"""FastAPI 入口：上传、书籍管理、术语表、翻译控制、导出、听书（TTS）、章节图片。"""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import posixpath
import re
import zipfile
from pathlib import Path
from urllib.parse import unquote

from fastapi import FastAPI, File, HTTPException, Query, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from . import parsing, store, translator, tts, webdav
from .crawlers import kakuyomu, syosetu

# uvicorn 只配置自己的 logger，应用 logger（app.*）传播到 root 后无 handler 会被丢弃，
# 这里给 root 装一个 handler 让应用日志（如 TTS 缓存命中）能输出到控制台
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="TranLatexBook")
app.include_router(webdav.router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIST = store.BASE_DIR.parent / "frontend" / "dist"


# ---------- 配置 ----------

def _mask(s: str) -> str:
    return s[:6] + "..." if s else ""


@app.get("/api/config")
def get_config():
    cfg = store.load_config()
    # 多 key 为空但存在旧的单 key 配置时，合成一条用于前端展示（保存时迁移为 api_keys）
    keys = cfg.get("api_keys") or []
    if not keys and cfg.get("api_key"):
        keys = [{"key": cfg["api_key"], "model": "", "concurrency": 0}]
    cfg["api_keys"] = [{**k, "key": _mask(k["key"])} for k in keys]
    cfg["api_key_set"] = bool(keys)
    cfg["api_key"] = _mask(cfg.get("api_key", ""))
    return cfg


class ConfigIn(BaseModel):
    api_key: str | None = None
    api_keys: list[dict] | None = None
    base_url: str | None = None
    model: str | None = None
    target_lang: str | None = None
    concurrency: int | None = None
    max_segment_chars: int | None = None
    webdav_enabled: bool | None = None


@app.put("/api/config")
def put_config(body: ConfigIn):
    cfg = store.load_config()
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    # 前端回显的是脱敏 key，原样提交时不覆盖
    if updates.get("api_key", "").endswith("..."):
        updates.pop("api_key")
    if "api_keys" in updates:
        # 脱敏 key 按位置回代原值；提交了 api_keys 即迁移掉旧的单 key 字段
        old = cfg.get("api_keys") or []
        if not old and cfg.get("api_key"):
            old = [{"key": cfg["api_key"], "model": "", "concurrency": 0}]
        merged_keys = []
        for i, k in enumerate(updates["api_keys"]):
            if isinstance(k, dict) and str(k.get("key") or "").endswith("..."):
                k = {**k, "key": old[i]["key"] if i < len(old) else ""}
            merged_keys.append(k)
        updates["api_keys"] = merged_keys
        updates["api_key"] = ""
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
    syosetu.stop_crawl(book_id)
    kakuyomu.stop_crawl(book_id)
    store.dequeue_book(book_id)
    store.delete_book(book_id)
    return {"ok": True}


class ProgressIn(BaseModel):
    cid: str
    y: float = 0


@app.get("/api/books/{book_id}/progress")
def get_read_progress(book_id: str):
    """阅读进度：{cid, y}，无记录时 cid 为 null。"""
    if not store.load_book(book_id):
        raise HTTPException(404, "书籍不存在")
    return store.get_read_progress(book_id) or {"cid": None, "y": 0}


@app.put("/api/books/{book_id}/progress")
def put_read_progress(book_id: str, body: ProgressIn):
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    if not any(c["id"] == body.cid for c in book.get("chapters", [])):
        raise HTTPException(404, "章节不存在")
    store.save_read_progress(book_id, body.cid, body.y)
    return {"ok": True}


class NoTranslateIn(BaseModel):
    no_translate: bool


@app.put("/api/books/{book_id}/no_translate")
def set_no_translate(book_id: str, body: NoTranslateIn):
    """标记/取消"无需翻译"：仅托管（阅读/导出/WebDAV），不参与任何翻译任务。"""
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    book["no_translate"] = bool(body.no_translate)
    if book["no_translate"]:
        # 标记后移出翻译队列（若正在翻译则由用户先停止，不强制中断）
        store.dequeue_book(book_id)
    store.save_book(book)
    return {"ok": True, "no_translate": book["no_translate"]}


def _check_translatable(book: dict) -> None:
    if book.get("no_translate"):
        raise HTTPException(400, "该书已标记为无需翻译（仅托管），无法执行翻译相关操作")


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


# ---------- 听书（edge-tts） ----------

@app.get("/api/tts/voices")
def tts_voices():
    return {"voices": tts.VOICES, "default": tts.DEFAULT_VOICE}


def _check_voice(voice: str) -> str:
    voice = voice or tts.DEFAULT_VOICE
    if voice not in tts.VOICES:
        raise HTTPException(400, "不支持的音色")
    return voice


class TtsSpeakReq(BaseModel):
    text: str
    voice: str = ""
    rate: float = 1.0


class TtsWarmReq(BaseModel):
    texts: list[str]
    voice: str = ""
    rate: float = 1.0


def _check_rate(rate: float) -> float:
    if not 0.5 <= rate <= 2.0:
        raise HTTPException(400, "不支持的倍速（0.5~2.0）")
    return rate


@app.post("/api/tts/warm")
async def tts_warm(req: TtsWarmReq):
    """听书批量预热：一批句文本高并发合成落盘缓存，前端播放时逐句请求全部毫秒级命中。

    逐句冷合成约 1.5s，浏览器同源连接数有限，逐句预取在冷缓存设备上跑不过播放；
    批量预热由后端 asyncio 高并发执行，不受浏览器连接数限制。
    """
    voice = _check_voice(req.voice)
    rate = _check_rate(req.rate)
    if len(req.texts) > 100:
        raise HTTPException(400, "单批最多 100 句")
    if any(len(t) > tts.MAX_TEXT_CHARS for t in req.texts):
        raise HTTPException(400, f"存在超长文本（>{tts.MAX_TEXT_CHARS} 字）")
    try:
        done, failed = await asyncio.wait_for(tts.warm_cache(req.texts, voice, rate), timeout=180)
    except TimeoutError:
        raise HTTPException(504, "批量合成超时")
    return {"ok": True, "done": done, "failed": failed}


@app.post("/api/tts/speak")
async def tts_speak(req: TtsSpeakReq):
    """任意文本语音（mp3）：前端自行分句后直接发句文本合成，按 音色+倍速+文本 哈希全局缓存。"""
    voice = _check_voice(req.voice)
    rate = _check_rate(req.rate)
    try:
        path = await asyncio.wait_for(tts.synthesize_text(req.text, voice, rate), timeout=60)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except TimeoutError:
        raise HTTPException(504, "语音合成超时")
    except Exception as e:
        raise HTTPException(502, f"语音合成失败: {e}")
    return FileResponse(path, media_type="audio/mpeg")


# ---------- 章节图片（epub 内嵌图） ----------

_epub_files_cache: dict[str, tuple[float, dict[str, str]]] = {}


def _epub_chapter_file(epub_path: Path, chapter_id: str) -> str | None:
    """章节 id → epub 内部文档路径，按文件 mtime 缓存。"""
    key = str(epub_path)
    mtime = epub_path.stat().st_mtime
    hit = _epub_files_cache.get(key)
    if not hit or hit[0] != mtime:
        hit = (mtime, parsing.epub_chapter_files(epub_path))
        _epub_files_cache[key] = hit
    return hit[1].get(chapter_id)


@app.get("/api/books/{book_id}/chapters/{chapter_id}/image")
def chapter_image(book_id: str, chapter_id: str, src: str = ""):
    """epub 章节内嵌图片：按章节文档路径解析相对 src，从原始 epub 中读取。"""
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    source_file = book.get("source_file") or ""
    epub_path = store.BOOKS_DIR / book_id / source_file
    if not source_file.lower().endswith(".epub") or not epub_path.exists():
        raise HTTPException(404, "该书没有 epub 源文件")
    item_name = _epub_chapter_file(epub_path, chapter_id)
    if not item_name or not src:
        raise HTTPException(404, "图片不存在")
    rel = posixpath.normpath(
        posixpath.join(posixpath.dirname(item_name), unquote(src))).lstrip("/")
    if rel.startswith(".."):
        raise HTTPException(400, "非法的图片路径")
    try:
        with zipfile.ZipFile(epub_path) as zf:
            names = zf.namelist()
            if rel in names:
                data = zf.read(rel)
            else:
                # 部分 epub 的 HTML 相对路径与 zip 实际结构不一致，按同名文件兜底，
                # 多个同名时取与解析路径后缀重合最长者
                base = posixpath.basename(rel)
                cands = [n for n in names if posixpath.basename(n) == base]
                if not cands:
                    raise KeyError(rel)
                best = max(cands, key=lambda n: _common_suffix_len(n, rel))
                data = zf.read(best)
    except KeyError:
        raise HTTPException(404, "图片不存在")
    media_type = mimetypes.guess_type(rel)[0] or "application/octet-stream"
    return Response(content=data, media_type=media_type,
                    headers={"Cache-Control": "max-age=86400"})


def _common_suffix_len(a: str, b: str) -> int:
    n = 0
    for x, y in zip(reversed(a), reversed(b)):
        if x != y:
            break
        n += 1
    return n


# ---------- 术语表 ----------

@app.post("/api/books/{book_id}/glossary/generate")
async def gen_glossary(book_id: str):
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    _check_translatable(book)
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
              "type": str(t.get("type", "术语")).strip() or "术语",
              "note": str(t.get("note", "")).strip()}
             for t in body.terms]
    book["glossary"] = [t for t in terms if t["src"]]
    store.save_book(book)
    return {"ok": True, "count": len(book["glossary"])}


