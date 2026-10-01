import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { ArrowUpRight, Cpu, Dumbbell, Flag, Lightbulb, RefreshCw, Sparkles, Target, ThumbsUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { MiniRoute } from '../components/MiniRoute'
import { toast } from '../components/Toast'
import type { Health } from '../lib/api'
import { computeInsights, onDeviceFeedback, requestVlmCoach } from '../lib/coach'
import { ROUTE_COLORS, type CoachFeedback, type Session } from '../lib/types'

function ScoreRing({ score, color }: { score: number; color: string }) {
  const v = useMotionValue(0)
  const shown = useTransform(v, (x) => Math.round(x))
  const [n, setN] = useState(0)
  useEffect(() => {
    const c = animate(v, score, { duration: 1.4, ease: [0.16, 1, 0.3, 1] })
    const u = shown.on('change', setN)
    return () => { c.stop(); u() }
  }, [score, v, shown])
  const r = 74, C = 2 * Math.PI * r
  return (
    <div className="ring">
      <svg viewBox="0 0 180 180">
        <defs>
          <linearGradient id="ring-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={color} />
            <stop offset="1" stopColor="#22D3EE" />
          </linearGradient>
        </defs>
        <circle cx="90" cy="90" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="12" />
        <motion.circle cx="90" cy="90" r={r} fill="none" stroke="url(#ring-g)" strokeWidth="12" strokeLinecap="round" transform="rotate(-90 90 90)"
          strokeDasharray={C} initial={{ strokeDashoffset: C }} animate={{ strokeDashoffset: C * (1 - score / 100) }} transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1] }} />
      </svg>
      <div className="ring-num"><b>{n}</b><span>coach score</span></div>
    </div>
  )
}

const STEPS = ['Packing the climb’s measurements', 'Pulling keyframes from your clip', 'The VLM is studying your movement', 'Writing your feedback']

