#!/usr/bin/env python3
"""
Project N.O.M.A.D. YouTube ZIM Builder

Two-phase tool:
  Phase 1 (Download): Downloads a YouTube video or channel to persistent raw file storage.
  Phase 2 (ZIM Build): Builds per-channel ZIM files + a lightweight 'youtube_library.zim' hub.

Usage:
    # Full download + rebuild:
    python build_zim.py --url URL --raw-dir /raw --zim-dir /zim [--quality 480] [--max-comments 100]

    # Rebuild hub ZIM + build any missing channel ZIMs (used after deletions, no internet needed):
    python build_zim.py --rebuild-only --raw-dir /raw --zim-dir /zim

Progress output (stdout):
    NOMAD_PROGRESS:{percent}:{message}
    NOMAD_DONE:{filename}
    NOMAD_ERROR:{message}
"""

import argparse
import base64
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.request
from datetime import datetime, UTC
from pathlib import Path

# YouTube-style icon: red rounded rectangle with white play triangle (48x48 PNG)
_YOUTUBE_ICON_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAgUlEQVR42u3YWwqAMAxE0e5/"
    "0z4WIApmkk5yL/orPSDaZi0iIqJuHde14229+E+I3Rf/irAGuCz+ERH28Dt7QAJCDxAjcgBC"
    "RB5AhMgFCBD5gGBEDSAQUgsIQNQDfiIAzH6F+IzyI5u0lWA7zYFm2pGSycTUuVCL0WKL4S4R"
    "EZFTJ2oD9ZfGNKoYAAAAAElFTkSuQmCC"
)
_YOUTUBE_ICON_BYTES = base64.b64decode(_YOUTUBE_ICON_B64)

try:
    import yt_dlp
    from jinja2 import Environment, FileSystemLoader
    from libzim.writer import Creator, Hint, Item, StringProvider, FileProvider
except ImportError as e:
    print(f"NOMAD_ERROR:Missing dependency: {e}", flush=True)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Progress / logging helpers
# ---------------------------------------------------------------------------

def progress(pct: int, msg: str):
    print(f"NOMAD_PROGRESS:{pct}:{msg}", flush=True)


def done(filename: str):
    print(f"NOMAD_DONE:{filename}", flush=True)


def error(msg: str):
    print(f"NOMAD_ERROR:{msg}", flush=True)


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def format_duration(seconds) -> str:
    if not seconds:
        return ""
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def format_date(date_str) -> str:
    if not date_str or len(str(date_str)) < 8:
        return ""
    try:
        return datetime.strptime(str(date_str)[:8], "%Y%m%d").strftime("%b %d, %Y")
    except ValueError:
        return str(date_str)


