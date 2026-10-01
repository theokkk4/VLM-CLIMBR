// Pipeline JSON → Session. Every source (the bundled example, files dropped on
// the import page, JSON pasted from a run, a live VLM Run analysis) ends here,
// so the viewer only ever reads one shape.

import { bboxOf, centroid, clamp, median } from './geometry'
import {
  LIMBS,
  type Attempt,
  type ClimbrManifest,
  type Comparison,
  type Hold,
  type LimbKey,
  type LimbUtil,
  type Move,
  type PipelineClimb,
  type PipelineComparison,
  type PipelineHold,
  type PipelineMove,
  type PipelineSequence,
  type Session,
  type Vec2,
} from './types'

export interface SessionParts {
  manifest?: ClimbrManifest
  climb?: PipelineClimb
  sequence?: PipelineSequence
  holds?: PipelineHold[]
  comparison?: PipelineComparison
  baseUrl?: string // where the manifest's relative paths resolve
  videoUrl?: string
  wallUrl?: string
  plyUrl?: string
  kind?: Session['kind']
  meta?: Partial<Pick<Session, 'title' | 'climber' | 'gym' | 'route'>>
}

const uid = () => Math.random().toString(36).slice(2, 10)

export function holdsFromPipeline(list: PipelineHold[]): Hold[] {
  return list
    .filter((h) => Array.isArray(h.bbox) && h.bbox.length === 4)
    .map((h, i) => {
      const [x, y, w, hh] = h.bbox
      const polygon: Vec2[] = h.polygon && h.polygon.length >= 3
        ? h.polygon.map((p) => [Number(p[0]), Number(p[1])] as Vec2)
        : [[x, y], [x + w, y], [x + w, y + hh], [x, y + hh]]
      return {
        id: Number.isFinite(h.id) ? Number(h.id) : i + 1,
        polygon,
        bbox: bboxOf(polygon),
        center: centroid(polygon),
        score: typeof h.score === 'number' ? h.score : undefined,
        depth: typeof h.depth === 'number' ? h.depth : undefined,
      }
    })
    .sort((a, b) => a.id - b.id)
}

/** No holds.json? Lay the ids out bottom-to-top in a gentle zigzag so the route
 *  still reads. The viewer says the shapes are approximate. */
export function placeholderHolds(ids: number[]): Hold[] {
  const max = Math.max(...ids, 1)
  return [...new Set(ids)].sort((a, b) => a - b).map((id) => {
    const t = (id - 1) / Math.max(1, max - 1)
    const cx = 0.5 + Math.sin(id * 1.7) * 0.16
    const cy = 0.92 - t * 0.84
    const r = 0.025 + ((id * 37) % 10) / 600
    const polygon: Vec2[] = Array.from({ length: 9 }, (_, k) => {
      const a = (k / 9) * Math.PI * 2
      const wob = 1 + 0.18 * Math.sin(a * 3 + id)
      return [cx + Math.cos(a) * r * wob * 0.9, cy + Math.sin(a) * r * wob * 0.75] as Vec2
    })
    return { id, polygon, bbox: bboxOf(polygon), center: centroid(polygon) }
  })
}

export function movesFromPipeline(list: PipelineMove[] = []): Move[] {
  return list
    .filter((m) => m && LIMBS.some((l) => l.key === m.limb))
    .map((m, i) => ({
      step: m.step ?? i + 1,
      holdId: Number(m.hold_id),
      limb: m.limb,
      time: Number(m.time) || 0,
      duration: Math.max(0.03, Number(m.contact_seconds) || 0.03),
    }))
    .sort((a, b) => a.time - b.time || a.step - b.step)
}

/** A sequence with no moves (a pasted comparison, say): spread it over the
 *  climb, hands taking the upper holds and feet the lower ones. */
function movesFromSequence(sequence: number[], elapsed: number, holds: Hold[]): Move[] {
  const byId = new Map(holds.map((h) => [h.id, h]))
  const step = elapsed / Math.max(1, sequence.length)
  const moves: Move[] = []
  const lastHand: LimbKey[] = ['left_hand', 'right_hand']
  const lastFoot: LimbKey[] = ['left_foot', 'right_foot']
  sequence.forEach((id, i) => {
    const y = byId.get(id)?.center[1] ?? 0.5
    const hand = i < 2 ? i === 0 : y < 0.55
    const limb = hand ? lastHand[i % 2] : lastFoot[i % 2]
    moves.push({ step: i + 1, holdId: id, limb, time: i * step, duration: Math.max(0.3, elapsed - i * step) })
  })
  return moves
}

