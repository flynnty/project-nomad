#!/usr/bin/env python3
"""
Project N.O.M.A.D. YouTube ZIM Builder

Downloads a YouTube video or channel and packages it as a Kiwix-compatible ZIM file.

Usage:
    python build_zim.py --url URL --output /output [--quality 480] [--max-comments 100]

Progress output (stdout):
    NOMAD_PROGRESS:{percent}:{message}
    NOMAD_DONE:{filename.zim}
    NOMAD_ERROR:{message}
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

try:
    import yt_dlp
    from jinja2 import Environment, FileSystemLoader
    from libzim.writer import Creator, Item, StringProvider, FileProvider, Hints
except ImportError as e:
    print(f"NOMAD_ERROR:Missing dependency: {e}", flush=True)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def progress(pct: int, msg: str):
    print(f"NOMAD_PROGRESS:{pct}:{msg}", flush=True)


def done(filename: str):
    print(f"NOMAD_DONE:{filename}", flush=True)


def error(msg: str):
    print(f"NOMAD_ERROR:{msg}", flush=True)


def format_duration(seconds: int | None) -> str:
    if not seconds:
        return ""
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def format_date(date_str: str | None) -> str:
    if not date_str or len(date_str) < 8:
        return ""
    try:
        return datetime.strptime(date_str[:8], "%Y%m%d").strftime("%b %d, %Y")
    except ValueError:
        return date_str


def sanitize_id(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", text)


def load_json_file(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


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
        return {Hints.FRONT_ARTICLE: self._is_front}


class BinaryItem(Item):
    def __init__(self, path: str, mimetype: str, filepath: str, is_front: bool = False):
        super().__init__()
        self._path = path
        self._mimetype = mimetype
        self._filepath = filepath
        self._is_front = is_front

    def get_path(self) -> str:
        return self._path

    def get_title(self) -> str:
        return ""

    def get_mimetype(self) -> str:
        return self._mimetype

    def get_contentprovider(self):
        return FileProvider(self._filepath)

    def get_hints(self) -> dict:
        return {Hints.FRONT_ARTICLE: self._is_front}


# ---------------------------------------------------------------------------
# yt-dlp helpers
# ---------------------------------------------------------------------------

def make_ydl_opts(tmpdir: str, quality: int, write_comments: bool = False) -> dict:
    opts = {
        "format": (
            f"bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]"
            f"/bestvideo[height<={quality}]+bestaudio"
            f"/best[height<={quality}]"
            f"/best"
        ),
        "merge_output_format": "mp4",
        "outtmpl": os.path.join(tmpdir, "%(id)s.%(ext)s"),
        "writethumbnail": True,
        "writeinfojson": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "postprocessors": [
            {"key": "FFmpegVideoConvertor", "preferedformat": "mp4"},
        ],
    }
    if write_comments:
        opts["writecomments"] = True
        opts["getcomments"] = True
        opts["extractor_args"] = {"youtube": {"max_comments": ["100", "all", "10", "5"]}}
    return opts


def get_video_info(url: str) -> dict | None:
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": False}) as ydl:
        try:
            return ydl.extract_info(url, download=False)
        except Exception:
            return None


def detect_type(url: str) -> str:
    """Return 'video' or 'channel' based on URL pattern."""
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


# ---------------------------------------------------------------------------
# Video download
# ---------------------------------------------------------------------------

def download_single_video(url: str, tmpdir: str, quality: int, max_comments: int) -> dict | None:
    opts = make_ydl_opts(tmpdir, quality, write_comments=True)
    opts["extractor_args"] = {"youtube": {"max_comments": [str(max_comments), "all", "10", "5"]}}

    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(url, download=True)
            return info
        except Exception as exc:
            error(f"yt-dlp failed: {exc}")
            return None


# ---------------------------------------------------------------------------
# Channel / playlist download
# ---------------------------------------------------------------------------

def download_channel(url: str, tmpdir: str, quality: int, max_comments: int) -> dict | None:
    # First pass: get entry list only
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": True}) as ydl:
        try:
            flat = ydl.extract_info(url, download=False)
        except Exception as exc:
            error(f"Failed to list channel: {exc}")
            return None

    entries = flat.get("entries") or []
    if not entries:
        error("No videos found in channel/playlist.")
        return None

    total = len(entries)
    progress(5, f"Found {total} videos")

    opts = make_ydl_opts(tmpdir, quality, write_comments=True)
    opts["extractor_args"] = {"youtube": {"max_comments": [str(max_comments), "all", "10", "5"]}}

    downloaded_infos = []
    for idx, entry in enumerate(entries):
        video_url = entry.get("url") or entry.get("webpage_url") or f"https://www.youtube.com/watch?v={entry.get('id', '')}"
        pct = 5 + int(90 * idx / total)
        progress(pct, f"Downloading video {idx + 1}/{total}: {entry.get('title', video_url)}")

        with yt_dlp.YoutubeDL(opts) as ydl:
            try:
                info = ydl.extract_info(video_url, download=True)
                if info:
                    downloaded_infos.append(info)
            except Exception as exc:
                # Skip failed videos, don't abort the whole channel
                print(f"NOMAD_PROGRESS:{pct}:Warning — skipped video {entry.get('id', '')}: {exc}", flush=True)

    flat["downloaded_entries"] = downloaded_infos
    return flat


# ---------------------------------------------------------------------------
# ZIM builder — single video
# ---------------------------------------------------------------------------

def build_video_zim(info: dict, tmpdir: str, output_dir: str, quality: int) -> str:
    video_id = info.get("id", "unknown")
    title = info.get("title", "Untitled")
    channel = info.get("uploader") or info.get("channel") or "Unknown"
    description = info.get("description") or ""
    upload_date = format_date(info.get("upload_date"))
    view_count = info.get("view_count")
    duration = format_duration(info.get("duration"))

    comments_raw = info.get("comments") or []
    comments = [
        {"author": c.get("author", "Anonymous"), "text": c.get("text", "")}
        for c in comments_raw[:100]
        if c.get("text")
    ]

    progress(75, "Generating HTML")

    env = Environment(loader=FileSystemLoader("/app/templates"))
    tmpl = env.get_template("video.html")
    html = tmpl.render(
        title=title,
        channel=channel,
        upload_date=upload_date,
        view_count=view_count,
        description=description,
        comments=comments,
        video_id=video_id,
    )

    # Locate downloaded video file
    video_file = None
    for f in Path(tmpdir).glob(f"{video_id}*.mp4"):
        video_file = str(f)
        break
    if not video_file:
        for f in Path(tmpdir).glob(f"{video_id}*"):
            if not f.name.endswith((".json", ".jpg", ".png", ".webp")):
                video_file = str(f)
                break

    # Locate thumbnail
    thumb_file = None
    for ext in ("jpg", "webp", "png"):
        candidates = list(Path(tmpdir).glob(f"{video_id}*.{ext}"))
        if candidates:
            thumb_file = str(candidates[0])
            break

    now_str = datetime.utcnow().strftime("%Y-%m")
    safe_title = sanitize_id(title[:40]) or video_id
    zim_name = f"youtube_video_{video_id}_{now_str}.zim"
    zim_path = os.path.join(output_dir, zim_name)

    progress(80, "Creating ZIM file")

    with Creator(zim_path) as creator:
        creator.config_indexing(True, "eng")
        creator.set_mainpath("index.html")
        creator.add_metadata("Title", title)
        creator.add_metadata("Description", description[:255] if description else f"YouTube video by {channel}")
        creator.add_metadata("Language", "eng")
        creator.add_metadata("Creator", channel)
        creator.add_metadata("Publisher", "Project N.O.M.A.D.")
        creator.add_metadata("Source", f"https://www.youtube.com/watch?v={video_id}")
        creator.add_metadata("Date", datetime.utcnow().strftime("%Y-%m-%d"))

        if thumb_file and os.path.exists(thumb_file):
            try:
                creator.add_illustration(48, open(thumb_file, "rb").read())
            except Exception:
                pass

        # Index page (redirects to the video page or IS the video page)
        creator.add_item(HtmlItem("index.html", title, html, is_front=True))

        if video_file and os.path.exists(video_file):
            creator.add_item(BinaryItem(f"videos/{video_id}.mp4", "video/mp4", video_file))

        if thumb_file and os.path.exists(thumb_file):
            ext = Path(thumb_file).suffix.lstrip(".")
            mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
            creator.add_item(BinaryItem(f"thumbnails/{video_id}.{ext}", mime, thumb_file))

    return zim_name


# ---------------------------------------------------------------------------
# ZIM builder — channel / playlist
# ---------------------------------------------------------------------------

def build_channel_zim(flat_info: dict, tmpdir: str, output_dir: str) -> str:
    channel_name = flat_info.get("channel") or flat_info.get("uploader") or flat_info.get("title") or "YouTube Channel"
    channel_id = flat_info.get("channel_id") or flat_info.get("id") or sanitize_id(channel_name[:20])
    channel_desc = flat_info.get("description") or ""

    entries = flat_info.get("downloaded_entries") or []

    progress(85, "Generating HTML pages")

    env = Environment(loader=FileSystemLoader("/app/templates"))
    video_tmpl = env.get_template("video.html")
    channel_tmpl = env.get_template("channel.html")

    video_metas = []
    video_pages = []  # (video_id, title, html)
    video_files = []  # (video_id, filepath)
    thumb_files = []  # (video_id, filepath, ext)

    for info in entries:
        vid = info.get("id", "")
        if not vid:
            continue

        t = info.get("title", "Untitled")
        channel_auth = info.get("uploader") or info.get("channel") or channel_name
        desc = info.get("description") or ""
        upload_date = format_date(info.get("upload_date"))
        view_count = info.get("view_count")
        duration_str = format_duration(info.get("duration"))

        comments_raw = info.get("comments") or []
        comments = [
            {"author": c.get("author", "Anonymous"), "text": c.get("text", "")}
            for c in comments_raw[:100]
            if c.get("text")
        ]

        html = video_tmpl.render(
            title=t,
            channel=channel_auth,
            upload_date=upload_date,
            view_count=view_count,
            description=desc,
            comments=comments,
            video_id=vid,
        )
        video_pages.append((vid, t, html))

        # Locate video file
        vfile = None
        for f in Path(tmpdir).glob(f"{vid}*.mp4"):
            vfile = str(f)
            break
        if vfile:
            video_files.append((vid, vfile))

        # Locate thumbnail
        tfile = None
        tfile_ext = "jpg"
        for ext in ("jpg", "webp", "png"):
            candidates = list(Path(tmpdir).glob(f"{vid}*.{ext}"))
            if candidates:
                tfile = str(candidates[0])
                tfile_ext = ext
                break

        has_thumb = tfile is not None
        if tfile:
            thumb_files.append((vid, tfile, tfile_ext))

        video_metas.append({
            "id": vid,
            "title": t,
            "upload_date": upload_date,
            "view_count": view_count,
            "duration_str": duration_str,
            "has_thumb": has_thumb,
        })

    index_html = channel_tmpl.render(
        channel_name=channel_name,
        channel_description=channel_desc,
        videos=video_metas,
    )

    now_str = datetime.utcnow().strftime("%Y-%m")
    safe_id = sanitize_id(channel_id[:30]) or "channel"
    zim_name = f"youtube_channel_{safe_id}_{now_str}.zim"
    zim_path = os.path.join(output_dir, zim_name)

    progress(90, "Creating ZIM file")

    # Pick a thumbnail from the first video as the ZIM favicon
    favicon_bytes = None
    if thumb_files:
        try:
            favicon_bytes = open(thumb_files[0][1], "rb").read()
        except Exception:
            pass

    with Creator(zim_path) as creator:
        creator.config_indexing(True, "eng")
        creator.set_mainpath("index.html")
        creator.add_metadata("Title", channel_name)
        creator.add_metadata("Description", channel_desc[:255] if channel_desc else f"YouTube channel: {channel_name}")
        creator.add_metadata("Language", "eng")
        creator.add_metadata("Creator", channel_name)
        creator.add_metadata("Publisher", "Project N.O.M.A.D.")
        creator.add_metadata("Date", datetime.utcnow().strftime("%Y-%m-%d"))

        if favicon_bytes:
            try:
                creator.add_illustration(48, favicon_bytes)
            except Exception:
                pass

        creator.add_item(HtmlItem("index.html", channel_name, index_html, is_front=True))

        for vid, title, html in video_pages:
            creator.add_item(HtmlItem(f"video/{vid}.html", title, html, is_front=True))

        for vid, vpath in video_files:
            creator.add_item(BinaryItem(f"videos/{vid}.mp4", "video/mp4", vpath))

        for vid, tpath, text in thumb_files:
            mime = "image/jpeg" if text in ("jpg", "jpeg") else f"image/{text}"
            creator.add_item(BinaryItem(f"thumbnails/{vid}.{text}", mime, tpath))

    return zim_name


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Build a Kiwix ZIM from a YouTube URL")
    parser.add_argument("--url", required=True, help="YouTube video or channel URL")
    parser.add_argument("--output", required=True, help="Output directory for the ZIM file")
    parser.add_argument("--quality", type=int, default=480, help="Max video height in pixels (default 480)")
    parser.add_argument("--max-comments", type=int, default=100, dest="max_comments",
                        help="Max comments to include per video (default 100)")
    args = parser.parse_args()

    url = args.url
    output_dir = args.output
    quality = args.quality
    max_comments = args.max_comments

    os.makedirs(output_dir, exist_ok=True)

    content_type = detect_type(url)
    progress(0, f"Starting {content_type} download from {url}")

    with tempfile.TemporaryDirectory(prefix="nomad_yt_") as tmpdir:
        if content_type == "video":
            progress(5, "Fetching video info and downloading...")
            info = download_single_video(url, tmpdir, quality, max_comments)
            if not info:
                error("Failed to download video.")
                sys.exit(1)

            progress(70, "Download complete, building ZIM...")
            try:
                zim_name = build_video_zim(info, tmpdir, output_dir, quality)
            except Exception as exc:
                error(f"Failed to create ZIM: {exc}")
                sys.exit(1)

        else:
            progress(2, "Fetching channel info...")
            flat_info = download_channel(url, tmpdir, quality, max_comments)
            if not flat_info:
                error("Failed to download channel.")
                sys.exit(1)

            try:
                zim_name = build_channel_zim(flat_info, tmpdir, output_dir)
            except Exception as exc:
                error(f"Failed to create ZIM: {exc}")
                sys.exit(1)

    progress(100, "Done!")
    done(zim_name)


if __name__ == "__main__":
    main()
