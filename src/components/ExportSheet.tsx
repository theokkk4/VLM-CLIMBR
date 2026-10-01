import { motion } from 'framer-motion'
import { Clapperboard, FileSpreadsheet, FileText, ImageDown, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { canExportVideo, exportAnalysisVideo } from '../lib/videoexport'
import type { Session } from '../lib/types'
import { toast } from './Toast'

export function ExportSheet({ session: s, onClose }: { session: Session; onClose: () => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const render = useRef<AbortController | null>(null)
  const close = useRef(onClose)
  close.current = () => { render.current?.abort(); onClose() }
  useEffect(() => {
    let live = true
    import('../lib/export').then(({ renderShareCard }) => renderShareCard(s)).then((c) => live && setPreview(c.toDataURL('image/png')))
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => { live = false; window.removeEventListener('keydown', esc); render.current?.abort() }
  }, [s])

  // The exporters (and jsPDF) load on first use, not with the app.
  const lib = () => import('../lib/export')
  const run = async (id: string, fn: (x: Awaited<ReturnType<typeof lib>>) => unknown, msg: string) => {
    setBusy(id)
    try {
      await fn(await lib())
      toast(msg)
    } catch (e) {
      toast((e as Error).message, 'warn')
    } finally {
      setBusy(null)
    }
  }

  // Rendered only when asked for: the clip plays through once, overlays burned in.
  const renderVideo = async () => {
    const ctl = new AbortController()
    render.current = ctl
    setBusy('video')
    setProgress(0)
    try {
      const r = await exportAnalysisVideo(s, { onProgress: setProgress, signal: ctl.signal })
      toast(`Analysis video saved · ${(r.bytes / 1e6).toFixed(1)} MB ${r.type === 'video/mp4' ? 'MP4' : 'WebM'}`)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'warn')
    } finally {
      render.current = null
      setBusy(null)
    }
  }

  const video = canExportVideo(s)
  const options = [
    { id: 'video', icon: <Clapperboard size={18} />, title: 'Analysis video', sub: video ? `The replay with holds, skeleton and clock burned in · renders in ${s.video?.duration ? `~${Math.ceil(s.video.duration)} s` : 'real time'}` : 'Needs a clip and a browser that can record video', go: renderVideo, disabled: !video },
    { id: 'pdf', icon: <FileText size={18} />, title: 'Coach report', sub: 'PDF · feedback, drills, every move', go: () => run('pdf', (x) => x.exportPdf(s), 'Coach report saved') },
    { id: 'png', icon: <ImageDown size={18} />, title: 'Share card', sub: 'PNG · 1080×1350, ready for stories', go: () => run('png', (x) => x.exportShareCard(s), 'Share card saved') },
    { id: 'csv', icon: <FileSpreadsheet size={18} />, title: 'Moves', sub: 'CSV · limb, hold, time, contact', go: () => run('csv', (x) => x.exportCsv(s), 'Moves CSV saved') },
  ]

  return (
    <motion.div className="sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => close.current()}>
      <motion.div className="sheet" initial={{ opacity: 0, y: 40, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 30, scale: 0.98 }} transition={{ type: 'spring', stiffness: 320, damping: 32 }} onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn sheet-close" onClick={() => close.current()} aria-label="Close"><X size={16} /></button>
        <div className="sheet-preview">
          {preview ? <motion.img src={preview} alt="Share card preview" initial={{ opacity: 0, rotate: -2, y: 10 }} animate={{ opacity: 1, rotate: -1.5, y: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 20 }} /> : <div className="spinner" />}
        </div>
        <div className="sheet-body">
          <span className="kicker">Export</span>
          <h2>Take your climb with you</h2>
          <p className="muted">Your feedback{s.coach?.source === 'vlm' ? ` from ${s.coach.model}` : ''}, the route, and the raw numbers — in the formats you’ll actually use.</p>
          <div className="export-list">
            {options.map((o, i) => (
              <motion.button key={o.id} className="export-opt" onClick={o.go} disabled={busy !== null || o.disabled} initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.08 + i * 0.05 }}>
                <span className="export-icon">{busy === o.id ? <Loader2 size={18} className="spin" /> : o.icon}</span>
                <span className="export-text">
                  <b>{o.title}</b>
                  <span>{busy === 'video' && o.id === 'video' ? `Rendering… ${Math.round(progress * 100)}% · close to cancel` : o.sub}</span>
                  {busy === 'video' && o.id === 'video' && <span className="st-bar export-bar"><i style={{ width: `${progress * 100}%` }} /></span>}
                </span>
              </motion.button>
            ))}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
