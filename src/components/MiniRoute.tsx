import { motion } from 'framer-motion'
import { useId, useMemo } from 'react'
import { polygonPath, smoothPath } from '../lib/geometry'
import { GOLD, ROUTE_COLORS, type Session, type Vec2 } from '../lib/types'

/** A still route map: every hold, the given sequence lit and joined in order. */
export function MiniRoute({ session: s, sequence, color, animate = true, highlight = [], unique = [], loop = false, height = 260, body = false }: { session: Session; sequence: number[]; color?: string; animate?: boolean; highlight?: number[]; unique?: number[]; loop?: boolean; height?: number; body?: boolean }) {
  const aspect = s.canvas.width / s.canvas.height
  const route = color ?? ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const X = (p: Vec2): Vec2 => [p[0] * aspect * 1000, p[1] * 1000]
  const box = useMemo(() => {
    const pts = s.holds.flatMap((h) => h.polygon.map(X))
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    const pad = 40
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s])
  const byId = new Map(s.holds.map((h) => [h.id, h]))
  const path = sequence.map((id) => byId.get(id)).filter(Boolean).map((h) => X(h!.center))
  // `body`: draw the line the torso took instead of joining hold centres.
  const torso = body && s.torso ? s.torso.filter((p, i) => p[0] >= 0 && p[0] <= (s.elapsed ?? s.duration) && i % 3 === 0).map((p) => X([p[1], p[2]])) : null
  const d = torso && torso.length > 2 ? smoothPath(torso, (p) => p) : path.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')
  const k = box.h / height
  const maskId = `mr-${useId().replace(/:/g, '')}`
  const dur = 0.12
  return (
    <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} style={{ height, width: '100%' }} className="mini-route">
      {s.holds.map((h) => {
        const i = sequence.indexOf(h.id)
        const used = i >= 0
        const isTop = h.id === s.finalHoldId
        const fill = unique.includes(h.id) ? GOLD : isTop && used ? GOLD : route
        return (
          <motion.path
            key={h.id}
            d={polygonPath(h.polygon, X)}
            fill={used ? fill : 'transparent'}
            stroke={highlight.includes(h.id) ? '#fff' : used ? 'transparent' : 'rgba(255,255,255,0.25)'}
            strokeWidth={(highlight.includes(h.id) ? 2.5 : 1.2) * k}
            initial={animate && used ? { fillOpacity: 0 } : false}
            animate={{ fillOpacity: used ? 0.85 : 0 }}
            transition={animate ? { delay: 0.2 + i * dur, duration: 0.3, repeat: loop ? Infinity : 0, repeatDelay: loop ? sequence.length * dur + 1.6 : 0 } : undefined}
          />
        )
      })}
      {path.length > 1 && (
        <>
          {/* The dotted line is revealed by a mask: animating pathLength on the
              dotted path itself would replace its dash pattern. */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x={box.x} y={box.y} width={box.w} height={box.h}>
            <motion.path d={d} fill="none" stroke="#fff" strokeWidth={12 * k} strokeLinecap="round"
              initial={animate ? { pathLength: 0 } : false} animate={{ pathLength: 1 }} transition={{ duration: sequence.length * dur, delay: 0.2, ease: 'linear', repeat: loop ? Infinity : 0, repeatDelay: loop ? 1.9 : 0 }} />
          </mask>
          <path d={d} fill="none" stroke="#fff" strokeOpacity={0.9} strokeWidth={2.4 * k} strokeDasharray={`${0.1 * k} ${5.5 * k}`} strokeLinecap="round" mask={`url(#${maskId})`} />
          {!torso && path.map((p, i) => (
            <motion.circle key={i} cx={p[0]} cy={p[1]} r={2.4 * k} fill="#fff" initial={animate ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={animate ? { delay: 0.2 + i * dur, repeat: loop ? Infinity : 0, repeatDelay: loop ? sequence.length * dur + 1.6 : 0 } : undefined} />
          ))}
        </>
      )}
    </svg>
  )
}
