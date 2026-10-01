// Camera motion, read from SAM 3.1's own hold tracks.
//
// Holds are bolted to the wall, so when a hold moves in the picture the camera
// moved. For every frame SAM sampled, a similarity (scale, rotation, shift)
// maps the picture onto one canvas of the wall. It is fitted to the holds that
// frame shares with the others, robustly: a hold half-hidden under a hand
// (its mask, and so its centre, shrinks) or something green that moves does
// not drag it. A camera that never moved gets the identity, exactly.
//
// Coordinates: "video" is 0–1 of the frame (x right, y down); "canvas" is 0–1
// of the wall canvas. Fitting happens in isotropic units (x scaled by the
// frame's aspect) so a rotation is a rotation.

import type { Vec2 } from './types'

/** 2×3: (x, y) → (m[0][0] x + m[0][1] y + m[0][2], m[1][0] x + m[1][1] y + m[1][2]) */
export type Affine = number[][]
export const IDENTITY: Affine = [[1, 0, 0], [0, 1, 0]]

export const applyM = (m: Affine, p: Vec2): Vec2 => [m[0][0] * p[0] + m[0][1] * p[1] + m[0][2], m[1][0] * p[0] + m[1][1] * p[1] + m[1][2]]

/** a ∘ b: apply b, then a. */
export function compose(a: Affine, b: Affine): Affine {
  return [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]],
  ]
}

export function invert(m: Affine): Affine {
  const [[a, b, c], [d, e, f]] = m
  const det = a * e - b * d
  return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det]]
}

const lerpM = (a: Affine, b: Affine, k: number): Affine => a.map((row, i) => row.map((v, j) => v + (b[i][j] - v) * k))
/** Linear scale of an affine (√|det|). */
export const scaleOf = (m: Affine) => Math.sqrt(Math.abs(m[0][0] * m[1][1] - m[0][1] * m[1][0]))

/** Per sampled frame: canvas → video. Absent on a still camera (identity). */
export interface MotionTrack { t: number[]; m: Affine[] }

/** The camera at time t (video seconds), between the two sampled frames around it.
 *  Null where the camera is unknown: a gap with no holds in view, or past the ends. */
export function motionAt(mt: MotionTrack | undefined, t: number, maxGap = 1.25, edge = 0.35): Affine | null {
  if (!mt) return IDENTITY
  const ts = mt.t
  if (!ts.length) return null
  if (t <= ts[0]) return ts[0] - t <= edge ? mt.m[0] : null
  const n = ts.length - 1
  if (t >= ts[n]) return t - ts[n] <= edge ? mt.m[n] : null
  let lo = 0, hi = n
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ts[mid] <= t) lo = mid
    else hi = mid
  }
  if (ts[hi] - ts[lo] > maxGap) return null
  return lerpM(mt.m[lo], mt.m[hi], (t - ts[lo]) / (ts[hi] - ts[lo]))
}

// ── fitting ─────────────────────────────────────────────────────────────────

/** One SAM sighting of a track, as the fit sees it. */
export interface Sighting {
  track: number
  sample: number // index into the sampled frames
  c: Vec2 // centre, video 0–1
  w: number // weight
  size?: number // the hold's height, video units: a volume's centre wanders further than a crimp's
}

interface Sim { a: number; b: number; tx: number; ty: number } // X' = aX − bY + tx, Y' = bX + aY + ty

const simApply = (s: Sim, p: Vec2): Vec2 => [s.a * p[0] - s.b * p[1] + s.tx, s.b * p[0] + s.a * p[1] + s.ty]
const simCompose = (s2: Sim, s1: Sim): Sim => ({
  a: s2.a * s1.a - s2.b * s1.b,
  b: s2.a * s1.b + s2.b * s1.a,
  tx: s2.a * s1.tx - s2.b * s1.ty + s2.tx,
  ty: s2.b * s1.tx + s2.a * s1.ty + s2.ty,
})
const simInvert = (s: Sim): Sim => {
  const d = s.a * s.a + s.b * s.b
  const a = s.a / d, b = -s.b / d
  return { a, b, tx: -(a * s.tx - b * s.ty), ty: -(b * s.tx + a * s.ty) }
}
const SIM_I: Sim = { a: 1, b: 0, tx: 0, ty: 0 }

/**
 * Weighted least-squares similarity p → q (complex form: q = z·p + t), with
 * z pulled toward `prior` by `lambda`. Two points determine a similarity
 * exactly, so with few holds in view the prior (the neighbouring frames'
 * scale and rotation) keeps one half-hidden hold from tilting the canvas.
 */
