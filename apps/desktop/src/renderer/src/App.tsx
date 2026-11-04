import { useEffect, useMemo, useRef, useState } from 'react'
import { errorText, holon, setProject, type Action, type Cli, type Directive, type Escalation, type Node, type Project } from './holon.ts'
import { Pane } from './Pane.tsx'
import { Board, InboxCard } from './Board.tsx'
import { Num } from './Num.tsx'
import { press } from './press.ts'
import { OrgMap } from './Map.tsx'
import { Culture, Roster, SettingsView, UsagePanel } from './Org.tsx'
import { Health } from './Health.tsx'
import { Memory } from './Memory.tsx'
import { Dashboard } from './Dashboard.tsx'

type View = 'board' | 'health' | 'map' | 'org' | 'terminals' | 'culture' | 'memory' | 'settings'

// Projects across the top: one company per tab, each with its own daemon, org and settings.
export function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [slug, setSlug] = useState('')
  const [asks, setAsks] = useState<Record<string, number>>({})
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    holon.projects().then(ps => { setProjects(ps); setSlug(s => s || 'dashboard') })
  }, [])
  // A notification click opens the app on the org that asked.
  useEffect(() => holon.onOpenProject(setSlug), [])
  // Every tab shows how many asks are waiting on you in it.
  useEffect(() => {
    const load = () => projects.forEach(p => holon.callIn<Escalation[]>(p.slug, 'escalations')
      .then(es => setAsks(a => ({ ...a, [p.slug]: es.filter(e => e.to === null && e.status === 'open').length }))).catch(() => {}))
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [projects])
  if (!slug) return <div className="shell"><nav className="projects drag" /></div>
  setProject(slug)
  const project = projects.find(p => p.slug === slug)!
  return (
    <div className="shell">
      <nav className="projects drag">
        <button className={slug === 'dashboard' ? 'on' : ''} onClick={() => setSlug('dashboard')}>All projects</button>
        {projects.map(p => (
          <button key={p.slug} className={p.slug === slug ? 'on' : ''} onClick={() => setSlug(p.slug)}>
            {p.name}{asks[p.slug] ? <span className="badge"><Num value={asks[p.slug]} /></span> : null}
          </button>
        ))}
        <button className="add" title="Add a project" aria-label="Add a project" onClick={() => setAdding(a => !a)}>+</button>
        {adding && <AddProject onAdded={p => { setProjects(ps => [...ps, p]); setSlug(p.slug); setAdding(false) }} />}
      </nav>
      {slug === 'dashboard'
        ? <Dashboard projects={projects} onOpen={setSlug} />
        : <Org key={slug} project={project} />}
    </div>
  )
}

// Stops every agent in this org (nothing runs, nothing spends) until resumed; survives restarts.
function PauseToggle({ paused }: { paused: { at: string; reason: string } | null }) {
  const [busy, setBusy] = useState(false)
  // Resuming spends credits: it takes a second click, so a double-click on Pause can't undo itself.
  const [confirming, setConfirming] = useState(false)
  useEffect(() => { if (!confirming) return; const t = setTimeout(() => setConfirming(false), 5000); return () => clearTimeout(t) }, [confirming])
  const run = async (method: 'pause' | 'resume') => {
    setBusy(true); setConfirming(false)
    try { await holon.call(method, { reason: 'paused from the app' }) } finally { setBusy(false) }
  }
  return (
    <section className="pause">
      {paused && <h2>Paused since {new Date(paused.at).toLocaleString()}</h2>}
      {paused
        ? <button disabled={busy} className={confirming ? 'warn' : ''} onClick={() => confirming ? run('resume') : setConfirming(true)}>
            {confirming ? 'Click again to resume' : 'Resume org'}
          </button>
        : <button disabled={busy} onClick={() => run('pause')}>Pause org</button>}
    </section>
  )
}

