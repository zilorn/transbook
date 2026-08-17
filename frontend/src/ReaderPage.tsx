// 阅读器：全屏路由（不经侧边栏布局），桌面/移动端自适应。
// 内容取译文优先、缺失回退原文；阅读进度存后端，字号/主题设置存 localStorage。
import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js'
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

interface ReaderSettings { fontSize: number; theme: ThemeKey; voice: string; rate: number }
interface Progress { cid: string; y: number }

const RATES = [0.75, 1, 1.25, 1.5, 2]

const SETTINGS_KEY = 'reader-settings'

function loadSettings(): ReaderSettings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '')
    return {
      fontSize: Math.min(26, Math.max(14, Number(s.fontSize) || 18)),
      theme: (s.theme in THEMES ? s.theme : 'light') as ThemeKey,
      voice: typeof s.voice === 'string' ? s.voice : '',
      rate: RATES.includes(Number(s.rate)) ? Number(s.rate) : 1,
    }
  } catch {
    return { fontSize: 18, theme: 'light', voice: '', rate: 1 }
  }
}

// 旧版本进度存在 localStorage，首次打开时迁移到后端后删除
function loadLegacyProgress(bookId: string): Progress | null {
  const key = `reader-progress:${bookId}`
  try {
    const p = JSON.parse(localStorage.getItem(key) || '')
    if (!p || typeof p.cid !== 'string') return null
    localStorage.removeItem(key)
    return { cid: p.cid, y: Number(p.y) || 0 }
  } catch {
    return null
  }
}

