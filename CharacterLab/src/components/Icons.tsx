import type { ReactNode } from 'react'

/** 内联矢量图标（无外部资源），线性风格，随 currentColor 着色 */
const PATHS: Record<string, ReactNode> = {
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />,
  skipBack: (
    <>
      <path d="M18.5 5.5v13L9 12z" fill="currentColor" stroke="none" />
      <path d="M6.5 5.5v13" />
    </>
  ),
  loop: (
    <>
      <path d="M17 2.5l3.5 3.5L17 9.5" />
      <path d="M3.5 11.5V10a4 4 0 014-4h13" />
      <path d="M7 21.5L3.5 18 7 14.5" />
      <path d="M20.5 12.5V14a4 4 0 01-4 4h-13" />
    </>
  ),
  scissors: (
    <>
      <circle cx="6" cy="6.5" r="2.6" />
      <circle cx="6" cy="17.5" r="2.6" />
      <path d="M8.2 8.4L20 20M8.2 15.6L20 4M12.8 13.2l1.5 1.4" />
    </>
  ),
  undo: (
    <>
      <path d="M3.5 7v6h6" />
      <path d="M20.5 17a8.5 8.5 0 00-14.5-6L3.5 13" />
    </>
  ),
  redo: (
    <>
      <path d="M20.5 7v6h-6" />
      <path d="M3.5 17a8.5 8.5 0 0114.5-6l2.5 2" />
    </>
  ),
  trash: (
    <>
      <path d="M3.5 6.5h17M8.5 6.5V4.2A1.2 1.2 0 019.7 3h4.6a1.2 1.2 0 011.2 1.2v2.3" />
      <path d="M18.8 6.5L18 19.4a1.6 1.6 0 01-1.6 1.6H7.6A1.6 1.6 0 016 19.4L5.2 6.5" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  download: (
    <>
      <path d="M20.5 15v3.5a2 2 0 01-2 2h-13a2 2 0 01-2-2V15" />
      <path d="M7.5 10.5L12 15l4.5-4.5M12 15V3.5" />
    </>
  ),
  save: (
    <>
      <path d="M18.5 20.5h-13a2 2 0 01-2-2v-13a2 2 0 012-2h9.5l5.5 5.5v9.5a2 2 0 01-2 2z" />
      <path d="M16.5 20.5V13h-9v7.5M7.5 3.5V8h7" />
    </>
  ),
  camera: (
    <>
      <path d="M21.5 18a2 2 0 01-2 2h-15a2 2 0 01-2-2V9a2 2 0 012-2h3l2-2.5h5L16.5 7h3a2 2 0 012 2z" />
      <circle cx="12" cy="13.4" r="3.6" />
    </>
  ),
  frame: (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
      <path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17" />
    </>
  ),
  bone: (
    <>
      <path d="M17.6 4a2.6 2.6 0 00-2.4 3.7L8 14.9A2.6 2.6 0 104.5 18a2.6 2.6 0 103.4-3.4l7.2-7.2A2.6 2.6 0 1017.6 4z" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="6.4" r="3.4" />
      <path d="M4.8 21v-.8a7.2 7.2 0 0114.4 0v.8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  move: (
    <>
      <path d="M12 2.5v19M2.5 12h19" />
      <path d="M9.2 5l2.8-2.8L14.8 5M9.2 19l2.8 2.8L14.8 19M5 9.2L2.2 12 5 14.8M19 9.2l2.8 2.8L19 14.8" />
    </>
  ),
  rotate: (
    <>
      <path d="M20.5 12a8.5 8.5 0 11-2.8-6.3" />
      <path d="M20.5 2.5v5h-5" />
    </>
  ),
  resize: (
    <>
      <path d="M14 3.5h6.5V10M20.5 3.5L13 11" />
      <path d="M10 20.5H3.5V14M3.5 20.5L11 13" />
    </>
  ),
  cursor: <path d="M5 4l6.8 15.5 2-6.7 6.7-2z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  folder: (
    <path d="M21.5 18.5a2 2 0 01-2 2h-15a2 2 0 01-2-2v-13a2 2 0 012-2h4.5l2 2.6h8.5a2 2 0 012 2z" />
  ),
  upload: (
    <>
      <path d="M20.5 15v3.5a2 2 0 01-2 2h-13a2 2 0 01-2-2V15" />
      <path d="M7.5 8L12 3.5 16.5 8M12 3.5V15" />
    </>
  ),
  film: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M8 3.5v17M16 3.5v17M3.5 8H8M3.5 16H8M16 8h4.5M16 16h4.5" />
    </>
  ),
  cube: (
    <>
      <path d="M20.5 16.2V7.8a1.8 1.8 0 00-.9-1.6l-6.7-3.8a1.8 1.8 0 00-1.8 0L4.4 6.2a1.8 1.8 0 00-.9 1.6v8.4a1.8 1.8 0 00.9 1.6l6.7 3.8a1.8 1.8 0 001.8 0l6.7-3.8a1.8 1.8 0 00.9-1.6z" />
      <path d="M3.8 6.9l8.2 4.7 8.2-4.7M12 21.5v-9.9" />
    </>
  ),
  layers: (
    <>
      <path d="M12 2.5L2.5 7.5 12 12.5l9.5-5z" />
      <path d="M2.5 12l9.5 5 9.5-5M2.5 16.5l9.5 5 9.5-5" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 13.5a5 5 0 007.6.6l2.6-2.6a5 5 0 00-7-7.2L11 6" />
      <path d="M14.5 10.5a5 5 0 00-7.6-.6l-2.6 2.6a5 5 0 007 7.2L13 18" />
    </>
  ),
  mirror: (
    <>
      <path d="M12 2.5v19" strokeDasharray="2.5 2.5" />
      <path d="M8 7.5L3.5 12 8 16.5M16 7.5l4.5 4.5-4.5 4.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  check: <path d="M20 6.5L9.5 17 4 11.5" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  edit: (
    <>
      <path d="M12.5 5.5l6 6L8 22H2v-6z" transform="scale(0.92) translate(1,-1)" />
      <path d="M15 3l6 6" />
    </>
  ),
  export: (
    <>
      <path d="M4 13v5.5a2 2 0 002 2h12a2 2 0 002-2V13" />
      <path d="M7.5 7L12 2.5 16.5 7M12 2.5V15" />
    </>
  ),
  ground: (
    <>
      <path d="M3.5 20.5h17" />
      <path d="M12 3.5v12M7.5 11L12 15.5 16.5 11" />
    </>
  ),
  ruler: (
    <>
      <path d="M4 20.5L20.5 4" />
      <path d="M2.5 17.5L6.5 21.5 21.5 6.5 17.5 2.5 2.5 17.5z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 018 0v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 017.7-1.5" />
    </>
  ),
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 15 }: { name: IconName | string; size?: number }) {
  const content = PATHS[name]
  if (!content) return null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {content}
    </svg>
  )
}
