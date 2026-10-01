// Coaching, two ways. On-device: rules over the measurements, instant and
// always available. VLM: the same measurements (and, when the server has it,
// the clip itself) sent through VLM Run to a multimodal model.

import { sampleFrames } from './frames'
import { clamp } from './geometry'
import { LIMBS, LIMB_BY_KEY, type CoachFeedback, type LimbKey, type Session } from './types'

export interface Insight {
  id: string
  tone: 'good' | 'warn' | 'info'
  title: string
  detail: string
  metric?: string
  time?: number
  holds?: number[]
}

function staticContacts(s: Session) {
  return [...s.moves].sort((a, b) => b.duration - a.duration)
}

/** The longest stretch where no limb arrived anywhere new. */
function longestStill(s: Session) {
  const times = [...new Set(s.moves.map((m) => m.time))].sort((a, b) => a - b)
  const end = s.elapsed ?? s.duration
  let best = { from: 0, to: 0 }
  const pts = [0, ...times, end]
  for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > best.to - best.from) best = { from: pts[i - 1], to: pts[i] }
  return best
}

function matches(s: Session) {
  const hands = s.moves.filter((m) => LIMB_BY_KEY[m.limb].hand)
  const ids = new Set<number>()
  for (const a of hands) for (const b of hands) {
    if (a.limb !== b.limb && a.holdId === b.holdId && a.time < b.time + b.duration && b.time < a.time + a.duration) ids.add(a.holdId)
  }
  return [...ids].sort((a, b) => a - b)
}

export function computeInsights(s: Session): Insight[] {
  const out: Insight[] = []
  const elapsed = s.elapsed ?? s.duration
  const used = s.sequence.length
  const attempts = s.comparison?.attempts ?? []
  const mine = attempts.find((a) => a.isThis)
  const sends = attempts.filter((a) => a.toppedOut && a.elapsed != null)

  if (sends.length > 1 && mine?.elapsed != null) {
    const avg = sends.reduce((t, a) => t + a.elapsed!, 0) / sends.length
    const rank = [...sends].sort((a, b) => a.elapsed! - b.elapsed!).findIndex((a) => a.label === mine.label) + 1
    const minHolds = Math.min(...sends.map((a) => a.sequence.length))
    out.push({
      id: 'rank',
      tone: rank === 1 ? 'good' : 'info',
      title: rank === 1 ? 'Fastest send of the session' : `#${rank} of ${sends.length} sends`,
      detail: `${Math.abs(avg - mine.elapsed).toFixed(2)} s ${mine.elapsed <= avg ? 'faster' : 'slower'} than your average of ${avg.toFixed(2)} s${mine.sequence.length === minHolds ? `, on the shortest beta (${minHolds} holds).` : '.'}`,
      metric: `${mine.elapsed.toFixed(2)} s`,
    })
  }

  out.push({
    id: 'economy',
    tone: used / Math.max(1, s.holdsDetected) <= 0.65 ? 'good' : 'info',
    title: `${used} of ${s.holdsDetected} holds`,
    detail: `You skipped ${s.holdsDetected - used} holds on the route${s.holdsDetected - used ? ` (${s.holds.filter((h) => !s.sequence.includes(h.id)).map((h) => h.id).join(', ')})` : ''}. Fewer touches usually means fewer readjustments.`,
    metric: `${Math.round((used / Math.max(1, s.holdsDetected)) * 100)}%`,
    holds: s.holds.filter((h) => !s.sequence.includes(h.id)).map((h) => h.id),
  })

  const top = staticContacts(s)[0]
  if (top) {
    out.push({
      id: 'longest',
      tone: top.duration > elapsed * 0.33 ? 'warn' : 'info',
      title: `Longest grip: ${LIMB_BY_KEY[top.limb].name} on ${top.holdId}`,
      detail: `${top.duration.toFixed(2)} s from ${top.time.toFixed(2)} s — ${Math.round((top.duration / elapsed) * 100)}% of the climb. That limb was your anchor while the others moved.`,
      metric: `${top.duration.toFixed(1)} s`,
      time: top.time,
      holds: [top.holdId],
    })
  }

  const still = longestStill(s)
  if (still.to - still.from > 1.2) {
    out.push({
      id: 'pause',
      tone: still.to - still.from > 2.5 ? 'warn' : 'info',
      title: 'Longest pause between moves',
      detail: `No new placement from ${still.from.toFixed(2)} s to ${still.to.toFixed(2)} s. Reading the next move from the ground saves this time on the wall.`,
      metric: `${(still.to - still.from).toFixed(1)} s`,
      time: still.from,
    })
  }

  if (s.utilization) {
    const feet = (['left_foot', 'right_foot'] as LimbKey[]).map((k) => ({ k, c: s.utilization![k].coverage }))
    const weak = feet.sort((a, b) => a.c - b.c)[0]
    out.push({
      id: 'feet',
      tone: weak.c < 0.8 ? 'warn' : 'good',
      title: weak.c < 0.8 ? `${cap(LIMB_BY_KEY[weak.k].name)} spent ${Math.round((1 - weak.c) * 100)}% of the climb off a hold` : 'Feet stayed on holds',
      detail: weak.c < 0.8 ? 'Every second a foot hangs, the arms carry that weight. Place it before you reach.' : 'Both feet were on holds for most of the climb — the arms only steered.',
      metric: `${Math.round(weak.c * 100)}%`,
    })
  }

  const m = matches(s)
  if (m.length) {
    out.push({
      id: 'matches',
      tone: m.length > 3 ? 'warn' : 'info',
      title: `Matched hands on ${m.length} hold${m.length > 1 ? 's' : ''}`,
      detail: `Both hands shared ${m.join(', ')}. Matching is a rest — on easy terrain, crossing through is faster.`,
      holds: m,
    })
  }

  const handMoves = s.moves.filter((x) => LIMB_BY_KEY[x.limb].hand).length
  const footMoves = s.moves.length - handMoves
  out.push({
    id: 'rhythm',
    tone: footMoves >= handMoves * 0.7 ? 'good' : 'warn',
    title: `${handMoves} hand moves · ${footMoves} foot moves`,
    detail: footMoves >= handMoves * 0.7 ? 'Your feet kept pace with your hands — a climber pushing with the legs.' : 'Hands moved far more often than feet: more feet between reaches will take load off the arms.',
    metric: `${(s.moves.length / Math.max(0.1, elapsed)).toFixed(2)} moves/s`,
  })
  return out
}

