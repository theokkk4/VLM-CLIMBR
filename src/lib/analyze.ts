// Reading the route from raw VLM Run output, in the browser.
//
// A port of the core of vision-demos/rock_climbing/src/climb.py for a still
// camera: SAM 3.1's hold tracks become one polygon per hold, ViTPose+ gives the
// climber's four points of contact, and contact is decided per limb with a
// dwell (a hand passing over a hold has not used it) and hysteresis (entering a
// hold is a tight margin, letting go a loose one). Margins are in hold heights
// and body heights, as the pipeline quotes them, so framing does not matter.

import { bboxOf, gaussianSmooth, median, polygonArea, signedDistance } from './geometry'
import type { PipelineClimb, PipelineHold, PipelineMove, Vec2, LimbKey } from './types'
import { LIMBS } from './types'

export const CFG = {
  HOLD_MIN_SCORE: 0.4,
  HOLD_MIN_APPEARANCE: 0.3,
  HOLD_DWELL_SECONDS: 0.5,
  FINAL_HOLD_TOUCH_SECONDS: 0.25,
  FINAL_HOLD_DWELL_SECONDS: 0.5,
  HOLD_MASK_MARGIN: 0.58,
  HOLD_RELEASE_MARGIN: 0.96,
  HOLD_GRAZE_DEPTH: 0.38,
  HOLD_GRAZE_DWELL_SECONDS: 1.5,
  ANKLE_TO_TOE_OFFSET: 0.045,
  START_DWELL_SECONDS: 0.4,
  POSE_SMOOTH_SIGMA: 1.5,
  NUMBER_BAND: 0.025,
}

const KPT = { lShoulder: 5, rShoulder: 6, lWrist: 9, rWrist: 10, lHip: 11, rHip: 12, lAnkle: 15, rAnkle: 16 }
const LIMB_KPT: Record<LimbKey, number> = { left_hand: KPT.lWrist, right_hand: KPT.rWrist, left_foot: KPT.lAnkle, right_foot: KPT.rAnkle }
const TORSO = [KPT.lShoulder, KPT.rShoulder, KPT.lHip, KPT.rHip]

interface SamItem { track_id?: number; frame_id?: number; score?: number; bbox_xywh?: number[]; polys_xy?: number[][][] }
interface PoseItem { track_id?: number; frame_id?: number; bbox_xywh?: number[]; kpts_xy?: number[][]; kpts_score?: number[] }

export function isSamPayload(j: any): boolean {
  return j?.content?.object === 'vid.segment.masks' || j?.content?.object === 'img.segment.masks'
}
export function isPosePayload(j: any): boolean {
  return j?.content?.object === 'vid.pose.kpts'
}