# ---------- syosetu 爬虫 ----------

@app.get("/api/syosetu/search")
async def syosetu_search(q: str):
    if not q.strip():
        return {"results": []}
    try:
        return {"results": await syosetu.search(q.strip())}
    except Exception as e:
        raise HTTPException(502, f"搜索失败: {e}")


@app.get("/api/syosetu/rankings")
async def syosetu_rankings(period: str = "daily", genre: str = "total",
                           kind: str = "total"):
    """排行榜（发现页）：周期 × 分类，综合榜可按范围（连载/完结/短篇）筛选。"""
    if period not in syosetu.RANK_PERIODS or genre not in syosetu.RANK_GENRES \
            or kind not in syosetu.RANK_KINDS:
        raise HTTPException(400, "无效的排行榜筛选参数")
    try:
        return {"results": await syosetu.rankings(period, genre, kind),
                "periods": syosetu.RANK_PERIODS,
                "genres": syosetu.RANK_GENRES,
                "kinds": syosetu.RANK_KINDS}
    except Exception as e:
        raise HTTPException(502, f"排行榜获取失败: {e}")


class FetchIn(BaseModel):
    url: str


@app.post("/api/syosetu/fetch")
async def syosetu_fetch(body: FetchIn):
    """按作品链接/N コード创建书籍并启动后台爬取（逐章落盘）。"""
    ncode = syosetu.parse_ncode(body.url)
    if not ncode:
        raise HTTPException(400, "无法识别 ncode.syosetu.com 作品链接或作品编号")
    book_id = store.new_book_id()
    store.book_dir(book_id)
    book = {
        "id": book_id,
        "title": ncode,  # 书名在爬取到目录后回填
        "title_translated": None,
        "author": "",
        "format": "txt",
        "source_file": "",
        "created_at": store.now(),
        "status": "ready",
        "error": None,
        "glossary": [],
        "chapters": [],
        "source": {"site": "syosetu",
                   "url": f"https://ncode.syosetu.com/{ncode}/",
                   "ncode": ncode},
    }
    store.save_book(book)
    syosetu.start_crawl(book_id)
    return book


