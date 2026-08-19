// 全书搜索：逐章拉取内容（译文优先，无译文回退原文），纯前端匹配。
// epub 章节先 DOMParser 去标签取纯文本再搜。点结果跳转阅读器对应章节，
// 经 sessionStorage reader-find:<bookId> 传入关键词，由阅读器定位并闪烁高亮。
import { createSignal, For, onMount, Show } from 'solid-js'
import { useNavigate, useParams } from '@solidjs/router'
import { api } from './api'
import type { Book, Chapter } from './types'

interface Hit {
  cid: string // 章节 id
  cidx: number // 章节序号（0 起）
  title: string
  pre: string // 命中前的上下文
  match: string
  post: string // 命中后的上下文
}

const CTX = 40 // 命中上下文长度（字）
const MAX_HITS = 500 // 结果上限，防一次搜索刷出过多条目
const CONCURRENCY = 4 // 章节内容拉取并发数
const FIND_TTL = 60_000 // 跳转定位关键词有效期（与书签跳转一致）

// 返回上一页再进搜索页时恢复上次搜索结果（组件重挂载会丢内存状态）
let lastSearch: { bookId: string; q: string; hits: Hit[]; truncated: boolean } | null = null

// 章节纯文本：epub 去标签（跳过 style/script/title），txt 原样
function chapterText(raw: string, format: string): string {
  if (format !== 'epub') return raw
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  doc.querySelectorAll('style,script,title,noscript').forEach((el) => el.remove())
  return doc.body?.textContent || ''
}

export default function BookSearchPage() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const bookId = params.id
  const [book, setBook] = createSignal<Book | null>(null)
  const [q, setQ] = createSignal('')
  const [hits, setHits] = createSignal<Hit[]>([])
  const [truncated, setTruncated] = createSignal(false)
  const [searching, setSearching] = createSignal(false)
  const [scanned, setScanned] = createSignal(0) // 已扫描章节数（进度展示）
  const [error, setError] = createSignal('')
  let stopFlag = false // 停止当前搜索（协作用户取消）

  onMount(async () => {
    try {
      const b = await api.book(bookId)
      setBook(b)
      // 恢复上次搜索（同一本书）
      if (lastSearch && lastSearch.bookId === bookId) {
        setQ(lastSearch.q)
        setHits(lastSearch.hits)
        setTruncated(lastSearch.truncated)
      }
    } catch (e: any) {
      setError(String(e.message || e))
    }
  })

  const doSearch = async () => {
    const b = book()
    const query = q().trim()
    if (!b || !query || searching()) return
    setSearching(true)
    setError('')
    setHits([])
    setTruncated(false)
    setScanned(0)
    stopFlag = false
    const out: Hit[] = []
    const ql = query.toLowerCase()
    const cs = b.chapters
    let cursor = 0
    const worker = async () => {
      while (cursor < cs.length && !stopFlag) {
        const c: Chapter = cs[cursor++]
        // 译文优先，取不到回退原文（与阅读器一致）
        const preferDst = c.status === 'done'
        let raw = ''
        try {
          raw = await api.chapterContent(bookId, c.id, preferDst)
        } catch {
          if (preferDst) raw = await api.chapterContent(bookId, c.id, false).catch(() => '')
        }
        setScanned(cursor)
        if (!raw) continue
        const text = chapterText(raw, c.format)
        const lower = text.toLowerCase()
        let pos = 0
        for (;;) {
          const i = lower.indexOf(ql, pos)
          if (i < 0) break
          out.push({
            cid: c.id,
            cidx: cursor - 1,
            title: c.title_translated || c.title,
            pre: text.slice(Math.max(0, i - CTX), i),
            match: text.slice(i, i + query.length),
            post: text.slice(i + query.length, i + query.length + CTX),
          })
          pos = i + ql.length
          if (out.length >= MAX_HITS) { setTruncated(true); stopFlag = true; break }
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    setHits(out)
    lastSearch = { bookId, q: query, hits: out, truncated: truncated() }
    setSearching(false)
  }

  const jump = (h: Hit) => {
    // 定位信息交阅读器：命中章节 + 关键词，阅读器在渲染后的 DOM 里找首个命中并高亮
    sessionStorage.setItem(`reader-find:${bookId}`,
      JSON.stringify({ cid: h.cid, q: h.match, ts: Date.now() }))
    navigate(`/books/${bookId}/read/${h.cid}`)
  }

  return (
    <div class="max-w-[800px] mx-auto pt-4">
      <div class="flex items-center gap-2 mb-4">
        <button class="border-0 px-2 shrink-0" title="返回书籍详情"
          onClick={() => navigate(`/books/${bookId}`)}>
          <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5" /><polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <span class="text-[16px] font-bold truncate">
          全书搜索<Show when={book()}><span class="opacity-50 text-[13px] ml-2">{book()!.title_translated || book()!.title}</span></Show>
        </span>
      </div>

      <form class="flex gap-2 mb-3"
        onSubmit={(e) => { e.preventDefault(); void doSearch() }}>
        <input class="flex-1 min-w-0 px-3 py-2 border border-line rounded-[6px] text-[14px]"
          type="search" placeholder="输入要搜索的文字…"
          value={q()} autofocus
          onInput={(e) => setQ(e.currentTarget.value)} />
        <button type="submit" class="primary shrink-0" disabled={searching() || !q().trim()}>搜索</button>
        <Show when={searching()}>
          <button type="button" class="shrink-0" onClick={() => { stopFlag = true }}>停止</button>
        </Show>
      </form>

      <Show when={searching()}>
        <p class="text-[13px] text-muted mb-3">
          搜索中… 已扫描 {scanned()}/{book()?.chapters.length ?? 0} 章
        </p>
      </Show>
      <Show when={error()}>
        <p class="text-danger text-[14px] mb-3">{error()}</p>
      </Show>
      <Show when={!searching() && hits().length > 0}>
        <p class="text-[13px] text-muted mb-3">
          共 {hits().length} 处命中{truncated() ? `（已达 ${MAX_HITS} 条上限，仅显示前 ${MAX_HITS} 条）` : ''}
        </p>
      </Show>

      <For each={hits()}>
        {(h) => (
          <button class="block w-full text-left border-0 bg-card rounded-[8px] px-4 py-3 mb-2"
            onClick={() => jump(h)}>
            <div class="text-[13px] text-muted truncate mb-1">
              {h.cidx + 1}. {h.title}
            </div>
            <div class="text-[14px] leading-[1.7] break-all">
              <span class="opacity-70">…{h.pre}</span>
              <mark class="bg-[#fde68a] text-inherit rounded-[2px] px-[1px]">{h.match}</mark>
              <span class="opacity-70">{h.post}…</span>
            </div>
          </button>
        )}
      </For>
    </div>
  )
}