/** SAM 3.1 tracks → one polygon per hold, numbered bottom to top. */
export function holdsFromSam(payload: any): PipelineHold[] {
  const items: SamItem[] = payload?.content?.items ?? []
  const nFrames = Math.max(1, new Set((payload?.content?.frames ?? items).map((f: any) => f.frame_id)).size)
  const byTrack = new Map<number, SamItem[]>()
  for (const it of items) {
    if (it.track_id == null || !it.bbox_xywh || (it.score ?? 0) < CFG.HOLD_MIN_SCORE) continue
    const list = byTrack.get(it.track_id) ?? []
    list.push(it)
    byTrack.set(it.track_id, list)
  }
  type Cand = { track: number; polygon: Vec2[]; score: number; appearance: number; frames: number[] }
  const cands: Cand[] = []
  for (const [track, list] of byTrack) {
    const appearance = new Set(list.map((i) => i.frame_id)).size / nFrames
    if (appearance < CFG.HOLD_MIN_APPEARANCE && list.length < 3) continue
    // The hold's shape: the sighting of median area. The largest is usually
    // two holds bridged; the smallest, one half-covered by a hand.
    const withPoly = list
      .map((i) => {
        const rings = (i.polys_xy ?? []).filter((r) => r.length >= 3)
        const ring = rings.length ? rings.reduce((a, b) => (b.length > a.length ? b : a)) : null
        const [x, y, w, h] = i.bbox_xywh!
        const polygon: Vec2[] = ring ? ring.map((p) => [p[0], p[1]] as Vec2) : [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
        return { polygon, area: polygonArea(polygon), score: i.score ?? 0 }
      })
      .sort((a, b) => a.area - b.area)
    const pick = withPoly[Math.floor(withPoly.length / 2)]
    cands.push({
      track,
      polygon: pick.polygon,
      score: list.reduce((s, i) => s + (i.score ?? 0), 0) / list.length,
      appearance,
      frames: list.map((i) => i.frame_id ?? 0),
    })
  }
  // Two tracks on one hold (SAM re-acquiring it after an occlusion): keep the steadier one.
  cands.sort((a, b) => b.appearance - a.appearance || b.score - a.score)
  const kept: Cand[] = []
  for (const c of cands) {
    const bc = bboxOf(c.polygon)
    if (kept.some((k) => iou(bboxOf(k.polygon), bc) > 0.45)) continue
    kept.push(c)
  }
  return assignIds(kept.map((c) => ({
    id: 0,
    bbox: bboxOf(c.polygon),
    polygon: c.polygon,
    score: round(c.score, 4),
    appearance_fraction: round(c.appearance, 4),
    tracks: [c.track],
    frames: [Math.min(...c.frames), Math.max(...c.frames)],
  })))
}

/** Bottom to top; holds in one horizontal band are read left to right. */
function assignIds(holds: PipelineHold[]): PipelineHold[] {
  const c = (h: PipelineHold) => [h.bbox[0] + h.bbox[2] / 2, h.bbox[1] + h.bbox[3] / 2]
  const sorted = [...holds].sort((a, b) => c(b)[1] - c(a)[1])
  const rows: PipelineHold[][] = []
  for (const h of sorted) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(c(row[0])[1] - c(h)[1]) < CFG.NUMBER_BAND) row.push(h)
    else rows.push([h])
  }
  let id = 1
  for (const row of rows) for (const h of row.sort((a, b) => c(a)[0] - c(b)[0])) h.id = id++
  return sorted.sort((a, b) => a.id - b.id)
}

interface Poses {
  frames: number[]
  kpts: Map<number, Vec2[]>
  valid: Map<number, boolean[]>
  boxes: Map<number, number[]>
}

function posesFromPayload(payload: any, holds: PipelineHold[]): Poses {
  const items: PoseItem[] = payload?.content?.items ?? []
  const byTrack = new Map<number, PoseItem[]>()
  for (const it of items) {
    const t = it.track_id ?? 0
    const list = byTrack.get(t) ?? []
    list.push(it)
    byTrack.set(t, list)
  }
  // The climber is the person on the holds — not the biggest, not the most central.
  const wall = holds.length ? bboxOf(holds.flatMap((h) => [[h.bbox[0], h.bbox[1]], [h.bbox[0] + h.bbox[2], h.bbox[1] + h.bbox[3]]] as Vec2[])) : null
  let best = -1, bestScore = -Infinity
  for (const [track, list] of byTrack) {
    const overlap = wall ? list.reduce((s, i) => s + overlapFrac(i.bbox_xywh ?? [0, 0, 0, 0], wall), 0) / list.length : 0
    const score = overlap * 10 + list.length / Math.max(1, items.length)
    if (score > bestScore) { bestScore = score; best = track }
  }
  const mine = (byTrack.get(best) ?? []).sort((a, b) => (a.frame_id ?? 0) - (b.frame_id ?? 0))
  const kpts = new Map<number, Vec2[]>(), valid = new Map<number, boolean[]>(), boxes = new Map<number, number[]>()
  for (const it of mine) {
    const f = it.frame_id ?? 0
    const xy = (it.kpts_xy ?? []).slice(0, 17).map((p) => [Number(p[0]), Number(p[1])] as Vec2)
    while (xy.length < 17) xy.push([0, 0])
    kpts.set(f, xy)
    valid.set(f, xy.map(([x, y]) => !(x === 0 && y === 0)))
    boxes.set(f, it.bbox_xywh ?? [0, 0, 0, 0])
  }
  const frames = [...kpts.keys()].sort((a, b) => a - b)
  // Smooth each joint across contiguous runs only.
  for (let k = 0; k < 17; k++) {
    let run: number[] = []
    const flush = () => {
      const present = run.filter((f) => valid.get(f)![k])
      if (present.length >= 3) {
        const xs = gaussianSmooth(present.map((f) => kpts.get(f)![k][0]), CFG.POSE_SMOOTH_SIGMA)
        const ys = gaussianSmooth(present.map((f) => kpts.get(f)![k][1]), CFG.POSE_SMOOTH_SIGMA)
        present.forEach((f, i) => { kpts.get(f)![k] = [xs[i], ys[i]] })
      }
      run = []
    }
    for (let i = 0; i < frames.length; i++) {
      if (i && frames[i] - frames[i - 1] !== 1) flush()
      run.push(frames[i])
    }
    flush()
  }
  return { frames, kpts, valid, boxes }
}

