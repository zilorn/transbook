import { createSignal, For, onMount, Show } from 'solid-js'
import { api } from './api'
import type { ApiKeyEntry, Config, UpdateStatus } from './types'

// 表单编辑过程中数字字段可能是字符串（保存时再 Number 转换）
type ConfigForm = Omit<Config, 'concurrency' | 'max_segment_chars'> & {
  concurrency: number | string
  max_segment_chars: number | string
}

// 原 .modal label / .modal input 样式
const LABEL = 'block mb-3 text-[13px] text-muted'
const INPUT = 'w-full mt-1 px-2.5 py-[7px] border border-line rounded-[6px] text-[14px]'

export default function Settings(props: { config: Config; onClose: (saved: boolean) => void }) {
  const [form, setForm] = createSignal<ConfigForm>({ ...props.config, api_keys: props.config.api_keys || [] })
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal('')

  const set = <K extends keyof ConfigForm>(k: K, v: ConfigForm[K]) => setForm({ ...form(), [k]: v })

  // ---- 多 API Key 编辑 ----
  const setKey = <K extends keyof ApiKeyEntry>(i: number, k: K, v: ApiKeyEntry[K]) => {
    const keys = form().api_keys.slice()
    keys[i] = { ...keys[i], [k]: v }
    set('api_keys', keys)
  }
  const addKey = () => set('api_keys', [...form().api_keys, { key: '', model: '', concurrency: 0 }])
  const delKey = (i: number) => set('api_keys', form().api_keys.filter((_, n) => n !== i))

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
    try {
      await api.saveConfig({
        ...form(),
        concurrency: Number(form().concurrency),
        max_segment_chars: Number(form().max_segment_chars),
        api_keys: form().api_keys
          .filter(k => k.key.trim())
          .map(k => ({ ...k, key: k.key.trim(), concurrency: Number(k.concurrency) || 0 })),
      })
      props.onClose(true)
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-10"
      onClick={(e) => e.target === e.currentTarget && props.onClose(false)}>
      <div class="bg-card rounded-[10px] p-[22px] w-[560px] max-w-[92vw] max-h-[88vh] overflow-y-auto">
        <h2 class="mb-3.5 text-[18px] font-bold">设置</h2>
        <div class="mb-1 flex items-center justify-between">
          <span class="text-[13px] text-muted">API Keys（可多个，请求自动分摊）</span>
          <button class="small" onClick={addKey}>+ 添加 Key</button>
        </div>
        <For each={form().api_keys}>
          {(k, i) => (
            <div class="border border-line rounded-[6px] p-2.5 mb-2">
              <div class="flex gap-2 items-center">
                <input class="flex-1 px-2.5 py-[7px] border border-line rounded-[6px] text-[14px]"
                  type="password" value={k.key} placeholder="sk-..."
                  onInput={(e) => setKey(i(), 'key', e.currentTarget.value)} />
                <button class="danger small shrink-0" onClick={() => delKey(i())}>删</button>
              </div>
              <div class="flex gap-2 mt-2">
                <input class="flex-1 px-2.5 py-[7px] border border-line rounded-[6px] text-[13px]"
                  value={k.model} placeholder={`统一模型：${form().model || 'deepseek-chat'}`}
                  onInput={(e) => setKey(i(), 'model', e.currentTarget.value)} />
                <input class="w-[130px] px-2.5 py-[7px] border border-line rounded-[6px] text-[13px]"
                  type="number" min="0" max="50" value={k.concurrency || ''}
                  placeholder={`统一并发：${form().concurrency}`}
                  title="并发数，留空或 0 表示跟随统一并发数"
                  onInput={(e) => setKey(i(), 'concurrency', e.currentTarget.valueAsNumber || 0)} />
              </div>
            </div>
          )}
        </For>
        <Show when={form().api_keys.length === 0}>
          <p class="text-muted text-[12px] mt-0 mb-2">尚未添加 API Key，翻译前请先添加。</p>
        </Show>
        <label class={LABEL}>API 地址
          <input class={INPUT} value={form().base_url || ''}
            onInput={(e) => set('base_url', e.currentTarget.value)} />
        </label>
        <label class={LABEL}>统一模型（各 Key 可单独覆盖）
          <input class={INPUT} value={form().model || ''}
            onInput={(e) => set('model', e.currentTarget.value)} />
        </label>
        <label class={LABEL}>目标语言
          <input class={INPUT} value={form().target_lang || ''}
            onInput={(e) => set('target_lang', e.currentTarget.value)} />
        </label>
        <label class={LABEL}>统一并发数：{form().concurrency}（各 Key 可单独覆盖）
          <input class={INPUT} type="range" min="1" max="20" step="1" value={form().concurrency}
            onInput={(e) => set('concurrency', e.currentTarget.value)} />
        </label>
        <label class={LABEL}>单段最大字符数（越大分段越少）
          <input class={INPUT} type="number" min="500" max="20000" value={form().max_segment_chars}
            onInput={(e) => set('max_segment_chars', e.currentTarget.value)} />
        </label>
        <label class="flex items-center gap-2 mb-3 text-[13px] text-muted cursor-pointer">
          <input type="checkbox" checked={form().webdav_enabled || false}
            onChange={(e) => set('webdav_enabled', e.currentTarget.checked)} />
          开启 WebDAV 书库（只读，供阅读软件访问）
        </label>
        {form().webdav_enabled && (
          <p class="mb-3 text-[12px] text-muted break-all">
            在阅读软件中添加 WebDAV 书库，地址：
            <code class="select-all">http://{location.hostname}:8300/webdav/</code>
            <br />已翻译的书籍会以 EPUB 形式出现在书库根目录。
            从手机等其他设备访问时，把主机名换成本机的局域网 IP。
          </p>
        )}
        <div class="border-t border-line pt-3 mt-1 mb-3">
          <div class="mb-2 flex items-center justify-between">
            <span class="text-[13px] text-muted">版本更新（GitHub）</span>
            <button class="small" disabled={updBusy()} onClick={checkUpdate}>
              {updBusy() && upd()?.status === 'checking' ? '检查中…' : '检查更新'}
            </button>
          </div>
          <label class={LABEL}>更新仓库（owner/repo，留空默认官方仓库）
            <input class={INPUT} value={form().update_repo || ''} placeholder="zilorn/transbook"
              onInput={(e) => set('update_repo', e.currentTarget.value)} />
          </label>
          <div class="flex gap-2">
            <label class={`${LABEL} flex-1`}>分支
              <input class={INPUT} value={form().update_branch || ''} placeholder="main"
                onInput={(e) => set('update_branch', e.currentTarget.value)} />
            </label>
            <label class={`${LABEL} flex-[2]`}>GitHub Token（私有仓库用，可留空）
              <input class={INPUT} type="password" value={form().github_token || ''}
                onInput={(e) => set('github_token', e.currentTarget.value)} />
            </label>
          </div>
          <Show when={upd()}>
            <p class="text-[12px] text-muted mb-2 break-all">
              当前版本 <code>{shortSha(upd()!.current_sha)}</code>
              <Show when={upd()!.remote_sha}>
                {' '}→ 最新 <code>{shortSha(upd()!.remote_sha)}</code>（{upd()!.remote_msg}）
              </Show>
              <br />上次检查：{fmtTime(upd()!.last_check)}（冷却 {upd()!.cooldown_min} 分钟内不重复请求）
              <Show when={upd()!.status === 'updating'}>
                <br />正在更新：下载源码并构建前端，完成后服务自动重启…
              </Show>
              <Show when={upd()!.status === 'restarting'}><br />正在重启服务…</Show>
              <Show when={upd()!.status === 'restart_required'}>
                <br />更新已应用，非 Docker 环境需手动重启服务生效。
              </Show>
            </p>
            <Show when={upd()!.update_available && !['updating', 'restarting'].includes(upd()!.status)}>
              <button class="primary small mb-2" disabled={updBusy()} onClick={applyUpdate}>
                {updBusy() ? '更新中…' : '立即更新'}
              </button>
            </Show>
          </Show>
        </div>
        {error() && <p class="text-danger text-[13px]">{error()}</p>}
        <div class="flex justify-end gap-2.5 mt-2">
          <button onClick={() => props.onClose(false)}>取消</button>
          <button class="primary" disabled={saving()} onClick={save}>
            {saving() ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
