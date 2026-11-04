// Real-agent proof of holon shape: three peers (Claude, Codex, OpenCode) and an auditor.
//
//   node scripts/e2e-holon.ts
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon, serve, MCP_ENTRY } from '../packages/core/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'holon-ring-'))
const home = join(root, 'home'), repo = join(root, 'wclite')
mkdirSync(home); mkdirSync(repo)
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
execFileSync('git', ['init', '-q', '-b', 'main', repo])
git('config', 'user.email', 'holon@local'); git('config', 'user.name', 'holon')
writeFileSync(join(repo, 'package.json'), '{ "name": "wclite", "type": "module" }\n')
git('add', '.'); git('commit', '-qm', 'init')
console.log(`root: ${root}`)

const sock = join(home, 'holon.sock')
const h = new Holon({ home, socketPath: sock, mcpEntry: MCP_ENTRY })
const server = await serve(h, sock)
const SHOW = new Set(['propose', 'critique', 'vote', 'proposal_passed', 'board_post', 'board_claim', 'board_done', 'merged', 'merge_refused', 'audit_round', 'kb_write', 'spawn'])
h.on('action', a => { if (SHOW.has(a.action)) console.log(`  ${a.ts.slice(11, 19)} ${a.caller ? h.list().find(n => n.id === a.caller)?.label ?? a.caller : 'human'} ${a.action} ${JSON.stringify(a.args).slice(0, 110)}`) })

await h.startDirective([
  'Build wc-lite in this git repo: a dependency-free Node CLI (wc.js) that prints line, word and character counts for a file,',
  'as functions in lib.js with tests in lib.test.js and wc.test.js runnable by `node --test`. Keep it tiny.',
  'Agree the plan with one proposal first. Split the work on the task board. Builders work in worktrees; merge with merge_report.',
  'When it is merged and `node --test` passes on main, post an update_human saying so.',
].join(' '), repo, undefined, 'holon', true)
h.setTestCmd('node --test')

const deadline = Date.now() + 25 * 60_000
const passing = () => existsSync(join(repo, 'lib.js')) && spawnSync('node', ['--test'], { cwd: repo }).status === 0
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 15_000))
  h.audit(Date.now(), 0)                         // audit as soon as there are claims
  await h.heal(Date.now(), false)                // the watcher, as the daemon runs it
  const d = h.getDirective()!
  if (passing() && (d.updates ?? []).length && (h.kbOverview()?.counts.fact ?? 0) >= 1) break
}
await new Promise(r => setTimeout(r, 60_000))    // let the auditor finish its round
const d = h.getDirective()!
const tasks = d.tasks ?? []
const checks = {
  'three peers + auditor': h.list().filter(n => n.parentId === null).length === 4,
  'a proposal with a critique passed': !!d.proposals?.some(p => p.status === 'passed' && p.critique),
  'tasks posted and claimed': tasks.length >= 2 && tasks.some(t => t.owner),
  'a task finished with evidence': tasks.some(t => t.status === 'done' && (t.result ?? '').length > 5),
  'node --test passes on main': passing(),
  'human got an update': (d.updates ?? []).length > 0,
  'auditor recorded findings': h.kbSearch('audit', 'fact').length > 0,
}
console.log('\n' + git('log', '--oneline', 'main'))
console.log(JSON.stringify(checks, null, 2))
const ok = Object.values(checks).every(Boolean)
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
h.shutdown(); server.close()
process.exit(ok ? 0 : 1)