export interface AnalysisResult {
  holds: PipelineHold[]
  climb: PipelineClimb
  torso: [number, number, number][]
  startFrame: number | null
  completionFrame: number | null
  warnings: string[]
}

export function analyzePayloads(samPayload: any, posePayload: any, opts: { fps?: number; aspect?: number; color?: string; holds?: PipelineHold[] } = {}): AnalysisResult {
  const warnings: string[] = []
  const holds = opts.holds?.length ? opts.holds : holdsFromSam(samPayload)
  if (!holds.length) throw new Error('SAM 3.1 found no holds in this clip. Check the hold colour.')
  const fps = opts.fps ?? posePayload?.video_fps ?? samPayload?.video_fps ?? 30
  const aspect = opts.aspect ?? ((posePayload?.video_width && posePayload?.video_height) ? posePayload.video_width / posePayload.video_height : 9 / 16)
  const poses = posesFromPayload(posePayload, holds)
  if (!poses.frames.length) throw new Error('ViTPose+ found nobody climbing in this clip.')

  const holdUnit = Math.max(1e-4, median(holds.map((h) => h.bbox[3])))
  const bodyUnit = Math.max(1e-4, median(poses.frames.map((f) => poses.boxes.get(f)![3])))
  const enter = CFG.HOLD_MASK_MARGIN * holdUnit
  const release = CFG.HOLD_RELEASE_MARGIN * holdUnit
  const grazeDepth = CFG.HOLD_GRAZE_DEPTH * holdUnit
  const toe = CFG.ANKLE_TO_TOE_OFFSET * bodyUnit
  const dwell = Math.max(1, Math.round(CFG.HOLD_DWELL_SECONDS * fps))
  const finalTouch = Math.max(1, Math.round(CFG.FINAL_HOLD_TOUCH_SECONDS * fps))
  const finalFrames = Math.max(1, Math.round(CFG.FINAL_HOLD_DWELL_SECONDS * fps))
  const grazeFrames = Math.max(1, Math.round(CFG.HOLD_GRAZE_DWELL_SECONDS * fps))
  const startFrames = Math.max(1, Math.round(CFG.START_DWELL_SECONDS * fps))
  const finalHold = holds.reduce((a, b) => (a.bbox[1] + a.bbox[3] / 2 < b.bbox[1] + b.bbox[3] / 2 ? a : b))
  const polys = new Map(holds.map((h) => [h.id, (h.polygon ?? []) as Vec2[]]))
  const depth = (id: number, x: number, y: number) => signedDistance(polys.get(id)!, x, y, aspect)
  const bestHold = (x: number, y: number, margin: number) => {
    let bestId: number | null = null, bestD = -margin
    for (const h of holds) {
      const d = depth(h.id, x, y)
      if (d >= -margin && d > bestD) { bestD = d; bestId = h.id }
    }
    return bestId
  }

  type Contact = { limb: LimbKey; holdId: number; start: number; end: number }
  const contacts: Contact[] = []
  const activatedAt = new Map<number, number>()
  const st = Object.fromEntries(LIMBS.map((l) => [l.key, { on: null as number | null, since: 0, held: 0, confirmed: false, last: 0, peak: -Infinity }])) as Record<LimbKey, { on: number | null; since: number; held: number; confirmed: boolean; last: number; peak: number }>
  const close = (k: LimbKey) => {
    const s = st[k]
    if (s.on != null && s.confirmed) contacts.push({ limb: k, holdId: s.on, start: s.since, end: s.last })
    s.on = null; s.held = 0; s.confirmed = false; s.peak = -Infinity
  }
  const midline = new Map<number, Vec2>()
  let startFrame: number | null = null, startDwell = 0
  let completion: number | null = null, finalDwell = 0

  for (const frame of poses.frames) {
    const k = poses.kpts.get(frame)!, ok = poses.valid.get(frame)!
    const tor = TORSO.filter((i) => ok[i])
    if (tor.length) midline.set(frame, [tor.reduce((s, i) => s + k[i][0], 0) / tor.length, tor.reduce((s, i) => s + k[i][1], 0) / tor.length])
    const now: Partial<Record<LimbKey, number>> = {}
    for (const limb of LIMBS) {
      const key = limb.key, kp = LIMB_KPT[key], s = st[key]
      if (!ok[kp]) { close(key); continue }
      const x = k[kp][0], y = k[kp][1] + (limb.hand ? 0 : toe)
      let chosen: number | null
      let d: number | null = null
      if (s.on != null && depth(s.on, x, y) >= -release) {
        const cur = depth(s.on, x, y)
        const better = bestHold(x, y, enter)
        chosen = better != null && better !== s.on && depth(better, x, y) > cur ? better : s.on
        d = chosen === s.on ? cur : null
      } else chosen = bestHold(x, y, enter)
      if (chosen == null) { close(key); continue }
      if (s.on !== chosen) { close(key); s.on = chosen; s.since = frame }
      s.held++
      s.last = frame
      s.peak = Math.max(s.peak, d ?? depth(chosen, x, y))
      const need = chosen === finalHold.id ? finalTouch : dwell
      if (!s.confirmed && s.held >= need && (s.peak >= -grazeDepth || s.held >= grazeFrames)) {
        s.confirmed = true
        if (!activatedAt.has(chosen)) activatedAt.set(chosen, frame)
      }
      if (s.confirmed) now[key] = chosen
    }
    if (completion == null) {
      if (now.left_hand === finalHold.id && now.right_hand === finalHold.id) {
        const overlap = frame - Math.max(st.left_hand.since, st.right_hand.since) + 1
        finalDwell = Math.max(finalDwell + 1, overlap)
        if (finalDwell >= finalFrames) completion = frame
      } else finalDwell = 0
    }
    if (startFrame == null) {
      // No floor segmentation here: both feet on holds is "off the ground".
      const started = st.left_foot.on != null && st.right_foot.on != null
      startDwell = started ? startDwell + 1 : Math.max(0, startDwell - 1)
      if (startDwell >= startFrames) startFrame = frame - startDwell + 1
    }
  }
  for (const l of LIMBS) close(l.key)

  if (startFrame == null) {
    // Never saw both feet on holds — start at the first confirmed contact instead.
    startFrame = contacts.length ? Math.min(...contacts.map((c) => c.start)) : poses.frames[0]
    warnings.push('The clock start was inferred from the first contact (both feet were never seen on holds together).')
  }
  if (completion == null) warnings.push('No top-out detected: both hands never held the top hold together.')
  const lo = startFrame, hi = completion ?? poses.frames[poses.frames.length - 1]

  // Restrict to the climb, then merge a limb's re-grips on the same hold.
  const merged: Contact[] = []
  const latest = new Map<LimbKey, Contact>()
  for (const c of [...contacts].sort((a, b) => a.start - b.start || a.limb.localeCompare(b.limb))) {
    const start = Math.max(c.start, lo), end = Math.min(c.end, hi)
    if (end < start) continue
    const prev = latest.get(c.limb)
    if (prev && prev.holdId === c.holdId) { prev.end = Math.max(prev.end, end); continue }
    const e = { ...c, start, end }
    merged.push(e)
    latest.set(c.limb, e)
  }
  const moves: PipelineMove[] = merged.map((m, i) => ({
    step: i + 1,
    hold_id: m.holdId,
    limb: m.limb,
    limb_label: LIMBS.find((l) => l.key === m.limb)!.label,
    time: round((m.start - lo) / fps),
    contact_seconds: round((m.end - m.start + 1) / fps),
  }))
  const firstUse = new Map<number, number>()
  for (const m of merged) if (!firstUse.has(m.holdId) || m.start < firstUse.get(m.holdId)!) firstUse.set(m.holdId, m.start)
  const order = [...firstUse.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
  const elapsed = completion != null ? (completion - lo) / fps : null

  const journey = hi - lo + 1
  const perLimb: Record<string, any> = {}
  let total = 0
  for (const l of LIMBS) total += merged.filter((m) => m.limb === l.key).reduce((s, m) => s + m.end - m.start + 1, 0)
  for (const l of LIMBS) {
    const own = merged.filter((m) => m.limb === l.key)
    const frames = own.reduce((s, m) => s + m.end - m.start + 1, 0)
    const seq: number[] = []
    for (const m of own) if (seq[seq.length - 1] !== m.holdId) seq.push(m.holdId)
    perLimb[l.key] = {
      seconds: round(frames / fps),
      share_of_contact: round(total ? frames / total : 0, 5),
      coverage_of_climb: round(journey ? Math.min(1, frames / journey) : 0, 5),
      holds: [...new Set(seq)].sort((a, b) => a - b),
      n_holds: new Set(seq).size,
      sequence: seq,
    }
  }

  const torsoFrames = [...midline.keys()].filter((f) => f >= lo - fps && f <= hi + fps).sort((a, b) => a - b)
  const tx = gaussianSmooth(torsoFrames.map((f) => midline.get(f)![0]), 3)
  const ty = gaussianSmooth(torsoFrames.map((f) => midline.get(f)![1]), 3)
  const torso: [number, number, number][] = torsoFrames
    .map((f, i) => [round((f - lo) / fps), round(tx[i], 5), round(ty[i], 5)] as [number, number, number])
    .filter((_, i) => i % 2 === 0)

  const color = opts.color ?? 'green'
  const climb: PipelineClimb = {
    route: { color, grade: '—', name: null, prompt: `${color} climbing hold` },
    route_color: color,
    prompt: `${color} climbing hold`,
    fps,
    holds_detected: holds.length,
    holds_used: order.length,
    start_frame: lo,
    completion_frame: completion,
    final_hold_id: finalHold.id,
    elapsed_seconds: elapsed != null ? round(elapsed) : null,
    topped_out: completion != null,
    order,
    sequence: order,
    moves,
    utilization: { total_contact_seconds: round(total / fps), per_limb: perLimb },
  }
  return { holds: holds.map((h) => ({ ...h, polygon: (h.polygon ?? []).map((p) => [round(p[0], 5), round(p[1], 5)] as Vec2) })), climb, torso, startFrame: lo, completionFrame: completion, warnings }
}

function iou(a: number[], b: number[]) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3])
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const u = a[2] * a[3] + b[2] * b[3] - inter
  return u > 0 ? inter / u : 0
}
function overlapFrac(box: number[], wall: number[]) {
  const x0 = Math.max(box[0], wall[0]), y0 = Math.max(box[1], wall[1])
  const x1 = Math.min(box[0] + box[2], wall[0] + wall[2]), y1 = Math.min(box[1] + box[3], wall[1] + wall[3])
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  return box[2] * box[3] > 0 ? inter / (box[2] * box[3]) : 0
}
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d