@app.get("/api/syosetu/status/{book_id}")
def syosetu_status(book_id: str):
    return syosetu.progress(book_id)


@app.post("/api/syosetu/stop/{book_id}")
async def syosetu_stop(book_id: str):
    syosetu.stop_crawl(book_id)
    return {"ok": True}


@app.post("/api/books/{book_id}/syosetu/update")
async def syosetu_update(book_id: str):
    """增量更新：只抓本地缺失的最新章节。"""
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    if not book.get("source"):
        raise HTTPException(400, "该书没有网络来源，无法更新")
    if translator.is_running(book_id):
        raise HTTPException(409, "翻译进行中，请先停止再更新章节")
    if not syosetu.start_update(book_id):
        raise HTTPException(409, "该书已有爬取任务在运行")
    return {"ok": True}


# ---------- kakuyomu 爬虫 ----------

@app.get("/api/kakuyomu/search")
async def kakuyomu_search(q: str, genre: list[str] = Query(default=[])):
    if not q.strip():
        return {"results": []}
    try:
        return {"results": await kakuyomu.search(q.strip(), genre),
                "genres": kakuyomu.GENRES}
    except Exception as e:
        raise HTTPException(502, f"搜索失败: {e}")


@app.get("/api/kakuyomu/genres")
def kakuyomu_genres():
    return {"genres": kakuyomu.GENRES}


