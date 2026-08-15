import { createSignal } from 'solid-js'
import { api } from './api'
import type { Config } from './types'

// 表单编辑过程中数字字段可能是字符串（保存时再 Number 转换）
type ConfigForm = Omit<Config, 'concurrency' | 'max_segment_chars'> & {
  concurrency: number | string
  max_segment_chars: number | string
}

// 原 .modal label / .modal input 样式
const LABEL = 'block mb-3 text-[13px] text-muted'
const INPUT = 'w-full mt-1 px-2.5 py-[7px] border border-line rounded-[6px] text-[14px]'

export default function Settings(props: { config: Config; onClose: (saved: boolean) => void }) {
  const [form, setForm] = createSignal<ConfigForm>({ ...props.config })
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal('')

  const set = <K extends keyof ConfigForm>(k: K, v: ConfigForm[K]) => setForm({ ...form(), [k]: v })

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await api.saveConfig({
        ...form(),
        concurrency: Number(form().concurrency),
        max_segment_chars: Number(form().max_segment_chars),
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
      <div class="bg-card rounded-[10px] p-[22px] w-[420px] max-w-[92vw]">
        <h2 class="mb-3.5 text-[18px] font-bold">设置</h2>
        <label class={LABEL}>DeepSeek API Key
          <input class={INPUT} type="password" value={form().api_key || ''}
            placeholder="sk-..."
            onInput={(e) => set('api_key', e.currentTarget.value)} />
        </label>
        <label class={LABEL}>API 地址
          <input class={INPUT} value={form().base_url || ''}
            onInput={(e) => set('base_url', e.currentTarget.value)} />
        </label>
        <label class={LABEL}>模型
          <input class={INPUT} value={form().model || ''}
            onInput={(e) => set('model', e.currentTarget.value)} />
        </label>
        <label class={LABEL}>目标语言
          <input class={INPUT} value={form().target_lang || ''}
            onInput={(e) => set('target_lang', e.currentTarget.value)} />
        </label>
        <label class={LABEL}>并发数：{form().concurrency}
          <input class={INPUT} type="range" min="1" max="20" step="1" value={form().concurrency}
            onInput={(e) => set('concurrency', e.currentTarget.value)} />
        </label>
        <label class={LABEL}>单段最大字符数
          <input class={INPUT} type="number" min="500" max="20000" value={form().max_segment_chars}
            onInput={(e) => set('max_segment_chars', e.currentTarget.value)} />
        </label>
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