function fitSim(pairs: { p: Vec2; q: Vec2; w: number }[], prior: Sim | null, lambda: number): Sim | null {
  const W = pairs.reduce((s, x) => s + x.w, 0)
  if (!pairs.length || W <= 0) return null
  const pm: Vec2 = [pairs.reduce((s, x) => s + x.w * x.p[0], 0) / W, pairs.reduce((s, x) => s + x.w * x.p[1], 0) / W]
  const qm: Vec2 = [pairs.reduce((s, x) => s + x.w * x.q[0], 0) / W, pairs.reduce((s, x) => s + x.w * x.q[1], 0) / W]
  let re = 0, im = 0, den = 0
  for (const { p, q, w } of pairs) {
    const px = p[0] - pm[0], py = p[1] - pm[1], qx = q[0] - qm[0], qy = q[1] - qm[1]
    re += w * (px * qx + py * qy)
    im += w * (px * qy - py * qx)
    den += w * (px * px + py * py)
  }
  const z0 = prior ?? SIM_I
  const lam = pairs.length === 1 ? 1 : lambda * W
  const a = (re + lam * z0.a) / (den + lam), b = (im + lam * z0.b) / (den + lam)
  return { a, b, tx: qm[0] - (a * pm[0] - b * pm[1]), ty: qm[1] - (b * pm[0] + a * pm[1]) }
}

export interface Registration {
  mode: 'still' | 'handheld'
  /** Per sampled frame, video → canvas (isotropic units of the reference frame); null = unregistered. */
  toCanvas: (Affine | null)[]
  /** Per sampled frame, the weighted RMS misfit of its holds, in hold heights. */
  residual: (number | null)[]
  /** Tracks that move against the wall: not holds. */
  moving: number[]
  reference: number
  aspect: number
}

/**
 * Register every sampled frame to one wall canvas.
 * `holdUnit` is the median hold height in video units; tolerances scale with it.
 */
