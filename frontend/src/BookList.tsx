import { createSignal, For, onMount, Show } from 'solid-js'
import { api } from './api'
import type { BookSummary } from './types'

const STATUS_TEXT: Record<string, string> = {
  ready: '待翻译', glossary: '生成术语表中', translating: '翻译中',
  paused: '已暂停', done: '已完成', error: '有错误',
}

// 原 .badge 基础样式与 .st-* 状态色
const BADGE_BASE = 'text-[12px] rounded-[4px] px-[7px] py-[2px]'
const BADGE = `${BADGE_BASE} bg-[#eef0f3] text-muted`
const STATUS_BADGE: Record<string, string> = {
  translating: 'bg-[#dbeafe] text-[#1d4ed8]',
  done: 'bg-[#dcfce7] text-[#166534]',
  error: 'bg-[#fee2e2] text-[#991b1b]',
}

export default function BookList(props: { onOpen: (id: string) => void }) {
  const [books, setBooks] = createSignal<BookSummary[]>([])
  const [uploading, setUploading] = createSignal(false)
  const [error, setError] = createSignal('')

  const refresh = async () => {
    try { setBooks(await api.books()) } catch (e: any) { setError(String(e.message || e)) }
  }
  onMount(refresh)

  const onUpload = async (e: { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0]
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const book = await api.upload(file)
      props.onOpen(book.id)
    } catch (err: any) {
      setError(String(err.message || err))
    } finally {
      setUploading(false)
      e.currentTarget.value = ''
    }
  }

  const remove = async (e: MouseEvent, id: string) => {
    e.stopPropagation()
    if (!confirm('确定删除这本书及其全部翻译数据？')) return
    await api.deleteBook(id)
    refresh()
  }

  return (
    <div>
      <div class="flex gap-2.5 my-4 items-center">
        <label class={`inline-block px-4 py-2 border border-dashed border-primary rounded-[6px] text-primary cursor-pointer bg-[#eff6ff] ${uploading() ? 'opacity-50' : ''}`}>
          {uploading() ? '上传解析中…' : '上传书籍（.epub / .txt）'}
          <input type="file" accept=".epub,.txt" hidden disabled={uploading()}
            onChange={onUpload} />
        </label>
        <button onClick={refresh}>刷新</button>
      </div>
      {error() && <p class="text-danger text-[13px]">{error()}</p>}
      <Show when={books().length === 0}>
        <p class="text-muted text-center py-[30px]">还没有书籍，点击上方按钮上传。</p>
      </Show>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
        <For each={books()}>
          {(b) => (
            <div class="bg-card border border-line rounded-[10px] p-3.5 cursor-pointer hover:border-primary"
              onClick={() => props.onOpen(b.id)}>
              <div class="font-semibold mb-1 break-all">{b.title_translated || b.title}</div>
              <Show when={b.title_translated && b.title_translated !== b.title}>
                <div class="text-muted text-[13px]">{b.title}</div>
              </Show>
              <div class="flex gap-1.5 flex-wrap my-2">
                <span class={BADGE}>{b.format}</span>
                <span class={`${BADGE_BASE} ${STATUS_BADGE[b.status] ?? 'bg-[#eef0f3] text-muted'}`}>
                  {STATUS_TEXT[b.status] || b.status}
                </span>
                <span class={BADGE}>{b.done}/{b.chapters} 章</span>
                <Show when={b.glossary_count > 0}>
                  <span class={BADGE}>术语 {b.glossary_count}</span>
                </Show>
              </div>
              <div class="h-1.5 bg-[#e5e7eb] rounded-[3px] overflow-hidden my-2">
                <div class="h-full bg-primary transition-[width] duration-[0.4s]"
                  style={{ width: `${b.chapters ? (b.done / b.chapters) * 100 : 0}%` }} />
              </div>
              <button class="danger small" onClick={(e) => remove(e, b.id)}>删除</button>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
