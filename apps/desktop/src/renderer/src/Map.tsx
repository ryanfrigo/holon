import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { describe } from './App.tsx'
import type { Action, Directive, Escalation, Node } from './holon.ts'
import { press } from './press.ts'

// A live picture of the org: the chart from you down, and every message travelling along it.
// Room for the name: the grade badge (and the quota ⬇ beside it) takes the right of the card.
const labelMax = (n: { grade?: number | null; gradeFrom?: number }) => n.gradeFrom !== undefined ? 13 : n.grade !== undefined && n.grade !== null ? 15 : 20
const W = 186, H = 64, GAP_X = 22, GAP_Y = 70, YOU = '__you__'
const MIN_ZOOM = 0.25, MAX_ZOOM = 3
const SHOWN = new Set(['type', 'press', 'escalate', 'answer', 'spawn', 'kill', 'merged', 'merge_refused', 'update', 'deliver',
  'propose', 'vote', 'critique', 'second_opinion', 'verdict', 'heal', 'ask', 'board_post', 'board_claim', 'board_done', 'retired'])
const COLOR: Record<string, string> = {
  type: '#e8a33d', press: '#e8a33d', ask: '#8fb4e8', answer: '#8fb4e8', escalate: '#e06c5a', update: '#7fb069', deliver: '#7fb069',
  merged: '#7fb069', merge_refused: '#e06c5a', heal: '#c39bf0', second_opinion: '#c39bf0', verdict: '#c39bf0',
}

interface Pos { x: number; y: number }
interface Flight { key: string; from: string; to: string; label: string; color: string }

function layout(nodes: Node[]) {
  const kids = new Map<string, Node[]>()
  for (const n of nodes) {
    const p = n.parentId ?? YOU
    kids.set(p, [...(kids.get(p) ?? []), n])
  }
  const pos = new Map<string, Pos>()
  let cursor = 0
  const place = (id: string, depth: number): number => {
    const children = kids.get(id) ?? []
    let x: number
    if (!children.length) { x = cursor; cursor += W + GAP_X }
    else {
      const xs = children.map(c => place(c.id, depth + 1))
      x = (xs[0] + xs[xs.length - 1]) / 2
    }
    pos.set(id, { x, y: depth * (H + GAP_Y) })
    return x
  }
  place(YOU, 0)
  return { pos, width: Math.max(cursor, W) , height: Math.max(...[...pos.values()].map(p => p.y)) + H }
}

