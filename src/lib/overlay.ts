// What the replay draws over the video at one moment of the clip, in the
// video's own 0–1 coordinates: each hold's outline where the camera saw it,
// whether it has been used and whether a limb is on it now, and the climber's
// joints. The player (VideoStage) and the exported analysis video both draw
// from this, so they cannot disagree.

import { applyAffine } from './geometry'
import { holdOutlineAt } from './motion'
import { poseAt, type Joint } from './skeleton'
import type { Timeline } from './timeline'
import { LIMBS, type LimbKey, type Session, type Vec2 } from './types'

export const LIMB_JOINT: Record<LimbKey, number> = { left_hand: 9, right_hand: 10, left_foot: 15, right_foot: 16 }

export interface OverlayFrame {
  holds: { id: number; poly: Vec2[]; lit: boolean; held: boolean }[]
  joints: Joint[] | null
  holding: Map<LimbKey, number | null>
  /** Limbs at their holds, for a session without a pose track. */
  fallbackLimbs: { key: LimbKey; p: Vec2 }[]
}

/** `t` is the climb clock (seconds from the start of the climb). */
export function overlayAt(s: Session, tl: Timeline, t: number): OverlayFrame | null {
  const v = s.video
  if (!v || !v.width || !v.height || v.overlays === 'burned-in') return null
  const vt = t + v.offset
  const tc = Math.max(0, Math.min(t, tl.climbEnd))
  const lit = new Set(tl.litAt(t))
  const holding = new Map(LIMBS.map((l) => [l.key, tl.limbAt(l.key, tc).holdId] as const))
  const held = new Set([...holding.values()].filter((h): h is number => h != null))
  const holds = []
  for (const h of s.holds) {
    const poly = v.motion ? holdOutlineAt(h.polygon, v.sightings?.[h.id], v.motion, vt) : h.polygon.map((p) => applyAffine(v.affine, p))
    if (poly) holds.push({ id: h.id, poly, lit: lit.has(h.id), held: held.has(h.id) })
  }
  const joints = poseAt(s.pose, vt)
  const fallbackLimbs = s.pose ? [] : LIMBS.flatMap((l) => {
    const st = tl.limbAt(l.key, tc)
    return st.holdId ? [{ key: l.key, p: applyAffine(v.affine, st.pos) }] : []
  })
  return { holds, joints, holding, fallbackLimbs }
}