function AddProject({ onAdded }: { onAdded: (p: Project) => void }) {
  const [name, setName] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const choose = async () => {
    const dir = await holon.pickFolder()
    if (!dir) return
    setWorkspace(dir)
    if (!name.trim()) setName(dir.split('/').filter(Boolean).pop() ?? '')
  }
  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { onAdded(await holon.addProject(name, workspace || undefined)) }
    catch (err) { setError(errorText(err).replace(/^Error invoking remote method 'holon:addProject': Error: /, '')) }
    finally { setBusy(false) }
  }
  return (
    <form className="add-project" onSubmit={add}>
      <button type="button" onClick={choose}>Choose folder…</button>
      <input placeholder="Repo or folder" value={workspace} onChange={e => setWorkspace(e.target.value)} title="Where its org works" />
      <input autoFocus placeholder="Name (defaults to the folder)" value={name} onChange={e => setName(e.target.value)} />
      <button type="submit" disabled={busy || !(name.trim() || workspace.trim())}>{busy ? 'Starting…' : 'Add'}</button>
      {error && <span className="error">{error}</span>}
    </form>
  )
}

function Org({ project }: { project: Project }) {
  const [nodes, setNodes] = useState<Node[]>([])
  const [actions, setActions] = useState<Action[]>([])
  const [escalations, setEscalations] = useState<Escalation[]>([])
  const [directive, setDirective] = useState<Directive | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [view, setView] = useState<View>('board')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [paused, setPaused] = useState<{ at: string; reason: string } | null>(null)
  const [seats, setSeats] = useState<Node[]>([])

  useEffect(() => {
    const refresh = () => holon.call<Node[]>('list').then(setNodes)
    const loadPaused = () => {
      holon.call('paused').then(setPaused)
      holon.call<Node[]>('paused_seats').then(setSeats)
    }
    loadPaused()
    refresh()
    holon.call<Action[]>('actions').then(setActions)
    holon.call<Escalation[]>('escalations').then(setEscalations)
    holon.call<Directive | null>('directive').then(setDirective)
    const off = holon.onEvent(({ event, payload }) => {
      if (event === 'org') setNodes(payload)
      if (event === 'exit') refresh()
      if (event === 'action') setActions(a => [...a.slice(-499), payload])
      if (event === 'escalation') setEscalations(payload)
      if (event === 'directive') setDirective({ ...payload })
      if (event === 'paused') loadPaused()
    })
    const timer = setInterval(refresh, 1000) // keeps states and headlines current
    // Asks and the directive are re-read too, so a missed event can't hide an ask.
    const slow = setInterval(() => {
      holon.call<Escalation[]>('escalations').then(setEscalations)
      holon.call<Directive | null>('directive').then(d => setDirective(d && { ...d }))
    }, 5000)
    return () => { off(); clearInterval(timer); clearInterval(slow) }
  }, [])

  // A paused org shows the seats it will bring back, so its chart and directive stay visible.
  const shown = useMemo(() => paused ? [...nodes, ...seats.filter(s => !nodes.some(n => n.id === s.id))] : nodes, [nodes, seats, paused])
  const labels = useMemo(() => new Map(shown.map(n => [n.id, n.label])), [shown])
  const open = (id: string) => { setFocus(id); setExpanded(id); setView('terminals') }
  const asks = escalations.filter(e => e.to === null && e.status === 'open')
  const inbox = escalations.filter(e => e.to === null && e.status === 'open').length

  return (
    <div className="app">
      <aside>
        <div className="brand drag">
          <img src="./icon.png" alt="" />
          <span>holon</span>
        </div>
        {asks.length > 0 && (
          <section className="asks">
            <h2>Asks for you · <Num value={asks.length} /></h2>
            {asks.map(e => <InboxCard key={e.id} esc={e} from={labels.get(e.from) ?? e.from} compact />)}
          </section>
        )}
        {(paused || nodes.length > 0) && <PauseToggle paused={paused} />}
        <OrgTree nodes={shown} parentId={null} focus={focus} onOpen={open} />
        {!paused && !(directive?.status === 'running' && nodes.some(n => n.id === directive.directorId)) && <NewDirective project={project} running={false} onStarted={() => setView('board')} />}
        <details className="new-terminal">
          <summary>New terminal</summary>
          <NewTerminal nodes={nodes} workspace={directive?.workspace ?? project.workspace ?? holon.home} onCreated={open} />
        </details>
        <UsagePanel />
      </aside>
      <main>
        <nav className="toolbar drag">
          <div className="tabs">
            <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>
              Board{inbox > 0 && <span className="badge"><Num value={inbox} /></span>}
            </button>
            <button className={view === 'health' ? 'on' : ''} onClick={() => setView('health')}>Health</button>
            <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>Map</button>
            <button className={view === 'org' ? 'on' : ''} onClick={() => setView('org')}>Org</button>
            <button className={view === 'terminals' ? 'on' : ''} onClick={() => setView('terminals')}>Terminals</button>
            <button className={view === 'culture' ? 'on' : ''} onClick={() => setView('culture')}>Culture</button>
            <button className={view === 'memory' ? 'on' : ''} onClick={() => setView('memory')}>Memory</button>
            <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}>Settings</button>
          </div>
        </nav>
        {view === 'health' ? <Health actions={actions} escalations={escalations} directive={directive} />
          : view === 'org' ? <Roster onOpen={open} />
          : view === 'culture' ? <Culture />
          : view === 'memory' ? <Memory />
          : view === 'settings' ? <SettingsView directive={directive} />
          : view === 'map'
          ? <OrgMap nodes={shown} actions={actions} escalations={escalations} directive={directive} onOpen={open} />
          : view === 'board'
          ? <Board nodes={shown} actions={actions} escalations={escalations} directive={directive} labels={labels} onOpen={open} />
          : expanded && nodes.some(n => n.id === expanded)
            ? <div className="single">
                <div className="strip">
                  <button className="back" onClick={() => setExpanded(null)}>⊞ All terminals</button>
                  {nodes.map(n => (
                    <button key={n.id} className={`strip-item ${n.id === expanded ? 'on' : ''}`} onClick={() => { setExpanded(n.id); setFocus(n.id) }}>
                      <span className={`dot ${n.state}`} />{n.label}
                    </button>
                  ))}
                </div>
                {nodes.filter(n => n.id === expanded).map(n => (
                  <Pane key={n.id} node={n} parentLabel={n.parentId ? labels.get(n.parentId) : undefined}
                    focused onFocus={() => setFocus(n.id)} expanded onToggle={() => setExpanded(null)} />
                ))}
              </div>
            : <div className="panes" data-count={Math.min(nodes.length, 4)}>
                {nodes.length === 0 && <p className="empty">No terminals yet. Start a directive, or create a terminal.</p>}
                {nodes.map(n => (
                  <Pane key={n.id} node={n} parentLabel={n.parentId ? labels.get(n.parentId) : undefined}
                    focused={focus === n.id} onFocus={() => setFocus(n.id)} onToggle={() => { setExpanded(n.id); setFocus(n.id) }} />
                ))}
              </div>}
        <ActionLog actions={actions} labels={labels} />
      </main>
    </div>
  )
}

