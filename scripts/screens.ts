// Screenshots of the desktop app as the owner sees it: every project, every view, from the live
// daemons. Builds the app from this checkout first, so a branch's UI change can be looked at.
//   node scripts/screens.ts [out-dir] [--no-build] [--fresh] [--no-claude]    PNGs land in ~/.holon/shots/<time> by default
//   --fresh: a stranger's first run. HOME and HOLON_HOME point at an empty scratch dir: no orgs, no
//   Claude or Codex login files, no plan data. Your own daemons are untouched.
//   --no-claude (needs --fresh): a Codex-only stranger. PATH is a scratch dir holding node, npm, git and a fake
//   `codex` script, so no claude is found and no real agent CLI can run.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootOf } from '../packages/core/src/projects.ts'

const DESK = join(import.meta.dirname, '..', 'apps/desktop')
const args = process.argv.slice(2)
const fresh = args.includes('--fresh')
const scratch = fresh ? mkdtempSync(join(tmpdir(), 'holon-fresh-')) : ''
if (fresh) mkdirSync(join(scratch, '.holon'))
const noClaude = args.includes('--no-claude')
if (noClaude && !fresh) throw new Error('--no-claude needs --fresh: it must not touch your own setup')
const env: NodeJS.ProcessEnv = fresh ? { ...process.env, HOME: scratch, HOLON_HOME: join(scratch, '.holon'), HOLON_SHOTS_SEED: '1' } : process.env
if (noClaude) {
  // Symlinks to the few tools the app needs, plus a codex that only prints a line. Nothing else is on PATH.
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  const where = (c: string) => execFileSync('which', [c], { encoding: 'utf8' }).trim()
  for (const c of ['node', 'npm', 'npx', 'git']) if (existsSync(where(c))) symlinkSync(where(c), join(bin, c))
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho "fake codex (screens.ts)"\n')
  chmodSync(join(bin, 'codex'), 0o755)
  env.PATH = bin
}
const out = args.find(a => !a.startsWith('--')) ??
  join(rootOf(process.env.HOLON_HOME || join(homedir(), '.holon')), 'shots', new Date().toISOString().slice(0, 16).replace(/:/g, ''))
// Not through npx: it needs `sh`, which the --no-claude PATH leaves out.
const electronBin = [join(DESK, 'node_modules/.bin/electron'), join(DESK, '../../node_modules/.bin/electron')].find(existsSync) ?? 'electron'
if (!args.includes('--no-build')) execFileSync('npx', ['electron-vite', 'build'], { cwd: DESK, stdio: 'ignore' })
execFileSync(electronBin, ['.', '--shots', out], { cwd: DESK, stdio: ['ignore', 'ignore', 'inherit'], timeout: 10 * 60_000, env })
const files = readdirSync(out).filter(f => f.endsWith('.png')).sort()
console.log(`${files.length} screenshots in ${out}`)
for (const f of files) console.log(`  ${join(out, f)}`)
