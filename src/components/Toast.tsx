import { AnimatePresence, motion } from 'framer-motion'
import { Check, Info, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

type Toast = { id: number; text: string; tone: 'ok' | 'info' | 'warn' }
let push: ((t: Omit<Toast, 'id'>) => void) | null = null
export const toast = (text: string, tone: Toast['tone'] = 'ok') => push?.({ text, tone })

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([])
  useEffect(() => {
    push = (t) => {
      const id = Date.now() + Math.random()
      setItems((xs) => [...xs, { ...t, id }])
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3600)
    }
    return () => { push = null }
  }, [])
  return (
    <div className="toasts">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div key={t.id} className={`toast ${t.tone}`} layout initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.96 }} transition={{ type: 'spring', stiffness: 420, damping: 32 }}>
            {t.tone === 'ok' ? <Check size={15} /> : t.tone === 'warn' ? <TriangleAlert size={15} /> : <Info size={15} />}
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
