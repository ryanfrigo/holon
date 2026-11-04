// The org as a game: the roster with grades and records, the culture, and the project's settings.
import { useEffect, useState } from 'react'
import { Num } from './Num.tsx'
import { errorText, GRADE_LABEL, holon, type Department, type Cli, type Directive, type FreePool, type Grade, type ModelUsage, type Plan, type Role, type Settings } from './holon.ts'

const GRADES: Grade[] = [0, 1, 2, 3]

export function Roster({ onOpen }: { onOpen: (id: string) => void }) {
  const [roles, setRoles] = useState<Role[]>([])
  const [reason, setReason] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    const load = () => holon.call<Role[]>('roles').then(setRoles).catch(() => {})
    load()
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [])

  const regrade = async (r: Role, g: Grade) => {
    setError('')
    try { await holon.call('set_grade', { id: r.id, grade: g, reason: reason[r.id]?.trim() || 'set by the human' }) }
    catch (err) { setError(errorText(err)) }
  }
  const depts = roles.filter(r => r.dept)
  const staff = roles.filter(r => !r.dept)
  const card = (r: Role) => (
    <div key={r.id} className={`role ${r.state}`}>
      <div className="role-head">
        <span className={`dot ${r.state}`} />
        <button className="link" onClick={() => setOpen(r.id)} title="Open this role">{r.label}</button>
        {r.dept && <span className="tag">{r.dept}</span>}
        <span className="muted">{r.model ?? r.cli}</span>
      </div>
      {r.grade !== null && (
        <div className="grades">
          {GRADES.map(g => (
            <button key={g} className={`grade g${g} ${r.grade === g ? 'on' : ''} ${r.pendingGrade === g ? 'pending' : ''}`}
              title={GRADE_LABEL[g]} onClick={() => regrade(r, g)}>G{g}</button>
          ))}
          <input placeholder="reason" value={reason[r.id] ?? ''} onChange={e => setReason({ ...reason, [r.id]: e.target.value })} />
        </div>
      )}
      <div className="record">
        <span title="merges landed">⇡ {r.record.merges}</span>
        <span title="tasks done">✓ {r.record.tasksDone}</span>
        <span title="rejected in review">✗ {r.record.rejections}</span>
        <span title="times the watcher found it stuck">⏸ {r.record.stuck}</span>
        {r.record.approvals > 0 && <span title="approvals given">☑ {r.record.approvals}</span>}
        <span title="runway minutes spent">{r.spentMin} min</span>
      </div>
      {r.pendingGrade !== null && <p className="muted">Moves to {GRADE_LABEL[r.pendingGrade]} when it goes quiet.</p>}
      {r.gradeFrom !== null && r.gradeFrom !== r.grade && <p className="warn">Out of quota: running at {GRADE_LABEL[r.grade!]} until {GRADE_LABEL[r.gradeFrom]} resets.</p>}
    </div>
  )
  return (
    <div className="page">
      {error && <p className="error">{error}</p>}
      <Reorganize />
      <h2>Departments · {depts.length}</h2>
      {depts.length === 0 && <p className="muted">No departments yet. Start an org from the Directive box and the Director opens them as the work needs them.</p>}
      <div className="roles">{depts.map(card)}</div>
      <h2>Everyone else · {staff.length}</h2>
      <div className="roles">{staff.map(card)}</div>
      {open && roles.some(r => r.id === open) && (
        <RoleDrawer key={`${open}:${roles.find(r => r.id === open)!.dept ?? ""}`} role={roles.find(r => r.id === open)!} roles={roles} onClose={() => setOpen(null)}
          onTerminal={() => onOpen(open)} onGrade={g => regrade(roles.find(r => r.id === open)!, g)} />
      )}
    </div>
  )
}

