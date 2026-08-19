"""持久化存储：配置与书籍清单，全部落在 backend/data/ 下。"""
from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
BOOKS_DIR = DATA_DIR / "books"
CONFIG_PATH = DATA_DIR / "config.json"
QUEUE_PATH = DATA_DIR / "queue.json"
PROGRESS_PATH = DATA_DIR / "progress.json"
GROUPS_PATH = DATA_DIR / "groups.json"

DEFAULT_CONFIG = {
    "api_key": "",
    "api_keys": [],
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "target_lang": "简体中文",
    "concurrency": 5,
    "max_segment_chars": 8000,
    "webdav_enabled": False,
    "update_repo": "",
    "update_branch": "main",
    "github_token": "",
}

_lock = threading.Lock()

BOOKS_DIR.mkdir(parents=True, exist_ok=True)


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


# ---------- 全局配置 ----------

def _norm_keys(keys) -> list[dict]:
    """规范化多 API Key 配置：key 必填；model 为空表示跟随统一模型；
    concurrency 为 0 表示跟随统一并发数。"""
    out = []
    for k in keys or []:
        if not isinstance(k, dict):
            continue
        key = str(k.get("key") or "").strip()
        if not key:
            continue
        try:
            conc = max(0, int(k.get("concurrency") or 0))
        except (TypeError, ValueError):
            conc = 0
        out.append({"key": key, "model": str(k.get("model") or "").strip(),
                    "concurrency": conc})
    return out


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(_read_json(CONFIG_PATH, {}))
    cfg["concurrency"] = max(1, int(cfg.get("concurrency") or 5))
    cfg["max_segment_chars"] = max(500, int(cfg.get("max_segment_chars") or 8000))
    cfg["api_keys"] = _norm_keys(cfg.get("api_keys"))
    return cfg


def save_config(cfg: dict) -> dict:
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    merged["api_keys"] = _norm_keys(merged.get("api_keys"))
    with _lock:
        _write_json(CONFIG_PATH, merged)
    return load_config()


# ---------- 翻译队列 ----------

def load_queue() -> list[dict]:
    q = _read_json(QUEUE_PATH, [])
    if not isinstance(q, list):
        return []
    return [e for e in q if isinstance(e, dict) and e.get("book_id")]


def save_queue(entries: list[dict]) -> None:
    with _lock:
        _write_json(QUEUE_PATH, entries)


def enqueue_book(book_id: str, chapter_ids: list[str] | None = None,
                 overwrite: bool = False) -> list[dict]:
    """加入翻译队列；同一本书重复加入时替换旧条目（后加的生效）。"""
    q = [e for e in load_queue() if e["book_id"] != book_id]
    q.append({"book_id": book_id, "chapter_ids": chapter_ids,
              "overwrite": bool(overwrite), "added_at": now()})
    save_queue(q)
    return q


def dequeue_book(book_id: str) -> list[dict]:
    q = [e for e in load_queue() if e["book_id"] != book_id]
    save_queue(q)
    return q


# ---------- 分组 ----------

def load_groups() -> list[dict]:
    gs = _read_json(GROUPS_PATH, [])
    if not isinstance(gs, list):
        return []
    return [g for g in gs
            if isinstance(g, dict) and g.get("id") and isinstance(g.get("name"), str)]


def save_groups(groups: list[dict]) -> None:
    with _lock:
        _write_json(GROUPS_PATH, groups)


def create_group(name: str) -> dict:
    g = {"id": uuid.uuid4().hex[:8], "name": name, "created_at": now()}
    gs = load_groups()
    gs.append(g)
    save_groups(gs)
    return g


def delete_group(group_id: str) -> bool:
    gs = load_groups()
    kept = [g for g in gs if g["id"] != group_id]
    if len(kept) == len(gs):
        return False
    save_groups(kept)
    # 组内书籍回落为未分组
    for p in BOOKS_DIR.glob("*/book.json"):
        b = _read_json(p, None)
        if b and b.get("group_id") == group_id:
            b["group_id"] = None
            with _lock:
                _write_json(p, b)
    return True


