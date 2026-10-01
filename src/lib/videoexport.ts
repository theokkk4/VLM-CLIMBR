// The analysis video: the clip with everything the replay draws over it burned
// in — each hold where SAM 3.1 saw it, lit once used, the climber's ViTPose+
// skeleton, the clock and the sequence. Rendered in the browser only when asked
// for, in real time: the clip plays once into a canvas that MediaRecorder
// records. MP4 where the browser can record it, WebM otherwise.

import { download, slug } from './download'
import { polygonPath } from './geometry'
import { LIMB_JOINT, overlayAt } from './overlay'
import { BONES, DRAW_MIN_CONFIDENCE } from './skeleton'
import { buildTimeline } from './timeline'
import { LIMBS, LIMB_BY_KEY, ROUTE_COLORS, type Session, type Vec2 } from './types'

// H.264 MP4 plays everywhere; a browser that cannot record it gets WebM rather
// than an MP4 with a codec QuickTime will not open.
const TYPES = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']

export function canExportVideo(s: Session) {
  return Boolean(s.video?.src) && typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' && TYPES.some((t) => MediaRecorder.isTypeSupported(t))
}

export async function exportAnalysisVideo(s: Session, { onProgress, signal }: { onProgress?: (p: number) => void; signal?: AbortSignal } = {}) {
  const v = s.video
  if (!v?.src) throw new Error('This climb has no video to render.')
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t))
  if (!type) throw new Error('This browser cannot record video.')
  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  el.preload = 'auto'
  el.crossOrigin = 'anonymous'
  for (const src of [v.src, v.webm].filter(Boolean) as string[]) {
    const so = document.createElement('source')
    so.src = src
    if (src.endsWith('.webm')) so.type = 'video/webm'
    el.appendChild(so)
  }
  el.load()
  await new Promise<void>((res, rej) => {
    el.addEventListener('loadeddata', () => res(), { once: true })
    el.addEventListener('error', () => rej(new Error('The clip could not be loaded for rendering.')), { once: true })
  })

  const W = el.videoWidth, H = el.videoHeight
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const tl = buildTimeline(s)
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const u = H / 1280 // one UI unit, at the clip's own scale
  const P = (q: Vec2): Vec2 => [q[0] * W, q[1] * H]

  const draw = () => {
    const vt = el.currentTime
    const t = vt - v.offset
    ctx.drawImage(el, 0, 0, W, H)
    const ov = overlayAt(s, tl, t)
    if (ov) {
      for (const h of ov.holds) {
        const path = new Path2D(polygonPath(h.poly, P))
        if (h.lit) {
          ctx.globalAlpha = h.held ? 0.6 : 0.4
          ctx.fillStyle = route
          ctx.fill(path)
          ctx.globalAlpha = 1
        }
        ctx.lineJoin = 'round'
        ctx.lineWidth = (h.held ? 4.5 : 3) * u
        ctx.strokeStyle = h.held ? '#fff' : route
        ctx.stroke(path)
      }
      const j = ov.joints
      if (j) {
        ctx.lineCap = 'round'
        ctx.lineWidth = 4 * u
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'
        for (const [a, b] of BONES) {
          if (j[a].c < DRAW_MIN_CONFIDENCE || j[b].c < DRAW_MIN_CONFIDENCE) continue
          const [x1, y1] = P(j[a].p), [x2, y2] = P(j[b].p)
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
        }
        for (const l of LIMBS) {
          const k = j[LIMB_JOINT[l.key]]
          if (k.c < DRAW_MIN_CONFIDENCE) continue
          const [x, y] = P(k.p)
          dot(ctx, x, y, (ov.holding.get(l.key) != null ? 13 : 8) * u, l.color, u)
        }
      }
      for (const { key, p } of ov.fallbackLimbs) dot(ctx, P(p)[0], P(p)[1], 9 * u, LIMB_BY_KEY[key].color, u)
    }
    hud(ctx, s, tl.litAt(t), t, tl.climbEnd, W, H, u, route)
  }

  const stream = canvas.captureStream(30)
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const stopped = new Promise<void>((res) => { rec.onstop = () => res() })

  let raf = 0
  const frame = () => {
    draw()
    onProgress?.(Math.min(1, el.currentTime / (el.duration || 1)))
    raf = 'requestVideoFrameCallback' in el ? (el as any).requestVideoFrameCallback(frame) : requestAnimationFrame(frame)
  }
  const cancel = () => el.pause()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    el.currentTime = 0
    await new Promise((res) => el.addEventListener('seeked', res, { once: true }))
    draw()
    rec.start(500)
    frame()
    await el.play()
    await new Promise<void>((res, rej) => {
      el.addEventListener('ended', () => res(), { once: true })
      el.addEventListener('error', () => rej(new Error('Playback stopped while rendering.')), { once: true })
      signal?.addEventListener('abort', () => rej(new DOMException('Cancelled', 'AbortError')), { once: true })
    })
    draw()
  } finally {
    if ('cancelVideoFrameCallback' in el) (el as any).cancelVideoFrameCallback(raf)
    cancelAnimationFrame(raf)
    if (rec.state !== 'inactive') rec.stop()
    signal?.removeEventListener('abort', cancel)
  }
  await stopped
  stream.getTracks().forEach((tr) => tr.stop())
  let blob = new Blob(chunks, { type: type.split(';')[0] })
  if (!blob.size) throw new Error('The recording came out empty.')
  if (blob.type === 'video/webm') blob = await withWebmDuration(blob, el.duration * 1000)
  download(`${slug(s)}-analysis.${type.startsWith('video/mp4') ? 'mp4' : 'webm'}`, blob)
  return { bytes: blob.size, type: blob.type, seconds: el.duration }
}