export default function ReaderPage() {
  const params = useParams<{ id: string; cid?: string }>()
  const navigate = useNavigate()
  const bookId = params.id
  const [book, setBook] = createSignal<Book | null>(null)
  const [content, setContent] = createSignal('')
  const [contentCid, setContentCid] = createSignal('') // content 属于哪一章（切章后旧内容清空前不朗读）
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal('')
  const [tocOpen, setTocOpen] = createSignal(false)
  const [panelOpen, setPanelOpen] = createSignal(false)
  const [settings, setSettings] = createSignal<ReaderSettings>(loadSettings())
  const [progress, setProgress] = createSignal<Progress | null>(null)
  // 进度保存：更新本地信号 + 落后端（失败静默，下次滚动会再存）
  const saveProgress = (cid: string, y: number) => {
    setProgress({ cid, y })
    void api.saveProgress(bookId, cid, y).catch(() => {})
  }
  const [previewImg, setPreviewImg] = createSignal('')
  // ---- 听书（edge-tts，逐句连播）----
  // 前端自行分句、直接把每句文本发给后端合成：渲染的句与朗读的句天然是同一份，逐句高亮必然对齐。
  const [ttsOpen, setTtsOpen] = createSignal(false)
  const [ttsPlaying, setTtsPlaying] = createSignal(false)
  const [ttsBusy, setTtsBusy] = createSignal(false)
  const [ttsError, setTtsError] = createSignal('')
  const [voices, setVoices] = createSignal<Record<string, string>>({})
  const [voiceDefault, setVoiceDefault] = createSignal('')
  const [ttsIdx, setTtsIdx] = createSignal(-1) // 当前朗读句下标（-1 = 未在朗读）
  let audio: HTMLAudioElement | undefined
  let wantPlay = false // 播放意图：切章/播报完自动续播都靠它
  let playGen = 0 // 播放代际：暂停/关闭/切章时递增，作废在途的合成等待与下一句接续
  // 播放/暂停按钮只随播放意图变（句间换音频触发的 pause/playing 事件不再让图标闪烁）
  const setWant = (v: boolean) => { wantPlay = v; setTtsPlaying(v) }
  let playedKey = '' // 当前音频对应的 章节id:音色（区分切章与换音色）
  let consecFails = 0 // 连续合成/播放失败句数，超阈值才停止
  let blobUrl = ''
  const audioCache = new Map<number, Promise<Blob>>() // 本章音频缓存：句号 → 合成 Promise（失败不缓存）
  let prefetchGen = 0 // 预缓存代际：切章/换音色时作废旧的后台预取

  // 分句规则：一句（含结尾标点）或连续换行
  const SEG_RE = /[^。！？!?…\n]+[。！？!?…]*|\n+/g
  interface Seg { t: string; si: number } // si=-1 为纯换行排版段，不朗读；其余按顺序编号
  const segments = (): Seg[] => {
    const txt = content().trim()
    if (!txt) return []
    let si = 0
    return (txt.match(SEG_RE) || []).map(t => ({ t, si: /^\s*$/.test(t) ? -1 : si++ }))
  }

  // 当前章节的朗读句清单：txt 由正文直接分句；epub 由拆句后的 HTML 得到（见 epubSeg）
  // content 必须属于当前章节：切章后 loadChapter 还在等网络时 content 仍是上一章，
  // 不门控的话自动续播会拿上一章的句子接着读
  const sentences = (): string[] => {
    const c = chapter()
    if (!c || contentCid() !== c.id) return []
    return c.format === 'epub' ? (epubSeg()?.texts ?? []) : segments().filter(s => s.si >= 0).map(s => s.t)
  }

  // epub：用 DOMParser 处理 HTML 字符串（不依赖渲染时机，避免 effect/ref 竞态导致句清单为空），
  // 把文本节点拆成句级 span[data-si] 并同步收集句文本作为朗读清单——渲染的句与朗读的句是同一份数据。
  // 跳过 style/script/title 内的文本与纯空白节点（不朗读）。
  let segEl: HTMLDivElement | undefined
  const splitEpubHtml = (html: string): { html: string; texts: string[] } => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = (n as Text).parentElement
        return p && p.closest('style,script,title,noscript')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      },
    })
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    let si = 0
    const texts: string[] = []
    for (const node of nodes) {
      const stripped = node.data.trim()
      if (!stripped) continue
      const frag = doc.createDocumentFragment()
      for (const part of stripped.match(SEG_RE) || []) {
        if (/^\s*$/.test(part)) { frag.appendChild(doc.createTextNode(part)); continue }
        const span = doc.createElement('span')
        span.dataset.si = String(si++)
        span.textContent = part
        texts.push(part)
        frag.appendChild(span)
      }
      node.replaceWith(frag)
    }
    return { html: doc.documentElement.innerHTML, texts }
  }

  // 按章节缓存拆句结果（拆整章 DOM 有开销，避免每次响应式访问都重算）
  let epubSegCache: { key: string; v: { html: string; texts: string[] } } | null = null
  const epubSeg = () => {
    const c = chapter()
    const h = content()
    if (!c || c.format !== 'epub' || !h) return null
    const key = `${c.id}:${h.length}`
    if (epubSegCache?.key !== key) epubSegCache = { key, v: splitEpubHtml(h) }
    return epubSegCache.v
  }

  // epub 章节存的是完整 XHTML 文档；图片为 epub 内部相对路径，重写为后端图片接口
  // （外链图保留原样，加载失败的图隐藏）；正文首个 h1-h3 与阅读器标题栏重复，去掉。
  const processEpub = (html: string, cid: string): string =>
    html
      .replace(/<img\b[^>]*>/gi, (tag) => {
        const m = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
        const src = m?.[1] ?? m?.[2] ?? m?.[3] ?? ''
        if (!src) return ''
        if (/^(?:https?:|data:|blob:)/i.test(src)) return tag
        return tag.replace(m![0],
          `src="${api.chapterImageUrl(bookId, cid, src)}" loading="lazy" onerror="this.style.display='none'"`)
      })
      .replace(/<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]>/i, '')

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
    setContentCid('')
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
      setContent(c.format === 'epub' ? processEpub(text, c.id) : text)
      setContentCid(c.id)
      setLoading(false)
      // 恢复上次的滚动位置；新章节回顶部并记为当前进度
      const saved = progress()
      const y = saved && saved.cid === c.id ? saved.y : 0
      saveProgress(c.id, y)
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

  // ---- 听书播放控制（逐句连播：当前句高亮，句间/章末自动接续，失败句跳过）----
  const curVoice = () => settings().voice || voiceDefault()
  const playKey = () => `${params.cid}:${curVoice()}`

  // 合成并缓存第 i 句音频（Promise 缓存，并发调用共享；失败不缓存，下次重试）
  const getAudio = (i: number): Promise<Blob> => {
    let p = audioCache.get(i)
    if (!p) {
      p = api.ttsSpeak(sentences()[i], curVoice())
      p.catch(() => audioCache.delete(i))
      audioCache.set(i, p)
    }
    return p
  }

  // 后台预缓存本章全部音频（2 并发 worker），播到时即时出声
  const prefetchAll = () => {
    const gen = ++prefetchGen
    const total = sentences().length
    let next = 0
    const worker = async () => {
      while (gen === prefetchGen) {
        const i = next++
        if (i >= total) break
        try { await getAudio(i) } catch { /* 失败句跳过，播到时会重试 */ }
      }
    }
    void worker()
    void worker()
  }

  const ensureAudio = (): HTMLAudioElement => {
    if (!audio) {
      audio = new Audio()
      audio.preload = 'auto'
      audio.addEventListener('playing', () => { setTtsBusy(false); consecFails = 0 })
      audio.addEventListener('waiting', () => setTtsBusy(true))
      audio.addEventListener('ended', () => {
        if (!wantPlay) return
        // 播完自动接下一句；本章播完连播下一章（切章由下面的 createEffect 接管续播）
        if (ttsIdx() + 1 < sentences().length) void playSentence(ttsIdx() + 1)
        else if (idx() >= 0 && idx() < chapters().length - 1) next()
        else { setWant(false); setTtsBusy(false); setTtsIdx(-1) }
      })
      audio.addEventListener('error', () => {
        setTtsBusy(false)
        if (wantPlay) skipBadSentence(ttsIdx()) // 播放失败也跳过，不卡住
        else setWant(false)
      })
    }
    return audio
  }

  // 合成/播放失败：跳到下一句（连续失败 5 句才停止，防死循环）
  const skipBadSentence = (i: number) => {
    consecFails++
    if (!wantPlay) return
    if (consecFails >= 5) {
      setWant(false)
      setTtsBusy(false)
      setTtsError('连续多句语音合成失败，已停止（请检查后端能否访问 edge-tts）')
      return
    }
    if (i + 1 < sentences().length) void playSentence(i + 1)
    else if (idx() >= 0 && idx() < chapters().length - 1) next()
    else { setWant(false); setTtsBusy(false); setTtsIdx(-1) }
  }

  const playSentence = async (i: number) => {
    const c = chapter()
    if (!c || i < 0 || i >= sentences().length) return
    const key = playKey()
    const gen = playGen
    setTtsError('')
    setTtsIdx(i)
    setTtsBusy(true)
    playedKey = key
    let blob: Blob
    try {
      blob = await getAudio(i)
    } catch {
      skipBadSentence(i) // 合成失败：跳句
      return
    }
    // 等待合成期间已切章/换音色/暂停：gen 变了说明用户已主动停掉，在途的下一句一并作废
    if (!wantPlay || gen !== playGen || playedKey !== key || ttsIdx() !== i) return
    const a = ensureAudio()
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    blobUrl = URL.createObjectURL(blob)
    a.src = blobUrl
    a.playbackRate = settings().rate
    // play() 被新的 load/pause 打断（AbortError）说明已有更新的播放操作接管（跳句/暂停/切章），
    // 静默忽略；其余错误（如移动端自动播放限制 NotAllowedError）才展示
    a.play().catch((e) => {
      if ((e as DOMException)?.name === 'AbortError') return
      setTtsBusy(false)
      setTtsError(String(e?.message || e))
    })
    // 预取随后几句，减少句间停顿
    for (let j = i + 1; j < Math.min(i + 4, sentences().length); j++) getAudio(j).catch(() => {})
  }

  const playTts = () => {
    if (!chapter()) return
    if (!sentences().length) { setTtsError('本章没有可朗读的文本'); setWant(false); return }
    void playSentence(Math.max(ttsIdx(), 0))
    prefetchAll()
  }

  const toggleTts = () => {
    setTtsOpen(true)
    if (wantPlay) {
      // 暂停：只有用户操作才停；递增 playGen 把在途的下一句合成/接续一并作废
      setWant(false)
      playGen++
      audio?.pause()
    } else {
      setWant(true)
      // 暂停在同一句中途则续播，否则从头开始
      if (audio && playedKey === playKey() && ttsIdx() >= 0 && !audio.ended && audio.currentTime > 0) {
        setTtsError('')
        audio.play().catch((e) => setTtsError(String(e.message || e)))
      } else {
        playTts()
      }
    }
  }

  // 上一句/下一句：播放中跳句重读（递增 playGen 作废当前句的在途合成与 ended 接续）；
  // 暂停中只移动高亮位置，不自动开播
  const skipSentence = (d: number) => {
    const total = sentences().length
    if (!total) return
    const i = Math.min(Math.max((ttsIdx() < 0 ? 0 : ttsIdx()) + d, 0), total - 1)
    consecFails = 0
    if (wantPlay) {
      playGen++
      audio?.pause()
      void playSentence(i)
    } else {
      audio?.pause()
      setTtsIdx(i)
    }
  }

  const closeTts = () => {
    setWant(false)
    playGen++
    audio?.pause()
    setTtsOpen(false)
    setTtsIdx(-1)
  }

  // 切章/换音色：清空本章音频缓存与朗读位置，作废在途的合成等待
  createEffect((prev: string) => {
    const key = `${params.cid}:${settings().voice}`
    if (prev && prev !== key) {
      audioCache.clear()
      prefetchGen++
      playGen++
      setTtsIdx(-1)
      consecFails = 0
    }
    return key
  }, '')

  // 切章或换音色时，若处于播放意图则换源续播（换音色重读当前句，切章从首句开始）。
  // 等分句就绪（epub 需等渲染拆句完成）再启动，避免误报"没有可朗读文本"。
  // ttsIdx 必须 untrack：否则 playSentence 里每次 setTtsIdx 都会重触本 effect，
  // 同一句被重复 playSentence，两次 src 赋值互相打断 play()
  //（移动端报 "The play() request was interrupted by a new load request"，读一句停一句）。
  createEffect(() => {
    const key = playKey()
    if (!wantPlay || !chapter() || !sentences().length) return
    untrack(() => {
      if (playedKey === key && ttsIdx() >= 0) void playSentence(ttsIdx())
      else playTts()
    })
  })

  // 倍速即时生效
  createEffect(() => {
    if (audio) audio.playbackRate = settings().rate
  })

  // 朗读句自动滚动到视野中部
  createEffect(() => {
    const i = ttsIdx()
    if (i >= 0 && ttsOpen())
      document.querySelector(`[data-si="${i}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })

  // epub 高亮靠切换 .tts-active（txt 由 Solid classList 绑定，不走这里）
  createEffect(() => {
    const i = ttsIdx()
    const c = chapter()
    if (!segEl || c?.format !== 'epub') return
    segEl.querySelector('.tts-active')?.classList.remove('tts-active')
    if (i >= 0) segEl.querySelector(`[data-si="${i}"]`)?.classList.add('tts-active')
  })

  // ---- 进度记忆（滚动节流保存到后端）----
  let lastSave = 0
  const onScroll = () => {
    const now = Date.now()
    if (now - lastSave < 400) return
    lastSave = now
    const c = chapter()
    if (c) saveProgress(c.id, window.scrollY)
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
    void api.ttsVoices()
      .then((v) => { setVoices(v.voices); setVoiceDefault(v.default) })
      .catch(() => {})
    try {
      const [b, saved] = await Promise.all([
        api.book(bookId),
        api.getProgress(bookId).catch(() => null),
      ])
      // 无记录时尝试迁移旧版本存在 localStorage 的进度
      let prog: Progress | null =
        saved && typeof saved.cid === 'string' && saved.cid
          ? { cid: saved.cid, y: Number(saved.y) || 0 }
          : loadLegacyProgress(bookId)
      setProgress(prog)
      if (prog && !saved?.cid) void api.saveProgress(bookId, prog.cid, prog.y).catch(() => {})
      setBook(b)
      if (!b.chapters.length) {
        setError('本书还没有章节')
        setLoading(false)
        return
      }
      // 无 cid 或 cid 无效：跳到上次进度，否则第一章
      if (!params.cid || !b.chapters.some(c => c.id === params.cid)) {
        const target = prog && b.chapters.some(c => c.id === prog.cid) ? prog.cid : b.chapters[0].id
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
    wantPlay = false
    audio?.pause()
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
          <button class="border-0 px-2 shrink-0" title="听书"
            onClick={toggleTts}>
            <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
              <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
            </svg>
          </button>
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
      <div class="max-w-[800px] mx-auto px-4 md:px-6 pt-5"
        style={{ 'padding-bottom': ttsOpen() ? '120px' : '32px' }}>
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
                  {/* 听书逐句高亮：txt 始终按句渲染 span；epub 渲染的是 epubSeg 拆句后的
                      HTML（已含 span[data-si]）。两者都只对当前朗读句加 .tts-active */}
                  <Show when={c().format === 'epub'} fallback={
                    <pre class="m-0 whitespace-pre-wrap break-words font-[inherit]"
                      style={{ 'font-size': `${settings().fontSize}px`, 'line-height': 1.9 }}>
                      <For each={segments()}>{(seg) => seg.si < 0 ? seg.t : (
                        <span data-si={seg.si} class="px-[1px]"
                          classList={{ 'tts-active': seg.si === ttsIdx() }}>
                          {seg.t}
                        </span>
                      )}</For>
                    </pre>
                  }>
                    <div class="preview-html break-words"
                      ref={(el) => { segEl = el }}
                      style={{ 'font-size': `${settings().fontSize}px`, 'line-height': 1.9 }}
                      onClick={(e) => {
                        const t = e.target as HTMLElement
                        if (t.tagName === 'IMG') setPreviewImg((t as HTMLImageElement).src)
                      }}
                      innerHTML={epubSeg()?.html ?? content()} />
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

      {/* 听书悬浮球：球体播放/暂停（SVG 图标），上方悬浮卡片放进度/倍速/音色/关闭。
          浮起一段距离，避开手机底部导航栏/浏览器工具栏的遮挡 */}
      <Show when={ttsOpen()}>
        <div class="fixed z-20 right-3 flex flex-col items-end gap-2"
          style={{ bottom: 'calc(88px + env(safe-area-inset-bottom, 0px))' }}>
          <div class="reader-bar rounded-[12px] border shadow-lg p-2.5 w-[228px]"
            style={{ background: theme().bg, 'border-color': theme().line }}>
            <div class="flex items-center gap-1 mb-2">
              <span class="flex-1 min-w-0 truncate text-[12px] opacity-60">
                {ttsError() || (ttsBusy() ? '语音生成中…' : (
                  (ttsIdx() >= 0 ? `${ttsIdx() + 1}/${sentences().length} · ` : '') +
                  (chapter()?.title_translated || chapter()?.title || '')
                ))}
              </span>
              <button class="border-0 px-1 shrink-0" title="关闭听书" onClick={closeTts}>
                <svg class="w-[16px] h-[16px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" x2="6" y1="6" y2="18" /><line x1="6" x2="18" y1="6" y2="18" />
                </svg>
              </button>
            </div>
            <div class="flex gap-2 mb-2">
              <button class="small flex-1" disabled={!sentences().length}
                title="上一句" onClick={() => skipSentence(-1)}>⏮ 上一句</button>
              <button class="small flex-1" disabled={!sentences().length}
                title="下一句" onClick={() => skipSentence(1)}>下一句 ⏭</button>
            </div>
            <div class="flex gap-2">
              <select class="shrink-0 w-[62px]" title="倍速"
                value={String(settings().rate)}
                onChange={(e) => setSettings(s => ({ ...s, rate: Number(e.currentTarget.value) }))}>
                <For each={RATES}>
                  {(r) => <option value={r}>{r}×</option>}
                </For>
              </select>
              <select class="flex-1 min-w-0"
                value={settings().voice || voiceDefault()}
                onChange={(e) => setSettings(s => ({ ...s, voice: e.currentTarget.value }))}>
                <For each={Object.entries(voices())}>
                  {([id, name]) => <option value={id}>{name}</option>}
                </For>
              </select>
            </div>
          </div>
          <button class="primary rounded-full w-[52px] h-[52px] shadow-lg flex items-center justify-center p-0"
            title={ttsPlaying() ? '暂停' : '播放'}
            onClick={toggleTts}>
            <Show when={ttsPlaying()} fallback={
              <svg class="w-[22px] h-[22px] translate-x-[2px]" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
            }>
              <svg class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
              </svg>
            </Show>
          </button>
        </div>
      </Show>

      {/* 图片全屏预览 */}
      <Show when={previewImg()}>
        <div class="fixed inset-0 z-30 bg-black/85 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setPreviewImg('')}>
          <img src={previewImg()} class="max-w-full max-h-full object-contain" alt="" />
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
