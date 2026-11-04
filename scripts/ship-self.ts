// Ship the Holon org's own work: merge branch `self` into main, run the tests, and restart every
// daemon on the new code. Daemons run from this checkout, so nothing on `self` is live until this runs.
//   node scripts/ship-self.ts            merge + test here, then restart in a detached process
//   node scripts/ship-self.ts --restart  restart only (no merge)
//   add --app to rebuild and reopen the desktop app even when apps/desktop did not change
// The restart runs detached because the Holon Director's own terminal dies with its daemon. If any
// daemon fails to come back, main is reset to where it was and the daemons restart on the old code.
// When apps/desktop changed, the app is rebuilt and reopened too, so the owner sees what shipped.
// The outcome is appended to ~/.holon/ship-self.log; read it after you are restored.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HolonClient } from '../packages/core/src/client.ts'
import { listProjects, rootOf, socketFor } from '../packages/core/src/projects.ts'
import { rollingRestart } from '../packages/core/src/ship.ts'

const REPO = join(import.meta.dirname, '..')
// The Holon org's own worktree (branch `self`), fast-forwarded to main after a ship: HOLON_SELF if
// set, else whichever worktree of this repo has `self` checked out. None (a stranger's clone): skipped.
const selfWorktree = (): string | undefined => {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
    for (const block of out.split('\n\n')) {
      const lines = block.split('\n')
      if (lines.includes('branch refs/heads/self')) return lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length)
    }
  } catch {}
  return undefined
}
const SELF = process.env.HOLON_SELF || selfWorktree()
// A Director's terminal has HOLON_HOME set to its project's home; every org hangs off the root.
const root = rootOf(process.env.HOLON_HOME || join(homedir(), '.holon'))
const LOG = join(root, 'ship-self.log')
const args = process.argv.slice(2)
const git = (...a: string[]) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim()
const say = (line: string) => { console.log(line); appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function up(home: string, ms = 30_000) {
  for (let t = 0; t < ms; t += 500) {
    try { const c = await HolonClient.connect(socketFor(home)); await c.call('paused'); c.close(); return true } catch {}
    await sleep(500)
  }
  return false
}

async function restartOne(home: string) {
  const pidFile = join(home, 'daemon.pid')
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : 0
  if (pid) {
    try { process.kill(pid, 'SIGTERM') } catch {}
    for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); await sleep(250) } catch { break } }
  }
  const log = openSync(join(home, 'daemon.log'), 'a')
  spawn(process.env.SHELL || '/bin/zsh', ['-lc', `exec node ${JSON.stringify(join(REPO, 'packages/core/src/daemon.ts'))}`], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, HOLON_HOME: home, HOLON_SOCKET: socketFor(home) },
  }).unref()
}

// One org at a time: a restart kills a merge mid-run and any seat mid-command (exit 137), so each
// org gets its merges and seats waited out (bounded) before it, and only it, is restarted.
async function restartAll() {
  const projects = listProjects(root)
  const slug = (home: string) => projects.find(p => p.home === home)?.slug ?? home
  const down = await rollingRestart(projects.map(p => p.home), {
    restart: restartOne, up, say, name: slug,
    mergeWaitMs: Number(process.env.SHIP_MERGE_WAIT_MS) || 20 * 60_000,
    quietWaitMs: Number(process.env.SHIP_QUIET_WAIT_MS) || 10 * 60_000,
  })
  return down.map(slug)
}

// One ship at a time: the owner and the Holon org can both run this, and a run that resets main on
// failing tests would wipe a commit the other made meanwhile. The detached restart holds it to the end.
const LOCK = join(root, 'ship-self.lock')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const holder = existsSync(LOCK) ? Number(readFileSync(LOCK, 'utf8')) : 0
if (holder && holder !== process.ppid && holder !== process.pid && alive(holder)) { say(`refused: another ship is running (pid ${holder}); run again when ${LOG} shows it finished`); process.exit(1) }
writeFileSync(LOCK, String(process.pid))
const done = (code: number) => { rmSync(LOCK, { force: true }); process.exit(code) }