export function CoachView({ session: s, health, onUpdate, onSeek, onHighlight }: { session: Session; health: Health | null; onUpdate: (s: Session) => void; onSeek: (t: number) => void; onHighlight: (ids: number[]) => void }) {
  const local = useMemo(() => onDeviceFeedback(s), [s])
  const insights = useMemo(() => computeInsights(s), [s])
  const f: CoachFeedback = s.coach ?? local
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState(0)
  const [hl, setHl] = useState<number[]>([])
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  useEffect(() => { onHighlight(hl) }, [hl, onHighlight])

  useEffect(() => {
    if (!busy) return
    setStep(0)
    const id = setInterval(() => setStep((x) => Math.min(STEPS.length - 1, x + 1)), 2200)
    return () => clearInterval(id)
  }, [busy])

  const generate = async () => {
    setBusy(true)
    try {
      const coach = await requestVlmCoach(s)
      onUpdate({ ...s, coach })
      toast(`Coached by ${coach.model ?? 'VLM Run'}${coach.watchedVideo ? ` — it studied ${coach.frames ?? 8} frames of your clip` : ''}`)
    } catch (e) {
      toast((e as Error).message, 'warn')
    } finally {
      setBusy(false)
    }
  }

  const canVlm = Boolean(health?.connected)
  return (
    <div className="coach">
      <aside className="coach-side">
        <div className="card coach-score">
          <ScoreRing key={f.generatedAt ?? f.source} score={f.score} color={route} />
          <div className="subscores">
            {Object.entries(f.scores).map(([k, v], i) => (
              <div key={k} className="sub">
                <span>{k}</span>
                <span className="sub-bar"><motion.i initial={{ width: 0 }} animate={{ width: `${v}%` }} transition={{ delay: 0.3 + i * 0.08, duration: 0.9, ease: [0.16, 1, 0.3, 1] }} style={{ background: route }} /></span>
                <b>{v}</b>
              </div>
            ))}
          </div>
          <div className={`source-badge ${f.source}`}>
            {f.source === 'vlm' ? <><Sparkles size={13} /> {f.model ?? 'VLM Run'}{f.watchedVideo ? ` · studied ${f.frames ?? 8} frames` : ''}</> : <><Cpu size={13} /> On-device coach</>}
          </div>
          <button className="btn primary wide shimmer-btn" disabled={!canVlm || busy} onClick={generate} title={canVlm ? '' : 'Start the CLIMBR server with a VLMRUN_API_KEY to use the VLM coach'}>
            {busy ? <RefreshCw size={15} className="spin" /> : <Sparkles size={15} />}
            {busy ? 'Coaching…' : f.source === 'vlm' ? 'Regenerate with VLM Run' : 'Coach me with VLM Run'}
          </button>
          {!canVlm && <p className="muted xs center">Server offline or no key — showing on-device feedback.</p>}
        </div>
        <div className="card">
          <span className="kicker">Where it happened</span>
          <MiniRoute session={s} sequence={s.sequence} highlight={hl} animate={false} height={250} />
        </div>
      </aside>

      <div className="coach-main">
        <AnimatePresence mode="wait">
          {busy ? (
            <motion.div key="busy" className="card coach-busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="busy-orb" />
              <h3>Coaching your climb</h3>
              <ul>
                {STEPS.map((x, i) => (
                  <li key={x} className={i < step ? 'done' : i === step ? 'now' : ''}>{x}</li>
                ))}
              </ul>
              <div className="skeleton-lines"><i /><i /><i style={{ width: '60%' }} /></div>
            </motion.div>
          ) : (
            <motion.div key={f.generatedAt ?? f.source} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
              <div className="coach-hero">
                <span className="kicker">The read</span>
                <h2>{f.headline}</h2>
                <p>{f.summary}</p>
              </div>
              <div className="coach-cols">
                <section>
                  <h4 className="sec good"><ThumbsUp size={14} /> What went well</h4>
                  {f.strengths.map((x, i) => (
                    <motion.div key={i} className="card item" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.07 }}>
                      <b>{x.title}</b><p>{x.detail}</p>
                    </motion.div>
                  ))}
                </section>
                <section>
                  <h4 className="sec warn"><Target size={14} /> Focus next time</h4>
                  {f.focus.map((x, i) => (
                    <motion.button key={i} className="card item clickable" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.07 }}
                      onMouseEnter={() => setHl(x.holds ?? [])} onMouseLeave={() => setHl([])} onClick={() => x.time != null && onSeek(x.time)}>
                      <b>{x.title}</b><p>{x.detail}</p>
                      {(x.time != null || x.holds?.length) ? <span className="item-meta">{x.time != null && <>at {x.time.toFixed(1)} s <ArrowUpRight size={12} /></>}{x.holds?.length ? <> · holds {x.holds.join(', ')}</> : null}</span> : null}
                    </motion.button>
                  ))}
                </section>
              </div>
              <h4 className="sec drill"><Dumbbell size={14} /> Drills</h4>
              <div className="drills">
                {f.drills.map((d, i) => (
                  <motion.div key={i} className="card drill-card" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.2 + i * 0.07 }}>
                    <div className="drill-top"><b>{d.name}</b>{d.dose && <span className="chip sm">{d.dose}</span>}</div>
                    <p>{d.how}</p>
                  </motion.div>
                ))}
              </div>
              <div className="coach-foot">
                <div className="card beta"><span className="kicker"><Lightbulb size={12} /> Suggested beta</span><p>{f.beta}</p></div>
                <div className="card beta"><span className="kicker"><Flag size={12} /> Next goal</span><p>{f.next_goal}</p></div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <aside className="coach-insights">
        <span className="kicker">Measured · on-device</span>
        {insights.map((x, i) => (
          <motion.button key={x.id} className={`insight ${x.tone}`} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.05 }}
            onMouseEnter={() => setHl(x.holds ?? [])} onMouseLeave={() => setHl([])} onClick={() => x.time != null && onSeek(x.time)}>
            <div className="insight-top"><b>{x.title}</b>{x.metric && <span className="insight-metric">{x.metric}</span>}</div>
            <p>{x.detail}</p>
          </motion.button>
        ))}
      </aside>
    </div>
  )
}
