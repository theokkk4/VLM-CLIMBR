// Connecting CLIMBR to VLM Run: paste a key, it is tested against the gateway
// (does it list SAM 3.1 and ViTPose+?) and saved on the server only if it
// works. Also the place to re-check a key that is already set.

import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, KeyRound, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { checkModels, connectKey, type Health, type KeyCheck } from '../lib/api'

const REQUIRED: [string, string][] = [['facebook/sam3.1', 'SAM 3.1 · holds'], ['usyd-community/vitpose-plus-large', 'ViTPose+ · climber']]

export function ConnectKey({ health, onConnected, compact }: { health: Health | null; onConnected: (h: Health) => void; compact?: boolean }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<KeyCheck | null>(null)
  const connected = Boolean(health?.connected)

  // With a key already set, show what it can actually do.
  useEffect(() => {
    if (connected && !check) checkModels().then(setCheck)
  }, [connected, check])

  const submit = async () => {
    if (!key.trim()) return
    setBusy(true)
    const r = await connectKey(key.trim())
    setCheck(r)
    setBusy(false)
    if (r.ok && r.health) { setKey(''); onConnected(r.health) }
  }
  const recheck = async () => {
    setBusy(true)
    setCheck(await checkModels())
    setBusy(false)
  }

  return (
    <div className={`connect ${compact ? 'compact' : ''}`}>
      <div className="limb-head">
        <span className="kicker"><KeyRound size={12} /> VLM Run</span>
        {connected && <button className="link" onClick={recheck} disabled={busy}><RefreshCw size={12} className={busy ? 'spin' : ''} /> Re-check</button>}
      </div>
      {!connected && (
        <>
          <p className="muted xs">Paste your VLM Run API key. CLIMBR tests it against the gateway and keeps it on the server, in the project’s <code>.env</code>. It never reaches the browser again.</p>
          {health?.canSaveKey === false ? (
            <p className="muted xs">On Vercel, add <code>VLMRUN_API_KEY</code> under Settings → Environment Variables and redeploy.</p>
          ) : (
            <form className="connect-form" onSubmit={(e) => { e.preventDefault(); submit() }}>
              <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" spellCheck={false} autoComplete="off" type="password" />
              <button className="btn primary" type="submit" disabled={busy || !key.trim()}>{busy ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />} Connect</button>
            </form>
          )}
        </>
      )}
      <AnimatePresence initial={false}>
        {check && (
          <motion.ul className="connect-checks" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <li className={check.status === 200 ? 'ok' : 'bad'}>{check.status === 200 ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<b>{check.status === 200 ? 'Key accepted by the gateway' : 'Key not accepted'}</b><span>{check.status === 200 ? `${check.models.length} models available` : check.error}</span></li>
            {check.status === 200 && REQUIRED.map(([id, label]) => {
              const ok = check.models.includes(id)
              return <li key={id} className={ok ? 'ok' : 'bad'}>{ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<b>{label}</b><span>{ok ? id : 'not available to this key'}</span></li>
            })}
            {check.status === 200 && <li className={check.coach?.length ? 'ok' : 'warn'}>{check.coach?.length ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<b>Coach · VLM</b><span>{check.coach?.length ? check.coach.join(', ') : 'no coach model on this key; on-device notes only'}</span></li>}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}
