// Everything the replay draws at time t, derived once per session: where each
// limb is, which holds have lit, the running "on a hold" split, and a
// stick-figure climber solved from the limbs and the torso path.

import { clamp, easeInOut, holdLetter, lerp } from './geometry'
import { LIMBS, LIMB_BY_KEY, type Hold, type LimbKey, type Session, type Vec2 } from './types'

export interface Interval { start: number; end: number; holdId: number }

export interface LimbState { pos: Vec2; holdId: number | null; moving: boolean }

export interface Skeleton {
  head: Vec2
  neck: Vec2
  shoulders: [Vec2, Vec2]
  elbows: [Vec2, Vec2]
  wrists: [Vec2, Vec2]
  hips: [Vec2, Vec2]
  knees: [Vec2, Vec2]
  ankles: [Vec2, Vec2]
  torso: Vec2
}

export interface Timeline {
  duration: number
  climbEnd: number
  intervals: Record<LimbKey, Interval[]>
  firstUse: Map<number, { time: number; limb: LimbKey }>
  holdLimbs: Map<number, LimbKey[]>
  byId: Map<number, Hold>
  aspect: number
  limbAt(limb: LimbKey, t: number): LimbState
  coverageAt(limb: LimbKey, t: number): number
  sequenceAt(limb: LimbKey, t: number): number[]
  litAt(t: number): number[]
  torsoAt(t: number): Vec2 | null
  skeletonAt(t: number): Skeleton
  label(id: number, letters?: boolean): string
}

// Body proportions in meters; converted into canvas units by the route's scale.
const BODY = { shoulder: 0.4, hip: 0.27, torso: 0.5, upperArm: 0.31, forearm: 0.29, thigh: 0.45, shin: 0.44, neck: 0.1, head: 0.11 }

