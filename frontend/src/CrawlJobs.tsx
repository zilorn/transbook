import { createSignal, For, onCleanup, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { api } from './api'
import type { Book, CrawlStatus } from './types'

// 爬取任务（书 + 实时进度）
export interface CrawlJob {
  book: Book
  status: CrawlStatus | null
}

const statusApi = (j: CrawlJob) =>
  j.book.source?.site === 'kakuyomu' ? api.kakuyomuStatus : api.syosetuStatus
const stopApi = (j: CrawlJob) =>
  j.book.source?.site === 'kakuyomu' ? api.kakuyomuStop : api.syosetuStop

// 爬取任务列表状态 + 2s 轮询进度（搜索页 / 发现页共用）
export function useCrawlJobs() {
  const [jobs, setJobs] = createSignal<CrawlJob[]>([])

  const timer = setInterval(async () => {
    const pending = jobs().filter((j) => !j.status || j.status.running)
    if (!pending.length) return
    const updated = await Promise.all(pending.map(async (j) => {
      try {
        return { book: j.book, status: await statusApi(j)(j.book.id) }
      } catch {
        return j
      }
    }))
    const byId = new Map(updated.map((j) => [j.book.id, j]))
    setJobs((js) => js.map((j) => byId.get(j.book.id) || j))
  }, 2000)
  onCleanup(() => clearInterval(timer))

  const addJob = (book: Book) => setJobs((js) => [{ book, status: null }, ...js])
  return { jobs, addJob }
}

// 爬取任务进度卡片列表
export function CrawlJobList(props: { jobs: CrawlJob[] }) {
  const navigate = useNavigate()
  return (
    <div class="flex flex-col gap-2 mb-6">
      <For each={props.jobs}>
        {(j) => (
          <div class="bg-card border border-line rounded-[8px] p-3">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <span class="text-[14px] font-medium">{j.book.title}</span>
                <span class="text-[12px] text-muted ml-2">{j.book.source?.url}</span>
              </div>
              <div class="shrink-0 flex gap-2">
                <Show when={j.status?.running}>
                  <button class="text-[13px]" onClick={() => stopApi(j)(j.book.id)}>停止</button>
                </Show>
                <Show when={j.status && !j.status.running && !j.status.error}>
                  <button class="text-[13px]" onClick={() => navigate(`/books/${j.book.id}`)}>查看书籍</button>
                </Show>
              </div>
            </div>
            <div class="text-[12px] text-muted mt-1">
              <Show when={!j.status}>正在启动…</Show>
              <Show when={j.status?.running}>
                爬取中 {j.status!.done}/{j.status!.total || '?'}{j.status!.current ? `：${j.status!.current}` : ''}
              </Show>
              <Show when={j.status && !j.status.running && !j.status.error}>
                完成，共 {j.status!.done} 章
              </Show>
              <Show when={j.status?.error}>
                <span class="text-[#991b1b]">失败：{j.status!.error}（已抓 {j.status!.done} 章保留）</span>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}
