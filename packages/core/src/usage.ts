import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Token use per agent, read from each CLI's own records on disk. Claude and Codex costs
// are API-equivalent estimates (subscriptions aren't billed per token); OpenCode reports
// its own cost. Codex uses default rates, overridden by prices.json; unknown models stay null.

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number | null
  source?: string
}

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 })
export const total = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite

// $ per million tokens, from Anthropic's published first-party rates (2026-10).
const CLAUDE_RATES: Record<string, { in: number; out: number; read: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.2 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.01 },
}

// $ per million tokens, Standard short-context rates: https://developers.openai.com/api/docs/pricing (read 2026-10-30).
const CODEX_RATES: Record<string, { in: number; out: number; read: number }> = {
  'gpt-6-astra': { in: 10, out: 50, read: 1 },
  'gpt-6-luna': { in: 0.1, out: 0.5, read: 0.01 },
}

type Rates = Record<string, { in: number; out: number; read?: number }>
function userRates(home: string): Rates {
  const f = join(home, 'prices.json')
  try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {} } catch { return {} }
}

// Claude Code logs one line per content block, so the same message's usage repeats; count each id once.
// Transcripts only grow, and the dashboard counts live: each read parses only the bytes added
// since the last one (whole lines), carrying the totals forward. A shorter file starts over.
const claudeRead = new Map<string, { offset: number; u: Usage; seen: Set<string> }>()

export function claudeUsage(file: string): Usage {
  if (!existsSync(file)) return { ...zero(), costUsd: null }
  let st = claudeRead.get(file)
  const size = statSync(file).size
  if (!st || size < st.offset) st = { offset: 0, u: zero(), seen: new Set() }
  claudeRead.set(file, st)
  let text = ''
  if (size > st.offset) {
    const fd = openSync(file, 'r')
    try { const buf = Buffer.alloc(size - st.offset); readSync(fd, buf, 0, buf.length, st.offset); text = buf.toString('utf8') } finally { closeSync(fd) }
  }
  let end = text.lastIndexOf('\n') + 1
  // A last line with no newline counts once it parses: a line still being written doesn't.
  try { if (end < text.length) { JSON.parse(text.slice(end)); end = text.length } } catch {}
  st.offset += Buffer.byteLength(text.slice(0, end))
  const u = st.u, seen = st.seen
  for (const line of text.slice(0, end).split('\n')) {
    if (!line.includes('"usage"')) continue
    let m: any
    try { m = JSON.parse(line).message } catch { continue }
    if (!m?.usage || (m.id && seen.has(m.id))) continue
    if (m.id) seen.add(m.id)
    const us = m.usage
    const oneHour = us.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const write = us.cache_creation_input_tokens ?? 0
    u.input += us.input_tokens ?? 0
    u.output += us.output_tokens ?? 0
    u.cacheRead += us.cache_read_input_tokens ?? 0
    u.cacheWrite += write
    // Match by prefix ("claude-opus-5-5[1m]" etc.); entries with no known model (synthetic
    // messages) carry no cost and are skipped rather than voiding the total.
    const key = Object.keys(CLAUDE_RATES).find(k => String(m.model ?? '').startsWith(k))
    const r = key ? CLAUDE_RATES[key] : undefined
    if (r && u.costUsd !== null) {
      u.costUsd += ((us.input_tokens ?? 0) * r.in + (us.output_tokens ?? 0) * r.out + (us.cache_read_input_tokens ?? 0) * r.read
        + oneHour * r.in * 2 + (write - oneHour) * r.in * 1.25) / 1e6
    }
  }
  return { ...u, source: file }
}

// How big the conversation is as of its last turn (what the next turn re-reads), and whether
// that turn ended with the agent waiting for input. Text typed mid-turn is queued as a plain
// message, so a slash command only works at the prompt. Only the file's tail is read; long
// sessions run to tens of megabytes.
// Escape in a running turn ends the transcript with a user line of "[Request interrupted by user]"
// (or "... for tool use"); the seat is back at its prompt though no assistant line says end_turn.
// A finished /compact ends with a user line whose output reads "Compacted"; `compacted` marks it.
const userText = (j: any): string => {
  const c = j?.message?.content
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('') : ''
}