export function registerCamera(sightings: Sighting[], sampleTimes: number[], aspect: number, holdUnit: number): Registration {
  const N = sampleTimes.length
  const iso = (c: Vec2): Vec2 => [c[0] * aspect, c[1]]
  // Misfit is judged in each hold's own size, never less than a typical hold.
  const unitOf = new Map<number, number>()
  {
    const sizes = new Map<number, number[]>()
    for (const s of sightings) if (s.size) sizes.set(s.track, [...(sizes.get(s.track) ?? []), s.size])
    for (const [t, l] of sizes) unitOf.set(t, Math.max(holdUnit, median(l)))
  }
  const unit = (track: number) => unitOf.get(track) ?? holdUnit
  const run = (exclude: Set<number>) => {
    const bySample: Sighting[][] = Array.from({ length: N }, () => [])
    for (const s of sightings) if (!exclude.has(s.track) && s.sample >= 0 && s.sample < N) bySample[s.sample].push(s)
    const T: (Sim | null)[] = new Array(N).fill(null)
    let ref = 0
    for (let i = 1; i < N; i++) if (bySample[i].length > bySample[ref].length) ref = i
    if (!bySample[ref].length) return null
    T[ref] = SIM_I
    const acc = new Map<number, { x: number; y: number; w: number }>()
    const addTo = (i: number) => {
      for (const s of bySample[i]) {
        const q = simApply(T[i]!, iso(s.c))
        const a = acc.get(s.track) ?? { x: 0, y: 0, w: 0 }
        a.x += q[0] * s.w; a.y += q[1] * s.w; a.w += s.w
        acc.set(s.track, a)
      }
    }
    addTo(ref)
    const LAMBDA = 0.012 // the prior weighs like holds 0.11 frame heights from the centre
    // Out from the reference frame in both directions, each frame fitted to the
    // holds already placed, its scale and rotation anchored to its neighbour's.
    const sweep = (from: number, step: 1 | -1) => {
      let prev = T[ref]!, prevT = sampleTimes[ref]
      for (let i = from; i >= 0 && i < N; i += step) {
        const pairs = bySample[i].filter((s) => acc.has(s.track)).map((s) => {
          const a = acc.get(s.track)!
          return { p: iso(s.c), q: [a.x / a.w, a.y / a.w] as Vec2, w: s.w }
        })
        const fit = robustFit(pairs, prev, LAMBDA, holdUnit)
        if (fit && plausible(fit, prev, Math.abs(sampleTimes[i] - prevT))) {
          T[i] = fit
          addTo(i)
          prev = fit
          prevT = sampleTimes[i]
        }
      }
    }
    sweep(ref + 1, 1)
    sweep(ref - 1, -1)

    // Refine: re-place every hold from all frames, refit every frame to them,
    // with each frame's scale and rotation pulled toward its neighbours'.
    for (let iter = 0; iter < 4; iter++) {
      const pos = new Map<number, Vec2>()
      const byTrack = new Map<number, { q: Vec2; w: number }[]>()
      for (let i = 0; i < N; i++) {
        if (!T[i]) continue
        for (const s of bySample[i]) {
          const list = byTrack.get(s.track) ?? []
          list.push({ q: simApply(T[i]!, iso(s.c)), w: s.w })
          byTrack.set(s.track, list)
        }
      }
      for (const [track, list] of byTrack) pos.set(track, robustMean(list, holdUnit))
      const next: (Sim | null)[] = T.slice()
      for (let i = 0; i < N; i++) {
        const pairs = bySample[i].filter((s) => pos.has(s.track)).map((s) => ({ p: iso(s.c), q: pos.get(s.track)!, w: s.w }))
        const nb = [T[i - 1], T[i + 1]].filter(Boolean) as Sim[]
        const prior = nb.length ? { a: nb.reduce((s, x) => s + x.a, 0) / nb.length, b: nb.reduce((s, x) => s + x.b, 0) / nb.length, tx: 0, ty: 0 } : T[i]
        const fit = robustFit(pairs, prior, LAMBDA, holdUnit)
        next[i] = fit && absolutelyPlausible(fit) ? fit : T[i] && pairs.length ? T[i] : null
      }
      // Keep the reference frame the canvas: undo any drift of the whole solution.
      const g = next[ref] ? simInvert(next[ref]!) : SIM_I
      for (let i = 0; i < N; i++) T[i] = next[i] ? simCompose(g, next[i]!) : null
    }

    // Misfit per frame and per track.
    const pos = new Map<number, Vec2>()
    const byTrack = new Map<number, { q: Vec2; w: number }[]>()
    for (let i = 0; i < N; i++) {
      if (!T[i]) continue
      for (const s of bySample[i]) {
        const list = byTrack.get(s.track) ?? []
        list.push({ q: simApply(T[i]!, iso(s.c)), w: s.w })
        byTrack.set(s.track, list)
      }
    }
    for (const [track, list] of byTrack) pos.set(track, robustMean(list, holdUnit))
    const trackErr = new Map<number, number[]>()
    const residual: (number | null)[] = new Array(N).fill(null)
    for (let i = 0; i < N; i++) {
      if (!T[i]) continue
      let se = 0, sw = 0
      for (const s of bySample[i]) {
        const q = simApply(T[i]!, iso(s.c)), p = pos.get(s.track)!
        const e = Math.hypot(q[0] - p[0], q[1] - p[1])
        se += s.w * (e / holdUnit) ** 2; sw += s.w
        const l = trackErr.get(s.track) ?? []
        l.push(e / unit(s.track))
        trackErr.set(s.track, l)
      }
      residual[i] = sw ? Math.sqrt(se / sw) : null
    }
    return { T, ref, residual, trackErr }
  }

  let exclude = new Set<number>()
  let r = run(exclude)
  if (!r) return { mode: 'handheld', toCanvas: new Array(N).fill(null), residual: new Array(N).fill(null), moving: [], reference: 0, aspect }
  // Something green that moves against the wall (a shoe, a shirt, a chalk bag)
  // is not a hold: drop it and fit again.
  const moving = [...r.trackErr].filter(([, e]) => e.length >= 3 && median(e) > 0.75).map(([t]) => t)
  if (moving.length) {
    exclude = new Set(moving)
    r = run(exclude) ?? r
  }
  // A still camera: every frame within a hair of the reference. Snap to the
  // identity so tripod footage reads exactly as the pipeline reads it.
  const centre: Vec2 = [0.5 * aspect, 0.5]
  const still = r.T.every((s) => {
    if (!s) return true
    const c = simApply(s, centre)
    return Math.abs(Math.hypot(s.a, s.b) - 1) < 0.01 && Math.abs(Math.atan2(s.b, s.a)) < 0.006 && Math.hypot(c[0] - centre[0], c[1] - centre[1]) < 0.2 * holdUnit
  })
  const toAffine = (s: Sim): Affine => compose([[s.a, -s.b, s.tx], [s.b, s.a, s.ty]], [[aspect, 0, 0], [0, 1, 0]])
  if (still) {
    const iso0 = toAffine(SIM_I)
    return { mode: 'still', toCanvas: new Array(N).fill(iso0), residual: r.residual, moving, reference: r.ref, aspect }
  }
  return { mode: 'handheld', toCanvas: r.T.map((s) => (s ? toAffine(s) : null)), residual: r.residual, moving, reference: r.ref, aspect }
}

