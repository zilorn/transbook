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

DEFAULT_CONFIG = {
    "api_key": "",
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "target_lang": "简体中文",
    "concurrency": 5,
    "max_segment_chars": 3000,
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

def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(_read_json(CONFIG_PATH, {}))
    cfg["concurrency"] = max(1, int(cfg.get("concurrency") or 5))
    cfg["max_segment_chars"] = max(500, int(cfg.get("max_segment_chars") or 3000))
    return cfg


def save_config(cfg: dict) -> dict:
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    with _lock:
        _write_json(CONFIG_PATH, merged)
    return load_config()


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
    for p in sorted(BOOKS_DIR.glob("*/book.json")):
        b = _read_json(p, None)
        if not b:
            continue
        total = len(b.get("chapters", []))
        done = sum(1 for c in b.get("chapters", []) if c.get("status") == "done")
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
        })
    out.sort(key=lambda x: x.get("created_at") or 0, reverse=True)
    return out


def delete_book(book_id: str) -> None:
    shutil.rmtree(BOOKS_DIR / book_id, ignore_errors=True)


def chapter_src_path(book_id: str, chapter_id: str) -> Path:
    return BOOKS_DIR / book_id / "chapters" / f"{chapter_id}.src"


def chapter_dst_path(book_id: str, chapter_id: str) -> Path:
    return BOOKS_DIR / book_id / "chapters" / f"{chapter_id}.dst"


def now() -> float:
    return time.time()
