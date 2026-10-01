import type { Vec2 } from './types'

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

export function bboxOf(points: Vec2[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of points) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1 - x0, y1 - y0]
}

export function polygonArea(points: Vec2[]): number {
  let a = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1])
  }
  return Math.abs(a / 2)
}

export function centroid(points: Vec2[]): Vec2 {
  let cx = 0, cy = 0, a = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const f = points[j][0] * points[i][1] - points[i][0] * points[j][1]
    cx += (points[j][0] + points[i][0]) * f
    cy += (points[j][1] + points[i][1]) * f
    a += f
  }
  if (Math.abs(a) < 1e-12) {
    const n = points.length || 1
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n]
  }
  return [cx / (3 * a), cy / (3 * a)]
}

function inside(points: Vec2[], x: number, y: number): boolean {
  let c = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay
  const len = dx * dx + dy * dy
  const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len) : 0
  const qx = ax + t * dx - px, qy = ay + t * dy - py
  return Math.sqrt(qx * qx + qy * qy)
}

/** Signed distance to a polygon's outline: positive inside, negative outside.
 *  `aspect` scales x so both axes are one physical unit — cv2.pointPolygonTest
 *  on the aspect-corrected contour, as the pipeline does. */
export function signedDistance(points: Vec2[], x: number, y: number, aspect = 1): number {
  let d = Infinity
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    d = Math.min(d, segDist(x * aspect, y, points[j][0] * aspect, points[j][1], points[i][0] * aspect, points[i][1]))
  }
  return inside(points, x, y) ? d : -d
}

export function applyAffine(m: number[][] | undefined, p: Vec2): Vec2 {
  if (!m) return p
  return [m[0][0] * p[0] + m[0][1] * p[1] + m[0][2], m[1][0] * p[0] + m[1][1] * p[1] + m[1][2]]
}

export function invertAffine(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f]] = m
  const det = a * e - b * d
  return [
    [e / det, -b / det, (b * f - c * e) / det],
    [-d / det, a / det, (c * d - a * f) / det],
  ]
}

export function gaussianSmooth(values: number[], sigma: number): number[] {
  if (sigma <= 0 || values.length < 3) return values.slice()
  const r = Math.ceil(sigma * 3)
  const w: number[] = []
  for (let i = -r; i <= r; i++) w.push(Math.exp(-0.5 * (i / sigma) ** 2))
  return values.map((_, i) => {
    let s = 0, ws = 0
    for (let k = -r; k <= r; k++) {
      const j = Math.min(values.length - 1, Math.max(0, i + k))
      s += values[j] * w[k + r]
      ws += w[k + r]
    }
    return s / ws
  })
}

export const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Path length of a polyline in canvas units, x scaled by aspect. */
export function pathLength(points: Vec2[], aspect = 1) {
  let s = 0
  for (let i = 1; i < points.length; i++) s += Math.hypot((points[i][0] - points[i - 1][0]) * aspect, points[i][1] - points[i - 1][1])
  return s
}

/** Catmull-Rom through points → SVG path data. */
export function smoothPath(points: Vec2[], toXY: (p: Vec2) => Vec2): string {
  if (points.length < 2) return ''
  const p = points.map(toXY)
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] ?? p2
    const c1: Vec2 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Vec2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  return d
}

export function polygonPath(points: Vec2[], toXY: (p: Vec2) => Vec2): string {
  return points.map((p, i) => {
    const [x, y] = toXY(p)
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join('') + 'Z'
}

/** Hold id → letter, as the 3D panel labels them (A…Z, then AA…). */
export function holdLetter(id: number): string {
  let n = id, s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s || '?'
}

export function mixHex(colors: string[]): string {
  if (!colors.length) return '#ffffff'
  const rgb = colors.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)))
  const avg = [0, 1, 2].map((k) => Math.round(rgb.reduce((s, c) => s + c[k], 0) / rgb.length))
  return '#' + avg.map((v) => v.toString(16).padStart(2, '0')).join('')
}

export function hexA(hex: string, alpha: number) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgba(${r},${g},${b},${alpha})`
}
