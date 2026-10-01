import { motion } from 'framer-motion'
import { ArrowRight, Box, Brain, Clapperboard, Play, ScanLine, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MiniRoute } from '../components/MiniRoute'
import { getPrefs, listSessions, type StoredSession } from '../lib/store'
import { ROUTE_COLORS, type Session } from '../lib/types'

export function Home({ sessions, go }: { sessions: Session[]; go: (h: string) => void }) {
  const [saved, setSaved] = useState<StoredSession[]>([])
  useEffect(() => { listSessions().then(setSaved) }, [])
  const example = sessions.find((s) => s.kind === 'example')
  const name = getPrefs().name
  const all = [...sessions.filter((s) => s.kind === 'example'), ...saved.map((r) => r.session).filter((s) => !sessions.some((x) => x.id === s.id && x.kind === 'example'))]

  return (
    <motion.section className="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="hero">
        <div className="hero-copy">
          <motion.span className="kicker" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>{name ? `Welcome back, ${name}` : 'Computer vision for bouldering'}</motion.span>
          <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
            Read every <span className="grad">move.</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
            CLIMBR finds every hold on your route, tracks all four limbs, and turns a phone video — or an iPhone LiDAR scan — into a synced replay, a 3D wall in meters, and a coach’s notes.
          </motion.p>
          <motion.div className="cta" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}>
            <button className="btn primary lg" onClick={() => go('#/session/example-green-vb')}><Play size={16} fill="currentColor" /> Watch the example</button>
            <button className="btn lg" onClick={() => go('#/import')}><Upload size={16} /> Import a climb</button>
          </motion.div>
          <motion.div className="model-row" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
            <span className="chip"><ScanLine size={12} /> SAM 3.1</span>
            <span className="chip">ViTPose+ Large</span>
            <span className="chip"><Brain size={12} /> VLM coach</span>
            <span className="chip"><Box size={12} /> iPhone LiDAR</span>
            <span className="muted xs">all through the VLM Run gateway</span>
          </motion.div>
        </div>
        <motion.div className="hero-visual" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.15, type: 'spring', stiffness: 120, damping: 20 }}>
          <div className="hero-glow" />
          {example ? (
            <div className="hero-card card">
              <MiniRoute session={example} sequence={example.sequence} loop body height={420} />
              <motion.div className="float f1" animate={{ y: [0, -6, 0] }} transition={{ duration: 4, repeat: Infinity }}><b>{example.elapsed?.toFixed(2)} s</b><span>topped out</span></motion.div>
              <motion.div className="float f2" animate={{ y: [0, 6, 0] }} transition={{ duration: 4.6, repeat: Infinity }}><b>{example.sequence.length}/{example.holdsDetected}</b><span>holds used</span></motion.div>
              <motion.div className="float f3" animate={{ y: [0, -5, 0] }} transition={{ duration: 5, repeat: Infinity }}><b>{example.utilization ? Math.round(((example.utilization.left_hand.coverage + example.utilization.right_hand.coverage) / 2) * 100) : '—'}%</b><span>hands on a hold</span></motion.div>
            </div>
          ) : <div className="spinner" />}
        </motion.div>
      </div>

      <div className="section-head">
        <h2>Your climbs</h2>
        <button className="link" onClick={() => go('#/import')}>Add a climb <ArrowRight size={14} /></button>
      </div>
      <div className="session-cards">
        {all.map((s, i) => (
          <motion.button key={s.id} className="card session-card" onClick={() => go(`#/session/${encodeURIComponent(s.id)}`)} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.06 }} whileHover={{ y: -4 }}>
            <div className="sc-visual">
              {s.video?.poster ? <img src={s.video.poster} alt="" /> : <MiniRoute session={s} sequence={s.sequence} animate={false} height={180} />}
              <span className="sc-play"><Play size={14} fill="currentColor" /></span>
              {s.kind === 'example' && <span className="chip accent sc-tag">Example</span>}
              {s.kind === 'live' && <span className="chip accent sc-tag">VLM Run</span>}
            </div>
            <div className="sc-body">
              <b>{s.title}</b>
              <span className="muted xs"><span className="route-dot" style={{ background: ROUTE_COLORS[s.route.color] }} />{s.route.color} · {s.route.grade} · {s.climber}</span>
              <div className="sc-stats">
                <span><b>{s.elapsed?.toFixed(2) ?? '—'}</b> s</span>
                <span><b>{s.sequence.length}</b>/{s.holdsDetected} holds</span>
                <span><b>{s.moves.length}</b> moves</span>
              </div>
            </div>
          </motion.button>
        ))}
        <motion.button className="card session-card add" onClick={() => go('#/import')} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + all.length * 0.06 }} whileHover={{ y: -4 }}>
          <Upload size={22} />
          <b>Import a climb</b>
          <span className="muted xs">video · JSON · LiDAR</span>
        </motion.button>
      </div>

      <div className="how">
        {[
          { icon: <Clapperboard size={18} />, t: 'Film it', d: 'Phone on a water bottle, or a friend. iPhone Pro adds LiDAR depth.' },
          { icon: <ScanLine size={18} />, t: 'Segment', d: 'SAM 3.1 finds every hold of your colour — no training, any gym.' },
          { icon: <Play size={18} />, t: 'Track', d: 'ViTPose+ follows both hands and feet, frame by frame.' },
          { icon: <Brain size={18} />, t: 'Coach', d: 'A VLM watches the clip with the numbers and tells you what to fix.' },
        ].map((x, i) => (
          <motion.div key={x.t} className="how-step" initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.08 }}>
            <span className="how-icon">{x.icon}</span>
            <span className="how-n">0{i + 1}</span>
            <b>{x.t}</b>
            <p>{x.d}</p>
          </motion.div>
        ))}
      </div>
      <p className="credit">Example footage and the reference pipeline: <a href="https://github.com/jeremyipark/vision-demos" target="_blank" rel="noreferrer">jeremyipark/vision-demos</a> (Apache-2.0).</p>
    </motion.section>
  )
}
