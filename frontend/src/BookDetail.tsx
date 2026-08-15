import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { api } from './api'
import type { Book, Chapter, ChapterPreview, GlossaryTerm } from './types'

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

export default function BookDetail(props: { id: string; onBack: () => void }) {
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

  // 章节搜索：按原标题/译后标题过滤（不区分大小写），保留原序号
  const filteredChapters = () =>
    (book()?.chapters || [])
      .map((c, i) => ({ c, n: i + 1 }))
      .filter(({ c }) => {
        const q = chapterQuery().trim().toLowerCase()
        if (!q) return true
        return c.title.toLowerCase().includes(q) || (c.title_translated || '').toLowerCase().includes(q)
      })

  // ---- 章节内容预览（原文/译文）----
  const openPreview = async (c: Chapter, translated: boolean) => {
    setPreview({
      title: translated ? (c.title_translated || c.title) : c.title,
      format: c.format, loading: true, content: '', error: '',
    })
    try {
      const content = await api.chapterContent(props.id, c.id, translated)
      setPreview(p => (p ? { ...p, loading: false, content } : p))
    } catch (e: any) {
      setPreview(p => (p ? { ...p, loading: false, error: String(e.message || e) } : p))
    }
  }

  const refresh = async () => {
    try {
      const prev = book()?.status
      const b = await api.book(props.id)
      setBook(b)
      // 术语表生成完毕（状态从 glossary 变回 ready），更新提示
      if (prev === 'glossary' && b.status === 'ready') setMsg('术语表已生成')
      if (!glossaryDirty()) setGlossary((b.glossary || []).map(t => ({ ...t })))
    } catch (e: any) { setError(String(e.message || e)) }
  }

  let timer: ReturnType<typeof setInterval>
  onMount(() => {
    refresh()
    timer = setInterval(() => {
      const b = book()
      if (b && (b.running || b.status === 'translating' || b.status === 'glossary')) refresh()
    }, 2000)
  })
  onCleanup(() => clearInterval(timer))

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
  const addTerm = () => { setGlossary([...glossary(), { src: '', dst: '', type: '术语' }]); setGlossaryDirty(true) }
  const delTerm = (i: number) => { setGlossary(glossary().filter((_, n) => n !== i)); setGlossaryDirty(true) }
  const saveGlossary = () => act(
    () => api.saveGlossary(props.id, glossary()),
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
      const res = await api.previewChapters(props.id, file)
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
    act(() => api.addChapters(props.id, selected), `已追加 ${selected.length} 章`)
      .then(() => setAppendPrev(null))
  }
  const onAddText = () => {
    const title = addTitle().trim()
    const body = addBody().trim()
    if (!title || !body) return
    act(() => api.addChapters(props.id, [{ title, body: addBody(), format: 'txt' }]), '章节已添加')
      .then(() => { setAddTitle(''); setAddBody('') })
  }

  const doneCount = () => (book()?.chapters || []).filter(c => c.status === 'done').length

  return (
    <Show when={book()} fallback={<p>加载中…</p>}>
      {(b) => (
        <div>
          <button class="link" onClick={props.onBack}>← 返回列表</button>
          <div>
            <div class="flex items-center gap-2 mt-3 mb-1">
              <h2 class="text-[1.5em] font-bold m-0">{b().title_translated || b().title}</h2>
              <button class="link p-0 inline-flex items-center" title="重翻书名"
                disabled={busy() || b().running}
                onClick={() => act(() => api.retranslateTitle(b().id), '正在重翻书名…')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
              </button>
            </div>
            <Show when={b().title_translated && b().title_translated !== b().title}>
              <p class="text-muted text-[13px] m-0">原名：{b().title}</p>
            </Show>
            <div class="flex gap-1.5 flex-wrap my-2">
              <span class={BADGE}>{b().format}</span>
              <span class={BADGE}>{doneCount()}/{b().chapters.length} 章</span>
              <span class={BADGE}>状态：{b().status}{b().running ? '（运行中）' : ''}</span>
            </div>
            <div class="h-2.5 bg-[#e5e7eb] rounded-[3px] overflow-hidden my-2">
              <div class="h-full bg-primary transition-[width] duration-[0.4s]"
                style={{ width: `${b().chapters.length ? (doneCount() / b().chapters.length) * 100 : 0}%` }} />
            </div>
          </div>

          <div class="flex gap-2.5 my-4 items-center flex-wrap">
            <button class="primary" disabled={busy() || b().running}
              onClick={() => act(() => api.translate(b().id))}>
              {doneCount() > 0 ? '继续翻译未完成章节' : '开始翻译'}
            </button>
            <button disabled={busy() || b().running}
              onClick={() => act(() => api.translate(b().id, { overwrite: true }))}>
              全部重译
            </button>
            <button disabled={!b().running} onClick={() => act(() => api.stop(b().id))}>停止</button>
            <button disabled={busy() || b().running}
              onClick={() => act(() => api.generateGlossary(b().id), '正在生成术语表…')}>
              生成术语表
            </button>
            <button disabled={busy() || b().running}
              onClick={() => act(() => api.retranslateToc(b().id), '正在重翻目录…')}>
              重翻目录
            </button>
            <a class="inline-block px-[14px] py-[7px] border border-line rounded-[6px] bg-card text-text text-[14px] no-underline hover:border-primary hover:text-primary"
              href={api.exportUrl(b().id, 'txt')} download="">导出 TXT</a>
            <a class="inline-block px-[14px] py-[7px] border border-line rounded-[6px] bg-card text-text text-[14px] no-underline hover:border-primary hover:text-primary"
              href={api.exportUrl(b().id, 'epub')} download="">导出 EPUB</a>
          </div>
          {error() && <p class="text-danger text-[13px]">{error()}</p>}
          {msg() && <p class="text-[#166534] text-[13px]">{msg()}</p>}
          {b().error && <p class="text-danger text-[13px]">{b().error}</p>}

          <div class="flex gap-1 border-b border-line mt-[18px] mb-3">
            <button class={`border-0 bg-transparent rounded-none px-[14px] py-2 ${tab() === 'chapters' ? 'border-b-2 border-primary text-primary' : ''}`}
              onClick={() => setTab('chapters')}>
              章节（{b().chapters.length}）
            </button>
            <button class={`border-0 bg-transparent rounded-none px-[14px] py-2 ${tab() === 'glossary' ? 'border-b-2 border-primary text-primary' : ''}`}
              onClick={() => setTab('glossary')}>
              术语表（{glossary().length}）{glossaryDirty() ? ' *' : ''}
            </button>
            <button class={`border-0 bg-transparent rounded-none px-[14px] py-2 ${tab() === 'add' ? 'border-b-2 border-primary text-primary' : ''}`}
              onClick={() => setTab('add')}>
              追加章节
            </button>
          </div>

          <Show when={tab() === 'chapters'}>
            <div class="flex gap-2.5 mb-2.5 items-center">
              <input class="w-[280px] px-2.5 py-[7px] border border-line rounded-[6px] text-[14px]"
                placeholder="搜索章节（原标题 / 译后标题）"
                value={chapterQuery()} onInput={(e) => setChapterQuery(e.currentTarget.value)} />
              <Show when={chapterQuery().trim()}>
                <span class="text-muted text-[13px]">
                  匹配 {filteredChapters().length} / {b().chapters.length} 章
                </span>
                <button class="small" onClick={() => setChapterQuery('')}>清除</button>
              </Show>
            </div>
            <table>
              <thead>
                <tr><th>#</th><th>原标题</th><th>译后标题</th><th>状态</th><th></th></tr>
              </thead>
              <tbody>
                <For each={filteredChapters()}>
                  {({ c, n }) => (
                    <tr>
                      <td>{n}</td>
                      <td>
                        <button class="link p-0 text-left text-[14px]" title="预览原文"
                          onClick={() => openPreview(c, false)}>{c.title}</button>
                      </td>
                      <td>
                        <Show when={c.title_translated} fallback="—">
                          <button class="link p-0 text-left text-[14px]" title="预览译文"
                            onClick={() => openPreview(c, true)}>{c.title_translated}</button>
                        </Show>
                      </td>
                      <td>
                        <span class={`${BADGE_BASE} ${STATUS_BADGE[c.status] ?? 'bg-[#eef0f3] text-muted'}`}>
                          {CH_STATUS[c.status] || c.status}
                        </span>
                        <Show when={c.error}><div class="text-danger text-[12px]">{c.error}</div></Show>
                      </td>
                      <td>
                        <button class="small" disabled={busy() || b().running}
                          onClick={() => act(() => api.retranslateChapter(b().id, c.id))}>
                          {c.status === 'done' ? '重译' : '翻译'}
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
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
                <tr><th>原文</th><th>译名</th><th>类型</th><th></th></tr>
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
