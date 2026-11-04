// Ops metrics per run: G0 share, quota heals, flow speed, human wait.
//
//   node scripts/ops-metrics.ts <trace dir> [<trace dir> ...] [<approvals file>]
//
// Read-only. One JSON object per trace folder, one per line. Every number comes from
// that folder's actions.jsonl; what cannot be computed is null, and the note says why.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

type Action = { ts: string; caller: string | null; target: string | null; action: string; args: Record<string, any> }

const argv = process.argv.slice(2)
if (!argv.length) {
  console.error('usage: node scripts/ops-metrics.ts <trace dir> [<trace dir> ...] [<approvals file>]')
  process.exit(1)
}

// The approvals file is the last argument when it is not a trace folder.
const last = argv[argv.length - 1]
const approvalsPath = !existsSync(last) || !statSync(last).isDirectory() ? last : null
const folders = approvalsPath ? argv.slice(0, -1) : argv
if (!folders.length) {
  console.error('no trace folders given')
  process.exit(1)
}

// Work actions: the first of these after a daemon resume means the run picked back up.
const WORK_ACTIONS = new Set([
  'spawn', 'type', 'press', 'merge', 'merged', 'approve', 'deliver', 'kb_write', 'propose', 'message',
])

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places
const minutes = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000
const isShape = (v: unknown): v is 'hierarchy' | 'holon' => v === 'hierarchy' || v === 'holon'
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const readActions = (dir: string) => {
  const file = join(dir, 'actions.jsonl')
  if (!existsSync(file)) return { actions: [] as Action[], missing: true, bad: 0 }
  const actions: Action[] = []
  let bad = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { actions.push(JSON.parse(line)) } catch { bad++ }
  }
  return { actions, missing: false, bad }
}

// Read a JSON file the way trace-report.ts does: missing or broken reads as empty.
const readJson = (path: string) => {
  if (!existsSync(path)) return {} as Record<string, any>
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any> } catch { return {} as Record<string, any> }
}

// Approvals file lines: builder, commit, UTC time.
const readApprovals = (path: string) => {
  const rows: { builder: string; commit: string; ts: string }[] = []
  const notes: string[] = []
  if (!existsSync(path)) return { rows, notes: [`approvals file not found: ${path}`] }
  readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return
    const fields = (line.includes(',') ? line.split(',') : line.split(/\s+/)).map(s => s.trim()).filter(Boolean)
    const builder = fields[0] ?? ''
    const commit = fields[1] ?? ''
    const time = fields.slice(2).join(' ')
    if (!builder || !time) {
      notes.push(`approvals line ${i + 1} skipped: expected "builder, commit, time"`)
      return
    }
    if (Number.isNaN(Date.parse(time))) {
      notes.push(`approvals line ${i + 1} skipped: unparsable time "${time}"`)
      return
    }
    rows.push({ builder, commit, ts: new Date(Date.parse(time)).toISOString() })
  })
  return { rows, notes }
}

