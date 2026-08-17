// 阅读器：全屏路由（不经侧边栏布局），桌面/移动端自适应。
// 内容取译文优先、缺失回退原文；阅读进度与字号/主题设置存 localStorage。
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { useNavigate, useParams } from '@solidjs/router'
import { api } from './api'
import type { Book, Chapter } from './types'

type ThemeKey = 'light' | 'sepia' | 'night'
interface Theme { name: string; bg: string; text: string; line: string }
const THEMES: Record<ThemeKey, Theme> = {
  light: { name: '白纸', bg: '#ffffff', text: '#24292f', line: '#e2e5ea' },
  sepia: { name: '护眼', bg: '#f5ecd9', text: '#5b4636', line: '#ddd0b8' },
  night: { name: '夜间', bg: '#16181d', text: '#a8adb5', line: '#2c313a' },
}

interface ReaderSettings { fontSize: number; theme: ThemeKey }
interface Progress { cid: string; y: number }

const SETTINGS_KEY = 'reader-settings'
const progressKey = (bookId: string) => `reader-progress:${bookId}`

function loadSettings(): ReaderSettings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '')
    return {
      fontSize: Math.min(26, Math.max(14, Number(s.fontSize) || 18)),
      theme: (s.theme in THEMES ? s.theme : 'light') as ThemeKey,
    }
  } catch {
    return { fontSize: 18, theme: 'light' }
  }
}

function loadProgress(bookId: string): Progress | null {
  try {
    const p = JSON.parse(localStorage.getItem(progressKey(bookId)) || '')
    return p && typeof p.cid === 'string' ? { cid: p.cid, y: Number(p.y) || 0 } : null
  } catch {
    return null
  }
}

// epub 章节存的是完整 XHTML 文档；图片为 epub 内部相对路径无法加载，直接去掉；
// 正文首个 h1-h3 即章节标题（与阅读器自身标题栏重复），一并去掉。
function sanitizeEpub(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]>/i, '')
}

