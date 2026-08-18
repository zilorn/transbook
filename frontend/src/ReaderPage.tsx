// 阅读器：全屏路由（不经侧边栏布局），桌面/移动端自适应。
// 内容取译文优先、缺失回退原文；阅读进度存后端，字号/主题设置存 localStorage。
import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js'
import { useNavigate, useParams } from '@solidjs/router'
import { api } from './api'
import type { Book, Bookmark, Chapter } from './types'

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
  const [tocTab, setTocTab] = createSignal<'toc' | 'bm'>('toc') // 目录抽屉：章节 / 书签
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
  const [ttsCtlOpen, setTtsCtlOpen] = createSignal(true) // 悬浮球控制面板展开/收缩
  const [ttsFollow, setTtsFollow] = createSignal(true) // 自动跟读（滚动跟随朗读句）：用户手动滚动后停止跟读（朗读与高亮继续），控制面板"返回跟读"恢复
  // Web Audio 播放：HTMLAudio 在移动端每次换 src/play 都要重建媒体管线（数百 ms），
  // 双元素预载也不会提前解码，句间必停顿；Web Audio 提前把下一句解码成 AudioBuffer，
  // 在当前句结束时刻 start(at) 精确调度（采样级无缝），暂停 = ctx.suspend() 冻结时钟。
  let actx: AudioContext | undefined
  let curSrc: AudioBufferSourceNode | undefined // 正在播的句
  let nextSrc: AudioBufferSourceNode | undefined // 已预调度的下一句
  let curEndAt = 0 // curSrc 预计结束时刻（actx 时钟，秒）
  let nextEndAt = 0
  let nextIdx = -1 // nextSrc 对应的句号（-1=无预调度）
  let nextKey = ''
  let wantPlay = false // 播放意图：切章/播报完自动续播都靠它
  let playGen = 0 // 播放代际：暂停/关闭/切章时递增，作废在途的合成等待与下一句接续
  // 播放/暂停按钮只随播放意图变（句间换音频触发的 pause/playing 事件不再让图标闪烁）
  const setWant = (v: boolean) => { wantPlay = v; setTtsPlaying(v) }
  let playedKey = '' // 当前音频对应的 章节id:音色（区分切章与换音色）
  let consecFails = 0 // 连续合成/播放失败句数，超阈值才停止
  const audioCache = new Map<number, Promise<Blob>>() // 本章音频缓存：句号 → 合成 Promise（失败不缓存）
  let prefetchGen = 0 // 预缓存代际：切章/换音色时作废旧的后台预取

  // 分句规则：一句（含结尾标点）或连续换行
  const SEG_RE = /[^。！？!?…\n]+[。！？!?…]*|\n+/g
  // 可朗读判断：至少含一个字母/数字/汉字等文字；纯标点段（如异常分割出的「」、——、※※）不朗读
  const speakable = (t: string) => /[\p{L}\p{N}]/u.test(t)
  interface Seg { t: string; si: number } // si=-1 为纯换行/纯标点段，不朗读；其余按顺序编号
  // 章节标题也朗读：固定为第 0 句（正文 h1 加 span[data-si="0"] 参与高亮），正文句号从 1 起编
  const titleText = (): string => {
    const c = chapter()
    if (!c || contentCid() !== c.id) return ''
    const t = (c.title_translated || c.title || '').trim()
    return speakable(t) ? t : ''
  }
  const titleOffset = () => (titleText() ? 1 : 0)
  const segments = (): Seg[] => {
    const txt = content().trim()
    if (!txt) return []
    let si = titleOffset()
    return (txt.match(SEG_RE) || []).map(t => ({ t, si: speakable(t) ? si++ : -1 }))
  }

  // 当前章节的朗读句清单：标题（可朗读时）为第 0 句，随后 txt 由正文直接分句、
  // epub 由拆句后的 HTML 得到（见 epubSeg）。
  // content 必须属于当前章节：切章后 loadChapter 还在等网络时 content 仍是上一章，
  // 不门控的话自动续播会拿上一章的句子接着读
  const sentences = (): string[] => {
    const c = chapter()
    if (!c || contentCid() !== c.id) return []
    const body = c.format === 'epub' ? (epubSeg()?.texts ?? []) : segments().filter(s => s.si >= 0).map(s => s.t)
    const t = titleText()
    return t ? [t, ...body] : body
  }

  // epub：用 DOMParser 处理 HTML 字符串（不依赖渲染时机，避免 effect/ref 竞态导致句清单为空），
  // 把文本节点拆成句级 span[data-si] 并同步收集句文本作为朗读清单——渲染的句与朗读的句是同一份数据。
  // 跳过 style/script/title 内的文本、纯空白节点与纯标点段（不朗读，按原样渲染不高亮）。
  // segEl 用 signal 而非普通变量：epub 正文 div 的创建晚于首批 effect 执行，
  // 普通变量不触发重跑，依赖 segEl 的 effect（tts 高亮/书签下划线）会在 ref 赋值前
  //  bailout 且之后再不重跑，导致首次进章节标记不显示
  const [segEl, setSegEl] = createSignal<HTMLDivElement | undefined>(undefined)
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
    let si = titleOffset()
    const texts: string[] = []
    for (const node of nodes) {
      const stripped = node.data.trim()
      if (!stripped) continue
      const frag = doc.createDocumentFragment()
      for (const part of stripped.match(SEG_RE) || []) {
        if (!speakable(part)) { frag.appendChild(doc.createTextNode(part)); continue }
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
    const key = `${c.id}:${h.length}:${titleOffset()}`
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

  // ---- 书签（选中文本添加；句子级定位，书签句显示橙色下划线）----
  const bookmarks = (): Bookmark[] => book()?.bookmarks ?? []
  // 当前章节被书签覆盖的句号集合
  const bmSis = (): Set<number> =>
    new Set(bookmarks().filter(b => b.cid === params.cid).flatMap(b => b.sis))
  const delBookmark = (bm: Bookmark) => {
    setBook(prev => prev && { ...prev, bookmarks: (prev.bookmarks ?? []).filter(x => x.id !== bm.id) })
    void api.removeBookmark(bookId, bm.id).catch(() => {})
  }

  // ---- 文本选取（自定义工具条：复制/书签/朗读；屏蔽原生 callout 与右键菜单）----
  let contentRef: HTMLDivElement | undefined
  const [selMenu, setSelMenu] = createSignal<{ x: number; y: number; above: boolean } | null>(null)
  let selTimer: ReturnType<typeof setTimeout> | undefined
  const onSelChange = () => {
    clearTimeout(selTimer)
    selTimer = setTimeout(() => {
      const sel = window.getSelection()
      const root = contentRef
      if (!sel || sel.isCollapsed || !root || !sel.toString().trim()) { setSelMenu(null); return }
      const range = sel.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) { setSelMenu(null); return }
      const r = range.getBoundingClientRect()
      const above = r.top > 56
      setSelMenu({
        x: Math.min(Math.max(r.left + r.width / 2, 96), window.innerWidth - 96),
        y: above ? r.top - 10 : r.bottom + 10,
        above,
      })
    }, 120) // 去抖：移动端拖动手柄期间持续触发，停手后才出工具条
  }
  const clearSel = () => { window.getSelection()?.removeAllRanges(); setSelMenu(null) }

  // 选取覆盖到的可朗读句号（span[data-si]，txt/epub 渲染结构一致）
  const coveredSis = (range: Range): number[] => {
    const out: number[] = []
    for (const el of contentRef?.querySelectorAll<HTMLElement>('span[data-si]') ?? []) {
      try { if (range.intersectsNode(el)) out.push(Number(el.dataset.si)) } catch { /* 游离节点 */ }
    }
    return out
  }

  // 朗读起点：从选取第 1 个字符所在的句开始；是标点则顺延到下一句含文字的字符
  // （实现：按文档序找第一个"交叠片段内含文字字符"的句 span）
  const ttsStartSi = (range: Range): number => {
    for (const el of contentRef?.querySelectorAll<HTMLElement>('span[data-si]') ?? []) {
      try {
        if (!range.intersectsNode(el)) continue
        const r = range.cloneRange()
        const sr = document.createRange()
        sr.selectNodeContents(el)
        if (r.compareBoundaryPoints(Range.START_TO_START, sr) < 0) r.setStart(sr.startContainer, sr.startOffset)
        if (r.compareBoundaryPoints(Range.END_TO_END, sr) > 0) r.setEnd(sr.endContainer, sr.endOffset)
        if (/[\p{L}\p{N}]/u.test(r.toString())) return Number(el.dataset.si)
      } catch { /* 游离节点 */ }
    }
    return -1
  }

  const copySel = async () => {
    const text = window.getSelection()?.toString() || ''
    if (!text) return
    try { await navigator.clipboard.writeText(text) } catch { document.execCommand('copy') }
    clearSel()
  }

  const bookmarkSel = async () => {
    const sel = window.getSelection()
    const c = chapter()
    if (!sel || sel.isCollapsed || !c) return
    const sis = coveredSis(sel.getRangeAt(0))
    const text = sel.toString().trim()
    clearSel()
    if (!sis.length || !text) return
    try {
      const bm = await api.addBookmark(bookId, { cid: c.id, sis, text })
      setBook(prev => prev && { ...prev, bookmarks: [...(prev.bookmarks ?? []), bm] })
    } catch { /* 失败静默：下次选取可再试 */ }
  }

  const speakSel = () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const si = ttsStartSi(sel.getRangeAt(0))
    clearSel()
    if (si >= 0) playFrom(si)
  }

  // 从指定句开始朗读（选中文本"朗读"、书签跳转朗读共用入口）
  const playFrom = (i: number) => {
    if (i < 0 || i >= sentences().length) return
    setTtsOpen(true)
    setWant(true)
    consecFails = 0
    killPlayback()
    playGen++
    void ensureCtx().resume()
    void playSentence(i)
    prefetchAll()
  }

  // 书签跳转：跨页（书籍详情）经 sessionStorage 传入，页内直接滚动
  let pendingJump: { cid: string; si: number } | null = null
  const jumpBookmark = (bm: Bookmark) => {
    setTocOpen(false)
    const si = bm.sis[0] ?? 0
    if (params.cid === bm.cid && contentCid() === bm.cid) {
      document.querySelector(`[data-si="${si}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }
    pendingJump = { cid: bm.cid, si }
    navigate(`/books/${bookId}/read/${bm.cid}`)
  }


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
      // 书签跳转目标章：由下面的跳转 effect 滚到书签句，不恢复旧滚动位置
      if (!(pendingJump && pendingJump.cid === c.id))
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
  // 倍速进 key：音频由后端按倍速生成（edge-tts rate 参数保调变速），换倍速等于换一批音频
  const playKey = () => `${params.cid}:${curVoice()}@${settings().rate}`

  // 合成并缓存第 i 句音频（Promise 缓存，并发调用共享；失败不缓存，下次重试）
  const getAudio = (i: number): Promise<Blob> => {
    let p = audioCache.get(i)
    if (!p) {
      p = api.ttsSpeak(sentences()[i], curVoice(), settings().rate)
      p.catch(() => audioCache.delete(i))
      audioCache.set(i, p)
    }
    return p
  }

  // 后台预缓存：从当前朗读位置起按 30 句一批发 /api/tts/warm，后端 12 并发合成落盘，
  // 播放时逐句请求全部毫秒级缓存命中。逐句预取受浏览器同源连接数限制（冷合成每句
  // 约 1.5s），冷缓存设备（手机首次播放、或音色与桌面端不同导致服务端缓存全 miss）
  // 会被播放追上，表现为每句"语音生成中"、读一句停一句——故预取走批量接口而非逐句请求。
  const WARM_BATCH = 30
  const prefetchAll = () => {
    const gen = ++prefetchGen
    const total = sentences().length
    const rate = settings().rate
    let next = Math.max(ttsIdx(), 0) // 从当前位置向后预取，已播过的句子多数已在缓存
    const worker = async () => {
      while (gen === prefetchGen) {
        const start = next
        next += WARM_BATCH
        if (start >= total) break
        // 已在内存缓存（已合成/在途）的句跳过，只发缺的去后端批量预热
        const texts: string[] = []
        for (let i = start; i < Math.min(start + WARM_BATCH, total); i++)
          if (!audioCache.has(i)) texts.push(sentences()[i])
        if (!texts.length) continue
        try {
          await api.ttsWarm(texts, curVoice(), rate)
        } catch { /* 预热失败不阻塞播放，播到时逐句现合成 */ }
      }
    }
    void worker()
    void worker()
  }

  const ensureCtx = (): AudioContext => {
    if (!actx) actx = new AudioContext()
    return actx
  }

  // 取第 i 句并解码为 AudioBuffer（blob 走 audioCache；解码结果不缓存——
  // 解码只要几十 ms，缓存整章 PCM 会占上百 MB 内存，移动端吃不消）
  const getBuffer = async (i: number): Promise<AudioBuffer> => {
    const blob = await getAudio(i)
    return ensureCtx().decodeAudioData(await blob.arrayBuffer())
  }

  // 停掉源并不触发其 onended（只有自然播完才走接续逻辑）
  const killSrc = (s: AudioBufferSourceNode | undefined) => {
    if (!s) return
    s.onended = null
    try { s.stop() } catch { /* 未 start 或已播完 */ }
    s.disconnect()
  }

  const killPlayback = () => {
    killSrc(curSrc)
    killSrc(nextSrc)
    curSrc = undefined
    nextSrc = undefined
    nextIdx = -1
    nextKey = ''
  }

  // 在 at 时刻开播第 i 句（解码已完成，启动无管线开销；倍速已在音频生成时生效）
  const startBuffer = (buf: AudioBuffer, i: number, key: string, at: number) => {
    const ctx = ensureCtx()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.onended = () => onSrcEnded(src, i, key)
    src.start(at)
    curSrc = src
    curEndAt = at + buf.duration
    setTtsBusy(false)
    consecFails = 0
    armNext(i + 1)
  }

  // 预调度第 i 句在当前句结束时刻开播：句间采样级无缝。只提前解码一句（内存可控）
  const armNext = (i: number) => {
    killSrc(nextSrc)
    nextSrc = undefined
    nextIdx = -1
    if (i >= sentences().length) return
    const key = playKey()
    const gen = playGen
    const endAt = curEndAt
    getBuffer(i).then((buf) => {
      // 等待期间已跳句/暂停/切章/换音色/换倍速/当前句被换掉：预调度作废
      if (gen !== playGen || key !== playKey() || !actx || !curSrc || curEndAt !== endAt) return
      const src = actx.createBufferSource()
      src.buffer = buf
      src.connect(actx.destination)
      src.onended = () => onSrcEnded(src, i, key)
      // 解码慢于当前句剩余时长时退化为立即开播（留小缝隙，避免与当前句叠音）
      const at = Math.max(endAt, actx.currentTime)
      src.start(at)
      nextSrc = src
      nextEndAt = at + buf.duration
      nextIdx = i
      nextKey = key
    }).catch(() => {})
  }

  // 句播完：下一句已预调度则记账接管（它已在无缝播放），否则回退现排（解码很快，缝隙极小）；
  // 本章播完连播下一章（切章由下面的 createEffect 接管续播）
  const onSrcEnded = (src: AudioBufferSourceNode, i: number, key: string) => {
    if (src !== curSrc) return // 只处理当前句的自然播完（killSrc 已摘除主动停止的回调）
    if (!wantPlay || key !== playKey()) return
    if (nextSrc && nextIdx === i + 1 && nextKey === key) {
      curSrc = nextSrc
      curEndAt = nextEndAt
      nextSrc = undefined
      nextIdx = -1
      nextKey = ''
      playedKey = key
      setTtsIdx(i + 1)
      armNext(i + 2)
    } else if (i + 1 < sentences().length) void playSentence(i + 1)
    else if (idx() >= 0 && idx() < chapters().length - 1) next()
    else { setWant(false); setTtsBusy(false); setTtsIdx(-1) }
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
    let buf: AudioBuffer
    try {
      buf = await getBuffer(i)
    } catch {
      skipBadSentence(i) // 合成/解码失败：跳句
      return
    }
    // 等待合成期间已切章/换音色/暂停：gen 变了说明用户已主动停掉，在途的下一句一并作废
    if (!wantPlay || gen !== playGen || playedKey !== key || ttsIdx() !== i) return
    const ctx = ensureCtx()
    void ctx.resume()
    killPlayback()
    startBuffer(buf, i, key, ctx.currentTime)
    // 预取随后几句，减少句间停顿
    for (let j = i + 1; j < Math.min(i + 6, sentences().length); j++) getAudio(j).catch(() => {})
  }

  // 视口内第一个可朗读句的下标（sticky 顶栏高 48px，留少量余量）：
  // 全新开播时若用户已滚动阅读过，从当前页面第一行开始读而不是从头。
  // 全部滚过（停在章末导航栏）则取最后一句；找不到任何句时回退 0。
  const firstVisibleIdx = (): number => {
    let last = -1
    for (const el of document.querySelectorAll<HTMLElement>('[data-si]')) {
      if (el.getBoundingClientRect().bottom > 56) return Number(el.dataset.si)
      last = Number(el.dataset.si)
    }
    return Math.max(last, 0)
  }

  // fromVisible 仅用于用户主动点播放按钮的全新开播；章末连播切章由续播 effect
  // 调 playTts()，那时滚动位置还没恢复（仍是上一章的），不能按可见句定位。
  const playTts = (fromVisible = false) => {
    if (!chapter()) return
    if (!sentences().length) { setTtsError('本章没有可朗读的文本'); setWant(false); return }
    void ensureCtx().resume()
    const start = ttsIdx() >= 0 ? ttsIdx() : fromVisible ? firstVisibleIdx() : 0
    void playSentence(start)
    prefetchAll()
  }

  const toggleTts = () => {
    setTtsOpen(true)
    if (wantPlay) {
      // 暂停：只有用户操作才停；递增 playGen 把在途的下一句合成/接续一并作废
      setWant(false)
      playGen++
      void actx?.suspend() // 冻结时钟：在播句与预调度的下一句一起停住
    } else {
      setWant(true)
      // 暂停在同一句中途则续播（时钟继续走），否则从头开始
      if (actx?.state === 'suspended' && curSrc && playedKey === playKey() && ttsIdx() >= 0) {
        setTtsError('')
        void actx.resume()
      } else {
        playTts(true) // 全新开播：从当前视口第一行起读（未滚动时即首句）
      }
    }
  }

  // 上一句/下一句：播放中跳句重读（递增 playGen 作废当前句的在途合成与 ended 接续）；
  // 暂停中只移动高亮位置并清掉旧源，再按播放时从该句重头开始
  const skipSentence = (d: number) => {
    const total = sentences().length
    if (!total) return
    const i = Math.min(Math.max((ttsIdx() < 0 ? 0 : ttsIdx()) + d, 0), total - 1)
    consecFails = 0
    killPlayback()
    if (wantPlay) {
      playGen++
      void ensureCtx().resume()
      void playSentence(i)
      prefetchAll() // 跳句后从新位置重新向后预取（playSentence 已同步更新 ttsIdx）
    } else {
      setTtsIdx(i)
    }
  }

  const closeTts = () => {
    setWant(false)
    playGen++
    killPlayback()
    void actx?.suspend()
    setTtsOpen(false)
    setTtsIdx(-1)
    setTtsFollow(true)
  }

  // 切章/换音色：清空本章音频缓存与朗读位置，作废在途的合成等待与调度
  createEffect((prev: string) => {
    const key = `${params.cid}:${settings().voice}`
    if (prev && prev !== key) {
      audioCache.clear()
      prefetchGen++
      playGen++
      killPlayback()
      setTtsIdx(-1)
      setTtsFollow(true)
      consecFails = 0
    }
    return key
  }, '')

  // 切章或换音色时，若处于播放意图则换源续播（换音色重读当前句，切章从首句开始）。
  // 等分句就绪（epub 需等渲染拆句完成）再启动，避免误报"没有可朗读文本"。
  // ttsIdx 必须 untrack：否则 playSentence 里每次 setTtsIdx 都会重触本 effect，同一句被重复播放。
  createEffect(() => {
    const key = playKey()
    if (!wantPlay || !chapter() || !sentences().length) return
    untrack(() => {
      if (playedKey === key && ttsIdx() >= 0) void playSentence(ttsIdx())
      else playTts()
    })
  })

  // 换倍速：音频由后端按倍速生成（edge-tts 保调变速），本章音频缓存全部失效。
  // 保持当前位置不重置 ttsIdx——续播 effect 的 playKey 含倍速，会自动重读当前句
  createEffect((prev: number) => {
    const r = settings().rate
    if (prev && prev !== r) {
      audioCache.clear()
      prefetchGen++
      playGen++
      killPlayback()
      consecFails = 0
    }
    return r
  }, 0)

  // 朗读句自动滚动到视野中部（ttsFollow 关闭时只高亮不滚动）
  createEffect(() => {
    const i = ttsIdx()
    if (i >= 0 && ttsOpen() && ttsFollow())
      document.querySelector(`[data-si="${i}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })

  // epub 高亮靠切换 .tts-active（txt 由 Solid classList 绑定，不走这里）
  createEffect(() => {
    const i = ttsIdx()
    const c = chapter()
    const el = segEl()
    if (!el || c?.format !== 'epub') return
    el.querySelector('.tts-active')?.classList.remove('tts-active')
    if (i >= 0) el.querySelector(`[data-si="${i}"]`)?.classList.add('tts-active')
  })

  // epub 书签橙色下划线：内容重渲染（innerHTML）或书签增删后重刷（txt 由 classList 绑定）
  createEffect(() => {
    const c = chapter()
    const marks = bmSis()
    const el = segEl()
    if (!epubSeg() || !el || c?.format !== 'epub') return
    el.querySelectorAll('.bm-mark').forEach(e => e.classList.remove('bm-mark'))
    for (const e of el.querySelectorAll<HTMLElement>('span[data-si]'))
      if (marks.has(Number(e.dataset.si))) e.classList.add('bm-mark')
  })

  // 书签跳转：本章内容加载完成后滚到书签句。pendingJump 为页内跳转；
  // 跨页跳转（书籍详情页）经 sessionStorage 传入（60s 内有效，消费即删）
  createEffect(() => {
    const cid = contentCid()
    if (!cid) return
    let si: number | null = null
    if (pendingJump) {
      if (pendingJump.cid !== cid) return
      si = pendingJump.si
      pendingJump = null
    } else {
      try {
        const key = `reader-jump:${bookId}`
        const j = JSON.parse(sessionStorage.getItem(key) || 'null')
        if (!j) return
        if (Date.now() - Number(j.ts) > 60_000) { sessionStorage.removeItem(key); return }
        if (j.cid !== cid) return
        sessionStorage.removeItem(key)
        si = Number(j.si)
      } catch { return }
    }
    if (si == null || Number.isNaN(si)) return
    requestAnimationFrame(() => requestAnimationFrame(() =>
      document.querySelector(`[data-si="${si}"]`)?.scrollIntoView({ block: 'center' })))
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

  // 用户手动滚动（滚轮/触摸/键盘翻页键）时停止自动跟读，朗读与高亮不受影响；
  // 程序性 smooth 滚动不触发这些事件，不会误停
  const onUserScroll = () => {
    if (ttsOpen() && ttsFollow() && ttsIdx() >= 0) setTtsFollow(false)
  }
  // 控制面板"返回跟读"：恢复跟读；置回 true 会重触上面的滚动 effect，自动滚回当前朗读句
  const resumeFollow = () => setTtsFollow(true)

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
    // 空格/PageUp/PageDown/上下方向键/Home/End 会原生滚动页面，视为手动滚动
    else if ([' ', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) onUserScroll()
  }

  onMount(async () => {
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('wheel', onUserScroll, { passive: true })
    window.addEventListener('touchmove', onUserScroll, { passive: true })
    window.addEventListener('keydown', onKey)
    document.addEventListener('selectionchange', onSelChange)
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
    window.removeEventListener('wheel', onUserScroll)
    window.removeEventListener('touchmove', onUserScroll)
    window.removeEventListener('keydown', onKey)
    document.removeEventListener('selectionchange', onSelChange)
    clearTimeout(selTimer)
    document.body.style.background = ''
    wantPlay = false
    killPlayback()
    void actx?.close()
    actx = undefined
  })

  // 打开目录时滚动到当前章；同时锁定正文滚动，防止抽屉滚动穿透到正文
  let tocRef: HTMLDivElement | undefined
  createEffect(() => {
    if (tocOpen()) {
      document.body.style.overflow = 'hidden'
      requestAnimationFrame(() =>
        tocRef?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'center' }))
      onCleanup(() => { document.body.style.overflow = '' })
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

      {/* 正文：自定义文本选取工具条，屏蔽原生右键菜单/长按 callout */}
      <div class="max-w-[800px] mx-auto px-4 md:px-6 pt-5 [-webkit-touch-callout:none]"
        ref={(el) => { contentRef = el }}
        onContextMenu={(e) => e.preventDefault()}
        style={{ 'padding-bottom': ttsOpen() ? (ttsCtlOpen() ? '180px' : '100px') : '32px' }}>
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
                  <h1 class="text-[1.35em] font-bold mt-0 mb-6 leading-[1.5] break-all"
                    data-si={titleOffset() ? 0 : undefined}
                    classList={{ 'tts-active': titleOffset() === 1 && ttsIdx() === 0, 'bm-mark': titleOffset() === 1 && bmSis().has(0) }}>
                    {c().title_translated || c().title}
                  </h1>
                  {/* 听书逐句高亮：txt 始终按句渲染 span；epub 渲染的是 epubSeg 拆句后的
                      HTML（已含 span[data-si]）。两者都只对当前朗读句加 .tts-active */}
                  <Show when={c().format === 'epub'} fallback={
                    <pre class="m-0 whitespace-pre-wrap break-words font-[inherit]"
                      style={{ 'font-size': `${settings().fontSize}px`, 'line-height': 1.9 }}>
                      <For each={segments()}>{(seg) => seg.si < 0 ? seg.t : (
                        <span data-si={seg.si} class="px-[1px]"
                          classList={{ 'tts-active': seg.si === ttsIdx(), 'bm-mark': bmSis().has(seg.si) }}>
                          {seg.t}
                        </span>
                      )}</For>
                    </pre>
                  }>
                    <div class="preview-html break-words"
                      ref={setSegEl}
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

      {/* 听书悬浮球：球体播放/暂停（SVG 图标），同组小圆钮为收缩/展开控制面板与关闭听书，
          控制面板（进度/上一句/下一句/倍速/音色）可收缩进悬浮球。
          浮起一段距离，避开手机底部导航栏/浏览器工具栏的遮挡 */}
      <Show when={ttsOpen()}>
        <div class="fixed z-20 right-3 flex flex-col items-end gap-2"
          style={{ bottom: 'calc(88px + env(safe-area-inset-bottom, 0px))' }}>
          <Show when={ttsCtlOpen()}>
            <div class="reader-bar rounded-[12px] border shadow-lg p-2.5 w-[228px]"
              style={{ background: theme().bg, 'border-color': theme().line }}>
              <div class="mb-2 truncate text-center text-[12px] opacity-60">
                {ttsError() || (ttsBusy() ? '语音生成中…' : (
                  (ttsIdx() >= 0 ? `${ttsIdx() + 1}/${sentences().length} · ` : '') +
                  (chapter()?.title_translated || chapter()?.title || '')
                ))}
              </div>
              <Show when={!ttsFollow()}>
                <button class="small w-full mb-2 flex items-center justify-center gap-1"
                  title="回到当前朗读句并恢复自动滚动" onClick={resumeFollow}>
                  <svg class="w-[14px] h-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" />
                    <line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" />
                  </svg>
                  返回跟读
                </button>
              </Show>
              <div class="flex gap-2 mb-2">
                <button class="small flex-1 flex items-center justify-center gap-1" disabled={!sentences().length}
                  title="上一句" onClick={() => skipSentence(-1)}>
                  <svg class="w-[14px] h-[14px]" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="19 20 9 12 19 4 19 20" /><rect x="5" y="4" width="2.5" height="16" />
                  </svg>
                  上一句
                </button>
                <button class="small flex-1 flex items-center justify-center gap-1" disabled={!sentences().length}
                  title="下一句" onClick={() => skipSentence(1)}>
                  下一句
                  <svg class="w-[14px] h-[14px]" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 4 15 12 5 20 5 4" /><rect x="16.5" y="4" width="2.5" height="16" />
                  </svg>
                </button>
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
          </Show>
          <div class="flex items-center gap-2">
            <button class="reader-bar rounded-full w-[36px] h-[36px] shadow-lg flex items-center justify-center p-0 border"
              style={{ background: theme().bg, 'border-color': theme().line }}
              title="关闭听书" onClick={closeTts}>
              <svg class="w-[16px] h-[16px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" x2="6" y1="6" y2="18" /><line x1="6" x2="18" y1="6" y2="18" />
              </svg>
            </button>
            <button class="reader-bar rounded-full w-[36px] h-[36px] shadow-lg flex items-center justify-center p-0 border"
              style={{ background: theme().bg, 'border-color': theme().line }}
              title={ttsCtlOpen() ? '收起控制' : '展开控制'}
              onClick={() => setTtsCtlOpen(v => !v)}>
              <Show when={ttsCtlOpen()} fallback={
                <svg class="w-[16px] h-[16px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
              }>
                <svg class="w-[16px] h-[16px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </Show>
            </button>
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
        </div>
      </Show>

      {/* 图片全屏预览 */}
      <Show when={previewImg()}>
        <div class="fixed inset-0 z-30 bg-black/85 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setPreviewImg('')}>
          <img src={previewImg()} class="max-w-full max-h-full object-contain" alt="" />
        </div>
      </Show>

      {/* 文本选取工具条：复制 / 书签 / 朗读。pointerdown 阻止默认行为，
          避免点按钮前选区被浏览器清掉 */}
      <Show when={selMenu()}>
        {(m) => (
          <div class="reader-bar fixed z-30 flex gap-1 rounded-[8px] border shadow-lg p-1 select-none"
            style={{
              left: `${m().x}px`, top: `${m().y}px`,
              transform: m().above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
              background: theme().bg, 'border-color': theme().line,
            }}
            onPointerDown={(e) => e.preventDefault()}>
            <button class="small border-0" onClick={copySel}>复制</button>
            <button class="small border-0" onClick={() => void bookmarkSel()}>书签</button>
            <button class="small border-0" onClick={speakSel}>朗读</button>
          </div>
        )}
      </Show>

      {/* 目录抽屉：移动端全屏，桌面右侧 360px；含章节 / 书签两个页签 */}
      <Show when={tocOpen()}>
        <div class="fixed inset-0 z-20 bg-black/40" onClick={() => setTocOpen(false)}>
          <div ref={tocRef}
            class="reader-bar absolute right-0 top-0 h-full w-full md:w-[360px] overflow-y-auto border-l"
            style={{ background: theme().bg, 'border-color': theme().line, 'overscroll-behavior': 'contain' }}
            onClick={(e) => e.stopPropagation()}>
            <div class="sticky top-0 z-10 flex items-center gap-1 px-2 h-[48px] border-b"
              style={{ background: theme().bg, 'border-color': theme().line }}>
              <button class={`small ${tocTab() === 'toc' ? 'primary' : 'border-0'}`}
                onClick={() => setTocTab('toc')}>
                目录（{chapters().length}）
              </button>
              <button class={`small ${tocTab() === 'bm' ? 'primary' : 'border-0'}`}
                onClick={() => setTocTab('bm')}>
                书签（{bookmarks().length}）
              </button>
              <div class="flex-1" />
              <button class="small" onClick={() => setTocOpen(false)}>关闭</button>
            </div>
            <Show when={tocTab() === 'toc'} fallback={
              <>
                <For each={bookmarks()}>
                  {(bm) => (
                    <div class="flex items-start gap-2 px-4 py-[10px] border-b text-[14px]"
                      style={{ 'border-color': theme().line }}>
                      <button class="flex-1 min-w-0 text-left border-0 bg-transparent p-0"
                        onClick={() => jumpBookmark(bm)}>
                        <div class="line-clamp-2 break-all underline decoration-[#f59e0b] decoration-2 underline-offset-4">
                          {bm.text}
                        </div>
                        <div class="text-[12px] opacity-50 mt-1 truncate">
                          {chapters().find(c => c.id === bm.cid)?.title_translated
                            || chapters().find(c => c.id === bm.cid)?.title || '章节已删除'}
                        </div>
                      </button>
                      <button class="small shrink-0" title="删除书签"
                        onClick={() => delBookmark(bm)}>删</button>
                    </div>
                  )}
                </For>
                <Show when={!bookmarks().length}>
                  <p class="text-center py-[40px] text-[13px] opacity-50">
                    还没有书签，在阅读页选中文本即可添加。
                  </p>
                </Show>
              </>
            }>
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
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
