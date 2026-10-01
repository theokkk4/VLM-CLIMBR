// One clock for the whole replay. The video drives it while the video has
// frames; past the end of the clip (the finale, or a session with no video at
// all) requestAnimationFrame takes over. Every panel reads the same t.

import { useSyncExternalStore } from 'react'

export interface PlayerState { t: number; playing: boolean; rate: number }

export interface Player {
  get(): PlayerState
  subscribe(fn: () => void): () => void
  play(): void
  pause(): void
  toggle(): void
  seek(t: number): void
  setRate(r: number): void
  attachVideo(v: HTMLVideoElement | null): void
  /** Starts the frame loop; returns the function that stops it. */
  run(): () => void
  start: number
  end: number
  climbEnd: number
  offset: number
}

export function createPlayer(opts: { start: number; end: number; climbEnd: number; offset: number }): Player {
  let state: PlayerState = { t: opts.start, playing: false, rate: 1 }
  const subs = new Set<() => void>()
  let video: HTMLVideoElement | null = null
  let raf = 0
  let last = 0
  const emit = () => subs.forEach((f) => f())
  const set = (patch: Partial<PlayerState>) => {
    state = { ...state, ...patch }
    emit()
  }
  const videoCovers = (t: number) => {
    if (!video || !Number.isFinite(video.duration)) return false
    const vt = t + opts.offset
    return vt >= 0 && vt < video.duration - 0.04
  }

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    const dt = last ? Math.min(0.25, (now - last) / 1000) : 0
    last = now
    if (!state.playing) return
    let t: number
    if (video && videoCovers(state.t) && !video.paused && !video.seeking) {
      t = video.currentTime - opts.offset
    } else {
      t = state.t + dt * state.rate
      if (video && videoCovers(t) && video.paused) {
        video.currentTime = t + opts.offset
        void video.play().catch(() => {})
      }
    }
    if (t >= opts.end) {
      t = opts.end
      set({ t, playing: false })
      video?.pause()
      return
    }
    if (t !== state.t) set({ t })
  }
  const player: Player = {
    ...opts,
    get: () => state,
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    play() {
      if (state.t >= opts.end - 0.01) player.seek(opts.start)
      last = 0
      set({ playing: true })
      if (video && videoCovers(state.t)) {
        video.currentTime = state.t + opts.offset
        video.playbackRate = state.rate
        void video.play().catch(() => {})
      }
    },
    pause() {
      set({ playing: false })
      video?.pause()
    },
    toggle() {
      if (state.playing) player.pause()
      else player.play()
    },
    seek(t) {
      const c = Math.max(opts.start, Math.min(opts.end, t))
      set({ t: c })
      if (video && Number.isFinite(video.duration)) {
        video.currentTime = Math.max(0, Math.min(video.duration - 0.05, c + opts.offset))
        if (state.playing && videoCovers(c)) void video.play().catch(() => {})
        else video.pause()
      }
    },
    setRate(r) {
      set({ rate: r })
      if (video) video.playbackRate = r
    },
    attachVideo(v) {
      video = v
      if (v) {
        v.playbackRate = state.rate
        const sync = () => {
          if (Number.isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration - 0.05, state.t + opts.offset))
        }
        if (v.readyState >= 1) sync()
        else v.addEventListener('loadedmetadata', sync, { once: true })
      }
    },
    run() {
      // Idempotent and restartable, so React StrictMode's mount → unmount →
      // mount leaves exactly one loop running.
      cancelAnimationFrame(raf)
      last = 0
      raf = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(raf)
    },
  }
  return player
}

export function usePlayer(p: Player): PlayerState {
  return useSyncExternalStore(p.subscribe, p.get, p.get)
}

/** The finale: lit holds dim, then relight one by one in limb colours. */
export function finaleSchedule(climbEnd: number, n: number) {
  const dimAt = climbEnd + 0.7
  const firstAt = dimAt + 0.5
  const step = 0.38
  const measureAt = firstAt + n * step + 0.3
  return { dimAt, firstAt, step, measureAt, end: measureAt + 2.4 }
}
