// 全局共享状态：配置与设置弹窗（供侧边栏布局与各路由页面使用）
import { createSignal } from 'solid-js'
import { api } from './api'
import type { Config } from './types'

export const [config, setConfig] = createSignal<Config | null>(null)
export const [settingsOpen, setSettingsOpen] = createSignal(false)

export async function loadConfig() {
  try {
    const c = await api.config()
    // 兼容旧后端/旧配置：api_keys 可能缺失
    c.api_keys = c.api_keys || []
    setConfig(c)
  } catch (e) { console.error(e) }
}
