import { AnimatePresence, motion } from 'framer-motion'
import { Box, Brain, Download, GitCompareArrows, Play } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { ExportSheet } from '../components/ExportSheet'
import { LivePanel } from '../components/LivePanel'
import { RoutePanel } from '../components/RoutePanel'
import { TimelineBar, type ViewOpts } from '../components/TimelineBar'
import { VideoStage } from '../components/VideoStage'
import type { Health } from '../lib/api'
import { createPlayer, finaleSchedule, usePlayer } from '../lib/player'
import { getPrefs, setPrefs } from '../lib/store'
import { buildTimeline } from '../lib/timeline'
import { ROUTE_COLORS, type Session } from '../lib/types'
import { AttemptsView } from './AttemptsView'
import { CoachView } from './CoachView'

const Scan3D = lazy(() => import('../components/Scan3D'))

type Tab = 'replay' | 'scan' | 'attempts' | 'coach'
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'replay', label: 'Replay', icon: <Play size={14} /> },
  { id: 'scan', label: '3D Scan', icon: <Box size={14} /> },
  { id: 'attempts', label: 'Attempts', icon: <GitCompareArrows size={14} /> },
  { id: 'coach', label: 'Coach', icon: <Brain size={14} /> },
]

export function SessionView({ session: s, health, onUpdate }: { session: Session; health: Health | null; onUpdate: (s: Session) => void; go: (h: string) => void }) {
  const tl = useMemo(() => buildTimeline(s), [s])
  const player = useMemo(() => {
    const climbEnd = tl.climbEnd
    const offset = s.video?.offset ?? 0
    const fin = finaleSchedule(climbEnd, s.sequence.length)
    return createPlayer({ start: s.video ? -offset : -0.4, end: s.toppedOut ? fin.end : climbEnd + 0.5, climbEnd, offset })
  }, [s, tl])
  useEffect(() => player.run(), [player])
  const ps = usePlayer(player)

  const [tab, setTab] = useState<Tab>('replay')
  const [opts, setOptsState] = useState<ViewOpts>(() => ({ skeleton: true, backdrop: Boolean(s.wall), letters: getPrefs().letters ?? false }))
  const setOpts = (o: ViewOpts) => { setOptsState(o); setPrefs({ letters: o.letters }) }
  const [cardDismissed, setCardDismissed] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [highlight, setHighlight] = useState<number[]>([])

  useEffect(() => { if (ps.t < tl.climbEnd) setCardDismissed(false) }, [ps.t, tl.climbEnd])
  const showCard = s.toppedOut && ps.t >= tl.climbEnd + 0.35 && !cardDismissed && tab === 'replay'

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return
      if (e.code === 'Space') { e.preventDefault(); player.toggle() }
      else if (e.key === 'ArrowRight') player.seek(player.get().t + (e.shiftKey ? 2 : 0.5))
      else if (e.key === 'ArrowLeft') player.seek(player.get().t - (e.shiftKey ? 2 : 0.5))
      else if (['1', '2', '3', '4'].includes(e.key)) setTab(TABS[Number(e.key) - 1].id)
      else if (e.key.toLowerCase() === 'e') setExportOpen(true)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [player])

  // Warm the 3D view's chunk while the replay plays, so switching is instant.
  useEffect(() => {
    const id = setTimeout(() => { void import('../components/Scan3D') }, 1200)
    return () => clearTimeout(id)
  }, [])

  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const seekAndShow = (t: number) => { setTab('replay'); player.seek(t) }

  return (
    <motion.section className="session" style={{ ['--route' as string]: route }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.35 }}>
      <div className="session-head">
        <div className="sh-title">
          <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>{s.title}</motion.h1>
          <div className="sh-meta">
            <span className="chip route-chip"><span className="route-dot" />{s.route.color} · {s.route.grade}</span>
            {s.gym && <span className="chip">{s.gym}</span>}
            <span className="chip"><span className="avatar">{s.climber.slice(0, 1)}</span>{s.climber}</span>
            {s.kind === 'example' && <span className="chip accent">Example</span>}
            {s.scale?.source === 'lidar' && <span className="chip accent">LiDAR</span>}
          </div>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t, i) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)} title={`${t.label} (${i + 1})`}>
              {tab === t.id && <motion.span layoutId="tab-pill" className="tab-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <span className="tab-inner">{t.icon}{t.label}</span>
            </button>
          ))}
        </div>
        <div className="sh-actions">
          <button className="btn primary" onClick={() => setExportOpen(true)}><Download size={15} /> Export</button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {tab === 'replay' && (
          <motion.div key="replay" className="replay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <div className="stage">
              <VideoStage session={s} player={player} tl={tl} t={ps.t} showCard={showCard} onDismissCard={() => setCardDismissed(true)} />
              <div className="route-wrap card">
                <div className="panel-label">
                  <span className="kicker">Route · {s.holdsDetected} holds</span>
                  <span className="kicker dim">{s.holds.length && s.holds[0].score === undefined && !s.holds[0].depth ? '' : 'SAM 3.1 masks'}</span>
                </div>
                <RoutePanel session={s} tl={tl} t={ps.t} letters={opts.letters} backdrop={opts.backdrop} skeleton={opts.skeleton} highlight={highlight} onSeek={(t) => player.seek(t)} />
                <div className="legend">
                  <span><i style={{ background: 'var(--lh)' }} />left hand</span>
                  <span><i style={{ background: 'var(--rh)' }} />right hand</span>
                  <span><i style={{ background: 'var(--lf)' }} />left foot</span>
                  <span><i style={{ background: 'var(--rf)' }} />right foot</span>
                  <span><i style={{ background: '#FF5A5F', borderRadius: 99 }} />torso</span>
                </div>
              </div>
              <LivePanel session={s} tl={tl} t={ps.t} letters={opts.letters} onSeek={(t) => player.seek(t)} />
            </div>
            <TimelineBar session={s} tl={tl} player={player} ps={ps} opts={opts} setOpts={setOpts} />
          </motion.div>
        )}
        {tab === 'scan' && (
          <motion.div key="scan" className="tab-body" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <Suspense fallback={<div className="loading-screen"><div className="spinner" /></div>}>
              <Scan3D session={s} tl={tl} player={player} letters={opts.letters} />
            </Suspense>
            <TimelineBar session={s} tl={tl} player={player} ps={ps} opts={opts} setOpts={setOpts} />
          </motion.div>
        )}
        {tab === 'attempts' && (
          <motion.div key="attempts" className="tab-body scroll" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <AttemptsView session={s} letters={opts.letters} />
          </motion.div>
        )}
        {tab === 'coach' && (
          <motion.div key="coach" className="tab-body scroll" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <CoachView session={s} health={health} onUpdate={onUpdate} onSeek={seekAndShow} onHighlight={setHighlight} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>{exportOpen && <ExportSheet session={s} onClose={() => setExportOpen(false)} />}</AnimatePresence>
    </motion.section>
  )
}
