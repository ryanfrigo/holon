// Pause or resume orgs, one project or all of them. A paused org runs no agents and spends
// nothing; it stays paused across daemon restarts until resumed.
//   node scripts/pause.ts [--resume] [--reason "..."] (--all | project-slug ...)
//   node scripts/pause.ts --status
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HolonClient } from '../packages/core/src/client.ts'
import { listProjects, socketFor } from '../packages/core/src/projects.ts'

const args = process.argv.slice(2)
const flag = (f: string) => args.includes(f)
const reasonAt = args.indexOf('--reason')
const reason = reasonAt >= 0 ? args[reasonAt + 1] ?? '' : 'paused by the owner'
const slugs = args.filter((a, i) => !a.startsWith('--') && i !== reasonAt + 1)
const root = process.env.HOLON_HOME || join(homedir(), '.holon')
const all = listProjects(root)
const status = flag('--status')
const projects = status || flag('--all') ? all : all.filter(p => slugs.includes(p.slug))
if (!projects.length) {
  console.error(`usage: node scripts/pause.ts [--resume] [--reason "..."] (--all | ${all.map(p => p.slug).join(' | ')}) | --status`)
  process.exit(1)
}

for (const p of projects) {
  const file = join(p.home, 'paused.json')
  let c: HolonClient | undefined
  try { c = await HolonClient.connect(socketFor(p.home)) } catch {}
  if (status) {
    const paused = c ? await c.call('paused') : existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
    console.log(`${p.slug.padEnd(16)} ${paused ? `PAUSED since ${paused.at.slice(0, 16)}${paused.reason ? ` (${paused.reason})` : ''}` : 'running'}${c ? '' : '  [daemon down]'}`)
  } else if (flag('--resume')) {
    // No daemon: removing the file is enough, the next daemon start restores the org.
    const n = c ? await c.call('resume') : (rmSync(file, { force: true }), 0)
    console.log(`${p.slug}: resumed${c ? `, ${n} terminals back` : ' (daemon down; restores on next start)'}`)
  } else {
    // No daemon: the file alone keeps the next start from bringing any agent back.
    if (c) await c.call('pause', { reason })
    else if (!existsSync(file)) writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), reason }, null, 2))
    console.log(`${p.slug}: paused${c ? '' : ' (daemon down; stays paused on next start)'}`)
  }
  c?.close?.()
}
process.exit(0)
