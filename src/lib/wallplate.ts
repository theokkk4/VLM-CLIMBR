// A photo of the wall with the climber taken out, built in the browser from the
// clip itself: a dozen frames spread across the climb, the climber's body masked
// out of each one (the torso track says where it was), and the median of what is
// left at every pixel. The same idea as vision-demos' wall.png, for a still
// camera. It is what the route backdrop and the 3D point cloud are coloured from.

import type { Session } from './types'

function once(el: HTMLMediaElement, ev: string, ms = 6000) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms)
    el.addEventListener(ev, () => { clearTimeout(t); res() }, { once: true })
    el.addEventListener('error', () => { clearTimeout(t); rej(new Error('video error')) }, { once: true })
  })
}

export async function buildWallPlate(s: Session, n = 12, width = 300): Promise<string | null> {
  const src = s.video?.src
  if (!src) return null
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.crossOrigin = 'anonymous'
  v.src = src
  try {
    await once(v, 'loadeddata')
  } catch {
    return null
  }
  const W = width, H = Math.round((width * v.videoHeight) / Math.max(1, v.videoWidth))
  if (!H) return null
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  const frames: Uint8ClampedArray[] = []
  const masks: Uint8Array[] = []
  const offset = s.video?.offset ?? 0
  const torsoAt = (t: number) => {
    const tr = s.torso
    if (!tr?.length) return null
    let best = tr[0]
    for (const p of tr) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p
    return Math.abs(best[0] - t) < 1 ? best : null
  }
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * v.duration
    v.currentTime = t
    try { await once(v, 'seeked', 4000) } catch { continue }
    ctx.drawImage(v, 0, 0, W, H)
    frames.push(ctx.getImageData(0, 0, W, H).data)
    const m = new Uint8Array(W * H)
    const tp = torsoAt(t - offset)
    if (tp) {
      // The body, as an ellipse around the torso: wide enough for the arms.
      const cx = tp[1] * W, cy = (tp[2] + 0.04) * H, rx = 0.2 * W, ry = 0.36 * H
      for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(H, Math.ceil(cy + ry)); y++) {
        for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(W, Math.ceil(cx + rx)); x++) {
          if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1) m[y * W + x] = 1
        }
      }
    }
    masks.push(m)
  }
  if (frames.length < 3) return null
  const out = ctx.createImageData(W, H)
  const buf = [0, 0, 0].map(() => new Array<number>(frames.length))
  for (let p = 0; p < W * H; p++) {
    let k = 0
    for (let f = 0; f < frames.length; f++) {
      if (masks[f][p]) continue
      buf[0][k] = frames[f][p * 4]; buf[1][k] = frames[f][p * 4 + 1]; buf[2][k] = frames[f][p * 4 + 2]
      k++
    }
    if (k === 0) {
      for (let f = 0; f < frames.length; f++) { buf[0][k] = frames[f][p * 4]; buf[1][k] = frames[f][p * 4 + 1]; buf[2][k] = frames[f][p * 4 + 2]; k++ }
    }
    for (let c = 0; c < 3; c++) {
      const a = buf[c].slice(0, k).sort((x, y) => x - y)
      out.data[p * 4 + c] = a[k >> 1]
    }
    out.data[p * 4 + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/jpeg', 0.86))
  return blob ? URL.createObjectURL(blob) : null
}
