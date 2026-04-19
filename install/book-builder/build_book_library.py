#!/usr/bin/env python3
"""
Project N.O.M.A.D. Book Library ZIM Builder

Scans /raw for book directories (each containing source.epub or source.pdf
plus an info.json), and builds a single my_book_library.zim.

Usage:
    python build_book_library.py --rebuild --raw-dir /raw --zim-dir /zim

Progress output (stdout):
    NOMAD_PROGRESS:{percent}:{message}
    NOMAD_DONE:{filename}
    NOMAD_ERROR:{message}
"""

import argparse
import io
import json
import os
import re
import sys
from datetime import datetime, UTC
from pathlib import Path

try:
    import ebooklib
    from ebooklib import epub
    from jinja2 import Environment, FileSystemLoader
    from libzim.writer import Creator, Hint, Item, StringProvider
    from PIL import Image
except ImportError as e:
    print(f"NOMAD_ERROR:Missing dependency: {e}", flush=True)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Progress helpers
# ---------------------------------------------------------------------------

def progress(pct: int, msg: str):
    print(f"NOMAD_PROGRESS:{pct}:{msg}", flush=True)


def done(filename: str):
    print(f"NOMAD_DONE:{filename}", flush=True)


def error(msg: str):
    print(f"NOMAD_ERROR:{msg}", flush=True)


# ---------------------------------------------------------------------------
# ZIM item classes
# ---------------------------------------------------------------------------

class HtmlItem(Item):
    def __init__(self, path: str, title: str, content: str | bytes, is_front: bool = True):
        super().__init__()
        self._path = path
        self._title = title
        self._content = content.encode('utf-8') if isinstance(content, str) else content
        self._is_front = is_front

    def get_path(self): return self._path
    def get_title(self): return self._title
    def get_mimetype(self): return 'text/html'
    def get_hints(self): return {Hint.FRONT_ARTICLE: self._is_front}
    def get_data(self): return StringProvider(self._content)


class BinaryItem(Item):
    def __init__(self, path: str, title: str, mimetype: str, data: bytes):
        super().__init__()
        self._path = path
        self._title = title
        self._mimetype = mimetype
        self._data = data

    def get_path(self): return self._path
    def get_title(self): return self._title
    def get_mimetype(self): return self._mimetype
    def get_hints(self): return {Hint.FRONT_ARTICLE: False}
    def get_data(self): return StringProvider(self._data)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_image_mimetype(filename: str) -> str:
    return {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.svg': 'image/svg+xml', '.webp': 'image/webp',
    }.get(Path(filename).suffix.lower(), 'image/jpeg')


def resize_cover(img_bytes: bytes, max_size=(200, 300)) -> tuple[bytes, str]:
    try:
        img = Image.open(io.BytesIO(img_bytes))
        img.thumbnail(max_size, Image.LANCZOS)
        if img.mode in ('RGBA', 'P', 'LA'):
            img = img.convert('RGBA')
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            return buf.getvalue(), 'image/png'
        buf = io.BytesIO()
        img.convert('RGB').save(buf, format='JPEG', quality=85)
        return buf.getvalue(), 'image/jpeg'
    except Exception:
        return img_bytes, 'image/jpeg'


# ---------------------------------------------------------------------------
# epub processing
# ---------------------------------------------------------------------------

