import { createSignal, For, onMount, Show } from 'solid-js'
import { api } from './api'
import { CrawlJobList, useCrawlJobs } from './CrawlJobs'
import type { KakuyomuResult, SyosetuResult } from './types'

// 输入形如作品/章节链接或纯 ID 时直接爬取，否则按关键词搜索
const NCODE_RE = /(?:ncode\.syosetu\.com\/)?n\d{4}[a-z]{2}/i
const WORK_ID_RE = /(?:kakuyomu\.jp\/works\/)?\d{10,}/

type Site = 'syosetu' | 'kakuyomu'

const SITE_INFO: Record<Site, { name: string; desc: string; placeholder: string }> = {
  syosetu: {
    name: '成为小说家吧（syosetu）',
    desc: '数据来源：syosetu.com。输入关键词搜索，或直接粘贴作品链接 / 作品编号爬取。',
    placeholder: '关键词 / 作品链接 / 作品编号',
  },
  kakuyomu: {
    name: 'KAKUYOMU',
    desc: '数据来源：kakuyomu.jp。输入关键词搜索（可按类型多选过滤），或直接粘贴作品 / 章节链接爬取。',
    placeholder: '关键词 / 作品链接 / 作品 ID',
  },
}

export default function SearchPage() {
  const [site, setSite] = createSignal<Site>('syosetu')
  const [query, setQuery] = createSignal('')
  const [results, setResults] = createSignal<(SyosetuResult | KakuyomuResult)[] | null>(null)
  const [searching, setSearching] = createSignal(false)
  const { jobs, addJob } = useCrawlJobs()
  const [error, setError] = createSignal('')
  // kakuyomu 类型多选过滤
  const [genres, setGenres] = createSignal<Record<string, string>>({})
  const [selGenres, setSelGenres] = createSignal<string[]>([])

  onMount(async () => {
    try {
      setGenres((await api.kakuyomuGenres()).genres)
    } catch { /* 忽略，无类型也能搜 */ }
  })

  const startFetch = async (url: string) => {
    setError('')
    try {
      const book = site() === 'kakuyomu'
        ? await api.kakuyomuFetch(url)
        : await api.syosetuFetch(url)
      addJob(book)
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  const submit = async () => {
    const q = query().trim()
    if (!q || searching()) return
    setError('')
    const direct = site() === 'kakuyomu' ? WORK_ID_RE.test(q) : NCODE_RE.test(q)
    if (direct) {
      await startFetch(q)
      return
    }
    setSearching(true)
    setResults(null)
    try {
      const r = site() === 'kakuyomu'
        ? await api.kakuyomuSearch(q, selGenres())
        : await api.syosetuSearch(q)
      setResults(r.results)
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setSearching(false)
    }
  }

  const toggleGenre = (g: string) => {
    setSelGenres((gs) => gs.includes(g) ? gs.filter((x) => x !== g) : [...gs, g])
  }

  return (
    <div class="max-w-[860px]">
      <h1 class="text-[20px] font-bold mt-6 mb-1">小说搜索</h1>

      {/* 站点切换 */}
      <div class="flex gap-1 mt-3 mb-2 border-b border-line">
        <For each={['syosetu', 'kakuyomu'] as Site[]}>
          {(s) => (
            <button
              class={`px-3 py-1.5 text-[14px] border-0 bg-transparent cursor-pointer ${site() === s ? 'text-primary font-medium border-b-2 border-primary -mb-px' : 'text-muted'}`}
              onClick={() => { setSite(s); setResults(null); setError('') }}>
              {SITE_INFO[s].name}
            </button>
          )}
        </For>
      </div>
      <p class="text-[13px] text-muted mb-4">
        {SITE_INFO[site()].desc}为规避风控，抓取为串行限速，长书耗时较长。
      </p>

      <div class="flex gap-2 mb-3">
        <input
          class="flex-1 px-3 py-2 border border-line rounded-[6px] text-[14px]"
          placeholder={SITE_INFO[site()].placeholder}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        />
        <button class="px-4" disabled={searching()} onClick={submit}>
          {searching() ? '搜索中…' : '搜索 / 爬取'}
        </button>
      </div>

      {/* kakuyomu 类型多选 */}
      <Show when={site() === 'kakuyomu' && Object.keys(genres()).length > 0}>
        <div class="flex flex-wrap gap-x-4 gap-y-1.5 mb-3 text-[13px]">
          <For each={Object.entries(genres())}>
            {([key, label]) => (
              <label class="inline-flex items-center gap-1 cursor-pointer select-none">
                <input type="checkbox" checked={selGenres().includes(key)}
                  onChange={() => toggleGenre(key)} />
                {label}
              </label>
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}>
        <p class="text-[13px] text-[#991b1b] mb-3">{error()}</p>
      </Show>

      {/* 爬取任务进度 */}
      <Show when={jobs().length > 0}>
        <CrawlJobList jobs={jobs()} />
      </Show>

      {/* 搜索结果 */}
      <Show when={results()}>
        <div class="text-[13px] text-muted mb-2">搜索结果 {results()!.length} 条</div>
        <div class="flex flex-col gap-2">
          <For each={results()!}>
            {(r) => (
              <div class="bg-card border border-line rounded-[8px] p-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <a href={r.url} target="_blank" rel="noreferrer"
                       class="text-[14px] font-medium text-primary no-underline hover:underline">
                      {r.title}
                    </a>
                    <div class="text-[12px] text-muted mt-[2px]">
                      {r.author}{r.status ? ` · ${r.status}` : ''}{r.episodes ? ` · 全${r.episodes}话` : ''}
                      {'genre' in r && r.genre ? ` · ${r.genre}` : ''}
                      {` · ${'ncode' in r ? r.ncode : r.work_id}`}
                    </div>
                  </div>
                  <button class="shrink-0 text-[13px]" onClick={() => startFetch(r.url)}>一键爬取</button>
                </div>
                <Show when={r.synopsis}>
                  <p class="text-[12px] text-muted mt-2 line-clamp-3">{r.synopsis}</p>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
