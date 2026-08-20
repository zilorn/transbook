import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { api } from './api'
import { config, loadConfig } from './state'
import { IconTrash, IconX } from './icons'
import type { ApiKeyEntry, QueueStatus, QueueStatusEntry } from './types'

const KEY_INPUT = 'px-2.5 py-[7px] border border-line rounded-[6px] text-[13px] bg-bg focus:border-primary focus:outline-none'

// 章节小方块状态色：灰=未开始 蓝=翻译中 绿=已完成 红=失败
const TILE: Record<string, string> = {
  pending: 'bg-[#d1d5db] text-[#4b5563]',
  translating: 'bg-[#3b82f6] text-white',
  done: 'bg-[#22c55e] text-white',
  error: 'bg-[#ef4444] text-white',
}
const BAR: Record<string, string> = {
  pending: 'bg-[#9ca3af]',
  translating: 'bg-[#3b82f6]',
  done: 'bg-[#22c55e]',
  error: 'bg-[#ef4444]',
}
const CH_STATUS: Record<string, string> = {
  pending: '待翻译', translating: '翻译中', done: '已完成', error: '失败',
}
const BOOK_STATUS: Record<string, string> = {
  ready: '待翻译', glossary: '生成术语表', translating: '翻译中',
  paused: '已暂停', done: '已完成', error: '出错',
}