@app.get("/api/kakuyomu/rankings")
async def kakuyomu_rankings(genre: str = "all", period: str = "weekly",
                            variation: str = "all"):
    """排行榜（发现页）：类型 × 周期 × 篇幅。"""
    if genre not in kakuyomu.RANK_GENRES or period not in kakuyomu.RANK_PERIODS \
            or variation not in kakuyomu.RANK_VARIATIONS:
        raise HTTPException(400, "无效的排行榜筛选参数")
    try:
        return {"results": await kakuyomu.rankings(genre, period, variation),
                "genres": kakuyomu.RANK_GENRES,
                "periods": kakuyomu.RANK_PERIODS,
                "variations": kakuyomu.RANK_VARIATIONS}
    except Exception as e:
        raise HTTPException(502, f"排行榜获取失败: {e}")


@app.post("/api/kakuyomu/fetch")
async def kakuyomu_fetch(body: FetchIn):
    """按作品/章节链接或作品 ID 创建书籍并启动后台爬取（逐章落盘）。"""
    work_id = kakuyomu.parse_work_id(body.url)
    if not work_id:
        raise HTTPException(400, "无法识别 kakuyomu.jp 作品链接或作品 ID")
    book_id = store.new_book_id()
    store.book_dir(book_id)
    book = {
        "id": book_id,
        "title": work_id,  # 书名在爬取到目录后回填
        "title_translated": None,
        "author": "",
        "format": "txt",
        "source_file": "",
        "created_at": store.now(),
        "status": "ready",
        "error": None,
        "glossary": [],
        "chapters": [],
        "source": {"site": "kakuyomu",
                   "url": f"https://kakuyomu.jp/works/{work_id}",
                   "work_id": work_id},
    }
    store.save_book(book)
    kakuyomu.start_crawl(book_id)
    return book


@app.get("/api/kakuyomu/status/{book_id}")
def kakuyomu_status(book_id: str):
    return kakuyomu.progress(book_id)


@app.post("/api/kakuyomu/stop/{book_id}")
async def kakuyomu_stop(book_id: str):
    kakuyomu.stop_crawl(book_id)
    return {"ok": True}


@app.post("/api/books/{book_id}/kakuyomu/update")
async def kakuyomu_update(book_id: str):
    """增量更新：只抓本地缺失的最新章节。"""
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    if not book.get("source"):
        raise HTTPException(400, "该书没有网络来源，无法更新")
    if translator.is_running(book_id):
        raise HTTPException(409, "翻译进行中，请先停止再更新章节")
    if not kakuyomu.start_update(book_id):
        raise HTTPException(409, "该书已有爬取任务在运行")
    return {"ok": True}


