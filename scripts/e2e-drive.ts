// Headless proof that a lead can drive another agent through Holon.
//
//   node scripts/e2e-drive.ts --report claude|codex
//
// Starts a private Holon (temp HOLON_HOME), a Claude lead, and a report in an empty
// git repo. Types one task into the lead, then only watches: it passes when the
// report's fizzbuzz tests pass and the lead says HOLON-DONE.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Holon, serve, MCP_ENTRY, type Cli } from '../packages/core/src/index.ts'

const { values } = parseArgs({ options: {
  report: { type: 'string', default: 'claude' },
  'timeout-min': { type: 'string', default: '20' },
} })
const reportCli = values.report as Cli
const deadline = Date.now() + Number(values['timeout-min']) * 60_000

const root = mkdtempSync(join(tmpdir(), 'holon-e2e-'))
const home = join(root, 'home'), repo = join(root, 'repo'), leadDir = join(root, 'lead')
for (const d of [home, repo, leadDir]) mkdirSync(d, { recursive: true })
execFileSync('git', ['init', '-q'], { cwd: repo })
console.log(`root: ${root}`)

const sock = join(home, 'holon.sock')
const h = new Holon({ home, socketPath: sock, mcpEntry: MCP_ENTRY })
const server = await serve(h, sock)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const lead = h.create({ label: 'Lead', cli: 'claude', cwd: leadDir, lead: true })
const report = h.create({ label: 'Builder', cli: reportCli, cwd: repo, parentId: lead.id })
console.log(`lead ${lead.id} (claude) → report ${report.id} (${reportCli})`)
h.on('action', a => {
  const what = a.action === 'type' ? JSON.stringify(String(a.args.text).slice(0, 70)) : a.action === 'press' ? `"${a.args.key}"` : a.action === 'wait_done' ? String(a.args.state) : ''
  console.log(`  ${a.ts.slice(11, 19)}  ${a.action.padEnd(11)} ${what}`)
})

// Setup only: get the lead itself past its folder-trust prompt. The report's prompts are the lead's job.
const leadTerm = () => h.readScreen(null, lead.id).text
await h.wait(null, lead.id, 3000, 60_000)
if (/trust this folder/i.test(leadTerm())) {
  h.press(null, lead.id, 'Down'); await sleep(300); h.press(null, lead.id, 'Enter')
  await h.wait(null, lead.id, 3000, 60_000)
}

await h.type(null, lead.id, [
  `Your report "${report.id}" is a ${reportCli === 'claude' ? 'Claude Code' : 'Codex'} session in ${repo}, an empty git repo.`,
  `Using only your holon tools, have it build a Node fizzbuzz CLI there: fizzbuzz.js prints 1..N (N from argv) with Fizz/Buzz/FizzBuzz,`,
  `plus tests in fizzbuzz.test.js that run with \`node --test\`. Have it run the tests and confirm they pass.`,
  `It may show trust or permission prompts first; read its screen and answer them. When the tests pass, reply with the single word HOLON-DONE.`,
].join(' '))

function testsPass(): boolean {
  try {
    readFileSync(join(repo, 'fizzbuzz.test.js'))
    return spawnSync('node', ['--test'], { cwd: repo, timeout: 30_000 }).status === 0
  } catch { return false }
}

let ok = false
while (Date.now() < deadline) {
  await sleep(5000)
  // A line that is only HOLON-DONE (optionally after Claude's reply marker); the task
  // text we typed also contains the word, but never alone on a line.
  if (/^\s*(?:[⏺●]\s*)?HOLON-DONE\s*$/m.test(h.readScreen(null, lead.id, 200).text)) {
    ok = testsPass()
    break
  }
}

writeFileSync(join(root, 'lead-screen.txt'), h.readScreen(null, lead.id, 2000).text)
writeFileSync(join(root, 'report-screen.txt'), h.readScreen(null, report.id, 2000).text)
const actions = readFileSync(join(home, 'actions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
const byLead = actions.filter(a => a.caller === lead.id)
const count = (k: string) => byLead.filter(a => a.action === k).length
console.log(`\nlead actions: ${byLead.length} (type ${count('type')}, press ${count('press')}, read ${count('read_screen')}, wait ${count('wait')})`)
console.log(`repo files: ${execFileSync('ls', [repo]).toString().trim().replace(/\n/g, ' ')}`)
console.log(`tests pass: ${testsPass()}`)
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
h.shutdown(); server.close()
process.exit(ok ? 0 : 1)
