import { A, HashRouter, Route } from '@solidjs/router'
import { onMount, Show, type ParentProps } from 'solid-js'
import { config, loadConfig, setSettingsOpen, settingsOpen } from './state'
import BookList from './BookList'
import BookDetail from './BookDetail'
import TranslatePage from './TranslatePage'
import SearchPage from './SearchPage'
import DiscoverPage from './DiscoverPage'
import Settings from './Settings'

const NAV = 'flex items-center gap-2 px-3 py-2 rounded-[6px] text-[14px] no-underline'
const NAV_ACTIVE = 'bg-[#dbeafe] text-[#1d4ed8] font-medium'
const NAV_IDLE = 'text-text hover:bg-[#eef0f3]'

const ICON = 'w-[16px] h-[16px] shrink-0'

function IconBook() {
  return (
    <svg class={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </svg>
  )
}

function IconSearch() {
  return (
    <svg class={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function IconList() {
  return (
    <svg class={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="8" x2="21" y1="6" y2="6" />
      <line x1="8" x2="21" y1="12" y2="12" />
      <line x1="8" x2="21" y1="18" y2="18" />
      <line x1="3" x2="3.01" y1="6" y2="6" />
      <line x1="3" x2="3.01" y1="12" y2="12" />
      <line x1="3" x2="3.01" y1="18" y2="18" />
    </svg>
  )
}

function IconCompass() {
  return (
    <svg class={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  )
}

function IconSettings() {
  return (
    <svg class={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function Layout(props: ParentProps) {
  onMount(loadConfig)

  return (
    <div class="flex min-h-screen">
      <aside class="w-[200px] shrink-0 bg-card border-r border-line flex flex-col sticky top-0 h-screen">
        <div class="px-4 py-4 border-b border-line">
          <A href="/" class="flex items-center gap-2 text-[18px] font-bold no-underline text-text hover:text-primary">
            <IconBook />
            书本翻译
          </A>
        </div>
        <nav class="flex-1 p-3 flex flex-col gap-1">
          <A href="/" end class={`${NAV} ${NAV_IDLE}`} activeClass={NAV_ACTIVE}><IconBook />书库</A>
          <A href="/search" class={`${NAV} ${NAV_IDLE}`} activeClass={NAV_ACTIVE}><IconSearch />小说搜索</A>
          <A href="/discover" class={`${NAV} ${NAV_IDLE}`} activeClass={NAV_ACTIVE}><IconCompass />发现</A>
          <A href="/queue" class={`${NAV} ${NAV_IDLE}`} activeClass={NAV_ACTIVE}><IconList />翻译队列</A>
        </nav>
        <div class="p-3 border-t border-line flex flex-col gap-2 items-start">
          <Show when={config()}>
            <span class={`text-[12px] px-2 py-[3px] rounded-[10px] ${config()!.api_key_set ? 'bg-[#dcfce7] text-[#166534]' : 'bg-[#fee2e2] text-[#991b1b]'}`}>
              {config()!.api_key_set ? `API 已配置（${config()!.api_keys.length} 个 Key）` : '未配置 API Key'}
            </span>
          </Show>
          <button class="w-full flex items-center justify-center gap-2" onClick={() => setSettingsOpen(true)}><IconSettings />设置</button>
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
      <Route path="/search" component={SearchPage} />
      <Route path="/discover" component={DiscoverPage} />
    </HashRouter>
  )
}
