import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
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

export default function BookList() {
  const navigate = useNavigate()
  const openBook = (id: string) => navigate(`/books/${id}`)
  const [books, setBooks] = createSignal<BookSummary[]>([])
  const [query, setQuery] = createSignal('')
  const [uploading, setUploading] = createSignal(false)
  const [error, setError] = createSignal('')

  // 模糊匹配：查询串的字符按顺序出现在目标中即匹配（大小写/空白不敏感），
  // 返回分数用于排序（连续匹配、起始位置靠前得分更高），不匹配返回 null
  const fuzzyScore = (text: string, query: string): number | null => {
    const t = text.toLowerCase()
    const q = query.toLowerCase().trim()
    if (!q) return 0
    if (t.includes(q)) return 1000 - t.indexOf(q)
    let score = 0, ti = 0, streak = 0
    for (const ch of q) {
      const found = t.indexOf(ch, ti)
      if (found === -1) return null
      streak = found === ti ? streak + 1 : 0
      score += 10 + streak * 5 - (found - ti)
      ti = found + 1
    }
    return score
  }

  const filtered = createMemo(() => {
    const q = query()
    if (!q.trim()) return books()
    return books()
      .map((b) => {
        const s = Math.max(
          fuzzyScore(b.title_translated || '', q) ?? -1,
          fuzzyScore(b.title, q) ?? -1,
          fuzzyScore(b.author, q) ?? -1,
        )
        return { b, s }
      })
      .filter((x) => x.s >= 0)
      .sort((x, y) => y.s - x.s)
      .map((x) => x.b)
  })

  const refresh = async () => {
    try { setBooks(await api.books()) } catch (e: any) { setError(String(e.message || e)) }
  }
  onMount(refresh)
  // 有书在生成术语表/翻译中时轮询刷新状态，避免徽章停留在"生成术语表中"
  const timer = setInterval(() => {
    if (books().some(b => b.status === 'glossary' || b.status === 'translating')) refresh()
  }, 3000)
  onCleanup(() => clearInterval(timer))

  const onUpload = async (e: { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0]
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const book = await api.upload(file)
      openBook(book.id)
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
        <input
          class="ml-auto px-3 py-2 border border-line rounded-[6px] bg-card text-[14px] w-[220px] outline-none focus:border-primary"
          type="search"
          placeholder="搜索书名 / 作者…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      {error() && <p class="text-danger text-[13px]">{error()}</p>}
      <Show when={books().length === 0}>
        <p class="text-muted text-center py-[30px]">还没有书籍，点击上方按钮上传。</p>
      </Show>
      <Show when={books().length > 0 && filtered().length === 0}>
        <p class="text-muted text-center py-[30px]">没有匹配「{query()}」的书籍。</p>
      </Show>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
        <For each={filtered()}>
          {(b) => (
            <div class="bg-card border border-line rounded-[10px] p-3.5 cursor-pointer hover:border-primary"
              onClick={() => openBook(b.id)}>
              <div class="font-semibold mb-1 break-all">{b.title_translated || b.title}</div>
              <Show when={b.title_translated && b.title_translated !== b.title}>
                <div class="text-muted text-[13px]">{b.title}</div>
              </Show>
              <div class="flex gap-1.5 flex-wrap my-2">
                <span class={BADGE}>{b.format}</span>
                <Show when={b.no_translate}>
                  <span class={`${BADGE_BASE} bg-[#fef3c7] text-[#92400e]`}>无需翻译</span>
                </Show>
                <Show when={!b.no_translate}>
                  <span class={`${BADGE_BASE} ${STATUS_BADGE[b.status] ?? 'bg-[#eef0f3] text-muted'}`}>
                    {STATUS_TEXT[b.status] || b.status}
                  </span>
                </Show>
                <span class={BADGE}>{b.no_translate ? `${b.chapters} 章` : `${b.done}/${b.chapters} 章`}</span>
                <Show when={!b.no_translate && b.glossary_count > 0}>
                  <span class={BADGE}>术语 {b.glossary_count}</span>
                </Show>
              </div>
              <Show when={!b.no_translate}>
                <div class="h-1.5 bg-[#e5e7eb] rounded-[3px] overflow-hidden my-2">
                  <div class="h-full bg-primary transition-[width] duration-[0.4s]"
                    style={{ width: `${b.chapters ? (b.done / b.chapters) * 100 : 0}%` }} />
                </div>
              </Show>
              <button class="danger small" onClick={(e) => remove(e, b.id)}>删除</button>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