/** Scores and words from the rules alone, in the coach's own shape. */
export function onDeviceFeedback(s: Session): CoachFeedback {
  const elapsed = s.elapsed ?? s.duration
  const used = s.sequence.length
  const econ = clamp(1 - (used - 4) / Math.max(4, s.holdsDetected), 0.3, 1)
  const util = s.utilization
  const footCov = util ? (util.left_foot.coverage + util.right_foot.coverage) / 2 : 0.7
  const still = longestStill(s)
  const flow = clamp(1 - (still.to - still.from) / Math.max(3, elapsed), 0.35, 1)
  const pace = clamp(1 - (elapsed / Math.max(1, used) - 0.9) / 2.5, 0.3, 1)
  const scores = {
    efficiency: Math.round(econ * 100),
    flow: Math.round(flow * 100),
    footwork: Math.round(clamp(footCov) * 100),
    pacing: Math.round(pace * 100),
  }
  const score = Math.round(scores.efficiency * 0.3 + scores.flow * 0.25 + scores.footwork * 0.25 + scores.pacing * 0.2)
  const ins = computeInsights(s)
  const top = staticContacts(s)[0]
  const weakFoot = util ? (['left_foot', 'right_foot'] as LimbKey[]).sort((a, b) => util[a].coverage - util[b].coverage)[0] : null
  return {
    source: 'on-device',
    headline: s.toppedOut ? `Clean send in ${elapsed.toFixed(2)} s on ${used} holds` : `${used} holds in — the top is next`,
    summary: `You ${s.toppedOut ? 'topped out' : 'climbed'} the ${s.route.color} ${s.route.grade} using ${used} of ${s.holdsDetected} holds. ${ins.find((i) => i.id === 'rank')?.detail ?? ''} Your ${top ? `${LIMB_BY_KEY[top.limb].name} on ${top.holdId}` : 'grip'} carried the middle of the climb.`.trim(),
    score,
    scores,
    strengths: ins.filter((i) => i.tone === 'good').slice(0, 3).map((i) => ({ title: i.title, detail: i.detail })),
    focus: ins.filter((i) => i.tone !== 'good').slice(0, 3).map((i) => ({ title: i.title, detail: i.detail, time: i.time ?? null, holds: i.holds })),
    drills: [
      { name: 'Silent feet', how: 'Climb the route again placing every foot without a sound — it forces you to look at each foothold before you weight it.', dose: '3 laps' },
      weakFoot
        ? { name: `${cap(LIMB_BY_KEY[weakFoot].name)} first`, how: `On every move, place the ${LIMB_BY_KEY[weakFoot].name} before you reach with a hand.`, dose: '2 × 4 moves' }
        : { name: 'Hover hands', how: 'Before each grab, hover the hand over the hold for one second — it teaches you to move from balance, not momentum.', dose: '2 laps' },
    ],
    beta: `Keep the ${s.sequence.join(' › ')} line${s.comparison ? ' — it was your shortest' : ''}, and cut the pause ${still.to - still.from > 1.2 ? `around ${still.from.toFixed(1)} s` : 'before the top'} by pre-reading the finish.`,
    next_goal: s.toppedOut ? `Send it under ${(elapsed * 0.9).toFixed(1)} s with both feet on holds 85% of the time.` : 'Top out — both hands on the finish hold.',
  }
}