def process_epub(book_dir: str, book_id: str) -> tuple:
    """
    Read an epub and return:
      (info_dict, chapters, image_items, cover_data, cover_mime)

    chapters: list of {path, title, content, index}
    image_items: list of (zim_path, mime, data)
    """
    source_path = os.path.join(book_dir, 'source.epub')
    book = epub.read_epub(source_path)

    def get_meta(field: str) -> str:
        try:
            items = book.get_metadata('DC', field)
            return items[0][0].strip() if items else ''
        except Exception:
            return ''

    title = get_meta('title') or book_id
    author = get_meta('creator') or 'Unknown'
    description = get_meta('description') or ''
    publisher = get_meta('publisher') or ''
    date = get_meta('date') or ''

    # Build epub href → item map
    href_to_item: dict = {}
    for item in book.get_items():
        href_to_item[item.get_name()] = item

    # Build image map: epub href → relative path from chapter ZIM location
    image_items = []
    href_to_zim_rel: dict = {}
    for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
        img_name = Path(item.get_name()).name
        zim_path = f'book/{book_id}/images/{img_name}'
        href_to_zim_rel[item.get_name()] = f'../images/{img_name}'
        try:
            image_items.append((zim_path, item.media_type or get_image_mimetype(img_name), item.get_content()))
        except Exception:
            pass

    # Extract cover
    cover_data: bytes | None = None
    cover_mime = 'image/jpeg'
    try:
        # Search by name
        for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
            if 'cover' in item.get_name().lower():
                cover_data, cover_mime = resize_cover(item.get_content(), (200, 300))
                break
        # Fallback: first image
        if cover_data is None and image_items:
            cover_data, cover_mime = resize_cover(image_items[0][2], (200, 300))
    except Exception:
        pass

    # Path fixer for chapter HTML
    def fix_paths(html_str: str, item_href: str) -> str:
        item_dir = item_href.rsplit('/', 1)[0] if '/' in item_href else ''

        def resolve(rel: str) -> str:
            if not rel or rel.startswith(('http://', 'https://', 'data:', '#', '/', 'mailto:')):
                return rel
            parts = (f'{item_dir}/{rel}' if item_dir else rel).split('/')
            out: list[str] = []
            for p in parts:
                if p == '..':
                    if out: out.pop()
                elif p and p != '.':
                    out.append(p)
            resolved = '/'.join(out)
            return href_to_zim_rel.get(resolved, rel)

        html_str = re.sub(
            r'(src)=["\']([^"\']*)["\']',
            lambda m: f'{m.group(1)}="{resolve(m.group(2))}"',
            html_str,
        )
        # Strip external stylesheet links
        html_str = re.sub(r'<link[^>]+rel=["\']stylesheet["\'][^>]*/>', '', html_str, flags=re.IGNORECASE)
        html_str = re.sub(r'<link[^>]+stylesheet[^>]*>', '', html_str, flags=re.IGNORECASE)
        return html_str

    # Extract chapters from spine
    chapters = []
    for idref, _ in book.spine:
        item = book.get_item_with_id(idref)
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        try:
            raw = item.get_content().decode('utf-8', errors='replace')
            body_m = re.search(r'<body[^>]*>(.*?)</body>', raw, re.DOTALL | re.IGNORECASE)
            body = body_m.group(1) if body_m else raw
            body = fix_paths(body, item.get_name())
            title_m = re.search(r'<title[^>]*>(.*?)</title>', raw, re.DOTALL | re.IGNORECASE)
            ch_title = re.sub(r'<[^>]+>', '', title_m.group(1)).strip() if title_m else f'Chapter {len(chapters) + 1}'
            chapters.append({
                'path': f'book/{book_id}/chapter/{len(chapters)}.html',
                'title': ch_title,
                'content': body,
                'index': len(chapters),
            })
        except Exception:
            pass

    info = {
        'title': title, 'author': author, 'description': description,
        'publisher': publisher, 'date': date, 'mime_type': 'application/epub+zip',
    }
    return info, chapters, image_items, cover_data, cover_mime


# ---------------------------------------------------------------------------
# Main build
# ---------------------------------------------------------------------------

