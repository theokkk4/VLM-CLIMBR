import { AnimatePresence, motion } from 'framer-motion'
import { Film, ScanLine } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { polygonPath } from '../lib/geometry'
import { LIMB_JOINT, overlayAt } from '../lib/overlay'
import type { Player } from '../lib/player'
import { BONES, DRAW_MIN_CONFIDENCE } from '../lib/skeleton'
import type { Timeline } from '../lib/timeline'
import { LIMBS, LIMB_BY_KEY, ROUTE_COLORS, type Session, type Vec2 } from '../lib/types'
import { CompletionCard } from './CompletionCard'

export function VideoStage({ session: s, player, tl, t, showCard, onDismissCard }: { session: Session; player: Player; tl: Timeline; t: number; showCard: boolean; onDismissCard: () => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    player.attachVideo(ref.current)
    return () => player.attachVideo(null)
  }, [player])

  const v = s.video
  // The overlay is drawn in the video's own pixels, letterboxed exactly as the
  // video is (object-fit: contain ↔ preserveAspectRatio meet), so it stays on
  // the picture whatever shape the box is.
  const aspect = v?.width && v?.height ? v.width / v.height : null
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const toV = (q: Vec2): Vec2 => [q[0] * 1000 * aspect!, q[1] * 1000]
  const ov = overlayAt(s, tl, t)
  const climbing = t >= 0 && t < tl.climbEnd

  return (
    <div className="video-stage">
      <div className="video-frame" style={{ aspectRatio: `${aspect ?? 9 / 16}` }}>
        {v ? (
          <>
            <video ref={ref} poster={v.poster} muted playsInline preload="auto" className="video">
              <source src={v.src} type={v.src.endsWith('.webm') ? 'video/webm' : 'video/mp4'} />
              {v.webm && <source src={v.webm} type="video/webm" />}
            </video>
            {ov && (
              <svg className="video-overlay" viewBox={`0 0 ${1000 * aspect!} 1000`} preserveAspectRatio="xMidYMid meet">
                {ov.holds.map((h) => (
                  <path key={h.id} d={polygonPath(h.poly, toV)} fill={h.lit ? route : 'none'} fillOpacity={h.held ? 0.6 : 0.4} stroke={h.held ? '#fff' : route} strokeWidth={h.held ? 3.5 : 2.5} strokeOpacity={0.95} strokeLinejoin="round" />
                ))}
                {ov.joints && (
                  <g className="pose">
                    {BONES.map(([a, b]) => ov.joints![a].c >= DRAW_MIN_CONFIDENCE && ov.joints![b].c >= DRAW_MIN_CONFIDENCE && (
                      <line key={`${a}-${b}`} x1={toV(ov.joints![a].p)[0]} y1={toV(ov.joints![a].p)[1]} x2={toV(ov.joints![b].p)[0]} y2={toV(ov.joints![b].p)[1]} stroke="#fff" strokeOpacity={0.85} strokeWidth={3} strokeLinecap="round" />
                    ))}
                    {ov.joints.map((j, i) => j.c >= DRAW_MIN_CONFIDENCE && i > 4 && !Object.values(LIMB_JOINT).includes(i) && (
                      <circle key={i} cx={toV(j.p)[0]} cy={toV(j.p)[1]} r={4} fill="#fff" />
                    ))}
                    {LIMBS.map((l) => {
                      const j = ov.joints![LIMB_JOINT[l.key]]
                      if (j.c < DRAW_MIN_CONFIDENCE) return null
                      const [x, y] = toV(j.p)
                      return <circle key={l.key} cx={x} cy={y} r={ov.holding.get(l.key) != null ? 10 : 6.5} fill={l.color} stroke="#000" strokeWidth={2} />
                    })}
                  </g>
                )}
                {ov.fallbackLimbs.map(({ key, p }) => {
                  const [x, y] = toV(p)
                  return <circle key={key} cx={x} cy={y} r={7} fill={LIMB_BY_KEY[key].color} stroke="#000" strokeWidth={2} />
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
            <span>Import the clip to replay it in sync.</span>
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
