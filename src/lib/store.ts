// Imported climbs survive a reload: the session in one store, its video and
// point cloud as blobs in another. IndexedDB can be unavailable (private
// windows, blocked storage), so every call degrades to "not saved".

import type { Session } from './types'

const DB = 'climbr'
const VERSION = 1

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

async function blobOf(url?: string): Promise<Blob | null> {
  if (!url || !url.startsWith('blob:')) return null
  try { return await (await fetch(url)).blob() } catch { return null }
}

export interface StoredSession { id: string; session: Session; savedAt: string }

export async function saveSession(s: Session): Promise<boolean> {
  try {
    const video = await blobOf(s.video?.src)
    const wall = await blobOf(s.wall?.src)
    const ply = await blobOf(s.lidar?.plyUrl)
    if (video) await tx('blobs', 'readwrite', (st) => st.put(video, `${s.id}:video`))
    if (wall) await tx('blobs', 'readwrite', (st) => st.put(wall, `${s.id}:wall`))
    if (ply) await tx('blobs', 'readwrite', (st) => st.put(ply, `${s.id}:ply`))
    const copy: Session = JSON.parse(JSON.stringify(s))
    await tx('sessions', 'readwrite', (st) => st.put({ id: s.id, session: copy, savedAt: new Date().toISOString() }))
    return true
  } catch {
    return false
  }
}

export async function listSessions(): Promise<StoredSession[]> {
  try {
    const all = await tx<StoredSession[]>('sessions', 'readonly', (st) => st.getAll() as IDBRequest<StoredSession[]>)
    return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  } catch {
    return []
  }
}

export async function loadSession(id: string): Promise<Session | null> {
  try {
    const rec = await tx<StoredSession | undefined>('sessions', 'readonly', (st) => st.get(id) as IDBRequest<StoredSession | undefined>)
    if (!rec) return null
    const s = rec.session
    const get = (k: string) => tx<Blob | undefined>('blobs', 'readonly', (st) => st.get(`${id}:${k}`) as IDBRequest<Blob | undefined>)
    const [video, wall, ply] = await Promise.all([get('video'), get('wall'), get('ply')])
    if (s.video) s.video.src = video ? URL.createObjectURL(video) : s.video.src.startsWith('blob:') ? '' : s.video.src
    if (s.video && !s.video.src) delete s.video
    if (s.wall) s.wall.src = wall ? URL.createObjectURL(wall) : s.wall.src
    if (s.lidar) s.lidar.plyUrl = ply ? URL.createObjectURL(ply) : undefined
    return s
  } catch {
    return null
  }
}

export async function deleteSession(id: string) {
  try {
    await tx('sessions', 'readwrite', (st) => st.delete(id))
    for (const k of ['video', 'wall', 'ply']) await tx('blobs', 'readwrite', (st) => st.delete(`${id}:${k}`))
  } catch { /* nothing to undo */ }
}

const PREFS = 'climbr:prefs'
export interface Prefs { onboarded?: boolean; name?: string; grade?: string; color?: string; device?: 'lidar' | 'phone'; letters?: boolean }
export function getPrefs(): Prefs {
  try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}') } catch { return {} }
}
export function setPrefs(p: Prefs) {
  try { localStorage.setItem(PREFS, JSON.stringify({ ...getPrefs(), ...p })) } catch { /* private mode */ }
}
