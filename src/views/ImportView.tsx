import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Box, Braces, CheckCircle2, ClipboardPaste, FileJson, FileVideo, FolderOpen, Loader2, Sparkles, Trash2, Upload, Wand2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from '../components/Toast'
import { analyzePayloads } from '../lib/analyze'
import { analyzeLive, type Health, type StageEvent, type StageKey } from '../lib/api'
import { assess, detectFile, detectPasted, filesFromDataTransfer, fmtBytes, sessionFromItems, type Detected } from '../lib/importers'
import { buildSession } from '../lib/session'
import { buildWallPlate } from '../lib/wallplate'
import { deleteSession, getPrefs, listSessions, saveSession, type StoredSession } from '../lib/store'
import { ROUTE_COLORS, type Session } from '../lib/types'

const GRADES = ['VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7+']

function iconFor(kind: Detected['kind']) {
  if (kind === 'video') return <FileVideo size={16} />
  if (kind === 'ply') return <Box size={16} />
  if (kind === 'sam' || kind === 'pose') return <Sparkles size={16} />
  if (kind === 'unknown' || kind === 'text') return <Braces size={16} />
  return <FileJson size={16} />
}

export function ImportView({ health, onSession }: { health: Health | null; onSession: (s: Session) => void }) {
  const prefs = getPrefs()
  const [items, setItems] = useState<Detected[]>([])
  const [paste, setPaste] = useState('')
  const [drag, setDrag] = useState(false)
  const [title, setTitle] = useState('')
  const [climber, setClimber] = useState(prefs.name ?? '')
  const [color, setColor] = useState(prefs.color ?? 'green')
  const [grade, setGrade] = useState(prefs.grade ?? 'V0')
  const [recent, setRecent] = useState<StoredSession[]>([])
  const [live, setLive] = useState<null | { stages: Partial<Record<StageKey, StageEvent>>; upload: number; started: number; file: Detected }>(null)
  const abort = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  useEffect(() => { listSessions().then(setRecent) }, [])

  const add = async (files: File[]) => {
    const found = await Promise.all(files.map(detectFile))
    for (const d of found) {
      if (d.kind === 'video' && d.url) {
        const meta = await videoMeta(d.url)
        if (meta) { d.detail = `${meta.w}×${meta.h} · ${meta.dur.toFixed(1)} s · ${fmtBytes(d.size)}`; d.data = meta }
      }
    }
    setItems((xs) => [...xs, ...found])
    const route = found.find((d) => d.kind === 'climb' || d.kind === 'sequence' || d.kind === 'comparison')?.data?.route
    if (route?.color) setColor(route.color)
    if (route?.grade) setGrade(route.grade)
  }

  const readPaste = () => {
    const found = detectPasted(paste)
    if (!found.length) return
    setItems((xs) => [...xs, ...found])
    setPaste('')
    const route = found.find((d) => d.kind === 'climb' || d.kind === 'sequence' || d.kind === 'comparison')?.data?.route
    if (route?.color) setColor(route.color)
    if (route?.grade) setGrade(route.grade)
    if (route?.name && !title) setTitle(route.name)
    const bad = found.filter((f) => f.kind === 'text' || f.kind === 'unknown')
    toast(bad.length ? `${found.length - bad.length} recognised, ${bad.length} not` : `Read ${found.length} JSON document${found.length > 1 ? 's' : ''}`, bad.length ? 'warn' : 'ok')
  }

  const loadSample = async (kind: 'raw' | 'pipeline') => {
    const base = '/examples/green-vb/'
    const files = kind === 'raw' ? ['gateway/sam3.1-track.json', 'gateway/vitpose-plus-large.json'] : ['climb.json', 'sequence.json', 'holds.json', 'comparison.json']
    const fetched = await Promise.all([...files, 'climb.mp4'].map(async (f) => {
      const b = await (await fetch(base + f)).blob()
      return new File([b], f.split('/').pop()!, { type: f.endsWith('.mp4') ? 'video/mp4' : 'application/json' })
    }))
    setItems([])
    await add(fetched)
    setTitle(kind === 'raw' ? 'Green VB — read live from VLM output' : 'Green VB — pipeline import')
    setClimber('Jeremy Park')
    setColor('green')
    setGrade('VB')
    toast(kind === 'raw' ? 'Loaded real SAM 3.1 + ViTPose+ responses' : 'Loaded vision-demos outputs', 'info')
  }

  const state = assess(items)
  const video = items.find((i) => i.kind === 'video')

  const open = async () => {
    try {
      const { session, warnings } = sessionFromItems(items, { title, climber, color, grade, videoAspect: video?.data ? video.data.w / video.data.h : undefined })
      if (video?.data && session.video && !session.video.width) Object.assign(session.video, { width: video.data.w, height: video.data.h })
      // A clip from the bundled example already carries its overlays.
      if (video && video.name === 'climb.mp4' && session.video) session.video.overlays = 'burned-in'
      warnings.forEach((w) => toast(w, 'warn'))
      if (session.video && !session.wall) {
        const plate = await buildWallPlate(session)
        if (plate) session.wall = { src: plate, affine: session.video.affine ?? [[1, 0, 0], [0, 1, 0]] }
      }
      const ok = await saveSession(session)
      if (ok) toast('Saved to this browser', 'info')
      onSession(session)
    } catch (e) {
      toast((e as Error).message, 'warn')
    }
  }

  const runLive = async () => {
    if (!video?.file) return
    const ctl = new AbortController()
    abort.current = ctl
    setLive({ stages: {}, upload: 0, started: Date.now(), file: video })
    try {
      const r = await analyzeLive(video.file, { color }, (e) => setLive((l) => l && { ...l, stages: { ...l.stages, [e.stage]: e } }), (p) => setLive((l) => l && { ...l, upload: p }), ctl.signal)
      setLive((l) => l && { ...l, stages: { ...l.stages, read: { type: 'stage', stage: 'read', status: 'running' } } })
      await new Promise((res) => setTimeout(res, 400))
      const a = analyzePayloads(r.holds, r.poses, { color, aspect: r.meta.width / r.meta.height, fps: r.meta.fps })
      const s = buildSession({
        manifest: {
          climbr: 1,
          canvas: { width: r.meta.width, height: r.meta.height },
          torso: a.torso,
          video: { src: r.video, clock_offset: (a.startFrame ?? 0) / r.meta.fps, affine: [[1, 0, 0], [0, 1, 0]], width: r.meta.width, height: r.meta.height, overlays: 'none' },
          models: { holds: 'facebook/sam3.1', pose: 'usyd-community/vitpose-plus-large' },
        },
        climb: a.climb,
        holds: a.holds,
        kind: 'live',
        meta: { title: title || undefined, climber: climber || undefined, route: { color, grade } },
      })
      s.video!.mediaId = `${r.id}.mp4`
      const cost = (r.usage?.holds?.cost ?? 0) + (r.usage?.pose?.cost ?? 0)
      s.usage = { costUsd: cost }
      setLive((l) => l && { ...l, stages: { ...l.stages, read: { type: 'stage', stage: 'read', status: 'done', detail: `${a.climb.sequence?.length} holds used · ${a.climb.elapsed_seconds != null ? a.climb.elapsed_seconds.toFixed(2) + ' s' : 'no top-out'}` } } })
      a.warnings.forEach((w) => toast(w, 'warn'))
      const plate = await buildWallPlate(s)
      if (plate) s.wall = { src: plate, affine: [[1, 0, 0], [0, 1, 0]] }
      await saveSession(s)
      await new Promise((res) => setTimeout(res, 900))
      toast(`Analyzed with VLM Run${cost ? ` for $${cost.toFixed(3)}` : ''}`)
      setLive(null)
      onSession(s)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'warn')
      setLive(null)
    }
  }

  return (
    <motion.section className="import" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
      <div className="import-head">
        <span className="kicker">New climb</span>
        <h1>Bring a climb.</h1>
        <p className="muted">A phone video, the output folder from <code>vision-demos</code>, an iPhone LiDAR capture — or just paste the JSON a VLM returned. CLIMBR figures out what you gave it.</p>
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
              <motion.span animate={{ y: [0, -5, 0] }} transition={{ duration: 3, repeat: Infinity, delay: 0.4 }}><FileJson size={22} /></motion.span>
              <motion.span animate={{ y: [0, -5, 0] }} transition={{ duration: 3, repeat: Infinity, delay: 0.8 }}><Box size={22} /></motion.span>
            </div>
            <h3>Drop your climb here</h3>
            <p>.mov / .mp4 · climb.json · holds.json · comparison.json · wall.ply · raw VLM Run responses</p>
            <div className="dz-actions">
              <button className="btn" onClick={() => fileInput.current?.click()}><Upload size={15} /> Browse files</button>
              <button className="btn ghost" onClick={() => folderInput.current?.click()}><FolderOpen size={15} /> Output folder</button>
            </div>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
            <input ref={folderInput} type="file" hidden multiple {...({ webkitdirectory: '' } as any)} onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
          </div>

          <div className="card paste-card">
            <div className="limb-head"><span className="kicker"><ClipboardPaste size={12} /> Paste VLM JSON</span><span className="kicker dim">one or many documents</span></div>
            <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'{ "content": { "object": "vid.segment.masks", … } }\n\n…or climb.json, sequence.json, comparison.json, a chat completion from the gateway'} spellCheck={false} />
            <div className="paste-actions">
              <button className="btn" disabled={!paste.trim()} onClick={readPaste}><Wand2 size={15} /> Read JSON</button>
            </div>
          </div>

          <div className="samples">
            <span className="kicker">Try it with real output</span>
            <div className="sample-row">
              <button className="sample" onClick={() => loadSample('raw')}>
                <Sparkles size={16} />
                <span><b>Raw VLM Run responses</b><em>SAM 3.1 tracks + ViTPose+ poses → read in your browser</em></span>
                <ArrowRight size={15} />
              </button>
              <button className="sample" onClick={() => loadSample('pipeline')}>
                <FileJson size={16} />
                <span><b>vision-demos outputs</b><em>climb · sequence · holds · comparison .json</em></span>
                <ArrowRight size={15} />
              </button>
            </div>
          </div>
        </div>

        <div className="import-right">
          <div className="card detected">
            <div className="limb-head"><span className="kicker">Detected</span>{items.length > 0 && <button className="link" onClick={() => setItems([])}>Clear</button>}</div>
            {items.length === 0 && <p className="muted xs">Nothing yet. Everything you add shows up here with what CLIMBR recognised it as.</p>}
            <AnimatePresence initial={false}>
              {items.map((d) => (
                <motion.div key={d.id} className={`det ${d.kind === 'unknown' || d.kind === 'text' ? 'bad' : ''}`} layout initial={{ opacity: 0, y: -8, height: 0 }} animate={{ opacity: 1, y: 0, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                  <span className="det-icon">{iconFor(d.kind)}</span>
                  <span className="det-text"><b>{d.label}</b><em>{d.name !== 'pasted' ? `${d.name} · ` : ''}{d.detail}</em></span>
                  <button className="icon-btn" onClick={() => setItems((xs) => xs.filter((x) => x.id !== d.id))} aria-label="Remove"><X size={14} /></button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

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
              {state.ready ? <CheckCircle2 size={16} className="ok" /> : <span className="dot-idle" />}
              <span>{state.summary}</span>
            </div>
            {state.missing.length > 0 && items.length > 0 && <ul className="missing">{state.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
            {state.needsLive ? (
              <button className="btn primary wide" disabled={!health?.connected} onClick={runLive}>
                <Sparkles size={15} /> Analyze with VLM Run
              </button>
            ) : (
              <button className="btn primary wide" disabled={!state.ready} onClick={open}>
                Open replay <ArrowRight size={15} />
              </button>
            )}
            {state.needsLive && !health?.connected && <p className="muted xs">Live analysis needs the CLIMBR server with a <code>VLMRUN_API_KEY</code> in <code>.env</code>.</p>}
            {state.needsLive && health?.connected && <p className="muted xs">SAM 3.1 tracks the {color} holds and ViTPose+ poses every frame — usually under a minute and a few cents.</p>}
          </div>

          {recent.length > 0 && (
            <div className="card recent">
              <span className="kicker">Saved in this browser</span>
              {recent.slice(0, 5).map((r) => (
                <div key={r.id} className="recent-row">
                  <a href={`#/session/${encodeURIComponent(r.id)}`}><b>{r.session.title}</b><em>{r.session.route.color} · {r.session.route.grade} · {r.session.elapsed?.toFixed(2) ?? '—'} s</em></a>
                  <button className="icon-btn" onClick={async () => { await deleteSession(r.id); setRecent(await listSessions()) }} aria-label="Delete"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>{live && <AnalyzeOverlay live={live} color={color} onCancel={() => { abort.current?.abort(); setLive(null) }} />}</AnimatePresence>
    </motion.section>
  )
}

function videoMeta(url: string): Promise<{ w: number; h: number; dur: number } | null> {
  return new Promise((res) => {
    const v = document.createElement('video')
    const done = setTimeout(() => res(null), 4000) // a codec the browser cannot parse may never answer
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => { clearTimeout(done); res({ w: v.videoWidth, h: v.videoHeight, dur: v.duration }) }
    v.onerror = () => { clearTimeout(done); res(null) }
    v.src = url
  })
}

const STAGES: { key: StageKey; label: string; model?: string }[] = [
  { key: 'upload', label: 'Uploading the clip' },
  { key: 'transcode', label: 'Preparing video', model: 'H.264 · 30 fps' },
  { key: 'holds', label: 'Segmenting holds', model: 'facebook/sam3.1' },
  { key: 'pose', label: 'Tracking the climber', model: 'vitpose-plus-large' },
  { key: 'read', label: 'Reading the route', model: 'in your browser' },
]

function AnalyzeOverlay({ live, color, onCancel }: { live: { stages: Partial<Record<StageKey, StageEvent>>; upload: number; started: number; file: Detected }; color: string; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(id) }, [])
  const route = ROUTE_COLORS[color] ?? ROUTE_COLORS.green
  const statusOf = (k: StageKey) => {
    if (k === 'upload') return live.stages.upload?.status === 'done' ? 'done' : 'running'
    return live.stages[k]?.status ?? 'pending'
  }
  return (
    <motion.div className="analyze" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="analyze-card" initial={{ scale: 0.96, y: 20 }} animate={{ scale: 1, y: 0 }} style={{ ['--route' as string]: route }}>
        <div className="analyze-video">
          <video src={live.file.url} autoPlay muted loop playsInline />
          <div className="scanline" />
          <div className="scan-grid" />
          <span className="chip glass"><span className="rec-dot" /> VLM Run</span>
        </div>
        <div className="analyze-body">
          <span className="kicker">Analyzing · {((now - live.started) / 1000).toFixed(1)} s</span>
          <h2>Reading your climb</h2>
          <ul className="stages">
            {STAGES.map((st) => {
              const s = statusOf(st.key)
              const ev = live.stages[st.key]
              return (
                <li key={st.key} className={s}>
                  <span className="st-icon">{s === 'done' ? <CheckCircle2 size={17} /> : s === 'running' ? <Loader2 size={17} className="spin" /> : s === 'skipped' ? <CheckCircle2 size={17} /> : <span className="st-dot" />}</span>
                  <span className="st-text">
                    <b>{st.label}</b>
                    <em>{st.key === 'upload' && s !== 'done' ? `${Math.round(live.upload * 100)}%` : ev?.detail ?? st.model ?? ''}</em>
                    {st.key === 'transcode' && s === 'running' && ev?.progress != null && <span className="st-bar"><i style={{ width: `${ev.progress * 100}%` }} /></span>}
                  </span>
                </li>
              )
            })}
          </ul>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>
      </motion.div>
    </motion.div>
  )
}
