// 设置页：左侧/顶部锚点导航 + 搜索过滤，可按设置项快速定位
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { A, useSearchParams } from '@solidjs/router'
import { api } from './api'
import { config, loadConfig } from './state'
import type { Config, UpdateStatus } from './types'

// 表单编辑过程中数字字段可能是字符串（保存时再 Number 转换）
type ConfigForm = Omit<Config, 'concurrency' | 'max_segment_chars'> & {
  concurrency: number | string
  max_segment_chars: number | string
}

// 移动端输入框用 16px 字号，避免 iOS 聚焦时自动放大页面
const INPUT = 'w-full px-3 py-2 border border-line rounded-[8px] text-[14px] max-md:text-[16px] bg-bg focus:border-primary focus:outline-none'
const FIELD_LABEL = 'block text-[13px] font-medium text-text mb-1.5'
const FIELD_HINT = 'text-[12px] text-muted mt-1'

// ---- 设置项注册表：锚点导航与搜索共用的数据源 ----
interface SettingItem {
  id: string
  section: string
  label: string
  keywords: string // 额外搜索关键词（中英文别名）
}

const SECTIONS = [
  { id: 'translate', title: '翻译参数' },
  { id: 'webdav', title: 'WebDAV 书库' },
  { id: 'update', title: '版本更新' },
] as const

const ITEMS: SettingItem[] = [
  { id: 'base_url', section: 'translate', label: 'API 地址', keywords: 'api url base 接口 deepseek 代理' },
  { id: 'model', section: 'translate', label: '统一模型', keywords: 'model 模型 deepseek' },
  { id: 'target_lang', section: 'translate', label: '目标语言', keywords: 'language 语言 译文 中文' },
  { id: 'concurrency', section: 'translate', label: '统一并发数', keywords: 'concurrency 并发 速度' },
  { id: 'max_segment_chars', section: 'translate', label: '单段最大字符数', keywords: 'segment 分段 字符 长度' },
  { id: 'webdav_enabled', section: 'webdav', label: '开启 WebDAV 书库', keywords: 'webdav 书库 epub 阅读器 局域网' },
  { id: 'update_repo', section: 'update', label: '更新仓库', keywords: 'repo github 仓库 更新 源码' },
  { id: 'update_branch', section: 'update', label: '分支', keywords: 'branch 分支 main' },
  { id: 'github_token', section: 'update', label: 'GitHub Token', keywords: 'token github 私有仓库 令牌' },
  { id: 'update_check', section: 'update', label: '检查更新', keywords: 'check 检查 更新 版本 升级' },
]

function Card(props: { title: string; desc?: string; children: any }) {
  return (
    <section class="bg-card border border-line rounded-[12px] p-4 md:p-5 mb-4">
      <h2 class="text-[15px] font-bold m-0">{props.title}</h2>
      <Show when={props.desc}>
        <p class="text-[12px] text-muted mt-1 mb-4">{props.desc}</p>
      </Show>
      <Show when={!props.desc}><div class="mt-4" /></Show>
      {props.children}
    </section>
  )
}

