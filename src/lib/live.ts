// A live analysis → a Session, and the checks it must pass before it opens.
//
// Everything here is measured: the clip's length and frame size come from the
// server's probe, times from the models' own frame timestamps, the hold and
// joint positions from SAM 3.1 and ViTPose+. A check that fails stops the run
// with the reason; nothing is filled in to make it look finished.

import type { Reading } from './analyze'
import { buildSession } from './session'
import type { Check, LiveAnalysis, Session } from './types'
import type { AnalyzeResult } from './vlm'

export interface LiveMeta { title?: string; climber?: string; color: string; grade: string }

export function sessionFromLive(r: AnalyzeResult, reading: Reading, meta: LiveMeta, media: { src: string; webm?: string | null; poster?: string | null }): Session {
  const s = buildSession({
    manifest: {
      climbr: 1,
      canvas: reading.canvas,
      torso: reading.torso,
      video: {
        src: media.src,
        webm: media.webm ?? undefined,
        poster: media.poster ?? undefined,
        clock_offset: reading.start,
        affine: reading.motion ? undefined : [[1, 0, 0], [0, 1, 0]],
        width: r.playback.width,
        height: r.playback.height,
        duration: r.playback.duration,
        overlays: 'none',
      },
      models: { holds: 'facebook/sam3.1', pose: 'usyd-community/vitpose-plus-large' },
    },
    climb: reading.climb,
    holds: reading.holds,
    kind: 'live',
    meta: { title: meta.title || undefined, climber: meta.climber || undefined, route: { color: meta.color, grade: meta.grade } },
  })
  s.id = `live-${r.id}`
  s.recordedAt = new Date().toISOString()
  if (reading.motion) s.video!.motion = reading.motion
  if (reading.sightings) s.video!.sightings = reading.sightings
  s.video!.mediaId = `${r.id}/play.mp4`
  s.pose = reading.pose
  const cost = (r.usage?.holds?.cost ?? 0) + (r.usage?.pose?.cost ?? 0)
  s.usage = { costUsd: cost }
  const span = <T,>(xs: T[], f: (x: T) => number): [number, number] | null => (xs.length ? [f(xs[0]), f(xs[xs.length - 1])] : null)
  s.analysis = {
    runId: r.id,
    analyzedAt: new Date().toISOString(),
    source: { name: r.source.name, duration: r.source.duration, fps: r.source.fps, width: r.source.width, height: r.source.height, frameCount: r.source.frameCount, sourceFormat: r.source.sourceFormat, bytes: r.source.bytes },
    analysis: r.analysis,
    sam: { model: 'facebook/sam3.1', prompt: r.prompt, samples: r.sam.samples.length, tracks: r.sam.tracks, detections: r.sam.detections.length, coords: r.sam.coords, span: span(r.sam.samples, (x) => x.t) },
    pose: { model: 'usyd-community/vitpose-plus-large', framesPosed: r.pose.framesPosed, people: r.pose.people, coords: r.pose.coords, keypoints: 'COCO-17', span: span(r.pose.frames, (x) => x.timestamp) },
    reading: reading.stats,
    validation: [],
    warnings: [...r.warnings, ...reading.warnings],
    debug: r.debug,
  }
  s.analysis.validation = validateLive(s, r, reading)
  return s
}