/** MediaRecorder's WebM has no Duration, so players cannot seek it. Write one
 *  into the Segment's Info element (in TimecodeScale units: ms by default). */
async function withWebmDuration(blob: Blob, ms: number): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 16)).arrayBuffer())
  const find = (id: number[], from = 0) => {
    for (let i = from; i < head.length - id.length; i++) if (id.every((b, k) => head[i + k] === b)) return i
    return -1
  }
  const vint = (at: number) => {
    const first = head[at]
    let len = 1
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
    let v = first & (0xff >> len)
    for (let k = 1; k < len; k++) v = v * 256 + head[at + k]
    return { len, v }
  }
  const info = find([0x15, 0x49, 0xa9, 0x66])
  if (info < 0) return blob
  const size = vint(info + 4)
  const start = info + 4 + size.len, end = start + size.v
  if (end > head.length || find([0x44, 0x89], start) > -1 && find([0x44, 0x89], start) < end) return blob
  const duration = new Uint8Array(11)
  duration.set([0x44, 0x89, 0x88])
  new DataView(duration.buffer).setFloat64(3, ms)
  const newSize = size.v + duration.length
  const sizeBytes = new Uint8Array(8) // an 8-byte vint always fits
  sizeBytes[0] = 0x01
  for (let k = 7, v = newSize; k >= 1; k--, v = Math.floor(v / 256)) sizeBytes[k] = v & 0xff
  return new Blob([head.slice(0, info + 4), sizeBytes, head.slice(start, end), duration, blob.slice(end)], { type: blob.type })
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, u: number) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = 2.5 * u
  ctx.strokeStyle = '#000'
  ctx.stroke()
}

/** The clock, the route and the holds used so far, over a soft scrim. */
function hud(ctx: CanvasRenderingContext2D, s: Session, lit: number[], t: number, climbEnd: number, W: number, H: number, u: number, route: string) {
  ctx.save()
  const top = ctx.createLinearGradient(0, 0, 0, 190 * u)
  top.addColorStop(0, 'rgba(4,5,6,0.72)')
  top.addColorStop(1, 'rgba(4,5,6,0)')
  ctx.fillStyle = top
  ctx.fillRect(0, 0, W, 190 * u)
  const bottom = ctx.createLinearGradient(0, H - 200 * u, 0, H)
  bottom.addColorStop(0, 'rgba(4,5,6,0)')
  bottom.addColorStop(1, 'rgba(4,5,6,0.78)')
  ctx.fillStyle = bottom
  ctx.fillRect(0, H - 200 * u, W, 200 * u)

  const pad = 36 * u
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#fff'
  ctx.font = `800 ${30 * u}px Geist, system-ui, sans-serif`
  ctx.fillText('CLIMBR', pad, pad + 26 * u)
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.font = `650 ${22 * u}px Geist, system-ui, sans-serif`
  ctx.fillText(s.title, pad, pad + 62 * u)
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = `600 ${16 * u}px Geist, system-ui, sans-serif`
  ctx.fillText(`${s.climber} · ${s.route.color} ${s.route.grade} · SAM 3.1 + ViTPose+ via VLM Run`, pad, pad + 88 * u)

  const topped = s.toppedOut && t >= climbEnd
  const clock = Math.max(0, Math.min(t, climbEnd))
  ctx.textAlign = 'right'
  ctx.fillStyle = topped ? '#F5C542' : '#fff'
  ctx.font = `760 ${58 * u}px Geist, system-ui, sans-serif`
  ctx.fillText(`${clock.toFixed(2)} s`, W - pad, pad + 48 * u)
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.font = `700 ${18 * u}px Geist, system-ui, sans-serif`
  ctx.fillText(t < 0 ? 'PULLING ON' : topped ? 'TOPPED OUT' : t < climbEnd ? 'ON THE WALL' : 'CLIMB OVER', W - pad, pad + 80 * u)

  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = `700 ${17 * u}px Geist, system-ui, sans-serif`
  ctx.fillText(`SEQUENCE · ${lit.length}/${s.holdsDetected} HOLDS`, pad, H - pad - 58 * u)
  // As many of the latest holds as fit on one line.
  ctx.font = `800 ${40 * u}px Geist, system-ui, sans-serif`
  const room = W - 2 * pad
  while (lit.length > 1 && ctx.measureText(lit.join(' › ') + ' ').width > room) lit = lit.slice(1)
  let x = pad
  lit.forEach((id, i) => {
    if (i) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillText('›', x, H - pad)
      x += ctx.measureText('› ').width
    }
    ctx.fillStyle = id === s.finalHoldId && topped ? '#F5C542' : route
    ctx.fillText(String(id), x, H - pad)
    x += ctx.measureText(`${id} `).width
  })
  ctx.restore()
}
