// The wall in 3D, in meters: x right, y up (floor at 0), z out of the wall.
//
// With a rock_climbing_3d capture the cloud is the real one (wall.ply). Without
// depth, CLIMBR builds a stand-in from the climber-free wall photo: every pixel
// becomes a point on a gently overhanging plane, the route's holds stand proud
// by an amount that grows with their size, and the mats fold forward onto the
// floor. The panel says which of the two it is drawing.

import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { centroid, invertAffine, polygonArea, signedDistance } from './geometry'
import type { Hold, Session, Vec2 } from './types'

export interface WallModel {
  toWorld: (p: Vec2, z?: number) => [number, number, number]
  surfaceZ: (y: number) => number
  holdDepth: Map<number, number>
  angleDeg: number
  centerX: number
  aspect: number
  mpu: number
  floorY: number
  heightM: number
  knee: number
  tan: number
}

export function wallModel(s: Session, angleDeg = s.lidar?.wallAngleDeg ?? 3): WallModel {
  const aspect = s.canvas.width / s.canvas.height
  const mpu = s.scale?.metersPerUnit ?? 4
  const floorY = s.scale?.floorY ?? Math.max(...s.holds.map((h) => h.bbox[1] + h.bbox[3])) + 0.07
  const xs = s.holds.map((h) => h.center[0])
  const top = Math.min(...s.holds.map((h) => h.bbox[1]))
  const m: WallModel = {
    angleDeg,
    aspect,
    mpu,
    floorY,
    centerX: (Math.min(...xs) + Math.max(...xs)) / 2,
    knee: 0.9, // meters: the kicker below is vertical, the wall above leans out
    tan: Math.tan((angleDeg * Math.PI) / 180),
    heightM: (floorY - top) * mpu,
    holdDepth: new Map(),
    surfaceZ: (y) => (y > m.knee ? (y - m.knee) * m.tan : 0),
    toWorld: (p, z = 0) => {
      const x = (p[0] - m.centerX) * m.aspect * m.mpu
      const y = (m.floorY - p[1]) * m.mpu
      return [x, y, m.surfaceZ(y) + z]
    },
  }
  for (const h of s.holds) {
    const areaM2 = polygonArea(h.polygon) * aspect * mpu * mpu
    m.holdDepth.set(h.id, h.depth != null ? Math.max(0.02, h.depth) : Math.min(0.14, 0.025 + Math.sqrt(areaM2) * 0.38))
  }
  return m
}

export interface Cloud { positions: Float32Array; colors: Float32Array; count: number; source: 'photo' | 'procedural' | 'lidar' }

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => res(img)
    img.onerror = rej
    img.src = src
  })
}

// Deterministic noise, so the cloud is identical on every visit.
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

function holdBump(holds: Hold[], m: WallModel) {
  // For a canvas point: how far it rises off the wall, from the hold under it.
  const prepared = holds.map((h) => {
    let inner = 0
    const c = centroid(h.polygon)
    inner = Math.max(1e-4, signedDistance(h.polygon, c[0], c[1], m.aspect))
    return { h, inner, depth: m.holdDepth.get(h.id) ?? 0.05, bbox: h.bbox }
  })
  return (cx: number, cy: number): number => {
    for (const p of prepared) {
      const [x, y, w, hh] = p.bbox
      if (cx < x || cy < y || cx > x + w || cy > y + hh) continue
      const d = signedDistance(p.h.polygon, cx, cy, m.aspect)
      if (d > 0) return p.depth * Math.sqrt(Math.min(1, d / p.inner))
    }
    return 0
  }
}

export async function buildCloud(s: Session, m: WallModel): Promise<Cloud> {
  if (s.lidar?.plyUrl) return loadPly(s.lidar.plyUrl, s, m)
  if (s.wall?.src) {
    try { return await cloudFromPhoto(s, m) } catch { /* fall through */ }
  }
  return proceduralCloud(s, m)
}

async function cloudFromPhoto(s: Session, m: WallModel): Promise<Cloud> {
  const img = await loadImage(s.wall!.src)
  const W = 300, H = Math.round((300 * img.naturalHeight) / img.naturalWidth)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, W, H)
  const px = ctx.getImageData(0, 0, W, H).data
  const inv = invertAffine(s.wall!.affine)
  const bump = holdBump(s.holds, m)
  const rand = rng(7)
  const gauss = () => (rand() + rand() + rand() - 1.5) * 0.8
  const pos: number[] = [], col: number[] = []
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const u = (ix + 0.5) / W, v = (iy + 0.5) / H
      // LiDAR thins out toward the edges of what the phone saw.
      const edge = Math.min(u, v, 1 - u, 1 - v)
      if (rand() < Math.max(0.06, 1 - edge / 0.07) * (edge < 0.07 ? 0.85 : 0.08)) continue
      const cx = inv[0][0] * u + inv[0][1] * v + inv[0][2]
      const cy = inv[1][0] * u + inv[1][1] * v + inv[1][2]
      const k = (iy * W + ix) * 4
      const r = px[k] / 255, g = px[k + 1] / 255, b = px[k + 2] / 255
      let [x, y, z] = m.toWorld([cx, cy])
      if (y < 0) {
        // Below the wall's foot: the mats, folded forward onto the floor.
        z = -y * 1.7
        y = 0
      } else {
        z += bump(cx, cy)
      }
      const j = gauss() * 0.004
      pos.push(x + gauss() * 0.002, y + gauss() * 0.002, z + j)
      col.push(r, g, b)
    }
  }
  return { positions: new Float32Array(pos), colors: new Float32Array(col), count: pos.length / 3, source: 'photo' }
}