export function utilizationFromMoves(moves: Move[], elapsed: number): Record<LimbKey, LimbUtil> {
  const total = moves.reduce((s, m) => s + m.duration, 0) || 1
  const out = {} as Record<LimbKey, LimbUtil>
  for (const limb of LIMBS) {
    const own = moves.filter((m) => m.limb === limb.key)
    const seconds = own.reduce((s, m) => s + Math.min(m.duration, Math.max(0, elapsed - m.time)), 0)
    const sequence: number[] = []
    for (const m of own) if (sequence[sequence.length - 1] !== m.holdId) sequence.push(m.holdId)
    out[limb.key] = {
      seconds,
      share: seconds / total,
      coverage: elapsed > 0 ? clamp(seconds / elapsed) : 0,
      holds: [...new Set(own.map((m) => m.holdId))].sort((a, b) => a - b),
      sequence,
    }
  }
  return out
}

function utilizationFromPipeline(u: PipelineClimb['utilization']): Record<LimbKey, LimbUtil> | undefined {
  const per = u?.per_limb
  if (!per) return undefined
  const out = {} as Record<LimbKey, LimbUtil>
  for (const limb of LIMBS) {
    const p = per[limb.key]
    if (!p) return undefined
    out[limb.key] = { seconds: p.seconds, share: p.share_of_contact, coverage: p.coverage_of_climb, holds: p.holds ?? [], sequence: p.sequence ?? [] }
  }
  return out
}

function comparisonFrom(parts: SessionParts, thisLabel: string | undefined, thisSeq: number[], elapsed: number | null, topped: boolean): Comparison | undefined {
  const c = parts.comparison
  if (c?.attempts?.length) {
    const attempts: Attempt[] = c.attempts.map((a) => ({
      label: a.label,
      index: a.index,
      sequence: a.sequence_aligned ?? a.sequence ?? [],
      elapsed: a.elapsed_seconds,
      toppedOut: a.topped_out,
      isThis: thisLabel ? a.label === thisLabel : false,
    }))
    if (!attempts.some((a) => a.isThis)) {
      // No label to go on: the attempt whose sequence is this one's.
      const match = attempts.find((a) => a.sequence.join() === thisSeq.join())
      if (match) match.isThis = true
    }
    return { reference: c.reference, shortest: c.shortest, fastest: c.fastest, shared: c.shared_holds ?? [], attempts }
  }
  const s = parts.sequence?.comparison
  if (s?.others?.length) {
    const label = thisLabel ?? parts.sequence?.label ?? 'this climb'
    const all = [
      { label, sequence: thisSeq, elapsed_seconds: elapsed, topped_out: topped },
      ...s.others,
    ].sort((a, b) => a.label.localeCompare(b.label))
    return {
      reference: s.reference,
      shortest: s.shortest,
      fastest: s.fastest,
      shared: s.shared_holds ?? [],
      attempts: all.map((a, i) => ({
        label: a.label,
        index: i + 1,
        sequence: a.sequence,
        elapsed: a.elapsed_seconds,
        toppedOut: a.topped_out,
        isThis: a.label === label,
      })),
    }
  }
  return undefined
}

/** Meters per canvas-height unit, guessed from the route when nothing measured
 *  it: a gym boulder's holds span roughly 3.2 m from first foot to the top. */
export function estimateScale(holds: Hold[]): Session['scale'] {
  if (!holds.length) return { metersPerUnit: 4, floorY: 1, source: 'estimated' }
  const ys = holds.map((h) => h.center[1])
  const span = Math.max(0.05, Math.max(...ys) - Math.min(...ys))
  const mpu = 3.2 / span
  const lowest = Math.max(...holds.map((h) => h.bbox[1] + h.bbox[3]))
  return { metersPerUnit: mpu, floorY: lowest + 0.28 / mpu, source: 'estimated' }
}

