import { Line, OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { AnimatePresence, motion } from 'framer-motion'
import { Crosshair, Orbit, ScanFace, Video } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { buildCloud, wallModel, type Cloud, type WallModel } from '../lib/cloud'
import { holdFill } from '../lib/colors'
import { clamp, easeInOut, pathLength } from '../lib/geometry'
import { finaleSchedule, type Player } from '../lib/player'
import type { Timeline } from '../lib/timeline'
import { GOLD, LIMBS, LIMB_BY_KEY, ROUTE_COLORS, type Session, type Vec2 } from '../lib/types'

type CamMode = 'intro' | 'face' | 'chase' | 'orbit' | 'free'

function useSelect<T>(player: Player, pick: (t: number) => T): T {
  const ref = useRef<{ v: T; key: string } | null>(null)
  return useSyncExternalStore(player.subscribe, () => {
    const v = pick(player.get().t)
    const key = JSON.stringify(v)
    if (!ref.current || ref.current.key !== key) ref.current = { v, key }
    return ref.current.v
  })
}

// Labels live in the DOM, over the canvas, and are moved every frame to where
// their 3D anchor projects — cheaper than a React root per label, and no root
// churn when holds light up.
type Align = 'center' | 'left' | 'right'
class Anchors {
  map = new Map<string, { pos: [number, number, number]; el: HTMLElement | null; align: Align }>()
  set(key: string, pos: [number, number, number], align: Align = 'center') {
    const a = this.map.get(key)
    if (a) { a.pos = pos; a.align = align } else this.map.set(key, { pos, el: null, align })
  }
  bind = (key: string) => (el: HTMLElement | null) => {
    const a = this.map.get(key)
    if (a) a.el = el
    else this.map.set(key, { pos: [0, 0, 0], el, align: 'center' })
  }
}

function Projector({ anchors }: { anchors: Anchors }) {
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera, size }) => {
    for (const a of anchors.map.values()) {
      if (!a.el) continue
      v.set(a.pos[0], a.pos[1], a.pos[2]).project(camera)
      if (v.z > 1 || v.z < -1) { a.el.style.opacity = '0'; continue }
      const x = ((v.x + 1) / 2) * size.width
      const y = ((1 - v.y) / 2) * size.height
      const tx = a.align === 'center' ? '-50%' : a.align === 'right' ? '-100%' : '0%'
      a.el.style.opacity = ''
      a.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(${tx}, -50%)`
    }
  })
  return null
}

export default function Scan3D({ session: s, tl, player, letters }: { session: Session; tl: Timeline; player: Player; letters?: boolean }) {
  const model = useMemo(() => wallModel(s), [s])
  const [cloud, setCloud] = useState<Cloud | null>(null)
  const [mode, setMode] = useState<CamMode>('intro')
  const [, bump] = useState(0)
  useEffect(() => {
    let live = true
    buildCloud(s, model).then((c) => { if (live) { setCloud(c); bump((n) => n + 1) } })
    return () => { live = false }
  }, [s, model])

  const sched = finaleSchedule(tl.climbEnd, s.sequence.length)
  const phase = useSelect(player, (t) => ({
    lit: tl.litAt(t).length,
    finale: s.toppedOut && t >= sched.dimAt ? Math.min(s.sequence.length + 1, Math.max(0, Math.floor((t - sched.firstAt) / sched.step) + 1)) : -1,
    measured: s.toppedOut && t >= sched.measureAt,
    done: s.toppedOut && t >= tl.climbEnd,
    sec: Math.floor(Math.max(0, Math.min(t, tl.climbEnd)) * 20),
  }))
  useEffect(() => { if (phase.finale >= 0 && mode === 'chase') setMode('face') }, [phase.finale, mode])

  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const used = s.holds.filter((h) => s.sequence.includes(h.id))
  const torsoMeters = useMemo(() => {
    const pts = (s.torso ?? []).filter((p) => p[0] >= 0 && p[0] <= tl.climbEnd).map((p) => [p[1], p[2]] as Vec2)
    return pathLength(pts, model.aspect) * model.mpu
  }, [s, tl, model, cloud])
  const finalHold = s.holds.find((h) => h.id === s.finalHoldId)
  const heightM = finalHold ? model.toWorld(finalHold.center)[1] : model.heightM
  const acrossM = finalHold ? Math.max(...used.map((h) => Math.abs(model.toWorld(h.center)[0] - model.toWorld(finalHold.center)[0])), 0) : 0
  const source = cloud?.source
  const clock = Math.max(0, Math.min(player.get().t, tl.climbEnd))
  const seqShown = phase.finale >= 0 ? s.sequence.slice(0, Math.max(0, phase.finale)) : s.sequence.filter((id) => tl.litAt(player.get().t).includes(id))
  const L = (id: number) => tl.label(id, letters)
  const anchors = useMemo(() => new Anchors(), [])

  // Where each hold's labels sit in 3D: id at its top-left, order badge top-right.
  const t = player.get().t
  const lit = new Set(tl.litAt(t))
  const inFinale = phase.finale >= 0
  const holdLabels = s.holds.map((h) => {
    const d = model.holdDepth.get(h.id) ?? 0.05
    anchors.set(`id-${h.id}`, model.toWorld([h.bbox[0], h.bbox[1]], d))
    anchors.set(`ord-${h.id}`, model.toWorld([h.bbox[0] + h.bbox[2], h.bbox[1]], d + 0.02))
    const idx = s.sequence.indexOf(h.id)
    const relit = inFinale && idx >= 0 && idx < phase.finale
    const on = inFinale ? relit : lit.has(h.id)
    return { h, idx, relit, on, used: idx >= 0 }
  })
  const finalW = finalHold ? model.toWorld(finalHold.center) : null
  let measureTags: { key: string; text: string; accent?: boolean; align: Align }[] = []
  if (phase.measured && finalW) {
    const fx = Math.max(...used.map((h) => Math.abs(model.toWorld(h.center)[0] - finalW[0]))) > 0
      ? model.toWorld(used.reduce((a, b) => (Math.abs(model.toWorld(b.center)[0] - finalW[0]) > Math.abs(model.toWorld(a.center)[0] - finalW[0]) ? b : a), finalHold!).center)[0]
      : finalW[0]
    const vx = finalW[0] + 0.28 * Math.sign(finalW[0] - fx || 1)
    const left = vx < finalW[0]
    anchors.set('m-height', [vx + (left ? -0.06 : 0.06), finalW[1] / 2, 0.2], left ? 'right' : 'left')
    anchors.set('m-across', [(fx + vx) / 2, -0.1, 0.3], 'center')
    const tp = (s.torso ?? []).filter((p) => p[0] >= 0)
    const mid = tp[Math.floor(tp.length * 0.42)]
    if (mid) anchors.set('m-torso', model.toWorld([mid[1], mid[2]], 0.34).map((v, i) => (i === 0 ? v + (left ? 0.12 : -0.12) : v)) as [number, number, number], left ? 'left' : 'right')
    measureTags = [
      { key: 'm-height', text: `${heightM.toFixed(2)} m off the ground`, accent: true, align: left ? 'right' : 'left' },
      { key: 'm-across', text: `${acrossM.toFixed(2)} m across`, align: 'center' },
      ...(mid && torsoMeters > 0 ? [{ key: 'm-torso', text: `${torsoMeters.toFixed(2)} m torso traveled`, align: (left ? 'left' : 'right') as Align }] : []),
    ]
  }

  return (
    <div className="scan">
      <Canvas dpr={[1, 2]} camera={{ fov: 34, position: [-3.6, 1.2, 4.2], near: 0.05, far: 60 }} gl={{ antialias: true, preserveDrawingBuffer: true }}>
        <color attach="background" args={['#040506']} />
        <fog attach="fog" args={['#040506', 7, 15]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[2, 5, 6]} intensity={1.2} />
        {cloud && <PointCloud cloud={cloud} height={model.heightM} />}
        <Holds s={s} tl={tl} m={model} player={player} phase={phase} route={route} />
        <Climber s={s} tl={tl} m={model} player={player} sched={sched} />
        {phase.finale >= 0 && <TorsoPath s={s} m={model} tl={tl} step={phase.finale} />}
        {phase.measured && finalHold && <Measures m={model} s={s} />}
        <Rig mode={mode} setMode={setMode} m={model} tl={tl} player={player} />
        <Projector anchors={anchors} />
      </Canvas>

      <div className="labels3d" aria-hidden>
        {holdLabels.map(({ h, idx, relit, on, used }) => {
          const isFinal = h.id === s.finalHoldId
          const color = relit ? holdFill(s, h.id) : phase.done && isFinal ? GOLD : route
          return (
            <span key={h.id}>
              {(!inFinale || used) && (
                <span ref={anchors.bind(`id-${h.id}`)} className={`label3d ${on ? 'on' : ''}`} style={on ? { background: relit ? 'transparent' : color } : undefined}>{L(h.id)}</span>
              )}
              {on && relit && <span ref={anchors.bind(`ord-${h.id}`)} className={`badge3d ${isFinal ? 'gold' : ''}`}>{idx + 1}</span>}
            </span>
          )
        })}
        {measureTags.map((m) => <span key={m.key} ref={anchors.bind(m.key)} className={`tag3d ${m.accent ? 'accent' : ''}`}>{m.text}</span>)}
      </div>

      <div className="scan-hud">
        <div className="scan-title">
          <motion.h2 initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
            {s.sequence.length} holds used <span className="dotsep">·</span> wall {model.angleDeg.toFixed(0)}° {model.angleDeg >= 0 ? 'overhang' : 'slab'}
          </motion.h2>
          <p>
            {source === 'lidar' ? 'reconstructed in 3D from iPhone LiDAR' : source === 'photo' ? 'depth simulated from the 2D clip' : source === 'procedural' ? 'route placed on a modelled wall' : 'reading depth…'}
            {cloud && <span className="muted"> · {cloud.count.toLocaleString()} points</span>}
          </p>
        </div>

        <div className="cam-modes">
          {([['face', <ScanFace key="a" size={14} />, 'Face-on'], ['orbit', <Orbit key="b" size={14} />, 'Orbit'], ['chase', <Video key="c" size={14} />, 'Chase'], ['free', <Crosshair key="d" size={14} />, 'Free']] as const).map(([id, icon, label]) => (
            <button key={id} className={mode === id ? 'on' : ''} onClick={() => setMode(id)}>{icon}{label}</button>
          ))}
        </div>

        <div className="scan-side">
        <div className="scan-metrics">
          {[
            { k: 'Off the ground', v: `${heightM.toFixed(2)} m`, accent: true },
            { k: 'Across', v: `${acrossM.toFixed(2)} m` },
            { k: 'Torso traveled', v: torsoMeters ? `${torsoMeters.toFixed(2)} m` : '—' },
            { k: 'Scale', v: source === 'lidar' ? 'measured' : 'estimated' },
          ].map((x, i) => (
            <motion.div key={x.k} className={`metric ${x.accent ? 'accent' : ''}`} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 + i * 0.08 }}>
              <span>{x.k}</span>
              <b>{x.v}</b>
            </motion.div>
          ))}
        </div>
        <div className="scan-clock">
          <b>{clock.toFixed(2)} s</b>
          <span>{s.climber}</span>
        </div>
        </div>

        <div className="scan-foot">
          <div>
            <div className="legend inline">
              {LIMBS.map((l) => <span key={l.key}><i style={{ background: l.color }} />{l.name}</span>)}
              <span className="muted">blended where limbs shared a hold</span>
            </div>
            <div className="kicker" style={{ marginTop: 10 }}>Sequence</div>
            <div className="scan-seq">
              <AnimatePresence initial={false}>
                {seqShown.map((id, i) => {
                  const f = tl.firstUse.get(id)
                  return (
                    <motion.span key={id} initial={{ opacity: 0, y: 8, scale: 0.6 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} style={{ color: id === s.finalHoldId && phase.done ? GOLD : f ? LIMB_BY_KEY[f.limb].color : '#fff' }}>
                      {i > 0 && <em>›</em>}{L(id)}
                    </motion.span>
                  )
                })}
              </AnimatePresence>
            </div>
          </div>
        </div>

        <motion.div className="scan-badge" initial={false} animate={{ opacity: mode === 'intro' ? 1 : 0, scale: mode === 'intro' ? 1 : 1.06 }} transition={{ duration: 0.5 }}>
          <span className="rec-dot" /> {source === 'lidar' ? 'FUSING LIDAR DEPTH' : 'RECONSTRUCTING WALL'}
        </motion.div>
      </div>
    </div>
  )
}

// ── the cloud, revealed by a scan line sweeping up the wall ──────────────────

const pointVert = /* glsl */ `
  attribute vec3 color;
  uniform float uReveal;
  uniform float uSize;
  uniform float uScale;
  varying vec3 vColor;
  varying float vGlow;
  varying float vShow;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = uReveal - position.y;
    vShow = step(0.0, d);
    vGlow = exp(-abs(d) * 14.0) * vShow;
    vColor = color;
    gl_PointSize = max(1.0, uSize * uScale / -mv.z);
  }
`
const pointFrag = /* glsl */ `
  varying vec3 vColor;
  varying float vGlow;
  varying float vShow;
  void main() {
    if (vShow < 0.5) discard;
    vec3 col = mix(vColor, vec3(0.62, 1.0, 0.86), clamp(vGlow, 0.0, 1.0) * 0.9);
    gl_FragColor = vec4(col, 1.0);
  }
`

function PointCloud({ cloud, height }: { cloud: Cloud; height: number }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(cloud.colors, 3))
    return g
  }, [cloud])
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: pointVert,
    fragmentShader: pointFrag,
    uniforms: { uReveal: { value: -0.2 }, uSize: { value: 0.0125 }, uScale: { value: 600 } },
    fog: false,
  }), [])
  const start = useRef<number | null>(null)
  const line = useRef<THREE.Mesh>(null)
  const { size, camera } = useThree()
  useFrame((st) => {
    if (start.current == null) start.current = st.clock.elapsedTime
    const k = clamp((st.clock.elapsedTime - start.current) / 2.4)
    const reveal = -0.2 + easeInOut(k) * (height + 1.4)
    mat.uniforms.uReveal.value = reveal
    const fov = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180
    mat.uniforms.uScale.value = (size.height * st.viewport.dpr) / (2 * Math.tan(fov / 2)) / st.viewport.dpr
    if (line.current) {
      line.current.position.y = reveal
      ;(line.current.material as THREE.MeshBasicMaterial).opacity = k < 1 ? 0.55 : 0
    }
  })
  return (
    <group>
      <points geometry={geo} material={mat} />
      <mesh ref={line} rotation={[0, 0, 0]} position={[0, 0, 0.15]}>
        <planeGeometry args={[8, 0.012]} />
        <meshBasicMaterial color="#9fffe0" transparent opacity={0.5} />
      </mesh>
    </group>
  )
}

// ── holds ────────────────────────────────────────────────────────────────────

function holdGeometry(points: [number, number, number][]) {
  const shape2 = points.map((p) => new THREE.Vector2(p[0], p[1]))
  const tris = THREE.ShapeUtils.triangulateShape(shape2, [])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3))
  g.setIndex(tris.flat())
  g.computeVertexNormals()
  return g
}

function Holds({ s, tl, m, player, phase, route }: { s: Session; tl: Timeline; m: WallModel; player: Player; phase: { lit: number; finale: number; done: boolean }; route: string }) {
  const t = player.get().t
  const lit = new Set(tl.litAt(t))
  const geoms = useMemo(() => s.holds.map((h) => {
    const d = m.holdDepth.get(h.id) ?? 0.05
    const pts = h.polygon.map((p) => m.toWorld(p, d * 0.62 + 0.004))
    return { h, pts, fill: holdGeometry(pts) }
  }), [s, m, m.mpu, m.aspect, m.centerX, m.floorY])
  return (
    <group>
      {geoms.map(({ h, pts, fill }) => {
        const idx = s.sequence.indexOf(h.id)
        const inFinale = phase.finale >= 0
        const relit = inFinale && idx >= 0 && idx < phase.finale
        const isFinal = h.id === s.finalHoldId
        const on = inFinale ? relit : lit.has(h.id)
        const color = relit ? holdFill(s, h.id) : phase.done && isFinal ? GOLD : route
        const used = idx >= 0
        return (
          <group key={h.id}>
            <Line points={[...pts, pts[0]]} color={on ? (isFinal && (phase.done || relit) ? GOLD : '#ffffff') : used || !inFinale ? route : '#7a7f88'} lineWidth={on ? (isFinal ? 3 : 1.6) : 1.2} transparent opacity={on ? 0.95 : inFinale && !used ? 0.25 : 0.6} />
            {(on || (inFinale && used)) && (
              <mesh geometry={fill}>
                <meshBasicMaterial color={color} transparent opacity={on ? 0.82 : 0.18} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
              </mesh>
            )}
          </group>
        )
      })}
    </group>
  )
}

// ── the climber, in 3D ───────────────────────────────────────────────────────

const BONES: [string, string, string][] = [
  ['ls', 'rs', '#ffffff'], ['lh', 'rh', '#ffffff'], ['ls', 'lh', '#ffffff'], ['rs', 'rh', '#ffffff'],
  ['ls', 'le', LIMB_BY_KEY.left_hand.color], ['le', 'lw', LIMB_BY_KEY.left_hand.color],
  ['rs', 're', LIMB_BY_KEY.right_hand.color], ['re', 'rw', LIMB_BY_KEY.right_hand.color],
  ['lh', 'lk', LIMB_BY_KEY.left_foot.color], ['lk', 'la', LIMB_BY_KEY.left_foot.color],
  ['rh', 'rk', LIMB_BY_KEY.right_foot.color], ['rk', 'ra', LIMB_BY_KEY.right_foot.color],
]

function Climber({ s, tl, m, player, sched }: { s: Session; tl: Timeline; m: WallModel; player: Player; sched: ReturnType<typeof finaleSchedule> }) {
  const lines = useRef<(any | null)[]>([])
  const joints = useRef<THREE.InstancedMesh>(null)
  const torso = useRef<THREE.Mesh>(null)
  const head = useRef<THREE.Mesh>(null)
  const group = useRef<THREE.Group>(null)
  const limbDots = useRef<(THREE.Mesh | null)[]>([])
  const tmp = useMemo(() => new THREE.Object3D(), [])
  useFrame(() => {
    const t = player.get().t
    const T = Math.max(0, Math.min(t, tl.climbEnd))
    const visible = !(s.toppedOut && t >= sched.dimAt)
    if (group.current) group.current.visible = visible
    if (!visible) return
    const sk = tl.skeletonAt(T)
    const off = { torso: 0.34, shoulder: 0.32, hip: 0.3, elbow: 0.22, knee: 0.26, head: 0.4 }
    const P = (p: Vec2, z: number) => m.toWorld(p, z)
    const at = (p: Vec2): number => {
      // A hand or foot sits on its hold's surface.
      let best = 0.05
      for (const l of LIMBS) {
        const st = tl.limbAt(l.key, T)
        if (st.holdId != null && Math.hypot(st.pos[0] - p[0], st.pos[1] - p[1]) < 0.02) best = (m.holdDepth.get(st.holdId) ?? 0.05) * 0.8
      }
      return best
    }
    const J: Record<string, [number, number, number]> = {
      ls: P(sk.shoulders[0], off.shoulder), rs: P(sk.shoulders[1], off.shoulder),
      le: P(sk.elbows[0], off.elbow), re: P(sk.elbows[1], off.elbow),
      lw: P(sk.wrists[0], at(sk.wrists[0])), rw: P(sk.wrists[1], at(sk.wrists[1])),
      lh: P(sk.hips[0], off.hip), rh: P(sk.hips[1], off.hip),
      lk: P(sk.knees[0], off.knee), rk: P(sk.knees[1], off.knee),
      la: P(sk.ankles[0], at(sk.ankles[0])), ra: P(sk.ankles[1], at(sk.ankles[1])),
    }
    BONES.forEach(([a, b], i) => {
      const ln = lines.current[i]
      if (ln?.geometry?.setPositions) ln.geometry.setPositions([...J[a], ...J[b]])
    })
    const names = ['ls', 'rs', 'le', 're', 'lh', 'rh', 'lk', 'rk']
    names.forEach((n, i) => {
      tmp.position.set(...J[n])
      tmp.updateMatrix()
      joints.current?.setMatrixAt(i, tmp.matrix)
    })
    if (joints.current) joints.current.instanceMatrix.needsUpdate = true
    const tp = tl.torsoAt(T) ?? sk.torso
    torso.current?.position.set(...P(tp, off.torso))
    head.current?.position.set(...P(sk.head, off.head))
    LIMBS.forEach((l, i) => {
      const st = tl.limbAt(l.key, T)
      const d = st.holdId != null ? (m.holdDepth.get(st.holdId) ?? 0.05) * 0.9 + 0.02 : 0.12
      limbDots.current[i]?.position.set(...P(st.pos, d))
    })
  })
  return (
    <group ref={group}>
      {BONES.map(([, , color], i) => (
        <Line key={i} ref={(r: any) => { lines.current[i] = r }} points={[[0, 0, 0], [0, 0.01, 0]]} color={color} lineWidth={3.2} transparent opacity={0.92} />
      ))}
      <instancedMesh ref={joints} args={[undefined, undefined, 8]}>
        <sphereGeometry args={[0.022, 12, 12]} />
        <meshBasicMaterial color="#ffffff" />
      </instancedMesh>
      <mesh ref={head}>
        <sphereGeometry args={[0.1, 20, 20]} />
        <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.35} />
      </mesh>
      <mesh ref={torso}>
        <sphereGeometry args={[0.045, 20, 20]} />
        <meshBasicMaterial color="#FF5A5F" toneMapped={false} />
      </mesh>
      {LIMBS.map((l, i) => (
        <mesh key={l.key} ref={(r) => { limbDots.current[i] = r }}>
          <sphereGeometry args={[0.032, 16, 16]} />
          <meshBasicMaterial color={l.color} toneMapped={false} />
        </mesh>
      ))}
    </group>
  )
}

function TorsoPath({ s, m, tl, step }: { s: Session; m: WallModel; tl: Timeline; step: number }) {
  const pts = useMemo(() => (s.torso ?? []).filter((p) => p[0] >= 0 && p[0] <= tl.climbEnd).filter((_, i) => i % 2 === 0).map((p) => m.toWorld([p[1], p[2]], 0.34)), [s, m, tl])
  // Grows with the finale: one stretch of the body's line per hold relit.
  const n = Math.max(2, Math.round(pts.length * clamp(step / Math.max(1, s.sequence.length))))
  if (pts.length < 2) return null
  return (
    <group key={n}>
      <Line points={pts.slice(0, n)} color="#000000" lineWidth={7} transparent opacity={0.28} />
      <Line points={pts.slice(0, n)} color="#ffffff" lineWidth={3.4} dashed dashSize={0.035} gapSize={0.045} />
    </group>
  )
}

function Measures({ m, s }: { m: WallModel; s: Session }) {
  const final = s.holds.find((h) => h.id === s.finalHoldId)!
  const top = m.toWorld(final.center)
  const used = s.holds.filter((h) => s.sequence.includes(h.id))
  const far = used.reduce((a, b) => (Math.abs(m.toWorld(b.center)[0] - top[0]) > Math.abs(m.toWorld(a.center)[0] - top[0]) ? b : a), final)
  const fx = m.toWorld(far.center)[0]
  const vx = top[0] + 0.28 * Math.sign(top[0] - fx || 1)
  const z = 0.2
  return (
    <group>
      <Line points={[[vx, 0, z], [vx, top[1], m.surfaceZ(top[1]) + z]]} color="#E6E1D9" lineWidth={2} dashed dashSize={0.06} gapSize={0.045} />
      <Line points={[[vx - 0.06, top[1], m.surfaceZ(top[1]) + z], [vx + 0.06, top[1], m.surfaceZ(top[1]) + z]]} color="#E6E1D9" lineWidth={2} />
      <Line points={[[fx, 0.004, z], [vx, 0.004, z]]} color="#E6E1D9" lineWidth={2} dashed dashSize={0.06} gapSize={0.045} />
    </group>
  )
}

// ── the camera ───────────────────────────────────────────────────────────────

function Rig({ mode, setMode, m, tl, player }: { mode: CamMode; setMode: (m: CamMode) => void; m: WallModel; tl: Timeline; player: Player }) {
  const controls = useRef<any>(null)
  const { camera } = useThree()
  const start = useRef<number | null>(null)
  const target = useMemo(() => new THREE.Vector3(0, m.heightM * 0.5 + 0.1, 0.1), [m.heightM])
  // Far enough back that the wall, floor to top, fits the 34° lens.
  const dist = Math.max(5.2, ((m.heightM + 1.3) / (2 * Math.tan((17 * Math.PI) / 180))) * 1.02)
  const face = useMemo(() => new THREE.Vector3(0, m.heightM * 0.5 + 0.15, dist), [m.heightM, dist])
  const threeQuarter = useMemo(() => new THREE.Vector3(dist * 0.32, m.heightM * 0.5 + 0.55, dist * 0.95), [m.heightM, dist])
  const want = useMemo(() => ({ pos: new THREE.Vector3(), look: new THREE.Vector3() }), [])
  useEffect(() => { start.current = null }, [mode])
  useFrame((st, dt) => {
    const c = controls.current
    if (!c) return
    if (start.current == null) start.current = st.clock.elapsedTime
    const el = st.clock.elapsedTime - start.current
    c.autoRotate = mode === 'orbit'
    c.autoRotateSpeed = 0.6
    if (mode === 'intro') {
      const k = easeInOut(clamp(el / 3.4))
      const from = new THREE.Vector3(-dist * 0.62, 0.7, dist * 0.55)
      camera.position.lerpVectors(from, threeQuarter, k)
      c.target.copy(target)
      if (k >= 1) setMode('free')
    } else if (mode === 'face') {
      want.pos.copy(face)
      camera.position.lerp(want.pos, 1 - Math.pow(0.02, dt))
      c.target.lerp(target, 1 - Math.pow(0.02, dt))
    } else if (mode === 'chase') {
      const t = Math.max(0, Math.min(player.get().t, tl.climbEnd))
      const tp = tl.torsoAt(t) ?? tl.skeletonAt(t).torso
      const w = m.toWorld(tp, 0.3)
      want.look.set(w[0], w[1] + 0.2, w[2])
      want.pos.set(w[0] + 1.1, w[1] + 0.35, w[2] + 2.3)
      camera.position.lerp(want.pos, 1 - Math.pow(0.08, dt))
      c.target.lerp(want.look, 1 - Math.pow(0.05, dt))
    }
    c.update()
  })
  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} minDistance={1.2} maxDistance={14} onStart={() => { if (mode !== 'orbit' && mode !== 'free') setMode('free') }} />
}