/** Every number the replay will show, checked against what was measured. */
export function validateLive(s: Session, r: AnalyzeResult, reading: Reading): Check[] {
  const checks: Check[] = []
  const add = (id: string, label: string, ok: boolean, detail: string, severity: Check['severity'] = 'error') => checks.push({ id, label, ok, severity, detail })
  const fin = (v: number) => Number.isFinite(v)
  const src = r.source, A = r.analysis, P = r.playback
  const dur = src.duration

  add('metadata', 'Clip metadata read', [src.duration, src.fps, src.width, src.height, src.frameCount].every((v) => fin(v) && v > 0),
    `${src.width}×${src.height} · ${src.fps.toFixed(2)} fps · ${src.duration.toFixed(3)} s · ${src.frameCount} frames · ${src.sourceFormat}`)
  add('playback', 'Playback copy matches the clip', Math.abs(P.duration - dur) <= Math.max(0.15, 2 / src.fps) && Math.abs(P.width / P.height - src.width / src.height) < 0.01,
    `playback ${P.width}×${P.height}, ${P.duration.toFixed(3)} s vs source ${src.width}×${src.height}, ${dur.toFixed(3)} s`)
  add('frames', 'Frames extracted at real timestamps', Math.abs(A.frameCount - Math.round(dur * A.fps)) <= 1,
    `${A.frameCount} frames at ${A.fps} fps for ${dur.toFixed(2)} s`)

  const samLast = r.sam.samples.length ? r.sam.samples[r.sam.samples.length - 1].t : -1
  const step = r.sam.samples.length > 1 ? (samLast - r.sam.samples[0].t) / (r.sam.samples.length - 1) : A.duration
  add('sam-coverage', 'SAM 3.1 sampled the whole clip', r.sam.samples.length > 0 && r.sam.samples[0].t <= step && samLast >= A.duration - 1.5 * step - 1e-6,
    `${r.sam.samples.length} frames from ${r.sam.samples[0]?.t.toFixed(2) ?? '—'} to ${samLast.toFixed(2)} s, one every ${step.toFixed(2)} s`)
  add('sam-holds', 'SAM 3.1 found holds', r.sam.tracks > 0, `${r.sam.tracks} tracks, ${r.sam.detections.length} masks`)
  const posed = r.pose.framesPosed
  add('pose-coverage', 'ViTPose+ posed the whole clip', posed >= 0.9 * A.frameCount,
    `${posed} of ${A.frameCount} frames${r.pose.frames.length ? `, ${r.pose.frames[0].timestamp.toFixed(2)}–${r.pose.frames[r.pose.frames.length - 1].timestamp.toFixed(2)} s` : ''}`)
  add('climber', 'Climber tracked', reading.stats.climberFrames > 0,
    `${reading.stats.climberFrames} frames${reading.stats.climberSpan ? `, ${reading.stats.climberSpan[0].toFixed(2)}–${reading.stats.climberSpan[1].toFixed(2)} s` : ''} of ${reading.stats.people} ${reading.stats.people === 1 ? 'person' : 'people'}`)
  add('camera', reading.stats.camera === 'still' ? 'Camera still' : 'Camera motion registered', reading.stats.registeredSamples > 0 && (reading.stats.camera === 'still' || reading.stats.registeredFraction >= 0.5),
    `${reading.stats.camera} · ${reading.stats.registeredSamples}/${reading.stats.samSamples} sampled frames placed${reading.stats.misfit != null ? ` · misfit ${reading.stats.misfit.toFixed(2)} hold heights` : ''}`,
    reading.stats.registeredSamples > 0 ? 'warn' : 'error')
  add('alignment', 'Holds line up across the clip', reading.stats.misfit == null || reading.stats.misfit <= 0.5,
    reading.stats.misfit == null ? 'still camera' : `median misfit ${reading.stats.misfit.toFixed(2)} hold heights`, 'warn')
  add('read', 'Holds placed for the climber', reading.stats.framesRead >= 0.5 * reading.stats.climberFrames,
    `${reading.stats.framesRead} of ${reading.stats.climberFrames} climber frames`, 'warn')

  // The replay's own numbers.
  const v = s.video!
  const span = (v.duration ?? 0) - v.offset
  add('duration', 'Timeline spans the clip', fin(s.duration) && s.duration > 0 && Math.abs(s.duration - Math.max(span, s.elapsed ?? 0)) < 0.01 && v.duration === P.duration,
    `${(v.duration ?? 0).toFixed(3)} s of video, climb clock from ${v.offset.toFixed(2)} s`)
  add('canvas', 'Canvas has a size', s.canvas.width > 0 && s.canvas.height > 0, `${s.canvas.width}×${s.canvas.height}`)
  const polysOk = s.holds.length > 0 && s.holds.every((h) => h.polygon.length >= 3 && h.polygon.every(([x, y]) => fin(x) && fin(y) && x > -0.05 && x < 1.05 && y > -0.05 && y < 1.05))
  add('holds', 'Hold outlines on the canvas', polysOk, `${s.holds.length} holds`)
  const lo = -v.offset - 1e-6, hi = span + 1e-6
  const movesOk = s.moves.every((m) => fin(m.time) && fin(m.duration) && m.time >= lo && m.time + m.duration <= hi + 0.2 && s.holds.some((h) => h.id === m.holdId))
  add('moves-time', 'Moves on the clip’s clock', movesOk, `${s.moves.length} moves within ${(-v.offset).toFixed(2)}…${span.toFixed(2)} s`)
  add('moves', 'Contacts found', s.moves.length > 0, s.moves.length ? `${s.moves.length} moves, ${s.sequence.length} holds used` : 'no hand or foot stayed on a hold long enough to count', 'warn')
  const pose = s.pose
  const poseOk = !!pose && pose.t.length === pose.k.length && pose.t.every((t) => t >= -1e-6 && t <= (v.duration ?? 0) + 0.05) && pose.k.every((row) => row.length === 51 && row.every(fin))
  add('pose', 'Skeleton frames on the clip’s clock', poseOk, `${pose?.t.length ?? 0} frames, COCO-17`)
  const torsoOk = (s.torso ?? []).every(([t, x, y]) => fin(t) && fin(x) && fin(y) && t >= lo - 1 && t <= hi + 1)
  add('torso', 'Torso path on the canvas', torsoOk, `${s.torso?.length ?? 0} points`)
  return checks
}

export const failedChecks = (checks: Check[] | undefined) => (checks ?? []).filter((c) => !c.ok && c.severity === 'error')

/** A saved live session that cannot be trusted: analyzed before these checks
 *  existed (the version that misread clips), or failing them. */
export function sessionProblem(s: Session): string | null {
  if (s.kind !== 'live') return null
  if (!s.analysis) return 'Analyzed by an earlier version of CLIMBR that misread this clip. Re-import the video to analyze it again.'
  const bad = failedChecks(s.analysis.validation)
  if (bad.length) return `Failed: ${bad.map((c) => c.label.toLowerCase()).join(', ')}.`
  if (!(s.canvas.width > 0 && s.canvas.height > 0) || !(s.duration > 0)) return 'This session has no size or length.'
  return null
}

/** A climb's time, said plainly: to the top, or the clip's length when it did not top out. */
export function clockLabel(s: Session) {
  if (s.toppedOut && s.elapsed != null) return `${s.elapsed.toFixed(2)} s`
  if (s.video?.duration) return `${s.video.duration.toFixed(1)} s clip · no top-out`
  return 'no top-out'
}

export type { LiveAnalysis }
