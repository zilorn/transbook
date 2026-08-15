import { createSignal, onMount, Show } from 'solid-js'
import { api } from './api'
import type { Config } from './types'
import BookList from './BookList'
import BookDetail from './BookDetail'
import Settings from './Settings'

type Route = { view: 'list' | 'detail'; id?: string }

export default function App() {
  const [route, setRoute] = createSignal<Route>({ view: 'list' })
  const [showSettings, setShowSettings] = createSignal(false)
  const [config, setConfig] = createSignal<Config | null>(null)

  onMount(async () => {
    try { setConfig(await api.config()) } catch (e) { console.error(e) }
  })

  const openBook = (id: string) => setRoute({ view: 'detail', id })

  return (
    <div class="max-w-[960px] mx-auto px-4 pb-[60px]">
      <header>
        <h1 onClick={() => setRoute({ view: 'list' })} style={{ cursor: 'pointer' }}>
          📖 书本翻译
        </h1>
        <div class="flex items-center gap-2.5">
          <Show when={config()}>
            <span class={`text-[12px] px-2 py-[3px] rounded-[10px] ${config()!.api_key_set ? 'bg-[#dcfce7] text-[#166534]' : 'bg-[#fee2e2] text-[#991b1b]'}`}>
              {config()!.api_key_set ? 'API 已配置' : '未配置 API Key'}
            </span>
          </Show>
          <button onClick={() => setShowSettings(true)}>设置</button>
        </div>
      </header>
      <main>
        <Show when={route().view === 'list'}>
          <BookList onOpen={openBook} />
        </Show>
        <Show when={route().view === 'detail'}>
          <BookDetail id={route().id!} onBack={() => setRoute({ view: 'list' })} />
        </Show>
      </main>
      <Show when={showSettings()}>
        <Settings config={config()!} onClose={(saved) => {
          setShowSettings(false)
          if (saved) api.config().then(setConfig)
        }} />
      </Show>
    </div>
  )
}
