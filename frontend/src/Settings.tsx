import { createSignal, For, Show } from 'solid-js'
import { api } from './api'
import type { ApiKeyEntry, Config } from './types'

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