const metrics = (dir: string) => {
  const notes: string[] = []
  const { actions, missing, bad } = readActions(dir)
  if (missing) notes.push('no actions.jsonl in this folder')
  if (bad) notes.push(`${bad} unreadable line(s) in actions.jsonl skipped`)

  // Org shape: 'hierarchy' or 'holon'. The run's directive.json carries it; manifest.json is the fallback.
  const directive = readJson(join(dir, 'directive.json'))
  const manifest = readJson(join(dir, 'manifest.json'))
  const shape = isShape(directive.shape) ? directive.shape : isShape(manifest.shape) ? manifest.shape : null
  if (!shape) notes.push('org is null: no shape in directive.json or manifest.json')

  const spawns = actions.filter(a => a.action === 'spawn')
  const builders = spawns.filter(a => a.args?.lead !== true)
  const builderSpawns = builders.length
  const g0BuilderSpawns = builders.filter(a => a.args?.grade === 0).length
  const g0Share = builderSpawns ? round(g0BuilderSpawns / builderSpawns, 4) : null
  if (!builderSpawns) notes.push('g0Share is null: no spawn with args.lead not true')

  const quotaHeals = actions.filter(a => a.action === 'heal' && a.args?.issue === 'quota').length

  // 'merge' is logged when a merge starts, so it counts as an attempt; only 'merged' is a landed merge.
  const landedMerges = actions.filter(a => a.action === 'merged')
  const mergeAttempts = actions.filter(a => a.action === 'merge').length
  // A merge names the builder by id; a merge with no id is matched by its label.
  const mergeMatches = (s: Action, e: Action) =>
    (!!s.target && e.target === s.target) || (!!s.args?.label && !e.target && e.args?.label === s.args.label)
  const mergeFor = (s: Action) => {
    const after = Date.parse(s.ts)
    return landedMerges.find(e => mergeMatches(s, e) && Date.parse(e.ts) >= after)
  }

  const spawnToMerge: number[] = []
  let byLabel = 0
  for (const s of builders) {
    const m = mergeFor(s)
    if (!m) continue
    if (!m.target) byLabel++
    spawnToMerge.push(minutes(s.ts, m.ts))
  }
  const spawnToMergeMinutes = {
    median: spawnToMerge.length ? round(median(spawnToMerge)!, 1) : null,
    n: spawnToMerge.length,
  }
  if (!spawnToMerge.length) notes.push('spawnToMergeMinutes.median is null: no builder spawn has a later landed merge')
  if (byLabel) notes.push(`${byLabel} spawn/landed-merge pair(s) matched by label, not by id`)

  const worktree = spawns.filter(a => a.args?.worktree === true)
  const neverMerged = worktree.filter(s => !landedMerges.some(e => mergeMatches(s, e)))
  const neverMergedShare = worktree.length ? round(neverMerged.length / worktree.length, 4) : null
  if (!worktree.length) notes.push('neverMergedShare is null: no spawn with args.worktree true')

  const mergeRefused = actions.filter(a => a.action === 'merge_refused').length

  // An answer with no caller is the human's; any other caller is a lead above.
  const askWaits: number[] = []
  const humanWaits: number[] = []
  const leadWaits: number[] = []
  let unanswered = 0
  let noId = 0
  let noCaller = 0
  for (const e of actions.filter(a => a.action === 'escalate')) {
    const id = e.args?.id
    if (id === undefined) { unanswered++; noId++; continue }
    const answer = actions.find(a => a.action === 'answer' && a.args?.id === id && Date.parse(a.ts) >= Date.parse(e.ts))
    if (!answer) { unanswered++; continue }
    const wait = minutes(e.ts, answer.ts)
    askWaits.push(wait)
    if (answer.caller === null) humanWaits.push(wait)
    else {
      leadWaits.push(wait)
      if (answer.caller === undefined) noCaller++
    }
  }
  if (noId) notes.push(`${noId} escalate event(s) had no args.id, counted as unanswered`)
  if (noCaller) notes.push(`${noCaller} answer event(s) had no caller field, counted as lead answers`)
  const askWaitMinutes = {
    human: {
      median: humanWaits.length ? round(median(humanWaits)!, 1) : null,
      max: humanWaits.length ? round(humanWaits.reduce((a, b) => (b > a ? b : a), 0), 1) : null,
      n: humanWaits.length,
    },
    lead: {
      median: leadWaits.length ? round(median(leadWaits)!, 1) : null,
      n: leadWaits.length,
    },
    unanswered,
    total: askWaits.length ? round(askWaits.reduce((a, b) => a + b, 0), 1) : null,
  }
  if (!askWaits.length) notes.push('askWaitMinutes total is null: no escalation was answered')
  if (!humanWaits.length) notes.push('askWaitMinutes.human.median is null: no answer came from the human')
  if (!leadWaits.length) notes.push('askWaitMinutes.lead.median is null: no answer came from a lead')

  // A daemon resume is logged as a 'restore' event with no caller.
  const restores = actions.filter(a => a.action === 'restore')
  const perRestart: (number | null)[] = []
  const idleMinutes: number[] = []
  let unreadableRestore = 0
  for (const r of restores) {
    const after = Date.parse(r.ts)
    if (Number.isNaN(after)) { perRestart.push(null); unreadableRestore++; continue }
    let next: Action | null = null
    for (const a of actions) {
      if (!WORK_ACTIONS.has(a.action)) continue
      const at = Date.parse(a.ts)
      if (Number.isNaN(at) || at <= after) continue
      if (!next || at < Date.parse(next.ts)) next = a
    }
    if (!next) { perRestart.push(null); continue }
    const idle = minutes(r.ts, next.ts)
    idleMinutes.push(idle)
    perRestart.push(round(idle, 1))
  }
  const restartIdle = {
    restarts: restores.length,
    medianIdleMinutes: idleMinutes.length ? round(median(idleMinutes)!, 1) : null,
    maxIdleMinutes: idleMinutes.length ? round(idleMinutes.reduce((a, b) => (b > a ? b : a), 0), 1) : null,
    perRestart,
  }
  if (!restores.length) notes.push('restartIdle is empty: no restore event in this folder')
  else {
    const noWork = restores.length - idleMinutes.length - unreadableRestore
    if (noWork) notes.push(`${noWork} restore event(s) had no later work action, idle minutes null`)
    if (unreadableRestore) notes.push(`${unreadableRestore} restore event(s) had an unparsable ts, idle minutes null`)
  }

  notes.push("a landed merge is a 'merged' action; 'merge' actions are attempts only, counted in mergeAttempts")
  notes.push('askWaitMinutes human waits are answers with a null caller, lead waits are answers from any other caller')
  notes.push("restartIdle counts 'restore' events (the daemon resume); idle is the minutes to the first later work action")
  notes.push('shares rounded to 4 decimals, minutes to 1')

  const out: Record<string, unknown> = {
    trace: basename(dir),
    path: dir,
    org: shape,
    builderSpawns,
    g0BuilderSpawns,
    g0Share,
    quotaHeals,
    spawnToMergeMinutes,
    worktreeBuilders: worktree.length,
    neverMergedShare,
    mergeAttempts,
    mergeRefused,
    askWaitMinutes,
    restartIdle,
  }

  if (approvalsPath) {
    const { rows, notes: approvalNotes } = readApprovals(approvalsPath)
    notes.push(...approvalNotes)
    const approvedNotMerged: string[] = []
    for (const r of rows) {
      const at = Date.parse(r.ts)
      const merged = actions.some(a => a.action === 'merged'
        && Date.parse(a.ts) > at
        && ((a.target && a.target === r.builder) || (a.args?.label && a.args.label === r.builder)))
      if (!merged && !approvedNotMerged.includes(r.builder)) approvedNotMerged.push(r.builder)
    }
    out.approvedNotMerged = approvedNotMerged
    if (!rows.length) notes.push('approvedNotMerged is empty: no usable approval lines')
  }

  out.note = notes.join('; ')
  return out
}

for (const dir of folders) console.log(JSON.stringify(metrics(dir)))
