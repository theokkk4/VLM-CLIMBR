// Keyframes for the coach, cut in the browser: a handful of evenly spaced
// frames of the clip as small JPEGs. Doing it here means the server needs no
// ffmpeg for coaching — which is what lets it run as a Vercel function.

import type { Session } from './types'

function once(el: HTMLMediaElement, ev: string, ms = 6000) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms)
    el.addEventListener(ev, () => { clearTimeout(t); res() }, { once: true })
    el.addEventListener('error', () => { clearTimeout(t); rej(new Error('video error')) }, { once: true })
  })
}

export async function sampleFrames(s: Session, n = 8, width = 448): Promise<string[]> {
  const v = s.video
  if (!v?.src) return []
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
  try {
    el.load()
    await once(el, 'loadeddata')
  } catch {
    return []
  }
  const h = Math.round((width * el.videoHeight) / Math.max(1, el.videoWidth))
  const cv = document.createElement('canvas')
  cv.width = width
  cv.height = h
  const ctx = cv.getContext('2d')!
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    el.currentTime = ((i + 0.5) / n) * el.duration
    try { await once(el, 'seeked', 4000) } catch { continue }
    ctx.drawImage(el, 0, 0, width, h)
    try { out.push(cv.toDataURL('image/jpeg', 0.72)) } catch { return [] } // a tainted canvas
  }
  return out
}
