// Development only: what a live run measured, end to end, and every check it
// passed or failed. The raw gateway responses are one click away.

import { motion } from 'framer-motion'
import { CheckCircle2, ExternalLink, X, XCircle } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Session } from '../lib/types'

export function DebugPanel({ session: s, onClose }: { session: Session; onClose: () => void }) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])
  const a = s.analysis!
  const r = a.reading
  const span = (x: [number, number] | null) => (x ? `${x[0].toFixed(2)}–${x[1].toFixed(2)} s` : '—')
  const rows: [string, string][] = [
    ['clip', `${a.source.name} · ${a.source.sourceFormat} · ${(a.source.bytes / 1e6).toFixed(1)} MB`],
    ['source', `${a.source.width}×${a.source.height} · ${a.source.fps.toFixed(2)} fps · ${a.source.duration.toFixed(3)} s · ${a.source.frameCount} frames`],
    ['analyzed', `${a.analysis.width}×${a.analysis.height} · ${a.analysis.frameCount} frames at ${a.analysis.fps} fps`],
    ['SAM 3.1', `“${a.sam.prompt}” · ${a.sam.samples} frames (${span(a.sam.span)}) · ${a.sam.tracks} tracks · ${a.sam.detections} masks · ${a.sam.coords}`],
    ['ViTPose+', `${a.pose.framesPosed} frames (${span(a.pose.span)}) · ${a.pose.people} people · ${a.pose.keypoints} · ${a.pose.coords}`],
    ['climber', `${r.climberFrames} frames (${span(r.climberSpan)}) · pose at ${r.poseFps} fps`],
    ['camera', `${r.camera} · ${r.registeredSamples}/${r.samSamples} frames placed · misfit ${r.misfit ?? '—'} hold heights`],
    ['holds', `${r.holds} on the route from ${r.holdTracks} tracks${r.movingTracks ? ` · ${r.movingTracks} moving rejected` : ''}`],
    ['read', `${r.framesRead} frames · ${r.contacts} contacts → ${r.moves} moves · start: ${r.start} · ${r.toppedOut ? 'topped out' : 'no top-out'}`],
    ['clock', `climb starts at ${s.video!.offset.toFixed(2)} s of ${(s.video!.duration ?? 0).toFixed(2)} s · session ${s.duration.toFixed(2)} s`],
  ]
  return (
    <motion.div className="sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="sheet debug-sheet" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn sheet-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        <div className="sheet-body">
          <span className="kicker">Debug · run {a.runId.slice(0, 8)}</span>
          <h2>What this analysis measured</h2>
          <dl className="debug-rows">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <span className="kicker">Checks</span>
          <ul className="debug-checks">
            {a.validation.map((c) => (
              <li key={c.id} className={c.ok ? 'ok' : c.severity}>
                {c.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <b>{c.label}</b><span>{c.detail}</span>
              </li>
            ))}
          </ul>
          {a.warnings.length > 0 && <><span className="kicker">Warnings</span><ul className="debug-warn">{a.warnings.map((w) => <li key={w}>{w}</li>)}</ul></>}
          {a.debug && (
            <div className="debug-links">
              <a className="link" href={a.debug} target="_blank" rel="noreferrer">run.json <ExternalLink size={12} /></a>
              <a className="link" href={`${a.debug}/sam.raw.json`} target="_blank" rel="noreferrer">SAM 3.1 raw <ExternalLink size={12} /></a>
              <a className="link" href={`${a.debug}/pose.raw.json`} target="_blank" rel="noreferrer">ViTPose+ raw <ExternalLink size={12} /></a>
              <a className="link" href={`${a.debug}/client.json`} target="_blank" rel="noreferrer">browser report <ExternalLink size={12} /></a>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
