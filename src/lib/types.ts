// The session model every view reads, and the pipeline's own JSON shapes it is
// built from (github.com/jeremyipark/vision-demos → rock_climbing, rock_climbing_3d).

import type { HoldSighting, MotionTrack } from './motion'

export type LimbKey = 'left_hand' | 'right_hand' | 'left_foot' | 'right_foot'
export type Vec2 = [number, number]

export interface LimbInfo {
  key: LimbKey
  label: 'LH' | 'RH' | 'LF' | 'RF'
  name: string
  color: string
  hand: boolean
  side: -1 | 1
}

// Panel order: hands above feet, left before right — the pipeline's LIMBS.
export const LIMBS: LimbInfo[] = [
  { key: 'left_hand', label: 'LH', name: 'left hand', color: '#22D3EE', hand: true, side: -1 },
  { key: 'right_hand', label: 'RH', name: 'right hand', color: '#6366F1', hand: true, side: 1 },
  { key: 'left_foot', label: 'LF', name: 'left foot', color: '#E879F9', hand: false, side: -1 },
  { key: 'right_foot', label: 'RF', name: 'right foot', color: '#FB7185', hand: false, side: 1 },
]
export const LIMB_BY_KEY = Object.fromEntries(LIMBS.map((l) => [l.key, l])) as Record<LimbKey, LimbInfo>
export const LIMB_BY_LABEL = Object.fromEntries(LIMBS.map((l) => [l.label, l])) as Record<string, LimbInfo>

export const ROUTE_COLORS: Record<string, string> = {
  green: '#4ADE80',
  orange: '#FB923C',
  blue: '#38BDF8',
  yellow: '#FACC15',
  red: '#F87171',
  purple: '#C084FC',
  pink: '#F472B6',
  white: '#F4F4F5',
  black: '#A1A1AA',
}
export const GOLD = '#F5C542'

export interface Hold {
  id: number
  polygon: Vec2[] // canvas-normalized, x and y each in [0, 1]
  bbox: [number, number, number, number]
  center: Vec2
  score?: number
  depth?: number // rock_climbing_3d: meters proud of the wall plane
}

export interface Move {
  step: number
  holdId: number
  limb: LimbKey
  time: number // seconds from the start of the climb
  duration: number // contact seconds
}

export interface LimbUtil {
  seconds: number
  share: number
  coverage: number
  holds: number[]
  sequence: number[]
}

export interface Attempt {
  label: string
  index: number
  sequence: number[]
  elapsed: number | null
  toppedOut: boolean
  isThis: boolean
}

export interface Comparison {
  reference?: string
  shortest?: string | null
  fastest?: string | null
  shared: number[]
  attempts: Attempt[]
}

export interface CoachItem {
  title: string
  detail: string
  time?: number | null
  holds?: number[]
}

export interface CoachFeedback {
  headline: string
  summary: string
  score: number
  scores: { efficiency: number; flow: number; footwork: number; pacing: number }
  strengths: CoachItem[]
  focus: CoachItem[]
  drills: { name: string; how: string; dose?: string }[]
  beta: string
  next_goal: string
  model?: string
  watchedVideo?: boolean
  frames?: number
  generatedAt?: string
  source: 'vlm' | 'on-device'
}

export interface SessionVideo {
  src: string
  webm?: string // VP9 fallback for browsers without H.264
  poster?: string
  offset: number // video seconds at which the climb clock reads 0
  affine?: number[][] // canvas-normalized → video-normalized, 2×3, for a still camera
  motion?: MotionTrack // …or per sampled frame, for a camera that moved
  sightings?: Record<number, HoldSighting[]> // each hold's own SAM outlines, video 0–1
  width?: number
  height?: number
  duration?: number // real seconds of the clip
  overlays?: 'burned-in' | 'none'
  mediaId?: string // server-side copy, for the coach to watch
}

/** The climber as ViTPose+ saw them: per frame, video seconds and COCO-17
 *  keypoints flattened as [x, y, confidence] × 17, video 0–1. */
export interface PoseTrack { t: number[]; k: number[][] }

export interface Check { id: string; label: string; ok: boolean; severity: 'error' | 'warn'; detail: string }

