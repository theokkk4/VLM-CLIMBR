import { AnimatePresence, motion } from 'framer-motion'
import { Film, ScanLine } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { applyAffine, polygonPath } from '../lib/geometry'
import type { Player } from '../lib/player'
import type { Timeline } from '../lib/timeline'
import { LIMBS, ROUTE_COLORS, type Session, type Vec2 } from '../lib/types'
import { CompletionCard } from './CompletionCard'

export function VideoStage({ session: s, player, tl, t, showCard, onDismissCard }: { session: Session; player: Player; tl: Timeline; t: number; showCard: boolean; onDismissCard: () => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    player.attachVideo(ref.current)
    return () => player.attachVideo(null)
  }, [player])

  const v = s.video
  const aspect = v?.width && v?.height ? v.width / v.height : 9 / 16
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const toV = (p: Vec2): Vec2 => {
    const q = applyAffine(v?.affine, p)
    return [q[0] * 1000 * aspect, q[1] * 1000]
  }
  const drawOverlay = v && v.overlays !== 'burned-in'
  const lit = new Set(tl.litAt(t))
  const climbing = t >= 0 && t < tl.climbEnd

  return (
    <div className="video-stage">
      <div className="video-frame" style={{ aspectRatio: `${aspect}` }}>
        {v ? (
          <>
            <video ref={ref} poster={v.poster} muted playsInline preload="auto" className="video">
              <source src={v.src} type={v.src.endsWith('.webm') ? 'video/webm' : 'video/mp4'} />
              {v.webm && <source src={v.webm} type="video/webm" />}
            </video>
            {drawOverlay && (
              <svg className="video-overlay" viewBox={`0 0 ${1000 * aspect} 1000`} preserveAspectRatio="none">
                {s.holds.map((h) => (
                  <path key={h.id} d={polygonPath(h.polygon, toV)} fill={lit.has(h.id) ? route : 'none'} fillOpacity={0.45} stroke={route} strokeWidth={2.5} strokeOpacity={0.9} />
                ))}
                {LIMBS.map((l) => {
                  const st = tl.limbAt(l.key, Math.max(0, Math.min(t, tl.climbEnd)))
                  if (!st.holdId) return null
                  const [x, y] = toV(st.pos)
                  return <circle key={l.key} cx={x} cy={y} r={7} fill={l.color} stroke="#000" strokeWidth={2} />
                })}
              </svg>
            )}
          </>
        ) : s.wall ? (
          <img src={s.wall.src} className="video" alt="" />
        ) : (
          <div className="video-empty">
            <Film size={28} />
            <p>No video attached</p>
            <span>Drop the clip on Import to replay it in sync.</span>
          </div>
        )}
        <div className="vf-corners" aria-hidden><i /><i /><i /><i /></div>
        <div className="video-chips">
          <span className="chip glass"><ScanLine size={12} /> SAM 3.1 · {s.route.color} holds</span>
          <span className="chip glass">ViTPose+ · 17 joints</span>
        </div>
        <AnimatePresence>
          {climbing && (
            <motion.div className="rec" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <span className="rec-dot" /> TRACKING
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>{showCard && <motion.div className="video-dim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}</AnimatePresence>
      </div>
      <AnimatePresence>{showCard && <CompletionCard key="card" session={s} onClose={onDismissCard} />}</AnimatePresence>
    </div>
  )
}