export default function ReaderPage() {
  const params = useParams<{ id: string; cid?: string }>()
  const navigate = useNavigate()
  const bookId = params.id
  const [book, setBook] = createSignal<Book | null>(null)
  const [content, setContent] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal('')
  const [tocOpen, setTocOpen] = createSignal(false)
  const [panelOpen, setPanelOpen] = createSignal(false)
  const [settings, setSettings] = createSignal<ReaderSettings>(loadSettings())

  const chapters = () => book()?.chapters || []
  const idx = () => chapters().findIndex(c => c.id === params.cid)
  const chapter = () => (idx() >= 0 ? chapters()[idx()] : null)
  const theme = () => THEMES[settings().theme]

  createEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings()))
  })
  // 阅读页整页换背景（含 overscroll 区域）
  createEffect(() => { document.body.style.background = theme().bg })

  // ---- 章节内容加载：译文优先，无译文回退原文 ----
  const loadChapter = async (c: Chapter) => {
    setLoading(true)
    setError('')
    setContent('')
    const preferDst = c.status === 'done'
    try {
      let text: string
      try {
        text = await api.chapterContent(bookId, c.id, preferDst)
      } catch (e) {
        if (!preferDst) throw e
        text = await api.chapterContent(bookId, c.id, false)
      }
      if (params.cid !== c.id) return // 等待期间已切到别章，丢弃
      setContent(c.format === 'epub' ? sanitizeEpub(text) : text)
      setLoading(false)
      // 恢复上次的滚动位置；新章节回顶部并记为当前进度
      const saved = loadProgress(bookId)
      const y = saved && saved.cid === c.id ? saved.y : 0
      localStorage.setItem(progressKey(bookId), JSON.stringify({ cid: c.id, y }))
      requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)))
    } catch (e: any) {
      if (params.cid !== c.id) return
      setError(String(e.message || e))
      setLoading(false)
    }
  }

  createEffect(() => {
    const c = chapter()
    if (c) void loadChapter(c)
  })

  // ---- 进度记忆（滚动节流保存）----
  let lastSave = 0
  const onScroll = () => {
    const now = Date.now()
    if (now - lastSave < 400) return
    lastSave = now
    const c = chapter()
    if (c) localStorage.setItem(progressKey(bookId), JSON.stringify({ cid: c.id, y: window.scrollY }))
  }

  const goChapter = (i: number) => {
    const cs = chapters()
    if (i < 0 || i >= cs.length) return
    setTocOpen(false)
    navigate(`/books/${bookId}/read/${cs[i].id}`)
  }
  const prev = () => goChapter(idx() - 1)
  const next = () => goChapter(idx() + 1)

  const onKey = (e: KeyboardEvent) => {
    if (tocOpen() || panelOpen()) return
    if (e.key === 'ArrowLeft') prev()
    else if (e.key === 'ArrowRight') next()
  }

  onMount(async () => {
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', onKey)
    try {
      const b = await api.book(bookId)
      setBook(b)
      if (!b.chapters.length) {
        setError('本书还没有章节')
        setLoading(false)
        return
      }
      // 无 cid 或 cid 无效：跳到上次进度，否则第一章
      if (!params.cid || !b.chapters.some(c => c.id === params.cid)) {
        const saved = loadProgress(bookId)
        const target = saved && b.chapters.some(c => c.id === saved.cid) ? saved.cid : b.chapters[0].id
        navigate(`/books/${bookId}/read/${target}`, { replace: true })
      }
    } catch (e: any) {
      setError(String(e.message || e))
      setLoading(false)
    }
  })
  onCleanup(() => {
    window.removeEventListener('scroll', onScroll)
    window.removeEventListener('keydown', onKey)
    document.body.style.background = ''
  })

  // 打开目录时滚动到当前章
  let tocRef: HTMLDivElement | undefined
  createEffect(() => {
    if (tocOpen()) {
      requestAnimationFrame(() =>
        tocRef?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'center' }))
    }
  })

  const bumpFont = (d: number) =>
    setSettings(s => ({ ...s, fontSize: Math.min(26, Math.max(14, s.fontSize + d)) }))

  return (
    <div class="min-h-screen" style={{ background: theme().bg, color: theme().text }}>
      {/* 顶栏 */}
      <div class="reader-bar sticky top-0 z-10 border-b"
        style={{ background: theme().bg, 'border-color': theme().line }}>
        <div class="max-w-[800px] mx-auto flex items-center gap-1 px-2 h-[48px]">
          <button class="border-0 px-2 shrink-0" title="返回书籍详情"
            onClick={() => navigate(`/books/${bookId}`)}>
            <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 12H5" /><polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <div class="flex-1 min-w-0 truncate text-[14px]">
            <Show when={chapter()}>
              {(c) => <>{c().title_translated || c().title}
                <span class="opacity-50 text-[12px] ml-2">{idx() + 1}/{chapters().length}</span></>}
            </Show>
          </div>
          <button class="border-0 px-2 shrink-0 text-[13px]" onClick={() => setPanelOpen(v => !v)}>Aa</button>
          <button class="border-0 px-2 shrink-0" title="目录" onClick={() => setTocOpen(true)}>
            <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="8" x2="21" y1="6" y2="6" /><line x1="8" x2="21" y1="12" y2="12" />
              <line x1="8" x2="21" y1="18" y2="18" /><line x1="3" x2="3.01" y1="6" y2="6" />
              <line x1="3" x2="3.01" y1="12" y2="12" /><line x1="3" x2="3.01" y1="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* 正文 */}
      <div class="max-w-[800px] mx-auto px-4 md:px-6 pt-5 pb-8">
        <Show when={!loading()} fallback={<p class="text-center py-[60px] opacity-60">加载中…</p>}>
          <Show when={!error()} fallback={
            <div class="text-center py-[60px]">
              <p class="text-danger text-[14px]">{error()}</p>
              <Show when={chapter()}>
                {(c) => <button onClick={() => loadChapter(c())}>重试</button>}
              </Show>
            </div>
          }>
            <Show when={chapter()}>
              {(c) => (
                <>
                  <h1 class="text-[1.35em] font-bold mt-0 mb-6 leading-[1.5] break-all">
                    {c().title_translated || c().title}
                  </h1>
                  <Show when={c().format === 'epub'} fallback={
                    <pre class="m-0 whitespace-pre-wrap break-words font-[inherit]"
                      style={{ 'font-size': `${settings().fontSize}px`, 'line-height': 1.9 }}>
                      {content()}
                    </pre>
                  }>
                    <div class="preview-html break-words"
                      style={{ 'font-size': `${settings().fontSize}px`, 'line-height': 1.9 }}
                      innerHTML={content()} />
                  </Show>
                  <div class="reader-bar flex justify-between gap-2 mt-10 pt-5 border-t"
                    style={{ 'border-color': theme().line }}>
                    <button disabled={idx() <= 0} onClick={prev}>← 上一章</button>
                    <button onClick={() => setTocOpen(true)}>目录</button>
                    <button disabled={idx() < 0 || idx() >= chapters().length - 1} onClick={next}>下一章 →</button>
                  </div>
                </>
              )}
            </Show>
          </Show>
        </Show>
      </div>

      {/* 字号 / 主题设置面板 */}
      <Show when={panelOpen()}>
        <div class="fixed inset-0 z-20" onClick={() => setPanelOpen(false)}>
          <div class="reader-bar absolute right-3 top-[54px] w-[230px] rounded-[10px] border shadow-lg p-4"
            style={{ background: theme().bg, 'border-color': theme().line }}
            onClick={(e) => e.stopPropagation()}>
            <div class="flex items-center justify-between mb-3">
              <span class="text-[13px] opacity-70">字号</span>
              <div class="flex items-center gap-2">
                <button class="small" disabled={settings().fontSize <= 14} onClick={() => bumpFont(-1)}>A-</button>
                <span class="text-[14px] w-[22px] text-center">{settings().fontSize}</span>
                <button class="small" disabled={settings().fontSize >= 26} onClick={() => bumpFont(1)}>A+</button>
              </div>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-[13px] opacity-70">主题</span>
              <div class="flex gap-1.5">
                <For each={Object.keys(THEMES) as ThemeKey[]}>
                  {(k) => (
                    <button class={`small ${settings().theme === k ? 'primary' : ''}`}
                      onClick={() => setSettings(s => ({ ...s, theme: k }))}>
                      {THEMES[k].name}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* 目录抽屉：移动端全屏，桌面右侧 360px */}
      <Show when={tocOpen()}>
        <div class="fixed inset-0 z-20 bg-black/40" onClick={() => setTocOpen(false)}>
          <div ref={tocRef}
            class="reader-bar absolute right-0 top-0 h-full w-full md:w-[360px] overflow-y-auto border-l"
            style={{ background: theme().bg, 'border-color': theme().line }}
            onClick={(e) => e.stopPropagation()}>
            <div class="sticky top-0 z-10 flex items-center justify-between px-4 h-[48px] border-b"
              style={{ background: theme().bg, 'border-color': theme().line }}>
              <span class="font-bold text-[15px]">目录（{chapters().length}）</span>
              <button class="small" onClick={() => setTocOpen(false)}>关闭</button>
            </div>
            <For each={chapters()}>
              {(c, i) => (
                <button data-active={c.id === params.cid}
                  class="block w-full text-left border-0 rounded-none bg-transparent px-4 py-[10px] text-[14px] truncate"
                  style={c.id === params.cid ? { color: '#2563eb', 'font-weight': 600 } : {}}
                  onClick={() => goChapter(i())}>
                  {i() + 1}. {c.title_translated || c.title}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
