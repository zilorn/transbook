import { createEffect, createSignal, onMount, Show } from 'solid-js'
import { api } from './api'
import { config, loadConfig } from './state'
import type { Config, UpdateStatus } from './types'

// 表单编辑过程中数字字段可能是字符串（保存时再 Number 转换）
type ConfigForm = Omit<Config, 'concurrency' | 'max_segment_chars'> & {
  concurrency: number | string
  max_segment_chars: number | string
}

const INPUT = 'w-full px-3 py-2 border border-line rounded-[8px] text-[14px] bg-bg focus:border-primary focus:outline-none'
const FIELD_LABEL = 'block text-[13px] font-medium text-text mb-1.5'
const FIELD_HINT = 'text-[12px] text-muted mt-1'

function Card(props: { title: string; desc?: string; children: any }) {
  return (
    <section class="bg-card border border-line rounded-[12px] p-5 mb-4">
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

  return (
    <Show when={form()} fallback={<p class="text-muted text-[14px] py-10 text-center">加载中…</p>}>
      {(f) => (
        <div class="max-w-[720px] mx-auto py-5">
          <div class="mb-5">
            <h1 class="text-[22px] font-bold m-0">设置</h1>
            <p class="text-[13px] text-muted mt-1 mb-0">翻译参数、WebDAV 与版本更新；API Keys 在「翻译队列」页配置</p>
          </div>

          {/* ---- 翻译参数 ---- */}
          <Card title="翻译参数">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
              <div class="sm:col-span-2">
                <span class={FIELD_LABEL}>API 地址</span>
                <input class={INPUT} value={f().base_url || ''}
                  onInput={(e) => set('base_url', e.currentTarget.value)} />
              </div>
              <div>
                <span class={FIELD_LABEL}>统一模型</span>
                <input class={INPUT} value={f().model || ''}
                  onInput={(e) => set('model', e.currentTarget.value)} />
                <p class={FIELD_HINT}>各 Key 可单独覆盖</p>
              </div>
              <div>
                <span class={FIELD_LABEL}>目标语言</span>
                <input class={INPUT} value={f().target_lang || ''}
                  onInput={(e) => set('target_lang', e.currentTarget.value)} />
              </div>
              <div>
                <span class={FIELD_LABEL}>统一并发数：{f().concurrency}</span>
                <input class="w-full accent-primary mt-2" type="range" min="1" max="20" step="1"
                  value={f().concurrency}
                  onInput={(e) => set('concurrency', e.currentTarget.value)} />
                <p class={FIELD_HINT}>各 Key 可单独覆盖</p>
              </div>
              <div>
                <span class={FIELD_LABEL}>单段最大字符数</span>
                <input class={INPUT} type="number" min="500" max="20000" value={f().max_segment_chars}
                  onInput={(e) => set('max_segment_chars', e.currentTarget.value)} />
                <p class={FIELD_HINT}>越大分段越少</p>
              </div>
            </div>
          </Card>

          {/* ---- WebDAV ---- */}
          <Card title="WebDAV 书库" desc="以只读 WebDAV 暴露已翻译书籍（EPUB），供阅读软件直接添加为书库。">
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
          </Card>

          {/* ---- 版本更新 ---- */}
          <Card title="版本更新（GitHub）">
            <div class="mb-4">
              <span class={FIELD_LABEL}>更新仓库（owner/repo，留空默认官方仓库）</span>
              <input class={INPUT} value={f().update_repo || ''} placeholder="zilorn/transbook"
                onInput={(e) => set('update_repo', e.currentTarget.value)} />
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-4 mb-4">
              <div>
                <span class={FIELD_LABEL}>分支</span>
                <input class={INPUT} value={f().update_branch || ''} placeholder="main"
                  onInput={(e) => set('update_branch', e.currentTarget.value)} />
              </div>
              <div class="sm:col-span-2">
                <span class={FIELD_LABEL}>GitHub Token（私有仓库用，可留空）</span>
                <input class={INPUT} type="password" value={f().github_token || ''}
                  onInput={(e) => set('github_token', e.currentTarget.value)} />
              </div>
            </div>
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
          </Card>

          {/* ---- 底部保存栏 ---- */}
          <div class="sticky bottom-0 -mx-4 md:mx-0 px-4 md:px-0 py-3 bg-bg/90 backdrop-blur flex items-center justify-end gap-3 border-t border-line md:border-0">
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
      )}
    </Show>
  )
}
