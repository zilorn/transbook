"""syosetu.com（成为小说家吧）爬虫：搜索、目录/正文抓取、增量更新。

站点专属逻辑：关键词搜索（yomou）、排行榜（rank/list 综合榜 + rank/genrelist 分类榜）、
详情页目录解析（自动翻页）、单话正文解析（<p> 一段一行，去 ruby 注音）。限速请求走
http.HttpGate，抓取任务生命周期（进度/停止/逐章落盘）走 tasks.CrawlRunner。
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
            "status": "已完结" if "完結" in left_text else ("连载中" if "連載" in left_text else ""),
            "episodes": int(m.group(1)) if m else 0,
        })
    return out


_EP_DATE_RE = re.compile(r"(\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2})")


def _parse_episodes(soup: BeautifulSoup, ncode: str) -> list[dict]:
    """目录话条目：{ep, title, date}，date 为站点显示的发布时间（YYYY-MM-DD HH:MM）。"""
    eps = []
    for sub in soup.select(".p-eplist__sublist"):
        a = sub.select_one("a.p-eplist__subtitle")
        if not a:
            continue
        m = re.search(rf"/{re.escape(ncode)}/(\d+)/", a.get("href", ""))
        if not m:
            continue
        date = None
        upd = sub.select_one(".p-eplist__update")
        if upd:
            d = _EP_DATE_RE.search(upd.get_text(" ", strip=True))
            if d:
                date = f"{d.group(1)}-{d.group(2)}-{d.group(3)} {d.group(4)}:{d.group(5)}"
        eps.append({"ep": int(m.group(1)), "title": a.get_text(strip=True), "date": date})
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
                "short": True, "episodes": [{"ep": 1, "title": title}],
                "last_update": None}

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
    dates = [e["date"] for e in episodes if e.get("date")]
    return {"title": title, "author": author, "synopsis": synopsis,
            "short": False, "episodes": episodes,
            "last_update": max(dates) if dates else None}


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


# ---------------- 排行榜（发现页） ----------------

# 排行周期（URL 第一段）
RANK_PERIODS = {
    "daily": "日排行",
    "weekly": "周排行",
    "monthly": "月排行",
    "quarter": "季度排行",
    "yearly": "年排行",
    "total": "累计排行",
}

# 作品分类（URL 第二段数字编号；total 走综合榜）
RANK_GENRES = {
    "total": "综合",
    "101": "异世界（恋爱）",
    "102": "现实世界（恋爱）",
    "201": "高幻想（奇幻）",
    "202": "低幻想（奇幻）",
    "301": "纯文学（文艺）",
    "302": "人性剧情（文艺）",
    "303": "历史（文艺）",
    "304": "推理（文艺）",
    "305": "恐怖（文艺）",
    "306": "动作（文艺）",
    "307": "喜剧（文艺）",
    "401": "VR游戏（科幻）",
    "402": "宇宙（科幻）",
    "403": "空想科学（科幻）",
    "404": "惊悚（科幻）",
    "9901": "童话（其他）",
    "9902": "诗歌（其他）",
    "9903": "随笔（其他）",
    "9999": "其他（其他）",
}

# 综合榜（genre=total）下的范围筛选
RANK_KINDS = {
    "total": "全部",
    "r": "连载中",
    "er": "已完结",
    "t": "短篇",
}

# 条目信息里的日文分类文本 → 中文
_GENRE_TEXT_ZH = {
    "異世界〔恋愛〕": "异世界（恋爱）",
    "現実世界〔恋愛〕": "现实世界（恋爱）",
    "ハイファンタジー〔ファンタジー〕": "高幻想（奇幻）",
    "ローファンタジー〔ファンタジー〕": "低幻想（奇幻）",
    "純文学〔文芸〕": "纯文学（文艺）",
    "ヒューマンドラマ〔文芸〕": "人性剧情（文艺）",
    "歴史〔文芸〕": "历史（文艺）",
    "推理〔文芸〕": "推理（文艺）",
    "ホラー〔文芸〕": "恐怖（文艺）",
    "アクション〔文芸〕": "动作（文艺）",
    "コメディー〔文芸〕": "喜剧（文艺）",
    "VRゲーム〔SF〕": "VR游戏（科幻）",
    "宇宙〔SF〕": "宇宙（科幻）",
    "空想科学〔SF〕": "空想科学（科幻）",
    "パニック〔SF〕": "惊悚（科幻）",
    "童話〔その他〕": "童话（其他）",
    "詩〔その他〕": "诗歌（其他）",
    "エッセイ〔その他〕": "随笔（其他）",
    "その他〔その他〕": "其他（其他）",
}

_STATUS_ZH = {"短編": "短篇", "完結": "已完结", "完結済": "已完结", "連載中": "连载中"}


async def rankings(period: str = "daily", genre: str = "total",
                   kind: str = "total") -> list[dict]:
    """抓取排行榜，返回
    [{rank, ncode, url, title, author, synopsis, status, episodes, genre, points, chars}]。

    genre=total 走综合榜 /rank/list/type/{period}_{kind}/（kind 筛选范围），
    其余走分类榜 /rank/genrelist/type/{period}_{genre}/。
    """
    if period not in RANK_PERIODS or genre not in RANK_GENRES or kind not in RANK_KINDS:
        raise SyosetuError("无效的排行榜筛选参数")
    if genre == "total":
        url = f"https://yomou.syosetu.com/rank/list/type/{period}_{kind}/"
    else:
        url = f"https://yomou.syosetu.com/rank/genrelist/type/{period}_{genre}/"
    soup = BeautifulSoup(await _gate.get(url), "html.parser")
    out = []
    for item in soup.select(".p-ranklist-item"):
        a = item.select_one(".p-ranklist-item__title a[href]")
        ncode = parse_ncode(a.get("href", "")) if a else None
        if not a or not ncode:
            continue
        rank_el = item.select_one(".c-rank-place__num")
        author_el = item.select_one(".p-ranklist-item__author a")
        points_el = item.select_one(".p-ranklist-item__points")
        syn_el = item.select_one(".p-ranklist-item__synopsis")
        # 信息行：连载状态（可带「全Nエピソード」后缀）、字数、分类、更新日期等分隔块
        seps = [s.get_text(strip=True)
                for s in item.select(".p-ranklist-item__infomation .p-ranklist-item__separator")]
        status = ""
        episodes = 0
        gtext = ""
        chars = 0
        for t in seps:
            m = re.match(r"(短編|完結済?|連載中)(?:\(全([\d,]+)エピソード\))?$", t)
            if m:
                status = _STATUS_ZH[m.group(1)]
                episodes = int(m.group(2).replace(",", "")) if m.group(2) else 0
                continue
            if t in _GENRE_TEXT_ZH:
                gtext = t
                continue
            m = re.match(r"([\d,]+)文字", t)
            if m:
                chars = int(m.group(1).replace(",", ""))
        m = re.search(r"[\d,]+", points_el.get_text(strip=True) if points_el else "")
        out.append({
            "rank": int(rank_el.get_text(strip=True)) if rank_el else len(out) + 1,
            "ncode": ncode,
            "url": f"https://ncode.syosetu.com/{ncode}/",
            "title": a.get_text(strip=True),
            "author": author_el.get_text(strip=True) if author_el else "",
            "synopsis": syn_el.get_text(" ", strip=True) if syn_el else "",
            "status": status,
            "genre": _GENRE_TEXT_ZH.get(gtext, gtext),
            "points": int(m.group(0).replace(",", "")) if m else 0,
            "chars": chars,
            "episodes": episodes,
        })
    return out


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