export function OrgMap({ nodes, actions, escalations, directive, onOpen }: {
  nodes: Node[]
  actions: Action[]
  escalations: Escalation[]
  directive: Directive | null
  onOpen: (id: string) => void
}) {
  const { pos, width, height } = useMemo(() => layout(nodes), [nodes.map(n => `${n.id}:${n.parentId}`).join()])
  const [flights, setFlights] = useState<Flight[]>([])
  const seen = useRef(actions.length)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const [vp, setVp] = useState({ w: 0, h: 0 })
  const vpRef = useRef({ w: 0, h: 0 })
  const canvasRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

  // The visible box of the map. The chart is drawn around its own middle, so pan 0,0 shows it centred.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const measure = () => {
      const size = { w: el.clientWidth, h: el.clientHeight }
      vpRef.current = size
      setVp(size)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

  // Zoom by a factor, keeping the point under (px, py) where it is.
  const zoomAt = (factor: number, px: number, py: number) => {
    const z = zoomRef.current
    const nz = clampZoom(z * factor)
    if (nz === z) return
    const { w, h } = vpRef.current
    const ux = px - w / 2
    const uy = py - h / 2
    const p = panRef.current
    const next = { x: ux - nz * (ux - p.x) / z, y: uy - nz * (uy - p.y) / z }
    zoomRef.current = nz
    panRef.current = next
    setZoom(nz)
    setPan(next)
  }

  // React's onWheel is passive, so this one is native: it can preventDefault and zoom to the cursor.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const zoomCentre = (factor: number) => {
    const { w, h } = vpRef.current
    zoomAt(factor, w / 2, h / 2)
  }

  const fit = () => {
    const { w, h } = vpRef.current
    const z = clampZoom(Math.min((w - 40) / (width || W), (h - 40) / (height || H)))
    zoomRef.current = z
    panRef.current = { x: 0, y: 0 }
    setZoom(z)
    setPan({ x: 0, y: 0 })
  }

  // A wide org opens already fitted, so no seat starts off-screen; the owner's own zoom after that is left alone.
  const autoFit = useRef(false)
  useEffect(() => {
    if (autoFit.current || !vp.w || !vp.h || !width) return
    autoFit.current = true
    const z = clampZoom(Math.min(1, (vp.w - 40) / width, (vp.h - 40) / (height || H)))
    zoomRef.current = z
    setZoom(z)
  }, [vp.w, vp.h, width])

  // Dragging the empty background pans; a drag that starts on a node still opens it.
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY }
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!dx && !dy) return
    d.x = e.clientX
    d.y = e.clientY
    const next = { x: panRef.current.x + dx, y: panRef.current.y + dy }
    panRef.current = next
    setPan(next)
  }
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // New actions become dots that fly from sender to receiver, then disappear.
  useEffect(() => {
    const fresh = actions.slice(seen.current)
    seen.current = actions.length
    const add = fresh.filter(a => SHOWN.has(a.action)).map((a, i) => ({
      key: `${a.ts}-${i}-${a.action}`,
      from: a.caller ?? YOU,
      to: a.target ?? (a.action === 'escalate' || a.action === 'update' ? YOU : a.caller ?? YOU),
      label: `${a.action} ${describe(a)}`.slice(0, 48),
      color: COLOR[a.action] ?? '#b8ae9c',
    }))
    if (!add.length) return
    setFlights(f => [...f, ...add].slice(-30))
    const t = setTimeout(() => setFlights(f => f.filter(x => !add.includes(x))), 3200)
    return () => clearTimeout(t)
  }, [actions.length])

  const center = (id: string) => { const p = pos.get(id) ?? pos.get(YOU)!; return { x: p.x + W / 2, y: p.y + H / 2 } }
  const asks = new Map<string, number>()
  for (const e of escalations) if (e.status === 'open') asks.set(e.from, (asks.get(e.from) ?? 0) + 1)
  const claimed = new Map<string, number>()
  for (const t of directive?.tasks ?? []) if (t.status === 'claimed' && t.owner) claimed.set(t.owner, (claimed.get(t.owner) ?? 0) + 1)
  const feed = actions.filter(a => SHOWN.has(a.action)).slice(-24).reverse()
  const name = (id: string | null) => id === null ? 'you' : nodes.find(n => n.id === id)?.label ?? id

  const vw = vp.w || width + 40
  const vh = vp.h || height + 40

  return (
    <div className="map">
      <div className="map-canvas" ref={canvasRef}>
        <svg
          width={vw} height={vh} viewBox={`${-vw / 2} ${-vh / 2} ${vw} ${vh}`}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        >
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            <g transform={`translate(${-width / 2},${-height / 2})`}>
              {nodes.map(n => {
                const a = center(n.parentId ?? YOU), b = center(n.id)
                return <path key={`e-${n.id}`} className="edge" d={`M${a.x},${a.y + H / 2} C${a.x},${a.y + H} ${b.x},${b.y - H / 2} ${b.x},${b.y - H / 2}`} />
              })}
              {flights.map(f => {
                const a = center(f.from), b = center(f.to)
                const d = f.from === f.to ? `M${a.x},${a.y} l0,-28 l0,28` : `M${a.x},${a.y} L${b.x},${b.y}`
                return (
                  <g key={f.key}>
                    <path d={d} className="flight-path" style={{ stroke: f.color }} />
                    <circle r="5" fill={f.color}><animateMotion dur="1.4s" fill="freeze" path={d} /></circle>
                    <text x={(a.x + b.x) / 2 + 6} y={(a.y + b.y) / 2 - 6} className="flight-label" style={{ fill: f.color }}>{f.label}</text>
                  </g>
                )
              })}
              <g className="node you" transform={`translate(${pos.get(YOU)!.x},${pos.get(YOU)!.y})`}>
                <rect width={W} height={H} rx="10" />
                <text x="14" y="26" className="n-label">You</text>
                <text x="14" y="46" className="n-sub">{(n => `${n} ${n === 1 ? 'ask' : 'asks'} waiting`)(escalations.filter(e => e.to === null && e.status === 'open').length)}</text>
              </g>
              {nodes.map(n => {
                const p = pos.get(n.id)!
                const extra = [asks.get(n.id) ? `${asks.get(n.id)} ask` : '', claimed.get(n.label) ? `${claimed.get(n.label)} task` : ''].filter(Boolean).join(' · ')
                return (
                  <g key={n.id} className={`node ${n.state}`} transform={`translate(${p.x},${p.y})`} {...press(() => onOpen(n.id))} aria-label={`Open ${n.label}`}>
                    <rect width={W} height={H} rx="10" />
                    <circle cx="14" cy="20" r="4" className={`dot-svg ${n.state}`} />
                    <text x="24" y="24" className="n-label">{n.label.length > labelMax(n) ? n.label.slice(0, labelMax(n) - 1) + '…' : n.label}<title>{n.label}</title></text>
                    <text x="14" y="41" className="n-sub">{n.dept ? `${n.dept} · ` : ''}{n.cli}{n.readOnly ? ' · read-only' : ''}</text>
                    {n.grade !== undefined && n.grade !== null && (
                      <g transform={`translate(${W - 40},10)`} className={`grade-badge g${n.grade}`}>
                        <rect width="30" height="16" rx="4" />
                        <text x="15" y="12" textAnchor="middle">G{n.grade}{n.pendingGrade !== undefined ? `→${n.pendingGrade}` : ''}</text>
                        <title>{n.gradeFrom !== undefined ? `On G${n.grade} because G${n.gradeFrom} is out of quota` : `Grade G${n.grade}${n.model ? ` · ${n.model}` : ''}`}</title>
                      </g>
                    )}
                    {n.gradeFrom !== undefined && <text x={W - 48} y="21" className="n-sub" textAnchor="end">⬇</text>}
                    <text x="14" y="56" className="n-status">{extra ? extra : (n.status ?? n.headline ?? '').slice(0, 28) + ((n.status ?? n.headline ?? '').length > 28 ? '…' : '')}</text>
                    <title>{`${n.label}\n${n.status ?? ''}\n${n.headline ?? ''}`}</title>
                  </g>
                )
              })}
            </g>
          </g>
        </svg>
        <div className="map-zoom">
          <button onClick={() => zoomCentre(1.25)} title="Zoom in" aria-label="Zoom in">+</button>
          <button onClick={() => zoomCentre(1 / 1.25)} title="Zoom out" aria-label="Zoom out">−</button>
          <button onClick={fit} title="Fit the whole org in view">Fit</button>
        </div>
      </div>
      <aside className="map-feed">
        <h2>Live</h2>
        {feed.map((a, i) => (
          <div key={i} className="feed-row">
            <time>{new Date(a.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time>
            <span><strong>{name(a.caller)}</strong> → {name(a.target ?? (a.action === 'escalate' || a.action === 'update' ? null : a.caller))}</span>
            <span className="feed-what" style={{ color: COLOR[a.action] ?? undefined }}>{a.action}</span>
            <span className="muted">{(t => t.length > 90 ? t.slice(0, 90).trimEnd() + '…' : t)(describe(a))}</span>
          </div>
        ))}
        {(directive?.tasks ?? []).some(t => t.status !== 'done' && t.status !== 'dropped') && <h2>Tasks</h2>}
        {(directive?.tasks ?? []).filter(t => t.status === 'open' || t.status === 'claimed').map(t => (
          <div key={t.id} className="feed-row"><span className={`pill ${t.status === 'claimed' ? 'running' : ''}`}>{t.status}</span><span>{t.title}</span><span className="muted">{t.owner ?? ''}</span></div>
        ))}
      </aside>
    </div>
  )
}
