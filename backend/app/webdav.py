"""只读 WebDAV：把有章节的书籍打包为 EPUB，暴露给阅读软件（PROPFIND/GET/HEAD）。

- 挂载在 /webdav/（与 API 同一端口 8300），通过 config.webdav_enabled 开关。
- 只支持阅读软件必需的读操作；写操作一律 405。
- 未翻译的章节回退原文，可托管本身已是译文的书籍。
- EPUB 按需生成并缓存在 books/<id>/webdav.epub，源文件更新后自动重建。
"""
from __future__ import annotations

import re
from email.utils import formatdate
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse

from . import parsing, store

router = APIRouter()

READ_METHODS = ["OPTIONS", "PROPFIND", "GET", "HEAD"]
WRITE_METHODS = ["PUT", "DELETE", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK", "PROPPATCH"]
DAV_ROOT = "/webdav"


# ---------- 书目 ----------

def collect_chapters(book: dict) -> list[dict]:
    """返回 [{title, text, html}]，优先使用译文（与导出逻辑一致）。"""
    out = []
    for ch in book["chapters"]:
        dst = store.chapter_dst_path(book["id"], ch["id"])
        src = store.chapter_src_path(book["id"], ch["id"])
        p = dst if dst.exists() else src
        if not p.exists():
            continue
        raw = p.read_text(encoding="utf-8", errors="replace")
        title = ch.get("title_translated") or ch["title"]
        if (ch.get("format") or book["format"]) == "epub":
            soup = parsing.BeautifulSoup(raw, "html.parser")
            lines = [ln.strip() for ln in soup.get_text("\n").splitlines() if ln.strip()]
            # 去掉与章节标题重复的首行标题（HTML 正文里已含 <h1>）
            if lines and lines[0] == title:
                lines = lines[1:]
            out.append({"title": title, "html": raw, "text": "\n".join(lines)})
        else:
            out.append({"title": title, "text": raw,
                        "html": parsing.text_to_html(raw)})
    return out


def _book_mtime(book: dict) -> float:
    paths = [store.book_path(book["id"])]
    for ch in book.get("chapters", []):
        paths.append(store.chapter_src_path(book["id"], ch["id"]))
        paths.append(store.chapter_dst_path(book["id"], ch["id"]))
    return max((p.stat().st_mtime for p in paths if p.exists()), default=0.0)


def list_dav_books() -> list[dict]:
    """WebDAV 根目录下的书目：[{name, book, mtime}]，收全部有章节的书。

    未翻译的章节回退原文（collect_chapters），便于托管本身已是译文的书籍。
    """
    out, used = [], set()
    for s in store.list_books():
        if not s.get("chapters"):
            continue
        book = store.load_book(s["id"])
        if not book:
            continue
        title = book.get("title_translated") or book.get("title") or "book"
        name = re.sub(r'[\\/:*?"<>|]', "_", title).strip() or "book"
        if name in used:  # 重名时加 id 后缀区分
            name = f"{name}_{book['id']}"
        used.add(name)
        out.append({"name": f"{name}.epub", "book": book,
                    "mtime": _book_mtime(book)})
    return out


def epub_cache_path(entry: dict) -> Path:
    """生成（或复用）缓存的 EPUB，源文件比缓存新时重建。"""
    book = entry["book"]
    out = store.BOOKS_DIR / book["id"] / "webdav.epub"
    if not out.exists() or out.stat().st_mtime < entry["mtime"]:
        title = book.get("title_translated") or book["title"]
        tmp = out.with_suffix(".tmp.epub")
        parsing.build_epub(title, book.get("author") or "",
                           collect_chapters(book), tmp)
        tmp.replace(out)
    return out


# ---------- WebDAV 协议 ----------

def _enabled() -> bool:
    return bool(store.load_config().get("webdav_enabled"))


def _href(path: str) -> str:
    return quote(f"{DAV_ROOT}/{path}".replace("//", "/"), safe="/")


def _propstat(*, name: str, href: str, collection: bool,
              size: int = 0, mtime: float = 0.0) -> str:
    if collection:
        type_props = "<D:resourcetype><D:collection/></D:resourcetype>"
    else:
        type_props = ("<D:resourcetype/>"
                      f"<D:getcontentlength>{size}</D:getcontentlength>"
                      "<D:getcontenttype>application/epub+zip</D:getcontenttype>")
    return (f"<D:response><D:href>{escape(href)}</D:href>"
            "<D:propstat><D:prop>"
            f"<D:displayname>{escape(name)}</D:displayname>"
            f"{type_props}"
            f"<D:getlastmodified>{formatdate(mtime or None, usegmt=True)}</D:getlastmodified>"
            "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>")


def _multistatus(items: list[str]) -> Response:
    body = ('<?xml version="1.0" encoding="utf-8"?>'
            '<D:multistatus xmlns:D="DAV:">' + "".join(items) + "</D:multistatus>")
    return Response(body, status_code=207,
                    media_type="application/xml; charset=utf-8")


def _find_entry(path: str) -> dict | None:
    name = path.rstrip("/")
    for e in list_dav_books():
        if e["name"] == name:
            return e
    return None


@router.api_route(DAV_ROOT, methods=READ_METHODS, include_in_schema=False)
@router.api_route(f"{DAV_ROOT}/{{path:path}}", methods=READ_METHODS,
                  include_in_schema=False)
async def webdav_read(request: Request, path: str = ""):
    if not _enabled():
        raise HTTPException(404, "WebDAV 未开启")

    if request.method == "OPTIONS":
        return Response(headers={"DAV": "1", "Allow": ", ".join(READ_METHODS),
                                 "MS-Author-Via": "DAV"})

    if request.method == "PROPFIND":
        depth = request.headers.get("depth", "1")
        if not path:
            items = [_propstat(name="", href=_href("/"), collection=True,
                               mtime=store.now())]
            if depth != "0":
                for e in list_dav_books():
                    epub = epub_cache_path(e)
                    items.append(_propstat(
                        name=e["name"], href=_href(e["name"]), collection=False,
                        size=epub.stat().st_size, mtime=epub.stat().st_mtime))
            return _multistatus(items)
        entry = _find_entry(path)
        if not entry:
            raise HTTPException(404, "文件不存在")
        epub = epub_cache_path(entry)
        return _multistatus([_propstat(
            name=entry["name"], href=_href(entry["name"]), collection=False,
            size=epub.stat().st_size, mtime=epub.stat().st_mtime)])

    # GET / HEAD
    if not path:
        raise HTTPException(404, "目录不支持下载，请用 PROPFIND 列出书籍")
    entry = _find_entry(path)
    if not entry:
        raise HTTPException(404, "文件不存在")
    return FileResponse(epub_cache_path(entry),
                        media_type="application/epub+zip",
                        filename=entry["name"])


@router.api_route(DAV_ROOT, methods=WRITE_METHODS, include_in_schema=False)
@router.api_route(f"{DAV_ROOT}/{{path:path}}", methods=WRITE_METHODS,
                  include_in_schema=False)
async def webdav_write(request: Request, path: str = ""):
    if not _enabled():
        raise HTTPException(404, "WebDAV 未开启")
    raise HTTPException(405, "WebDAV 书库为只读")
