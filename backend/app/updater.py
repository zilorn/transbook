"""自动更新（GitHub）：进入页面时前端触发一次检查，服务端受冷却时间限制不会频繁
请求 GitHub；远端 commit 与本地不一致时仅标记"有更新"，由用户点击确认后才执行：
下载源码 tarball → 暂存目录构建前端 → 同步依赖 → 替换 backend/app 与 frontend/dist
→ 重启进程（Docker 靠 restart 策略自动拉起，容器文件系统跨重启保留，完成热更新）。
当前版本 commit 优先级：data/update_state.json（上次更新的结果）→ 镜像构建时写入的
build-info.json → 本地 git（开发环境）。检查/更新状态持久化在 update_state.json，
重启后不丢、冷却跨重启有效。"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import tarfile
import threading
import time
from pathlib import Path

import httpx

from . import store

log = logging.getLogger(__name__)

APP_ROOT = store.BASE_DIR.parent           # 仓库根（容器内 /app）
APP_DIR = store.BASE_DIR / "app"           # 后端代码目录
DIST_DIR = APP_ROOT / "frontend" / "dist"  # 前端产物
BUILD_INFO_PATH = APP_ROOT / "build-info.json"  # Dockerfile 构建参数写入
UPDATE_DIR = store.DATA_DIR / "update"     # 更新工作区（下载/解压/构建）
STATE_PATH = store.DATA_DIR / "update_state.json"

# 未配置仓库时的默认更新源
DEFAULT_REPO = "zilorn/transbook"
# 检查冷却：距上次检查不足该间隔时不重复请求 GitHub
CHECK_COOLDOWN = 1800

# 运行时状态（不持久化）：idle/checking/available/updating/restarting/restart_required/error
_state: dict = {"status": "idle", "error": None}
_busy = False  # 检查/应用整体互斥


def _set(**kw) -> None:
    _state.update(kw)


def _load_persisted() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_persisted(obj: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE_PATH)


def _persist_check(sha: str, msg: str) -> None:
    p = _load_persisted()
    p.update({"remote_sha": sha, "remote_msg": msg, "last_check": time.time()})
    _save_persisted(p)


def _build_info() -> dict:
    try:
        return json.loads(BUILD_INFO_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _git(*args: str) -> str:
    try:
        r = subprocess.run(["git", "-C", str(APP_ROOT), *args],
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def norm_repo(s: str) -> str:
    """接受 owner/name、https://github.com/owner/name(.git)、git@github.com:owner/name.git。"""
    s = (s or "").strip().rstrip("/")
    s = re.sub(r"^https?://(www\.)?github\.com/", "", s)
    s = re.sub(r"^git@github\.com:", "", s)
    s = s.removesuffix(".git")
    return s if re.fullmatch(r"[\w.-]+/[\w.-]+", s) else ""


def resolve_repo(cfg: dict) -> str:
    return (norm_repo(cfg.get("update_repo") or "")
            or norm_repo(_build_info().get("repo", ""))
            or norm_repo(_git("config", "--get", "remote.origin.url"))
            or DEFAULT_REPO)


def resolve_branch(cfg: dict) -> str:
    return (cfg.get("update_branch") or "").strip() or "main"


def current_sha() -> str:
    return (_load_persisted().get("current_sha")
            or _build_info().get("commit")
            or _git("rev-parse", "HEAD")
            or "")


def in_docker() -> bool:
    return Path("/.dockerenv").exists()


def status() -> dict:
    cfg = store.load_config()
    p = _load_persisted()
    cur = current_sha()
    remote = p.get("remote_sha")
    return {
        "status": _state.get("status", "idle"),
        "error": _state.get("error"),
        "repo": resolve_repo(cfg),
        "branch": resolve_branch(cfg),
        "current_sha": cur,
        "remote_sha": remote,
        "remote_msg": p.get("remote_msg"),
        "last_check": p.get("last_check"),
        "update_available": bool(remote and remote != cur),
        "in_docker": in_docker(),
        "cooldown_min": CHECK_COOLDOWN // 60,
    }


async def fetch_remote_sha(repo: str, branch: str, token: str = "") -> tuple[str, str]:
    """返回 (sha, 提交信息首行)。"""
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with httpx.AsyncClient(timeout=30, headers=headers) as client:
        r = await client.get(f"https://api.github.com/repos/{repo}/commits/{branch}")
        if r.status_code == 404:
            raise RuntimeError("仓库或分支不存在（私有仓库需配置 GitHub Token）")
        r.raise_for_status()
        data = r.json()
        msg = (data.get("commit", {}).get("message") or "").splitlines()[0]
        return data["sha"], msg


# ---------- 应用更新（阻塞操作，经 asyncio.to_thread 执行） ----------

def _run(cmd: list[str], cwd: Path, timeout: int = 600) -> None:
    log.info("update: run %s (cwd=%s)", " ".join(cmd), cwd)
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"命令执行失败: {' '.join(cmd)}\n{(r.stdout + r.stderr)[-2000:]}")


def _download_tarball(repo: str, sha: str, token: str, dest: Path) -> None:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with httpx.Client(timeout=httpx.Timeout(300, connect=30),
                      follow_redirects=True, headers=headers) as client:
        with client.stream("GET", f"https://api.github.com/repos/{repo}/tarball/{sha}") as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in r.iter_bytes(1 << 16):
                    f.write(chunk)


