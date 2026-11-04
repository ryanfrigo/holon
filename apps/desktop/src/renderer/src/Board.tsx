import { useEffect, useRef, useState } from 'react'
import { describe } from './App.tsx'
import { Num } from './Num.tsx'
import { press } from './press.ts'
import { askAge, askPreamble, DAY } from '../../../../../packages/core/src/asks.ts'
import { errorText, holon, type Action, type Deliverable, type Directive, type Escalation, type Node } from './holon.ts'

const STATE_LABEL = { running: 'working', quiet: 'idle', exited: 'exited', paused: 'paused' } as const

// The whole org at a glance: the directive and its goals, what needs you, and every
// terminal's state, status and latest move, laid out as the org chart.
export function Board({ nodes, actions, escalations, directive, labels, onOpen }: {
  nodes: Node[]
  actions: Action[]
  escalations: Escalation[]
  directive: Directive | null
  labels: Map<string, string>
  onOpen: (id: string) => void
}) {
  const lastAction = new Map<string, Action>()
  for (const a of actions) {
    if (a.action === 'read_screen' || a.action === 'wait_done') continue
    if (a.caller) lastAction.set(a.caller, a)
  }
  const asking = new Map(escalations.filter(e => e.status === 'open').map(e => [e.from, e]))
  const mine = escalations.filter(e => e.to === null)
  const count = (s: Node['state']) => nodes.filter(n => n.state === s).length
  const roots = nodes.filter(n => n.parentId === null)

  const open = mine.filter(e => e.status === 'open')
  const updates = [...(directive?.updates ?? [])].reverse().slice(0, 6)

  return (
    <div className="board">
      {directive && <DirectiveBar directive={directive} directorAlive={nodes.some(n => n.id === directive.directorId && n.state !== 'paused')} paused={nodes.some(n => n.state === 'paused')} />}
      {directive && <Now directive={directive} nodes={nodes} actions={actions} asks={escalations.filter(e => e.to === null && e.status === 'open').length} />}
      {directive?.drafts?.filter(d => d.status === 'pending').map(d => <DraftCard key={d.id} draft={d} current={directive.text} />)}
      {directive?.messages?.length ? <Messages messages={directive.messages} /> : null}

      {open.length > 0 && (
        <section className="inbox">
          <h2>{directive?.autopilot ? 'The org needs' : 'Needs you'}</h2>
          {open.map(e => <InboxCard key={e.id} esc={e} from={labels.get(e.from) ?? e.from} />)}
        </section>
      )}

      {updates.length > 0 && (
        <section className="updates">
          <h2>Updates</h2>
          {updates.map((u, i) => (
            <div key={i} className="update">
              <time>{new Date(u.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
              <span>{u.text}</span>
            </div>
          ))}
        </section>
      )}

      {directive && directive.deliverables.length > 0 && (
        <section className="chips">
          {directive.deliverables.map(d => <DeliverableChip key={d.label} d={d} />)}
        </section>
      )}

      {directive && (directive.tasks ?? []).some(t => t.status === 'open' || t.status === 'claimed') && (
        <section className="tasks">
          <h2>Task board</h2>
          {(directive.tasks ?? []).filter(t => t.status === 'open' || t.status === 'claimed').slice(-10).reverse().map(t => (
            <div key={t.id} className={`task ${t.status}`} title={t.detail}>
              <span className={`pill ${t.status === 'claimed' ? 'running' : ''}`}>{t.status}</span>
              <span>{t.title}</span>
              <span className="muted">{t.owner ? `· ${t.owner}` : `· posted by ${t.by}`}</span>
            </div>
          ))}
        </section>
      )}

      <section className="chart">
        <h2>Org · <Num value={count('running')} /> working · <Num value={count('quiet')} /> idle</h2>
        {roots.length === 0 && (
          <div className="welcome">
            <h3>Holon runs a small company of AI agents for you.</h3>
            <p>You give it one goal. A Director agent splits the work, hires builders and reviewers, merges what passes review, and asks you only when it needs a decision or access.</p>
            <ol>
              <li>Write the goal in the <b>Directive</b> box on the left, or pick a folder and use "Suggest a directive".</li>
              <li>Press <b>Start org</b>. The Director appears here and its team fills in under it.</li>
              <li>Watch Board, Map and Terminals. Anything that needs you shows up as an ask at the top.</li>
            </ol>
            <p className="muted">Sign-in is separate: the plan panel at the bottom left says whether your agent CLI is ready.</p>
          </div>
        )}
        {roots.map(r => (
          <OrgNode key={r.id} node={r} nodes={nodes} lastAction={lastAction} asking={asking} labels={labels} onOpen={onOpen} />
        ))}
      </section>

      {directive && (
        <section className="more">
          {directive.summary && <Fold title="Latest round"><p className="summary-text">{directive.summary}</p></Fold>}
          {directive.goals.length > 0 && <Fold title={`Goals · ${directive.goals.length}`}><ol className="goals">{directive.goals.map((g, i) => <li key={i}>{g}</li>)}</ol></Fold>}
          {directive.council && <Fold title={`Council · ${(directive.proposals ?? []).length} proposals`}><Council directive={directive} labels={labels} /></Fold>}
          <Fold title="Knowledge"><Knowledge /></Fold>
          <Fold title="Tokens"><CostTable api={directive.usage?.billing === 'api'} /></Fold>
          {mine.some(e => e.status === 'answered') && (
            <Fold title="You answered">
              {mine.filter(e => e.status === 'answered').map(e => (
                <div key={e.id} className="answered-row">
                  <span className="muted">{labels.get(e.from) ?? e.from}:</span> {e.message}
                  <div className="reply">→ {e.answer}</div>
                </div>
              ))}
            </Fold>
          )}
          <Fold title="Directive"><p className="directive-text">{directive.text}</p></Fold>
        </section>
      )}
    </div>
  )
}

const fmtTokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)

interface UsageRow { id: string; label: string; cli: string; model?: string; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null }

// Per-agent tokens and estimated cost, read from each CLI's own records.
function CostTable({ api }: { api: boolean }) {
  const [rows, setRows] = useState<UsageRow[] | null>(null)
  useEffect(() => { holon.call<UsageRow[]>('usage').then(setRows) }, [])
  if (!rows) return <p className="muted">Reading usage…</p>
  return (
    <div className="cost-wrap">
      <table className="cost">
        <thead><tr><th>Agent</th><th>Model</th><th>Tokens</th><th>Output</th><th>Cache read</th>{api && <th>Est. cost</th>}</tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.label}</td><td className="muted">{r.cli} · {(r.model ?? 'default').replace('openrouter/', '')}</td>
              <td><Num value={r.tokens} format={fmtTokens} /></td><td><Num value={r.output} format={fmtTokens} /></td><td><Num value={r.cacheRead} format={fmtTokens} /></td>
              {api && <td>{r.costUsd === null ? <span className="muted">unpriced</span> : <Num value={r.costUsd} format={n => `$${n.toFixed(2)}`} />}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">{api ? 'Estimated at API rates. Codex uses OpenAI\'s published rates; ~/.holon/prices.json overrides them.' : 'On a subscription there is no per-token bill; these show where your plan limits go. Free OpenCode models use none. Set HOLON_BILLING=api to see dollar estimates.'}</p>
    </div>
  )
}

function Fold({ title, children }: { title: string; children: React.ReactNode }) {
  return <details className="fold"><summary>{title}</summary><div className="fold-body">{children}</div></details>
}

// One compact bar: status, the directive's first line, runway and MRR, and the ask box.
function DirectiveBar({ directive, directorAlive, paused }: { directive: Directive; directorAlive: boolean; paused: boolean }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(directive.text)
  const [why, setWhy] = useState('')
  const [err, setErr] = useState('')
  const saveDirective = async () => {
    setErr('')
    try { await holon.call('set_directive', { text: draft, reason: why.trim() || 'edited by the human' }); setEditing(false); setWhy('') }
    catch (e) { setErr(errorText(e)) }
  }
  const done = directive.status !== 'running'
  const t = directive.treasury
  const left = t ? Math.max(0, t.budgetMin + t.earnedMin - t.spentMin) : 0
  const pct = t ? Math.min(100, (left / (t.budgetMin + t.earnedMin || 1)) * 100) : 0
  const firstLine = directive.text.split(/(?<=[.!?])\s/)[0]
  return (
    <section className={`directive ${done ? 'complete' : ''}`}>
      <div className="directive-head">
        <span className={`pill ${directive.status === 'dead' ? 'dead' : done ? 'quiet' : 'running'}`}>{directive.status}</span>
        {paused && <span className="pill dead">paused</span>}
        {directive.autopilot && <span className="pill quiet">autopilot</span>}
        {directive.shape === 'holon' && <span className="pill">holon</span>}
        <span className="directive-line" title={directive.text}>{firstLine}</span>
        <button className="edit-directive" onClick={() => { setDraft(directive.text); setEditing(e => !e) }}>{editing ? 'Cancel' : 'Edit'}</button>
        {t && (
          <span className="runway-inline" title={`spent ${Math.round(t.spentMin)} of ${t.budgetMin} + earned ${Math.round(t.earnedMin)}`}>
            <span className="bar"><span className={`fill ${pct < 15 ? 'low' : pct < 40 ? 'mid' : 'ok'}`} style={{ width: `${pct}%` }} /></span>
            <Num value={left} /> min
            <strong className="mrr">$<Num value={t.mrr} format={n => n.toLocaleString()} /> MRR</strong>
          </span>
        )}
        {directive.usage && (
          <span className="usage-inline" title={directive.usage.billing === 'api' ? 'Estimated API cost' : 'Tokens used today across all agents. On a subscription there is no per-token bill; plan limits are what run out.'}>
            <Num value={directive.usage.tokens} format={fmtTokens} /> tokens{directive.usage.billing === 'api' ? <> · ~<Num value={directive.usage.costUsd} format={n => `$${n.toFixed(2)}`} /></> : null}
          </span>
        )}
      </div>
      {editing && (
        <div className="directive-edit">
          <textarea rows={8} value={draft} onChange={e => setDraft(e.target.value)} />
          <input placeholder="Why (optional): e.g. widen it to infinite rooms" value={why} onChange={e => setWhy(e.target.value)} />
          <button onClick={saveDirective} disabled={!draft.trim() || draft === directive.text}>Save directive · every head gets the new version</button>
          {err && <p className="error">{err}</p>}
        </div>
      )}
      {directorAlive && <AskDirector />}
    </section>
  )
}

function Runway({ t }: { t: NonNullable<Directive['treasury']> }) {
  const left = Math.max(0, t.budgetMin + t.earnedMin - t.spentMin)
  const pct = Math.min(100, (left / (t.budgetMin + t.earnedMin || 1)) * 100)
  const tone = pct < 15 ? 'low' : pct < 40 ? 'mid' : 'ok'
  return (
    <div className="runway">
      <div className="runway-head">
        <strong><Num value={left} /></strong> agent-minutes of runway
        <span className="muted"> · spent <Num value={t.spentMin} /> of <Num value={t.budgetMin} format={n => n.toLocaleString()} /> + earned <Num value={t.earnedMin} format={n => String(Math.round(n))} /></span>
        <span className="mrr">MRR $<Num value={t.mrr} format={n => n.toLocaleString()} /> settled{t.revenueError ? ' (meter error)' : ''}</span>
      </div>
      <div className="bar"><div className={`fill ${tone}`} style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

function DeliverableChip({ d }: { d: Deliverable }) {
  const [copied, setCopied] = useState(false)
  const act = () => {
    if (d.kind === 'command') {
      navigator.clipboard.writeText(d.value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } else holon.open(d.kind, d.value)
  }
  const verb = d.kind === 'url' ? 'Open' : d.kind === 'file' ? 'Show in Finder' : copied ? 'Copied' : 'Copy'
  return (
    <button className={`chip ${d.kind}`} onClick={act} title={`${d.value}${d.note ? '\n' + d.note : ''}`}>
      {d.label} <span className="d-verb">{verb} →</span>
    </button>
  )
}

function AskDirector() {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const noteTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(noteTimer.current), [])
  async function send(e: React.FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body) return
    // The box empties now and the note says so: the Director is told in the background.
    setText('')
    setError('')
    setSent(true)
    window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setSent(false), 1500)
    try {
      await holon.call('ask_director', { text: body })
    } catch (err) {
      window.clearTimeout(noteTimer.current)
      setSent(false)
      setText(body)
      setError(errorText(err))
    }
  }
  return (
    <form className="ask" onSubmit={send}>
      <input placeholder="Tell the org something…" value={text}
        onChange={e => { setText(e.target.value); setError('') }} />
      <button type="submit" disabled={!text.trim()}>Send</button>
      {sent && <span className="muted">Sent</span>}
      {error && <p className="error">{error}</p>}
    </form>
  )
}

function Council({ directive, labels }: { directive: Directive; labels: Map<string, string> }) {
  const { members, quorum } = directive.council!
  const proposals = [...(directive.proposals ?? [])].reverse()
  return (
    <section className="council">
      <h2>Council · {quorum} of {members.length} to pass</h2>
      <div className="members">{members.map(m => <span key={m} className="member">{labels.get(m) ?? m}</span>)}</div>
      {proposals.length === 0 && <p className="muted">No proposals yet.</p>}
      {proposals.slice(0, 8).map(p => (
        <div key={p.id} className={`proposal ${p.status}`}>
          <div className="proposal-head">
            <span className={`pill ${p.status === 'passed' ? 'quiet' : p.status === 'open' ? 'running' : 'dead'}`}>{p.status}</span>
            <strong>{p.title}</strong>
            <span className="muted">by {labels.get(p.by) ?? p.by}</span>
          </div>
          <div className="votes">
            {members.map(m => {
              const v = p.votes[m]
              return (
                <div key={m} className={`vote ${v?.vote ?? 'pending'}`}>
                  <span>{labels.get(m) ?? m}</span>
                  <strong>{v ? v.vote : '…'}</strong>
                  {v && v.reason !== 'proposer' && <span className="muted">{v.reason}</span>}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </section>
  )
}

interface KbOverview { dir: string; counts: Record<string, number>; recent: { path: string; kind: string; title: string; by: string; updated: string }[] }

// The org's shared memory: what it has decided, measured and learned.
function Knowledge() {
  const [kb, setKb] = useState<KbOverview | null>(null)
  useEffect(() => {
    const load = () => holon.call<KbOverview | null>('kb').then(setKb)
    load()
    const off = holon.onEvent(({ event, payload }) => { if (event === 'action' && /^kb_write|^proposal_passed|^answer|^complete/.test(payload.action)) load() })
    const timer = setInterval(load, 30_000)
    return () => { off(); clearInterval(timer) }
  }, [])
  if (!kb) return null
  const total = Object.values(kb.counts).reduce((a, b) => a + b, 0)
  return (
    <section className="knowledge">
      <h2>Knowledge · <Num value={total} /> entries</h2>
      <div className="kb-counts">
        {Object.entries(kb.counts).map(([k, n]) => <span key={k} className="member"><Num value={n} /> {k}{n === 1 ? '' : 's'}</span>)}
      </div>
      {kb.recent.map(e => (
        <button key={e.path} className="kb-row" onClick={() => holon.open('file', `${kb.dir}/${e.path}`)}>
          <span className="d-kind">{e.kind}</span>
          <span>{e.title}</span>
          <span className="muted">{e.by} · {new Date(e.updated).toLocaleString()}</span>
        </button>
      ))}
    </section>
  )
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return <div className={`stat ${tone ?? ''} ${n > 0 ? 'some' : ''}`}><strong>{n}</strong><span>{label}</span></div>
}

function OrgNode({ node, nodes, lastAction, asking, labels, onOpen }: {
  node: Node
  nodes: Node[]
  lastAction: Map<string, Action>
  asking: Map<string, Escalation>
  labels: Map<string, string>
  onOpen: (id: string) => void
}) {
  const reports = nodes.filter(n => n.parentId === node.id)
  const last = lastAction.get(node.id)
  const esc = asking.get(node.id)
  return (
    <div className="org-node">
      <button className={`card ${node.state} ${esc ? 'asking' : ''}`} onClick={() => onOpen(node.id)}>
        <div className="card-head">
          <span className={`dot ${node.state}`} />
          <strong>{node.label}</strong>
          <span className="muted">{node.cli}{node.lead ? ' · lead' : ''}</span>
          <span className={`pill ${node.state}`}>{STATE_LABEL[node.state]}</span>
        </div>
        {node.status && <div className="status">{node.status}</div>}
        {node.headline && <div className="headline">{node.headline}</div>}
        {last && (
          <div className="last">
            {last.target && last.target !== node.id ? `→ ${labels.get(last.target) ?? last.target}: ` : ''}
            {last.action} {describe(last).slice(0, 80)}
          </div>
        )}
        {esc && <div className="asking-line">asking {esc.to ? labels.get(esc.to) : 'you'}: {esc.message.slice(0, 120)}</div>}
      </button>
      {reports.length > 0 && (
        <div className="reports">
          {reports.map(r => (
            <OrgNode key={r.id} node={r} nodes={nodes} lastAction={lastAction} asking={asking} labels={labels} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

// A board card an ask names, as it reads now: the asker may have replaced it since.
function AskCard({ id }: { id: string }) {
  const [card, setCard] = useState<{ id: string; title: string; detail: string; status: string } | null>(null)
  useEffect(() => {
    const load = () => holon.call<typeof card>('board_card', { id }).then(setCard).catch(() => {})
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [id])
  if (!card) return null
  return (
    <details className="ask-card" open>
      <summary>{card.id}{card.id !== id ? ` (replaces ${id})` : ''} · {card.title}</summary>
      <div className="ask-card-body">{card.detail}</div>
    </details>
  )
}

// One decision of a multi-item ask: Yes / No or a typed answer. It goes to the asking seat at once.
function AskItemRow({ id, index, item, compact }: { id: string; index: number; item: { text: string; answer?: string }; compact: boolean }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const send = async (answer: string) => {
    if (!answer.trim()) return
    try { await holon.call('answer_item', { id, index, text: answer }) } catch (err) { setError(errorText(err)) }
  }
  return (
    <li className={`ask-item ${item.answer !== undefined ? 'done' : ''}`}>
      <span title={item.text}>{compact && item.text.length > 160 ? item.text.slice(0, 160) + '…' : item.text}</span>
      {item.answer !== undefined
        ? <span className="item-answer">→ {item.answer}</span>
        : <span className="answer-row">
            <button type="button" onClick={() => send('yes')}>Yes</button>
            <button type="button" onClick={() => send('no')}>No</button>
            <input placeholder="or write an answer" value={text} onChange={e => { setText(e.target.value); setError('') }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void send(text) } }} />
            <button type="button" disabled={!text.trim()} onClick={() => send(text)}>Answer</button>
          </span>}
      {error && <span className="error">{error}</span>}
    </li>
  )
}

export function InboxCard({ esc, from, compact = false }: { esc: Escalation; from: string; compact?: boolean }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => setError(''), [text])
  // autoFocus would scroll the Board to the input as it opens; focus without scrolling.
  useEffect(() => { if (!compact) input.current?.focus({ preventScroll: true }) }, [compact])
  async function send(e: React.FormEvent) {
    e.preventDefault()
    try { await holon.call('answer', { id: esc.id, text }) } catch (err) { setError(errorText(err)) }
  }
  return (
    <form className={`inbox-card ${compact ? 'compact' : ''}`} onSubmit={send}>
      <div className="eyebrow">{esc.kind === 'need' ? 'Need' : 'Question'} from {from} · {new Date(esc.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
      <div className="ask-meta">
        <span className={Date.now() - Date.parse(esc.ts) >= DAY ? 'age stale' : 'age'}>{askAge(esc.ts)}</span>
        {esc.blocks && <span className="blocks">blocks: {esc.blocks}</span>}
        {esc.recommend && <span className="recommend">recommended: {esc.recommend}</span>}
      </div>
      {(() => { const q = esc.items ? askPreamble(esc.message) : esc.message; return q ? <p title={esc.message}>{compact && q.length > 220 ? q.slice(0, 220) + '…' : q}</p> : null })()}
      {esc.items && (
        <>
          <p className="muted">{esc.items.filter(i => i.answer !== undefined).length} of {esc.items.length} answered. Each answer reaches {from} as soon as you give it.</p>
          <ol className="ask-items">{esc.items.map((item, i) => <AskItemRow key={i} id={esc.id} index={i} item={item} compact={compact} />)}</ol>
        </>
      )}
      {!compact && [...new Set(esc.message.match(/\bt-[0-9a-f]{4}\b/g) ?? [])].map(id => <AskCard key={id} id={id} />)}
      {!esc.items && <div className="answer-row">
        <input ref={input} placeholder={compact ? 'Answer…' : 'Your answer'} value={text} onChange={e => setText(e.target.value)} />
        <button type="submit" disabled={!text.trim()}>Answer</button>
      </div>}
      {error && <p className="error">{error}</p>}
    </form>
  )
}

// The owner's view: a strip of numbers and a plain-English digest, so nobody has to read terminals.
function Now({ directive, nodes, actions, asks }: { directive: Directive; nodes: Node[]; actions: Action[]; asks: number }) {
  const [busy, setBusy] = useState(false)
  const working = nodes.filter(n => n.state === 'running').length
  const agents = nodes.filter(n => n.cli !== 'shell')
  const free = agents.filter(n => n.grade === 0).length
  const today = new Date().toISOString().slice(0, 10)
  const merges = actions.filter(a => a.action === 'merged' && a.ts.startsWith(today)).length
  const t = directive.treasury
  const refresh = async () => { setBusy(true); try { await holon.call('digest', { force: true }) } finally { setBusy(false) } }
  const age = directive.digest ? Math.round((Date.now() - Date.parse(directive.digest.ts)) / 60_000) : null
  return (
    <section className="now">
      <div className="pulse">
        <div><b><Num value={working} /></b><span>working</span></div>
        <div><b><Num value={agents.length - working} /></b><span>idle</span></div>
        <div title="Agents on free models (G0)"><b><Num value={agents.length ? (free / agents.length) * 100 : 0} format={n => `${Math.round(n)}%`} /></b><span>free labour</span></div>
        <div><b><Num value={merges} /></b><span>merges today</span></div>
        <div className={asks ? 'hot' : ''}><b><Num value={asks} /></b><span>waiting on you</span></div>
        {t && <div><b><Num value={t.budgetMin + t.earnedMin - t.spentMin} /></b><span>runway min</span></div>}
      </div>
      <div className="digest">
        <div className="digest-head">
          <h2>What's happening</h2>
          <span className="muted">{age === null ? 'no summary yet' : age < 1 ? 'just now' : `${age} min ago`}</span>
          <button onClick={refresh} disabled={busy}>{busy ? 'Summarising…' : 'Refresh'}</button>
        </div>
        {directive.digest
          ? <ul>{directive.digest.text.split('\n').map((l, i) => <li key={i} className={/^- Waiting on you/.test(l) ? 'hot' : ''}>{l.replace(/^- /, '')}</li>)}</ul>
          : <p className="muted">A free model writes a short plain-English summary every 10 minutes while the org is active.</p>}
      </div>
    </section>
  )
}

// The owner's backlog: everything they told the org, tracked until it is done or declined.
function Messages({ messages }: { messages: NonNullable<Directive['messages']> }) {
  const [open, setOpen] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const col = (s?: string) => (s === 'done' || s === 'declined' ? 'done' : s === 'doing' ? 'doing' : 'new')
  const cols = { new: messages.filter(m => col(m.status) === 'new'), doing: messages.filter(m => col(m.status) === 'doing'), done: messages.filter(m => col(m.status) === 'done') }
  const mark = (id: string, status: 'doing' | 'done' | 'declined', text: string) => holon.call('note_message', { id, status, text })
  const age = (m: (typeof messages)[number]) => {
    const min = Math.round((Date.now() - Date.parse(m.actions?.at(-1)?.ts ?? m.ts)) / 60_000)
    return min < 60 ? `${min}m` : min < 2880 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`
  }
  const card = (m: (typeof messages)[number]) => {
    const last = m.actions?.at(-1)
    const stale = col(m.status) !== 'done' && Date.now() - Date.parse(last?.ts ?? m.ts) > 2 * 3_600_000
    return (
      <div key={m.id} className={`msg ${stale ? 'stale' : ''}`} {...press(() => setOpen(o => (o === m.id ? null : m.id)))} aria-expanded={open === m.id}>
        <div className="msg-head">
          <b>{m.title ?? m.text.slice(0, 90) + (m.text.length > 90 ? '…' : '')}</b>
          {m.owner && <span className="tag">{m.owner}</span>}
          <span className="muted">{age(m)}{stale ? ' · stale' : ''}</span>
        </div>
        {last ? <p className="msg-last">{last.by}: {last.text}</p> : <p className="msg-last muted">Nobody has picked this up yet.</p>}
        {open === m.id && (
          <div onClick={e => e.stopPropagation()}>
            {m.brief && <ul>{m.brief.split('\n').map((l, i) => <li key={i}>{l.replace(/^- /, '')}</li>)}</ul>}
            <p className="msg-raw">{m.text}</p>
            {(m.actions ?? []).slice(0, -1).reverse().map((a, i) => <p key={i} className="msg-last muted">{new Date(a.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} {a.by}: {a.text}</p>)}
            <div className="msg-actions">
              {col(m.status) !== 'done' && <button onClick={() => mark(m.id, 'done', 'Marked done by the owner')}>Done</button>}
              {col(m.status) !== 'done' && <button onClick={() => mark(m.id, 'declined', 'Dropped by the owner')}>Drop</button>}
              {col(m.status) === 'done' && <button onClick={() => mark(m.id, 'doing', 'Reopened by the owner')}>Reopen</button>}
            </div>
          </div>
        )}
      </div>
    )
  }
  return (
    <section className="messages backlog">
      <div className="digest-head">
        <h2>Your backlog · <Num value={cols.new.length + cols.doing.length} /> open</h2>
        <button onClick={() => setShowDone(v => !v)}>{showDone ? 'Hide done' : <>Done · <Num value={cols.done.length} /></>}</button>
      </div>
      {!showDone && cols.new.length + cols.doing.length === 0 ? <p className="muted">Nothing open. Anything you tell the org shows up here until it is done.</p> : <div className="backlog-cols">
        {(cols.new.length > 0 || cols.doing.length === 0) && <div><h3>New · <Num value={cols.new.length} /></h3>{[...cols.new].reverse().map(card)}</div>}
        {(cols.doing.length > 0 || cols.new.length === 0) && <div><h3>Doing · <Num value={cols.doing.length} /></h3>{[...cols.doing].reverse().map(card)}</div>}
        {showDone && <div><h3>Done · <Num value={cols.done.length} /></h3>{[...cols.done].reverse().map(card)}</div>}
      </div>}
    </section>
  )
}

// A suggested directive, waiting on the owner: approve as is, edit then approve, or reject with a note.
function DraftCard({ draft, current }: { draft: NonNullable<Directive['drafts']>[number]; current: string }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(draft.text)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const decide = async (approve: boolean) => {
    setBusy(true); setErr('')
    try { await holon.call('decide_directive', { id: draft.id, approve, note, text: editing ? text : undefined }) }
    catch (e) { setErr(errorText(e)) } finally { setBusy(false) }
  }
  const added = draft.text.length - current.length
  return (
    <section className="draft">
      <div className="digest-head">
        <h2>Suggested directive update</h2>
        <span className="muted">by {draft.by} · {new Date(draft.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {added >= 0 ? `+${added}` : added} chars</span>
      </div>
      <p className="draft-why">{draft.reason}</p>
      {editing
        ? <textarea rows={12} value={text} onChange={e => setText(e.target.value)} />
        : <pre className="draft-text">{draft.text}</pre>}
      <div className="draft-actions">
        <button className="approve" disabled={busy} onClick={() => decide(true)}>{editing ? 'Approve my edit' : 'Approve'}</button>
        <button disabled={busy} onClick={() => setEditing(e => !e)}>{editing ? 'Cancel edit' : 'Edit'}</button>
        <input placeholder="Note (optional): why, or what to change" value={note} onChange={e => setNote(e.target.value)} />
        <button className="reject" disabled={busy} onClick={() => decide(false)}>Reject</button>
      </div>
      {err && <p className="error">{err}</p>}
    </section>
  )
}
