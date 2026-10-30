import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Play, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LogoMark } from '../components/Logo'
import { RoutePanel } from '../components/RoutePanel'
import { loadExample } from '../lib/api'
import { getPrefs, setPrefs } from '../lib/store'
import { buildTimeline } from '../lib/timeline'
import { ROUTE_COLORS, type Session } from '../lib/types'

const GRADES = ['VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7+']
const STEPS = 5

export function Onboarding({ onDone }: { onDone: (to: string) => void }) {
  const p = getPrefs()
  const [step, setStep] = useState(0)
  const [dir, setDir] = useState(1)
  const [name, setName] = useState(p.name ?? '')
  const [grade, setGrade] = useState(p.grade ?? 'V1')
  const [color, setColor] = useState(p.color ?? 'green')
  const [example, setExample] = useState<Session | null>(null)
  useEffect(() => { loadExample().then(setExample).catch(() => {}) }, [])

  const go = (n: number) => {
    setDir(n > step ? 1 : -1)
    setStep(Math.max(0, Math.min(STEPS - 1, n)))
  }
  useEffect(() => {
    if (step !== 0) return
    const id = setTimeout(() => go(1), 3400)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input')) return
      if (e.key === 'ArrowRight' || e.key === 'Enter') go(step + 1)
      if (e.key === 'ArrowLeft') go(step - 1)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })

  const finish = (to: string) => {
    setPrefs({ onboarded: true, name: name.trim() || undefined, grade, color })
    onDone(to)
  }
  const route = ROUTE_COLORS[color] ?? ROUTE_COLORS.green

  return (
    <motion.div className="onboarding" style={{ ['--route' as string]: route }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: 1.02, filter: 'blur(6px)' }} transition={{ duration: 0.5 }}>
      <div className="ob-orbs" aria-hidden><i /><i /><i /></div>
      <Chalk />
      {step > 0 && <button className="ob-skip" onClick={() => finish('#/')}>Skip</button>}

      <AnimatePresence mode="wait" custom={dir}>
        <motion.div key={step} className="ob-step" custom={dir}
          initial={{ opacity: 0, x: dir * 60, filter: 'blur(8px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, x: dir * -60, filter: 'blur(8px)' }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}>
          {step === 0 && <Splash onNext={() => go(1)} />}

          {step === 1 && (
            <div className="ob-split">
              <div className="ob-copy">
                <span className="kicker">Step 1 · Film it</span>
                <h1>Prop your phone.<br /><span className="grad">Send the route.</span></h1>
                <p>Lean it on a water bottle or hand it to a friend. Keep the holds you climb in view, and film one attempt per clip: pulling on to topping out. Any phone, still or handheld.</p>
                <FilmTips />
              </div>
              <PhoneArt />
            </div>
          )}

          {step === 2 && (
            <div className="ob-split">
              <div className="ob-copy">
                <span className="kicker">Step 2 · We read it</span>
                <h1>Every hold.<br />Every limb.<br /><span className="grad">Every second.</span></h1>
                <ReadCaptions />
              </div>
              <div className="ob-demo card">{example ? <LiveDemo session={example} /> : <div className="spinner" />}</div>
            </div>
          )}

          {step === 3 && (
            <div className="ob-center">
              <span className="kicker">Step 3 · Make it yours</span>
              <h1>What should we call you?</h1>
              <input className="ob-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" onKeyDown={(e) => e.key === 'Enter' && go(4)} />
              <div className="ob-field">
                <span>Your usual grade</span>
                <div className="grades big">{GRADES.map((g) => <button key={g} className={grade === g ? 'on' : ''} onClick={() => setGrade(g)}>{g}</button>)}</div>
              </div>
              <div className="ob-field">
                <span>The colour you climb most</span>
                <div className="swatches big">
                  {Object.entries(ROUTE_COLORS).map(([k, v]) => (
                    <motion.button key={k} className={`swatch ${color === k ? 'on' : ''}`} style={{ background: v }} onClick={() => setColor(k)} whileHover={{ scale: 1.12 }} whileTap={{ scale: 0.92 }} title={k} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="ob-center">
              <motion.div initial={{ scale: 0.4, rotate: -20, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 16 }}>
                <LogoMark size={84} animate />
              </motion.div>
              <h1 className="ob-ready">You’re set{name.trim() ? `, ${name.trim()}` : ''}.</h1>
              <p className="ob-sub">Start with a real send — or bring your own.</p>
              <div className="ob-ctas">
                <motion.button className="btn primary xl" onClick={() => finish('#/session/example-green-vb')} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.98 }}>
                  <Play size={18} fill="currentColor" /> Watch an example climb
                </motion.button>
                <motion.button className="btn xl" onClick={() => finish('#/import')} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.98 }}>
                  <Upload size={18} /> Import my climb
                </motion.button>
              </div>
              <p className="muted xs">Tip: <kbd>Space</kbd> plays the replay, <kbd>1</kbd>–<kbd>3</kbd> switch views, <kbd>E</kbd> exports.</p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {step > 0 && (
        <div className="ob-nav">
          <button className="icon-btn" onClick={() => go(step - 1)} disabled={step <= 1} aria-label="Back"><ArrowLeft size={16} /></button>
          <div className="ob-dots">
            {Array.from({ length: STEPS - 1 }, (_, i) => (
              <button key={i} className={`ob-dot ${step === i + 1 ? 'on' : ''}`} onClick={() => go(i + 1)} aria-label={`Step ${i + 1}`}>
                {step === i + 1 && <motion.span layoutId="ob-dot" className="ob-dot-fill" />}
              </button>
            ))}
          </div>
          {step < STEPS - 1 ? (
            <button className="btn primary" onClick={() => go(step + 1)}>Continue <ArrowRight size={15} /></button>
          ) : <span style={{ width: 120 }} />}
        </div>
      )}
    </motion.div>
  )
}

function Splash({ onNext }: { onNext: () => void }) {
  const letters = 'CLIMBR'.split('')
  return (
    <div className="splash" onClick={onNext}>
      <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 18 }}>
        <LogoMark size={96} animate />
      </motion.div>
      <h1 className="splash-word">
        {letters.map((l, i) => (
          <motion.span key={i} initial={{ y: 40, opacity: 0, filter: 'blur(10px)' }} animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }} transition={{ delay: 0.5 + i * 0.07, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}>{l}</motion.span>
        ))}
      </h1>
      <motion.p className="splash-tag" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.3, duration: 0.6 }}>Read every move.</motion.p>
      <motion.div className="splash-powered" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.8 }}>
        SAM 3.1 · ViTPose+ — via VLM Run
      </motion.div>
      <motion.div className="splash-bar" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: 0.4, duration: 3, ease: 'linear' }} />
    </div>
  )
}

