import { useId, useMemo, useState } from 'react'
import { clamp, easeOut, invertAffine, pathLength, polygonPath, smoothPath } from '../lib/geometry'
import { holdFill } from '../lib/colors'
import { finaleSchedule } from '../lib/player'
import type { Timeline } from '../lib/timeline'
import { GOLD, LIMBS, LIMB_BY_KEY, ROUTE_COLORS, type Session, type Vec2 } from '../lib/types'
import { useSize } from '../lib/useSize'

const U = 1000

interface Props {
  session: Session
  tl: Timeline
  t: number
  letters?: boolean
  backdrop?: boolean
  skeleton?: boolean
  finale?: boolean
  highlight?: number[]
  onSeek?: (t: number) => void
}

export function RoutePanel({ session: s, tl, t, letters = false, backdrop = false, skeleton = true, finale = true, highlight = [], onSeek }: Props) {
  const [ref, size] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const uid = `rp${useId().replace(/:/g, '')}`
  const aspect = tl.aspect
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const X = (p: Vec2): Vec2 => [p[0] * aspect * U, p[1] * U]

  // Frame the holds and the climber's path, with room for labels and the floor.
  const view = useMemo(() => {
    const pts: Vec2[] = s.holds.flatMap((h) => h.polygon.map(X))
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const floorY = s.scale ? s.scale.floorY * U : y1 + 40
    y1 = Math.max(y1, floorY)
    const pad = Math.max(x1 - x0, y1 - y0) * 0.1 + 30
    x0 -= pad * 1.4; x1 += pad * 1.4; y0 -= pad; y1 += pad * 0.6
    const w = x1 - x0, h = y1 - y0
    // Fill the panel's own aspect so nothing letterboxes awkwardly.
    const want = size.width && size.height ? size.width / size.height : w / h
    if (w / h < want) { const nw = h * want; x0 -= (nw - w) / 2; x1 = x0 + nw }
    else { const nh = w / want; y0 -= (nh - h) / 2; y1 = y0 + nh }
    return { x0, y0, w: x1 - x0, h: y1 - y0, floorY }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, size.width, size.height, aspect])

  const px = size.height ? view.h / size.height : 1 // viewBox units per screen pixel
  const fs = 12 * px

  const climbEnd = tl.climbEnd
  const sched = finaleSchedule(climbEnd, s.sequence.length)
  const inFinale = finale && s.toppedOut && t >= sched.dimAt
  const lit = new Set(tl.litAt(t))
  const done = s.toppedOut && t >= climbEnd

  const wallXform = useMemo(() => {
    if (!s.wall) return null
    const m = invertAffine(s.wall.affine)
    return `matrix(${aspect * U * m[0][0]} ${U * m[1][0]} ${aspect * U * m[0][1]} ${U * m[1][1]} ${aspect * U * m[0][2]} ${U * m[1][2]})`
  }, [s.wall, aspect])

  const torsoPts = useMemo(() => (s.torso ?? []).filter((p) => p[0] >= 0 && p[0] <= climbEnd), [s.torso, climbEnd])
  const torsoMeters = useMemo(() => (s.scale ? pathLength(torsoPts.map((p) => [p[1], p[2]] as Vec2), aspect) * s.scale.metersPerUnit : 0), [torsoPts, aspect, s.scale])

  const finalHold = s.holds.find((h) => h.id === s.finalHoldId)

  // ── holds ──
  const holdEls = s.holds.map((h) => {
    const d = polygonPath(h.polygon, X)
    const isLit = lit.has(h.id)
    const isFinal = h.id === s.finalHoldId
    const label = tl.label(h.id, letters)
    const [lx, ly] = X([h.bbox[0], h.bbox[1]])
    const hi = highlight.includes(h.id) || hover === h.id
    let fill = 'transparent', fillOpacity = 0, stroke = 'rgba(255,255,255,0.28)', strokeW = 1.4 * px, flashKey: string | null = null
    let badge: 'route' | 'order' | 'none' = 'none'
    let orderIdx = -1
    if (inFinale) {
      orderIdx = s.sequence.indexOf(h.id)
      if (orderIdx >= 0) {
        const at = sched.firstAt + orderIdx * sched.step
        if (t >= at) {
          fill = holdFill(s, h.id)
          fillOpacity = 0.9
          stroke = isFinal ? GOLD : 'rgba(255,255,255,0.7)'
          strokeW = (isFinal ? 3.2 : 1.4) * px
          flashKey = `f-${h.id}`
          badge = 'order'
        } else {
          const k = clamp((t - sched.dimAt) / 0.4)
          fill = route
          fillOpacity = 0.85 - k * 0.65
          stroke = 'rgba(255,255,255,0.25)'
        }
      }
    } else if (isLit) {
      fill = done && isFinal ? GOLD : route
      fillOpacity = 0.86
      stroke = done && isFinal ? '#fff3c4' : 'rgba(255,255,255,0.0)'
      flashKey = `l-${h.id}`
      badge = 'route'
    }
    if (hi) { stroke = '#ffffff'; strokeW = 2.4 * px }
    const glow = fillOpacity > 0.5 ? `url(#${uid}-glow)` : undefined
    return (
      <g key={h.id} className="hold" onMouseEnter={() => setHover(h.id)} onMouseLeave={() => setHover(null)} onClick={() => { const f = tl.firstUse.get(h.id); if (f && onSeek) onSeek(f.time) }}>
        <path d={d} fill={fill} fillOpacity={fillOpacity} stroke={stroke} strokeWidth={strokeW} filter={glow} style={{ transition: 'fill-opacity .25s, stroke .25s' }} />
        {flashKey && <path key={flashKey} d={d} className="hold-flash" fill="none" stroke={badge === 'order' ? holdFill(s, h.id) : route} strokeWidth={5 * px} style={{ transformOrigin: `${X(h.center)[0]}px ${X(h.center)[1]}px` }} />}
        {badge === 'route' && (
          <g transform={`translate(${lx - 4 * px},${ly - 6 * px})`}>
            <rect x={-fs * 0.95} y={-fs * 1.25} width={fs * (label.length > 1 ? 1.75 : 1.3)} height={fs * 1.3} rx={2 * px} fill={done && isFinal ? GOLD : route} />
            <text x={-fs * 0.95 + (fs * (label.length > 1 ? 1.75 : 1.3)) / 2} y={-fs * 0.22} fontSize={fs} textAnchor="middle" className="hold-label dark">{label}</text>
          </g>
        )}
        {badge === 'none' && !inFinale && (
          <text x={lx - 2 * px} y={ly - 5 * px} fontSize={fs * 0.95} textAnchor="end" className="hold-label dim">{label}</text>
        )}
        {badge === 'order' && (() => {
          const [bx, by] = X([h.bbox[0] + h.bbox[2], h.bbox[1]])
          return (
            <g className="pop-in" style={{ transformOrigin: `${bx}px ${by}px` }}>
              <circle cx={bx} cy={by} r={fs * 0.95} fill={isFinal ? GOLD : '#fff'} />
              <text x={bx} y={by + fs * 0.36} fontSize={fs * 1.02} textAnchor="middle" className="hold-label dark">{orderIdx + 1}</text>
              <text x={X(h.center)[0]} y={X(h.center)[1] + fs * 0.36} fontSize={fs * 0.95} textAnchor="middle" className="hold-label onfill">{label}</text>
            </g>
          )
        })()}
      </g>
    )
  })

  // ── climber ──
  const showClimber = !inFinale
  const sk = skeleton && showClimber ? tl.skeletonAt(Math.min(t, climbEnd)) : null
  const torso = tl.torsoAt(Math.min(Math.max(t, 0), climbEnd + 0.5)) ?? sk?.torso ?? null
  const trail = useMemo(() => {
    if (!torsoPts.length) return [] as Vec2[]
    const from = t - 1.6
    return torsoPts.filter((p) => p[0] >= from && p[0] <= t).map((p) => [p[1], p[2]] as Vec2)
  }, [torsoPts, t])

  // ── finale: the path grows, then the measurements ──
  const grow = inFinale ? clamp((t - sched.firstAt) / (sched.measureAt - sched.firstAt)) : 0
  const pathD = useMemo(() => smoothPath(torsoPts.filter((_, i) => i % 3 === 0).map((p) => [p[1], p[2]] as Vec2), X), [torsoPts, aspect])
  const measure = inFinale ? clamp((t - sched.measureAt) / 0.9) : 0

  const meters = useMemo(() => {
    if (!s.scale || !finalHold) return null
    const used = s.holds.filter((h) => s.sequence.includes(h.id))
    const topY = finalHold.bbox[1]
    const fx = finalHold.center[0]
    const far = used.reduce((a, b) => (Math.abs(b.center[0] - fx) > Math.abs(a.center[0] - fx) ? b : a), finalHold)
    const height = (s.scale.floorY - finalHold.center[1]) * s.scale.metersPerUnit
    const across = Math.abs(far.center[0] - fx) * aspect * s.scale.metersPerUnit
    return { topY, fx, farX: far.center[0], height, across }
  }, [s, finalHold, aspect])

  const hoverHold = hover != null ? s.holds.find((h) => h.id === hover) : null
  const hoverUse = hover != null ? tl.firstUse.get(hover) : undefined

  return (
    <div className="route-panel" ref={ref}>
      {size.width > 0 && (
        <svg className="layer-static" viewBox={`${view.x0} ${view.y0} ${view.w} ${view.h}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
          <defs>
            <radialGradient id={`${uid}-vignette`} cx="50%" cy="45%" r="70%">
              <stop offset="0.6" stopColor="#000" stopOpacity="0" />
              <stop offset="1" stopColor="#000" stopOpacity="0.85" />
            </radialGradient>
          </defs>
          {backdrop && s.wall && wallXform && (
            <g className="backdrop">
              {/* Feathered on all four edges with two gradient masks — no filters,
                  which some GPUs and Chrome builds drop on transformed content. */}
              <linearGradient id={`${uid}-fx`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="#fff" stopOpacity="0" />
                <stop offset="0.12" stopColor="#fff" stopOpacity="1" />
                <stop offset="0.88" stopColor="#fff" stopOpacity="1" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={`${uid}-fy`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#fff" stopOpacity="0" />
                <stop offset="0.1" stopColor="#fff" stopOpacity="1" />
                <stop offset="0.9" stopColor="#fff" stopOpacity="1" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
              <mask id={`${uid}-mx`} maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill={`url(#${uid}-fx)`} /></mask>
              <mask id={`${uid}-my`} maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill={`url(#${uid}-fy)`} /></mask>
              <g mask={`url(#${uid}-my)`}>
                <image href={s.wall.src} x={0} y={0} width={1} height={1} preserveAspectRatio="none" transform={wallXform} opacity={0.5} mask={`url(#${uid}-mx)`} />
              </g>
              <rect x={view.x0} y={view.y0} width={view.w} height={view.h} fill={`url(#${uid}-vignette)`} />
            </g>
          )}

          {/* floor */}
          {s.scale && (
            <g opacity={0.5}>
              <line x1={view.x0} x2={view.x0 + view.w} y1={view.floorY} y2={view.floorY} stroke="rgba(255,255,255,0.18)" strokeWidth={px} strokeDasharray={`${4 * px} ${6 * px}`} />
              <text x={view.x0 + 14 * px} y={view.floorY - 6 * px} fontSize={fs * 0.8} className="hold-label dim">FLOOR</text>
            </g>
          )}

        </svg>
      )}
      {size.width > 0 && (
        <svg className="layer-live" viewBox={`${view.x0} ${view.y0} ${view.w} ${view.h}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id={`${uid}-glow`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation={6 * px} result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id={`${uid}-soft`} x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation={4 * px} />
            </filter>
          </defs>

          {/* the line the body took, drawn as the finale grows it */}
          {inFinale && pathD && (
            <>
              <mask id={`${uid}-grow-mask`} maskUnits="userSpaceOnUse" x={view.x0} y={view.y0} width={view.w} height={view.h}>
                <path d={pathD} fill="none" stroke="#fff" strokeWidth={14 * px} pathLength={1} strokeDasharray={`${grow} 1`} />
              </mask>
              <path d={pathD} fill="none" stroke="#fff" strokeOpacity={0.9} strokeWidth={2.8 * px} strokeLinecap="round" strokeDasharray={`${0.1 * px} ${7 * px}`} mask={`url(#${uid}-grow-mask)`} />
            </>
          )}

          {holdEls}

          {/* limbs on the wall */}
          {showClimber && sk && (
            <g className="skeleton">
              {(() => {
                const P = (p: Vec2) => X(p)
                const seg = (a: Vec2, b: Vec2, color: string, w = 2.4) => {
                  const [x1, y1] = P(a), [x2, y2] = P(b)
                  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={w * px} strokeLinecap="round" />
                }
                const L = LIMB_BY_KEY
                return (
                  <>
                    {seg(sk.shoulders[0], sk.shoulders[1], 'rgba(255,255,255,0.75)')}
                    {seg(sk.hips[0], sk.hips[1], 'rgba(255,255,255,0.75)')}
                    {seg(sk.shoulders[0], sk.hips[0], 'rgba(255,255,255,0.75)')}
                    {seg(sk.shoulders[1], sk.hips[1], 'rgba(255,255,255,0.75)')}
                    {seg(sk.neck, [(sk.shoulders[0][0] + sk.shoulders[1][0]) / 2, (sk.shoulders[0][1] + sk.shoulders[1][1]) / 2], 'rgba(255,255,255,0.6)')}
                    {seg(sk.shoulders[0], sk.elbows[0], L.left_hand.color)}
                    {seg(sk.elbows[0], sk.wrists[0], L.left_hand.color)}
                    {seg(sk.shoulders[1], sk.elbows[1], L.right_hand.color)}
                    {seg(sk.elbows[1], sk.wrists[1], L.right_hand.color)}
                    {seg(sk.hips[0], sk.knees[0], L.left_foot.color)}
                    {seg(sk.knees[0], sk.ankles[0], L.left_foot.color)}
                    {seg(sk.hips[1], sk.knees[1], L.right_foot.color)}
                    {seg(sk.knees[1], sk.ankles[1], L.right_foot.color)}
                    <circle cx={P(sk.head)[0]} cy={P(sk.head)[1]} r={9 * px} fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth={2 * px} />
                    {[...sk.shoulders, ...sk.elbows, ...sk.hips, ...sk.knees].map((j, i) => (
                      <circle key={i} cx={P(j)[0]} cy={P(j)[1]} r={2.6 * px} fill="#fff" />
                    ))}
                  </>
                )
              })()}
            </g>
          )}

          {showClimber && trail.length > 1 && (
            <g>
              {trail.slice(1).map((p, i) => {
                const a = X(trail[i]), b = X(p)
                return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#FF5A5F" strokeOpacity={(i / trail.length) * 0.8} strokeWidth={2.4 * px} strokeLinecap="round" />
              })}
            </g>
          )}
          {showClimber && torso && (
            <g>
              <circle cx={X(torso)[0]} cy={X(torso)[1]} r={11 * px} fill="#FF5A5F" opacity={0.35} filter={`url(#${uid}-soft)`} />
              <circle cx={X(torso)[0]} cy={X(torso)[1]} r={5 * px} fill="#FF5A5F" stroke="#fff" strokeWidth={1.4 * px} />
            </g>
          )}

          {showClimber && LIMBS.map((l) => {
            const st = tl.limbAt(l.key, Math.min(Math.max(t, 0), climbEnd))
            const [x, y] = X(st.pos)
            return (
              <g key={l.key}>
                {st.moving && <circle cx={x} cy={y} r={11 * px} fill={l.color} opacity={0.25} filter={`url(#${uid}-soft)`} />}
                <circle cx={x} cy={y} r={(st.moving ? 5.4 : 4.6) * px} fill={l.color} stroke="#0a0b0d" strokeWidth={1.4 * px} />
              </g>
            )
          })}

          {/* measurements, as the LiDAR finale draws them */}
          {inFinale && meters && measure > 0 && (() => {
            const ease = easeOut(measure)
            const [fx] = X([meters.fx, 0])
            const [farX] = X([meters.farX, 0])
            const topY = X([0, meters.topY])[1]
            const floorY = view.floorY
            const vx = fx + 46 * px * Math.sign(fx - farX || 1)
            const y2 = floorY - (floorY - topY) * ease
            const hx = farX + (vx - farX) * ease
            return (
              <g className="measure">
                <line x1={vx} y1={floorY} x2={vx} y2={y2} stroke="#E6E1D9" strokeWidth={2 * px} strokeDasharray={`${7 * px} ${5 * px}`} />
                <line x1={vx - 8 * px} x2={vx + 8 * px} y1={topY} y2={topY} stroke="#E6E1D9" strokeWidth={2 * px} opacity={ease} />
                <line x1={farX} y1={floorY} x2={hx} y2={floorY} stroke="#E6E1D9" strokeWidth={2 * px} strokeDasharray={`${7 * px} ${5 * px}`} />
                <line x1={farX} x2={farX} y1={floorY - 8 * px} y2={floorY + 8 * px} stroke="#E6E1D9" strokeWidth={2 * px} opacity={ease} />
                <rect x={vx - 6 * px} y={floorY - 6 * px} width={12 * px} height={12 * px} fill="none" stroke="#E6E1D9" strokeWidth={1.5 * px} opacity={ease} />
                <g opacity={clamp((measure - 0.5) * 2)}>
                  {/* Labels sit outside the dimension line, away from the climb. */}
                  {vx < fx
                    ? <MeterTag x={vx - 12 * px} y={(floorY + topY) / 2} px={px} text={`${meters.height.toFixed(2)} m off the ground`} accent right />
                    : <MeterTag x={vx + 12 * px} y={(floorY + topY) / 2} px={px} text={`${meters.height.toFixed(2)} m off the ground`} accent />}
                  <MeterTag x={(farX + vx) / 2} y={floorY + 22 * px} px={px} text={`${meters.across.toFixed(2)} m across`} center />
                  {torsoMeters > 0 && torsoPts.length > 4 && (() => {
                    const mid = torsoPts[Math.floor(torsoPts.length * 0.42)]
                    const [mx, my] = X([mid[1], mid[2]])
                    return vx < fx
                      ? <MeterTag x={mx + 18 * px} y={my} px={px} text={`${torsoMeters.toFixed(2)} m torso traveled`} />
                      : <MeterTag x={mx - 18 * px} y={my} px={px} text={`${torsoMeters.toFixed(2)} m torso traveled`} right />
                  })()}
                </g>
              </g>
            )
          })()}
        </svg>
      )}
      {hoverHold && (
        <div className="hold-tip">
          <strong>Hold {tl.label(hoverHold.id, letters)}</strong>
          {hoverUse ? (
            <span>
              #{s.sequence.indexOf(hoverHold.id) + 1} · first used {hoverUse.time.toFixed(2)} s by {LIMB_BY_KEY[hoverUse.limb].name}
              <em>{(tl.holdLimbs.get(hoverHold.id) ?? []).map((k) => LIMB_BY_KEY[k].label).join(' + ')}</em>
            </span>
          ) : (
            <span>not used{hoverHold.score ? ` · SAM score ${hoverHold.score.toFixed(2)}` : ''}</span>
          )}
        </div>
      )}
    </div>
  )
}

function MeterTag({ x, y, px, text, accent, center, right }: { x: number; y: number; px: number; text: string; accent?: boolean; center?: boolean; right?: boolean }) {
  const fs = 13 * px
  const w = text.length * fs * 0.56 + 14 * px
  const left = center ? x - w / 2 : right ? x - w : x
  return (
    <g>
      <rect x={left} y={y - fs * 0.95} width={w} height={fs * 1.6} rx={4 * px} fill="rgba(10,11,13,0.82)" stroke="rgba(255,255,255,0.12)" strokeWidth={px} />
      <text x={left + 7 * px} y={y + fs * 0.12} fontSize={fs} className={`meter-text ${accent ? 'accent' : ''}`}>{text}</text>
    </g>
  )
}