// One role, editable: its charter and persona, grade, a seat to promote it into, or firing it.
function RoleDrawer({ role, roles, onClose, onTerminal, onGrade }: {
  role: Role; roles: Role[]; onClose: () => void; onTerminal: () => void; onGrade: (g: Grade) => void
}) {
  const [charter, setCharter] = useState(role.charter ?? '')
  const [persona, setPersona] = useState(role.persona ?? '')
  const [depts, setDepts] = useState<string[]>([])
  const [seat, setSeat] = useState('')
  const [why, setWhy] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => { holon.call<Settings>('settings').then(s => setDepts(s.departments.map(d => d.dept))) }, [])
  const vacant = depts.filter(d => !roles.some(r => r.dept === d))
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setMsg('')
    try { await fn(); setMsg(done) } catch (err) { setMsg(errorText(err)) }
  }
  const isDirector = role.parentId === null && role.lead
  return (
    <div className="drawer">
      <div className="drawer-head">
        <h3>{role.label}{role.dept ? <span className="tag">{role.dept}</span> : null}</h3>
        <button className="kill" onClick={onClose} title="Close">×</button>
      </div>
      <p className="muted">{role.model ?? role.cli} · {role.grade === null ? 'no grade' : GRADE_LABEL[role.grade]} · {role.spentMin} runway min</p>
      {role.grade !== null && (
        <div className="grades">{GRADES.map(g => (
          <button key={g} className={`grade g${g} ${role.grade === g ? 'on' : ''} ${role.pendingGrade === g ? 'pending' : ''}`} onClick={() => onGrade(g)}>G{g}</button>
        ))}</div>
      )}
      <label>Charter<textarea rows={4} value={charter} onChange={e => setCharter(e.target.value)} placeholder="What it owns and must review" /></label>
      <label>Persona<textarea rows={2} value={persona} onChange={e => setPersona(e.target.value)} placeholder="Temperament and voice" /></label>
      <button disabled={charter === (role.charter ?? '') && persona === (role.persona ?? '')}
        onClick={() => act(() => holon.call('update_role', { id: role.id, charter, persona }), 'Saved; the role was told.')}>Save role</button>
      {!isDirector && !role.dept && (
        <div className="drawer-row">
          <select value={seat} onChange={e => setSeat(e.target.value)}>
            <option value="">Promote to head of…</option>
            {vacant.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <button disabled={!seat} onClick={() => act(() => holon.call('promote', { id: role.id, dept: seat }), `Promoted to head of ${seat}.`)}>Promote</button>
        </div>
      )}
      {!isDirector && (
        <div className="drawer-row">
          <input placeholder="Reason for firing" value={why} onChange={e => setWhy(e.target.value)} />
          <button className="danger" disabled={!why.trim()} onClick={() => act(async () => { await holon.call('fire', { id: role.id, reason: why }); onClose() }, 'Fired.')}>Fire</button>
        </div>
      )}
      <button onClick={onTerminal}>Open terminal</button>
      {msg && <p className="muted">{msg}</p>}
    </div>
  )
}

