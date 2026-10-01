// What the CLIMBR server sends back from a live analysis, after it has checked
// and normalized the gateway's answers (server/vlm.mjs): coordinates in 0–1 of
// the analyzed frame, times in real seconds from the start of the clip. The
// browser checks the shape again before it reads a route from it, so a server
// and a browser from different versions fail loudly instead of reading garbage.

import type { Vec2 } from './types'

export interface Check { name: string; ok: boolean; detail: string }
export interface Envelope { width: number; height: number; fps: number; frames: number; duration: number; hash: string | null }

export interface SamDetection {
  track: number
  frame: number
  t: number
  score: number | null
  bbox: [number, number, number, number]
  polygon: Vec2[] | null
}
export interface SamResult {
  model: string
  envelope: Envelope
  checks: Check[]
  coords: 'normalized' | 'pixels'
  samples: { frame: number; t: number }[]
  detections: SamDetection[]
  tracks: number
  dropped: number
  warnings: string[]
}

export interface Keypoint { name: string; x: number; y: number; confidence: number }
export interface PoseFrame {
  timestamp: number
  frame: number
  track: number
  bbox: [number, number, number, number] | null
  keypoints: Keypoint[]
}
export interface PoseResult {
  model: string
  envelope: Envelope
  checks: Check[]
  coords: 'normalized' | 'pixels'
  keypointNames: string[]
  frames: PoseFrame[]
  framesPosed: number
  people: number
  dropped: number
  warnings: string[]
}

export interface ClipMeta { width: number; height: number; fps: number; duration: number; frameCount: number }
export interface SourceMeta extends ClipMeta {
  name: string
  codec: string
  container: string
  sourceFormat: string
  rotation: number
  hdr: boolean
  hasAudio: boolean
  bytes: number
}

export interface AnalyzeResult {
  type: 'result'
  id: string
  color: string
  prompt: string
  source: SourceMeta
  analysis: ClipMeta
  playback: ClipMeta & { src: string; webm: string | null; poster: string }
  sam: SamResult
  pose: PoseResult
  usage?: { holds?: { cost?: number } | null; pose?: { cost?: number } | null }
  warnings: string[]
  debug: string | null
}

export const COCO17 = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
] as const

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const pos = (v: unknown): v is number => fin(v) && v > 0

/** Throws with a precise message when the server's answer is not what the reader needs. */
export function checkResult(r: any): AnalyzeResult {
  const bad = (what: string) => { throw new Error(`The CLIMBR server's result is malformed: ${what}.`) }
  if (!r || r.type !== 'result') bad('not a result')
  for (const [k, m] of [['source', r.source], ['analysis', r.analysis], ['playback', r.playback]] as const) {
    if (!m) bad(`no ${k} metadata`)
    for (const f of ['width', 'height', 'fps', 'duration', 'frameCount'] as const) if (!pos(m[f])) bad(`${k}.${f} is ${JSON.stringify(m[f])}`)
  }
  if (typeof r.playback.src !== 'string' || !r.playback.src) bad('no playback video')
  const sam = r.sam, pose = r.pose
  if (!sam || !Array.isArray(sam.samples) || !Array.isArray(sam.detections)) bad('SAM 3.1 samples / detections missing')
  if (!sam.samples.length) bad('SAM 3.1 sampled no frames')
  for (const s of sam.samples) if (!Number.isInteger(s?.frame) || !fin(s?.t)) bad('a SAM 3.1 sample without frame / time')
  for (const d of sam.detections) {
    if (!Number.isInteger(d?.track) || !fin(d?.t) || !Array.isArray(d?.bbox) || d.bbox.length !== 4 || !d.bbox.every(fin)) bad('a SAM 3.1 detection without track / time / box')
    if (d.polygon != null && (!Array.isArray(d.polygon) || d.polygon.length < 3 || !d.polygon.every((p: unknown) => Array.isArray(p) && fin(p[0]) && fin(p[1])))) bad('a SAM 3.1 outline that is not a polygon')
  }
  if (!pose || !Array.isArray(pose.frames)) bad('ViTPose+ frames missing')
  for (const f of pose.frames) {
    if (!fin(f?.timestamp) || !Number.isInteger(f?.track) || !Array.isArray(f?.keypoints) || f.keypoints.length !== 17) bad('a ViTPose+ frame without time / track / 17 keypoints')
    for (let j = 0; j < 17; j++) {
      const k = f.keypoints[j]
      if (k?.name !== COCO17[j] || !fin(k.x) || !fin(k.y) || !fin(k.confidence)) bad(`ViTPose+ keypoint ${j} is not COCO-17 ${COCO17[j]} with x, y, confidence`)
    }
  }
  return r as AnalyzeResult
}
