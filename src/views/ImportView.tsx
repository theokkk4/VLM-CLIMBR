import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, FileVideo, Loader2, RotateCcw, ScanLine, SearchX, Sparkles, Trash2, Upload, X, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from '../components/Toast'
import { readRoute, type Reading } from '../lib/analyze'
import { analyzeLive, reportRun, STAGE_KEYS, StageError, type Health, type StageEvent, type StageKey } from '../lib/api'
import { requestVlmCoach } from '../lib/coach'
import { clipFrom, filesFromDataTransfer, fmtBytes, isVideo, videoMeta, type Clip } from '../lib/importers'
import { clockLabel, failedChecks, sessionFromLive, sessionProblem } from '../lib/live'
import { deleteSession, getPrefs, listSessions, saveSession, type StoredSession } from '../lib/store'
import { ROUTE_COLORS, type Check, type Session } from '../lib/types'
import { buildWallPlate } from '../lib/wallplate'

const GRADES = ['VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7+']

// ── the run, as a state machine ─────────────────────────────────────────────
// uploading → extracting_frames → segmenting ‖ estimating_pose → analyzing_moves
// → (coaching) → complete. Any stage can end it in `error`; a run that worked
// but found nothing to read ends in `empty`, which is not a failure.
type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'
interface StageState { status: StageStatus; detail?: string; progress?: number }
type Phase = StageKey | 'complete' | 'empty' | 'error'
interface Run {
  phase: Phase
  stages: Record<StageKey, StageState>
  started: number
  finished?: number
  clip: Clip
  error?: { stage: StageKey | null; message: string; checks?: Check[] }
  empty?: string
  debug?: string | null
}

const fresh = (clip: Clip): Run => ({
  phase: 'uploading',
  stages: Object.fromEntries(STAGE_KEYS.map((k) => [k, { status: k === 'uploading' ? 'running' : 'pending' }])) as Run['stages'],
  started: Date.now(),
  clip,
})

