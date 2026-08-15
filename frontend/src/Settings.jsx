import { createSignal } from 'solid-js'
import { api } from './api'

export default function Settings(props) {
  const [form, setForm] = createSignal({ ...props.config })
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal('')

  const set = (k, v) => setForm({ ...form(), [k]: v })

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
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="modal-mask" onClick={(e) => e.target === e.currentTarget && props.onClose(false)}>
      <div class="modal">
        <h2>设置</h2>
        <label>DeepSeek API Key
          <input type="password" value={form().api_key || ''}
            placeholder="sk-..."
            onInput={(e) => set('api_key', e.currentTarget.value)} />
        </label>
        <label>API 地址
          <input value={form().base_url || ''}
            onInput={(e) => set('base_url', e.currentTarget.value)} />
        </label>
        <label>模型
          <input value={form().model || ''}
            onInput={(e) => set('model', e.currentTarget.value)} />
        </label>
        <label>目标语言
          <input value={form().target_lang || ''}
            onInput={(e) => set('target_lang', e.currentTarget.value)} />
        </label>
        <label>并发数：{form().concurrency}
          <input type="range" min="1" max="20" step="1" value={form().concurrency}
            onInput={(e) => set('concurrency', e.currentTarget.value)} />
        </label>
        <label>单段最大字符数
          <input type="number" min="500" max="20000" value={form().max_segment_chars}
            onInput={(e) => set('max_segment_chars', e.currentTarget.value)} />
        </label>
        {error() && <p class="error">{error()}</p>}
        <div class="modal-actions">
          <button onClick={() => props.onClose(false)}>取消</button>
          <button class="primary" disabled={saving()} onClick={save}>
            {saving() ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
