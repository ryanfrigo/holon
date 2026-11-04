// Org health: a handful of signals computed from the org's own log, each with a status and one
// plain line on why, so the owner can tell at a glance whether the org is working.
import { useEffect, useState } from 'react'
import { Num } from './Num.tsx'
import { holon, type Action, type Directive, type Escalation, type Role } from './holon.ts'

type Level = 'good' | 'watch' | 'bad'
interface Signal { name: string; value: string; level: Level; why: string; na?: boolean }  // na: nothing to measure, so it counts neither way

const H = 3_600_000
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const mins = (ms: number) => (ms < H ? `${Math.round(ms / 60_000)}m` : `${(ms / H).toFixed(1)}h`)

export function health(actions: Action[], roles: Role[], escalations: Escalation[], directive: Directive | null = null, now = Date.now()): Signal[] {
  const since = (h: number) => actions.filter(a => now - Date.parse(a.ts) < h * H)
  const last6 = since(6)
  const merges = last6.filter(a => a.action === 'merged')
  const spawnAt = new Map(actions.filter(a => a.action === 'spawn' && a.target).map(a => [a.target!, Date.parse(a.ts)]))
  const cycle = merges.map(m => m.target && spawnAt.has(m.target) ? Date.parse(m.ts) - spawnAt.get(m.target)! : null).filter((x): x is number => x !== null)
  const cyc = median(cycle)
  const openEsc = escalations.filter(e => e.status === 'open')
  const oldest = openEsc.length ? Math.max(...openEsc.map(e => now - Date.parse(e.ts))) : 0
  const heals = since(2).filter(a => a.action === 'heal' || a.action === 'quota_fallback')
  const rejects = last6.filter(a => a.action === 'reject' || a.action === 'merge_refused').length
  const approvals = last6.filter(a => a.action === 'approve').length
  const agents = roles.filter(r => r.grade !== null)
  const spent = agents.reduce((s, r) => s + r.spentMin, 0)
  const freeAgents = agents.filter(r => r.grade === 0).length
  // Runway is only metered when the org has a budget; without one, spend is unknown rather than zero.
  const perMerge = merges.length && spent > 0 ? Math.round(spent / Math.max(1, actions.filter(a => a.action === 'merged').length)) : null
  const idleSeats = roles.filter(r => r.dept && r.state !== 'running' && !last6.some(a => a.caller === r.id && Date.parse(a.ts) > now - H)).length

  const backlog = (directive?.messages ?? []).filter(m => m.status !== 'done' && m.status !== 'declined')
  const staleItems = backlog.filter(m => now - Date.parse(m.actions?.at(-1)?.ts ?? m.ts) > 2 * H)
  return [
    { name: 'Your backlog', value: `${backlog.length} open`, level: staleItems.length ? 'bad' : backlog.some(m => !m.owner) ? 'watch' : 'good',
      why: staleItems.length ? `${staleItems.length} of your items untouched for 2h+: ${staleItems.map(m => m.title ?? m.text.slice(0, 30)).slice(0, 2).join('; ')}` : backlog.length ? `${backlog.filter(m => !m.owner).length} without an owner yet` : 'everything you asked for is done or declined' },
    { name: 'Throughput', value: `${merges.length} merges / 6h`, level: merges.length >= 3 ? 'good' : merges.length ? 'watch' : 'bad',
      why: merges.length ? `${(merges.length / 6).toFixed(1)} an hour landing on the main branch` : 'nothing merged in 6 hours: check what the departments are blocked on' },
    { name: 'Idea to merge', value: cyc === null ? '—' : mins(cyc), level: cyc === null ? 'watch' : cyc < 1.5 * H ? 'good' : cyc < 4 * H ? 'watch' : 'bad',
      why: cyc === null ? 'no builder has spawned and merged in this window yet' : `median time from a builder starting to its work landing (${cycle.length} merges)` },
    { name: 'Waiting', value: `${openEsc.length} open`, level: !openEsc.length ? 'good' : oldest < 15 * 60_000 ? 'watch' : 'bad',
      why: openEsc.length ? `oldest unanswered for ${mins(oldest)}; whoever asked is blocked until then` : 'nobody is blocked on an answer' },
    { name: 'Stuck agents', value: `${heals.length} / 2h`, level: heals.length === 0 ? 'good' : heals.length < 4 ? 'watch' : 'bad',
      why: heals.length ? `the watcher stepped in ${heals.length}× (menus, prompts, quota): ${[...new Set(heals.map(h => String(h.args.issue ?? h.action)))].slice(0, 3).join(', ')}` : 'no agent needed rescuing' },
    { name: 'Review quality', value: `${approvals} ok · ${rejects} sent back`, level: rejects > approvals + 2 ? 'bad' : rejects > approvals ? 'watch' : 'good',
      why: rejects ? 'work sent back by a gate or failing tests; many means builders get unclear tasks' : 'work is passing its gates' },
    { name: 'Free labour', value: agents.length ? `${Math.round((freeAgents / agents.length) * 100)}%` : '—', level: freeAgents / Math.max(1, agents.length) >= 0.5 ? 'good' : freeAgents ? 'watch' : 'bad',
      why: `${freeAgents} of ${agents.length} agents run on free models` },
    { name: 'Runway per merge', value: perMerge === null ? '—' : `${perMerge} min`, na: perMerge === null && spent === 0, level: perMerge === null ? 'watch' : perMerge < 60 ? 'good' : perMerge < 180 ? 'watch' : 'bad',
      why: perMerge === null && spent === 0 ? 'no runway budget set for this org, so spend is not metered' : 'agent-minutes of paid labour spent for each change that landed' },
    { name: 'Idle seats', value: `${idleSeats}`, level: idleSeats === 0 ? 'good' : idleSeats < 3 ? 'watch' : 'bad',
      why: idleSeats ? 'department heads with nothing done in the last hour: give them goals or close the seat' : 'every department is active' },
  ]
}

