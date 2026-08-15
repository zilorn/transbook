import { createSignal, For, onMount, Show } from 'solid-js'
import { api } from './api'

const STATUS_TEXT = {
  ready: '待翻译', glossary: '生成术语表中', translating: '翻译中',
  paused: '已暂停', done: '已完成', error: '有错误',
}

export default function BookList(props) {
  const [books, setBooks] = createSignal([])
  const [uploading, setUploading] = createSignal(false)
  const [error, setError] = createSignal('')

  const refresh = async () => {
    try { setBooks(await api.books()) } catch (e) { setError(String(e.message || e)) }
  }
  onMount(refresh)

  const onUpload = async (e) => {
    const file = e.currentTarget.files?.[0]
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const book = await api.upload(file)
      props.onOpen(book.id)
    } catch (err) {
      setError(String(err.message || err))
    } finally {
      setUploading(false)
      e.currentTarget.value = ''
    }
  }

  const remove = async (e, id) => {
    e.stopPropagation()
    if (!confirm('确定删除这本书及其全部翻译数据？')) return
    await api.deleteBook(id)
    refresh()
  }

  return (
    <div>
      <div class="toolbar">
        <label class={`upload-btn ${uploading() ? 'disabled' : ''}`}>
          {uploading() ? '上传解析中…' : '上传书籍（.epub / .txt）'}
          <input type="file" accept=".epub,.txt" hidden disabled={uploading()}
            onChange={onUpload} />
        </label>
        <button onClick={refresh}>刷新</button>
      </div>
      {error() && <p class="error">{error()}</p>}
      <Show when={books().length === 0}>
        <p class="empty">还没有书籍，点击上方按钮上传。</p>
      </Show>
      <div class="book-grid">
        <For each={books()}>
          {(b) => (
            <div class="book-card" onClick={() => props.onOpen(b.id)}>
              <div class="book-title">{b.title_translated || b.title}</div>
              <Show when={b.title_translated && b.title_translated !== b.title}>
                <div class="book-sub">{b.title}</div>
              </Show>
              <div class="book-meta">
                <span class="badge">{b.format}</span>
                <span class={`badge st-${b.status}`}>{STATUS_TEXT[b.status] || b.status}</span>
                <span class="badge">{b.done}/{b.chapters} 章</span>
                <Show when={b.glossary_count > 0}>
                  <span class="badge">术语 {b.glossary_count}</span>
                </Show>
              </div>
              <div class="progress">
                <div class="progress-bar" style={{ width: `${b.chapters ? (b.done / b.chapters) * 100 : 0}%` }} />
              </div>
              <button class="danger small" onClick={(e) => remove(e, b.id)}>删除</button>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