function ReadCaptions() {
  const items = [
    ['SAM 3.1', 'segments every hold of your colour — prompt it “green climbing hold”, no training.'],
    ['ViTPose+', 'tracks 17 joints per frame; hands and feet become four points of contact.'],
    ['CLIMBR', 'decides when a limb is really on a hold, orders the sequence and stops the clock when both hands match the top.'],
  ]
  return (
    <div className="read-caps">
      {items.map(([k, v], i) => (
        <motion.div key={k} className="read-cap" initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.35 + i * 0.25 }}>
          <b>{k}</b><span>{v}</span>
        </motion.div>
      ))}
    </div>
  )
}

/** The real example, playing itself on loop at 1.4× through the real panel. */
function LiveDemo({ session }: { session: Session }) {
  const tl = useMemo(() => buildTimeline(session), [session])
  const [t, setT] = useState(-0.3)
  const start = useRef(performance.now())
  useEffect(() => {
    let raf = 0
    const loop = (now: number) => {
      const span = tl.climbEnd + 6.5
      const el = ((now - start.current) / 1000) * 1.4
      setT((el % span) - 0.3)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tl])
  return (
    <div className="live-demo">
      <RoutePanel session={session} tl={tl} t={t} backdrop />
      <div className="demo-clock">{Math.max(0, Math.min(t, tl.climbEnd)).toFixed(2)} s</div>
    </div>
  )
}

function FilmTips() {
  const tips = [['Portrait or landscape', 'whatever shows the whole route'], ['One colour per route', 'you pick it; SAM 3.1 finds every hold of it'], ['Under two minutes', 'one attempt, start to finish']]
  return (
    <div className="read-caps">
      {tips.map(([k, v], i) => (
        <motion.div key={k} className="read-cap" initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 + i * 0.2 }}>
          <b>{k}</b><span>{v}</span>
        </motion.div>
      ))}
    </div>
  )
}

function PhoneArt() {
  return (
    <div className="phone-art">
      <motion.div className="phone" initial={{ rotate: -8, y: 20, opacity: 0 }} animate={{ rotate: -4, y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 120, damping: 14 }}>
        <div className="phone-screen">
          <img src="/examples/green-vb/poster.jpg" alt="" />
          <div className="phone-rec"><span className="rec-dot" /> REC</div>
        </div>
        <div className="phone-cam" />
      </motion.div>
      <div className="bottle" />
      <motion.div className="phone-tag" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        Any phone, any angle that sees the route
      </motion.div>
    </div>
  )
}

function Chalk() {
  const dots = useMemo(() => Array.from({ length: 28 }, (_, i) => ({ x: (i * 37) % 100, d: 6 + ((i * 13) % 10), s: 1 + ((i * 7) % 3), delay: (i * 0.7) % 8 })), [])
  return (
    <div className="chalk" aria-hidden>
      {dots.map((p, i) => (
        <motion.i key={i} style={{ left: `${p.x}%`, width: p.s * 2, height: p.s * 2 }} initial={{ y: '105vh', opacity: 0 }} animate={{ y: '-5vh', opacity: [0, 0.6, 0] }} transition={{ duration: p.d * 2, repeat: Infinity, delay: p.delay, ease: 'linear' }} />
      ))}
    </div>
  )
}