export default function SettingsPage() {
  // 页面独立加载配置；form 为空时等 config 就绪后初始化
  onMount(() => { if (!config()) loadConfig() })
  const [form, setForm] = createSignal<ConfigForm | null>(null)
  createEffect(() => {
    const c = config()
    if (c && !form()) setForm({ ...c, api_keys: c.api_keys || [] })
  })

  const [saving, setSaving] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const [error, setError] = createSignal('')

  const set = <K extends keyof ConfigForm>(k: K, v: ConfigForm[K]) => {
    setForm({ ...form()!, [k]: v })
    setSaved(false)
  }

  // ---- 设置项定位：搜索过滤 + 锚点跳转 + 闪烁高亮 ----
  const [query, setQuery] = createSignal('')
  const [flashId, setFlashId] = createSignal('')
  const [activeId, setActiveId] = createSignal('')
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(flashTimer))

  const matched = (it: SettingItem): boolean => {
    const q = query().trim().toLowerCase()
    if (!q) return true
    const sec = SECTIONS.find(s => s.id === it.section)?.title || ''
    return `${it.label} ${it.keywords} ${sec}`.toLowerCase().includes(q)
  }
  const visible = (id: string) => matched(ITEMS.find(i => i.id === id)!)
  const sectionVisible = (sec: string) => ITEMS.some(i => i.section === sec && matched(i))
  const matchCount = () => ITEMS.filter(matched).length

  const jump = (id: string) => {
    const el = document.getElementById(`setting-${id}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveId(id)
    setFlashId(id)
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => setFlashId(''), 1700)
  }

  // 支持 #/settings?item=xxx 深链接直接定位（其他页面可跳转过来）
  const [params] = useSearchParams()
  createEffect(() => {
    if (!form()) return
    const it = params.item
    if (typeof it === 'string' && ITEMS.some(i => i.id === it)) {
      setTimeout(() => jump(it), 50)
    }
  })

  // ---- 版本更新 ----
  const [upd, setUpd] = createSignal<UpdateStatus | null>(null)
  const [updBusy, setUpdBusy] = createSignal(false)
  const shortSha = (s?: string | null) => (s || '').slice(0, 8) || '未知'
  const fmtTime = (t?: number | null) => t ? new Date(t * 1000).toLocaleString() : '从未'

  onMount(async () => {
    try { setUpd(await api.updateStatus()) } catch { /* 忽略 */ }
  })

  const checkUpdate = async () => {
    setUpdBusy(true)
    setError('')
    try {
      setUpd(await api.updateCheck(true))
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setUpdBusy(false)
    }
  }

  const applyUpdate = async () => {
    setUpdBusy(true)
    setError('')
    try {
      const s = await api.updateApply()
      setUpd(s)
      if (s.status === 'error') setError(s.error || '更新失败')
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setUpdBusy(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await api.saveConfig({
        ...form()!,
        concurrency: Number(form()!.concurrency),
        max_segment_chars: Number(form()!.max_segment_chars),
        api_keys: form()!.api_keys
          .filter(k => k.key.trim())
          .map(k => ({ ...k, key: k.key.trim(), concurrency: Number(k.concurrency) || 0 })),
      })
      await loadConfig()
      setSaved(true)
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    const c = config()
    if (c) setForm({ ...c, api_keys: c.api_keys || [] })
    setError('')
    setSaved(false)
  }

  // 可定位字段容器：锚点 id + 定位时的闪烁高亮
  const Field = (props: { id: string; children: any; class?: string }) => (
    <div id={`setting-${props.id}`}
      class={`scroll-mt-[64px] rounded-[8px] px-2 py-1 -mx-2 -my-1 ${flashId() === props.id ? 'setting-flash' : ''} ${props.class || ''}`}>
      {props.children}
    </div>
  )

  // 导航列表（桌面侧边栏 / 移动端 chips 共用数据）
  const navGroups = () =>
    SECTIONS.map(s => ({ ...s, items: ITEMS.filter(i => i.section === s.id && matched(i)) }))
      .filter(g => g.items.length > 0)

  const NAV_ITEM = 'block w-full text-left px-2 py-[5px] rounded-[6px] text-[13px] cursor-pointer border-0 bg-transparent'
  const navCls = (id: string) =>
    `${NAV_ITEM} ${activeId() === id ? 'bg-[#dbeafe] text-[#1d4ed8] font-medium' : 'text-text hover:bg-[#eef0f3]'}`

  return (
    <Show when={form()} fallback={<p class="text-muted text-[14px] py-10 text-center">加载中…</p>}>
      {(f) => (
        <div class="max-w-[960px] mx-auto py-5">
          <div class="mb-4">
            <h1 class="text-[22px] font-bold m-0">设置</h1>
            <p class="text-[13px] text-muted mt-1 mb-0">
              翻译参数、WebDAV 与版本更新；API Keys 在 <A href="/queue" class="text-primary">翻译队列</A> 页配置
            </p>
          </div>

          {/* ---- 搜索：按名称/关键词过滤设置项 ---- */}
          <div class="relative mb-4">
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-muted pointer-events-none"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input class={`${INPUT} pl-9 ${query().trim() ? 'pr-12' : ''}`} placeholder="搜索设置项（如：模型、webdav、token）"
              type="search" enterkeyhint="search"
              value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
            <Show when={query().trim()}>
              <button class="absolute right-2 top-1/2 -translate-y-1/2 border-0 bg-transparent text-muted text-[13px] px-1"
                onClick={() => setQuery('')}>清除</button>
            </Show>
          </div>

          {/* ---- 移动端：设置项 chips（横向滚动，隐藏滚动条） ---- */}
          <div class="md:hidden flex gap-2 overflow-x-auto pb-2 mb-3 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <For each={navGroups()}>
              {(g) => (
                <For each={g.items}>
                  {(it) => (
                    <button class={`shrink-0 px-3 py-[8px] text-[13px] whitespace-nowrap rounded-[8px] ${activeId() === it.id ? 'primary' : ''}`}
                      onClick={() => jump(it.id)}>{it.label}</button>
                  )}
                </For>
              )}
            </For>
            <Show when={matchCount() === 0}>
              <span class="text-[13px] text-muted shrink-0 self-center">无匹配设置项</span>
            </Show>
          </div>

          <div class="md:flex md:gap-6 md:items-start">
            {/* ---- 桌面端：锚点导航侧边栏 ---- */}
            <aside class="hidden md:block w-[180px] shrink-0 sticky top-5 self-start">
              <Show when={query().trim()}>
                <p class="text-[12px] text-muted mt-0 mb-2">匹配到 {matchCount()} 项</p>
              </Show>
              <Show when={navGroups().length > 0}
                fallback={<p class="text-[13px] text-muted">无匹配设置项</p>}>
                <For each={navGroups()}>
                  {(g) => (
                    <div class="mb-3">
                      <p class="text-[12px] text-muted font-medium px-2 mt-0 mb-1">{g.title}</p>
                      <For each={g.items}>
                        {(it) => (
                          <button class={navCls(it.id)} onClick={() => jump(it.id)}>{it.label}</button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </Show>
            </aside>

            {/* ---- 设置内容 ---- */}
            <div class="flex-1 min-w-0">
              <Show when={sectionVisible('translate')}>
                <Card title="翻译参数">
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                    <Show when={visible('base_url')}>
                      <Field id="base_url" class="sm:col-span-2">
                        <span class={FIELD_LABEL}>API 地址</span>
                        <input class={INPUT} value={f().base_url || ''}
                          onInput={(e) => set('base_url', e.currentTarget.value)} />
                      </Field>
                    </Show>
                    <Show when={visible('model')}>
                      <Field id="model">
                        <span class={FIELD_LABEL}>统一模型</span>
                        <input class={INPUT} value={f().model || ''}
                          onInput={(e) => set('model', e.currentTarget.value)} />
                        <p class={FIELD_HINT}>各 Key 可单独覆盖</p>
                      </Field>
                    </Show>
                    <Show when={visible('target_lang')}>
                      <Field id="target_lang">
                        <span class={FIELD_LABEL}>目标语言</span>
                        <input class={INPUT} value={f().target_lang || ''}
                          onInput={(e) => set('target_lang', e.currentTarget.value)} />
                      </Field>
                    </Show>
                    <Show when={visible('concurrency')}>
                      <Field id="concurrency">
                        <span class={FIELD_LABEL}>统一并发数：{f().concurrency}</span>
                        <input class="w-full accent-primary mt-2" type="range" min="1" max="20" step="1"
                          value={f().concurrency}
                          onInput={(e) => set('concurrency', e.currentTarget.value)} />
                        <p class={FIELD_HINT}>各 Key 可单独覆盖</p>
                      </Field>
                    </Show>
                    <Show when={visible('max_segment_chars')}>
                      <Field id="max_segment_chars">
                        <span class={FIELD_LABEL}>单段最大字符数</span>
                        <input class={INPUT} type="number" min="500" max="20000" value={f().max_segment_chars}
                          onInput={(e) => set('max_segment_chars', e.currentTarget.value)} />
                        <p class={FIELD_HINT}>越大分段越少</p>
                      </Field>
                    </Show>
                  </div>
                </Card>
              </Show>

              <Show when={sectionVisible('webdav')}>
                <Card title="WebDAV 书库" desc="以只读 WebDAV 暴露已翻译书籍（EPUB），供阅读软件直接添加为书库。">
                  <Field id="webdav_enabled">
                    <label class="flex items-center gap-2 text-[14px] cursor-pointer">
                      <input type="checkbox" class="w-[16px] h-[16px] accent-primary"
                        checked={f().webdav_enabled || false}
                        onChange={(e) => set('webdav_enabled', e.currentTarget.checked)} />
                      开启 WebDAV 书库
                    </label>
                    <Show when={f().webdav_enabled}>
                      <p class="mt-3 mb-0 text-[12px] text-muted break-all">
                        在阅读软件中添加 WebDAV 书库，地址：
                        <code class="select-all">http://{location.hostname}:8300/webdav/</code>
                        <br />已翻译的书籍会以 EPUB 形式出现在书库根目录。
                        从手机等其他设备访问时，把主机名换成本机的局域网 IP。
                      </p>
                    </Show>
                  </Field>
                </Card>
              </Show>

              <Show when={sectionVisible('update')}>
                <Card title="版本更新（GitHub）">
                  <Show when={visible('update_repo')}>
                    <Field id="update_repo" class="mb-4">
                      <span class={FIELD_LABEL}>更新仓库（owner/repo，留空默认官方仓库）</span>
                      <input class={INPUT} value={f().update_repo || ''} placeholder="zilorn/transbook"
                        onInput={(e) => set('update_repo', e.currentTarget.value)} />
                    </Field>
                  </Show>
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-4 mb-4">
                    <Show when={visible('update_branch')}>
                      <Field id="update_branch">
                        <span class={FIELD_LABEL}>分支</span>
                        <input class={INPUT} value={f().update_branch || ''} placeholder="main"
                          onInput={(e) => set('update_branch', e.currentTarget.value)} />
                      </Field>
                    </Show>
                    <Show when={visible('github_token')}>
                      <Field id="github_token" class="sm:col-span-2">
                        <span class={FIELD_LABEL}>GitHub Token（私有仓库用，可留空）</span>
                        <input class={INPUT} type="password" value={f().github_token || ''}
                          onInput={(e) => set('github_token', e.currentTarget.value)} />
                      </Field>
                    </Show>
                  </div>
                  <Show when={visible('update_check')}>
                    <Field id="update_check">
                      <div class="flex items-center gap-3 flex-wrap">
                        <button class="small" disabled={updBusy()} onClick={checkUpdate}>
                          {updBusy() && upd()?.status === 'checking' ? '检查中…' : '检查更新'}
                        </button>
                        <Show when={upd()}>
                          <p class="text-[12px] text-muted m-0 break-all">
                            当前 <code>{shortSha(upd()!.current_sha)}</code>
                            <Show when={upd()!.remote_sha}>
                              {' '}→ 最新 <code>{shortSha(upd()!.remote_sha)}</code>（{upd()!.remote_msg}）
                            </Show>
                            {'　'}上次检查：{fmtTime(upd()!.last_check)}
                          </p>
                        </Show>
                      </div>
                      <Show when={upd()}>
                        <Show when={upd()!.status === 'updating'}>
                          <p class="text-[12px] text-muted mt-2 mb-0">正在更新：下载源码并构建前端，完成后服务自动重启…</p>
                        </Show>
                        <Show when={upd()!.status === 'restarting'}>
                          <p class="text-[12px] text-muted mt-2 mb-0">正在重启服务…</p>
                        </Show>
                        <Show when={upd()!.status === 'restart_required'}>
                          <p class="text-[12px] text-muted mt-2 mb-0">更新已应用，非 Docker 环境需手动重启服务生效。</p>
                        </Show>
                        <Show when={upd()!.update_available && !['updating', 'restarting'].includes(upd()!.status)}>
                          <button class="primary small mt-3" disabled={updBusy()} onClick={applyUpdate}>
                            {updBusy() ? '更新中…' : '立即更新'}
                          </button>
                        </Show>
                      </Show>
                    </Field>
                  </Show>
                </Card>
              </Show>

              <Show when={matchCount() === 0}>
                <p class="text-muted text-[14px] py-10 text-center">
                  没有匹配「{query().trim()}」的设置项
                </p>
              </Show>

              {/* ---- 底部保存栏（移动端全宽 + iPhone 底部安全区） ---- */}
              <div class="sticky bottom-0 -mx-4 md:mx-0 px-4 md:px-0 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:py-3 bg-bg/90 backdrop-blur flex items-center justify-end gap-3 border-t border-line md:border-0">
                <Show when={error()}>
                  <span class="text-danger text-[13px] mr-auto">{error()}</span>
                </Show>
                <Show when={saved() && !error()}>
                  <span class="text-[13px] text-[#166534] mr-auto">✓ 已保存</span>
                </Show>
                <button onClick={reset}>放弃修改</button>
                <button class="primary" disabled={saving()} onClick={save}>
                  {saving() ? '保存中…' : '保存设置'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}