export function ImportView({ health, onSession }: { health: Health | null; onSession: (s: Session) => void }) {
  const prefs = getPrefs()
  const [clip, setClip] = useState<Clip | null>(null)
  const [drag, setDrag] = useState(false)
  const [title, setTitle] = useState('')
  const [climber, setClimber] = useState(prefs.name ?? '')
  const [color, setColor] = useState(prefs.color ?? 'green')
  const [grade, setGrade] = useState(prefs.grade ?? 'V0')
  const [recent, setRecent] = useState<StoredSession[]>([])
  const [run, setRun] = useState<Run | null>(null)
  const abort = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => { listSessions().then(setRecent) }, [])

  const add = async (files: File[]) => {
    const video = files.find(isVideo)
    if (!video) {
      if (files.length) toast('CLIMBR reads a video of the climb: .mov, .mp4 or .webm', 'warn')
      return
    }
    const c = clipFrom(video)
    setClip(c)
    const meta = await videoMeta(c.url)
    setClip((cur) => (cur?.id === c.id ? { ...c, meta } : cur))
  }

  const patch = (fn: (r: Run) => Run) => setRun((r) => (r ? fn(r) : r))
  const stage = (k: StageKey, s: Partial<StageState>) => patch((r) => {
    const stages = { ...r.stages, [k]: { ...r.stages[k], ...s } }
    // The phase is the furthest stage under way.
    const running = STAGE_KEYS.filter((x) => stages[x].status === 'running')
    return { ...r, stages, phase: running.length ? running[running.length - 1] : r.phase }
  })

  const start = async () => {
    if (!clip) return
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setRun(fresh(clip))
    let current: StageKey = 'uploading'
    const onEvent = (e: StageEvent) => {
      if (e.stage !== 'uploading') stage('uploading', { status: 'done', progress: 1 })
      current = e.stage
      stage(e.stage, { status: e.status, detail: e.detail ?? undefined, progress: e.progress })
    }
    try {
      const r = await analyzeLive(clip.file, { color, health }, onEvent, (p) => stage('uploading', { progress: p, detail: `${Math.round(p * 100)}% of ${fmtBytes(clip.size)}` }), ctl.signal)
      patch((x) => ({ ...x, debug: r.debug }))

      // ── analyzing_moves: the route reader, then every number checked ──
      current = 'analyzing_moves'
      stage('analyzing_moves', { status: 'running', detail: 'Placing the camera, the holds and every contact' })
      await new Promise((res) => setTimeout(res, 50))
      let reading: Reading
      try {
        reading = readRoute({ sam: r.sam, pose: r.pose, frame: { width: r.analysis.width, height: r.analysis.height, duration: r.analysis.duration }, color })
      } catch (e) {
        throw new StageError((e as Error).message, 'analyzing_moves')
      }
      if (reading.outcome !== 'ok') {
        const why = reading.outcome === 'no-holds'
          ? `SAM 3.1 sampled ${r.sam.samples.length} frames and found no ${color} holds it was sure of. If the route is another colour, pick it and run again.`
          : `ViTPose+ posed ${r.pose.framesPosed} frames but found nobody on the ${color} holds.`
        stage('analyzing_moves', { status: 'done', detail: reading.outcome === 'no-holds' ? `0 ${color} holds` : 'no climber' })
        reportRun(r.id, { status: 'empty', outcome: reading.outcome, summary: reading.stats, warnings: reading.warnings })
        patch((x) => ({ ...x, phase: 'empty', empty: why, finished: Date.now() }))
        return
      }
      const s = sessionFromLive(r, reading, { title, climber, color, grade }, { src: r.playback.src, webm: r.playback.webm, poster: r.playback.poster })
      const bad = failedChecks(s.analysis!.validation)
      reportRun(r.id, { status: bad.length ? 'invalid' : 'valid', summary: reading.stats, validation: s.analysis!.validation, warnings: s.analysis!.warnings, session: { duration: s.duration, offset: s.video!.offset, canvas: s.canvas, holds: s.holds.length, moves: s.moves.length, sequence: s.sequence, elapsed: s.elapsed } })
      if (bad.length) throw Object.assign(new StageError(`The result failed ${bad.length} check${bad.length > 1 ? 's' : ''}, so it was not opened.`, 'analyzing_moves'), { checks: bad })
      const plate = await buildWallPlate(s)
      if (plate) s.wall = { src: plate, affine: [[1, 0, 0], [0, 1, 0]] }
      stage('analyzing_moves', { status: 'done', detail: `${s.holds.length} holds · ${s.moves.length} moves · ${s.toppedOut ? `topped out in ${s.elapsed!.toFixed(2)} s` : 'no top-out'} · camera ${reading.stats.camera}` })

      // ── coaching: optional. A coach that cannot answer does not sink the run. ──
      current = 'coaching'
      stage('coaching', { status: 'running', detail: 'A VLM reads the numbers and 8 keyframes' })
      try {
        const fb = await requestVlmCoach(s, ctl.signal)
        s.coach = fb
        stage('coaching', { status: 'done', detail: `${fb.model ?? 'VLM'} · “${fb.headline}”` })
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        stage('coaching', { status: 'skipped', detail: `Not this time: ${(e as Error).message}. The Coach tab can ask again.` })
      }

      const saved = await saveSession(s)
      if (!saved) toast('Could not save to this browser (storage is blocked); the replay still opens.', 'warn')
      patch((x) => ({ ...x, phase: 'complete', finished: Date.now() }))
      await new Promise((res) => setTimeout(res, 900))
      const cost = s.usage?.costUsd
      toast(`Analyzed with VLM Run${cost ? ` for $${cost.toFixed(3)}` : ''}`)
      setRun(null)
      onSession(s)
    } catch (e) {
      if ((e as Error).name === 'AbortError') { setRun(null); return }
      const err = e as StageError & { checks?: Check[] }
      const failed = err.stage ?? current
      stage(failed, { status: 'error', detail: err.message })
      patch((x) => ({ ...x, phase: 'error', finished: Date.now(), error: { stage: failed, message: err.message, checks: err.checks } }))
    }
  }

  const ready = Boolean(clip && health?.connected && health.ffmpeg !== false && (health.platform !== 'vercel' || health.uploads === 'blob'))

  return (
    <motion.section className="import" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
      <div className="import-head">
        <span className="kicker">New climb</span>
        <h1>Bring a climb.</h1>
        <p className="muted">A phone video of one attempt. SAM 3.1 finds every hold of your route’s colour, ViTPose+ tracks all four limbs, and CLIMBR reads the moves, even when the camera follows you up the wall.</p>
      </div>

      <div className="import-grid">
        <div className="import-left">
          <div className={`dropzone ${drag ? 'drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={async (e) => { e.preventDefault(); setDrag(false); add(await filesFromDataTransfer(e.dataTransfer)) }}>
            <div className="dz-glow" />
            <div className="dz-icons">
              <motion.span animate={{ y: [0, -5, 0] }} transition={{ duration: 3, repeat: Infinity, delay: 0 }}><FileVideo size={22} /></motion.span>
              <motion.span animate={{ y: [0, -5, 0] }} transition={{ duration: 3, repeat: Infinity, delay: 0.4 }}><ScanLine size={22} /></motion.span>
              <motion.span animate={{ y: [0, -5, 0] }} transition={{ duration: 3, repeat: Infinity, delay: 0.8 }}><Sparkles size={22} /></motion.span>
            </div>
            <h3>Drop your climb here</h3>
            <p>.mov · .mp4 · .webm — iPhone HDR, any orientation, up to 2 minutes</p>
            <div className="dz-actions">
              <button className="btn" onClick={() => fileInput.current?.click()}><Upload size={15} /> Choose a video</button>
            </div>
            <input ref={fileInput} type="file" accept="video/*,.mov,.mp4,.m4v,.webm" hidden onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
          </div>

          <div className="card detected">
            <div className="limb-head"><span className="kicker">Clip</span>{clip && <button className="link" onClick={() => setClip(null)}>Clear</button>}</div>
            {!clip && <p className="muted xs">Nothing yet. The clip you choose shows up here.</p>}
            <AnimatePresence initial={false}>
              {clip && (
                <motion.div key={clip.id} className="det" layout initial={{ opacity: 0, y: -8, height: 0 }} animate={{ opacity: 1, y: 0, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                  <span className="det-icon"><FileVideo size={16} /></span>
                  <span className="det-text"><b>{clip.name}</b><em>{clip.meta ? `${clip.meta.w}×${clip.meta.h} · ${clip.meta.dur.toFixed(1)} s · ` : ''}{fmtBytes(clip.size)}{clip.meta ? '' : ' · read on the server'}</em></span>
                  <button className="icon-btn" onClick={() => setClip(null)} aria-label="Remove"><X size={14} /></button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="import-right">
          <div className="card">
            <span className="kicker">Details</span>
            <div className="form">
              <label><span>Route name</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. The Green Slab" /></label>
              <label><span>Climber</span><input value={climber} onChange={(e) => setClimber(e.target.value)} placeholder="Your name" /></label>
              <div className="field"><span>Hold colour</span>
                <div className="swatches">
                  {Object.entries(ROUTE_COLORS).map(([k, v]) => (
                    <button key={k} className={`swatch ${color === k ? 'on' : ''}`} style={{ background: v }} onClick={() => setColor(k)} title={k} />
                  ))}
                </div>
              </div>
              <div className="field"><span>Grade</span>
                <div className="grades">{GRADES.map((g) => <button key={g} className={grade === g ? 'on' : ''} onClick={() => setGrade(g)}>{g}</button>)}</div>
              </div>
            </div>
          </div>

          <div className="card go-card">
            <div className="go-status">
              {ready ? <CheckCircle2 size={16} className="ok" /> : <span className="dot-idle" />}
              <span>{clip ? (ready ? 'Ready to analyze' : 'The server is not ready') : 'Choose a video to start'}</span>
            </div>
            <button className="btn primary wide" disabled={!ready} onClick={start}>
              <Sparkles size={15} /> Analyze with VLM Run
            </button>
            {!health?.connected && <p className="muted xs">Live analysis needs the CLIMBR server with a <code>VLMRUN_API_KEY</code> in <code>.env</code> (or in the Vercel project’s environment variables).</p>}
            {health?.connected && health.ffmpeg === false && <p className="muted xs">The server has no ffmpeg. Run <code>npm install</code> (it brings ffmpeg-static) and restart it.</p>}
            {health?.connected && health.platform === 'vercel' && health.uploads !== 'blob' && <p className="muted xs">On Vercel, live analysis also needs a Blob store (Storage → Blob → connect to this project).</p>}
            {health?.connected && <p className="muted xs">SAM 3.1 tracks the {color} holds and ViTPose+ poses {health.analysis?.fps ?? 10} frames a second. Usually about a minute and a few cents.</p>}
          </div>

          {recent.length > 0 && (
            <div className="card recent">
              <span className="kicker">Saved in this browser</span>
              {recent.slice(0, 5).map((r) => {
                const problem = sessionProblem(r.session)
                return (
                  <div key={r.id} className="recent-row">
                    <a href={`#/session/${encodeURIComponent(r.id)}`}><b>{r.session.title}{problem && <AlertTriangle size={12} className="warn-icon" />}</b><em>{r.session.route.color} · {r.session.route.grade} · {clockLabel(r.session)}</em></a>
                    <button className="icon-btn" onClick={async () => { await deleteSession(r.id); setRecent(await listSessions()) }} aria-label="Delete"><Trash2 size={14} /></button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>{run && <AnalyzeOverlay run={run} color={color} onRetry={start} onClose={() => { abort.current?.abort(); setRun(null) }} />}</AnimatePresence>
    </motion.section>
  )
}

