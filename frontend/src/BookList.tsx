import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { api } from './api'
import { IconTrash, IconX } from './icons'
import type { BookSummary, Group } from './types'

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

// 分组筛选 chips
const CHIP_BASE = 'px-3 py-1 rounded-full border text-[13px] cursor-pointer select-none'
const CHIP_ON = 'border-primary bg-[#eff6ff] text-primary'
const CHIP_OFF = 'border-line bg-card text-muted'

export default function BookList() {
  const navigate = useNavigate()
  const openBook = (id: string) => navigate(`/books/${id}`)
  const [books, setBooks] = createSignal<BookSummary[]>([])
  const [groups, setGroups] = createSignal<Group[]>([])
  // 当前分组筛选：'' = 全部，'none' = 未分组，其余为分组 id
  const [activeGroup, setActiveGroup] = createSignal('')
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

  const ungroupedCount = createMemo(() => books().filter((b) => !b.group_id).length)

  const filtered = createMemo(() => {
    const g = activeGroup()
    let list = books()
    if (g === 'none') list = list.filter((b) => !b.group_id)
    else if (g) list = list.filter((b) => b.group_id === g)
    const q = query()
    if (!q.trim()) return list
    return list
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
    try {
      const [bs, gs] = await Promise.all([api.books(), api.groups()])
      // 先分组后书籍：卡片分组下拉框的 value 只在行重建时应用一次（不跟踪 groups()），
      // 若后更新分组，下拉框的 option 会被整组重建，已选中的分组显示被重置回"未分组"
      setGroups(gs)
      setBooks(bs)
      // 当前选中的分组已被删除时回退到"全部"
      const g = activeGroup()
      if (g && g !== 'none' && !gs.some((x) => x.id === g)) setActiveGroup('')
    } catch (e: any) { setError(String(e.message || e)) }
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

  const addGroup = async () => {
    const name = prompt('分组名称：')?.trim()
    if (!name) return
    try {
      await api.createGroup(name)
      refresh()
    } catch (e: any) { setError(String(e.message || e)) }
  }

  const removeGroup = async (g: Group) => {
    if (!confirm(`删除分组「${g.name}」？组内书籍会移回未分组，不会被删除。`)) return
    await api.deleteGroup(g.id)
    refresh()
  }

  const assignGroup = async (id: string, groupId: string) => {
    try {
      await api.setBookGroup(id, groupId || null)
      refresh()
    } catch (e: any) { setError(String(e.message || e)) }
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
      <div class="flex gap-2 flex-wrap items-center mb-3.5">
        <button class={`${CHIP_BASE} ${activeGroup() === '' ? CHIP_ON : CHIP_OFF}`}
          onClick={() => setActiveGroup('')}>
          全部 {books().length}
        </button>
        <button class={`${CHIP_BASE} ${activeGroup() === 'none' ? CHIP_ON : CHIP_OFF}`}
          onClick={() => setActiveGroup('none')}>
          未分组 {ungroupedCount()}
        </button>
        <For each={groups()}>
          {(g) => (
            <button class={`${CHIP_BASE} inline-flex items-center gap-1.5 ${activeGroup() === g.id ? CHIP_ON : CHIP_OFF}`}
              onClick={() => setActiveGroup(g.id)}>
              {g.name} {g.count}
              <span
                class="opacity-50 hover:opacity-100 hover:text-danger px-0.5 inline-flex items-center"
                title="删除分组（书籍移回未分组）"
                onClick={(e) => { e.stopPropagation(); removeGroup(g) }}>
                <IconX class="w-[11px] h-[11px]" />
              </span>
            </button>
          )}
        </For>
        <button class={`${CHIP_BASE} ${CHIP_OFF}`} onClick={addGroup}>＋ 新建分组</button>
      </div>
      {error() && <p class="text-danger text-[13px]">{error()}</p>}
      <Show when={books().length === 0}>
        <p class="text-muted text-center py-[30px]">还没有书籍，点击上方按钮上传。</p>
      </Show>
      <Show when={books().length > 0 && filtered().length === 0}>
        <p class="text-muted text-center py-[30px]">
          {query().trim() ? `没有匹配「${query()}」的书籍。` : '该分组暂无书籍。'}
        </p>
      </Show>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
        <For each={filtered()}>
          {(b) => (
            <div class="bg-card border border-line rounded-[10px] p-3.5 cursor-pointer hover:border-primary"
              onClick={() => openBook(b.id)}>
              <div class="font-semibold mb-1 break-all">{b.title_translated || b.title}</div>
              <div class="text-muted text-[13px] mb-1 truncate" title={b.read_progress?.title || ''}>
                {b.read_progress
                  ? `读至 第${b.read_progress.index}章 ${b.read_progress.title}`
                  : '未阅读'}
              </div>
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
              <div class="flex items-center justify-between gap-2">
                <select
                  class="px-1.5 py-1 border border-line rounded-[6px] bg-card text-[12px] text-muted outline-none cursor-pointer max-w-[150px]"
                  value={b.group_id || ''}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => assignGroup(b.id, e.currentTarget.value)}>
                  <option value="">未分组</option>
                  <For each={groups()}>
                    {(g) => <option value={g.id}>{g.name}</option>}
                  </For>
                </select>
                <button class="danger small p-[6px] inline-flex items-center justify-center"
                  title="删除书籍及其全部翻译数据" onClick={(e) => remove(e, b.id)}><IconTrash /></button>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
