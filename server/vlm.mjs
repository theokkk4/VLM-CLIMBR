// The strict side of the VLM Run gateway. SAM 3.1 and ViTPose+ responses are
// checked against the shapes CLIMBR relies on and normalized into one form:
// coordinates in 0–1 of the analyzed frame (x right, y down), times in real
// seconds from the start of the clip. A response that does not fit is rejected
// with a message saying what was wrong. Nothing is guessed or filled in.

export const COCO17 = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
]

export class ShapeError extends Error {
  constructor(model, message) {
    super(`${model} returned an unexpected response: ${message}`)
    this.status = 502
  }
}

const num = (v) => typeof v === 'number' && Number.isFinite(v)
const int = (v) => Number.isInteger(v) && v >= 0
const isPt = (p) => Array.isArray(p) && p.length >= 2 && num(p[0]) && num(p[1])
const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every(num) && b[2] >= 0 && b[3] >= 0
const r5 = (v) => Math.round(v * 1e5) / 1e5

/** What the gateway says it decoded, checked against the clip that was sent. */
function envelope(payload, model, expect) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ShapeError(model, 'not a JSON object')
  if (!payload.content || typeof payload.content !== 'object') throw new ShapeError(model, 'no `content` object')
  const env = {
    width: payload.video_width, height: payload.video_height, fps: payload.video_fps,
    frames: payload.video_nframes, duration: payload.video_duration, hash: payload.video_hash ?? null,
  }
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, detail })
  if (expect) {
    check('frame size', env.width === expect.width && env.height === expect.height, `gateway ${env.width}×${env.height}, sent ${expect.width}×${expect.height}`)
    check('frame rate', num(env.fps) && Math.abs(env.fps - expect.fps) < 0.01, `gateway ${env.fps} fps, sent ${expect.fps} fps`)
    check('frame count', int(env.frames) && Math.abs(env.frames - expect.frameCount) <= 1, `gateway ${env.frames} frames, sent ${expect.frameCount}`)
    check('duration', num(env.duration) && Math.abs(env.duration - expect.duration) <= 1.5 / expect.fps, `gateway ${env.duration} s, sent ${expect.duration} s`)
  }
  return { env, checks }
}

/** Normalized 0–1, or pixels of the frame the gateway decoded. A normalized
 *  payload may stray a little past 1 at the frame edge; pixels never stay that small. */
export function coordinateSpace(xs, ys, width, height, model) {
  const maxX = xs.length ? Math.max(...xs) : 0
  const maxY = ys.length ? Math.max(...ys) : 0
  if (maxX <= 1.5 && maxY <= 1.5) return { kind: 'normalized', sx: 1, sy: 1 }
  if (!(num(width) && width > 0 && num(height) && height > 0)) throw new ShapeError(model, 'coordinates are in pixels but the response gives no video_width / video_height to normalize them')
  return { kind: 'pixels', sx: 1 / width, sy: 1 / height }
}

/** frame_id → seconds, from the response's own `frames` list. Checked against
 *  frame_id / fps so a gateway that renumbers frames cannot shift the clock. */
function frameClock(frames, fps, model, warnings) {
  const ts = new Map()
  if (Array.isArray(frames)) {
    for (const f of frames) if (int(f?.frame_id) && num(f?.frame_ts)) ts.set(f.frame_id, f.frame_ts)
  }
  let worst = 0
  for (const [id, t] of ts) worst = Math.max(worst, Math.abs(t - id / fps))
  if (worst > 1 / fps) warnings.push(`${model}: frame_ts differs from frame_id / ${fps} fps by up to ${worst.toFixed(3)} s; using frame_ts.`)
  return (id) => (ts.has(id) ? ts.get(id) : id / fps)
}

/**
 * SAM 3.1 `track` → { samples, detections }. One detection per (track, sampled
 * frame): its score, box and outline. An empty `items` list is a valid answer
 * ("no holds of that colour"), not an error.
 */
