import { Bone, Image as ImageIcon, Pause, Play, RotateCcw, Type } from 'lucide-react'
import { useRef } from 'react'
import type { Player, PlayerState } from '../lib/player'
import type { Timeline } from '../lib/timeline'
import { GOLD, LIMBS, ROUTE_COLORS, type Session } from '../lib/types'

export interface ViewOpts { skeleton: boolean; backdrop: boolean; letters: boolean }

export function TimelineBar({ session: s, tl, player, ps, opts, setOpts }: { session: Session; tl: Timeline; player: Player; ps: PlayerState; opts: ViewOpts; setOpts: (o: ViewOpts) => void }) {
  const track = useRef<HTMLDivElement>(null)
  const span = player.end - player.start
  const pct = (t: number) => ((t - player.start) / span) * 100
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green

  const seekFrom = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    player.seek(player.start + ((clientX - r.left) / r.width) * span)
  }
  const onDown = (e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
    seekFrom(e.clientX)
  }
  const onMove = (e: React.PointerEvent) => {
    if (e.buttons & 1) seekFrom(e.clientX)
  }

  const shown = Math.max(0, Math.min(ps.t, tl.climbEnd))
  return (
    <div className="timeline">
      <div className="transport">
        <button className="play" onClick={() => player.toggle()} aria-label={ps.playing ? 'Pause' : 'Play'}>
          {ps.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}
        </button>
        <div className="tc">
          <span className="tc-now">{shown.toFixed(2)}</span>
          <span className="tc-sep">/</span>
          <span className="tc-total">{tl.climbEnd.toFixed(2)} s</span>
        </div>
        <div className="speeds">
          {[0.25, 0.5, 1, 2].map((r) => (
            <button key={r} className={ps.rate === r ? 'on' : ''} onClick={() => player.setRate(r)}>{r}×</button>
          ))}
        </div>
        <div className="flex1" />
        <div className="toggles">
          <button className={opts.skeleton ? 'on' : ''} onClick={() => setOpts({ ...opts, skeleton: !opts.skeleton })} title="Ghost climber"><Bone size={14} /> Climber</button>
          {s.wall && <button className={opts.backdrop ? 'on' : ''} onClick={() => setOpts({ ...opts, backdrop: !opts.backdrop })} title="Wall photo behind the route"><ImageIcon size={14} /> Wall</button>}
          <button className={opts.letters ? 'on' : ''} onClick={() => setOpts({ ...opts, letters: !opts.letters })} title="Label holds A–Z like the LiDAR view"><Type size={14} /> A–Z</button>
          {s.toppedOut && <button onClick={() => { player.seek(tl.climbEnd - 0.05); player.play() }} title="Replay the finale"><RotateCcw size={14} /> Finale</button>}
        </div>
      </div>

      <div className="track" onPointerDown={onDown} onPointerMove={onMove}>
       <div className="track-body" ref={track}>
        <div className="track-pre" style={{ width: `${pct(0)}%` }} />
        <div className="track-post" style={{ left: `${pct(tl.climbEnd)}%` }}><span>FINALE</span></div>
        <div className="marks">
          {[...tl.firstUse.entries()].map(([id, f]) => (
            <span key={id} className="mark" style={{ left: `${pct(f.time)}%`, background: id === s.finalHoldId ? GOLD : route, opacity: f.time <= ps.t ? 1 : 0.35 }}>{tl.label(id, opts.letters)}</span>
          ))}
        </div>
        {LIMBS.map((l) => (
          <div key={l.key} className="lane">
            <span className="lane-label" style={{ color: l.color }}>{l.label}</span>
            {tl.intervals[l.key].map((iv, i) => (
              <span key={i} className="bar" style={{ left: `${pct(iv.start)}%`, width: `${Math.max(0.4, pct(iv.end) - pct(iv.start))}%`, background: l.color, opacity: iv.start <= ps.t ? 0.95 : 0.3 }}>
                <em>{tl.label(iv.holdId, opts.letters)}</em>
              </span>
            ))}
          </div>
        ))}
        <div className="playhead" style={{ left: `${pct(ps.t)}%` }}><i /></div>
       </div>
      </div>
    </div>
  )
}
