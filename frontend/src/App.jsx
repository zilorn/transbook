import { createSignal, onMount, Show } from 'solid-js'
import { api } from './api'
import BookList from './BookList'
import BookDetail from './BookDetail'
import Settings from './Settings'

export default function App() {
  const [route, setRoute] = createSignal({ view: 'list' })
  const [showSettings, setShowSettings] = createSignal(false)
  const [config, setConfig] = createSignal(null)

  onMount(async () => {
    try { setConfig(await api.config()) } catch (e) { console.error(e) }
  })

  const openBook = (id) => setRoute({ view: 'detail', id })

  return (
    <div class="app">
      <header>
        <h1 onClick={() => setRoute({ view: 'list' })} style={{ cursor: 'pointer' }}>
          📖 书本翻译
        </h1>
        <div class="header-right">
          <Show when={config()}>
            <span class={`key-badge ${config().api_key_set ? 'ok' : 'warn'}`}>
              {config().api_key_set ? 'API 已配置' : '未配置 API Key'}
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
          <BookDetail id={route().id} onBack={() => setRoute({ view: 'list' })} />
        </Show>
      </main>
      <Show when={showSettings()}>
        <Settings config={config()} onClose={(saved) => {
          setShowSettings(false)
          if (saved) api.config().then(setConfig)
        }} />
      </Show>
    </div>
  )
}