// A signal's value is a phrase with a number in it; the number eases to its new value.
function SignalValue({ value }: { value: string }) {
  const parts = value.split(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)/g)
  return (
    <>
      {parts.map((p, i) => i % 2 === 1
        ? <Num key={i} value={Number(p.replace(/,/g, ''))} format={fmtFor(p)} />
        : p ? <span key={i}>{p}</span> : null)}
    </>
  )
}

// Keeps the number's own shape: 1,234 stays grouped, 12.3 keeps its decimal.
const fmtFor = (token: string) => {
  const decimals = token.includes('.') ? token.split('.')[1].length : 0
  const grouped = token.includes(',')
  return (n: number) => {
    const v = decimals ? n.toFixed(decimals) : String(Math.round(n))
    return grouped ? Number(v).toLocaleString() : v
  }
}

export function Health({ actions, escalations, directive }: { actions: Action[]; escalations: Escalation[]; directive: Directive | null }) {
  const [roles, setRoles] = useState<Role[]>([])
  useEffect(() => {
    const load = () => holon.call<Role[]>('roles').then(setRoles).catch(() => {})
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [])
  // Nothing to measure before an org exists: red cards for work nobody has been asked to do mislead.
  if (roles.length === 0 && !directive?.text) return <div className="page"><div className="welcome"><h3>Health fills in once an org is running.</h3><p>This page scores the org on merges landed, time from idea to merge, stuck agents, review quality and how much work runs on free models. Start an org from the Directive box on the left.</p></div></div>
  const signals = health(actions, roles, escalations, directive)
  const measured = signals.filter(s => !s.na)
  const score = measured.filter(s => s.level === 'good').length
  const overall: Level = measured.some(s => s.level === 'bad') ? (score >= 5 ? 'watch' : 'bad') : score >= 6 ? 'good' : 'watch'
  return (
    <div className="page">
      <div className={`health-head ${overall}`}>
        <b>{overall === 'good' ? 'Healthy' : overall === 'watch' ? 'Needs a look' : 'Struggling'}</b>
        <span><Num value={score} /> of {measured.length} signals green{measured.some(s => s.level !== 'good') ? ` (look at: ${measured.filter(s => s.level !== 'good').map(s => s.name.toLowerCase()).join(', ')})` : ''}{directive?.digest ? ` · ${directive.digest.text.split('\n')[0].replace(/^- /, '')}` : ''}</span>
      </div>
      <div className="signals">
        {signals.map(s => (
          <div key={s.name} className={`signal ${s.na ? 'na' : s.level}`}>
            <span className="muted">{s.name}</span>
            <b><SignalValue value={s.value} /></b>
            <p>{s.why}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
