"""书籍解析：txt 正则分章、epub 解析与生成、HTML 翻译单元抽取。"""
from __future__ import annotations

import re
from pathlib import Path

import ebooklib
from bs4 import BeautifulSoup, NavigableString
from ebooklib import epub

# ---------------- txt 分章 ----------------

# 章节标题候选正则，按优先级排列；数值型要求至少出现 2 次才采用
CHAPTER_PATTERNS: list[tuple[re.Pattern, int]] = [
    (re.compile(r"^\s*第[0-9零一二三四五六七八九十百千万两]+[章节回卷部集篇][^\n]{0,60}\s*$"), 1),
    (re.compile(r"^\s*(?:chapter|chap\.?|part|book|act|prologue|epilogue)\s+[0-9IVXLC]+[^\n]{0,60}\s*$", re.I), 1),
    (re.compile(r"^\s*(?:序章|序言?|前言|楔子|引子|终章|尾声|后记|番外篇?|interlude|foreword|preface|afterword)[^\n]{0,40}\s*$", re.I), 1),
    (re.compile(r"^\s*[0-9]{1,4}[\.、\)][ \t][^\n]{1,60}\s*$"), 2),
    (re.compile(r"^\s*[0-9]{1,4}\s*$"), 3),
]


def decode_text(raw: bytes) -> str:
    for enc in ("utf-8", "gb18030", "utf-16", "latin-1"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def split_txt_chapters(text: str) -> list[tuple[str, str]]:
    """返回 [(章节标题, 章节正文)]。识别不到章节时整本作为一章。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")

    for pattern, min_count in CHAPTER_PATTERNS:
        idx = [i for i, ln in enumerate(lines) if pattern.match(ln)]
        if len(idx) < min_count:
            continue
        chapters: list[tuple[str, str]] = []
        # 第一章之前的内容（前言/简介）
        head = "\n".join(lines[: idx[0]]).strip()
        if head:
            chapters.append(("前言", head))
        for n, start in enumerate(idx):
            end = idx[n + 1] if n + 1 < len(idx) else len(lines)
            title = lines[start].strip()
            body = "\n".join(lines[start + 1 : end]).strip()
            chapters.append((title, body))
        return [(t, b) for t, b in chapters if t or b]

    body = text.strip()
    return [("全文", body)] if body else []


# ---------------- epub 解析 ----------------

BLOCK_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "td", "th", "div", "section", "pre"]
HEADING_TAGS = ["h1", "h2", "h3"]


def _spine_docs(book) -> list[tuple[str, object, str, object]]:
    """按 spine 顺序返回 [(chapter_id, item, html, soup)]，跳过 nav/ncx 与无文本文档。"""
    docs: list[tuple[str, object, str, object]] = []
    n = 0
    seen: set[str] = set()
    for entry in book.spine:
        idref = entry[0] if isinstance(entry, tuple) else entry
        item = book.get_item_with_id(idref)
        if item is None or item.get_id() in seen:
            continue
        seen.add(item.get_id())
        if item.get_type() != ebooklib.ITEM_DOCUMENT or isinstance(item, (epub.EpubNav, epub.EpubNcx)):
            continue
        html = item.get_content().decode("utf-8", errors="replace")
        soup = BeautifulSoup(html, "html.parser")
        if not soup.get_text().strip():
            continue
        n += 1
        docs.append((f"ch{n:04d}", item, html, soup))
    return docs


def parse_epub(path: Path) -> tuple[dict, list[dict]]:
    """返回 (meta, chapters)。chapters: [{id, title, body(html), format: 'html'}]"""
    book = epub.read_epub(str(path), options={"ignore_ncx": True})
    meta = {
        "title": (book.get_metadata("DC", "title") or [("", {})])[0][0] or path.stem,
        "author": (book.get_metadata("DC", "creator") or [("", {})])[0][0] or "",
    }
    chapters: list[dict] = []
    for n, (cid, item, html, soup) in enumerate(_spine_docs(book), 1):
        heading = soup.find(HEADING_TAGS)
        title = heading.get_text().strip() if heading else Path(item.get_name()).stem
        chapters.append({
            "id": cid,
            "title": title or f"第 {n} 章",
            "body": html,
            "format": "html",
        })
    return meta, chapters


def epub_chapter_files(path: Path) -> dict[str, str]:
    """章节 id → epub 内部文档路径（编号与 parse_epub 一致），供章节图片路径解析。"""
    book = epub.read_epub(str(path), options={"ignore_ncx": True})
    return {cid: item.get_name() for cid, item, _, _ in _spine_docs(book)}


# ---------------- HTML 翻译单元 ----------------

def extract_units(html: str):
    """从章节 HTML 中抽取叶子块级元素作为翻译单元。

    返回 (soup, units, heading_el)；units: [(element, text)]，
    第一个 h1-h3 作为章节标题元素从 units 中排除、单独翻译。
    """
    soup = BeautifulSoup(html, "html.parser")
    root = soup.body or soup
    heading_el = None
    units: list[tuple] = []
    for el in root.find_all(BLOCK_TAGS):
        if el.find(BLOCK_TAGS):
            continue  # 只取叶子块，避免重复
        text = el.get_text().strip()
        if not text:
            continue
        if heading_el is None and el.name in HEADING_TAGS:
            heading_el = el
            continue
        units.append((el, text))
    return soup, units, heading_el


def set_el_text(el, text: str) -> None:
    el.clear()
    el.append(NavigableString(text))


# ---------------- 导出 ----------------

def text_to_html(text: str) -> str:
    paras = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
    return "".join(f"<p>{_escape(p)}</p>" for p in paras)


def _escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_epub(title: str, author: str, chapters: list[dict], out_path: Path) -> None:
    """chapters: [{title, html}]"""
    book = epub.EpubBook()
    book.set_identifier("tranlatexbook")
    book.set_title(title)
    book.set_language("zh")
    if author:
        book.add_author(author)

    items = []
    for i, ch in enumerate(chapters):
        item = epub.EpubHtml(title=ch["title"] or f"第 {i + 1} 章",
                             file_name=f"chap_{i + 1:04d}.xhtml", lang="zh")
        # 统一抽取 body 内容重建干净文档，避免 xml 声明导致 ebooklib 解析失败
        soup = BeautifulSoup(ch["html"], "html.parser")
        root = soup.body or soup
        first = root.find(BLOCK_TAGS)
        inner = "".join(str(c) for c in root.contents)
        if first is None or first.name not in HEADING_TAGS:
            inner = f"<h1>{_escape(ch['title'])}</h1>" + inner
        item.content = (f"<html><head><title>{_escape(ch['title'])}</title></head>"
                        f"<body>{inner}</body></html>")
        book.add_item(item)
        items.append(item)

    book.toc = tuple(items)
    book.spine = ["nav", *items]
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    epub.write_epub(str(out_path), book)


def build_txt(title: str, chapters: list[dict]) -> str:
    """chapters: [{title, text}]"""
    parts = [title, ""]
    for ch in chapters:
        parts.append(ch["title"])
        parts.append("")
        parts.append(ch["text"])
        parts.append("")
    return "\n".join(parts)
