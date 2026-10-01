// Getting a climb out: a coach report (PDF), a share card (PNG), the session
// (CLIMBR JSON), the pipeline's own climb.json, and the moves as CSV.

import { jsPDF } from 'jspdf'
import { onDeviceFeedback } from './coach'
import { holdFill } from './colors'
import { hexA, polygonPath } from './geometry'
import { toPipelineClimb } from './session'
import { GOLD, LIMBS, LIMB_BY_KEY, ROUTE_COLORS, type CoachFeedback, type Session, type Vec2 } from './types'

export function download(name: string, data: Blob | string, type = 'application/octet-stream') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export const slug = (s: Session) => `${s.title}-${s.route.color}-${s.route.grade}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function sessionBundle(s: Session) {
  const clean: Session = JSON.parse(JSON.stringify(s))
  if (clean.video?.src?.startsWith('blob:')) clean.video = { ...clean.video, src: '' }
  if (clean.wall?.src?.startsWith('blob:')) delete clean.wall
  if (clean.lidar?.plyUrl?.startsWith('blob:')) delete clean.lidar
  return {
    climbr: 1,
    kind: 'session',
    exported_at: new Date().toISOString(),
    session: clean,
    pipeline: {
      climb: toPipelineClimb(s),
      holds: s.holds.map((h) => ({ id: h.id, bbox: h.bbox, polygon: h.polygon, score: h.score ?? null })),
    },
  }
}

export function exportJson(s: Session) {
  download(`${slug(s)}.climbr.json`, JSON.stringify(sessionBundle(s), null, 2), 'application/json')
}

export function exportClimbJson(s: Session) {
  download('climb.json', JSON.stringify(toPipelineClimb(s), null, 2), 'application/json')
}

export function exportCsv(s: Session) {
  const rows = [['step', 'limb', 'hold_id', 'time', 'contact_seconds']]
  s.moves.forEach((m, i) => rows.push([String(i + 1), m.limb, String(m.holdId), m.time.toFixed(3), m.duration.toFixed(3)]))
  download(`${slug(s)}-moves.csv`, rows.map((r) => r.join(',')).join('\n'), 'text/csv')
}

// ── drawing the route onto a 2D canvas ───────────────────────────────────────

export function drawRoute(ctx: CanvasRenderingContext2D, s: Session, box: { x: number; y: number; w: number; h: number }, opts: { byLimb?: boolean; badges?: boolean; path?: boolean } = {}) {
  const { byLimb = true, badges = true, path = true } = opts
  const aspect = s.canvas.width / s.canvas.height
  const pts = s.holds.flatMap((h) => h.polygon)
  const xs = pts.map((p) => p[0] * aspect), ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const k = Math.min(box.w / (x1 - x0 || 1), box.h / (y1 - y0 || 1)) * 0.86
  const ox = box.x + box.w / 2 - ((x0 + x1) / 2) * k
  const oy = box.y + box.h / 2 - ((y0 + y1) / 2) * k
  const toXY = (p: Vec2): Vec2 => [ox + p[0] * aspect * k, oy + p[1] * k]
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  ctx.save()

  if (path && s.torso && s.torso.length > 2) {
    const end = s.elapsed ?? s.duration
    const t = s.torso.filter((p) => p[0] >= 0 && p[0] <= end)
    ctx.save()
    ctx.setLineDash([2, 7])
    ctx.lineCap = 'round'
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.beginPath()
    t.forEach((p, i) => {
      const [x, y] = toXY([p[1], p[2]])
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.stroke()
    ctx.restore()
  }

  for (const h of s.holds) {
    const used = s.sequence.includes(h.id)
    const p = new Path2D(polygonPath(h.polygon, toXY))
    if (used) {
      const fill = byLimb ? holdFill(s, h.id) : route
      ctx.save()
      ctx.shadowColor = hexA(fill, 0.8)
      ctx.shadowBlur = 18
      ctx.fillStyle = hexA(fill, 0.88)
      ctx.fill(p)
      ctx.restore()
      ctx.lineWidth = h.id === s.finalHoldId ? 4 : 1.5
      ctx.strokeStyle = h.id === s.finalHoldId ? GOLD : 'rgba(255,255,255,0.55)'
      ctx.stroke(p)
    } else {
      ctx.lineWidth = 1.5
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.stroke(p)
    }
  }
  if (badges) {
    s.sequence.forEach((id, i) => {
      const h = s.holds.find((x) => x.id === id)
      if (!h) return
      const [x, y] = toXY([h.bbox[0] + h.bbox[2], h.bbox[1]])
      ctx.beginPath()
      ctx.arc(x, y, 13, 0, Math.PI * 2)
      ctx.fillStyle = id === s.finalHoldId ? GOLD : '#ffffff'
      ctx.fill()
      ctx.fillStyle = '#0a0b0d'
      ctx.font = '700 14px "Geist Variable", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), x, y + 0.5)
    })
  }
  ctx.restore()
  return toXY
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

export async function renderShareCard(s: Session, coach?: CoachFeedback): Promise<HTMLCanvasElement> {
  // Canvas text only uses fonts that are already loaded; ask for them by name.
  await Promise.all(['700 64px "Geist Variable"', '600 40px "Geist Variable"', '700 34px "Geist Mono Variable"'].map((f) => document.fonts?.load(f).catch(() => null)))
  await document.fonts?.ready
  const W = 1080, H = 1350
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const f = coach ?? s.coach ?? onDeviceFeedback(s)
  const sans = '"Geist Variable", system-ui, sans-serif'
  const mono = '"Geist Mono Variable", ui-monospace, monospace'

  ctx.fillStyle = '#050607'
  ctx.fillRect(0, 0, W, H)
  const g = ctx.createRadialGradient(220, 260, 0, 220, 260, 900)
  g.addColorStop(0, hexA(route, 0.22))
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  const g2 = ctx.createRadialGradient(W, H, 0, W, H, 800)
  g2.addColorStop(0, 'rgba(99,102,241,0.18)')
  g2.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g2
  ctx.fillRect(0, 0, W, H)

  // header
  ctx.fillStyle = '#fff'
  ctx.font = `800 34px ${sans}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('CLIMBR', 72, 104)
  ctx.fillStyle = route
  ctx.beginPath()
  ctx.arc(60 - 8, 92, 7, 0, Math.PI * 2)
  ctx.fill()
  ctx.font = `500 22px ${sans}`
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.textAlign = 'right'
  ctx.fillText(new Date(s.recordedAt ?? Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), W - 64, 104)
  ctx.textAlign = 'left'

  ctx.fillStyle = '#fff'
  ctx.font = `700 64px ${sans}`
  ctx.fillText(s.title, 64, 200)
  ctx.font = `500 26px ${sans}`
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.fillText([s.route.color, s.route.grade, s.gym, s.climber].filter(Boolean).join('  ·  '), 64, 246)

  // route panel
  roundRect(ctx, 48, 290, 560, 820, 32)
  ctx.fillStyle = 'rgba(255,255,255,0.035)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1.5
  ctx.stroke()
  drawRoute(ctx, s, { x: 64, y: 310, w: 528, h: 780 })

  // stats
  const sx = 648
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = `600 20px ${sans}`
  ctx.fillText(s.toppedOut ? 'TOPPED OUT IN' : 'TIME ON THE WALL', sx, 340)
  ctx.fillStyle = '#fff'
  ctx.font = `760 128px ${sans}`
  const clock = (s.elapsed ?? s.duration).toFixed(2)
  ctx.fillText(clock, sx - 6, 456)
  const clockW = ctx.measureText(clock).width
  ctx.font = `600 44px ${sans}`
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.fillText('s', sx + clockW + 4, 456)

  const stat = (label: string, value: string, y: number) => {
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.font = `600 18px ${sans}`
    ctx.fillText(label.toUpperCase(), sx, y)
    ctx.fillStyle = '#fff'
    ctx.font = `700 48px ${sans}`
    ctx.fillText(value, sx, y + 50)
  }
  stat('Holds used', `${s.sequence.length}/${s.holdsDetected}`, 530)
  stat('Moves', String(s.moves.length), 640)
  const mine = s.comparison?.attempts.find((a) => a.isThis)
  stat('Attempt', mine ? `${mine.index} of ${s.comparison!.attempts.length}` : '1', 750)

  // score ring
  const cx = sx + 110, cy = 980, r = 92
  ctx.lineWidth = 16
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r)
  grad.addColorStop(0, route)
  grad.addColorStop(1, '#22D3EE')
  ctx.strokeStyle = grad
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * f.score) / 100)
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.font = `760 70px ${sans}`
  ctx.fillText(String(f.score), cx, cy + 16)
  ctx.font = `600 16px ${sans}`
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.fillText('COACH SCORE', cx, cy + 44)
  ctx.textAlign = 'left'

  // sequence
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.font = `600 18px ${sans}`
  ctx.fillText('SEQUENCE', 64, 1166)
  let x = 64
  ctx.font = `700 34px ${mono}`
  s.sequence.forEach((id, i) => {
    const first = s.moves.find((m) => m.holdId === id)
    ctx.fillStyle = id === s.finalHoldId ? GOLD : first ? LIMB_BY_KEY[first.limb].color : '#fff'
    ctx.fillText(String(id), x, 1212)
    x += ctx.measureText(String(id)).width + 10
    if (i < s.sequence.length - 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.fillText('›', x, 1212)
      x += ctx.measureText('›').width + 10
    }
  })
  // headline
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = `500 26px ${sans}`
  ctx.fillText(`“${f.headline}”`, 64, 1268, W - 128)
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.font = `500 18px ${sans}`
  ctx.fillText('Analyzed with VLM Run · SAM 3.1 + ViTPose+', 64, 1306)
  // limb legend
  let lx = W - 64
  ctx.textAlign = 'right'
  for (const l of [...LIMBS].reverse()) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.fillText(l.label, lx, 1306)
    lx -= ctx.measureText(l.label).width + 8
    ctx.fillStyle = l.color
    ctx.fillRect(lx - 12, 1292, 12, 12)
    lx -= 30
  }
  ctx.textAlign = 'left'
  return c
}

