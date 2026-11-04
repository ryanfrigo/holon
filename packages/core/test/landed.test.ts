import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { countLanded, landedLog, landedRefs } from '../src/landed.ts'

const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

it('counts commits landed on the branch the org works on, not only the owner checkout the project points at', () => {
  const dir = mkdtempSync(join(tmpdir(), 'landed-'))
  const owner = join(dir, 'owner'), clone = join(dir, 'org-clone'), home = join(dir, 'home')
  mkdirSync(owner); mkdirSync(home)
  sh(owner, 'init', '-q', '-b', 'main')
  writeFileSync(join(owner, 'a'), '1'); sh(owner, 'add', '.'); sh(owner, 'commit', '-qm', 'base')
  execFileSync('git', ['clone', '-q', owner, clone])
  sh(clone, 'checkout', '-qb', 'holon/org')
  for (const n of ['x', 'y', 'z']) { writeFileSync(join(clone, n), n); sh(clone, 'add', '.'); sh(clone, 'commit', '-qm', n) }
  writeFileSync(join(home, 'org.json'), JSON.stringify([{ id: 'b1', worktree: { base: clone, baseBranch: 'holon/org', path: '/x', branch: 'holon/b1' } }]))
  const since = '2000-01-01T00:00:00Z', until = '2030-01-01T00:00:00Z'
  // The workspace (owner checkout, untouched) sees only the base commit; the org's branch has that
  // same commit plus 3. 4 unique commits, not 1 + 4.
  expect(countLanded(home, owner, since, until)).toBe(4)
  // A workspace that is itself the base branch is not counted twice.
  expect(countLanded(home, clone, since, until)).toBe(4)
  // Nothing in the window, nothing counted.
  expect(countLanded(home, owner, '2030-01-01T00:00:00Z', '2031-01-01T00:00:00Z')).toBe(0)
})

it('keeps counting a ref it has seen once after the node is gone from org.json, and forgets a repo that was deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'landed-'))
  const owner = join(dir, 'owner'), clone = join(dir, 'org-clone'), home = join(dir, 'home')
  mkdirSync(owner); mkdirSync(home)
  sh(owner, 'init', '-q', '-b', 'main')
  writeFileSync(join(owner, 'a'), '1'); sh(owner, 'add', '.'); sh(owner, 'commit', '-qm', 'base')
  execFileSync('git', ['clone', '-q', owner, clone])
  sh(clone, 'checkout', '-qb', 'holon/org')
  for (const n of ['x', 'y']) { writeFileSync(join(clone, n), n); sh(clone, 'add', '.'); sh(clone, 'commit', '-qm', n) }
  const since = '2000-01-01T00:00:00Z', until = '2030-01-01T00:00:00Z'
  writeFileSync(join(home, 'org.json'), JSON.stringify([{ id: 'b1', worktree: { base: clone, baseBranch: 'holon/org', path: '/x', branch: 'holon/b1' } }]))
  expect(countLanded(home, owner, since, until)).toBe(3)
  // Daemon restarted: no seat has a worktree. The workspace HEAD alone would read 1 (base, shared with the clone).
  writeFileSync(join(home, 'org.json'), JSON.stringify([{ id: 'b1' }]))
  expect(countLanded(home, owner, since, until)).toBe(3)
  rmSync(join(home, 'org.json'))
  expect(countLanded(home, owner, since, until)).toBe(3)
  // The repo is gone: the entry is dropped.
  rmSync(clone, { recursive: true })
  expect(countLanded(home, owner, since, until)).toBe(1)
  expect(landedRefs(home, owner)).toEqual([{ repo: owner, ref: 'HEAD' }])
})

it('counts a commit once when the workspace HEAD and the org branch share history but have different tips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'landed-'))
  const repo = join(dir, 'repo'), home = join(dir, 'home')
  mkdirSync(repo); mkdirSync(home)
  sh(repo, 'init', '-q', '-b', 'main')
  const commit = (n: string) => { writeFileSync(join(repo, n), n); sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', n) }
  commit('base'); commit('shared')
  sh(repo, 'checkout', '-qb', 'holon/org')
  commit('o1'); commit('o2')
  sh(repo, 'checkout', '-q', 'main'); commit('w1')
  writeFileSync(join(home, 'org.json'), JSON.stringify([{ id: 'b1', worktree: { base: repo, baseBranch: 'holon/org', path: '/x', branch: 'holon/b1' } }]))
  const since = '2000-01-01T00:00:00Z', until = '2030-01-01T00:00:00Z'
  // main: base, shared, w1 (3). holon/org: base, shared, o1, o2 (4). Union is 5, not 7.
  expect(countLanded(home, repo, since, until)).toBe(5)
  const log = landedLog(home, repo, since, until)
  expect(log.map((l) => [l.ref, l.count])).toEqual([['HEAD', 3], ['holon/org', 2]])
  expect(log[1].log).not.toContain('shared')
})