export function normalizeSam(payload, expect) {
  const M = 'SAM 3.1'
  const { env, checks } = envelope(payload, M, expect)
  const c = payload.content
  if (c.object !== 'vid.segment.masks') throw new ShapeError(M, `content.object is ${JSON.stringify(c.object)}, expected "vid.segment.masks"`)
  if (!Array.isArray(c.items)) throw new ShapeError(M, 'content.items is not a list')
  if (!Array.isArray(c.frames) || !c.frames.length) throw new ShapeError(M, 'content.frames is missing, so the sampled frames are unknown')
  const warnings = []
  const fps = num(env.fps) && env.fps > 0 ? env.fps : expect.fps
  const clock = frameClock(c.frames, fps, M, warnings)
  const samples = c.frames.filter((f) => int(f?.frame_id)).map((f) => ({ frame: f.frame_id, t: r5(clock(f.frame_id)) })).sort((a, b) => a.frame - b.frame)

  const good = c.items.filter((it) => int(it?.track_id) && int(it?.frame_id) && isBox(it?.bbox_xywh))
  const dropped = c.items.length - good.length
  if (c.items.length && !good.length) throw new ShapeError(M, `none of its ${c.items.length} items has a track_id, frame_id and bbox_xywh`)
  const xs = [], ys = []
  for (const it of good) {
    const [x, y, w, h] = it.bbox_xywh
    xs.push(x + w); ys.push(y + h)
    for (const ring of it.polys_xy ?? []) if (Array.isArray(ring)) for (const p of ring) if (isPt(p)) { xs.push(p[0]); ys.push(p[1]) }
  }
  const space = coordinateSpace(xs, ys, env.width, env.height, M)
  const detections = good.map((it) => {
    const [x, y, w, h] = it.bbox_xywh
    const rings = (Array.isArray(it.polys_xy) ? it.polys_xy : []).filter((r) => Array.isArray(r) && r.length >= 3 && r.every(isPt))
    // A mask can come back as several pieces; the outline is the largest.
    const ring = rings.length ? rings.reduce((a, b) => (ringArea(b) > ringArea(a) ? b : a)) : null
    return {
      track: it.track_id,
      frame: it.frame_id,
      t: r5(clock(it.frame_id)),
      score: num(it.score) ? it.score : null,
      bbox: [r5(x * space.sx), r5(y * space.sy), r5(w * space.sx), r5(h * space.sy)],
      polygon: ring ? ring.map((p) => [r5(p[0] * space.sx), r5(p[1] * space.sy)]) : null,
    }
  }).sort((a, b) => a.frame - b.frame || a.track - b.track)
  if (dropped) warnings.push(`${M}: dropped ${dropped} malformed item${dropped > 1 ? 's' : ''}.`)
  const tracks = new Set(detections.map((d) => d.track)).size
  return { model: M, envelope: env, checks, coords: space.kind, samples, detections, tracks, dropped, warnings }
}

/**
 * ViTPose+ `pose` → one entry per (frame, person): COCO-17 keypoints as
 * {name, x, y, confidence}. Keypoint order comes from kpts_labels when the
 * response has them, and must be COCO-17 either way.
 */
export function normalizePose(payload, expect) {
  const M = 'ViTPose+'
  const { env, checks } = envelope(payload, M, expect)
  const c = payload.content
  if (c.object !== 'vid.pose.kpts') throw new ShapeError(M, `content.object is ${JSON.stringify(c.object)}, expected "vid.pose.kpts"`)
  if (!Array.isArray(c.items)) throw new ShapeError(M, 'content.items is not a list')
  const warnings = []
  let order = COCO17.map((_, i) => i)
  if (Array.isArray(c.kpts_labels)) {
    const missing = COCO17.filter((n) => !c.kpts_labels.includes(n))
    if (missing.length) throw new ShapeError(M, `kpts_labels is not COCO-17 (missing ${missing.join(', ')})`)
    order = COCO17.map((n) => c.kpts_labels.indexOf(n))
  } else warnings.push(`${M}: no kpts_labels in the response; reading keypoints in COCO-17 order.`)
  const need = Math.max(...order) + 1

  const fps = num(env.fps) && env.fps > 0 ? env.fps : expect.fps
  const clock = frameClock(c.frames, fps, M, warnings)
  const good = c.items.filter((it) => int(it?.frame_id) && Array.isArray(it?.kpts_xy) && it.kpts_xy.length >= need && order.every((k) => isPt(it.kpts_xy[k])) &&
    Array.isArray(it?.kpts_score) && it.kpts_score.length >= need && order.every((k) => num(it.kpts_score[k])))
  const dropped = c.items.length - good.length
  if (c.items.length && !good.length) throw new ShapeError(M, `none of its ${c.items.length} items has a frame_id plus 17 keypoints and 17 scores`)
  const xs = [], ys = []
  for (const it of good) for (const k of order) { xs.push(it.kpts_xy[k][0]); ys.push(it.kpts_xy[k][1]) }
  const space = coordinateSpace(xs, ys, env.width, env.height, M)
  const frames = good.map((it) => ({
    timestamp: r5(clock(it.frame_id)),
    frame: it.frame_id,
    track: int(it.track_id) ? it.track_id : 0,
    bbox: isBox(it.bbox_xywh) ? it.bbox_xywh.map((v, i) => r5(v * (i % 2 ? space.sy : space.sx))) : null,
    keypoints: COCO17.map((name, j) => {
      const k = order[j]
      return { name, x: r5(it.kpts_xy[k][0] * space.sx), y: r5(it.kpts_xy[k][1] * space.sy), confidence: Math.round(it.kpts_score[k] * 1e4) / 1e4 }
    }),
  })).sort((a, b) => a.frame - b.frame || a.track - b.track)
  if (dropped) warnings.push(`${M}: dropped ${dropped} malformed item${dropped > 1 ? 's' : ''}.`)
  const framesPosed = new Set(frames.map((f) => f.frame)).size
  const people = new Set(frames.map((f) => f.track)).size
  return { model: M, envelope: env, checks, coords: space.kind, keypointNames: COCO17, frames, framesPosed, people, dropped, warnings }
}

function ringArea(ring) {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1])
  return Math.abs(a / 2)
}