def _swap_dir(new: Path, dst: Path) -> None:
    """用 new 替换 dst 目录（先挪走旧目录再复制，失败残留 .old 不影响运行）。"""
    old = dst.with_name(dst.name + ".old")
    shutil.rmtree(old, ignore_errors=True)
    if dst.exists():
        dst.rename(old)
    shutil.copytree(new, dst)
    shutil.rmtree(old, ignore_errors=True)


def _apply_update(repo: str, sha: str, token: str) -> None:
    bun = shutil.which("bun")
    if not bun:
        raise RuntimeError("未找到 bun，无法构建前端（请使用项目 Dockerfile 部署）")
    uv = shutil.which("uv")

    work = UPDATE_DIR / "work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    pkg = UPDATE_DIR / "pkg.tar.gz"
    try:
        _download_tarball(repo, sha, token, pkg)
        with tarfile.open(pkg) as tf:
            try:
                tf.extractall(work, filter="data")
            except TypeError:  # Python < 3.11.4 无 filter 参数
                tf.extractall(work)
        src = next(work.iterdir())  # 解压出的顶层目录 <repo>-<sha>

        # 先在暂存目录构建前端（最容易失败的步骤），失败时运行环境完全未被改动
        _run([bun, "install", "--frozen-lockfile"], src, timeout=1200)
        _run([bun, "run", "build"], src / "frontend", timeout=1200)
        new_dist = src / "frontend" / "dist"
        if not new_dist.is_dir():
            raise RuntimeError("前端构建未产出 dist 目录")

        # 构建成功后同步 Python 依赖（uv.lock 变化时重装，无变化秒过）；
        # 失败则回滚依赖清单，避免"新依赖 + 旧代码"的不一致状态
        manifests = {}
        for name in ("pyproject.toml", "uv.lock"):
            p = APP_ROOT / name
            if p.exists():
                manifests[name] = p.read_bytes()
        try:
            for name in ("pyproject.toml", "uv.lock"):
                p = src / name
                if p.exists():
                    shutil.copy2(p, APP_ROOT / name)
            if uv:
                _run([uv, "sync", "--frozen", "--no-dev"], APP_ROOT)
        except Exception:
            for name, data in manifests.items():
                (APP_ROOT / name).write_bytes(data)
            raise

        _swap_dir(src / "backend" / "app", APP_DIR)
        _swap_dir(new_dist, DIST_DIR)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        pkg.unlink(missing_ok=True)


def _restart_later(delay: float = 3.0) -> None:
    """延迟自杀：让在途的 API 响应发完，容器由 Docker restart 策略拉起。"""
    def _do():
        time.sleep(delay)
        log.info("update: restarting process")
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=_do, daemon=True).start()


# ---------- 检查与更新 ----------

async def check_now(force: bool = False) -> dict:
    """检查远端 commit。非 force 时受冷却限制：距上次检查不足 CHECK_COOLDOWN
    直接返回缓存状态，不请求 GitHub。发现有更新只标记，不自动应用。"""
    global _busy
    p = _load_persisted()
    if not force and p.get("last_check") \
            and time.time() - p["last_check"] < CHECK_COOLDOWN:
        if _state.get("status") not in ("updating", "restarting", "restart_required"):
            _set(status="available"
                 if p.get("remote_sha") and p["remote_sha"] != current_sha() else "idle")
        return status()
    if _busy:
        raise RuntimeError("已有更新任务在进行中")
    cfg = store.load_config()
    _busy = True
    _set(status="checking", error=None)
    try:
        sha, msg = await fetch_remote_sha(resolve_repo(cfg), resolve_branch(cfg),
                                          cfg.get("github_token") or "")
        _persist_check(sha, msg)
        _set(status="available" if sha != current_sha() else "idle")
    except Exception as e:
        _set(status="error", error=str(e))
        log.warning("update check failed: %s", e)
    finally:
        _busy = False
    return status()


async def apply_update() -> dict:
    """用户确认后执行更新：拉取最新 commit（不受冷却限制）并应用。"""
    global _busy
    if _busy:
        raise RuntimeError("已有更新任务在进行中")
    cfg = store.load_config()
    repo, branch = resolve_repo(cfg), resolve_branch(cfg)
    token = cfg.get("github_token") or ""
    _busy = True
    try:
        _set(status="checking", error=None)
        sha, msg = await fetch_remote_sha(repo, branch, token)
        _persist_check(sha, msg)
        if sha == current_sha():
            _set(status="idle")
            return status()
        _set(status="updating")
        log.info("update: applying %s from %s", sha[:8], repo)
        try:
            await asyncio.to_thread(_apply_update, repo, sha, token)
        except Exception as e:
            _set(status="error", error=str(e))
            log.exception("update failed")
            return status()
        p = _load_persisted()
        p.update({"current_sha": sha, "updated_at": time.time()})
        _save_persisted(p)
        if in_docker():
            _set(status="restarting")
            _restart_later()
        else:
            # 非 Docker 环境（start.sh）：代码已替换，需手动重启生效
            _set(status="restart_required")
            log.warning("update applied; restart the server manually to take effect")
    except Exception as e:
        _set(status="error", error=str(e))
        log.warning("update apply failed: %s", e)
    finally:
        _busy = False
    return status()