def sanitize_id(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", text)


def load_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def find_thumbnail(dir_path: str) -> str | None:
    """Return path to a thumbnail file in dir_path, or None."""
    for ext in ("webp", "jpg", "png"):
        p = os.path.join(dir_path, f"thumbnail.{ext}")
        if os.path.exists(p):
            return p
    return None


def make_env() -> Environment:
    return Environment(loader=FileSystemLoader("/app/templates"))


# ---------------------------------------------------------------------------
# ZIM item classes
# ---------------------------------------------------------------------------

class HtmlItem(Item):
    def __init__(self, path: str, title: str, content: str, is_front: bool = False):
        super().__init__()
        self._path = path
        self._title = title
        self._content = content.encode("utf-8")
        self._is_front = is_front

    def get_path(self) -> str:
        return self._path

    def get_title(self) -> str:
        return self._title

    def get_mimetype(self) -> str:
        return "text/html"

    def get_contentprovider(self):
        return StringProvider(self._content)

    def get_hints(self) -> dict:
        return {Hint.FRONT_ARTICLE: self._is_front}


class BinaryItem(Item):
    def __init__(self, path: str, mimetype: str, filepath: str):
        super().__init__()
        self._path = path
        self._mimetype = mimetype
        self._filepath = filepath

    def get_path(self) -> str:
        return self._path

    def get_title(self) -> str:
        return ""

    def get_mimetype(self) -> str:
        return self._mimetype

    def get_contentprovider(self):
        return FileProvider(self._filepath)

    def get_hints(self) -> dict:
        return {Hint.FRONT_ARTICLE: False}


# ---------------------------------------------------------------------------
# yt-dlp helpers
# ---------------------------------------------------------------------------

def make_format_str(quality: int) -> str:
    # Prefer H.264 (avc1) — AV1/VP9 have inconsistent support in <video> elements
    # served from ZIM files (no codec hint, kiwix-serve range requests)
    return (
        f"bestvideo[height<={quality}][ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]"
        f"/bestvideo[height<={quality}][vcodec^=avc]+bestaudio"
        f"/bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]"
        f"/bestvideo[height<={quality}]+bestaudio"
        f"/best[height<={quality}]"
        f"/best"
    )


def detect_type(url: str) -> str:
    patterns_channel = [
        r"youtube\.com/@",
        r"youtube\.com/channel/",
        r"youtube\.com/c/",
        r"youtube\.com/user/",
        r"youtube\.com/playlist",
    ]
    for pat in patterns_channel:
        if re.search(pat, url):
            return "channel"
    return "video"


def copy_best_thumbnail(src_dir: str, dest_dir: str, video_id: str):
    """Copy the best-quality thumbnail from tmpdir to dest_dir as thumbnail.{ext}."""
    for ext in ("webp", "jpg", "png"):
        matches = list(Path(src_dir).glob(f"{video_id}*.{ext}"))
        if matches:
            dest = os.path.join(dest_dir, f"thumbnail.{ext}")
            shutil.copy(str(matches[0]), dest)
            return True
    return False


def copy_video_file(src_dir: str, dest_dir: str, video_id: str):
    """Copy the downloaded MP4 (or best available) to dest_dir/video.mp4."""
    # Try exact MP4 match first
    mp4s = list(Path(src_dir).glob(f"{video_id}*.mp4"))
    if mp4s:
        shutil.copy(str(mp4s[0]), os.path.join(dest_dir, "video.mp4"))
        return True
    # Fall back to any non-metadata file
    for f in Path(src_dir).iterdir():
        if f.suffix not in (".json", ".jpg", ".png", ".webp"):
            shutil.copy(str(f), os.path.join(dest_dir, "video.mp4"))
            return True
    return False


# ---------------------------------------------------------------------------
# Phase 1a: Download single video
# ---------------------------------------------------------------------------

def download_video(url: str, raw_dir: str, quality: int, max_comments: int) -> str | None:
    """Download a single video to /raw/videos/{id}/. Returns video_id or None."""

    # Quick info fetch to get the video ID
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
        try:
            peek = ydl.extract_info(url, download=False)
        except Exception as exc:
            error(f"Failed to fetch video info: {exc}")
            return None

    video_id = peek.get("id")
    if not video_id:
        error("Could not determine video ID")
        return None

    video_dir = os.path.join(raw_dir, "videos", video_id)
    os.makedirs(video_dir, exist_ok=True)

    progress(10, f"Downloading: {peek.get('title', video_id)}")

    with tempfile.TemporaryDirectory(prefix="nomad_yt_") as tmpdir:
        opts = {
            "format": make_format_str(quality),
            "merge_output_format": "mp4",
            "outtmpl": os.path.join(tmpdir, "%(id)s.%(ext)s"),
            "writethumbnail": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "writecomments": True,
            "getcomments": True,
            "extractor_args": {"youtube": {"max_comments": [str(max_comments), "all", "10", "5"]}},
            "postprocessors": [{"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}],
        }

        with yt_dlp.YoutubeDL(opts) as ydl:
            try:
                info = ydl.extract_info(url, download=True)
            except Exception as exc:
                error(f"yt-dlp failed: {exc}")
                return None

        copy_video_file(tmpdir, video_dir, video_id)
        copy_best_thumbnail(tmpdir, video_dir, video_id)

    comments_raw = info.get("comments") or []
    comments = [
        {"author": c.get("author", "Anonymous"), "text": c.get("text", "")}
        for c in comments_raw[:max_comments]
        if c.get("text")
    ]

    info_data = {
        "id": video_id,
        "title": info.get("title", "Untitled"),
        "channel": info.get("uploader") or info.get("channel") or "Unknown",
        "upload_date": format_date(info.get("upload_date")),
        "view_count": info.get("view_count"),
        "duration": format_duration(info.get("duration")),
        "description": info.get("description") or "",
        "comments": comments,
    }
    with open(os.path.join(video_dir, "info.json"), "w", encoding="utf-8") as f:
        json.dump(info_data, f, ensure_ascii=False, indent=2)

    return video_id


# ---------------------------------------------------------------------------
# Phase 1b: Download channel / playlist
# ---------------------------------------------------------------------------

def download_channel(url: str, raw_dir: str, quality: int, max_comments: int) -> str | None:
    """Download a full channel/playlist to /raw/channels/{id}/. Returns channel_id or None."""

    # Bare channel URLs (/@name, /channel/ID, /c/name, /user/name) return tabs as
    # top-level entries instead of individual videos. Force the /videos tab so
    # yt-dlp flat-extracts the full uploads list directly.
    if re.search(r'youtube\.com/(@[^/?#]+|channel/[^/?#]+|c/[^/?#]+|user/[^/?#]+)$', url):
        url = url.rstrip('/') + '/videos'
        progress(3, f"Resolved to videos tab: {url}")

    progress(3, "Fetching channel info...")
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": True}) as ydl:
        try:
            flat = ydl.extract_info(url, download=False)
        except Exception as exc:
            error(f"Failed to list channel: {exc}")
            return None

    channel_id = flat.get("channel_id") or flat.get("id") or sanitize_id(
        (flat.get("channel") or flat.get("title") or "channel")[:30]
    )
    channel_name = flat.get("channel") or flat.get("uploader") or flat.get("title") or "YouTube Channel"
    channel_desc = flat.get("description") or ""
    entries = flat.get("entries") or []

    # Pick the channel avatar (profile picture) from flat info thumbnails.
    # Banners are very wide (aspect ratio >> 1); the avatar is square or near-square.
    # Filter for roughly square thumbnails first, then take the highest resolution.
    channel_avatar_url = None
    all_thumbs = [t for t in flat.get("thumbnails", []) if t.get("url")]
    square_thumbs = [
        t for t in all_thumbs
        if t.get("width") and t.get("height")
        and 0.8 <= (t["width"] / t["height"]) <= 1.25
    ]
    candidates = square_thumbs if square_thumbs else all_thumbs
    if candidates:
        best = max(candidates, key=lambda t: (t.get("width") or 0) * (t.get("height") or 0))
        channel_avatar_url = best["url"]
    if not channel_avatar_url:
        channel_avatar_url = flat.get("thumbnail")

    if not entries:
        error("No videos found in channel/playlist.")
        return None

    channel_dir = os.path.join(raw_dir, "channels", channel_id)
    videos_dir = os.path.join(channel_dir, "videos")
    os.makedirs(videos_dir, exist_ok=True)

    total = len(entries)
    progress(5, f"Found {total} videos in {channel_name}")

    downloaded_ids = []

    dl_opts = {
        "format": make_format_str(quality),
        "merge_output_format": "mp4",
        "writethumbnail": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "writecomments": True,
        "getcomments": True,
        "extractor_args": {"youtube": {"max_comments": [str(max_comments), "all", "10", "5"]}},
        "postprocessors": [{"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}],
    }

    for idx, entry in enumerate(entries):
        vid_id = entry.get("id", "")
        if not vid_id:
            continue
        vid_url = (
            entry.get("url")
            or entry.get("webpage_url")
            or f"https://www.youtube.com/watch?v={vid_id}"
        )
        pct = 5 + int(75 * idx / total)
        progress(pct, f"Downloading video {idx + 1}/{total}: {entry.get('title', vid_id)}")

        vid_dir = os.path.join(videos_dir, vid_id)
        os.makedirs(vid_dir, exist_ok=True)

        # Skip if already fully downloaded (resume support)
        if os.path.exists(os.path.join(vid_dir, "video.mp4")) and \
                os.path.exists(os.path.join(vid_dir, "info.json")):
            progress(pct, f"Already downloaded, skipping: {entry.get('title', vid_id)}")
            downloaded_ids.append(vid_id)
            continue

        with tempfile.TemporaryDirectory(prefix="nomad_yt_") as tmpdir:
            opts = dict(dl_opts)
            opts["outtmpl"] = os.path.join(tmpdir, "%(id)s.%(ext)s")

            with yt_dlp.YoutubeDL(opts) as ydl:
                try:
                    info = ydl.extract_info(vid_url, download=True)
                except Exception as exc:
                    progress(pct, f"Warning — skipped {vid_id}: {exc}")
                    continue

            copy_video_file(tmpdir, vid_dir, vid_id)
            copy_best_thumbnail(tmpdir, vid_dir, vid_id)

        comments_raw = info.get("comments") or []
        comments = [
            {"author": c.get("author", "Anonymous"), "text": c.get("text", "")}
            for c in comments_raw[:max_comments]
            if c.get("text")
        ]
        info_data = {
            "id": vid_id,
            "title": info.get("title", "Untitled"),
            "channel": channel_name,
            "upload_date": format_date(info.get("upload_date")),
            "view_count": info.get("view_count"),
            "duration": format_duration(info.get("duration")),
            "description": info.get("description") or "",
            "comments": comments,
        }
        with open(os.path.join(vid_dir, "info.json"), "w", encoding="utf-8") as f:
            json.dump(info_data, f, ensure_ascii=False, indent=2)

        downloaded_ids.append(vid_id)

    if not downloaded_ids:
        error("No videos downloaded successfully.")
        return None

    # Channel thumbnail: prefer channel avatar, fall back to first video thumbnail
    ch_thumb_saved = False
    if channel_avatar_url:
        try:
            req = urllib.request.Request(
                channel_avatar_url, headers={"User-Agent": "Mozilla/5.0"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                ct = resp.headers.get("Content-Type", "")
                if "webp" in ct:
                    ext = "webp"
                elif "png" in ct:
                    ext = "png"
                else:
                    ext = "jpg"
                dest = os.path.join(channel_dir, f"thumbnail.{ext}")
                with open(dest, "wb") as f:
                    f.write(resp.read())
            ch_thumb_saved = True
            progress(82, "Channel avatar downloaded")
        except Exception as exc:
            progress(82, f"Could not download channel avatar: {exc}")

    if not ch_thumb_saved:
        for vid_id in downloaded_ids:
            t = find_thumbnail(os.path.join(videos_dir, vid_id))
            if t:
                ext = Path(t).suffix
                shutil.copy(t, os.path.join(channel_dir, f"thumbnail{ext}"))
                break

    channel_info = {
        "id": channel_id,
        "name": channel_name,
        "description": channel_desc,
        "videos": downloaded_ids,
    }
    with open(os.path.join(channel_dir, "info.json"), "w", encoding="utf-8") as f:
        json.dump(channel_info, f, ensure_ascii=False, indent=2)

    return channel_id


# ---------------------------------------------------------------------------
# Phase 2a: Build per-channel ZIM
# ---------------------------------------------------------------------------

def build_channel_zim(ch_id: str, raw_dir: str, zim_dir: str):
    """Build youtube_channel_{ch_id}.zim from raw channel storage."""

    channel_dir = os.path.join(raw_dir, "channels", ch_id)
    info = load_json(os.path.join(channel_dir, "info.json"))
    ch_name = info.get("name", ch_id)
    ch_desc = info.get("description", "")

    videos_dir = os.path.join(channel_dir, "videos")
    video_ids = info.get("videos") or []
    if not video_ids and os.path.isdir(videos_dir):
        video_ids = sorted(os.listdir(videos_dir))

    # Collect video data
    videos = []
    for vid_id in video_ids:
        vid_dir = os.path.join(videos_dir, vid_id)
        if not os.path.isdir(vid_dir):
            continue
        vid_info = load_json(os.path.join(vid_dir, "info.json"))
        vid_thumb = find_thumbnail(vid_dir)
        vid_mp4 = os.path.join(vid_dir, "video.mp4")
        videos.append({
            "id": vid_id,
            "info": vid_info,
            "thumb": vid_thumb,
            "mp4": vid_mp4 if os.path.exists(vid_mp4) else None,
        })

    env = make_env()
    ch_tmpl = env.get_template("channel.html")
    vid_tmpl = env.get_template("video.html")

    # Build video metadata list for channel template
    vid_metas = [
        {
            "id": v["id"],
            "title": v["info"].get("title", v["id"]),
            "upload_date": v["info"].get("upload_date", ""),
            "view_count": v["info"].get("view_count"),
            "duration_str": v["info"].get("duration", ""),
            "has_thumb": v["thumb"] is not None,
            "thumb_ext": Path(v["thumb"]).suffix.lstrip(".") if v["thumb"] else "webp",
        }
        for v in videos
    ]

    ch_html = ch_tmpl.render(
        channel_name=ch_name,
        channel_description=ch_desc,
        channel_id=ch_id,
        videos=vid_metas,
    )

    # Channel avatar for ZIM favicon
    ch_thumb = find_thumbnail(channel_dir)

    zim_name = f"youtube_channel_{ch_id.lower()}"
    os.makedirs(zim_dir, exist_ok=True)
    zim_path = os.path.join(zim_dir, f"{zim_name}.zim")

    creator = Creator(zim_path)
    creator.config_indexing(True, "eng")
    creator.set_mainpath("index.html")

    with creator:
        creator.add_metadata("Name", zim_name)
        creator.add_metadata("Title", ch_name)
        creator.add_metadata("Description", ch_desc[:255] if ch_desc else f"YouTube channel: {ch_name}")
        creator.add_metadata("Language", "eng")
        creator.add_metadata("Tags", "youtube;_category:youtube")
        creator.add_metadata("Creator", "Project N.O.M.A.D.")
        creator.add_metadata("Publisher", "Project N.O.M.A.D.")
        creator.add_metadata("Date", datetime.now(UTC).strftime("%Y-%m-%d"))

        # Use channel avatar as ZIM illustration if available, else YouTube icon
        if ch_thumb and os.path.exists(ch_thumb):
            try:
                with open(ch_thumb, "rb") as f:
                    creator.add_illustration(48, f.read())
            except Exception:
                try:
                    creator.add_illustration(48, _YOUTUBE_ICON_BYTES)
                except Exception:
                    pass
        else:
            try:
                creator.add_illustration(48, _YOUTUBE_ICON_BYTES)
            except Exception:
                pass

        # Channel index page
        creator.add_item(HtmlItem("index.html", ch_name, ch_html, is_front=True))

        # Channel thumbnail (for use by library hub — stored in channel ZIM but also
        # written to raw dir for the hub to read from disk)
        if ch_thumb and os.path.exists(ch_thumb):
            thumb_ext = Path(ch_thumb).suffix.lstrip(".")
            mime = "image/webp" if thumb_ext == "webp" else f"image/{thumb_ext}"
            creator.add_item(BinaryItem(f"assets/thumbs/{ch_id}.{thumb_ext}", mime, ch_thumb))

        # Video pages and assets
        for v in videos:
            vi = v["info"]
            vid_id = v["id"]

            # Video thumbnail
            if v["thumb"] and os.path.exists(v["thumb"]):
                thumb_ext = Path(v["thumb"]).suffix.lstrip(".")
                mime = "image/webp" if thumb_ext == "webp" else f"image/{thumb_ext}"
                creator.add_item(BinaryItem(
                    f"assets/thumbs/{vid_id}.{thumb_ext}", mime, v["thumb"]
                ))

            # Video MP4
            if v["mp4"] and os.path.exists(v["mp4"]):
                creator.add_item(BinaryItem(
                    f"assets/videos/{vid_id}.mp4", "video/mp4", v["mp4"]
                ))

            # Video page at video/{vid_id}.html (one level deep from ZIM root)
            # video_prefix: ../assets/videos/ — goes up one level from video/
            vid_html = vid_tmpl.render(
                title=vi.get("title", vid_id),
                channel=vi.get("channel", ch_name),
                upload_date=vi.get("upload_date", ""),
                view_count=vi.get("view_count"),
                description=vi.get("description", ""),
                comments=vi.get("comments", []),
                video_id=vid_id,
                thumb_ext=Path(v["thumb"]).suffix.lstrip(".") if v["thumb"] else "webp",
                video_prefix="../assets/videos/",
            )
            creator.add_item(HtmlItem(
                f"video/{vid_id}.html",
                vi.get("title", vid_id),
                vid_html,
                is_front=True,
            ))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Project N.O.M.A.D. YouTube ZIM Builder")
    parser.add_argument("--url", help="YouTube video or channel URL")
    parser.add_argument("--raw-dir", required=True, dest="raw_dir",
                        help="Persistent raw file storage directory")
    parser.add_argument("--zim-dir", required=True, dest="zim_dir",
                        help="ZIM output directory")
    parser.add_argument("--quality", type=int, default=480,
                        help="Max video height in pixels (default 480)")
    parser.add_argument("--max-comments", type=int, default=100, dest="max_comments",
                        help="Max comments per video (default 100)")
    parser.add_argument("--rebuild-only", action="store_true", dest="rebuild_only",
                        help="Skip download; rebuild hub ZIM and build any missing channel ZIMs")
    parser.add_argument("--force", action="store_true", dest="force",
                        help="Used with --rebuild-only: rebuild all channel ZIMs even if they already exist")
    args = parser.parse_args()

    os.makedirs(args.raw_dir, exist_ok=True)
    os.makedirs(args.zim_dir, exist_ok=True)

    if not args.rebuild_only:
        if not args.url:
            error("--url is required unless --rebuild-only is set")
            sys.exit(1)

        content_type = detect_type(args.url)
        progress(0, f"Starting {content_type} download from {args.url}")

        if content_type == "video":
            vid_id = download_video(args.url, args.raw_dir, args.quality, args.max_comments)
            if not vid_id:
                error("Failed to download video")
                sys.exit(1)
            progress(100, f"Video downloaded ({vid_id})")
            done(f"{vid_id}.zim")
        else:
            ch_id = download_channel(args.url, args.raw_dir, args.quality, args.max_comments)
            if not ch_id:
                error("Failed to download channel")
                sys.exit(1)
            progress(83, f"Channel downloaded ({ch_id}), building channel ZIM...")
            build_channel_zim(ch_id, args.raw_dir, args.zim_dir)
            progress(100, "Done!")
            done(f"youtube_channel_{ch_id.lower()}.zim")
    else:
        progress(0, "Rebuilding YouTube ZIMs from existing content...")

        # Incremental: build channel ZIMs that are missing (e.g. after migration or
        # partial failure). Existing channel ZIMs are left untouched.
        channels_root = os.path.join(args.raw_dir, "channels")
        if os.path.isdir(channels_root):
            ch_ids = [
                d for d in sorted(os.listdir(channels_root))
                if os.path.isdir(os.path.join(channels_root, d))
            ]
            for i, ch_id in enumerate(ch_ids):
                zim_path = os.path.join(args.zim_dir, f"youtube_channel_{ch_id.lower()}.zim")
                if not os.path.exists(zim_path) or args.force:
                    pct = 5 + int(90 * i / max(len(ch_ids), 1))
                    progress(pct, f"Building ZIM for channel {ch_id}...")
                    build_channel_zim(ch_id, args.raw_dir, args.zim_dir)
        progress(100, "Done!")
        done("(rebuild-only)")


if __name__ == "__main__":
    main()
