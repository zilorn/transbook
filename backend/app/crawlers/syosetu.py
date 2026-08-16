"""syosetu.com（成为小说家吧）爬虫：搜索、目录/正文抓取、增量更新。

站点专属逻辑：关键词搜索（yomou）、详情页目录解析（自动翻页）、单话正文解析
（<p> 一段一行，去 ruby 注音）。限速请求走 http.HttpGate，抓取任务生命周期
（进度/停止/逐章落盘）走 tasks.CrawlRunner。
"""
from __future__ import annotations

import re
from urllib.parse import quote

from bs4 import BeautifulSoup

from .http import HttpGate
from .tasks import CrawlRunner


class SyosetuError(Exception):
    pass


_gate = HttpGate(SyosetuError)


# ---------------- 解析 ----------------

_NCODE_RE = re.compile(r"(?:ncode\.syosetu\.com/)?(n\d{4}[a-z]{2})", re.I)


def parse_ncode(s: str) -> str | None:
    """从详情页/章节页 URL 或纯 N コード（如 n0305hn）中提取小写 ncode。"""
    m = _NCODE_RE.search(s.strip())
    return m.group(1).lower() if m else None


async def search(query: str) -> list[dict]:
    """关键词搜索，返回 [{ncode, url, title, author, synopsis, status, episodes}]。"""
    html = await _gate.get("https://yomou.syosetu.com/search.php?word=" + quote(query))
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for box in soup.select(".searchkekka_box"):
        a = box.select_one(".novel_h a.tl")
        if not a:
            continue
        ncode = parse_ncode(a.get("href", ""))
        if not ncode:
            continue
        author_a = box.find("a", href=re.compile(r"mypage\.syosetu\.com"))
        ex = box.select_one(".ex")
        left = box.select_one("td.left")
        left_text = left.get_text(" ", strip=True) if left else ""
        m = re.search(r"全(\d+)エピソード", left_text)
        out.append({
            "ncode": ncode,
            "url": f"https://ncode.syosetu.com/{ncode}/",
            "title": a.get_text(strip=True),
            "author": author_a.get_text(strip=True) if author_a else "",
            "synopsis": ex.get_text(" ", strip=True) if ex else "",
            "status": "完結" if "完結" in left_text else ("連載中" if "連載" in left_text else ""),
            "episodes": int(m.group(1)) if m else 0,
        })
    return out


def _parse_episodes(soup: BeautifulSoup, ncode: str) -> list[dict]:
    eps = []
    for a in soup.select("a.p-eplist__subtitle"):
        m = re.search(rf"/{re.escape(ncode)}/(\d+)/", a.get("href", ""))
        if m:
            eps.append({"ep": int(m.group(1)), "title": a.get_text(strip=True)})
    return eps


def _parse_body(body_el) -> str:
    """.p-novel__body → 纯文本：<p> 一段一行，空 <p><br/></p> 为空行；去掉注音 ruby。"""
    for tag in body_el.find_all(["rt", "rp"]):
        tag.decompose()
    paras = [p.get_text(strip=True) for p in body_el.find_all("p")]
    return "\n".join(paras).strip()


async def fetch_info(ncode: str) -> dict:
    """作品信息 + 完整目录（自动翻页）。短篇无目录，正文在详情页，short=True。"""
    base = f"https://ncode.syosetu.com/{ncode}/"
    html = await _gate.get(base)
    soup = BeautifulSoup(html, "html.parser")
    el = soup.select_one(".p-novel__title")
    title = el.get_text(strip=True) if el else ncode
    el = soup.select_one(".p-novel__author")
    author = el.get_text(strip=True).replace("作者：", "").strip() if el else ""
    el = soup.select_one("#novel_ex")
    synopsis = el.get_text("\n", strip=True) if el else ""

    episodes = _parse_episodes(soup, ncode)
    if not episodes:
        return {"title": title, "author": author, "synopsis": synopsis,
                "short": True, "episodes": [{"ep": 1, "title": title}]}

    seen = {e["ep"] for e in episodes}
    # 分页器只露出「次へ/最後」等少数页码，需以最大页码为界逐页抓全
    pages = [int(m.group(1)) for m in re.finditer(r"\?p=(\d+)", html)]
    for p in range(2, max(pages, default=1) + 1):
        sub = BeautifulSoup(await _gate.get(f"{base}?p={p}"), "html.parser")
        for e in _parse_episodes(sub, ncode):
            if e["ep"] not in seen:
                seen.add(e["ep"])
                episodes.append(e)
    episodes.sort(key=lambda e: e["ep"])
    return {"title": title, "author": author, "synopsis": synopsis,
            "short": False, "episodes": episodes}


async def fetch_chapter(ncode: str, ep: int, short: bool = False) -> tuple[str, str]:
    """抓取单话，返回 (标题, 正文纯文本)。"""
    base = f"https://ncode.syosetu.com/{ncode}/"
    html = await _gate.get(base if short else f"{base}{ep}/")
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.select_one("h1.p-novel__title")
    title = h1.get_text(strip=True) if h1 else f"第 {ep} 话"
    body_el = soup.select_one(".p-novel__body")
    if body_el is None:
        raise SyosetuError(f"第 {ep} 话正文解析失败")
    body = _parse_body(body_el)
    if not body:
        raise SyosetuError(f"第 {ep} 话正文为空")
    return title, body


# ---------------- 抓取任务 ----------------

_runner = CrawlRunner(
    source_key="ncode",
    fetch_info=fetch_info,
    fetch_chapter=lambda ncode, ep, info: fetch_chapter(
        ncode, ep, short=info.get("short", False)),
)

is_crawling = _runner.is_crawling
progress = _runner.progress
stop_crawl = _runner.stop_crawl
start_crawl = _runner.start_crawl
start_update = _runner.start_update