// The app shows what shipped only once it is rebuilt and reopened; the daemons outlive it. The
// renderer builds while the old app still runs, so a broken build leaves the owner's window alone.
function rebuildApp() {
  const DESK = join(REPO, 'apps/desktop')
  const run = (cmd: string, a: string[]) => execFileSync(cmd, a, { cwd: DESK, stdio: 'ignore' })
  try { run('npx', ['electron-vite', 'build']) } catch { say('FAILED: app build (electron-vite build); the running app is unchanged'); return }
  try { execFileSync('osascript', ['-e', 'quit app "Holon"'], { stdio: 'ignore' }) } catch {}
  for (let i = 0; i < 40; i++) { try { execFileSync('pgrep', ['-f', 'Holon.app/Contents/MacOS/Holon']); execFileSync('sleep', ['0.25']) } catch { break } }
  try { run('npx', ['electron-builder', '--mac', 'dir', '--config.mac.identity=null']) } catch { say('FAILED: app packaging (electron-builder); reopening what is there') }
  // Not with this process's HOLON_HOME: from a Director's terminal that is one project's home.
  const { HOLON_HOME: _h, HOLON_SOCKET: _s, ...env } = process.env
  try { execFileSync('open', [join(DESK, 'dist/mac-arm64/Holon.app')], { env }); say('app rebuilt and reopened') } catch { say('FAILED: could not reopen the app') }
}

if (args.includes('--detached')) {
  // Give the caller a moment to print its last line before its daemon goes away.
  await sleep(2000)
  const prev = args[args.indexOf('--detached') + 1]
  const down = await restartAll()
  if (!down.length) {
    say(`OK: every daemon restarted on main ${git('rev-parse', '--short', 'HEAD')}`)
    if (args.includes('--app') || (prev && git('diff', '--name-only', prev, 'HEAD', '--', 'apps/desktop'))) rebuildApp()
  }
  else if (prev && prev !== git('rev-parse', 'HEAD')) {
    say(`FAILED: ${down.join(', ')} did not come back on ${git('rev-parse', '--short', 'HEAD')}; resetting main to ${prev.slice(0, 7)} and restarting`)
    git('reset', '--hard', prev)
    const still = await restartAll()
    say(still.length ? `STILL DOWN after rollback: ${still.join(', ')} (see their daemon.log)` : `rolled back: every daemon is up on ${prev.slice(0, 7)}`)
  } else say(`FAILED: ${down.join(', ')} did not come back (see their daemon.log)`)
  done(0)
}

if (git('status', '--porcelain', '--untracked-files=no')) { say('refused: main checkout has uncommitted changes'); done(1) }
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') { say('refused: main checkout is not on main'); done(1) }
const prev = git('rev-parse', 'HEAD')
if (!args.includes('--restart')) {
  try { git('merge', '--no-edit', 'self') } catch (e) { git('merge', '--abort'); say(`refused: self does not merge cleanly into main: ${(e as Error).message.split('\n')[0]}`); done(1) }
  if (git('rev-parse', 'HEAD') === prev) say('nothing new on self; restarting anyway')
  try { execFileSync('npm', ['test'], { cwd: REPO, stdio: 'inherit' }) } catch {
    git('reset', '--hard', prev)
    say(`refused: tests fail with self merged; main is back at ${prev.slice(0, 7)}`)
    done(1)
  }
  say(`merged self into main: ${prev.slice(0, 7)} -> ${git('rev-parse', '--short', 'HEAD')}`)
  // Keep the org's worktree on the same code it just shipped.
  if (SELF) try { execFileSync('git', ['merge', '--ff-only', 'main'], { cwd: SELF, stdio: 'ignore' }) } catch { say(`note: ${SELF} could not fast-forward to main`) }
  if (git('diff', '--name-only', prev, 'HEAD', '--', 'apps/desktop').length) say('apps/desktop changed: the app will be rebuilt and reopened after the restart')
}
const child = spawn(process.execPath, [import.meta.filename, '--detached', prev, ...(args.includes('--app') ? ['--app'] : [])], { detached: true, stdio: 'ignore', cwd: REPO })
writeFileSync(LOCK, String(child.pid))   // the restart holds the lock until it logs its outcome
child.unref()
say('restarting every daemon in a detached process; your terminal will close and come back')