export function Culture() {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    holon.call<string>('culture').then(t => { setText(t); setSaved(t) })
    return holon.onEvent(({ event, payload }) => { if (event === 'culture') { setText(payload); setSaved(payload) } })
  }, [])
  const save = async () => {
    setError('')
    try { await holon.call('set_culture', { text, reason: 'edited by the human' }); setSaved(text) }
    catch (err) { setError(errorText(err)) }
  }
  return (
    <div className="page">
      <h2>CULTURE.md</h2>
      <p className="muted">Every role is briefed with this. The Director writes it when the org is founded and amends it; your edits win.</p>
      <textarea className="culture" rows={18} value={text} onChange={e => setText(e.target.value)}
        placeholder="What the org values, how decisions get made, what done means." />
      <button onClick={save} disabled={text === saved}>Save culture</button>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

const POOLS: { id: FreePool; label: string; note: string }[] = [
  { id: 'opencode', label: 'OpenCode free models', note: 'big-pickle, or subscription models with Go enabled' },
  { id: 'omniroute', label: 'OmniRoute gateway', note: 'local free-coding combo with automatic fallback' },
  { id: 'openrouter', label: 'OpenRouter :free', note: '~1000 requests a day, shared by every terminal' },
]

export function SettingsView({ directive }: { directive: Directive | null }) {
  const [s, setS] = useState<Settings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [heartbeat, setHeartbeat] = useState(String(directive?.heartbeatMin ?? 10))
  const [msg, setMsg] = useState('')
  useEffect(() => { holon.call<Settings>('settings').then(setS) }, [])
  // A model row for a CLI that is not installed would only invite editing something that never runs.
  const [clis, setClis] = useState<Cli[] | null>(null)
  useEffect(() => { holon.clis().then(setClis).catch(() => {}) }, [])
  const shows = (c: Cli) => !clis || clis.includes(c) || !(clis.includes('claude') || clis.includes('codex'))
  if (!s) return <div className="page"><p className="muted">Loading settings…</p></div>
  const edit = (next: Settings) => { setS(next); setDirty(true); setMsg('') }
  const dept = (i: number, patch: Partial<Department>) => edit({ ...s, departments: s.departments.map((d, j) => (j === i ? { ...d, ...patch } : d)) })
  const save = async () => {
    try {
      setS(await holon.call<Settings>('set_settings', { settings: s }))
      if (directive) await holon.call('set_heartbeat', { minutes: Number(heartbeat) || null })
      setDirty(false); setMsg('Saved. New roles and reseats use these settings.')
    } catch (err) { setMsg(errorText(err)) }
  }
  return (
    <div className="page settings">
      <section>
        <h2>Free labour (G0)</h2>
        {POOLS.map(p => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={s.freePools[p.id]} onChange={e => edit({ ...s, freePools: { ...s.freePools, [p.id]: e.target.checked } })} />
            {p.label} <span className="muted">{p.note}</span>
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={s.opencodeGo} onChange={e => edit({ ...s, opencodeGo: e.target.checked })} />
          Use my OpenCode Go subscription for OpenCode roles
        </label>
        <p className="muted">G0 roles rotate across the pools that are on. With all off, G0 runs on G1.</p>
        <label className="check">
          <input type="checkbox" checked={s.freeFirst} onChange={e => edit({ ...s, freeFirst: e.target.checked })} />
          Free first: builders run on G0 unless their lead gives a reason for paid labor
        </label>
        <label className="check">
          <input type="checkbox" checked={s.directiveApproval} onChange={e => edit({ ...s, directiveApproval: e.target.checked })} />
          The Director's changes to the directive wait for my approval
        </label>
      </section>
      <section>
        <h2>Limits</h2>
        <label className="check">Pause the org for the rest of the day once it spends $
          <input className="num" type="number" min={0} step={1} value={s.dailyCapUsd} onChange={e => edit({ ...s, dailyCapUsd: Number(e.target.value) })} />
          API-equivalent (0 = no cap)
        </label>
        <label className="check">
          <input type="checkbox" checked={!!s.runWindow} onChange={e => edit({ ...s, runWindow: e.target.checked ? { start: '09:00', end: '18:00' } : null })} />
          Run only between
          <input type="time" value={s.runWindow?.start ?? '09:00'} disabled={!s.runWindow} onChange={e => edit({ ...s, runWindow: { start: e.target.value, end: s.runWindow?.end ?? '18:00' } })} />
          and
          <input type="time" value={s.runWindow?.end ?? '18:00'} disabled={!s.runWindow} onChange={e => edit({ ...s, runWindow: { start: s.runWindow?.start ?? '09:00', end: e.target.value } })} />
        </label>
      </section>
      <section>
        <h2>Models per grade</h2>
        <div className="grid3">
          {shows('claude') && ([1, 2, 3] as const).map(g => (
            <label key={g}>{GRADE_LABEL[g]} · Claude
              <input value={s.gradeModels.claude[g]} onChange={e => edit({ ...s, gradeModels: { ...s.gradeModels, claude: { ...s.gradeModels.claude, [g]: e.target.value } } })} />
            </label>
          ))}
          {shows('codex') && ([1, 2, 3] as const).map(g => (
            <label key={g}>{GRADE_LABEL[g]} · Codex
              <input value={s.gradeModels.codex[g]} onChange={e => edit({ ...s, gradeModels: { ...s.gradeModels, codex: { ...s.gradeModels.codex, [g]: e.target.value } } })} />
            </label>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={s.quotaFallback} onChange={e => edit({ ...s, quotaFallback: e.target.checked })} />
          Out of quota: drop a role one grade instead of stalling; retry after
          <input className="num" type="number" min={5} value={s.fallbackRetryMin} onChange={e => edit({ ...s, fallbackRetryMin: Number(e.target.value) })} /> min
        </label>
        {directive && (
          <label className="check">Nudge the Director after the org is idle for
            <input className="num" type="number" min={5} value={heartbeat} onChange={e => { setHeartbeat(e.target.value); setDirty(true) }} /> min
          </label>
        )}
      </section>
      <section>
        <h2>Departments template</h2>
        <p className="muted">What the Director opens with open_department. Gates: Security-style path patterns (regex), or QA-style review of every G0 merge.</p>
        {s.departments.map((d, i) => (
          <div key={i} className="dept">
            <div className="dept-row">
              <input className="dept-name" value={d.dept} onChange={e => dept(i, { dept: e.target.value })} />
              <select value={d.grade} onChange={e => dept(i, { grade: Number(e.target.value) as Grade })}>
                {GRADES.map(g => <option key={g} value={g}>{GRADE_LABEL[g]}</option>)}
              </select>
              <label className="check"><input type="checkbox" checked={!!d.gate?.freeBuilders}
                onChange={e => dept(i, { gate: { ...d.gate, freeBuilders: e.target.checked } })} /> reviews G0 merges</label>
              <button className="kill" title="Remove department" onClick={() => edit({ ...s, departments: s.departments.filter((_, j) => j !== i) })}>×</button>
            </div>
            <textarea rows={2} value={d.charter} placeholder="Charter: what it owns and must review" onChange={e => dept(i, { charter: e.target.value })} />
            <textarea rows={1} value={d.persona} placeholder="Persona" onChange={e => dept(i, { persona: e.target.value })} />
            <input value={(d.gate?.paths ?? []).join(', ')} placeholder="Gate paths (regex, comma-separated)"
              onChange={e => dept(i, { gate: { ...d.gate, paths: e.target.value.split(',').map(x => x.trim()).filter(Boolean) } })} />
          </div>
        ))}
        <button onClick={() => edit({ ...s, departments: [...s.departments, { dept: 'New department', charter: '', persona: '', grade: 2 }] })}>+ Department</button>
      </section>
      <div className="save-bar">
        <button onClick={save} disabled={!dirty}>Save settings</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
  )
}

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const until = (iso?: string) => {
  if (!iso) return ''
  const m = Math.round((Date.parse(iso) - Date.now()) / 60_000)
  return m <= 0 ? 'resets now' : m < 90 ? `resets in ${m}m` : m < 48 * 60 ? `resets in ${Math.round(m / 60)}h` : `resets in ${Math.round(m / 1440)}d`
}

// Bottom-left: plan limits for every connected provider, and tokens by model across all projects.
export function UsagePanel() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [usage, setUsage] = useState<ModelUsage[]>([])
  const [at, setAt] = useState<number | null>(null)
  const [advice, setAdvice] = useState<{ text: string; at: string; path: string } | null>(null)
  const [showAdvice, setShowAdvice] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    const load = () => {
      holon.plans().then(setPlans).catch(() => {})
      holon.usage().then(u => { setUsage(u); setAt(Date.now()) }).catch(() => {})
      holon.advice().then(setAdvice).catch(() => {})
    }
    load()
    const t = setInterval(load, 30_000)
    const clock = setInterval(() => tick(n => n + 1), 5_000)
    return () => { clearInterval(t); clearInterval(clock) }
  }, [])
  return (
    <section className="usage-panel">
      {advice && (
        <div className="advice" onClick={() => setShowAdvice(v => !v)} title="From the Finance seat; click to expand">
          <h2>Worth paying for? <span className="muted">· {new Date(advice.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></h2>
          {(showAdvice ? advice.text.split('\n') : advice.text.split('\n').filter(l => /^\s*[-*] /.test(l)).slice(0, 3))
            .filter(l => l.trim() && !l.startsWith('#')).map((l, i) => <p key={i}>{l.replace(/^\s*[-*] /, '')}</p>)}
          <button className="link" onClick={e => { e.stopPropagation(); holon.open('file', advice.path) }}>Open full advice</button>
        </div>
      )}
      <h2>Plan limits</h2>
      {plans.filter(p => p.bars.length || p.error || !/^(\$0\.00 in 7d · )?0\.0M tokens/.test(p.plan ?? '')).map(p => (
        <div key={p.provider} className="plan">
          <div className="plan-head"><b>{p.provider}</b><span className="muted">{p.plan ?? ''}</span></div>
          {p.bars.filter(b => b.usedPct > 0 || b.resetsAt).map(b => {
            const out = / limit reached$/.test(b.label)   // a wall, not a gauge: say so
            return (
              <div key={b.label} className="plan-bar" title={b.resetsAt ? new Date(b.resetsAt).toLocaleString() : ''}>
                <span className="muted">{out ? b.label.replace(/ reached$/, '') : b.label}</span>
                <span className="bar"><span className={`fill ${out || b.usedPct > 85 ? 'low' : b.usedPct > 60 ? 'mid' : 'ok'}`} style={{ width: `${b.usedPct}%` }} /></span>
                <span>{out ? 'out' : `${b.usedPct}%`}</span>
                <span className="muted reset">{out ? `out · ${until(b.resetsAt)}` : until(b.resetsAt)}</span>
              </div>
            )
          })}
          {(p.error || p.note) && <p className="muted">{p.error === 'not signed in' ? 'not signed in: run claude in a terminal and sign in' : p.error ?? p.note}</p>}
          <p className="muted">checked {new Date(p.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
        </div>
      ))}
      <h2>Tokens by model <span className="muted">· all projects{usage.length && at ? ` · updated ${Math.round((Date.now() - at) / 1000)}s ago` : ''}</span></h2>
      {usage.length === 0 && <p className="muted">No usage yet. Token counts per model appear once an agent has run.</p>}
      {usage.length > 0 && (
        <p className="muted">≈ <Num value={usage.reduce((s, u) => s + u.usd, 0)} format={n => `$${Math.round(n)}`} /> at API prices · <Num value={usage.reduce((s, u) => s + u.output, 0)} format={fmt} /> written · <Num value={usage.reduce((s, u) => s + u.cacheRead, 0)} format={fmt} /> cache re-reads (cheap; most of the total)</p>
      )}
      {usage.slice(0, 8).map(u => (
        <div key={u.cli + u.model} className="model-row" title={`${fmt(u.tokens)} tokens in all, ${fmt(u.cacheRead)} of them cache re-reads; ${u.agents} agents`}>
          <span>{u.model}</span>
          <span className="muted"><Num value={u.output} format={fmt} /> out</span>
          <b>{u.usd >= 1 ? <Num value={u.usd} format={n => `$${Math.round(n)}`} /> : u.usd > 0 ? '<$1' : 'free'}</b>
        </div>
      ))}
    </section>
  )
}

// Change a running org's shape. Nothing is lost: knowledge, backlog, goals and repo carry over.
function Reorganize() {
  const [to, setTo] = useState<'designed' | 'departments' | 'lean' | 'holon'>('designed')
  const [design, setDesign] = useState<Department[] | null>(null)
  const [busy, setBusy] = useState('')
  const [sure, setSure] = useState(false)
  const [msg, setMsg] = useState('')
  const [current, setCurrent] = useState('')
  useEffect(() => { holon.call<Directive | null>('directive').then(d => setCurrent(d ? `${d.shape === 'holon' ? 'peer ring' : d.template ?? 'lean'}` : '')) }, [])
  if (!current) return null
  const preview = async () => {
    setBusy('Designing…'); setMsg('')
    try { setDesign(await holon.call<Department[]>('design_org', {})) } catch (e) { setMsg(errorText(e)) } finally { setBusy('') }
  }
  const go = async () => {
    if (!sure) { setSure(true); return }
    setBusy('Reorganizing…'); setMsg('')
    try {
      let departments = design ?? undefined
      if (to === 'designed' && !departments) departments = await holon.call<Department[]>('design_org', {})
      await holon.call('reshape', { shape: to === 'holon' ? 'holon' : 'hierarchy', template: to === 'lean' ? 'lean' : 'departments', departments: to === 'designed' ? departments : undefined })
      setMsg('Reorganized. The new leadership was briefed on everything before it.'); setSure(false); setDesign(null)
    } catch (e) { setMsg(errorText(e)) } finally { setBusy('') }
  }
  return (
    <div className="reorg">
      <span className="muted">Shape now: <b>{current}</b></span>
      <select value={to} onChange={e => { setTo(e.target.value as typeof to); setSure(false) }}>
        <option value="designed">Designed for this directive</option>
        <option value="departments">Departments template</option>
        <option value="lean">Lean hierarchy</option>
        <option value="holon">Peer ring</option>
      </select>
      {to === 'designed' && <button disabled={!!busy} onClick={preview}>Preview design</button>}
      <button className={sure ? 'danger' : ''} disabled={!!busy} onClick={go}>{busy || (sure ? 'Confirm: close the current leadership and reorganize' : 'Reorganize')}</button>
      {msg && <span className="muted">{msg}</span>}
      {design && (
        <div className="reorg-design">
          {design.map((d, i) => <p key={i}><b>{d.dept}</b> <span className="muted">G{d.grade}{d.gate ? ' · gate' : ''}</span> {d.charter}</p>)}
        </div>
      )}
    </div>
  )
}
