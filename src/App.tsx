import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { TopBar } from './components/TopBar'
import { Toaster } from './components/Toast'
import { health as fetchHealth, loadExample, type Health } from './lib/api'
import { getPrefs, loadSession } from './lib/store'
import type { Session } from './lib/types'
import { Home } from './views/Home'
import { ImportView } from './views/ImportView'
import { Onboarding } from './views/Onboarding'
import { SessionView } from './views/SessionView'

type Route = { name: 'home' } | { name: 'welcome' } | { name: 'import' } | { name: 'session'; id: string }

function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, '')
  if (h.startsWith('welcome')) return { name: 'welcome' }
  if (h.startsWith('import')) return { name: 'import' }
  if (h.startsWith('session/')) return { name: 'session', id: decodeURIComponent(h.slice(8)) }
  return { name: 'home' }
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => (getPrefs().onboarded || location.hash ? parse(location.hash) : { name: 'welcome' }))
  const [sessions, setSessions] = useState<Record<string, Session>>({})
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const on = () => setRoute(parse(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  useEffect(() => {
    fetchHealth().then(setHealth)
    loadExample().then((s) => setSessions((m) => ({ ...m, [s.id]: s }))).catch((e) => setError(String(e)))
  }, [])

  const go = useCallback((hash: string) => {
    if (location.hash === hash) setRoute(parse(hash))
    else location.hash = hash
  }, [])

  const addSession = useCallback((s: Session) => {
    setSessions((m) => ({ ...m, [s.id]: s }))
  }, [])

  // A saved session opened by link loads from IndexedDB on demand.
  useEffect(() => {
    if (route.name === 'session' && !sessions[route.id] && !route.id.startsWith('example')) {
      loadSession(route.id).then((s) => (s ? addSession(s) : setError('That climb is not saved in this browser.')))
    }
  }, [route, sessions, addSession])

  const active = route.name === 'session' ? sessions[route.id] : undefined
  const navId = route.name === 'session' ? (route.id.startsWith('example') ? 'session' : 'other') : route.name

  return (
    <div className="app">
      <div className="bg-grid" aria-hidden />
      <div className="bg-noise" aria-hidden />
      <AnimatePresence mode="wait">
        {route.name === 'welcome' ? (
          <Onboarding key="welcome" onDone={(to) => go(to)} />
        ) : (
          <motion.div key="shell" className="shell" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <TopBar health={health} route={navId} go={go} onHealth={setHealth} />
            <main className="main">
              <AnimatePresence mode="wait">
                {route.name === 'home' && <Home key="home" sessions={Object.values(sessions)} go={go} />}
                {route.name === 'import' && <ImportView key="import" health={health} onHealth={setHealth} onSession={(s) => { addSession(s); go(`#/session/${encodeURIComponent(s.id)}`) }} />}
                {route.name === 'session' && (active ? (
                  <SessionView key={active.id} session={active} health={health} onUpdate={addSession} go={go} />
                ) : (
                  <motion.div key="loading" className="loading-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    {error ? <p className="muted">{error}</p> : <div className="spinner" />}
                  </motion.div>
                ))}
              </AnimatePresence>
            </main>
          </motion.div>
        )}
      </AnimatePresence>
      <Toaster />
    </div>
  )
}