# ---------- 翻译控制 ----------

class TranslateIn(BaseModel):
    chapter_ids: list[str] | None = None
    overwrite: bool = False


@app.post("/api/books/{book_id}/translate")
async def start_translate(book_id: str, body: TranslateIn | None = None):
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    _check_translatable(book)
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
    _check_translatable(book)
    if not any(c["id"] == chapter_id for c in book["chapters"]):
        raise HTTPException(404, "章节不存在")
    if not translator.start_translation(book_id, [chapter_id], overwrite=True):
        raise HTTPException(409, "该书已有任务在运行")
    return {"ok": True}


@app.post("/api/books/{book_id}/title/retranslate")
async def retranslate_title(book_id: str):
    """重翻书名（不影响章节）。"""
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    _check_translatable(book)
    if not translator.start_title_retranslate(book_id, "book"):
        raise HTTPException(409, "该书已有任务在运行")
    return {"ok": True}


@app.post("/api/books/{book_id}/toc/retranslate")
async def retranslate_toc(book_id: str):
    """重翻目录（全部章节标题，不改正文）。"""
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    _check_translatable(book)
    if not translator.start_title_retranslate(book_id, "toc"):
        raise HTTPException(409, "该书已有任务在运行")
    return {"ok": True}


# ---------- 翻译队列 ----------

class QueueIn(BaseModel):
    book_id: str
    chapter_ids: list[str] | None = None
    overwrite: bool = False


@app.get("/api/queue")
def get_queue():
    return {"running": translator.queue_running(), "entries": store.load_queue()}


@app.post("/api/queue")
def add_to_queue(body: QueueIn):
    book = store.load_book(body.book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    _check_translatable(book)
    q = store.enqueue_book(body.book_id, body.chapter_ids, body.overwrite)
    return {"ok": True, "entries": q, "running": translator.queue_running()}


@app.delete("/api/queue/{book_id}")
def remove_from_queue(book_id: str):
    if translator.queue_current() == book_id:
        raise HTTPException(409, "该书正在翻译，请先停止队列")
    return {"ok": True, "entries": store.dequeue_book(book_id)}


@app.post("/api/queue/start")
async def start_queue():
    if not store.load_queue():
        raise HTTPException(400, "队列为空")
    if not translator.start_queue():
        raise HTTPException(409, "队列已在运行")
    return {"ok": True}


@app.post("/api/queue/stop")
async def stop_queue():
    translator.stop_queue()
    return {"ok": True}


@app.get("/api/queue/status")
def queue_status():
    """队列 + 每本书的章节/分段进度，供翻译页轮询。"""
    entries = []
    for e in store.load_queue():
        book = store.load_book(e["book_id"])
        if not book:
            continue
        entries.append({
            "book_id": e["book_id"],
            "overwrite": bool(e.get("overwrite")),
            "title": book.get("title") or "",
            "title_translated": book.get("title_translated"),
            "status": book.get("status"),
            "error": book.get("error"),
            "running": translator.is_running(book["id"]),
            "chapters": [{
                "id": c["id"], "title": c["title"],
                "title_translated": c.get("title_translated"),
                "status": c.get("status"), "error": c.get("error"),
                "seg_total": c.get("seg_total"), "seg_done": c.get("seg_done"),
            } for c in book.get("chapters", [])],
        })
    return {"running": translator.queue_running(), "entries": entries}


# ---------- 导出 ----------

@app.get("/api/books/{book_id}/export")
def export_book(book_id: str, fmt: str = "txt"):
    book = store.load_book(book_id)
    if not book:
        raise HTTPException(404, "书籍不存在")
    chapters = webdav.collect_chapters(book)
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