function proceduralCloud(s: Session, m: WallModel): Cloud {
  const rand = rng(11)
  const pos: number[] = [], col: number[] = []
  const xs = s.holds.flatMap((h) => h.polygon.map((p) => m.toWorld(p)[0]))
  const x0 = Math.min(...xs) - 1.2, x1 = Math.max(...xs) + 1.2
  const top = m.heightM + 0.6
  const bump = holdBump(s.holds, m)
  const step = 0.012
  for (let y = 0; y < top; y += step) {
    for (let x = x0; x < x1; x += step) {
      if (rand() < 0.12) continue
      const cx = x / (m.aspect * m.mpu) + m.centerX
      const cy = m.floorY - y / m.mpu
      const b = bump(cx, cy)
      const tnut = Math.abs(((x * 5 + 100) % 1) - 0.5) < 0.04 && Math.abs(((y * 5 + 100) % 1) - 0.5) < 0.04
      const panel = (Math.floor(x / 1.22) + Math.floor(y / 2.44)) % 2 === 0 ? 0.03 : 0
      let c: [number, number, number] = tnut ? [0.25, 0.23, 0.2] : [0.82 - panel, 0.76 - panel, 0.66 - panel]
      if (b > 0) c = [0.28, 0.78, 0.36]
      pos.push(x, y, m.surfaceZ(y) + b + (rand() - 0.5) * 0.006)
      col.push(...c)
    }
  }
  for (let z = 0; z < 2.2; z += step * 1.4) for (let x = x0; x < x1; x += step * 1.4) {
    if (rand() < 0.3) continue
    const g = 0.28 + rand() * 0.04
    pos.push(x, 0, z)
    col.push(g, g, g * 1.04)
  }
  return { positions: new Float32Array(pos), colors: new Float32Array(col), count: pos.length / 3, source: 'procedural' }
}

/** rock_climbing_3d's wall.ply: meters, +y up, already in the route's frame.
 *  holds.json was flattened into the bounding box of the hold outlines, which
 *  the writer painted in the route colour — so that box is recovered here. */
async function loadPly(url: string, s: Session, m: WallModel): Promise<Cloud> {
  const geo = await new PLYLoader().loadAsync(url)
  const p = geo.getAttribute('position').array as Float32Array
  const c = (geo.getAttribute('color')?.array as Float32Array) ?? new Float32Array(p.length).fill(0.8)
  const n = p.length / 3
  let floor = Infinity
  for (let i = 0; i < n; i++) floor = Math.min(floor, p[i * 3 + 1])
  const routeRgb = { green: [60, 200, 80], orange: [255, 140, 0], blue: [30, 130, 255], yellow: [255, 215, 0], red: [235, 40, 40], purple: [170, 80, 220], pink: [255, 105, 180], white: [245, 245, 245], black: [150, 150, 150] }[s.route.color] ?? [255, 140, 0]
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity]
  for (let i = 0; i < n; i++) {
    const r = Math.round(c[i * 3] * 255), g = Math.round(c[i * 3 + 1] * 255), b = Math.round(c[i * 3 + 2] * 255)
    if (Math.abs(r - routeRgb[0]) < 3 && Math.abs(g - routeRgb[1]) < 3 && Math.abs(b - routeRgb[2]) < 3) {
      lo = [Math.min(lo[0], p[i * 3]), Math.min(lo[1], p[i * 3 + 1])]
      hi = [Math.max(hi[0], p[i * 3]), Math.max(hi[1], p[i * 3 + 1])]
    }
  }
  const pos = new Float32Array(p.length)
  for (let i = 0; i < n; i++) {
    pos[i * 3] = p[i * 3]
    pos[i * 3 + 1] = p[i * 3 + 1] - floor
    pos[i * 3 + 2] = p[i * 3 + 2]
  }
  if (Number.isFinite(lo[0])) {
    // holds.json was normalized into this box, y flipped: x = lo.x + u·span.x,
    // y = lo.y + (1 − v)·span.y. Make toWorld say exactly that.
    const span: Vec2 = [hi[0] - lo[0], hi[1] - lo[1]]
    const loY = lo[1] - floor
    s.lidar = { ...s.lidar, bounds: { lo: [lo[0], loY], span } }
    m.mpu = span[1]
    m.aspect = span[0] / span[1]
    m.centerX = -lo[0] / span[0]
    m.floorY = 1 + loY / span[1]
    m.tan = 0 // the scan is the wall's real shape; no modelled overhang
    m.heightM = hi[1] - floor
  }
  return { positions: pos, colors: c, count: n, source: 'lidar' }
}