export default function TranslatePage() {
  const navigate = useNavigate()
  const [status, setStatus] = createSignal<QueueStatus | null>(null)
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')

  // ---- API Keys 编辑 ----
  const [keys, setKeys] = createSignal<ApiKeyEntry[] | null>(null)
  const [keysSaving, setKeysSaving] = createSignal(false)
  const [keysMsg, setKeysMsg] = createSignal('')
  createEffect(() => {
    const c = config()
    if (c && !keys()) setKeys((c.api_keys || []).map(k => ({ ...k })))
  })
  const setKey = <K extends keyof ApiKeyEntry>(i: number, k: K, v: ApiKeyEntry[K]) => {
    const ks = keys()!.slice()
    ks[i] = { ...ks[i], [k]: v }
    setKeys(ks)
    setKeysMsg('')
  }
  const addKey = () => { setKeys([...keys()!, { key: '', model: '', concurrency: 0 }]); setKeysMsg('') }
  const delKey = (i: number) => { setKeys(keys()!.filter((_, n) => n !== i)); setKeysMsg('') }
  const saveKeys = async () => {
    const c = config()
    if (!c || !keys()) return
    setKeysSaving(true)
    setKeysMsg('')
    try {
      await api.saveConfig({
        ...c,
        api_keys: keys()!
          .filter(k => k.key.trim())
          .map(k => ({ ...k, key: k.key.trim(), concurrency: Number(k.concurrency) || 0 })),
      })
      await loadConfig()
      setKeysMsg('✓ 已保存')
    } catch (e: any) {
      setKeysMsg(String(e.message || e))
    } finally {
      setKeysSaving(false)
    }
  }

  const refresh = async () => {
    try {
      setStatus(await api.queueStatus())
      setError('')
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  let timer: ReturnType<typeof setInterval>
  onMount(() => {
    refresh()
    timer = setInterval(refresh, 2000)
  })
  onCleanup(() => clearInterval(timer))

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await refresh()
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const isOpen = (e: QueueStatusEntry) => expanded()[e.book_id] ?? e.running
  const toggle = (id: string, cur: boolean) => setExpanded({ ...expanded(), [id]: !cur })

  // 队列条目可能只含部分章节（按范围入队），过滤后展示并保留原章节序号
  const chaptersOf = (e: QueueStatusEntry) =>
    e.chapters.map((c, i) => ({ c, n: i + 1 }))
      .filter(({ c }) => !e.chapter_ids || e.chapter_ids.includes(c.id))
  const doneOf = (e: QueueStatusEntry) => chaptersOf(e).filter(({ c }) => c.status === 'done').length
  const runningOf = (e: QueueStatusEntry) => chaptersOf(e).filter(({ c }) => c.status === 'translating').length

  // 各 key 的有效并发数之和 = 当前总并发能力
  const totalConcurrency = () => {
    const cfg = config()
    if (!cfg) return 0
    return (cfg.api_keys || []).reduce((s, k) => s + (k.concurrency || cfg.concurrency), 0)
  }

  return (
    <div>
      {/* API Keys 配置 */}
      <div class="bg-card border border-line rounded-[10px] p-4 mb-4">
        <div class="flex items-center justify-between mb-1">
          <h2 class="text-[16px] font-bold m-0">API Keys</h2>
          <div class="flex gap-2">
            <button class="small" onClick={addKey}>+ 添加 Key</button>
            <button class="small" onClick={() => navigate('/settings')}>更多设置</button>
          </div>
        </div>
        <p class="text-muted text-[12px] mt-0 mb-3">可配置多个 Key，翻译请求按各 Key 并发数自动分摊。</p>
        <Show when={keys()} fallback={<p class="text-muted text-[13px]">加载中…</p>}>
          {(ks) => (
            <>
              <For each={ks()}>
                {(k, i) => (
                  <div class="border border-line rounded-[8px] p-2.5 mb-2 bg-bg">
                    <div class="flex gap-2 items-center">
                      <span class="text-[12px] text-muted w-[36px] shrink-0">Key {i() + 1}</span>
                      <input class={`${KEY_INPUT} flex-1 min-w-0 font-mono`}
                        type="password" value={k.key} placeholder="sk-..."
                        onInput={(e) => setKey(i(), 'key', e.currentTarget.value)} />
                      <button class="danger small shrink-0 p-[6px] inline-flex items-center justify-center"
                        title="删除该 Key" onClick={() => delKey(i())}><IconTrash /></button>
                    </div>
                    <div class="flex gap-2 mt-2 ml-0 sm:ml-[44px]">
                      <input class={`${KEY_INPUT} flex-1 min-w-0`}
                        value={k.model} placeholder={`统一模型：${config()?.model || 'deepseek-chat'}`}
                        onInput={(e) => setKey(i(), 'model', e.currentTarget.value)} />
                      <input class={`${KEY_INPUT} w-[104px] sm:w-[130px] shrink-0`}
                        type="number" min="0" max="50" value={k.concurrency || ''}
                        placeholder={`统一并发：${config()?.concurrency ?? ''}`}
                        title="并发数，留空或 0 表示跟随统一并发数"
                        onInput={(e) => setKey(i(), 'concurrency', e.currentTarget.valueAsNumber || 0)} />
                    </div>
                  </div>
                )}
              </For>
              <Show when={ks().length === 0}>
                <p class="text-danger text-[13px] mt-0 mb-2">尚未添加 API Key，翻译前请先添加。</p>
              </Show>
              <div class="flex items-center gap-3">
                <button class="primary small" disabled={keysSaving()} onClick={saveKeys}>
                  {keysSaving() ? '保存中…' : '保存'}
                </button>
                <Show when={keysMsg()}>
                  <span class={`text-[13px] ${keysMsg().startsWith('✓') ? 'text-[#166534]' : 'text-danger'}`}>{keysMsg()}</span>
                </Show>
              </div>
            </>
          )}
        </Show>
        <Show when={config()}>
          {(cfg) => (
            <p class="text-muted text-[13px] mt-3 mb-0">
              总并发 {totalConcurrency()} · 目标语言 {cfg().target_lang} ·
              单段最大 {cfg().max_segment_chars} 字符
            </p>
          )}
        </Show>
      </div>

      {/* 队列控制 */}
      <div class="flex gap-2.5 my-4 items-center flex-wrap">
        <button class="primary"
          disabled={busy() || (status()?.running ?? false) || !(status()?.entries.length)}
          onClick={() => act(() => api.startQueue())}>
          一键开始
        </button>
        <button disabled={busy() || !(status()?.running)}
          onClick={() => act(() => api.stopQueue())}>
          全部停止
        </button>
        <Show when={status()?.running}>
          <span class="text-[#1d4ed8] text-[13px]">队列运行中…</span>
        </Show>
        <Show when={status() && !status()!.running && status()!.entries.length > 0}>
          <span class="text-muted text-[13px]">{status()!.entries.length} 本书排队中</span>
        </Show>
      </div>
      {error() && <p class="text-danger text-[13px]">{error()}</p>}

      <Show when={status() && status()!.entries.length === 0}>
        <p class="text-muted text-center py-[40px]">
          队列为空。在书籍详情页点击「排队翻译」将书加入队列，然后回到这里一键开始。
        </p>
      </Show>

      {/* 每本书一个收纳盒 */}
      <For each={status()?.entries || []}>
        {(e) => (
          <div class="bg-card border border-line rounded-[10px] mb-3 overflow-hidden">
            <div class="flex items-center gap-2.5 px-3.5 py-2.5 cursor-pointer select-none"
              onClick={() => toggle(e.book_id, isOpen(e))}>
              <span class="text-muted text-[12px] w-[14px]">{isOpen(e) ? '▾' : '▸'}</span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium text-[14px] truncate">{e.title_translated || e.title}</span>
                  <span class={`text-[12px] rounded-[4px] px-[7px] py-[2px] ${e.running
                    ? 'bg-[#dbeafe] text-[#1d4ed8]'
                    : 'bg-[#eef0f3] text-muted'}`}>
                    {e.running
                      ? `${BOOK_STATUS[e.status] || '翻译中'}（${runningOf(e)} 章进行中）`
                      : `排队中 · ${BOOK_STATUS[e.status] || e.status}`}
                  </span>
                  <Show when={e.overwrite}>
                    <span class="text-[12px] rounded-[4px] px-[7px] py-[2px] bg-[#fef3c7] text-[#92400e]">全部重译</span>
                  </Show>
                  <Show when={e.error}>
                    <span class="text-danger text-[12px]">{e.error}</span>
                  </Show>
                </div>
                <div class="flex items-center gap-2 mt-1.5">
                  <div class="flex-1 h-2 bg-[#e5e7eb] rounded-[3px] overflow-hidden">
                    <div class="h-full bg-primary transition-[width] duration-[0.4s]"
                      style={{ width: `${chaptersOf(e).length ? (doneOf(e) / chaptersOf(e).length) * 100 : 0}%` }} />
                  </div>
                  <span class="text-muted text-[12px] shrink-0">{doneOf(e)}/{chaptersOf(e).length} 章</span>
                </div>
              </div>
              <button class="small shrink-0"
                onClick={(ev) => { ev.stopPropagation(); navigate(`/books/${e.book_id}`) }}>
                详情
              </button>
              <button class="small danger shrink-0 p-[6px] inline-flex items-center justify-center"
                title="从队列移除" disabled={busy() || e.running}
                onClick={(ev) => { ev.stopPropagation(); act(() => api.dequeue(e.book_id)) }}>
                <IconX />
              </button>
            </div>

            {/* 章节小方块 */}
            <Show when={isOpen(e)}>
              <div class="px-3.5 pb-3.5 pt-1 border-t border-line flex flex-wrap gap-2">
                <For each={chaptersOf(e)}>
                  {({ c, n }) => {
                    const segPct = () => {
                      if (c.status === 'done') return 100
                      if (c.seg_total) return Math.round(((c.seg_done || 0) / c.seg_total) * 100)
                      return 0
                    }
                    return (
                      <div class="w-[64px]"
                        title={`${c.title}\n${CH_STATUS[c.status] || c.status}${c.error ? `\n${c.error}` : ''}`}>
                        <div class={`w-[64px] h-[48px] rounded-[6px] flex items-center justify-center text-[13px] font-medium transition-colors duration-300 ${TILE[c.status] || TILE.pending}`}>
                          {n}
                        </div>
                        {/* 分段翻译进度 */}
                        <div class="h-[4px] bg-[#e5e7eb] rounded-[2px] overflow-hidden mt-1">
                          <div class={`h-full transition-[width] duration-[0.3s] ${BAR[c.status] || BAR.pending}`}
                            style={{ width: `${segPct()}%` }} />
                        </div>
                        <div class="text-[10px] text-muted text-center mt-[2px]">
                          {c.seg_total ? `${c.seg_done || 0}/${c.seg_total} 段` : ' '}
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
