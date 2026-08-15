import { A, HashRouter, Route } from '@solidjs/router'
import { onMount, Show, type ParentProps } from 'solid-js'
import { config, loadConfig, setSettingsOpen, settingsOpen } from './state'
import BookList from './BookList'
import BookDetail from './BookDetail'
import TranslatePage from './TranslatePage'
import Settings from './Settings'

const NAV = 'block px-3 py-2 rounded-[6px] text-[14px] no-underline'
const NAV_ACTIVE = 'bg-[#dbeafe] text-[#1d4ed8] font-medium'
const NAV_IDLE = 'text-text hover:bg-[#eef0f3]'

function Layout(props: ParentProps) {
  onMount(loadConfig)

  return (
    <div class="flex min-h-screen">
      <aside class="w-[200px] shrink-0 bg-card border-r border-line flex flex-col sticky top-0 h-screen">
        <div class="px-4 py-4 border-b border-line">
          <A href="/" class="text-[18px] font-bold no-underline text-text hover:text-primary">
            📖 书本翻译
          </A>
        </div>
        <nav class="flex-1 p-3 flex flex-col gap-1">
          <A href="/" end class={`${NAV} ${NAV_IDLE}`} activeClass={NAV_ACTIVE}>书库</A>
          <A href="/queue" class={`${NAV} ${NAV_IDLE}`} activeClass={NAV_ACTIVE}>翻译队列</A>
        </nav>
        <div class="p-3 border-t border-line flex flex-col gap-2 items-start">
          <Show when={config()}>
            <span class={`text-[12px] px-2 py-[3px] rounded-[10px] ${config()!.api_key_set ? 'bg-[#dcfce7] text-[#166534]' : 'bg-[#fee2e2] text-[#991b1b]'}`}>
              {config()!.api_key_set ? `API 已配置（${config()!.api_keys.length} 个 Key）` : '未配置 API Key'}
            </span>
          </Show>
          <button class="w-full" onClick={() => setSettingsOpen(true)}>设置</button>
        </div>
      </aside>
      <main class="flex-1 min-w-0 px-6 pb-[60px]">
        {props.children}
      </main>
      <Show when={settingsOpen() && config()}>
        <Settings config={config()!} onClose={(saved) => {
          setSettingsOpen(false)
          if (saved) loadConfig()
        }} />
      </Show>
    </div>
  )
}

export default function App() {
  return (
    <HashRouter root={Layout}>
      <Route path="/" component={BookList} />
      <Route path="/books/:id" component={BookDetail} />
      <Route path="/queue" component={TranslatePage} />
    </HashRouter>
  )
}
