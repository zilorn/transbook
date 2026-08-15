import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { api } from './api'

const CH_STATUS = { pending: '待翻译', translating: '翻译中', done: '已完成', error: '失败' }

export default function BookDetail(props) {
  const [book, setBook] = createSignal(null)
  const [error, setError] = createSignal('')
  const [msg, setMsg] = createSignal('')
  const [glossary, setGlossary] = createSignal([])
  const [glossaryDirty, setGlossaryDirty] = createSignal(false)
  const [tab, setTab] = createSignal('chapters')
  const [addTitle, setAddTitle] = createSignal('')
  const [addBody, setAddBody] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [preview, setPreview] = createSignal(null)
  const [appendPrev, setAppendPrev] = createSignal(null)

  // ---- 章节内容预览（原文/译文）----
  const openPreview = async (c, translated) => {
    setPreview({
      title: translated ? (c.title_translated || c.title) : c.title,
      format: c.format, loading: true, content: '', error: '',
    })
    try {
      const content = await api.chapterContent(props.id, c.id, translated)
      setPreview(p => (p ? { ...p, loading: false, content } : p))
    } catch (e) {
      setPreview(p => (p ? { ...p, loading: false, error: String(e.message || e) } : p))
    }
  }

  const refresh = async () => {
    try {
      const b = await api.book(props.id)
      setBook(b)
      if (!glossaryDirty()) setGlossary((b.glossary || []).map(t => ({ ...t })))
    } catch (e) { setError(String(e.message || e)) }
  }

  let timer
  onMount(() => {
    refresh()
    timer = setInterval(() => {
      const b = book()
      if (b && (b.running || b.status === 'translating' || b.status === 'glossary')) refresh()
    }, 2000)
  })
  onCleanup(() => clearInterval(timer))

  const act = async (fn, okMsg = '') => {
    setBusy(true)
    setError('')
    setMsg('')
    try {
      await fn()
      if (okMsg) setMsg(okMsg)
      await refresh()
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  // ---- 术语表编辑 ----
  const setTerm = (i, k, v) => {
    const g = glossary().slice()
    g[i] = { ...g[i], [k]: v }
    setGlossary(g)
    setGlossaryDirty(true)
  }
  const addTerm = () => { setGlossary([...glossary(), { src: '', dst: '', type: '术语' }]); setGlossaryDirty(true) }
  const delTerm = (i) => { setGlossary(glossary().filter((_, n) => n !== i)); setGlossaryDirty(true) }
  const saveGlossary = () => act(
    () => api.saveGlossary(props.id, glossary()),
    '术语表已保存'
  ).then(() => setGlossaryDirty(false))

  // ---- 追加章节 ----
  const onAddFile = async (e) => {
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
    } catch (err) {
      setError(String(err.message || err))
    } finally {
      setBusy(false)
    }
  }
  const toggleAppend = (i, checked) => {
    setAppendPrev(p => p && ({
      ...p,
      chapters: p.chapters.map((c, n) => (n === i ? { ...c, checked } : c)),
    }))
  }
  const setAllAppend = (checked) => {
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
          <div class="book-head">
            <h2>{b().title_translated || b().title}</h2>
            <Show when={b().title_translated && b().title_translated !== b().title}>
              <p class="book-sub">原名：{b().title}</p>
            </Show>
            <div class="book-meta">
              <span class="badge">{b().format}</span>
              <span class="badge">{doneCount()}/{b().chapters.length} 章</span>
              <span class="badge">状态：{b().status}{b().running ? '（运行中）' : ''}</span>
            </div>
            <div class="progress big">
              <div class="progress-bar"
                style={{ width: `${b().chapters.length ? (doneCount() / b().chapters.length) * 100 : 0}%` }} />
            </div>
          </div>

          <div class="toolbar wrap">
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
            <a class="btn" href={api.exportUrl(b().id, 'txt')} download>导出 TXT</a>
            <a class="btn" href={api.exportUrl(b().id, 'epub')} download>导出 EPUB</a>
          </div>
          {error() && <p class="error">{error()}</p>}
          {msg() && <p class="ok-msg">{msg()}</p>}
          {b().error && <p class="error">{b().error}</p>}

          <div class="tabs">
            <button class={tab() === 'chapters' ? 'active' : ''} onClick={() => setTab('chapters')}>
              章节（{b().chapters.length}）
            </button>
            <button class={tab() === 'glossary' ? 'active' : ''} onClick={() => setTab('glossary')}>
              术语表（{glossary().length}）{glossaryDirty() ? ' *' : ''}
            </button>
            <button class={tab() === 'add' ? 'active' : ''} onClick={() => setTab('add')}>
              追加章节
            </button>
          </div>

          <Show when={tab() === 'chapters'}>
            <table class="chapters">
              <thead>
                <tr><th>#</th><th>原标题</th><th>译后标题</th><th>状态</th><th></th></tr>
              </thead>
              <tbody>
                <For each={b().chapters}>
                  {(c, i) => (
                    <tr>
                      <td>{i() + 1}</td>
                      <td>
                        <button class="link ch-title" title="预览原文"
                          onClick={() => openPreview(c, false)}>{c.title}</button>
                      </td>
                      <td>
                        <Show when={c.title_translated} fallback="—">
                          <button class="link ch-title" title="预览译文"
                            onClick={() => openPreview(c, true)}>{c.title_translated}</button>
                        </Show>
                      </td>
                      <td>
                        <span class={`badge st-${c.status}`}>{CH_STATUS[c.status] || c.status}</span>
                        <Show when={c.error}><div class="error small-text">{c.error}</div></Show>
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
          </Show>

          <Show when={tab() === 'glossary'}>
            <div class="toolbar">
              <button onClick={addTerm}>+ 添加词条</button>
              <button class="primary" disabled={!glossaryDirty() || busy()} onClick={saveGlossary}>
                保存术语表
              </button>
            </div>
            <table class="glossary">
              <thead>
                <tr><th>原文</th><th>译名</th><th>类型</th><th></th></tr>
              </thead>
              <tbody>
                <For each={glossary()}>
                  {(t, i) => (
                    <tr>
                      <td><input value={t.src} onInput={(e) => setTerm(i(), 'src', e.currentTarget.value)} /></td>
                      <td><input value={t.dst} onInput={(e) => setTerm(i(), 'dst', e.currentTarget.value)} /></td>
                      <td>
                        <select value={t.type} onChange={(e) => setTerm(i(), 'type', e.currentTarget.value)}>
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
              <p class="empty">术语表为空，可点击"生成术语表"自动抽取，或手动添加。</p>
            </Show>
          </Show>

          <Show when={tab() === 'add'}>
            <div class="add-chapters">
              <h3>上传文件追加</h3>
              <label class={`upload-btn ${busy() ? 'disabled' : ''}`}>
                选择 .txt / .epub 文件（解析后勾选要追加的章节）
                <input type="file" accept=".epub,.txt" hidden disabled={busy()} onChange={onAddFile} />
              </label>
              <h3>粘贴文本追加</h3>
              <input class="add-title" placeholder="章节名称（必填）"
                value={addTitle()} onInput={(e) => setAddTitle(e.currentTarget.value)} />
              <textarea rows="10" placeholder="章节正文（必填）"
                value={addBody()} onInput={(e) => setAddBody(e.currentTarget.value)} />
              <button class="primary" disabled={busy() || !addTitle().trim() || !addBody().trim()}
                onClick={onAddText}>
                添加为章节
              </button>
            </div>
          </Show>

          <Show when={appendPrev()}>
            {(ap) => (
              <div class="modal-mask" onClick={() => setAppendPrev(null)}>
                <div class="modal append" onClick={(e) => e.stopPropagation()}>
                  <h2>确认追加章节</h2>
                  <p class="append-info">
                    {ap().filename} 解析出 {ap().chapters.length} 章，本书已有 {ap().existing} 章。
                    与已有章节重复的不默认勾选。
                  </p>
                  <div class="toolbar">
                    <button class="small" onClick={() => setAllAppend(true)}>全选</button>
                    <button class="small" onClick={() => setAllAppend(false)}>全不选</button>
                  </div>
                  <div class="append-list">
                    <For each={ap().chapters}>
                      {(c, i) => (
                        <label class="append-item">
                          <input type="checkbox" checked={c.checked}
                            onChange={(e) => toggleAppend(i(), e.currentTarget.checked)} />
                          <div class="append-item-main">
                            <div>
                              <span class="append-item-title">{c.title}</span>
                              <span class="badge">{c.format}</span>
                              <span class="badge">{c.chars} 字</span>
                              <Show when={c.duplicate}>
                                <span class="badge st-error">与已有章节重复</span>
                              </Show>
                            </div>
                            <Show when={c.snippet}>
                              <div class="snippet">{c.snippet}</div>
                            </Show>
                          </div>
                        </label>
                      )}
                    </For>
                  </div>
                  <div class="modal-actions">
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
              <div class="modal-mask" onClick={() => setPreview(null)}>
                <div class="modal preview" onClick={(e) => e.stopPropagation()}>
                  <div class="preview-head">
                    <h2>{p().title}</h2>
                    <button class="small" onClick={() => setPreview(null)}>关闭</button>
                  </div>
                  <div class="preview-body">
                    <Show when={!p().loading} fallback={<p class="empty">加载中…</p>}>
                      <Show when={!p().error} fallback={<p class="error">{p().error}</p>}>
                        <Show when={p().format === 'epub'} fallback={<pre>{p().content}</pre>}>
                          <div class="preview-html" innerHTML={p().content} />
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
