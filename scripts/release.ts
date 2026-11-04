// Export main as a public snapshot: a separate repo with its own history, one commit per release.
// The working repo stays private: its history carries the owner's org logs, and the Holon org commits
// to main all day. Files marked export-ignore in .gitattributes are left out; home paths become ~.
//   node scripts/release.ts [~/dev/holon-public]   then review and push from there
//   RELEASE_AUTHOR='Name <email>' sets the commit author (default Holon <noreply@localhost>), never the git config here.
//   Names that must not ship (your other orgs, your handle) are read from ~/.holon/release-deny.txt, not from the repo.
//   RELEASE_REF=<branch> exports that ref instead of main (to audit a branch before it lands). Nothing is pushed.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findLeaks, parseDenyList } from './release-scan.ts'

const REPO = join(import.meta.dirname, '..')
const REF = process.env.RELEASE_REF || 'main'
const OUT = process.argv[2] || join(homedir(), 'dev/holon-public')
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

if (!existsSync(join(OUT, '.git'))) { mkdirSync(OUT, { recursive: true }); git(OUT, 'init', '-q', '-b', 'main') }
for (const f of readdirSync(OUT)) if (f !== '.git') rmSync(join(OUT, f), { recursive: true, force: true })
execFileSync('sh', ['-c', `git archive ${JSON.stringify(REF)} | tar -x -C ${JSON.stringify(OUT)}`], { cwd: REPO })

const home = homedir()
for (const f of git(OUT, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean)) {
  const p = join(OUT, f)
  if (!existsSync(p)) continue
  const text = readFileSync(p, 'utf8')
  if (text.includes('\0') || !text.includes(home)) continue
  writeFileSync(p, text.replaceAll(home, '~'))
}

const DENY = join(home, '.holon/release-deny.txt')
if (!existsSync(DENY)) { console.error(`not committed: ${DENY} is missing. List the names that must not ship, one per line (see scripts/release-scan.ts).`); process.exit(1) }
const list = parseDenyList(readFileSync(DENY, 'utf8'))
const leaks = git(OUT, 'ls-files', '-co', '--exclude-standard').split('\n').filter(f => f && f !== 'package-lock.json').flatMap(f => {
  const text = readFileSync(join(OUT, f), 'utf8')
  return text.includes('\0') ? [] : findLeaks(f, text, list)
})
if (leaks.length) { console.error(`not committed: the export names the owner or their other projects:\n${leaks.join('\n')}`); process.exit(1) }

git(OUT, 'add', '-A')
if (!git(OUT, 'status', '--porcelain')) { console.log('nothing changed since the last release'); process.exit(0) }
const sha = git(REPO, 'rev-parse', '--short', REF)
// The commit carries a neutral author, not whoever's git config is active here (the owner's name and email).
const who = process.env.RELEASE_AUTHOR || 'Holon <noreply@localhost>'
const [, name, email] = who.match(/^(.*?)\s*<(.+)>$/) || ['', who, 'noreply@localhost']
git(OUT, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--author', `${name} <${email}>`, '-m', `Release from ${sha}`)
console.log(`committed ${git(OUT, 'rev-parse', '--short', 'HEAD')} in ${OUT} (from ${REF} ${sha}); review it, then git push`)