export async function exportShareCard(s: Session, coach?: CoachFeedback) {
  const c = await renderShareCard(s, coach)
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'))
  download(`${slug(s)}-card.png`, blob)
}

// ── the coach report ─────────────────────────────────────────────────────────

export async function exportPdf(s: Session, coach?: CoachFeedback) {
  const f = coach ?? s.coach ?? onDeviceFeedback(s)
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight()
  const M = 40
  const route = ROUTE_COLORS[s.route.color] ?? ROUTE_COLORS.green
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]

  // cover band
  doc.setFillColor(8, 9, 11)
  doc.rect(0, 0, W, 300, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text('CLIMBR', M, 48)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(150, 155, 165)
  doc.setFontSize(9)
  doc.text('COACH REPORT', W - M, 48, { align: 'right' })
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(30)
  doc.text(s.title, M, 104)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.setTextColor(170, 175, 185)
  doc.text([s.route.color, s.route.grade, s.gym, s.climber, new Date(s.recordedAt ?? Date.now()).toLocaleDateString()].filter(Boolean).join('   ·   '), M, 126)

  const card = await renderShareCard(s, f)
  // The route panel, cropped out of the share card.
  const crop = document.createElement('canvas')
  crop.width = 560
  crop.height = 820
  crop.getContext('2d')!.drawImage(card, 48, 290, 560, 820, 0, 0, 560, 820)
  doc.addImage(crop.toDataURL('image/jpeg', 0.9), 'JPEG', W - M - 150, 70, 150, 220)

  const big = (label: string, value: string, x: number) => {
    doc.setTextColor(140, 145, 155)
    doc.setFontSize(8)
    doc.text(label.toUpperCase(), x, 190)
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(26)
    doc.text(value, x, 222)
    doc.setFont('helvetica', 'normal')
  }
  big(s.toppedOut ? 'Topped out in' : 'Time', `${(s.elapsed ?? s.duration).toFixed(2)} s`, M)
  big('Holds used', `${s.sequence.length}/${s.holdsDetected}`, M + 130)
  big('Coach score', `${f.score}`, M + 250)
  doc.setFontSize(9)
  doc.setTextColor(140, 145, 155)
  doc.text('SEQUENCE', M, 258)
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(12)
  doc.text(s.sequence.join('  ›  '), M, 276)

  let y = 340
  doc.setTextColor(...rgb('#0B0C0E'))
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  y = para(doc, f.headline, M, y, W - 2 * M, 22) + 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.setTextColor(60, 64, 72)
  y = para(doc, f.summary, M, y, W - 2 * M, 15) + 16

  // sub-scores
  const keys = Object.entries(f.scores) as [string, number][]
  const bw = (W - 2 * M - 30) / 4
  keys.forEach(([k, v], i) => {
    const x = M + i * (bw + 10)
    doc.setFontSize(8)
    doc.setTextColor(120, 125, 135)
    doc.text(k.toUpperCase(), x, y)
    doc.setFillColor(232, 234, 238)
    doc.roundedRect(x, y + 8, bw, 6, 3, 3, 'F')
    doc.setFillColor(...rgb(route))
    doc.roundedRect(x, y + 8, (bw * v) / 100, 6, 3, 3, 'F')
    doc.setFontSize(12)
    doc.setTextColor(20, 22, 26)
    doc.text(String(v), x, y + 32)
  })
  y += 60

  const BOTTOM = H - 60
  const ensure = (space: number) => {
    if (y + space > BOTTOM) { doc.addPage(); y = 56 }
  }
  const section = (title: string, items: { title: string; detail: string }[], color: string) => {
    ensure(60)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...rgb(color))
    doc.text(title.toUpperCase(), M, y)
    y += 16
    for (const it of items) {
      const lines = (doc.splitTextToSize(it.detail || '', W - 2 * M) as string[]).length
      ensure(20 + lines * 13)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(11)
      doc.setTextColor(20, 22, 26)
      y = para(doc, it.title, M, y, W - 2 * M, 14)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.setTextColor(80, 84, 92)
      y = para(doc, it.detail, M, y, W - 2 * M, 13) + 8
    }
    y += 6
  }
  section('What went well', f.strengths, '#16A34A')
  section('Focus next time', f.focus, '#E11D48')
  section('Drills', f.drills.map((d) => ({ title: `${d.name}${d.dose ? ` — ${d.dose}` : ''}`, detail: d.how })), '#4F46E5')
  ensure(90)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(20, 22, 26)
  doc.text('SUGGESTED BETA', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(60, 64, 72)
  y = para(doc, f.beta, M, y + 14, W - 2 * M, 13) + 10
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(20, 22, 26)
  doc.text('NEXT GOAL', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(60, 64, 72)
  para(doc, f.next_goal, M, y + 14, W - 2 * M, 13)

  // page 2: the measurements
  doc.addPage()
  y = 56
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(20, 22, 26)
  doc.text('Move by move', M, y)
  y += 24
  doc.setFontSize(8)
  doc.setTextColor(120, 125, 135)
  const cols = [M, M + 50, M + 150, M + 230, M + 320]
  ;['#', 'LIMB', 'HOLD', 'AT', 'HELD'].forEach((h, i) => doc.text(h, cols[i], y))
  y += 12
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  s.moves.forEach((m, i) => {
    ensure(16)
    const l = LIMB_BY_KEY[m.limb]
    doc.setFillColor(...rgb(l.color))
    doc.circle(cols[1] + 4, y - 3.5, 3.5, 'F')
    doc.setTextColor(20, 22, 26)
    doc.text(String(i + 1), cols[0], y)
    doc.text(l.name, cols[1] + 14, y)
    doc.text(String(m.holdId), cols[2], y)
    doc.text(`${m.time.toFixed(2)} s`, cols[3], y)
    doc.text(`${m.duration.toFixed(2)} s`, cols[4], y)
    y += 16
  })
  y += 18
  if (s.utilization) {
    ensure(110)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(16)
    doc.text('On a hold', M, y)
    y += 20
    for (const l of LIMBS) {
      const u = s.utilization[l.key]
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.setTextColor(20, 22, 26)
      doc.text(l.name, M, y)
      doc.setFillColor(236, 238, 242)
      doc.roundedRect(M + 90, y - 7, 220, 8, 4, 4, 'F')
      doc.setFillColor(...rgb(l.color))
      doc.roundedRect(M + 90, y - 7, 220 * u.coverage, 8, 4, 4, 'F')
      doc.text(`${Math.round(u.coverage * 100)}%`, M + 320, y)
      doc.setTextColor(110, 115, 125)
      doc.text(u.sequence.join(' '), M + 360, y)
      y += 18
    }
  }
  if (s.comparison?.attempts.length) {
    y += 16
    ensure(40 + s.comparison.attempts.length * 16)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(16)
    doc.setTextColor(20, 22, 26)
    doc.text('Attempts', M, y)
    y += 20
    for (const a of [...s.comparison.attempts].sort((p, q) => p.index - q.index)) {
      doc.setFont('helvetica', a.isThis ? 'bold' : 'normal')
      doc.setFontSize(10)
      doc.setTextColor(20, 22, 26)
      doc.text(`Attempt ${a.index}${a.isThis ? ' (this climb)' : ''}`, M, y)
      doc.text(a.elapsed != null ? `${a.elapsed.toFixed(2)} s` : '—', M + 150, y)
      doc.text(`${a.sequence.length} holds`, M + 220, y)
      doc.setTextColor(110, 115, 125)
      doc.text(a.sequence.join(' › '), M + 290, y)
      y += 16
    }
  }
  doc.setFontSize(8)
  doc.setTextColor(150, 155, 165)
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.text(`CLIMBR · ${f.source === 'vlm' ? `Coached by ${f.model ?? 'VLM Run'}` : 'On-device coach'} · holds by SAM 3.1, pose by ViTPose+ via VLM Run`, M, H - 24)
    doc.text(`${p}/${pages}`, W - M, H - 24, { align: 'right' })
  }
  doc.save(`${slug(s)}-coach-report.pdf`)
}

function para(doc: jsPDF, text: string, x: number, y: number, w: number, lh: number) {
  const lines = doc.splitTextToSize(text || '', w) as string[]
  lines.forEach((l, i) => doc.text(l, x, y + i * lh))
  return y + lines.length * lh
}