# ---------- 阅读进度 ----------

def get_read_progress(book_id: str) -> dict | None:
    p = _read_json(PROGRESS_PATH, {})
    if not isinstance(p, dict):
        return None
    e = p.get(book_id)
    if not isinstance(e, dict) or not isinstance(e.get("cid"), str):
        return None
    try:
        y = max(0.0, float(e.get("y") or 0))
    except (TypeError, ValueError):
        y = 0.0
    return {"cid": e["cid"], "y": y}


def save_read_progress(book_id: str, cid: str, y: float) -> None:
    with _lock:
        p = _read_json(PROGRESS_PATH, {})
        if not isinstance(p, dict):
            p = {}
        p[book_id] = {"cid": cid, "y": max(0.0, float(y)), "t": now()}
        _write_json(PROGRESS_PATH, p)


# ---------- 书籍 ----------

def new_book_id() -> str:
    return uuid.uuid4().hex[:12]


def book_dir(book_id: str) -> Path:
    d = BOOKS_DIR / book_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "chapters").mkdir(exist_ok=True)
    return d


def book_path(book_id: str) -> Path:
    return BOOKS_DIR / book_id / "book.json"


def load_book(book_id: str) -> dict | None:
    book = _read_json(book_path(book_id), None)
    return book


def save_book(book: dict) -> None:
    with _lock:
        _write_json(book_path(book["id"]), book)


def list_books() -> list[dict]:
    out = []
    prog_map = _read_json(PROGRESS_PATH, {})
    if not isinstance(prog_map, dict):
        prog_map = {}
    for p in sorted(BOOKS_DIR.glob("*/book.json")):
        b = _read_json(p, None)
        if not b:
            continue
        total = len(b.get("chapters", []))
        done = sum(1 for c in b.get("chapters", []) if c.get("status") == "done")
        # 阅读进度：上次读到的章节（序号 + 标题，译名优先），无记录为 None
        read_progress = None
        prog = prog_map.get(b["id"])
        last_read_at = 0.0
        if isinstance(prog, dict):
            try:
                last_read_at = float(prog.get("t") or 0)
            except (TypeError, ValueError):
                last_read_at = 0.0
            if isinstance(prog.get("cid"), str):
                for i, c in enumerate(b.get("chapters", [])):
                    if c.get("id") == prog["cid"]:
                        read_progress = {
                            "index": i + 1,
                            "title": c.get("title_translated") or c.get("title") or "",
                        }
                        break
        created_at = b.get("created_at") or 0
        out.append({
            "id": b["id"],
            "title": b.get("title") or "",
            "title_translated": b.get("title_translated") or "",
            "author": b.get("author") or "",
            "format": b.get("format"),
            "status": b.get("status"),
            "created_at": b.get("created_at"),
            "chapters": total,
            "done": done,
            "glossary_count": len(b.get("glossary") or []),
            "source": b.get("source"),
            "no_translate": bool(b.get("no_translate")),
            "group_id": b.get("group_id"),
            "read_progress": read_progress,
            "last_read_at": last_read_at or None,
            "_sort_at": max(last_read_at, float(created_at)),
        })
    # 书架排序：最近阅读的排最前；未阅读的按导入时间排（刚导入的靠前）
    out.sort(key=lambda x: x["_sort_at"], reverse=True)
    for x in out:
        x.pop("_sort_at", None)
    return out


def delete_book(book_id: str) -> None:
    shutil.rmtree(BOOKS_DIR / book_id, ignore_errors=True)


def chapter_src_path(book_id: str, chapter_id: str) -> Path:
    return BOOKS_DIR / book_id / "chapters" / f"{chapter_id}.src"


def chapter_dst_path(book_id: str, chapter_id: str) -> Path:
    return BOOKS_DIR / book_id / "chapters" / f"{chapter_id}.dst"


def now() -> float:
    return time.time()
