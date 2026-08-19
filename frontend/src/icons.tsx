// 通用小图标（lucide 风格，stroke=currentColor），供各页面的图标按钮复用

type IconProps = { class?: string }

const BASE = 'w-[14px] h-[14px] shrink-0'

export function IconBack(props: IconProps) {
  return (
    <svg class={props.class ?? BASE} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  )
}

export function IconTrash(props: IconProps) {
  return (
    <svg class={props.class ?? BASE} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  )
}

export function IconX(props: IconProps) {
  return (
    <svg class={props.class ?? BASE} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
