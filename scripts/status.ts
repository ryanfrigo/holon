// One screen per project: what every org is doing right now, what it shipped, and what it
// needs from you. Read-only; talks to the daemons over their unix sockets.
//   node --experimental-strip-types scripts/status.ts [project-slug ...]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { HolonClient } from '../packages/core/src/client.ts'
import { listProjects, socketFor } from '../packages/core/src/projects.ts'

const only = process.argv.slice(2)
const root = join(homedir(), '.holon')
const projects = listProjects(root).filter(p => !only.length || only.includes(p.slug))

const esc = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim()

for (const p of projects) {
  let c: HolonClient
  try { c = await HolonClient.connect(socketFor(p.home)) } catch {
    console.log(`\n━━ ${p.name} ━━  daemon not reachable at ${p.home}`)
    continue
  }
  const call = async (m: string, params: Record<string, unknown> = {}) => {
    try { return await c.call(m, params) } catch (e) { return { error: (e as Error).message } }
  }
  const [list, dir, usage, escs, board] = await Promise.all([call('list'), call('directive'), call('usage'), call('escalations'), call('board_list')])
  const t = (dir as any)?.treasury
  console.log(`\n━━ ${p.name} ━━  ${p.workspace ?? dir?.workspace ?? ''}   status ${(dir as any)?.status ?? '?'}, autopilot ${(dir as any)?.autopilot}`)
  if (t?.runwayMin !== undefined) console.log(`   runway ${t.runwayMin}/${t.budgetMin} agent-min, MRR $${t.settledMrr}`)

  const u = usage as Record<string, { label?: string; costUsd?: number; model?: string }>
  const terms = (Array.isArray(list) ? list : []) as { id: string; label: string; cli: string; model?: string; grade?: number; state?: string; exitCode?: number }[]
  const total = Object.values(u).reduce((s, x) => s + (x.costUsd ?? 0), 0)
  console.log(`   ${terms.length} seats, API-equiv spend $${total.toFixed(2)}`)
  for (const s of terms)
    console.log(`   - ${s.label.padEnd(24)} ${s.cli.padEnd(9)} ${String(s.grade ?? '').padEnd(3)} ${String(s.model ?? '').padEnd(20)} ${s.exitCode !== undefined ? `exited(${s.exitCode})` : 'running'}`)

  const open = (escs as any[]).filter(e => e.status === 'open')
  if (open.length) {
    console.log(`   needs from you (${open.length}):`)
    for (const e of open.slice(-6)) console.log(`   ? ${esc(e.message).slice(0, 200)}`)
  }
  const tasks = (Array.isArray(board) ? board : []).filter(x => x.status === 'open' || x.status === 'claimed')
  if (tasks.length) console.log(`   board open/claimed: ${tasks.map(x => esc(x.title).slice(0, 60)).join(' | ')}`)

  // What changed in the workspace in the last 24h (commits), in the running checkout.
  const ws = (dir as any)?.workspace ?? p.workspace
  if (ws && existsSync(ws)) {
    try {
      const log = execFileSync('git', ['-C', ws, 'log', '--oneline', '--since=24 hours ago'], { encoding: 'utf8' }).trim()
      const n = log ? log.split('\n').length : 0
      console.log(`   commits last 24h: ${n}`)
      for (const line of log.split('\n').slice(0, 5)) console.log(`     ${line}`)
    } catch {}
  }
  const homeLog = ws ? join(ws, 'HOLON-LOG.md') : undefined
  if (homeLog && existsSync(homeLog)) {
    const heads = readFileSync(homeLog, 'utf8').split('\n').filter(l => l.startsWith('### ') || l.startsWith('## ')).slice(-4)
    for (const hh of heads) console.log(`   ${hh.trim()}`)
  }
  c.close()
}
process.exit(0)
