"""FastAPI 入口：上传、书籍管理、术语表、翻译控制、导出。"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from . import parsing, store, translator

app = FastAPI(title="TranLatexBook")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIST = store.BASE_DIR.parent / "frontend" / "dist"


# ---------- 配置 ----------

@app.get("/api/config")
def get_config():
    cfg = store.load_config()
    cfg["api_key_set"] = bool(cfg.get("api_key"))
    cfg["api_key"] = cfg.get("api_key", "")[:6] + "..." if cfg.get("api_key") else ""
    return cfg


class ConfigIn(BaseModel):
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    target_lang: str | None = None
    concurrency: int | None = None
    max_segment_chars: int | None = None


@app.put("/api/config")
def put_config(body: ConfigIn):
    cfg = store.load_config()
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    # 前端回显的是脱敏 key，原样提交时不覆盖
    if updates.get("api_key", "").endswith("..."):
        updates.pop("api_key")
    cfg.update(updates)
    return store.save_config(cfg)


# ---------- 书籍 ----------

def _persist_chapters(book_id: str, pairs: list[tuple[str, str, str]],
                      start_n: int = 1) -> list[dict]:
    """pairs: [(title, body, fmt)]，写盘并返回章节清单条目。"""
    chapters = []
    for n, (title, body, fmt) in enumerate(pairs, start_n):
        cid = f"ch{n:04d}"
        store.chapter_src_path(book_id, cid).write_text(body, encoding="utf-8")
        chapters.append({"id": cid, "title": title, "title_translated": None,
                         "status": "pending", "error": None, "format": fmt})
    return chapters


def _parse_upload(raw: bytes, filename: str) -> tuple[list[tuple[str, str, str]], dict | None]:
    """解析上传内容，返回 ([(title, body, fmt)], epub_meta_or_None)。"""
    suffix = Path(filename).suffix.lower()
    if suffix == ".txt":
        text = parsing.decode_text(raw)
        return [(t, b, "txt") for t, b in parsing.split_txt_chapters(text)], None
    if suffix == ".epub":
        tmp = store.DATA_DIR / f"tmp_{store.new_book_id()}.epub"
        try:
            tmp.write_bytes(raw)
            meta, parsed = parsing.parse_epub(tmp)
        finally:
            tmp.unlink(missing_ok=True)
        return [(c["title"], c["body"], "epub") for c in parsed], meta
    raise HTTPException(400, "仅支持 .txt 或 .epub 文件")


@app.post("/api/books")
async def upload_book(file: UploadFile = File(...)):
    filename = file.filename or "book"
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "文件为空")

    try:
        pairs, meta = _parse_upload(raw, filename)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"文件解析失败: {e}")
    if not pairs:
        raise HTTPException(400, "未能从文件中解析出内容")

    book_id = store.new_book_id()
    d = store.book_dir(book_id)
    suffix = Path(filename).suffix.lower()
    (d / f"source{suffix}").write_bytes(raw)
    chapters = _persist_chapters(book_id, pairs)
    fmt = "epub" if suffix == ".epub" else "txt"

    book = {
        "id": book_id,
        "title": (meta or {}).get("title") or Path(filename).stem,
        "title_translated": None,
        "author": (meta or {}).get("author") or "",
        "format": fmt,
        "source_file": f"source{suffix}",
        "created_at": store.now(),
        "status": "ready",
        "error": None,
        "glossary": [],
        "chapters": chapters,
    }
    store.save_book(book)
    return book


def _norm_title(t: str) -> str:
    return re.sub(r"\s+", "", t).lower()


def _norm_body(t: str) -> str:
    return re.sub(r"\s+", "", t)[:300]


def _existing_fingerprints(book: dict) -> tuple[set, set]:
    """已有章节的标题/正文指纹，用于查重。"""
    titles, bodies = set(), set()
    for ch in book["chapters"]:
        titles.add(_norm_title(ch["title"]))
        p = store.chapter_src_path(book["id"], ch["id"])
        if p.exists():
            bodies.add(_norm_body(p.read_text(encoding="utf-8", errors="replace")))
    return titles, bodies


@app.post("/api/books/{book_id}/chapters/preview")
async def preview_chapters(book_id: str, file: UploadFile = File(...)):
    """解析待追加的 txt/epub 文件，返回章节清单（含查重标记），不写入。"""
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    if translator.is_running(book_id):
        raise HTTPException(409, "翻译进行中，请先停止再添加章节")

    raw = await file.read()
    if not raw:
        raise HTTPException(400, "文件为空")
    try:
        pairs, _ = _parse_upload(raw, file.filename or "")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"文件解析失败: {e}")
    if not pairs:
        raise HTTPException(400, "未能从文件中解析出新章节")

    titles, bodies = _existing_fingerprints(book)
    out = []
    for i, (title, body, fmt) in enumerate(pairs):
        snippet = re.sub(r"<[^>]+>", " ", body) if fmt == "epub" else body
        snippet = re.sub(r"\s+", " ", snippet).strip()[:100]
        out.append({
            "index": i, "title": title, "format": fmt, "body": body,
            "chars": len(body), "snippet": snippet,
            "duplicate": _norm_title(title) in titles or _norm_body(body) in bodies,
        })
    return {"chapters": out, "existing": len(book["chapters"])}


class ChapterIn(BaseModel):
    title: str
    body: str
    format: str = "txt"


class ChaptersIn(BaseModel):
    chapters: list[ChapterIn]


@app.post("/api/books/{book_id}/chapters")
async def add_chapters(book_id: str, body: ChaptersIn):
    """追加章节：前端显式给出每章标题与正文（粘贴文本或预览勾选后的结果）。"""
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    if translator.is_running(book_id):
        raise HTTPException(409, "翻译进行中，请先停止再添加章节")

    pairs = []
    for c in body.chapters:
        title, text = c.title.strip(), c.body.strip()
        if not title or not text:
            continue
        fmt = c.format if c.format in ("txt", "epub") else "txt"
        pairs.append((title, c.body, fmt))
    if not pairs:
        raise HTTPException(400, "没有可添加的章节（标题与正文均不能为空）")

    start_n = len(book["chapters"]) + 1
    book["chapters"].extend(_persist_chapters(book_id, pairs, start_n))
    if book.get("status") in ("done", "error", "paused"):
        book["status"] = "ready"
    store.save_book(book)
    return {"ok": True, "added": len(pairs), "total": len(book["chapters"])}


@app.get("/api/books")
def list_books():
    return store.list_books()


@app.get("/api/books/{book_id}")
def get_book(book_id: str):
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    book["running"] = translator.is_running(book_id)
    return book


@app.delete("/api/books/{book_id}")
def delete_book(book_id: str):
    translator.stop_translation(book_id)
    store.delete_book(book_id)
    return {"ok": True}


@app.get("/api/books/{book_id}/chapters/{chapter_id}/content")
def chapter_content(book_id: str, chapter_id: str, translated: bool = False):
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    p = store.chapter_dst_path(book_id, chapter_id) if translated \
        else store.chapter_src_path(book_id, chapter_id)
    if not p.exists():
        raise HTTPException(404, "内容不存在")
    return PlainTextResponse(p.read_text(encoding="utf-8", errors="replace"))


# ---------- 术语表 ----------

@app.post("/api/books/{book_id}/glossary/generate")
async def gen_glossary(book_id: str):
    if not store.load_book(book_id):
        raise HTTPException(404, "书籍不存在")
    if not translator.start_glossary(book_id):
        raise HTTPException(409, "该书已有任务在运行")
    return {"ok": True}


class GlossaryIn(BaseModel):
    terms: list[dict]


@app.put("/api/books/{book_id}/glossary")
def put_glossary(book_id: str, body: GlossaryIn):
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    terms = [{"src": str(t.get("src", "")).strip(),
              "dst": str(t.get("dst", "")).strip(),
              "type": str(t.get("type", "术语")).strip() or "术语"}
             for t in body.terms]
    book["glossary"] = [t for t in terms if t["src"]]
    store.save_book(book)
    return {"ok": True, "count": len(book["glossary"])}


# ---------- 翻译控制 ----------

class TranslateIn(BaseModel):
    chapter_ids: list[str] | None = None
    overwrite: bool = False


@app.post("/api/books/{book_id}/translate")
async def start_translate(book_id: str, body: TranslateIn | None = None):
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    body = body or TranslateIn()
    if not translator.start_translation(book_id, body.chapter_ids, body.overwrite):
        raise HTTPException(409, "该书已有任务在运行")
    return {"ok": True}


@app.post("/api/books/{book_id}/stop")
async def stop_translate(book_id: str):
    translator.stop_translation(book_id)
    return {"ok": True}


@app.post("/api/books/{book_id}/chapters/{chapter_id}/retranslate")
async def retranslate_chapter(book_id: str, chapter_id: str):
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    if not any(c["id"] == chapter_id for c in book["chapters"]):
        raise HTTPException(404, "章节不存在")
    if not translator.start_translation(book_id, [chapter_id], overwrite=True):
        raise HTTPException(409, "该书已有任务在运行")
    return {"ok": True}


# ---------- 导出 ----------

def _collect_chapters(book: dict) -> list[dict]:
    """返回 [{title, text, html}]，优先使用译文。"""
    out = []
    for ch in book["chapters"]:
        dst = store.chapter_dst_path(book["id"], ch["id"])
        src = store.chapter_src_path(book["id"], ch["id"])
        p = dst if dst.exists() else src
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


@app.get("/api/books/{book_id}/export")
def export_book(book_id: str, fmt: str = "txt"):
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    chapters = _collect_chapters(book)
    title = book.get("title_translated") or book["title"]
    safe = re.sub(r'[\\/:*?"<>|]', "_", title) or "book"

    if fmt == "epub":
        out = store.BOOKS_DIR / book_id / "export.epub"
        parsing.build_epub(title, book.get("author") or "", chapters, out)
        return FileResponse(out, media_type="application/epub+zip",
                            filename=f"{safe}.epub")
    text = parsing.build_txt(title, chapters)
    return PlainTextResponse(
        text, media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_urlquote(safe)}.txt"})


def _urlquote(s: str) -> str:
    from urllib.parse import quote
    return quote(s)


# ---------- 前端静态文件（生产模式可选） ----------

if FRONTEND_DIST.exists():
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
