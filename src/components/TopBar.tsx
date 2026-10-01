import { Plus, Sparkles } from 'lucide-react'
import type { Health } from '../lib/api'
import { LogoMark, Wordmark } from './Logo'

export function TopBar({ health, route, go }: { health: Health | null; route: string; go: (r: string) => void }) {
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
        <div className={`status ${health?.connected ? 'on' : health?.ok ? 'warn' : 'off'}`} title={health?.connected ? `Gateway ${health.gateway}` : 'Add VLMRUN_API_KEY to .env and run npm run dev'}>
          <span className="status-dot" />
          {health?.connected ? 'VLM Run connected' : health?.ok ? 'VLM Run: no key' : 'Offline mode'}
        </div>
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
