import { motion } from 'framer-motion'

/** Three holds and the line between them — the route, as a mark. */
export function LogoMark({ size = 28, animate = false }: { size?: number; animate?: boolean }) {
  const d = (i: number) => (animate ? { initial: { scale: 0, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: { delay: 0.15 + i * 0.18, type: 'spring' as const, stiffness: 380, damping: 18 } } : {})
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="16" fill="url(#lg-bg)" />
      <defs>
        <linearGradient id="lg-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#15181d" />
          <stop offset="1" stopColor="#0a0b0d" />
        </linearGradient>
      </defs>
      <motion.path
        d="M19 49 C 24 40, 28 38, 31 31 S 38 20, 45 15"
        fill="none"
        stroke="#fff"
        strokeOpacity={0.85}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray="0.5 6"
        {...(animate ? { initial: { pathLength: 0 }, animate: { pathLength: 1 }, transition: { duration: 1.1, ease: 'easeInOut' } } : {})}
      />
      <motion.path d="M14 46c2-4 7-5 10-2s1 8-3 8-9-2-7-6z" fill="#E879F9" style={{ transformOrigin: '19px 47px' }} {...d(0)} />
      <motion.path d="M27 30c2-4 8-4 10 0s-1 7-5 7-7-3-5-7z" fill="#22D3EE" style={{ transformOrigin: '32px 32px' }} {...d(1)} />
      <motion.path d="M41 13c3-3 9-2 10 2s-3 7-7 6-6-5-3-8z" fill="#F5C542" style={{ transformOrigin: '45px 16px' }} {...d(2)} />
    </svg>
  )
}

export function Wordmark({ size = 18 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      CLIMBR
    </span>
  )
}
