import { motion } from 'framer-motion'
import { Timer, Trophy, Waypoints } from 'lucide-react'
import { useState } from 'react'
import { SequenceChips } from '../components/CompletionCard'
import { MiniRoute } from '../components/MiniRoute'
import { holdLetter } from '../lib/geometry'
import { GOLD, ROUTE_COLORS, type Session } from '../lib/types'

const PALETTE = ['#22D3EE', '#4ADE80', '#E879F9', '#FB7185', '#F5C542', '#6366F1']

export function AttemptsView({ session: s, letters }: { session: Session; letters?: boolean }) {
  const [hover, setHover] = useState<string | null>(null)
  const c = s.comparison
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const L = (id: number) => (letters ? holdLetter(id) : String(id))
  if (!c?.attempts.length) {
    return (
      <div className="empty-state">
        <Waypoints size={28} />
        <h3>One attempt so far</h3>
        <p>Run several clips of the same route through vision-demos (batch mode) and drop the folder’s <code>comparison.json</code> here to compare your beta across attempts.</p>
        <div className="attempt-solo card"><SequenceChips seq={s.sequence} label={L} /></div>
      </div>
    )
  }
  const attempts = [...c.attempts].sort((a, b) => a.index - b.index)
  const maxT = Math.max(...attempts.map((a) => a.elapsed ?? 0), 1)
  const count = new Map<number, number>()
  for (const a of attempts) for (const id of new Set(a.sequence)) count.set(id, (count.get(id) ?? 0) + 1)
  const uniqueOf = (seq: number[]) => seq.filter((id) => count.get(id) === 1)
  const columns = [...count.keys()].sort((a, b) => a - b)
  const best = attempts.filter((a) => a.elapsed != null).sort((a, b) => a.elapsed! - b.elapsed!)[0]
  const shortest = [...attempts].sort((a, b) => a.sequence.length - b.sequence.length)[0]
  const shared = columns.filter((id) => count.get(id) === attempts.length)
  const color = (i: number) => PALETTE[i % PALETTE.length]

  return (
    <div className="attempts">
      <div className="att-stats">
        {[
          { icon: <Trophy size={16} />, k: 'Fastest send', v: best ? `${best.elapsed!.toFixed(2)} s` : '—', sub: best ? `Attempt ${best.index}` : '' },
          { icon: <Waypoints size={16} />, k: 'Shortest beta', v: `${shortest.sequence.length} holds`, sub: `Attempt ${shortest.index}` },
          { icon: <Timer size={16} />, k: 'Average', v: `${(attempts.reduce((t, a) => t + (a.elapsed ?? 0), 0) / attempts.length).toFixed(2)} s`, sub: `${attempts.length} attempts` },
          { icon: <span className="dot-route" style={{ background: route }} />, k: 'Shared by every attempt', v: `${shared.length} holds`, sub: shared.map(L).join(' · ') },
        ].map((x, i) => (
          <motion.div key={x.k} className="card stat" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}>
            <span className="stat-k">{x.icon}{x.k}</span>
            <b className="stat-v">{x.v}</b>
            <span className="stat-sub">{x.sub}</span>
          </motion.div>
        ))}
      </div>

      <div className="att-grid">
        <div className="card att-bars">
          <div className="limb-head"><span className="kicker">Time to top</span><span className="kicker dim">seconds</span></div>
          {attempts.map((a, i) => (
            <div key={a.label} className={`att-bar-row ${a.isThis ? 'this' : ''} ${hover === a.label ? 'hover' : ''}`} onMouseEnter={() => setHover(a.label)} onMouseLeave={() => setHover(null)}>
              <span className="att-name"><i style={{ background: color(i) }} />Attempt {a.index}{a.isThis && <em>this climb</em>}</span>
              <span className="att-track">
                <motion.span className="att-fill" style={{ background: color(i) }} initial={{ width: 0 }} animate={{ width: `${((a.elapsed ?? 0) / maxT) * 100}%` }} transition={{ delay: 0.15 + i * 0.08, type: 'spring', stiffness: 120, damping: 20 }} />
              </span>
              <span className="att-val">{a.elapsed != null ? a.elapsed.toFixed(2) : '—'}</span>
              <span className="att-badges">
                {c.fastest === a.label && <span className="badge-gold">FASTEST</span>}
                {c.shortest === a.label && <span className="badge-gold">SHORTEST</span>}
              </span>
            </div>
          ))}

          <div className="limb-head" style={{ marginTop: 22 }}><span className="kicker">Beta matrix</span><span className="kicker dim">order each hold was reached</span></div>
          <div className="matrix" style={{ gridTemplateColumns: `110px repeat(${columns.length}, 1fr)` }}>
            <span />
            {columns.map((id) => <span key={id} className={`mx-head ${count.get(id) === attempts.length ? 'shared' : ''}`}>{L(id)}</span>)}
            {attempts.map((a, i) => (
              <div key={a.label} className={`mx-row ${hover === a.label ? 'hover' : ''}`} style={{ display: 'contents' }} onMouseEnter={() => setHover(a.label)} onMouseLeave={() => setHover(null)}>
                <span className="mx-label"><i style={{ background: color(i) }} />Attempt {a.index}</span>
                {columns.map((id) => {
                  const k = a.sequence.indexOf(id)
                  const uniq = k >= 0 && count.get(id) === 1
                  return (
                    <motion.span key={id} className={`mx-cell ${k >= 0 ? 'on' : ''}`} style={k >= 0 ? { background: uniq ? GOLD : color(i), color: '#0a0b0d' } : undefined} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.3 + i * 0.05 + columns.indexOf(id) * 0.01 }}>
                      {k >= 0 ? k + 1 : ''}
                    </motion.span>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="legend-unique"><span className="sq" /> only that attempt used this hold · <b>bold</b> columns: every attempt</div>
        </div>

        <div className="att-maps">
          {attempts.map((a, i) => (
            <motion.div key={a.label} className={`card att-map ${a.isThis ? 'this' : ''} ${hover === a.label ? 'hover' : ''}`} onMouseEnter={() => setHover(a.label)} onMouseLeave={() => setHover(null)} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + i * 0.08 }}>
              <div className="att-map-head">
                <span><i style={{ background: color(i) }} />Attempt {a.index}</span>
                <span className="muted xs">{a.sequence.length} holds · {a.elapsed?.toFixed(2) ?? '—'} s</span>
              </div>
              <MiniRoute session={s} sequence={a.sequence} color={color(i)} unique={uniqueOf(a.sequence)} height={230} />
              <SequenceChips seq={a.sequence} size="sm" unique={(id) => count.get(id) === 1} label={L} delay={0.3} />
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  )
}