def build_library_zim(raw_dir: str, zim_dir: str, env: Environment):
    progress(0, 'Scanning books...')

    book_dirs = []
    if os.path.isdir(raw_dir):
        book_dirs = sorted([
            d for d in os.listdir(raw_dir)
            if os.path.isdir(os.path.join(raw_dir, d))
            and os.path.exists(os.path.join(raw_dir, d, 'info.json'))
        ])

    progress(5, f'Found {len(book_dirs)} book(s).')

    library_tmpl = env.get_template('library.html')
    toc_tmpl = env.get_template('book_toc.html')
    reader_tmpl = env.get_template('book_reader.html')
    pdf_tmpl = env.get_template('book_pdf.html')

    book_summaries = []
    zim_path = os.path.join(zim_dir, 'my_book_library.zim')
    os.makedirs(zim_dir, exist_ok=True)

    with Creator(zim_path) as creator:
        creator.config_indexing(True, 'mul')
        creator.set_mainpath('index.html')
        creator.add_metadata('Name', 'my_book_library')
        creator.add_metadata('Title', 'My Book Library')
        creator.add_metadata('Description', 'Personal book library')
        creator.add_metadata('Language', 'mul')
        creator.add_metadata('Tags', 'books;_category:books')
        creator.add_metadata('Creator', 'Project N.O.M.A.D.')
        creator.add_metadata('Publisher', 'Project N.O.M.A.D.')
        creator.add_metadata('Date', datetime.now(UTC).strftime('%Y-%m-%d'))

        for i, book_id in enumerate(book_dirs):
            book_dir = os.path.join(raw_dir, book_id)
            pct = 5 + int(85 * i / max(len(book_dirs), 1))

            with open(os.path.join(book_dir, 'info.json')) as f:
                info = json.load(f)

            title = info.get('title', book_id)
            author = info.get('author', 'Unknown')
            description = info.get('description', '')

            has_epub = os.path.exists(os.path.join(book_dir, 'source.epub'))
            has_pdf = os.path.exists(os.path.join(book_dir, 'source.pdf'))

            cover_zim_path: str | None = None
            progress(pct, f'Processing {i + 1}/{len(book_dirs)}: {title}')

            if has_epub:
                try:
                    new_info, chapters, image_items, cover_data, cover_mime = process_epub(book_dir, book_id)
                    # Update metadata from epub
                    if new_info['title']: title = new_info['title']
                    if new_info['author']: author = new_info['author']
                    if new_info['description']: description = new_info['description']
                    info.update(new_info)
                    with open(os.path.join(book_dir, 'info.json'), 'w') as f:
                        json.dump(info, f, indent=2)

                    if cover_data:
                        ext = '.png' if cover_mime == 'image/png' else '.jpg'
                        cover_zim_path = f'assets/covers/{book_id}{ext}'
                        creator.add_item(BinaryItem(cover_zim_path, '', cover_mime, cover_data))

                    for img_path, mime, img_data in image_items:
                        try:
                            creator.add_item(BinaryItem(img_path, '', mime, img_data))
                        except Exception:
                            pass

                    for ch in chapters:
                        html = reader_tmpl.render(
                            book_title=title, author=author,
                            chapter_title=ch['title'], content=ch['content'],
                            book_id=book_id, chapter_index=ch['index'],
                            total_chapters=len(chapters),
                            prev_url=f"../{ch['index'] - 1}.html" if ch['index'] > 0 else None,
                            next_url=f"../{ch['index'] + 1}.html" if ch['index'] < len(chapters) - 1 else None,
                            toc_url='../index.html',
                        )
                        creator.add_item(HtmlItem(ch['path'], ch['title'], html))

                    toc_html = toc_tmpl.render(
                        book_title=title, author=author, description=description,
                        chapters=chapters, book_id=book_id,
                        cover_path=f'../../{cover_zim_path}' if cover_zim_path else None,
                    )
                    creator.add_item(HtmlItem(f'book/{book_id}/index.html', title, toc_html))

                except Exception as e:
                    print(f"Warning: epub processing failed for {book_id}: {e}", file=sys.stderr)
                    creator.add_item(HtmlItem(
                        f'book/{book_id}/index.html', title,
                        f'<html><body style="background:#111;color:#eee;padding:2rem"><h1>{title}</h1><p>Error reading book: {e}</p></body></html>',
                    ))

            elif has_pdf:
                try:
                    with open(os.path.join(book_dir, 'source.pdf'), 'rb') as f:
                        pdf_data = f.read()
                    creator.add_item(BinaryItem(f'book/{book_id}/source.pdf', title, 'application/pdf', pdf_data))
                    pdf_html = pdf_tmpl.render(book_title=title, author=author, description=description, book_id=book_id)
                    creator.add_item(HtmlItem(f'book/{book_id}/index.html', title, pdf_html))
                except Exception as e:
                    print(f"Warning: pdf processing failed for {book_id}: {e}", file=sys.stderr)
                    creator.add_item(HtmlItem(
                        f'book/{book_id}/index.html', title,
                        f'<html><body style="background:#111;color:#eee;padding:2rem"><h1>{title}</h1><p>Error reading PDF: {e}</p></body></html>',
                    ))

            book_summaries.append({
                'id': book_id, 'title': title, 'author': author,
                'description': description[:200] if description else '',
                'cover_path': cover_zim_path,
                'is_pdf': has_pdf and not has_epub,
            })

        library_html = library_tmpl.render(books=book_summaries)
        creator.add_item(HtmlItem('index.html', 'My Book Library', library_html))

    progress(100, f'Built my_book_library.zim with {len(book_dirs)} book(s).')
    done('my_book_library.zim')


def main():
    parser = argparse.ArgumentParser(description='Project N.O.M.A.D. Book Library ZIM Builder')
    parser.add_argument('--rebuild', action='store_true', help='Rebuild ZIM from all books in raw-dir')
    parser.add_argument('--raw-dir', required=True, dest='raw_dir')
    parser.add_argument('--zim-dir', required=True, dest='zim_dir')
    args = parser.parse_args()

    env = Environment(FileSystemLoader('/app/templates'), autoescape=False)

    if args.rebuild:
        build_library_zim(args.raw_dir, args.zim_dir, env)
    else:
        error('No action specified. Use --rebuild.')
        sys.exit(1)


if __name__ == '__main__':
    main()
