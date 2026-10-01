import { motion } from 'framer-motion'
import type { Attempt, Session } from '../lib/types'
import { GOLD } from '../lib/types'

function uniqueTo(attempts: Attempt[]) {
  const count = new Map<number, number>()
  for (const a of attempts) for (const id of new Set(a.sequence)) count.set(id, (count.get(id) ?? 0) + 1)
  return (id: number) => attempts.length > 1 && count.get(id) === 1
}

export function SequenceChips({ seq, unique, delay = 0, size = 'lg', label }: { seq: number[]; unique?: (id: number) => boolean; delay?: number; size?: 'lg' | 'md' | 'sm'; label?: (id: number) => string }) {
  return (
    <div className={`seq seq-${size}`}>
      {seq.map((id, i) => (
        <motion.span key={`${id}-${i}`} className="seq-item" initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ delay: delay + i * 0.045, duration: 0.35 }}>
          {i > 0 && <span className="seq-sep">›</span>}
          <span className="seq-id" style={unique?.(id) ? { color: GOLD } : undefined}>{label ? label(id) : id}</span>
        </motion.span>
      ))}
    </div>
  )
}

export function CompletionCard({ session: s, onClose }: { session: Session; onClose?: () => void }) {
  const attempts = s.comparison?.attempts ?? []
  const mine = attempts.find((a) => a.isThis)
  const others = attempts
    .filter((a) => !a.isThis)
    .sort((a, b) => Number(!a.toppedOut) - Number(!b.toppedOut) || a.sequence.length - b.sequence.length || (a.elapsed ?? 1e9) - (b.elapsed ?? 1e9))
  const uniq = uniqueTo(attempts)
  const badges = [mine && s.comparison?.shortest === mine.label ? 'SHORTEST' : null, mine && s.comparison?.fastest === mine.label ? 'FASTEST' : null].filter(Boolean).join(' + ')
  return (
    <motion.div className="completion" initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }} onClick={onClose}>
      <motion.h2 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
        {s.toppedOut ? <>Completed in {s.elapsed?.toFixed(2)}s!</> : <>Not topped out — yet.</>}
      </motion.h2>
      <motion.p className="completion-meta" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
        {s.route.color} · {s.holdsDetected} holds on the route{attempts.length ? ` · ${attempts.length} attempts` : ''}
      </motion.p>

      <h3 className="completion-h">This climb</h3>
      <div className="attempt-row">
        <div className="attempt-head">
          <span className="attempt-name">{mine ? `Attempt ${mine.index}` : 'This attempt'}</span>
          {badges && <motion.span className="badge-gold" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.5, type: 'spring', stiffness: 500, damping: 20 }}>{badges}</motion.span>}
          <span className="attempt-stat">{s.sequence.length} holds · {s.elapsed != null ? `${s.elapsed.toFixed(2)}s` : '—'}</span>
        </div>
        <SequenceChips seq={s.sequence} delay={0.3} />
      </div>

      {others.length > 0 && (
        <>
          <div className="completion-h-row">
            <h3 className="completion-h">Other attempts</h3>
            <span className="muted xs">same route</span>
          </div>
          {others.map((a, i) => (
            <motion.div key={a.label} className="attempt-row" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.55 + i * 0.12 }}>
              <div className="attempt-head">
                <span className="attempt-name dim">Attempt {a.index}</span>
                <span className="attempt-stat">{a.sequence.length} holds · {a.elapsed != null ? `${a.elapsed.toFixed(2)}s` : 'no top'}</span>
              </div>
              <SequenceChips seq={a.sequence} unique={uniq} delay={0.6 + i * 0.12} size="md" />
            </motion.div>
          ))}
          <div className="legend-unique"><span className="sq" /> unique to that attempt</div>
        </>
      )}
    </motion.div>
  )
}
