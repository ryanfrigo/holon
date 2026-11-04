// Real-agent proof of worktrees, the merge queue and the knowledge base.
//
//   node scripts/e2e-org.ts
//
// A Claude lead in an empty repo spawns two Claude builders in their own worktrees, has
// each add a module with tests, merges both through the queue, and records a lesson.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon, serve, MCP_ENTRY } from '../packages/core/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'holon-org-'))
const home = join(root, 'home'), repo = join(root, 'calc')
mkdirSync(home); mkdirSync(repo)
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
execFileSync('git', ['init', '-q', '-b', 'main', repo])
git('config', 'user.email', 'holon@local'); git('config', 'user.name', 'holon')
writeFileSync(join(repo, 'package.json'), '{ "name": "calc", "type": "module" }\n')
git('add', '.'); git('commit', '-qm', 'init')
console.log(`root: ${root}`)

const sock = join(home, 'holon.sock')
const h = new Holon({ home, socketPath: sock, mcpEntry: MCP_ENTRY })
const server = await serve(h, sock)
const lead = await h.startDirective('test org', repo)   // gives us a KB and a Director brief
h.setTestCmd('node --test')
h.on('action', a => {
  if (['spawn', 'merge', 'merged', 'merge_refused', 'kb_write'].includes(a.action)) console.log(`  ${a.ts.slice(11, 19)} ${a.action} ${JSON.stringify(a.args).slice(0, 140)}`)
})
await h.wait(null, lead.id, 4000, 120_000)
// Replace the generic brief with a concrete task.
await h.type(null, lead.id, [
  'Ignore the strategy steps of your brief; this is a test of your tools. In this repo:',
  '1. spawn two builders (cli claude, worktree: true, yolo: true). Builder A: create add.js exporting add(a,b) and add.test.js using node:test.',
  'Builder B: create mul.js exporting mul(a,b) and mul.test.js using node:test. Each must git add + commit in its own worktree. Run them in parallel.',
  '2. When both have committed, merge_report each one. If one is refused, hand the reason back to that builder and retry.',
  '3. kb_write a lesson titled "Parallel builders via worktrees" describing what happened.',
  '4. Reply with the single word HOLON-DONE.',
].join('\n'))

const deadline = Date.now() + 15 * 60_000
let done = false
while (Date.now() < deadline && !done) {
  await new Promise(r => setTimeout(r, 5000))
  done = /^\s*(?:[⏺●]\s*)?HOLON-DONE\s*$/m.test(h.readScreen(null, lead.id, 300).text)
}
const tests = spawnSync('node', ['--test'], { cwd: repo, encoding: 'utf8' })
const log = git('log', '--oneline', 'main')
const kb = h.kbOverview()!
const checks = {
  'lead said done': done,
  'add.js and mul.js on main': existsSync(join(repo, 'add.js')) && existsSync(join(repo, 'mul.js')),
  'node --test passes on main': tests.status === 0,
  'two builder branches merged': (log.match(/\n/g) ?? []).length >= 2,
  'lesson in kb': kb.counts.lesson >= 1,
}
console.log('\n' + log)
console.log(JSON.stringify(checks, null, 2))
const ok = Object.values(checks).every(Boolean)
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
h.shutdown(); server.close()
process.exit(ok ? 0 : 1)
