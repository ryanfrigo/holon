import { useEffect, useState } from 'react'
import { holon, type Escalation, type Project } from './holon.ts'
import { UsagePanel } from './Org.tsx'
import { Num } from './Num.tsx'
import { press } from './press.ts'
import { openAskSummary } from '../../../../../packages/core/src/asks.ts'

interface Summary {
  paused: { at: string; reason: string } | null
  directive: { text: string; status: string; autopilot: boolean; workspace: string } | null
  director: { cli: string; model: string | null } | null
  seats: number; working: number
  tokensIn: number; tokensOut: number; costUsd: number
  mergesToday: number; merges7d: number; mergesAll: number
  goalMetrics: { name: string; value?: number; changedAt?: string; error?: string }[]
  openTasks: number; asks: number; lastActionAt: string | null
}
type Row = Summary | { down: true }

// Totals that roll between updates, so spend reads as a live counter.
const POLL = 5_000
// Enough digits that a few thousand tokens visibly move the number.
const short = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(4)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(3)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}k` : String(Math.round(n))
const dollars = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const ago = (ts: string | null) => {
  if (!ts) return '—'
  const m = Math.round((Date.now() - Date.parse(ts)) / 60_000)
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}
// "2d" / "5h" / "20m": how long a number has sat still.
const flat = (ts: string) => { const ms = Date.now() - Date.parse(ts); return ms >= 864e5 ? `${Math.floor(ms / 864e5)}d` : ms >= 36e5 ? `${Math.floor(ms / 36e5)}h` : `${Math.max(0, Math.floor(ms / 6e4))}m` }
const GOALS_SHOWN = 3
// One cell per org: flattest metrics first, so the goal that has not moved leads.
function Goals({ metrics }: { metrics: Summary['goalMetrics'] }) {
  if (!metrics.length) return <span className="muted">no metrics</span>
  const t = (m: Summary['goalMetrics'][number]) => m.changedAt ? Date.parse(m.changedAt) : -Infinity
  const sorted = [...metrics].sort((a, b) => t(a) - t(b))
  return <>
    {sorted.slice(0, GOALS_SHOWN).map(m => (
      <div key={m.name} className={m.error ? 'muted' : undefined}
        title={m.error ?? `${m.name} ${m.value ?? '—'}${m.changedAt ? ` · flat ${flat(m.changedAt)}` : ''}`}>
        {m.error ? <span className="goal-name">{m.error}</span> : <>
          <span className="goal-val">{m.value ?? '—'}{m.changedAt ? ` · flat ${flat(m.changedAt)}` : ''}</span>
          <span className="goal-name muted">{m.name}</span>
        </>}
      </div>))}
    {sorted.length > GOALS_SHOWN && <div className="muted">+{sorted.length - GOALS_SHOWN}</div>}
  </>
}
const stateOf = (r?: Row) => !r ? 'quiet' : 'down' in r ? 'down' : r.paused ? 'paused' : r.working ? 'running' : r.seats ? 'quiet' : 'exited'

// The home screen: every project at a glance — running or paused, its directive and Director,
// seats, merges, tokens and spend — with plan limits across providers in the sidebar.
export function Dashboard({ projects, onOpen }: { projects: Project[]; onOpen: (slug: string) => void }) {
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [busy, setBusy] = useState(false)
  const [asks, setAsks] = useState<Record<string, ReturnType<typeof openAskSummary>>>({})
  const load = () => {
    for (const p of projects) holon.callIn<Escalation[]>(p.slug, 'escalations')
      .then(es => setAsks(a => ({ ...a, [p.slug]: openAskSummary(es) }))).catch(() => {})
    for (const p of projects) holon.callIn<Summary>(p.slug, 'summary')
      .then(s => setRows(r => ({ ...r, [p.slug]: s })))
      .catch(() => setRows(r => ({ ...r, [p.slug]: { down: true } })))
  }
  useEffect(() => {
    load()
    const t = setInterval(load, POLL)
    return () => clearInterval(t)
  }, [projects])

  const live = Object.values(rows).filter((r): r is Summary => !('down' in r))
  const sum = (f: (r: Summary) => number) => live.reduce((s, r) => s + f(r), 0)
  const pausedCount = live.filter(r => r.paused).length
  // Pausing is always safe; resuming spends credits, so it takes a second, deliberate click.
  // Two buttons, never one that flips: a double-click on a flipping button paused then resumed everything.
  const [confirming, setConfirming] = useState(false)
  useEffect(() => { if (!confirming) return; const t = setTimeout(() => setConfirming(false), 5000); return () => clearTimeout(t) }, [confirming])
  const all = async (method: 'pause' | 'resume') => {
    setBusy(true); setConfirming(false)
    try { await Promise.all(projects.map(p => holon.callIn(p.slug, method, { reason: 'paused from the dashboard' }).catch(() => {}))) }
    finally { setBusy(false); load() }
  }

  return (
    <div className="app">
      <aside><UsagePanel /></aside>
      <main className="dash">
        <div className="page">
          <div className="dash-head">
            <h2>All projects</h2>
            <div className="dash-actions">
              <button disabled={busy || pausedCount === live.length} onClick={() => all('pause')}>Pause all</button>
              <button disabled={busy || pausedCount === 0} className={confirming ? 'warn' : ''}
                onClick={() => confirming ? all('resume') : setConfirming(true)}>
                {confirming ? `Click again to resume ${pausedCount} org${pausedCount === 1 ? '' : 's'}` : 'Resume all'}
              </button>
            </div>
          </div>
          <div className="pulse">
            <div><b><Num value={sum(r => r.working)} /></b><span>working</span></div>
            <div><b><Num value={sum(r => r.mergesToday)} /></b><span>merges today</span></div>
            <div><b><Num value={sum(r => r.merges7d)} /></b><span>merges 7d</span></div>
            <div><b><Num value={sum(r => r.tokensIn)} live format={short} /></b><span>tokens in</span></div>
            <div><b><Num value={sum(r => r.tokensOut)} live format={short} /></b><span>tokens out</span></div>
            <div><b><Num value={sum(r => r.costUsd)} live format={dollars} /></b><span>API-equiv</span></div>
          </div>
          <table className="cost dash-rows">
            <thead><tr>
              <th>Status</th><th>Project</th><th>Directive</th><th>Director</th><th>Seats</th>
              <th title="Merges today / 7d / all">Merges d / 7d / all</th><th>Tokens in</th><th>Tokens out</th><th>$ API-equiv</th><th>Goals</th><th>Asks</th><th>Last activity</th>
            </tr></thead>
            <tbody>
              {projects.map(p => {
                const r = rows[p.slug]
                const s = stateOf(r)
                const ok = r && !('down' in r) ? r : null
                return (
                  <tr key={p.slug} {...press(() => onOpen(p.slug))} aria-label={`Open ${p.name}`} title={ok?.directive?.text ?? `Open ${p.name}`}>
                    <td><span className={`dot ${s}`} /> {s}</td>
                    <td>{p.name}</td>
                    <td className="dash-directive">{ok?.directive
                      ? <>{ok.directive.autopilot && <><span className="muted">autopilot</span> </>}{ok.directive.text.split(/(?<=[.!?])\s/)[0]}</>
                      : <span className="muted">{r && 'down' in r ? 'daemon unreachable' : '—'}</span>}</td>
                    <td>{ok?.director ? `${ok.director.cli} ${ok.director.model ?? ''}` : '—'}</td>
                    <td>{ok ? `${ok.working}/${ok.seats}` : ''}</td>
                    <td>{ok ? `${ok.mergesToday} / ${ok.merges7d} / ${ok.mergesAll}` : ''}</td>
                    <td className="n">{ok ? <Num value={ok.tokensIn} live format={short} /> : ''}</td>
                    <td className="n">{ok ? <Num value={ok.tokensOut} live format={short} /> : ''}</td>
                    <td className="n">{ok ? <Num value={ok.costUsd} live format={dollars} /> : ''}</td>
                    <td className="dash-goals">{ok ? <Goals metrics={ok.goalMetrics ?? []} /> : ''}</td>
                    <td className="dash-asks">{ok?.asks ?? ''}{asks[p.slug] && (
                      <div className="muted" title={asks[p.slug]!.blocks}>
                        oldest {asks[p.slug]!.age}{asks[p.slug]!.blocks ? ` · blocks ${asks[p.slug]!.blocks}` : ''}
                      </div>)}</td>
                    <td className="muted">{ok ? ago(ok.lastActionAt) : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
