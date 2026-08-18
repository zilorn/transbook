import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { api } from './api'
import type { UpdateStatus } from './types'

// 进入页面时检查一次更新（后端有冷却，不会频繁请求 GitHub）；
// 发现更新时弹窗提示，用户点击「立即更新」后才执行下载/构建/重启。
const STATUS_TEXT: Record<string, string> = {
  checking: '正在检查更新…',
  updating: '正在下载源码并构建前端，可能需要几分钟…',
  restarting: '更新完成，正在重启服务…',
}

const short = (s?: string | null) => (s || '').slice(0, 8) || '未知'

export default function UpdatePrompt() {
  const [st, setSt] = createSignal<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = createSignal(false)
  const [applying, setApplying] = createSignal(false)
  const [done, setDone] = createSignal(false)
  const [err, setErr] = createSignal('')

  onMount(async () => {
    try {
      setSt(await api.updateCheck())
    } catch { /* 检查失败静默，不打扰使用 */ }
  })

  let timer: number | undefined
  const stopPoll = () => { if (timer) { clearInterval(timer); timer = undefined } }
  onCleanup(stopPoll)

  const poll = () => {
    stopPoll()
    timer = window.setInterval(async () => {
      try {
        const s = await api.updateStatus()
        setSt(s)
        if (s.status === 'error') {
          setErr(s.error || '更新失败')
          setApplying(false)
          stopPoll()
        } else if (s.status === 'restart_required') {
          setApplying(false)
          stopPoll()
        } else if (s.status === 'idle' && !s.update_available) {
          // 重启完成：远端 commit 已与本地一致
          setDone(true)
          setApplying(false)
          stopPoll()
        }
      } catch { /* 服务重启中，请求失败属正常，继续轮询 */ }
    }, 2000)
  }

  const apply = async () => {
    setErr('')
    setApplying(true)
    try {
      const s = await api.updateApply()
      setSt(s)
      if (s.status === 'error') {
        setErr(s.error || '更新失败')
        setApplying(false)
        return
      }
      if (s.status === 'idle') {
        setApplying(false) // 已是最新
        setDismissed(true)
        return
      }
      poll()
    } catch (e: any) {
      setErr(String(e.message || e))
      setApplying(false)
    }
  }

  const visible = () => {
    const s = st()
    if (!s || dismissed()) return false
    return s.update_available || applying() || done() ||
      s.status === 'restarting' || s.status === 'restart_required'
  }

  return (
    <Show when={visible()}>
      <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-30">
        <div class="bg-card rounded-[10px] p-[22px] w-[420px] max-w-[92vw]">
          <h2 class="mb-3 text-[16px] font-bold">发现新版本</h2>
          <Show when={!applying() && !done() && st()!.status !== 'restarting' && st()!.status !== 'restart_required'}>
            <p class="text-[13px] text-muted mb-1 break-all">
              {st()!.remote_msg || '远程仓库有新的提交'}
            </p>
            <p class="text-[12px] text-muted mb-4">
              当前版本 <code>{short(st()!.current_sha)}</code> → 最新版本 <code>{short(st()!.remote_sha)}</code>
            </p>
            {err() && <p class="text-danger text-[13px] mb-2">{err()}</p>}
            <div class="flex justify-end gap-2.5">
              <button onClick={() => setDismissed(true)}>暂不更新</button>
              <button class="primary" onClick={apply}>立即更新</button>
            </div>
          </Show>
          <Show when={applying() || st()!.status === 'restarting'}>
            <p class="text-[13px] text-muted mb-2">
              {STATUS_TEXT[st()!.status] || '正在更新…'}
            </p>
            <p class="text-[12px] text-muted">期间服务可能短暂不可用，请勿关闭页面。</p>
          </Show>
          <Show when={st()!.status === 'restart_required'}>
            <p class="text-[13px] text-muted mb-4">
              更新已应用，但当前不是 Docker 部署，需要手动重启服务后生效。
            </p>
            <div class="flex justify-end">
              <button class="primary" onClick={() => setDismissed(true)}>知道了</button>
            </div>
          </Show>
          <Show when={done()}>
            <p class="text-[13px] text-muted mb-4">服务已重启并运行最新版本，刷新页面即可使用。</p>
            <div class="flex justify-end">
              <button class="primary" onClick={() => location.reload()}>刷新页面</button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}
