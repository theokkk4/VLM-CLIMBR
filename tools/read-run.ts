// Run the browser's route reader in Node against saved gateway output.
//   · a live run's folder (.climbr/runs/<id>, written by the dev server), or
//   · a pair of raw gateway responses, normalized here exactly as the server does
// Build: npx rolldown tools/read-run.ts -p node -f esm -o .climbr/read-run.mjs
// Then:  node .climbr/read-run.mjs run <dir>  |  result <result.json>  |  raw <sam.json> <pose.json> [climb.json]
import fs from 'node:fs'
import { readRoute } from '../src/lib/analyze'
import { sessionFromLive } from '../src/lib/live'
// @ts-ignore — plain JS module shared with the server
import { normalizePose, normalizeSam } from '../server/vlm.mjs'

const [mode, a, b, c] = process.argv.slice(2)
let sam: any, pose: any, frame: any, color = 'green'
if (mode === 'result') {
  // A saved {type:"result"} event, as /api/analyze streams it.
  const res = JSON.parse(fs.readFileSync(a, 'utf8'))
  sam = res.sam
  pose = res.pose
  frame = { width: res.analysis.width, height: res.analysis.height, duration: res.analysis.duration }
} else if (mode === 'run') {
  sam = JSON.parse(fs.readFileSync(`${a}/sam.json`, 'utf8'))
  pose = JSON.parse(fs.readFileSync(`${a}/pose.json`, 'utf8'))
  const run = JSON.parse(fs.readFileSync(`${a}/run.json`, 'utf8'))
  frame = { width: run.analysis.width, height: run.analysis.height, duration: run.analysis.duration }
} else {
  const rs = JSON.parse(fs.readFileSync(a, 'utf8')), rp = JSON.parse(fs.readFileSync(b, 'utf8'))
  const expect = { width: rs.video_width, height: rs.video_height, fps: rs.video_fps, frameCount: rs.video_nframes, duration: rs.video_duration }
  sam = normalizeSam(rs, expect)
  pose = normalizePose(rp, expect)
  frame = { width: expect.width, height: expect.height, duration: expect.duration }
}
const t0 = performance.now()
const r = readRoute({ sam, pose, frame, color })
const ms = performance.now() - t0
const out = { ms: Math.round(ms), outcome: r.outcome, stats: r.stats, canvas: r.canvas, start: r.start, end: r.end, warnings: r.warnings,
  holds: r.holds.map((h) => ({ id: h.id, track: (h.tracks as number[])[0], c: [h.bbox[0] + h.bbox[2] / 2, h.bbox[1] + h.bbox[3] / 2].map((v) => +v.toFixed(3)), h: +h.bbox[3].toFixed(3) })),
  sequence: r.climb.sequence, elapsed: r.climb.elapsed_seconds,
  moves: r.climb.moves!.map((m) => `${m.limb_label}→${m.hold_id}@${m.time.toFixed(2)}+${m.contact_seconds.toFixed(2)}`),
  perLimb: Object.fromEntries(Object.entries(r.climb.utilization!.per_limb!).map(([k, v]) => [k, { seq: v.sequence, cover: v.coverage_of_climb, share: v.share_of_contact }])),
  motionSamples: r.motion?.t.length ?? 0, torso: r.torso.length, poseFrames: r.pose.t.length }
console.log(JSON.stringify(out, null, 1))
if (c) {
  const ref = JSON.parse(fs.readFileSync(c, 'utf8'))
  console.log('PIPELINE sequence', JSON.stringify(ref.sequence), 'elapsed', ref.elapsed_seconds, 'holds_detected', ref.holds_detected)
  console.log('PIPELINE per limb', JSON.stringify(Object.fromEntries(Object.entries(ref.utilization.per_limb).map(([k, v]: any) => [k, { seq: v.sequence, cover: v.coverage_of_climb, share: v.share_of_contact }]))))
}
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(r))

// The rest of the browser's chain for a live run: session + validation.
if (mode === 'run') {
  const run = JSON.parse(fs.readFileSync(`${a}/run.json`, 'utf8'))
  const result: any = { type: 'result', id: run.id, color, prompt: `${color} climbing hold`, source: run.source, analysis: run.analysis,
    playback: { ...run.playback, src: `/api/media/${run.id}/play.mp4`, webm: null, poster: `/api/media/${run.id}/poster.jpg` }, sam, pose, usage: {}, warnings: run.warnings ?? [], debug: null }
  const s = sessionFromLive(result, r, { color, grade: 'V2' }, { src: result.playback.src, poster: result.playback.poster })
  console.log('SESSION', JSON.stringify({ duration: s.duration, elapsed: s.elapsed, offset: s.video!.offset, videoDuration: s.video!.duration, canvas: s.canvas, holds: s.holds.length, moves: s.moves.length, sequence: s.sequence, toppedOut: s.toppedOut, finalHold: s.finalHoldId, pose: s.pose!.t.length, motion: s.video!.motion?.t.length ?? 0, bytes: JSON.stringify(s).length }))
  for (const c of s.analysis!.validation) console.log(c.ok ? ' ok ' : c.severity === 'error' ? 'FAIL' : 'warn', c.label.padEnd(40), c.detail)
}
