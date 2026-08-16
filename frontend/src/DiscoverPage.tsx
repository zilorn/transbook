import { createSignal, For, onMount, Show } from 'solid-js'
import { api } from './api'
import { CrawlJobList, useCrawlJobs } from './CrawlJobs'
import type { RankItem } from './types'

type Site = 'syosetu' | 'kakuyomu'

const SITE_INFO: Record<Site, { name: string; desc: string }> = {
  syosetu: {
    name: '成为小说家吧（syosetu）',
    desc: '数据来源：syosetu.com 官方排行榜，每榜前 50 名。',
  },
  kakuyomu: {
    name: 'KAKUYOMU',
    desc: '数据来源：kakuyomu.jp 官方排行榜，每榜前 100 名。',
  },
}

const SELECT = 'px-2 py-1.5 border border-line rounded-[6px] text-[13px] bg-card'

function FilterSelect(props: {
  label: string
  value: string
  options: Record<string, string>
  onChange: (v: string) => void
}) {
  return (
    <label class="inline-flex items-center gap-1.5 text-[13px] text-muted">
      {props.label}
      <select class={SELECT} value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}>
        <For each={Object.entries(props.options)}>
          {([key, label]) => <option value={key}>{label}</option>}
        </For>
      </select>
    </label>
  )
}

export default function DiscoverPage() {
  const [site, setSite] = createSignal<Site>('syosetu')
  // syosetu 筛选：周期 × 分类（综合榜可按范围再筛）
  const [sPeriod, setSPeriod] = createSignal('daily')
  const [sGenre, setSGenre] = createSignal('total')
  const [sKind, setSKind] = createSignal('total')
  // kakuyomu 筛选：类型 × 周期 × 篇幅
  const [kGenre, setKGenre] = createSignal('all')
  const [kPeriod, setKPeriod] = createSignal('weekly')
  const [kVariation, setKVariation] = createSignal('all')
  // 筛选项字典（随首次响应返回）
  const [options, setOptions] = createSignal<Record<string, Record<string, string>>>({})
  const [results, setResults] = createSignal<RankItem[] | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const { jobs, addJob } = useCrawlJobs()

  const load = async () => {
    if (loading()) return
    setLoading(true)
    setError('')
    try {
      if (site() === 'syosetu') {
        const r = await api.syosetuRankings(sPeriod(), sGenre(), sKind())
        setResults(r.results)
        setOptions({ periods: r.periods, genres: r.genres, kinds: r.kinds })
      } else {
        const r = await api.kakuyomuRankings(kGenre(), kPeriod(), kVariation())
        setResults(r.results)
        setOptions({ periods: r.periods, genres: r.genres, variations: r.variations })
      }
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }
  onMount(load)

  const switchSite = (s: Site) => {
    if (s === site()) return
    setSite(s)
    setResults(null)
    setOptions({})
    setError('')
    load()
  }

  // 筛选变化即重新加载
  const change = (setter: (v: string) => void) => (v: string) => {
    setter(v)
    load()
  }

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

  const meta = (r: RankItem) => [
    r.author,
    r.status,
    r.genre,
    r.points ? `${r.points.toLocaleString()} 点` : '',
    r.episodes ? `全 ${r.episodes} 话` : '',
    r.chars ? `${r.chars.toLocaleString()} 字` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div class="max-w-[860px]">
      <h1 class="text-[20px] font-bold mt-6 mb-1">发现</h1>

      {/* 站点切换 */}
      <div class="flex gap-1 mt-3 mb-2 border-b border-line">
        <For each={['syosetu', 'kakuyomu'] as Site[]}>
          {(s) => (
            <button
              class={`px-3 py-1.5 text-[14px] border-0 bg-transparent cursor-pointer ${site() === s ? 'text-primary font-medium border-b-2 border-primary -mb-px' : 'text-muted'}`}
              onClick={() => switchSite(s)}>
              {SITE_INFO[s].name}
            </button>
          )}
        </For>
      </div>
      <p class="text-[13px] text-muted mb-4">
        {SITE_INFO[site()].desc}想看更多可用「小说搜索」按关键词查找。
      </p>

      {/* 筛选 */}
      <Show when={Object.keys(options()).length > 0}>
        <div class="flex flex-wrap gap-x-5 gap-y-2 mb-4">
          <Show when={site() === 'syosetu'}>
            <FilterSelect label="周期" value={sPeriod()} options={options().periods || {}} onChange={change(setSPeriod)} />
            <FilterSelect label="分类" value={sGenre()} options={options().genres || {}} onChange={change(setSGenre)} />
            <Show when={sGenre() === 'total'}>
              <FilterSelect label="范围" value={sKind()} options={options().kinds || {}} onChange={change(setSKind)} />
            </Show>
          </Show>
          <Show when={site() === 'kakuyomu'}>
            <FilterSelect label="类型" value={kGenre()} options={options().genres || {}} onChange={change(setKGenre)} />
            <FilterSelect label="周期" value={kPeriod()} options={options().periods || {}} onChange={change(setKPeriod)} />
            <FilterSelect label="篇幅" value={kVariation()} options={options().variations || {}} onChange={change(setKVariation)} />
          </Show>
        </div>
      </Show>
      <Show when={error()}>
        <p class="text-[13px] text-[#991b1b] mb-3">{error()}</p>
      </Show>

      {/* 爬取任务进度 */}
      <Show when={jobs().length > 0}>
        <CrawlJobList jobs={jobs()} />
      </Show>

      {/* 排行榜结果 */}
      <Show when={loading()}>
        <p class="text-[13px] text-muted">加载排行榜中…</p>
      </Show>
      <Show when={!loading() && results()}>
        <div class="text-[13px] text-muted mb-2">排行榜 {results()!.length} 条</div>
        <div class="flex flex-col gap-2">
          <For each={results()!}>
            {(r) => (
              <div class="bg-card border border-line rounded-[8px] p-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex items-start gap-2">
                    <span class={`shrink-0 w-[26px] text-center text-[13px] font-bold rounded-[4px] py-[1px] ${r.rank <= 3 ? 'bg-[#fef3c7] text-[#92400e]' : 'bg-[#eef0f3] text-muted'}`}>
                      {r.rank}
                    </span>
                    <div class="min-w-0">
                      <a href={r.url} target="_blank" rel="noreferrer"
                         class="text-[14px] font-medium text-primary no-underline hover:underline">
                        {r.title}
                      </a>
                      <div class="text-[12px] text-muted mt-[2px]">{meta(r)}</div>
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