const STAGES: { key: StageKey; label: string; model?: string }[] = [
  { key: 'uploading', label: 'Uploading the clip' },
  { key: 'extracting_frames', label: 'Reading the video', model: 'ffmpeg · 10 frames a second' },
  { key: 'segmenting', label: 'Segmenting holds', model: 'facebook/sam3.1' },
  { key: 'estimating_pose', label: 'Tracking the climber', model: 'vitpose-plus-large' },
  { key: 'analyzing_moves', label: 'Reading the route', model: 'in your browser' },
  { key: 'coaching', label: 'Coach notes', model: 'VLM · optional' },
]

function AnalyzeOverlay({ run, color, onRetry, onClose }: { run: Run; color: string; onRetry: () => void; onClose: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(id) }, [])
  const route = ROUTE_COLORS[color] ?? ROUTE_COLORS.green
  const elapsed = ((run.finished ?? now) - run.started) / 1000
  const failed = run.phase === 'error', empty = run.phase === 'empty', done = run.phase === 'complete'
  return (
    <motion.div className="analyze" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className={`analyze-card ${failed ? 'failed' : ''}`} initial={{ scale: 0.96, y: 20 }} animate={{ scale: 1, y: 0 }} style={{ ['--route' as string]: route }}>
        <div className="analyze-video">
          <video src={run.clip.url} autoPlay muted loop playsInline />
          {!failed && !empty && <><div className="scanline" /><div className="scan-grid" /></>}
          <span className="chip glass"><span className="rec-dot" /> VLM Run</span>
        </div>
        <div className="analyze-body">
          <span className="kicker">{failed ? 'Stopped' : empty ? 'Finished' : done ? 'Done' : 'Analyzing'} · {elapsed.toFixed(1)} s</span>
          <h2>{failed ? 'Analysis failed' : empty ? 'Nothing to read' : done ? 'Climb read' : 'Reading your climb'}</h2>
          <ul className="stages">
            {STAGES.map((st) => {
              const s = run.stages[st.key]
              const shown = s.status === 'pending' && (failed || empty) ? 'not run' : null
              return (
                <li key={st.key} className={s.status}>
                  <span className="st-icon">{s.status === 'done' ? <CheckCircle2 size={17} /> : s.status === 'running' ? <Loader2 size={17} className="spin" /> : s.status === 'error' ? <XCircle size={17} /> : s.status === 'skipped' ? <SearchX size={17} /> : <span className="st-dot" />}</span>
                  <span className="st-text">
                    <b>{st.label}</b>
                    <em>{shown ?? s.detail ?? st.model ?? ''}</em>
                    {s.status === 'running' && s.progress != null && st.key !== 'coaching' && <span className="st-bar"><i style={{ width: `${s.progress * 100}%` }} /></span>}
                  </span>
                </li>
              )
            })}
          </ul>
          {failed && run.error?.checks && (
            <ul className="failed-checks">{run.error.checks.map((c) => <li key={c.id}><b>{c.label}</b> — {c.detail}</li>)}</ul>
          )}
          {empty && <p className="muted empty-note">{run.empty}</p>}
          <div className="analyze-actions">
            {(failed || empty) && <button className="btn primary" onClick={onRetry}><RotateCcw size={15} /> Retry</button>}
            <button className="btn ghost" onClick={onClose}>{failed || empty ? 'Close' : 'Cancel'}</button>
            {import.meta.env.DEV && run.debug && <a className="link debug-link" href={run.debug} target="_blank" rel="noreferrer">debug log</a>}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