/** What the VLM is told about the climb. Compact, and in the pipeline's terms. */
export function analyticsFor(s: Session) {
  const ins = computeInsights(s)
  return {
    route: { color: s.route.color, grade: s.route.grade, name: s.route.name, holds_detected: s.holdsDetected },
    climber: s.climber,
    elapsed_seconds: s.elapsed,
    topped_out: s.toppedOut,
    sequence: s.sequence,
    unused_holds: s.holds.filter((h) => !s.sequence.includes(h.id)).map((h) => h.id),
    moves: s.moves.map((m) => ({ limb: LIMB_BY_KEY[m.limb].label, hold: m.holdId, t: +m.time.toFixed(2), held_s: +m.duration.toFixed(2) })),
    on_a_hold: s.utilization ? Object.fromEntries(LIMBS.map((l) => [l.label, Math.round(s.utilization![l.key].coverage * 100) + '%'])) : undefined,
    per_limb_sequence: s.utilization ? Object.fromEntries(LIMBS.map((l) => [l.label, s.utilization![l.key].sequence])) : undefined,
    attempts: s.comparison?.attempts.map((a) => ({ label: a.isThis ? `${a.label} (this climb)` : a.label, holds: a.sequence.length, seconds: a.elapsed, sequence: a.sequence, topped_out: a.toppedOut })),
    hold_positions: s.holds.map((h) => ({ id: h.id, x: +h.center[0].toFixed(3), y: +h.center[1].toFixed(3) })),
    measured_insights: ins.map((i) => `${i.title}: ${i.detail}`),
  }
}

export async function requestVlmCoach(s: Session, signal?: AbortSignal): Promise<CoachFeedback> {
  const frames = await sampleFrames(s)
  const res = await fetch('/api/coach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analytics: analyticsFor(s), frames, exampleId: s.exampleId, mediaId: s.video?.mediaId }),
    signal,
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error ?? `Coach failed (${res.status})`)
  return normalizeFeedback(j.feedback, { model: j.model, watchedVideo: j.watchedVideo, frames: j.frames })
}

export function normalizeFeedback(f: any, extra: Partial<CoachFeedback> = {}): CoachFeedback {
  const num = (v: any, d = 70) => clamp(Number.isFinite(+v) ? Math.round(+v) : d, 0, 100)
  // Models drift from the schema: items come back as bare strings, the score
  // as an object. Accept the drift rather than show nothing.
  const item = (x: any) => {
    if (typeof x === 'string') {
      const [title, ...rest] = x.split(/(?<=[.!?])\s+/)
      return { title: title.replace(/[.!?]$/, ''), detail: rest.join(' ') }
    }
    return { title: String(x?.title ?? x?.name ?? ''), detail: String(x?.detail ?? x?.description ?? '') }
  }
  const sc = typeof f?.score === 'object' && f?.score ? f.score : null
  const scores = f?.scores ?? sc ?? {}
  const vals = ['efficiency', 'flow', 'footwork', 'pacing'].map((k) => num(scores[k]))
  return {
    source: 'vlm',
    headline: String(f?.headline ?? 'Your climb, read'),
    summary: String(f?.summary ?? ''),
    score: sc ? Math.round(vals.reduce((a, b) => a + b, 0) / 4) : num(f?.score),
    scores: { efficiency: vals[0], flow: vals[1], footwork: vals[2], pacing: vals[3] },
    strengths: (f?.strengths ?? []).slice(0, 3).map(item),
    focus: (f?.focus ?? []).slice(0, 3).map((x: any) => ({
      ...item(x),
      time: x && typeof x === 'object' && Number.isFinite(+x.time) && x.time !== null ? +x.time : null,
      holds: x && Array.isArray(x.holds) ? x.holds.map(Number).filter(Number.isFinite) : [],
    })),
    drills: (f?.drills ?? []).slice(0, 3).map((x: any) => (typeof x === 'string' ? { name: item(x).title, how: item(x).detail } : { name: String(x?.name ?? ''), how: String(x?.how ?? ''), dose: x?.dose ? String(x.dose) : undefined })),
    beta: String(f?.beta ?? ''),
    next_goal: String(f?.next_goal ?? ''),
    generatedAt: new Date().toISOString(),
    ...extra,
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
