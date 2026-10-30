import { AnimatePresence, motion } from 'framer-motion'
import { Plus, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Health } from '../lib/api'
import { ConnectKey } from './ConnectKey'
import { LogoMark, Wordmark } from './Logo'

export function TopBar({ health, route, go, onHealth }: { health: Health | null; route: string; go: (r: string) => void; onHealth: (h: Health) => void }) {
  const [open, setOpen] = useState(false)
  const pop = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc) }
  }, [open])
  const links = [
    { id: 'home', label: 'Climbs', href: '#/' },
    { id: 'session', label: 'Example', href: '#/session/example-green-vb' },
    { id: 'import', label: 'Import', href: '#/import' },
  ]
  return (
    <header className="topbar">
      <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); go('#/') }}>
        <LogoMark size={28} />
        <Wordmark />
      </a>
      <nav className="nav">
        {links.map((l) => (
          <a key={l.id} href={l.href} className={`nav-link ${route === l.id ? 'active' : ''}`} onClick={(e) => { e.preventDefault(); go(l.href) }}>
            <span>{l.label}</span>
          </a>
        ))}
      </nav>
      <div className="topbar-right">
        <button className={`status ${!health ? '' : health.connected ? 'on' : health.ok ? 'warn' : 'off'}`} onClick={() => setOpen((o) => !o)} title={health?.connected ? `Gateway ${health.gateway} · click to check the key` : 'Click to add your VLM Run key'}>
          <span className="status-dot" />
          {!health ? 'Checking…' : health.connected ? 'VLM Run connected' : health.ok ? 'Add VLM Run key' : 'Server offline'}
        </button>
        <AnimatePresence>
          {open && (
            <motion.div ref={pop} className="connect-pop" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              {health?.ok ? <ConnectKey health={health} onConnected={(h) => { onHealth(h); setOpen(false) }} compact /> : <p className="muted xs">The CLIMBR server is not running. Start it with <code>npm run dev</code>.</p>}
            </motion.div>
          )}
        </AnimatePresence>
        <button className="btn ghost sm" onClick={() => go('#/welcome')}>
          <Sparkles size={14} /> Intro
        </button>
        <button className="btn primary sm" onClick={() => go('#/import')}>
          <Plus size={15} /> New climb
        </button>
      </div>
    </header>
  )
}
