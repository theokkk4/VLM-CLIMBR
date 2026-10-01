import { AnimatePresence, motion } from 'framer-motion'
import type { Timeline } from '../lib/timeline'
import { GOLD, LIMBS, LIMB_BY_KEY, ROUTE_COLORS, type Session } from '../lib/types'

export function LivePanel({ session: s, tl, t, letters, onSeek }: { session: Session; tl: Timeline; t: number; letters?: boolean; onSeek: (t: number) => void }) {
  const T = Math.max(0, Math.min(t, tl.climbEnd))
  const done = s.toppedOut && t >= tl.climbEnd
  const started = t >= 0
  const clock = started ? T : 0
  const lit = tl.litAt(T)
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const recent = s.moves.filter((m) => m.time <= T).slice(-4).reverse()
  const L = (id: number) => tl.label(id, letters)

  return (
    <div className="live">
      <div className="card clock-card">
        <div className="clock-top">
          <span className="kicker">{done ? 'Topped out' : started ? 'On the wall' : 'Pulling on'}</span>
          <span className={`state-pill ${done ? 'done' : started ? 'live' : ''}`}>
            <span className="dot" /> {done ? 'SENT' : started ? 'CLIMBING' : 'READY'}
          </span>
        </div>
        <div className="clock">
          <span className="clock-num">{clock.toFixed(2).padStart(5, '0')}</span>
          <span className="clock-unit">s</span>
        </div>
        <div className="clock-bar">
          <motion.div className="clock-fill" style={{ width: `${(T / Math.max(0.01, tl.climbEnd)) * 100}%`, background: done ? GOLD : route }} />
        </div>
        <div className="clock-meta">
          <span><b>{lit.length}</b>/{s.holdsDetected} holds</span>
          <span><b>{s.moves.filter((m) => m.time <= T).length}</b> moves</span>
          <span><b>{s.climber}</b></span>
        </div>
      </div>

      <div className="card">
        <div className="limb-head">
          <span className="kicker">On a hold</span>
          <span className="kicker">Holds used, in order</span>
        </div>
        {LIMBS.map((l) => {
          const cov = tl.coverageAt(l.key, T)
          const seq = tl.sequenceAt(l.key, T)
          const now = tl.limbAt(l.key, T)
          return (
            <div key={l.key} className={`limb-row ${now.moving && started && !done ? 'moving' : ''}`}>
              <span className="limb-sw" style={{ background: l.color }} />
              <span className="limb-name">{l.name}</span>
              <span className="limb-bar"><span style={{ width: `${cov * 100}%`, background: l.color }} /></span>
              <span className="limb-pct">{Math.round(cov * 100)}%</span>
              <span className="limb-seq" style={{ color: l.color }}>
                <AnimatePresence initial={false}>
                  {seq.map((id, i) => (
                    <motion.span key={`${id}-${i}`} initial={{ opacity: 0, scale: 0.4, y: 4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 26 }}>
                      {L(id)}
                    </motion.span>
                  ))}
                </AnimatePresence>
              </span>
            </div>
          )
        })}
      </div>

      <div className="card">
        <div className="limb-head"><span className="kicker">Sequence</span><span className="kicker dim">{lit.length} of {s.sequence.length}</span></div>
        <div className="route-seq">
          {s.sequence.map((id, i) => {
            const on = lit.includes(id)
            const first = tl.firstUse.get(id)
            const color = id === s.finalHoldId && done ? GOLD : first ? LIMB_BY_KEY[first.limb].color : '#fff'
            return (
              <button key={id} className={`rs-chip ${on ? 'on' : ''}`} style={on ? { color, borderColor: color, boxShadow: `0 0 18px -6px ${color}` } : undefined} onClick={() => first && onSeek(first.time)}>
                <i>{i + 1}</i>{L(id)}
              </button>
            )
          })}
        </div>
      </div>

      <div className="card feed">
        <span className="kicker">Latest moves</span>
        <div className="feed-list">
          <AnimatePresence initial={false}>
            {recent.length === 0 && <motion.p key="none" className="muted xs" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>Waiting for the first placement…</motion.p>}
            {recent.map((m) => {
              const l = LIMB_BY_KEY[m.limb]
              return (
                <motion.button key={`${m.limb}-${m.holdId}-${m.time}`} layout className="feed-item" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ type: 'spring', stiffness: 500, damping: 36 }} onClick={() => onSeek(m.time)}>
                  <span className="feed-limb" style={{ background: l.color }}>{l.label}</span>
                  <span className="feed-text">{l.name} → <b>{L(m.holdId)}</b></span>
                  <span className="feed-t">{m.time.toFixed(2)}s</span>
                </motion.button>
              )
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
