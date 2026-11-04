import { useEffect, useMemo, useState } from 'react'
import { errorText, holon } from './holon.ts'

export interface KbItem { path: string; kind: string; title: string; by?: string; updated: string; reads?: number; lastRead?: string }
interface KbEntry extends KbItem { body: string; readBy?: Record<string, number> }

const KINDS = ['decision', 'fact', 'lesson', 'playbook', 'person']

// The org's memory: every entry the knowledge base holds, filtered by kind and
// searchable, with the chosen one read in full beside the list.
export function Memory() {
  const [all, setAll] = useState<KbItem[]>([])
  const [hits, setHits] = useState<KbItem[] | null>(null)  // non-null while searching
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [sort, setSort] = useState<'new' | 'reads'>('new')
  const [path, setPath] = useState<string | null>(null)
  const [entry, setEntry] = useState<KbEntry | null>(null)
  const [error, setError] = useState('')

  const load = () => holon.call<KbItem[]>('kb_list').then(list => { setAll(list); setError('') }).catch(e => setError(errorText(e)))
  useEffect(() => {
    load()
    // A write means the org just learned something: the list behind it changed.
    const off = holon.onEvent(({ event, payload }) => { if (event === 'action' && String(payload.action).startsWith('kb_write')) load() })
    // Agents read the KB behind the owner's back, so the counts need a heartbeat of their own.
    const timer = setInterval(load, 30_000)
    return () => { off(); clearInterval(timer) }
  }, [])

  // The box searches the KB; an empty box shows everything.
  useEffect(() => {
    const q = query.trim()
    if (!q) { setHits(null); return }
    let live = true
    const timer = setTimeout(() => {
      holon.call<KbItem[]>('kb_search', { query: q, kind: kind || undefined })
        .then(found => { if (live) { setHits(found); setError('') } })
        .catch(e => { if (live) setError(errorText(e)) })
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [query, kind])

  const rows = useMemo(() => {
    const source = hits ?? all
    const filtered = kind ? source.filter(e => e.kind === kind) : source
    // Most read first: the entries the org keeps coming back to.
    if (sort === 'reads') return [...filtered].sort((a, b) => (b.reads ?? 0) - (a.reads ?? 0) || b.updated.localeCompare(a.updated))
    return filtered
  }, [all, hits, kind, sort])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const e of all) c[e.kind] = (c[e.kind] ?? 0) + 1
    return c
  }, [all])

  const open = (p: string) => {
    setPath(p)
    setError('')
    holon.call<KbEntry>('kb_read', { path: p })
      .then(setEntry).catch(e => { setEntry(null); setError(errorText(e)) })
  }

  return (
    <div className="memory">
      <div className="memory-list">
        <div className="memory-filters">
          <button className={kind === '' ? 'on' : ''} onClick={() => setKind('')}>
            All<span className="count">{all.length}</span>
          </button>
          {KINDS.map(k => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)} disabled={!counts[k]}>
              {k}<span className="count">{counts[k] ?? 0}</span>
            </button>
          ))}
          <span className="memory-sort">
            <button className={sort === 'new' ? 'on' : ''} onClick={() => setSort('new')} title="Newest first">Newest</button>
            <button className={sort === 'reads' ? 'on' : ''} onClick={() => setSort('reads')} title="Most read first">Most read</button>
          </span>
        </div>
        <div className="memory-search">
          <input placeholder="Search the knowledge base…" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        {error && <p className="error memory-note">{error}</p>}
        <div className="memory-rows">
          {rows.length === 0 && (
            <p className="memory-note">
              {query.trim() ? 'Nothing matches that search.' : 'Nothing here yet. The org writes to its memory as it decides and learns.'}
            </p>
          )}
          {rows.map(e => (
            <button key={e.path} className={`memory-row ${e.path === path ? 'on' : ''}`} onClick={() => open(e.path)}>
              <span className="m-title">{e.title}</span>
              <span className="m-kind">{e.kind}</span>
              <span className="m-meta">{e.by || 'unknown'} · {ago(e.updated)} · <span className="m-reads">{e.reads ? `read ${e.reads}×` : 'never read'}</span></span>
            </button>
          ))}
        </div>
      </div>
      <div className="memory-reader">
        {entry ? (
          <>
            <h1>{entry.title}</h1>
            <div className="m-meta">
              <span className="m-kind">{entry.kind}</span> · by {entry.by || 'unknown'} · {new Date(entry.updated).toLocaleString()}
            </div>
            <div className="m-meta m-reads">{readLine(entry)}</div>
            <div className="memory-body">{entry.body}</div>
          </>
        ) : (
          <p className="memory-note">Pick an entry to read it.</p>
        )}
      </div>
    </div>
  )
}

// How long ago, in words: "3m ago" beats a timestamp the owner has to decode.
function ago(ts: string) {
  const then = Date.parse(ts)
  if (!Number.isFinite(then)) return ''
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 30 * 86400) return `${Math.round(s / 86400)}d ago`
  return new Date(then).toLocaleDateString()
}

// Who reads this entry, and how often: "read 3× · last 2h ago · by Engineering 2, QA 1".
function readLine(entry: KbEntry) {
  if (!entry.reads) return 'never read by an agent'
  const readers = Object.entries(entry.readBy ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${label} ${n}`)
    .join(', ')
  const last = entry.lastRead ? `last ${ago(entry.lastRead)}` : ''
  return [`read ${entry.reads}×`, last, readers && `by ${readers}`].filter(Boolean).join(' · ')
}
