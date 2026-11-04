import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Where an org's work lands: the repo and branch each seat's worktree was cut from (the Director
// integrates there by hand, outside merge_report), plus the project's own workspace checkout.
// The workspace alone misses orgs whose Director works in a separate clone on its own branch.
// Seats come and go (daemon restart, builders closed), so every (repo, ref) seen is remembered in
// landed-refs.json under the org home and unioned back in: the count must not drop to 0 and return.
export function landedRefs(home: string, workspace?: string): { repo: string; ref: string }[] {
  const out: { repo: string; ref: string }[] = []
  if (workspace) out.push({ repo: workspace, ref: 'HEAD' })
  const live: { repo: string; ref: string }[] = []
  try {
    const org = JSON.parse(readFileSync(join(home, 'org.json'), 'utf8'))
    const nodes: any[] = Array.isArray(org) ? org : (org?.nodes ?? [])
    for (const n of nodes) if (n?.worktree?.base && n.worktree.baseBranch) live.push({ repo: n.worktree.base, ref: n.worktree.baseBranch })
  } catch {}
  const file = join(home, 'landed-refs.json')
  let known: { repo: string; ref: string }[] = []
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(saved)) known = saved.filter((e) => typeof e?.repo === 'string' && typeof e?.ref === 'string')
  } catch {}
  const all = new Map<string, { repo: string; ref: string }>()
  for (const e of [...known, ...live]) if (existsSync(e.repo)) all.set(`${e.repo}\0${e.ref}`, { repo: e.repo, ref: e.ref })
  const merged = [...all.values()]
  if (JSON.stringify(merged) !== JSON.stringify(known)) {
    try { writeFileSync(file, JSON.stringify(merged)) } catch { /* the live refs still count this time */ }
  }
  return out.concat(merged)
}

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const firstParent = (repo: string, ref: string, since: string, until: string, ...extra: string[]) =>
  git(repo, 'rev-list', '--first-parent', `--since=${since}`, `--until=${until}`, ...extra, ref).split('\n').filter(Boolean)

// Unique first-parent commits in the window across every (repo, ref). Refs with different tips but
// shared history count a shared commit once. A hash names the same commit in any clone, so it is the key.
export function countLanded(home: string, workspace: string | undefined, since: string, until: string): number {
  const seen = new Set<string>()
  for (const { repo, ref } of landedRefs(home, workspace)) {
    if (!existsSync(repo)) continue
    try {
      for (const h of firstParent(repo, ref, since, until)) seen.add(h)
    } catch {}
  }
  return seen.size
}

// The first-parent commits of the window with their file stats, for a reviewer to read, each commit
// once under the first ref that has it. Refs with nothing new are left out.
export function landedLog(home: string, workspace: string | undefined, since: string, until: string): { repo: string; ref: string; count: number; log: string }[] {
  const seen = new Set<string>()
  const out: { repo: string; ref: string; count: number; log: string }[] = []
  for (const { repo, ref } of landedRefs(home, workspace)) {
    if (!existsSync(repo)) continue
    try {
      const fresh = firstParent(repo, ref, since, until).filter((h) => !seen.has(h))
      if (!fresh.length) continue
      for (const h of fresh) seen.add(h)
      const log = execFileSync('git', ['-C', repo, 'show', '--no-walk=unsorted', '--stat', '--format=commit %h %an %aI%n    %s', ...fresh],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim()
      out.push({ repo, ref, count: fresh.length, log })
    } catch {}
  }
  return out
}
