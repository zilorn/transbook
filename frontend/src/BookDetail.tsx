import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { useNavigate, useParams } from '@solidjs/router'
import { api } from './api'
import type { Book, Bookmark, Chapter, ChapterPreview, GlossaryTerm } from './types'

const CH_STATUS: Record<string, string> = { pending: '待翻译', translating: '翻译中', done: '已完成', error: '失败' }

// 原 .badge 基础样式与 .st-* 状态色
const BADGE_BASE = 'text-[12px] rounded-[4px] px-[7px] py-[2px]'
const BADGE = `${BADGE_BASE} bg-[#eef0f3] text-muted`
const STATUS_BADGE: Record<string, string> = {
  translating: 'bg-[#dbeafe] text-[#1d4ed8]',
  done: 'bg-[#dcfce7] text-[#166534]',
  error: 'bg-[#fee2e2] text-[#991b1b]',
}

interface PreviewState {
  title: string
  format: string
  loading: boolean
  content: string
  error: string
}

interface AppendChapter extends ChapterPreview {
  checked: boolean
}

interface AppendPreview {
  chapters: AppendChapter[]
  existing: number
  filename: string
}

export default function BookDetail() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const bookId = params.id
  const [book, setBook] = createSignal<Book | null>(null)
  const [error, setError] = createSignal('')
  const [msg, setMsg] = createSignal('')
  const [glossary, setGlossary] = createSignal<GlossaryTerm[]>([])
  const [glossaryDirty, setGlossaryDirty] = createSignal(false)
  const [tab, setTab] = createSignal('chapters')
  const [addTitle, setAddTitle] = createSignal('')
  const [addBody, setAddBody] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [preview, setPreview] = createSignal<PreviewState | null>(null)
  const [appendPrev, setAppendPrev] = createSignal<AppendPreview | null>(null)
  const [chapterQuery, setChapterQuery] = createSignal('')
  // 状态筛选：空集合 = 不过滤；点击表头"状态"展开勾选
  const [statusFilter, setStatusFilter] = createSignal<Set<string>>(new Set<string>())
  const [statusMenuOpen, setStatusMenuOpen] = createSignal(false)
  const [statusMenuPos, setStatusMenuPos] = createSignal({ top: 0, left: 0 })
  let statusMenuRef: HTMLDivElement | undefined
  const toggleStatusFilter = (s: string) => {
    const next = new Set(statusFilter())
    if (next.has(s)) next.delete(s); else next.add(s)
    setStatusFilter(next)
  }
  const toggleStatusMenu = (e: MouseEvent) => {
    if (!statusMenuOpen()) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setStatusMenuPos({ top: r.bottom + 4, left: r.left })
    }
    setStatusMenuOpen(v => !v)
  }
  const statusCount = (s: string) => (book()?.chapters || []).filter(c => c.status === s).length

  // ---- 目录表格列宽：# / 标题 / 操作列可拖拽调整，状态列固定不可调 ----
  const STATUS_COL_W = 96
  const [colW, setColW] = createSignal({ idx: 52, title: 620, ops: 88 })
  const startColResize = (e: PointerEvent, key: 'idx' | 'title' | 'ops', min: number) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = colW()[key]
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    const move = (ev: PointerEvent) =>
      setColW(w => ({ ...w, [key]: Math.max(min, startW + ev.clientX - startX) }))
    const up = () => {
      document.body.style.userSelect = prevSelect
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const colResizer = (key: 'idx' | 'title' | 'ops', min: number) => (
    <span class="absolute top-0 right-[-4px] z-[1] h-full w-[8px] cursor-col-resize hover:bg-primary/40"
      onPointerDown={(e) => startColResize(e, key, min)} />
  )

  // 章节搜索：按原标题/译后标题过滤（不区分大小写），保留原序号；再按状态筛选
  const filteredChapters = () =>
    (book()?.chapters || [])
      .map((c, i) => ({ c, n: i + 1 }))
      .filter(({ c }) => {
        const q = chapterQuery().trim().toLowerCase()
        if (!q) return true
        return c.title.toLowerCase().includes(q) || (c.title_translated || '').toLowerCase().includes(q)
      })
      .filter(({ c }) => statusFilter().size === 0 || statusFilter().has(c.status))

  // ---- 章节内容预览（原文/译文）----
  const openPreview = async (c: Chapter, translated: boolean) => {
    setPreview({
      title: translated ? (c.title_translated || c.title) : c.title,
      format: c.format, loading: true, content: '', error: '',
    })
    try {
      const content = await api.chapterContent(bookId, c.id, translated)
      setPreview(p => (p ? { ...p, loading: false, content } : p))
    } catch (e: any) {
      setPreview(p => (p ? { ...p, loading: false, error: String(e.message || e) } : p))
    }
  }

  const refresh = async () => {
    try {
      const prev = book()?.status
      const b = await api.book(bookId)
      setBook(b)
      // 术语表生成完毕（状态从 glossary 变回 ready），更新提示
      if (prev === 'glossary' && b.status === 'ready') setMsg('术语表已生成')
      if (!glossaryDirty()) setGlossary((b.glossary || []).map(t => ({ ...t })))
    } catch (e: any) { setError(String(e.message || e)) }
  }

  let timer: ReturnType<typeof setInterval>
  const onDocPointerDown = (e: PointerEvent) => {
    if (statusMenuRef && !statusMenuRef.contains(e.target as Node)) setStatusMenuOpen(false)
  }
  onMount(() => {
    refresh()
    document.addEventListener('pointerdown', onDocPointerDown)
    timer = setInterval(() => {
      const b = book()
      if (b && (b.running || b.status === 'translating' || b.status === 'glossary')) refresh()
    }, 2000)
  })
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener('pointerdown', onDocPointerDown)
  })

  const act = async (fn: () => Promise<unknown>, okMsg = '') => {
    setBusy(true)
    setError('')
    setMsg('')
    try {
      await fn()
      if (okMsg) setMsg(okMsg)
      await refresh()
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  // ---- 术语表编辑 ----
  const setTerm = <K extends keyof GlossaryTerm>(i: number, k: K, v: GlossaryTerm[K]) => {
    const g = glossary().slice()
    g[i] = { ...g[i], [k]: v }
    setGlossary(g)
    setGlossaryDirty(true)
  }
  const addTerm = () => { setGlossary([...glossary(), { src: '', dst: '', type: '术语', note: '' }]); setGlossaryDirty(true) }
  const delTerm = (i: number) => { setGlossary(glossary().filter((_, n) => n !== i)); setGlossaryDirty(true) }
  const saveGlossary = () => act(
    () => api.saveGlossary(bookId, glossary()),
    '术语表已保存'
  ).then(() => setGlossaryDirty(false))
  const copyGlossary = async () => {
    const text = glossary().filter(t => t.src).map(t => `${t.src} => ${t.dst}`).join('\n')
    if (!text) return
    await navigator.clipboard.writeText(text)
    setMsg('术语表已复制到剪贴板')
  }

  // ---- 追加章节 ----
  const onAddFile = async (e: { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    setBusy(true)
    setError('')
    setMsg('')
    try {
      const res = await api.previewChapters(bookId, file)
      setAppendPrev({
        chapters: res.chapters.map(c => ({ ...c, checked: !c.duplicate })),
        existing: res.existing,
        filename: file.name,
      })
    } catch (err: any) {
      setError(String(err.message || err))
    } finally {
      setBusy(false)
    }
  }
  const toggleAppend = (i: number, checked: boolean) => {
    setAppendPrev(p => p && ({
      ...p,
      chapters: p.chapters.map((c, n) => (n === i ? { ...c, checked } : c)),
    }))
  }
  const setAllAppend = (checked: boolean) => {
    setAppendPrev(p => p && ({ ...p, chapters: p.chapters.map(c => ({ ...c, checked })) }))
  }
  const confirmAppend = () => {
    const p = appendPrev()
    if (!p) return
    const selected = p.chapters.filter(c => c.checked)
      .map(c => ({ title: c.title, body: c.body, format: c.format }))
    if (!selected.length) return
    act(() => api.addChapters(bookId, selected), `已追加 ${selected.length} 章`)
      .then(() => setAppendPrev(null))
  }
  const onAddText = () => {
    const title = addTitle().trim()
    const body = addBody().trim()
    if (!title || !body) return
    act(() => api.addChapters(bookId, [{ title, body: addBody(), format: 'txt' }]), '章节已添加')
      .then(() => { setAddTitle(''); setAddBody('') })
  }

  const doneCount = () => (book()?.chapters || []).filter(c => c.status === 'done').length

  // ---- 排队翻译弹窗：选翻译类型（常规/重翻）+ 章节范围（1 起，与目录 # 列一致）----
  const [queueOpen, setQueueOpen] = createSignal(false)
  const [qOverwrite, setQOverwrite] = createSignal(false)
  const [qFrom, setQFrom] = createSignal('1')
  const [qTo, setQTo] = createSignal('1')
  const openQueueDialog = () => {
    setQOverwrite(false)
    setQFrom('1')
    setQTo(String(book()?.chapters.length || 1))
    setQueueOpen(true)
  }
  const confirmQueue = () => {
    const chs = book()?.chapters || []
    const n = chs.length
    if (!n) return
    let from = parseInt(qFrom(), 10)
    let to = parseInt(qTo(), 10)
    if (isNaN(from)) from = 1
    if (isNaN(to)) to = n
    from = Math.min(Math.max(from, 1), n)
    to = Math.min(Math.max(to, 1), n)
    if (from > to) [from, to] = [to, from]
    const ids = chs.slice(from - 1, to).map(c => c.id)
    const re = qOverwrite()
    // 全本范围时不传 chapter_ids，保持与整书入队一致
    const ranged = from !== 1 || to !== n
    act(() => api.enqueue(bookId, re, ranged ? ids : undefined),
      re ? '已加入翻译队列（重翻所选章节）' : '已加入翻译队列')
      .then(() => setQueueOpen(false))
  }

  // ---- 书签（阅读器选中文本添加）----
  // 展示按章节顺序排序（章节序 → 句号；章节已删除的排最后），内部数据仍按添加顺序存
  const bookmarks = (): Bookmark[] => {
    const list = book()?.bookmarks ?? []
    const chIdx = new Map((book()?.chapters ?? []).map((c, i) => [c.id, i]))
    return [...list].sort((a, b) =>
      (chIdx.get(a.cid) ?? Number.MAX_SAFE_INTEGER) - (chIdx.get(b.cid) ?? Number.MAX_SAFE_INTEGER)
      || Math.min(...a.sis) - Math.min(...b.sis))
  }
  const bmChapterTitle = (cid: string) => {
    const c = book()?.chapters.find(x => x.id === cid)
    return c ? (c.title_translated || c.title) : '章节已删除'
  }
  // 跳转阅读器对应章节的书签句：经 sessionStorage 把句号带给阅读器（60s 内有效）
  const jumpBookmark = (bm: Bookmark) => {
    sessionStorage.setItem(`reader-jump:${bookId}`,
      JSON.stringify({ cid: bm.cid, si: bm.sis[0] ?? 0, ts: Date.now() }))
    navigate(`/books/${bookId}/read/${bm.cid}`)
  }

  // ---- 来源站点增量更新（仅抓新章节）----
  const [updating, setUpdating] = createSignal(false)
  const updateFromSource = async () => {
    setUpdating(true)
    setError('')
    setMsg('')
    const isKakuyomu = book()?.source?.site === 'kakuyomu'
    const updateApi = isKakuyomu ? api.kakuyomuUpdate : api.syosetuUpdate
    const statusApi = isKakuyomu ? api.kakuyomuStatus : api.syosetuStatus
    try {
      await updateApi(bookId)
      for (;;) {
        await new Promise(r => setTimeout(r, 2000))
        const st = await statusApi(bookId)
        if (!st.running) {
          if (st.error) setError(`更新失败：${st.error}（已抓部分保留）`)
          else setMsg(st.added > 0 ? `已新增 ${st.added} 章` : '已是最新，没有新章节')
          break
        }
      }
      await refresh()
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setUpdating(false)
    }
  }

  return (
    <Show when={book()} fallback={<p>加载中…</p>}>
      {(b) => (
        <div>
          <button class="link" onClick={() => navigate('/')}>← 返回列表</button>
          <div>
            <div class="flex items-center gap-2 mt-3 mb-1">
              <h2 class="text-[1.5em] font-bold m-0">{b().title_translated || b().title}</h2>
              <Show when={!b().no_translate}>
                <button class="link p-0 inline-flex items-center" title="重翻书名"
                  disabled={busy() || b().running}
                  onClick={() => act(() => api.retranslateTitle(b().id), '正在重翻书名…')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <polyline points="21 3 21 9 15 9" />
                  </svg>
                </button>
              </Show>
            </div>
            <Show when={b().title_translated && b().title_translated !== b().title}>
              <p class="text-muted text-[13px] m-0">原名：{b().title}</p>
            </Show>
            <div class="flex gap-1.5 flex-wrap my-2">
              <span class={BADGE}>{b().format}</span>
              <span class={BADGE}>
                {b().no_translate ? `${b().chapters.length} 章` : `${doneCount()}/${b().chapters.length} 章`}
              </span>
              <Show when={!b().no_translate}>
                <span class={BADGE}>状态：{b().status}{b().running ? '（运行中）' : ''}</span>
              </Show>
              <Show when={b().no_translate}>
                <span class={`${BADGE_BASE} bg-[#fef3c7] text-[#92400e]`}>无需翻译（仅托管）</span>
              </Show>
              <Show when={b().source}>
                <a class={`${BADGE} no-underline hover:text-primary`}
                  href={b().source!.url} target="_blank" rel="noreferrer"
                  title={`作品页：${b().source!.url}`}>
                  来源：{b().source!.site}{b().source!.site === 'kakuyomu' ? '.jp' : '.com'} ↗
                </a>
              </Show>
            </div>
            <Show when={!b().no_translate}>
              <div class="h-2.5 bg-[#e5e7eb] rounded-[3px] overflow-hidden my-2">
                <div class="h-full bg-primary transition-[width] duration-[0.4s]"
                  style={{ width: `${b().chapters.length ? (doneCount() / b().chapters.length) * 100 : 0}%` }} />
              </div>
            </Show>
          </div>

          <div class="flex flex-col gap-2.5 my-4 items-start">
            {/* 阅读是最高频操作，放第一排 */}
            <div class="flex gap-2.5 items-center flex-wrap">
              <button class="primary" disabled={b().chapters.length === 0}
                title="进入阅读器（自动续读上次位置）"
                onClick={() => navigate(`/books/${b().id}/read`)}>
                阅读
              </button>
              <Show when={b().source}>
                <button disabled={busy() || b().running || updating()}
                  title="从来源站点检查并抓取最新章节"
                  onClick={updateFromSource}>
                  {updating() ? '正在更新…' : '更新章节'}
                </button>
              </Show>
              <button disabled={busy() || b().running}
                title="标记后仅用于托管（阅读/导出/WebDAV），不再参与任何翻译任务"
                onClick={() => act(
                  () => api.setNoTranslate(b().id, !b().no_translate),
                  b().no_translate ? '已取消「无需翻译」标记' : '已标记为无需翻译（仅托管）'
                ).then(() => { if (b().no_translate && tab() === 'glossary') setTab('chapters') })}>
                {b().no_translate ? '取消「无需翻译」' : '标记为无需翻译'}
              </button>
            </div>
            <Show when={!b().no_translate}>
              {/* 翻译操作：方框按钮紧贴成组，单独一行 */}
              <div class="flex items-center flex-wrap gap-y-2">
                <div class="flex">
                  <button class="primary rounded-r-none" disabled={busy() || b().running}
                    title="选择翻译类型与章节范围后加入翻译队列"
                    onClick={openQueueDialog}>
                    排队翻译
                  </button>
                  <button class="rounded-none -ml-px" disabled={busy() || b().running}
                    onClick={() => act(() => api.generateGlossary(b().id), '正在生成术语表…')}>
                    生成术语表
                  </button>
                  <button class="rounded-l-none -ml-px" disabled={busy() || b().running}
                    onClick={() => act(() => api.retranslateToc(b().id), '正在重翻目录…')}>
                    重翻目录
                  </button>
                </div>
              </div>
            </Show>
            {/* 导出：方框按钮紧贴成组，单独一行 */}
            <div class="flex">
              <a class="inline-block px-[14px] py-[7px] border border-line rounded-l-[6px] bg-card text-text text-[14px] no-underline hover:border-primary hover:text-primary"
                href={api.exportUrl(b().id, 'txt')} download="">导出 TXT</a>
              <a class="inline-block px-[14px] py-[7px] border border-line rounded-r-[6px] -ml-px bg-card text-text text-[14px] no-underline hover:border-primary hover:text-primary"
                href={api.exportUrl(b().id, 'epub')} download="">导出 EPUB</a>
            </div>
          </div>
          {error() && <p class="text-danger text-[13px]">{error()}</p>}
          {msg() && <p class="text-[#166534] text-[13px]">{msg()}</p>}
          {b().error && <p class="text-danger text-[13px]">{b().error}</p>}

          <div class="flex gap-1 border-b border-line mt-[18px] mb-3">
            <button class={`border-0 bg-transparent rounded-none px-[14px] py-2 ${tab() === 'chapters' ? 'border-b-2 border-primary text-primary' : ''}`}
              onClick={() => setTab('chapters')}>
              章节（{b().chapters.length}）
            </button>
            <Show when={!b().no_translate}>
              <button class={`border-0 bg-transparent rounded-none px-[14px] py-2 ${tab() === 'glossary' ? 'border-b-2 border-primary text-primary' : ''}`}
                onClick={() => setTab('glossary')}>
                术语表（{glossary().length}）{glossaryDirty() ? ' *' : ''}
              </button>
            </Show>
            <button class={`border-0 bg-transparent rounded-none px-[14px] py-2 ${tab() === 'bookmarks' ? 'border-b-2 border-primary text-primary' : ''}`}
              onClick={() => setTab('bookmarks')}>
              书签（{bookmarks().length}）
            </button>
            <button class={`border-0 bg-transparent rounded-none px-[14px] py-2 ${tab() === 'add' ? 'border-b-2 border-primary text-primary' : ''}`}
              onClick={() => setTab('add')}>
              追加章节
            </button>
          </div>

          <Show when={tab() === 'bookmarks'}>
            <div class="border border-line rounded-[6px] overflow-hidden">
              <For each={bookmarks()}>
                {(bm) => (
                  <div class="flex items-start gap-3 px-3 py-2.5 border-b border-line last:border-b-0">
                    <button class="link p-0 flex-1 min-w-0 text-left" title="跳转到阅读器对应位置"
                      onClick={() => jumpBookmark(bm)}>
                      <div class="text-[14px] text-text line-clamp-2 break-all underline decoration-[#f59e0b] decoration-2 underline-offset-4">
                        {bm.text}
                      </div>
                      <div class="text-muted text-[12px] mt-1 truncate">
                        {bmChapterTitle(bm.cid)} · {new Date(bm.created_at * 1000).toLocaleString()}
                      </div>
                    </button>
                    <button class="small danger shrink-0" disabled={busy()}
                      onClick={() => act(() => api.removeBookmark(bookId, bm.id), '书签已删除')}>
                      删除
                    </button>
                  </div>
                )}
              </For>
              <Show when={!bookmarks().length}>
                <p class="text-muted text-center py-[30px]">书签为空，在阅读器中选中文本即可添加。</p>
              </Show>
            </div>
          </Show>

          <Show when={tab() === 'chapters'}>
            <div class="flex gap-2.5 mb-2.5 items-center">
              <input class="w-[280px] px-2.5 py-[7px] border border-line rounded-[6px] text-[14px]"
                placeholder="搜索章节（原标题 / 译后标题）"
                value={chapterQuery()} onInput={(e) => setChapterQuery(e.currentTarget.value)} />
              <Show when={chapterQuery().trim() || statusFilter().size > 0}>
                <span class="text-muted text-[13px]">
                  匹配 {filteredChapters().length} / {b().chapters.length} 章
                </span>
                <button class="small" onClick={() => { setChapterQuery(''); setStatusFilter(new Set<string>()) }}>
                  清除
                </button>
              </Show>
            </div>
            <div class="overflow-x-auto">
              <table class="table-fixed" style={{
                width: b().no_translate
                  ? `${colW().idx + colW().title}px`
                  : `${colW().idx + colW().title + STATUS_COL_W + colW().ops}px`,
                'min-width': '100%',
              }}>
                <colgroup>
                  <col style={{ width: `${colW().idx}px` }} />
                  <col style={{ width: `${colW().title}px` }} />
                  <Show when={!b().no_translate}>
                    <col style={{ width: `${STATUS_COL_W}px` }} />
                    <col style={{ width: `${colW().ops}px` }} />
                  </Show>
                </colgroup>
                <thead>
                  <tr>
                    <th class="relative">#{colResizer('idx', 40)}</th>
                    <th class="relative">{b().no_translate ? '标题' : '标题（译名 / 原名）'}{colResizer('title', 160)}</th>
                    <Show when={!b().no_translate}>
                      <th class="whitespace-nowrap">
                        <div ref={statusMenuRef} class="inline-block">
                          <button type="button"
                            class={`border-0 bg-transparent p-0 font-bold cursor-pointer inline-flex items-center gap-[3px] ${statusFilter().size > 0 ? 'text-primary' : 'text-inherit'}`}
                            title="按状态筛选"
                            onClick={toggleStatusMenu}>
                            状态
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
                              class={`transition-transform ${statusMenuOpen() ? 'rotate-180' : ''}`}>
                              <path d="M12 16l-6-6h12z" />
                            </svg>
                          </button>
                          <Show when={statusMenuOpen()}>
                            {/* fixed 定位，避免被 overflow-x-auto 的表格外层裁剪 */}
                            <div class="fixed z-20 bg-card border border-line rounded-[6px] shadow-lg py-1 min-w-[130px] font-normal text-left"
                              style={{ top: `${statusMenuPos().top}px`, left: `${statusMenuPos().left}px` }}>
                              <For each={['pending', 'translating', 'done']}>
                                {(s) => (
                                  <label class="flex items-center gap-2 px-3 py-[6px] cursor-pointer text-[13px] hover:bg-[#f3f4f6]">
                                    <input type="checkbox" checked={statusFilter().has(s)}
                                      onChange={() => toggleStatusFilter(s)} />
                                    {CH_STATUS[s]}（{statusCount(s)}）
                                  </label>
                                )}
                              </For>
                              <Show when={statusFilter().size > 0}>
                                <button type="button"
                                  class="border-0 bg-transparent w-full text-left px-3 py-[6px] text-[13px] text-muted hover:bg-[#f3f4f6] cursor-pointer"
                                  onClick={() => setStatusFilter(new Set<string>())}>
                                  清除筛选
                                </button>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      </th>
                      <th class="relative">{colResizer('ops', 72)}</th>
                    </Show>
                  </tr>
                </thead>
                <tbody>
                  <For each={filteredChapters()}>
                    {({ c, n }) => (
                      <tr>
                        <td class="truncate">{n}</td>
                        <td class="overflow-hidden">
                          <button class="link p-0 block w-full truncate text-left text-[14px]"
                            title={c.title_translated ? '阅读译文' : '阅读原文'}
                            onClick={() => navigate(`/books/${b().id}/read/${c.id}`)}>
                            {c.title_translated || c.title}
                          </button>
                          <Show when={c.title_translated && c.title_translated !== c.title}>
                            <button class="link p-0 block w-full truncate text-left text-[12px] text-muted"
                              title="预览原文"
                              onClick={() => openPreview(c, false)}>
                              {c.title}
                            </button>
                          </Show>
                        </td>
                        <Show when={!b().no_translate}>
                          <td class="whitespace-nowrap overflow-hidden">
                            <span class={`${BADGE_BASE} whitespace-nowrap ${STATUS_BADGE[c.status] ?? 'bg-[#eef0f3] text-muted'}`}>
                              {CH_STATUS[c.status] || c.status}
                            </span>
                            <Show when={c.error}>
                              <div class="text-danger text-[12px] truncate" title={c.error ?? undefined}>{c.error}</div>
                            </Show>
                          </td>
                          <td>
                            <button class="small whitespace-nowrap" disabled={busy() || b().running}
                              onClick={() => act(() => api.retranslateChapter(b().id, c.id))}>
                              {c.status === 'done' ? '重译' : '翻译'}
                            </button>
                          </td>
                        </Show>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <Show when={filteredChapters().length === 0}>
              <p class="text-muted text-center py-[30px]">没有匹配的章节。</p>
            </Show>
          </Show>

          <Show when={tab() === 'glossary'}>
            <div class="flex gap-2.5 my-4 items-center">
              <button onClick={addTerm}>+ 添加词条</button>
              <button class="primary" disabled={!glossaryDirty() || busy()} onClick={saveGlossary}>
                保存术语表
              </button>
              <button disabled={glossary().length === 0} onClick={copyGlossary}>复制术语表</button>
            </div>
            <table>
              <thead>
                <tr><th>原文</th><th>译名</th><th>类型</th><th>备注</th><th></th></tr>
              </thead>
              <tbody>
                <For each={glossary()}>
                  {(t, i) => (
                    <tr>
                      <td><input class="w-full px-2 py-[5px] border border-line rounded-[4px] text-[14px]"
                        value={t.src} onInput={(e) => setTerm(i(), 'src', e.currentTarget.value)} /></td>
                      <td><input class="w-full px-2 py-[5px] border border-line rounded-[4px] text-[14px]"
                        value={t.dst} onInput={(e) => setTerm(i(), 'dst', e.currentTarget.value)} /></td>
                      <td>
                        <select class="w-full px-2 py-[5px] border border-line rounded-[4px] text-[14px]"
                          value={t.type} onChange={(e) => setTerm(i(), 'type', e.currentTarget.value)}>
                          <option>人名</option><option>地名</option><option>组织</option><option>术语</option>
                        </select>
                      </td>
                      <td><input class="w-full px-2 py-[5px] border border-line rounded-[4px] text-[14px]"
                        placeholder="可选，如：女，主角的妹妹"
                        value={t.note || ''} onInput={(e) => setTerm(i(), 'note', e.currentTarget.value)} /></td>
                      <td><button class="danger small" onClick={() => delTerm(i())}>删</button></td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <Show when={glossary().length === 0}>
              <p class="text-muted text-center py-[30px]">术语表为空，可点击"生成术语表"自动抽取，或手动添加。</p>
            </Show>
          </Show>

          <Show when={tab() === 'add'}>
            <div>
              <h3 class="text-[15px] font-bold mt-[18px] mb-2">上传文件追加</h3>
              <label class={`inline-block px-4 py-2 border border-dashed border-primary rounded-[6px] text-primary cursor-pointer bg-[#eff6ff] ${busy() ? 'opacity-50' : ''}`}>
                选择 .txt / .epub 文件（解析后勾选要追加的章节）
                <input type="file" accept=".epub,.txt" hidden disabled={busy()} onChange={onAddFile} />
              </label>
              <h3 class="text-[15px] font-bold mt-[18px] mb-2">粘贴文本追加</h3>
              <input class="w-full px-2.5 py-2 border border-line rounded-[6px] text-[14px] mt-2"
                placeholder="章节名称（必填）"
                value={addTitle()} onInput={(e) => setAddTitle(e.currentTarget.value)} />
              <textarea rows="10" placeholder="章节正文（必填）"
                class="w-full p-2.5 border border-line rounded-[6px] text-[14px] my-2 font-[inherit] resize-y"
                value={addBody()} onInput={(e) => setAddBody(e.currentTarget.value)} />
              <button class="primary" disabled={busy() || !addTitle().trim() || !addBody().trim()}
                onClick={onAddText}>
                添加为章节
              </button>
            </div>
          </Show>

          <Show when={queueOpen()}>
            <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-10"
              onClick={() => setQueueOpen(false)}>
              <div class="bg-card rounded-[10px] p-[22px] max-w-[92vw] w-[440px]"
                onClick={(e) => e.stopPropagation()}>
                <h2 class="mb-3.5 text-[18px] font-bold">排队翻译</h2>
                <div class="flex flex-col gap-2 mb-4">
                  <label class="flex items-center gap-2 cursor-pointer text-[14px]">
                    <input type="radio" name="qmode" checked={!qOverwrite()}
                      onChange={() => setQOverwrite(false)} />
                    常规翻译（范围内已翻译的章节跳过，只翻译未翻译的）
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer text-[14px]">
                    <input type="radio" name="qmode" checked={qOverwrite()}
                      onChange={() => setQOverwrite(true)} />
                    重翻（范围内章节全部重新翻译，不管是否已翻译）
                  </label>
                </div>
                <div class="flex items-center gap-2 mb-4 text-[14px]">
                  <span>从第</span>
                  <input type="number" min="1" max={b().chapters.length}
                    class="w-[76px] px-2.5 py-[7px] border border-line rounded-[6px] text-[14px]"
                    value={qFrom()} onInput={(e) => setQFrom(e.currentTarget.value)} />
                  <span>章到第</span>
                  <input type="number" min="1" max={b().chapters.length}
                    class="w-[76px] px-2.5 py-[7px] border border-line rounded-[6px] text-[14px]"
                    value={qTo()} onInput={(e) => setQTo(e.currentTarget.value)} />
                  <span>章（共 {b().chapters.length} 章）</span>
                </div>
                <div class="flex justify-end gap-2.5">
                  <button onClick={() => setQueueOpen(false)}>取消</button>
                  <button class="primary" disabled={busy() || b().chapters.length === 0}
                    onClick={confirmQueue}>
                    加入队列
                  </button>
                </div>
              </div>
            </div>
          </Show>

          <Show when={appendPrev()}>
            {(ap) => (
              <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-10"
                onClick={() => setAppendPrev(null)}>
                <div class="bg-card rounded-[10px] p-[22px] max-w-[92vw] w-[640px] max-h-[84vh] flex flex-col"
                  onClick={(e) => e.stopPropagation()}>
                  <h2 class="mb-3.5 text-[18px] font-bold">确认追加章节</h2>
                  <p class="text-muted text-[13px] m-0 mb-1">
                    {ap().filename} 解析出 {ap().chapters.length} 章，本书已有 {ap().existing} 章。
                    与已有章节重复的不默认勾选。
                  </p>
                  <div class="flex gap-2.5 my-4 items-center">
                    <button class="small" onClick={() => setAllAppend(true)}>全选</button>
                    <button class="small" onClick={() => setAllAppend(false)}>全不选</button>
                  </div>
                  <div class="overflow-y-auto flex-1 border border-line rounded-[6px]">
                    <For each={ap().chapters}>
                      {(c, i) => (
                        <label class="flex gap-2.5 items-start px-2.5 py-2 border-b border-line cursor-pointer text-[14px] text-text last:border-b-0">
                          <input type="checkbox" class="mt-[3px]" checked={c.checked}
                            onChange={(e) => toggleAppend(i(), e.currentTarget.checked)} />
                          <div class="flex-1 min-w-0">
                            <div>
                              <span class="font-medium mr-1.5 break-all">{c.title}</span>
                              <span class={`${BADGE} mr-1`}>{c.format}</span>
                              <span class={`${BADGE} mr-1`}>{c.chars} 字</span>
                              <Show when={c.duplicate}>
                                <span class={`${BADGE_BASE} mr-1 ${STATUS_BADGE.error}`}>与已有章节重复</span>
                              </Show>
                            </div>
                            <Show when={c.snippet}>
                              <div class="text-muted text-[12px] mt-[3px] truncate">{c.snippet}</div>
                            </Show>
                          </div>
                        </label>
                      )}
                    </For>
                  </div>
                  <div class="flex justify-end gap-2.5 mt-2">
                    <button onClick={() => setAppendPrev(null)}>取消</button>
                    <button class="primary"
                      disabled={busy() || !ap().chapters.some(c => c.checked)}
                      onClick={confirmAppend}>
                      追加选中的 {ap().chapters.filter(c => c.checked).length} 章
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Show>

          <Show when={preview()}>
            {(p) => (
              <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-10"
                onClick={() => setPreview(null)}>
                <div class="bg-card rounded-[10px] p-[22px] max-w-[92vw] w-[760px] max-h-[84vh] flex flex-col"
                  onClick={(e) => e.stopPropagation()}>
                  <div class="flex justify-between items-start gap-3">
                    <h2 class="mb-3 text-[17px] font-bold break-all">{p().title}</h2>
                    <button class="small" onClick={() => setPreview(null)}>关闭</button>
                  </div>
                  <div class="overflow-auto flex-1">
                    <Show when={!p().loading} fallback={<p class="text-muted text-center py-[30px]">加载中…</p>}>
                      <Show when={!p().error} fallback={<p class="text-danger text-[13px]">{p().error}</p>}>
                        <Show when={p().format === 'epub'}
                          fallback={<pre class="m-0 whitespace-pre-wrap break-words font-[inherit] text-[14px] leading-[1.7]">{p().content}</pre>}>
                          <div class="preview-html text-[14px] leading-[1.7]" innerHTML={p().content} />
                        </Show>
                      </Show>
                    </Show>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}