export function buildSession(parts: SessionParts): Session {
  const { manifest: man, climb, sequence: seqFile } = parts
  const base = parts.baseUrl ? parts.baseUrl.replace(/\/?$/, '/') : ''
  const resolve = (p?: string) => (p ? (/^(blob:|data:|https?:|\/)/.test(p) ? p : base + p) : undefined)

  const route = {
    color: (climb?.route?.color ?? climb?.route_color ?? seqFile?.route?.color ?? parts.comparison?.route?.color ?? 'green').toLowerCase(),
    grade: climb?.route?.grade ?? seqFile?.route?.grade ?? parts.comparison?.route?.grade ?? '—',
    name: climb?.route?.name ?? seqFile?.route?.name ?? undefined,
    prompt: climb?.prompt ?? climb?.route?.prompt,
    ...parts.meta?.route,
  }

  const sequence = climb?.sequence ?? climb?.order ?? seqFile?.sequence ?? []
  const elapsedRaw = climb?.elapsed_seconds ?? seqFile?.elapsed_seconds ?? null
  const toppedOut = climb?.topped_out ?? seqFile?.topped_out ?? elapsedRaw != null

  let holds = parts.holds?.length ? holdsFromPipeline(parts.holds) : []
  let moves = movesFromPipeline(climb?.moves ?? seqFile?.moves ?? [])
  if (!moves.length && parts.comparison) {
    const own = parts.comparison.attempts.find((a) => a.label === (man?.label ?? seqFile?.label))
    if (own?.limb_sequence?.length) moves = movesFromPipeline(own.limb_sequence)
  }
  const usedIds = [...sequence, ...moves.map((m) => m.holdId)]
  const detected = climb?.holds_detected ?? seqFile?.holds_detected ?? 0
  if (!holds.length) {
    const ids = usedIds.length ? usedIds : Array.from({ length: Math.max(detected, 1) }, (_, i) => i + 1)
    const all = detected ? Array.from({ length: Math.max(detected, ...ids) }, (_, i) => i + 1) : ids
    holds = placeholderHolds(all)
  }

  const lastMoveEnd = moves.reduce((m, x) => Math.max(m, x.time + x.duration), 0)
  // A climb that did not top out has no time to top, whatever its last move was.
  const elapsed = elapsedRaw ?? (climb?.topped_out === false ? null : lastMoveEnd || null)
  if (!moves.length && sequence.length) moves = movesFromSequence(sequence, elapsed ?? sequence.length * 1.2, holds)
  const order = sequence.length ? sequence : firstUseOrder(moves)

  const utilization = utilizationFromPipeline(climb?.utilization) ?? (moves.length ? utilizationFromMoves(moves, elapsed ?? lastMoveEnd) : undefined)
  const label = man?.label ?? seqFile?.label
  const finalHoldId = climb?.final_hold_id ?? (holds.length ? holds.reduce((a, b) => (a.center[1] < b.center[1] ? a : b)).id : null)

  const fps = climb?.fps ?? 30
  const startFrame = climb?.start_frame ?? null
  const v = man?.video
  const videoSrc = parts.videoUrl ?? resolve(v?.src)
  const offset = v?.clock_offset ?? (startFrame != null ? startFrame / fps : 0)
  // With the clip's real length known, the session runs to the end of it.
  const videoSpan = v?.duration ? v.duration - offset : 0

  const scale = man?.scale
    ? { metersPerUnit: man.scale.meters_per_unit, floorY: man.scale.floor_y, source: man.scale.source ?? 'estimated' as const }
    : estimateScale(holds)

  const session: Session = {
    id: man?.id ?? `session-${uid()}`,
    title: parts.meta?.title ?? man?.title ?? route.name ?? `${cap(route.color)} ${route.grade !== '—' ? route.grade : 'route'}`,
    climber: parts.meta?.climber ?? man?.climber ?? 'You',
    gym: parts.meta?.gym ?? man?.gym,
    recordedAt: man?.recorded_at ?? new Date().toISOString(),
    kind: parts.kind ?? 'import',
    credit: man?.credit,
    route,
    label,
    fps,
    canvas: man?.canvas ?? { width: 9, height: 16 },
    holds,
    moves,
    sequence: order,
    elapsed,
    duration: Math.max(elapsed ?? 0, lastMoveEnd, videoSpan),
    toppedOut,
    finalHoldId,
    holdsDetected: detected || holds.length,
    utilization,
    torso: man?.torso,
    comparison: comparisonFrom(parts, label, order, elapsed, toppedOut),
    video: videoSrc
      ? {
          src: videoSrc,
          webm: parts.videoUrl ? undefined : resolve(v?.webm),
          poster: resolve(v?.poster),
          offset,
          affine: v?.affine,
          width: v?.width,
          height: v?.height,
          duration: v?.duration,
          overlays: v?.overlays ?? 'none',
        }
      : undefined,
    wall: parts.wallUrl ? { src: parts.wallUrl, affine: man?.wall?.affine ?? v?.affine ?? [[1, 0, 0], [0, 1, 0]] } : man?.wall ? { src: resolve(man.wall.src)!, affine: man.wall.affine } : undefined,
    scale,
    lidar: parts.plyUrl ? { plyUrl: parts.plyUrl } : undefined,
    coach: man?.coach,
    models: man?.models,
  }
  return session
}

function firstUseOrder(moves: Move[]): number[] {
  const seen: number[] = []
  for (const m of [...moves].sort((a, b) => a.time - b.time)) if (!seen.includes(m.holdId)) seen.push(m.holdId)
  return seen
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Hold-unit for sizing labels and markers: the median hold height. */
export const holdUnit = (holds: Hold[]) => median(holds.map((h) => h.bbox[3])) || 0.03

