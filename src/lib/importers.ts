// What CLIMBR accepts on the Import page: a video of a climb. Everything else —
// holds, moves, the 3D wall — is measured from it.

export interface Clip {
  id: string
  name: string
  size: number
  file: File
  url: string // an object URL, for the preview
  meta?: { w: number; h: number; dur: number } // as this browser reads it; the server probes for real
}

const VIDEO = /\.(mp4|mov|m4v|webm)$/i

export const isVideo = (f: File) => f.type.startsWith('video/') || VIDEO.test(f.name)

export function clipFrom(file: File): Clip {
  return { id: Math.random().toString(36).slice(2, 9), name: file.name, size: file.size, file, url: URL.createObjectURL(file) }
}

/** What this browser can read of the clip, for the preview. An iPhone's HEVC
 *  may not be readable here at all; the server reads it either way. */
export function videoMeta(url: string): Promise<Clip['meta'] | undefined> {
  return new Promise((res) => {
    const v = document.createElement('video')
    const done = setTimeout(() => res(undefined), 4000)
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => {
      clearTimeout(done)
      res(v.videoWidth && Number.isFinite(v.duration) ? { w: v.videoWidth, h: v.videoHeight, dur: v.duration } : undefined)
    }
    v.onerror = () => { clearTimeout(done); res(undefined) }
    v.src = url
  })
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean)
  if (!entries.length) return [...dt.files]
  const out: File[] = []
  const walk = async (entry: any): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => entry.file(res, rej)))
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      const read = () => new Promise<any[]>((res, rej) => reader.readEntries(res, rej))
      for (let batch = await read(); batch.length; batch = await read()) for (const e of batch) await walk(e)
    }
  }
  for (const e of entries) await walk(e)
  return out.filter((f) => !f.name.startsWith('.'))
}