/** Where a live session came from and what was checked before it was opened. */
export interface LiveAnalysis {
  runId: string
  analyzedAt: string
  source: { name: string; duration: number; fps: number; width: number; height: number; frameCount: number; sourceFormat: string; bytes: number }
  analysis: { fps: number; width: number; height: number; frameCount: number; duration: number }
  sam: { model: string; prompt: string; samples: number; tracks: number; detections: number; coords: string; span: [number, number] | null }
  pose: { model: string; framesPosed: number; people: number; coords: string; keypoints: string; span: [number, number] | null }
  reading: import('./analyze').ReadStats
  validation: Check[]
  warnings: string[]
  debug?: string | null
}

export interface Session {
  id: string
  title: string
  climber: string
  gym?: string
  recordedAt?: string
  kind: 'example' | 'import' | 'live'
  credit?: string
  exampleId?: string
  route: { color: string; grade: string; name?: string; prompt?: string }
  label?: string
  fps: number
  canvas: { width: number; height: number }
  holds: Hold[]
  moves: Move[]
  sequence: number[]
  elapsed: number | null
  duration: number
  toppedOut: boolean
  finalHoldId: number | null
  holdsDetected: number
  utilization?: Record<LimbKey, LimbUtil>
  torso?: [number, number, number][] // [t, x, y] canvas-normalized
  comparison?: Comparison
  video?: SessionVideo
  wall?: { src: string; affine: number[][] }
  scale?: { metersPerUnit: number; floorY: number; source: 'estimated' | 'lidar' }
  lidar?: { plyUrl?: string; pointCount?: number; wallAngleDeg?: number; bounds?: { lo: Vec2; span: Vec2 } }
  coach?: CoachFeedback
  models?: { holds?: string; pose?: string }
  usage?: { costUsd?: number }
  pose?: PoseTrack
  analysis?: LiveAnalysis
}

// ── pipeline JSON (what rock_climbing writes to data/output/<stamp>/) ────────

export interface PipelineHold {
  id: number
  bbox: [number, number, number, number]
  polygon?: Vec2[]
  score?: number
  depth?: number
  [k: string]: unknown
}

export interface PipelineMove {
  step: number
  hold_id: number
  limb: LimbKey
  limb_label?: string
  time: number
  contact_seconds: number
}

export interface PipelineClimb {
  route?: { color?: string; grade?: string; name?: string | null; prompt?: string }
  route_color?: string
  prompt?: string
  fps?: number
  holds_detected?: number
  holds_used?: number
  start_frame?: number | null
  completion_frame?: number | null
  final_hold_id?: number | null
  elapsed_seconds?: number | null
  topped_out?: boolean
  order?: number[]
  sequence?: number[]
  moves?: PipelineMove[]
  utilization?: {
    total_contact_seconds?: number
    per_limb?: Record<string, { seconds: number; share_of_contact: number; coverage_of_climb: number; holds: number[]; sequence: number[] }>
  }
  holds?: { hold_id: number; order: number | null; limbs: string; time_start: number | null; time_end: number | null; contact_seconds: number | null }[]
}

export interface PipelineSequence {
  video?: string
  label?: string
  route?: PipelineClimb['route']
  topped_out?: boolean
  elapsed_seconds?: number | null
  holds_detected?: number
  holds_used?: number
  sequence?: number[]
  sequence_aligned?: number[]
  moves?: PipelineMove[]
  per_limb_sequence?: Record<string, number[]>
  comparison?: {
    reference?: string
    shortest?: string | null
    fastest?: string | null
    shared_holds?: number[]
    others?: { label: string; sequence: number[]; holds: number; elapsed_seconds: number | null; topped_out: boolean }[]
  } | null
}

export interface PipelineComparison {
  route?: PipelineClimb['route']
  reference?: string
  shortest?: string | null
  fastest?: string | null
  shared_holds?: number[]
  attempts: {
    label: string
    index: number
    topped_out: boolean
    elapsed_seconds: number | null
    sequence: number[]
    sequence_aligned?: number[]
    limb_sequence?: PipelineMove[]
  }[]
}

export interface ClimbrManifest {
  climbr: number
  id?: string
  title?: string
  climber?: string
  gym?: string
  recorded_at?: string
  credit?: string
  label?: string
  canvas?: { width: number; height: number }
  video?: { src: string; webm?: string; poster?: string; clock_offset?: number; affine?: number[][]; width?: number; height?: number; duration?: number; overlays?: 'burned-in' | 'none' }
  wall?: { src: string; affine: number[][] }
  torso?: [number, number, number][]
  scale?: { meters_per_unit: number; floor_y: number; source?: 'estimated' | 'lidar' }
  models?: { holds?: string; pose?: string }
  files?: Record<string, string>
  coach?: CoachFeedback
}