export function claudeTail(file: string): { context: number; atPrompt: boolean; compacted: boolean } {
  let context = 0, sized = false, atPrompt: boolean | null = null, compacted = false
  try {
    const fd = openSync(file, 'r')
    const size = fstatSync(fd).size, n = Math.min(size, 512 * 1024)
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, size - n)
    closeSync(fd)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0 && (!sized || atPrompt === null); i--) {
      let j: any
      try { j = JSON.parse(lines[i]) } catch { continue }   // the first line in the window can be cut
      if (atPrompt === null && j.type === 'user') {
        const t = userText(j)
        atPrompt = t.startsWith('[Request interrupted by user')
        if (/^<local-command-stdout>[^]*Compacted/.test(t)) { atPrompt = true; compacted = true }
      } else if (atPrompt === null && j.type === 'queue-operation') atPrompt = false
      if (j.subtype === 'compact_boundary') sized = true   // compacted since its last turn: the old size no longer applies
      if (j.type !== 'assistant') continue
      if (atPrompt === null) atPrompt = j.message?.stop_reason === 'end_turn'
      const us = j.message?.usage
      if (us && !sized) { context = (us.input_tokens ?? 0) + (us.cache_read_input_tokens ?? 0) + (us.cache_creation_input_tokens ?? 0); sized = true }
    }
  } catch { /* no transcript yet */ }
  return { context, atPrompt: atPrompt ?? false, compacted }
}

export const claudeContext = (file: string) => claudeTail(file).context

interface Session { file: string; cwd: string; start: number }

export function codexSessions(since: number): Session[] {
  const root = join(homedir(), '.codex', 'sessions')
  if (!existsSync(root)) return []
  const out: Session[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (f.endsWith('.jsonl') && st.mtimeMs >= since) {
        const first = readFileSync(p, 'utf8').split('\n', 1)[0]
        try {
          const meta = JSON.parse(first)
          if (meta.type === 'session_meta') out.push({ file: p, cwd: meta.payload.cwd, start: Date.parse(meta.payload.timestamp ?? meta.timestamp) })
        } catch {}
      }
    }
  }
  walk(root)
  return out
}

export function codexUsage(file: string, home: string, model?: string): Usage {
  const u = zero()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"total_token_usage"')) continue
    try {
      const t = JSON.parse(line).payload.info.total_token_usage
      u.input = (t.input_tokens ?? 0) - (t.cached_input_tokens ?? 0)
      u.cacheRead = t.cached_input_tokens ?? 0
      u.output = (t.output_tokens ?? 0) + (t.reasoning_output_tokens ?? 0)
    } catch {}
  }
  const r = model ? userRates(home)[model] ?? CODEX_RATES[model] : undefined
  u.costUsd = r ? (u.input * r.in + u.output * r.out + u.cacheRead * (r.read ?? r.in)) / 1e6 : null
  return { ...u, source: file }
}

export async function opencodeSessions(since: number, dbFile = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')): Promise<(Session & { usage: Usage; model?: string })[]> {
  if (!existsSync(dbFile)) return []
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    // OpenCode 2.x writes sessions to session_v2; the older session table holds only what came
    // before. Read both, newer first, and count each id once.
    const tables = (db.prepare("select name from sqlite_master where type = 'table' and name in ('session_v2', 'session')").all() as { name: string }[])
      .map(t => t.name).sort().reverse()
    const seen = new Set<string>()
    const rows = tables.flatMap(t => db.prepare(`select id, directory, time_created, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model from ${t} where time_created >= ?`).all(since) as any[])
      .filter(r => !seen.has(r.id) && seen.add(r.id))
    return rows.map(r => {
      // The db stores the model as JSON ({id, providerID}); the provider is what the
      // panel needs, because opencode-go/* is the plan and opencode/* is console credits.
      let model: string | undefined
      try { const m = JSON.parse(r.model); if (m?.providerID && m?.id) model = `${m.providerID}/${m.id}` } catch {}
      return {
        file: `${dbFile}#${r.id}`, cwd: r.directory, start: Number(r.time_created), model,
        usage: { input: r.tokens_input ?? 0, output: (r.tokens_output ?? 0) + (r.tokens_reasoning ?? 0), cacheRead: r.tokens_cache_read ?? 0, cacheWrite: r.tokens_cache_write ?? 0, costUsd: r.cost ?? 0, source: `opencode session ${r.id}` },
      }
    })
  } finally { db.close() }
}

// Matches each terminal to the session its CLI started: same directory, first unclaimed start after it.
export function claim<T extends Session>(sessions: T[], cwd: string, createdAt: number, claimed: Set<string>): T | undefined {
  return sessions
    .filter(s => s.cwd === cwd && s.start >= createdAt - 60_000 && !claimed.has(s.file))
    .sort((a, b) => a.start - b.start)[0]
}
