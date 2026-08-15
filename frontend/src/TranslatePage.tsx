import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { api } from './api'
import { config, setSettingsOpen } from './state'
import type { QueueStatus, QueueStatusEntry } from './types'

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

  const doneOf = (e: QueueStatusEntry) => e.chapters.filter(c => c.status === 'done').length
  const runningOf = (e: QueueStatusEntry) => e.chapters.filter(c => c.status === 'translating').length

  // 各 key 的有效并发数之和 = 当前总并发能力
  const totalConcurrency = () => {
    const cfg = config()
    if (!cfg) return 0
    return (cfg.api_keys || []).reduce((s, k) => s + (k.concurrency || cfg.concurrency), 0)
  }

  return (
    <div>
      {/* API 配置概览 */}
      <div class="bg-card border border-line rounded-[10px] p-4 mb-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-[16px] font-bold m-0">API 配置</h2>
          <button class="small" onClick={() => setSettingsOpen(true)}>修改设置</button>
        </div>
        <Show when={config()} fallback={<p class="text-muted text-[13px]">加载中…</p>}>
          {(cfg) => (
            <div>
              <Show when={cfg().api_keys.length > 0}
                fallback={<p class="text-danger text-[13px] my-1">尚未配置 API Key，请先在设置中添加。</p>}>
                <table class="mb-2">
                  <thead>
                    <tr><th>API Key</th><th>模型</th><th>并发数</th></tr>
                  </thead>
                  <tbody>
                    <For each={cfg().api_keys}>
                      {(k) => (
                        <tr>
                          <td class="font-mono text-[13px]">{k.key}</td>
                          <td>{k.model || <span class="text-muted">统一：{cfg().model}</span>}</td>
                          <td>{k.concurrency || <span class="text-muted">统一：{cfg().concurrency}</span>}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
              <p class="text-muted text-[13px] m-0">
                总并发 {totalConcurrency()} · 目标语言 {cfg().target_lang} ·
                单段最大 {cfg().max_segment_chars} 字符
              </p>
            </div>
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
                      style={{ width: `${e.chapters.length ? (doneOf(e) / e.chapters.length) * 100 : 0}%` }} />
                  </div>
                  <span class="text-muted text-[12px] shrink-0">{doneOf(e)}/{e.chapters.length} 章</span>
                </div>
              </div>
              <button class="small shrink-0"
                onClick={(ev) => { ev.stopPropagation(); navigate(`/books/${e.book_id}`) }}>
                详情
              </button>
              <button class="small danger shrink-0" disabled={busy() || e.running}
                onClick={(ev) => { ev.stopPropagation(); act(() => api.dequeue(e.book_id)) }}>
                移除
              </button>
            </div>

            {/* 章节小方块 */}
            <Show when={isOpen(e)}>
              <div class="px-3.5 pb-3.5 pt-1 border-t border-line flex flex-wrap gap-2">
                <For each={e.chapters}>
                  {(c, i) => {
                    const segPct = () => {
                      if (c.status === 'done') return 100
                      if (c.seg_total) return Math.round(((c.seg_done || 0) / c.seg_total) * 100)
                      return 0
                    }
                    return (
                      <div class="w-[64px]"
                        title={`${c.title}\n${CH_STATUS[c.status] || c.status}${c.error ? `\n${c.error}` : ''}`}>
                        <div class={`w-[64px] h-[48px] rounded-[6px] flex items-center justify-center text-[13px] font-medium transition-colors duration-300 ${TILE[c.status] || TILE.pending}`}>
                          {i() + 1}
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