function OrgTree({ nodes, parentId, focus, onOpen }: {
  nodes: Node[]; parentId: string | null; focus: string | null; onOpen: (id: string) => void
}) {
  const children = nodes.filter(n => n.parentId === parentId)
  if (!children.length) return null
  return (
    <ul className="tree">
      {children.map(n => (
        <li key={n.id}>
          <div className={`node ${focus === n.id ? 'focused' : ''}`} {...press(() => onOpen(n.id))} aria-label={`Open ${n.label}`}>
            <span className={`dot ${n.state}`} />
            <span>{n.label}</span>
            <span className="muted">{n.cli}</span>
            <button className="kill" title="Kill (and its reports)" aria-label={`Kill ${n.label} and its reports`}
              onClick={e => { e.stopPropagation(); holon.call('kill', { id: n.id }) }}>×</button>
          </div>
          <OrgTree nodes={nodes} parentId={n.id} focus={focus} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  )
}

function NewDirective({ project, running, onStarted }: { project: Project; running: boolean; onStarted: () => void }) {
  const [text, setText] = useState('')
  const [workspace, setWorkspace] = useState(project.workspace ?? `${holon.home}/holon-orgs/`)
  const [shape, setShape] = useState<'holon' | 'hierarchy' | 'departments' | 'designed'>('designed')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [suggesting, setSuggesting] = useState(false)
  async function suggest() {
    setSuggesting(true); setError('')
    try { setText((await holon.call<{ text: string }>('draft_directive', { workspace })).text) }
    catch (err) { setError(errorText(err)) }
    finally { setSuggesting(false) }
  }

  async function start(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setError('')
    try {
      const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
      const ws = workspace.endsWith('/') ? workspace + slug : workspace
      onStarted()
      if (shape === 'designed') {
        // Departments fitted to this directive and repo; the template is the fallback if drafting fails.
        try { await holon.call('set_settings', { settings: { departments: await holon.call('design_org', { text: text.trim(), workspace: ws }) } }) } catch {}
      }
      await holon.call('start_directive', {
        text: text.trim(), workspace: ws, heartbeatMin: 10,
        shape: shape === 'holon' ? 'holon' : 'hierarchy', template: shape === 'departments' || shape === 'designed' ? 'departments' : 'lean',
      })
      setText('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="form" onSubmit={start}>
      <h2>Directive</h2>
      <textarea rows={4} placeholder="What should the org accomplish? e.g. Launch a landing page and waitlist for a local sauna booking app"
        value={text} onChange={e => setText(e.target.value)} disabled={running} />
      <input value={workspace} onChange={e => setWorkspace(e.target.value)} disabled={running} title="Workspace folder" />
      <button type="button" className="suggest" disabled={running || suggesting || workspace.endsWith('/')} onClick={suggest}
        title="A free model reads the folder (README, package files, docs) and drafts a directive for you to edit">
        {suggesting ? 'Reading the repo…' : 'Suggest a directive from this folder'}
      </button>
      <select value={shape} onChange={e => setShape(e.target.value as 'holon' | 'hierarchy' | 'departments' | 'designed')} disabled={running}>
        <option value="designed">Designed for this directive: departments drafted to fit it (recommended)</option>
        <option value="departments">Departments: Director + Engineering, Growth, Security, QA, Ops heads</option>
        <option value="hierarchy">Lean hierarchy: a Director staffs as it goes</option>
        <option value="holon">Holon: peer ring, experimental</option>
      </select>
      <button type="submit" disabled={running || busy || !text.trim()}>
        {running ? 'Directive running' : busy ? 'Starting…' : 'Start org'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}

// Same rule as the daemon's default seat: claude unless only codex is installed.
export const pickCli = (l: Cli[]): Cli => l.includes('claude') || !l.includes('codex') ? 'claude' : 'codex'

function NewTerminal({ nodes, workspace, onCreated }: { nodes: Node[]; workspace: string; onCreated: (id: string) => void }) {
  const [label, setLabel] = useState('')
  const [cli, setCli] = useState<Cli>('claude')
  // Only CLIs that are installed are offered; a Codex-only machine starts on Codex.
  const [clis, setClis] = useState<Cli[] | null>(null)
  useEffect(() => { holon.clis().then(l => { setClis(l); setCli(pickCli(l)) }).catch(() => {}) }, [])
  const offer = (c: Cli) => !clis || clis.includes(c)
  // New terminals start in the project's folder, or in the folder of the role they report to.
  const [cwd, setCwd] = useState(workspace)
  useEffect(() => setCwd(workspace), [workspace])
  const [parentId, setParentId] = useState('')
  const [lead, setLead] = useState(false)
  const [yolo, setYolo] = useState(false)
  const [error, setError] = useState('')

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const node = await holon.call<Node>('create', {
        label: label || (lead ? 'Lead' : 'Worker'), cli, cwd, parentId: parentId || null, lead, yolo: cli !== 'shell' && yolo,
      })
      setLabel('')
      onCreated(node.id)
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <form className="form" onSubmit={create}>
      <input placeholder="Label" value={label} onChange={e => setLabel(e.target.value)} />
      <select value={cli} onChange={e => setCli(e.target.value as Cli)}>
        {offer('claude') && <option value="claude">Claude Code</option>}
        {offer('codex') && <option value="codex">Codex</option>}
        {offer('gemini') && <option value="gemini">Gemini</option>}
        {offer('opencode') && <option value="opencode">OpenCode (free models)</option>}
        <option value="shell">Shell</option>
      </select>
      <input placeholder="Working directory" value={cwd} onChange={e => setCwd(e.target.value)} />
      <select value={parentId} onChange={e => { setParentId(e.target.value); setCwd(nodes.find(n => n.id === e.target.value)?.cwd ?? workspace) }}>
        <option value="">Reports to: nobody (top level)</option>
        {nodes.map(n => <option key={n.id} value={n.id}>Reports to: {n.label}</option>)}
      </select>
      <label className="check">
        <input type="checkbox" checked={lead} disabled={cli === 'shell'}
          onChange={e => { setLead(e.target.checked); setYolo(e.target.checked) }} />
        Lead (can drive its reports)
      </label>
      <label className="check">
        <input type="checkbox" checked={yolo} onChange={e => setYolo(e.target.checked)} disabled={cli === 'shell'} />
        Skip permission prompts
      </label>
      <button type="submit">Create</button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}

const QUIET_ACTIONS = new Set(['read_screen', 'wait_done'])

function ActionLog({ actions, labels }: { actions: Action[]; labels: Map<string, string> }) {
  const box = useRef<HTMLDivElement>(null)
  // Scroll the log itself; scrollIntoView would also scroll every pane around it (the Board opened half-scrolled).
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [actions.length])
  const name = (id: string | null) => (id === null ? 'you' : labels.get(id) ?? id)
  return (
    <div className="log" ref={box}>
      {actions.length === 0 && <p className="muted">What your leads do shows up here.</p>}
      {actions.map((a, i) => (
        <div key={i} className={`entry ${QUIET_ACTIONS.has(a.action) ? 'dim' : ''} ${a.action}`}>
          <time>{new Date(a.ts).toLocaleTimeString()}</time>
          <span className="who">{name(a.caller)}{a.target !== null || a.action === 'escalate' ? ` → ${name(a.target)}` : ''}</span>
          <span className="what">{a.action}</span>
          <span className="detail">{describe(a)}</span>
        </div>
      ))}
    </div>
  )
}

export function describe(a: Action): string {
  switch (a.action) {
    case 'type': return JSON.stringify(a.args.text) + (a.args.submit === false ? '' : ' ⏎')
    case 'press': return `"${a.args.key}"`
    case 'wait': return `until still ${a.args.quietMs ?? 3000}ms`
    case 'wait_done': return String(a.args.state)
    case 'spawn': return `${a.args.label} (${a.args.cli}${a.args.lead ? ', lead' : ''})`
    case 'escalate': return String(a.args.message)
    case 'answer': return String(a.args.text)
    case 'set_status': return String(a.args.status)
    case 'set_goals': return (a.args.goals as string[]).join(' · ')
    case 'directive': return String(a.args.text)
    case 'ask': return String(a.args.text)
    case 'deliver': return `${a.args.label}: ${a.args.value}`
    case 'complete': return String(a.args.summary)
    case 'update': return String(a.args.text)
    case 'org_review': return `${a.args.teams} teams reviewed`
    case 'retired': return `${a.args.label} after ${a.args.idleMin} idle min`
    case 'heal': return `${a.args.issue}: ${a.args.summary}`
    default: return ''
  }
}