export function buildTimeline(s: Session): Timeline {
  const byId = new Map(s.holds.map((h) => [h.id, h]))
  const aspect = s.canvas.width / s.canvas.height
  const climbEnd = s.elapsed ?? s.duration
  const intervals = {} as Record<LimbKey, Interval[]>
  for (const l of LIMBS) {
    intervals[l.key] = s.moves
      .filter((m) => m.limb === l.key && byId.has(m.holdId))
      .map((m) => ({ start: m.time, end: Math.min(m.time + m.duration, Math.max(climbEnd, m.time + 0.05)), holdId: m.holdId }))
      .sort((a, b) => a.start - b.start)
  }
  const firstUse = new Map<number, { time: number; limb: LimbKey }>()
  const holdLimbs = new Map<number, LimbKey[]>()
  for (const m of [...s.moves].sort((a, b) => a.time - b.time)) {
    if (!firstUse.has(m.holdId)) firstUse.set(m.holdId, { time: m.time, limb: m.limb })
    const ls = holdLimbs.get(m.holdId) ?? []
    if (!ls.includes(m.limb)) ls.push(m.limb)
    holdLimbs.set(m.holdId, ls)
  }

  // Canvas units → meters. x is in canvas-width units, so it carries the aspect.
  const mpu = s.scale?.metersPerUnit ?? 4
  const toM = (p: Vec2): Vec2 => [p[0] * aspect * mpu, p[1] * mpu]
  const fromM = (p: Vec2): Vec2 => [p[0] / (aspect * mpu), p[1] / mpu]

  function anchor(holdId: number, limb: LimbKey): Vec2 {
    const h = byId.get(holdId)!
    const info = LIMB_BY_KEY[limb]
    const [, , w, hh] = h.bbox
    const dx = info.side * Math.min(w * 0.22, 0.012)
    // Hands grip the top edge of a hold; feet stand on it.
    const dy = info.hand ? -hh * 0.18 : -hh * 0.05
    return [h.center[0] + dx, h.center[1] + dy]
  }

  function limbAt(limb: LimbKey, t: number): LimbState {
    const iv = intervals[limb]
    if (!iv.length) return { pos: [0.5, 0.5], holdId: null, moving: false }
    if (t <= iv[0].start) return { pos: anchor(iv[0].holdId, limb), holdId: t >= iv[0].start - 1e-6 ? iv[0].holdId : null, moving: false }
    for (let i = 0; i < iv.length; i++) {
      const cur = iv[i]
      if (t >= cur.start && t <= cur.end) return { pos: anchor(cur.holdId, limb), holdId: cur.holdId, moving: false }
      const next = iv[i + 1]
      if (next && t > cur.end && t < next.start) {
        const a = anchor(cur.holdId, limb), b = anchor(next.holdId, limb)
        const raw = (t - cur.end) / Math.max(1e-3, next.start - cur.end)
        const e = easeInOut(clamp(raw))
        // A reach bows away from the body rather than sliding along a ruler.
        const side = LIMB_BY_KEY[limb].side
        const dxm = (b[0] - a[0]) * aspect, dym = b[1] - a[1]
        const len = Math.hypot(dxm, dym)
        const bow = Math.sin(Math.PI * e) * len * 0.18
        const nx = (-dym / (len || 1)) * side, ny = (dxm / (len || 1)) * side
        return { pos: [lerp(a[0], b[0], e) + (nx * bow) / aspect, lerp(a[1], b[1], e) + ny * bow], holdId: null, moving: true }
      }
    }
    return { pos: anchor(iv[iv.length - 1].holdId, limb), holdId: t <= iv[iv.length - 1].end ? iv[iv.length - 1].holdId : null, moving: false }
  }

  function coverageAt(limb: LimbKey, t: number) {
    const T = Math.min(t, climbEnd)
    if (T <= 1 / s.fps) return intervals[limb].some((i) => i.start <= 1 / s.fps) ? 1 : 0
    let on = 0
    for (const i of intervals[limb]) on += Math.max(0, Math.min(i.end, T) - i.start)
    return clamp(on / T)
  }

  function sequenceAt(limb: LimbKey, t: number) {
    const out: number[] = []
    for (const i of intervals[limb]) if (i.start <= t && out[out.length - 1] !== i.holdId) out.push(i.holdId)
    return out
  }

  const order = [...firstUse.entries()].sort((a, b) => a[1].time - b[1].time)
  function litAt(t: number) {
    return order.filter(([, f]) => f.time <= t).map(([id]) => id)
  }

  const torso = s.torso && s.torso.length > 1 ? s.torso : null
  function torsoAt(t: number): Vec2 | null {
    if (!torso) return null
    if (t <= torso[0][0]) return [torso[0][1], torso[0][2]]
    const last = torso[torso.length - 1]
    if (t >= last[0]) return [last[1], last[2]]
    let lo = 0, hi = torso.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (torso[mid][0] <= t) lo = mid
      else hi = mid
    }
    const a = torso[lo], b = torso[hi]
    const k = (t - a[0]) / (b[0] - a[0] || 1)
    return [lerp(a[1], b[1], k), lerp(a[2], b[2], k)]
  }

  // Limb lengths stretch to the reaches this climb actually made, so a long
  // move never tears the figure apart.
  const sampleTs = Array.from({ length: 60 }, (_, i) => (climbEnd * i) / 59)
  function rawTorso(t: number): Vec2 {
    const fromTrace = torsoAt(t)
    if (fromTrace) return toM(fromTrace)
    const hands = (['left_hand', 'right_hand'] as LimbKey[]).map((k) => toM(limbAt(k, t).pos))
    const feet = (['left_foot', 'right_foot'] as LimbKey[]).map((k) => toM(limbAt(k, t).pos))
    const hx = (hands[0][0] + hands[1][0]) / 2, hy = (hands[0][1] + hands[1][1]) / 2
    const fx = (feet[0][0] + feet[1][0]) / 2, fy = (feet[0][1] + feet[1][1]) / 2
    return [hx * 0.5 + fx * 0.5, hy * 0.42 + fy * 0.58]
  }
  let arm = BODY.upperArm + BODY.forearm
  let leg = BODY.thigh + BODY.shin
  for (const t of sampleTs) {
    const c = rawTorso(t)
    const sh: Vec2 = [c[0], c[1] - BODY.torso / 2]
    const hp: Vec2 = [c[0], c[1] + BODY.torso / 2]
    for (const k of ['left_hand', 'right_hand'] as LimbKey[]) {
      const p = toM(limbAt(k, t).pos)
      arm = Math.max(arm, Math.hypot(p[0] - sh[0], p[1] - sh[1]) * 0.98)
    }
    for (const k of ['left_foot', 'right_foot'] as LimbKey[]) {
      const p = toM(limbAt(k, t).pos)
      leg = Math.max(leg, Math.hypot(p[0] - hp[0], p[1] - hp[1]) * 0.98)
    }
  }
  arm = Math.min(arm, 1.05)
  leg = Math.min(leg, 1.35)
  const armK = arm / (BODY.upperArm + BODY.forearm)
  const legK = leg / (BODY.thigh + BODY.shin)
  // Long reaches mean a bigger body, not a spider: grow the trunk with the limbs.
  const bodyK = clamp((armK + legK) / 2, 1, 1.45)
  const T = { torso: BODY.torso * bodyK, shoulder: BODY.shoulder * bodyK, hip: BODY.hip * bodyK, neck: BODY.neck * bodyK, head: BODY.head * bodyK }

  function solve(root: Vec2, target: Vec2, a: number, b: number, outward: number): [Vec2, Vec2] {
    let dx = target[0] - root[0], dy = target[1] - root[1]
    let d = Math.hypot(dx, dy)
    const max = (a + b) * 0.999
    let end = target
    if (d > max) {
      end = [root[0] + (dx / d) * max, root[1] + (dy / d) * max]
      dx = end[0] - root[0]; dy = end[1] - root[1]; d = max
    }
    d = Math.max(d, Math.abs(a - b) + 1e-4)
    const x = (a * a - b * b + d * d) / (2 * d)
    const h = Math.sqrt(Math.max(0, a * a - x * x))
    const ux = dx / d, uy = dy / d
    const c1: Vec2 = [root[0] + ux * x - uy * h, root[1] + uy * x + ux * h]
    const c2: Vec2 = [root[0] + ux * x + uy * h, root[1] + uy * x - ux * h]
    // Elbows and knees bend away from the body's midline.
    const joint = (c1[0] - root[0]) * outward > (c2[0] - root[0]) * outward ? c1 : c2
    return [joint, end]
  }

  function skeletonAt(t: number): Skeleton {
    const c = rawTorso(t)
    const lh = toM(limbAt('left_hand', t).pos), rh = toM(limbAt('right_hand', t).pos)
    const lf = toM(limbAt('left_foot', t).pos), rf = toM(limbAt('right_foot', t).pos)
    // A little roll toward the higher hand, for life.
    const roll = clamp((rh[1] - lh[1]) * 0.25, -0.25, 0.25)
    const up: Vec2 = [Math.sin(roll), -Math.cos(roll)]
    const across: Vec2 = [-up[1], up[0]]
    const sc: Vec2 = [c[0] + up[0] * T.torso / 2, c[1] + up[1] * T.torso / 2]
    const hc: Vec2 = [c[0] - up[0] * T.torso / 2, c[1] - up[1] * T.torso / 2]
    const ls: Vec2 = [sc[0] - across[0] * T.shoulder / 2, sc[1] - across[1] * T.shoulder / 2]
    const rs: Vec2 = [sc[0] + across[0] * T.shoulder / 2, sc[1] + across[1] * T.shoulder / 2]
    const lhp: Vec2 = [hc[0] - across[0] * T.hip / 2, hc[1] - across[1] * T.hip / 2]
    const rhp: Vec2 = [hc[0] + across[0] * T.hip / 2, hc[1] + across[1] * T.hip / 2]
    const [le, lw] = solve(ls, lh, BODY.upperArm * armK, BODY.forearm * armK, -1)
    const [re, rw] = solve(rs, rh, BODY.upperArm * armK, BODY.forearm * armK, 1)
    const [lk, la] = solve(lhp, lf, BODY.thigh * legK, BODY.shin * legK, -1)
    const [rk, ra] = solve(rhp, rf, BODY.thigh * legK, BODY.shin * legK, 1)
    const neck: Vec2 = [sc[0] + up[0] * T.neck, sc[1] + up[1] * T.neck]
    const head: Vec2 = [neck[0] + up[0] * T.head, neck[1] + up[1] * T.head]
    const f = fromM
    return {
      head: f(head), neck: f(neck), torso: f(c),
      shoulders: [f(ls), f(rs)], elbows: [f(le), f(re)], wrists: [f(lw), f(rw)],
      hips: [f(lhp), f(rhp)], knees: [f(lk), f(rk)], ankles: [f(la), f(ra)],
    }
  }

  return {
    duration: s.duration,
    climbEnd,
    intervals,
    firstUse,
    holdLimbs,
    byId,
    aspect,
    limbAt,
    coverageAt,
    sequenceAt,
    litAt,
    torsoAt,
    skeletonAt,
    label: (id, letters) => (letters ? holdLetter(id) : String(id)),
  }
}

export const fmtTime = (t: number | null | undefined, digits = 2) => (t == null ? '—' : `${t.toFixed(digits)}`)