/** Huber-reweighted fit: a hold whose misfit is far above the rest counts less. */
function robustFit(pairs: { p: Vec2; q: Vec2; w: number }[], prior: Sim | null, lambda: number, holdUnit: number): Sim | null {
  let fit = fitSim(pairs, prior, lambda)
  if (!fit || pairs.length < 3) return fit
  const delta = 0.35 * holdUnit
  for (let k = 0; k < 3; k++) {
    const re = pairs.map((x) => {
      const q = simApply(fit!, x.p)
      const e = Math.hypot(q[0] - x.q[0], q[1] - x.q[1])
      return { ...x, w: x.w * Math.min(1, delta / Math.max(1e-9, e)) }
    })
    fit = fitSim(re, prior, lambda) ?? fit
  }
  return fit
}

/** Frame to frame, a hand-held camera turns and zooms, but not in jumps. */
function plausible(s: Sim, prev: Sim, dt: number) {
  if (!absolutelyPlausible(s)) return false
  const ds = Math.abs(Math.log(Math.hypot(s.a, s.b) / Math.hypot(prev.a, prev.b)))
  const dr = Math.abs(Math.atan2(s.b * prev.a - s.a * prev.b, s.a * prev.a + s.b * prev.b))
  return ds < 0.12 + 0.6 * dt && dr < 0.09 + 0.5 * dt
}
function absolutelyPlausible(s: Sim) {
  const sc = Math.hypot(s.a, s.b)
  return sc > 0.3 && sc < 3.5 && Math.abs(Math.atan2(s.b, s.a)) < 0.8
}

function robustMean(list: { q: Vec2; w: number }[], holdUnit: number): Vec2 {
  let m: Vec2 = [0, 0]
  let W = 0
  for (const x of list) { m[0] += x.q[0] * x.w; m[1] += x.q[1] * x.w; W += x.w }
  m = [m[0] / W, m[1] / W]
  const delta = 0.35 * holdUnit
  for (let k = 0; k < 3; k++) {
    let sx = 0, sy = 0, sw = 0
    for (const x of list) {
      const w = x.w * Math.min(1, delta / Math.max(1e-9, Math.hypot(x.q[0] - m[0], x.q[1] - m[1])))
      sx += x.q[0] * w; sy += x.q[1] * w; sw += w
    }
    m = [sx / sw, sy / sw]
  }
  return m
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const k = s.length >> 1
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2
}

// ── where a hold is in the picture at time t ────────────────────────────────

/** One SAM sighting of a hold, kept for drawing and for contact: its outline in
 *  video coordinates at a sampled time, and whether it was seen whole. */
export interface HoldSighting { t: number; poly: Vec2[]; whole: boolean }

/**
 * A hold's outline in the picture at video time t. Still camera: the hold's
 * one outline. Moving camera: SAM's own outline from the nearest frame that saw
 * it whole, carried by the camera's motion from then to now — local, so it
 * stays true where a single canvas-wide map would bend.
 */
export function holdOutlineAt(canvasPoly: Vec2[], sightings: HoldSighting[] | undefined, motion: MotionTrack | undefined, t: number): Vec2[] | null {
  if (!motion) return canvasPoly
  const now = motionAt(motion, t)
  let best: HoldSighting | null = null
  if (sightings) for (const s of sightings) if (s.whole && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s
  if (best) {
    if (Math.abs(best.t - t) < 1e-3) return best.poly
    const then = motionAt(motion, best.t)
    if (now && then) {
      const carry = compose(now, invert(then))
      return best.poly.map((p) => applyM(carry, p))
    }
    if (Math.abs(best.t - t) <= 0.2) return best.poly
  }
  return now ? canvasPoly.map((p) => applyM(now, p)) : null
}

/** Douglas–Peucker, to keep stored outlines small. */
export function simplify(poly: Vec2[], tol = 0.0015, max = 28): Vec2[] {
  if (poly.length <= 4) return poly
  const keep = new Uint8Array(poly.length)
  keep[0] = keep[poly.length - 1] = 1
  const stack: [number, number][] = [[0, poly.length - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    let worst = -1, wd = tol
    const [ax, ay] = poly[i], [bx, by] = poly[j]
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs(dy * poly[k][0] - dx * poly[k][1] + bx * ay - by * ax) / L
      if (d > wd) { wd = d; worst = k }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([i, worst], [worst, j]) }
  }
  let out = poly.filter((_, k) => keep[k])
  if (out.length > max) out = out.filter((_, k) => k % Math.ceil(out.length / max) === 0)
  return out.length >= 3 ? out : poly
}
