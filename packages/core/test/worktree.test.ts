import { beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addWorktree, mergeBranch, removeWorktree } from '../src/worktree.ts'

// The key is built here, never written out: a real-looking key in a test file is exactly
// what this scan is meant to catch.
const { scanFail, FAKE_KEY } = vi.hoisted(() => ({ scanFail: { on: false }, FAKE_KEY: 'sk-' + 'a'.repeat(40) }))

// execFileSync cannot be spied on directly (an ESM namespace is not configurable), so the
// module is mocked and every call but the forced scan diff is passed through unchanged.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: ((...a: Parameters<typeof actual.execFileSync>) => {
      const [file, args] = a
      if (scanFail.on && file === 'git' && Array.isArray(args) && args.includes('diff') && args.includes('-U0')) {
        throw new Error(`fatal: bad object ${FAKE_KEY}`)
      }
      return actual.execFileSync(...a)
    }) as typeof actual.execFileSync,
  }
})

let root: string, base: string
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
const commit = (cwd: string, file: string, text: string) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, 'commit', '-qm', file) }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-'))
  base = join(root, 'repo')
  mkdirSync(join(base, 'node_modules'), { recursive: true })
  git(root, 'init', '-q', '-b', 'main', base)
  git(base, 'config', 'user.email', 't@t'); git(base, 'config', 'user.name', 't')
  writeFileSync(join(base, '.gitignore'), 'node_modules\n.env.local\n')
  commit(base, 'a.txt', 'one\n')
  writeFileSync(join(base, '.env.local'), 'X=1\n')
})

it('branches a worktree with env and node_modules, then merges it after tests pass', async () => {
  const wt = addWorktree(base, join(root, 'wt1'), 'holon/b1')
  expect(existsSync(join(wt.path, '.env.local'))).toBe(true)
  expect(existsSync(join(wt.path, 'node_modules'))).toBe(true)
  commit(wt.path, 'b.txt', 'two\n')
  const r = await mergeBranch(wt, 'test -f b.txt')
  expect(r.merged).toBe(true)
  expect(existsSync(join(base, 'b.txt'))).toBe(true)
  expect(removeWorktree(wt)).toBe(true)
})

it('refuses to merge when tests fail, and reports conflicts without leaving a broken rebase', async () => {
  const wt = addWorktree(base, join(root, 'wt2'), 'holon/b2')
  commit(wt.path, 'a.txt', 'from builder\n')
  expect((await mergeBranch(wt, 'exit 1')).reason).toMatch(/tests failed/)
  commit(base, 'a.txt', 'from main\n')
  const r = await mergeBranch(wt, 'true')
  expect(r.merged).toBe(false)
  expect(r.conflicts).toEqual(['a.txt'])
  expect(git(wt.path, 'status', '--porcelain', '--untracked-files=no')).toBe('')
})

it('requires committed work', async () => {
  const wt = addWorktree(base, join(root, 'wt3'), 'holon/b3')
  writeFileSync(join(wt.path, 'a.txt'), 'dirty\n')
  expect((await mergeBranch(wt)).reason).toMatch(/uncommitted/)
  expect(removeWorktree(wt)).toBe(false)
})

it('names the uncommitted base files that block a merge', async () => {
  const wt = addWorktree(base, join(root, 'wt4'), 'holon/b4')
  commit(wt.path, 'a.txt', 'three\n')
  writeFileSync(join(base, 'a.txt'), 'org log edit in progress\n')
  const r = await mergeBranch(wt, 'true')
  expect(r.merged).toBe(false)
  expect(r.reason).toMatch(/uncommitted changes \(a\.txt\)/)
})

it('merges past an uncommitted base file the branch does not change, and leaves it as it was', async () => {
  commit(base, 'pilot.csv', 'a\n')
  const wt = addWorktree(base, join(root, 'wt-csv'), 'holon/csv')
  commit(wt.path, 'csv-feature.txt', 'x\n')
  writeFileSync(join(base, 'pilot.csv'), 'a\nappended by the org\n')
  const r = await mergeBranch(wt, 'true')
  expect(r.merged).toBe(true)
  expect(existsSync(join(base, 'csv-feature.txt'))).toBe(true)
  expect(readFileSync(join(base, 'pilot.csv'), 'utf8')).toBe('a\nappended by the org\n')
  git(base, 'checkout', '--', 'pilot.csv')
})

it('commits an org log left uncommitted in the base, then merges without a second test run', async () => {
  commit(base, 'HOLON-LOG.md', 'log\n')
  const wt = addWorktree(base, join(root, 'wt-notes'), 'holon/notes')
  commit(wt.path, 'd.txt', 'four\n')
  writeFileSync(join(base, 'HOLON-LOG.md'), 'log\nlead appended this\n')
  const runs = join(root, 'runs')
  const r = await mergeBranch(wt, `echo x >> ${runs}`)
  expect(r.merged).toBe(true)
  expect(git(base, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  expect(git(base, 'log', '-1', '--format=%s', 'HEAD~1')).toMatch(/commit org notes before merge \(HOLON-LOG\.md\)/)
  expect(existsSync(join(base, 'd.txt'))).toBe(true)
  expect(execFileSync('wc', ['-l', runs], { encoding: 'utf8' }).trim()).toMatch(/^1 /)
})

it('when the base moves while tests run, it rebases and tests again instead of failing', async () => {
  const wt = addWorktree(base, join(root, 'wt-race'), 'holon/race')
  commit(wt.path, 'b.txt', 'builder\n')
  // The first test run lands a commit on main mid-merge, as a lead logging to the base would.
  const flag = join(root, 'landed')
  const tests = `test -f ${flag} || (echo log > ${base}/LOG.md && git -C ${base} add LOG.md && git -C ${base} commit -qm log && touch ${flag})`
  const r = await mergeBranch(wt, tests)
  expect(r.merged).toBe(true)
  expect(existsSync(join(base, 'b.txt')) && existsSync(join(base, 'LOG.md'))).toBe(true)
})

it('refuses to merge a branch that adds a secret-shaped line, naming file:line only', async () => {
  const wt = addWorktree(base, join(root, 'wt-secret'), 'holon/secret')
  commit(wt.path, 'config.ts', `const key = "${FAKE_KEY}"\n`)
  const marker = join(root, 'warn-tests-ran')
  const r = await mergeBranch(wt, `touch ${marker}`)
  expect(r.merged).toBe(false)
  expect(r.reason).toBe('secret scan: 1 warning(s) at config.ts:1; add // secret-scan:allow to lines that are not secrets')
  expect(r.reason).not.toContain(FAKE_KEY)
  // Refused before the rebase and the tests: the worktree is untouched and the test never ran.
  expect(existsSync(marker)).toBe(false)
  expect(git(wt.path, 'status', '--porcelain', '--untracked-files=no')).toBe('')
})

// A gate that cannot see must refuse, and its reason must not carry the git error (which can quote the diff).
it('refuses to merge when the diff scan cannot run, without repeating the git error', async () => {
  const wt = addWorktree(base, join(root, 'wt-blind'), 'holon/blind')
  commit(wt.path, 'b.txt', 'two\n')
  const marker = join(root, 'blind-tests-ran')
  scanFail.on = true
  try {
    const r = await mergeBranch(wt, `touch ${marker}`)
    expect(r.merged).toBe(false)
    expect(r.reason).toBe('secret scan could not run; merge refused until the branch can be scanned')
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(base, 'b.txt'))).toBe(false)
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(r)).not.toContain('bad object')
  } finally {
    scanFail.on = false
  }
})

it('merges the same line when it carries the secret-scan:allow marker', async () => {
  const wt = addWorktree(base, join(root, 'wt-allow'), 'holon/allow')
  commit(wt.path, 'config.ts', `const key = "${FAKE_KEY}" // secret-scan:allow\n`)
  const r = await mergeBranch(wt, 'true')
  expect(r.merged).toBe(true)
  expect(r.output).toContain('1 allowed (config.ts:1)')
  expect(r.output).not.toContain(FAKE_KEY)
})

it('still merges a clean branch and reports the scan clean', async () => {
  const wt = addWorktree(base, join(root, 'wt-clean'), 'holon/clean')
  commit(wt.path, 'b.txt', 'two\n')
  const r = await mergeBranch(wt, 'true')
  expect(r.merged).toBe(true)
  expect(r.output).toContain('secret scan: clean')
})

it('runs the acceptance check on the rebased tree, so a fix that landed after the branch was cut counts', async () => {
  commit(base, 'gate.txt', 'broken\n')
  const wt = addWorktree(base, join(root, 'wt-check'), 'holon/b-check')
  commit(wt.path, 'feature.txt', 'work\n')
  // The base repairs the gate after the branch was cut; the branch tree alone still fails it.
  commit(base, 'gate.txt', 'fixed\n')
  const check = 'grep -q fixed gate.txt'
  expect(() => execFileSync('sh', ['-c', check], { cwd: wt.path })).toThrow()
  const r = await mergeBranch(wt, undefined, check)
  expect(r.merged).toBe(true)
  expect(r.checkFailed).toBeUndefined()
  expect(existsSync(join(base, 'feature.txt'))).toBe(true)
})

it('still refuses a branch whose acceptance check fails on the rebased tree, and a conflict still lists its files', async () => {
  const wt = addWorktree(base, join(root, 'wt-check2'), 'holon/b-check2')
  commit(wt.path, 'feature.txt', 'work\n')
  const bad = await mergeBranch(wt, undefined, 'exit 1')
  expect(bad).toMatchObject({ merged: false, checkFailed: true })
  expect(bad.reason).toMatch(/acceptance check failed/)
  expect(existsSync(join(base, 'feature.txt'))).toBe(false)
  commit(wt.path, 'a.txt', 'from builder\n')
  commit(base, 'a.txt', 'from main\n')
  const c = await mergeBranch(wt, undefined, 'true')
  expect(c.conflicts).toEqual(['a.txt'])
})

it('commits notes left in docs/inbox/ too, but a code edit in the base alongside them still refuses the merge when the branch changes that file', async () => {
  mkdirSync(join(base, 'docs', 'inbox'), { recursive: true })
  commit(base, 'docs/inbox/n1.md', 'one\n')
  const wt = addWorktree(base, join(root, 'wt-inbox'), 'holon/inbox')
  commit(wt.path, 'e.txt', 'five\n')
  writeFileSync(join(base, 'docs', 'inbox', 'n1.md'), 'one\ntwo\n')
  const ok = await mergeBranch(wt, 'true')
  expect(ok.merged).toBe(true)
  expect(git(base, 'log', '--format=%s', '-2')).toMatch(/commit org notes before merge \(docs\/inbox\/n1\.md\)/)

  const wt2 = addWorktree(base, join(root, 'wt-mixed'), 'holon/mixed')
  commit(wt2.path, 'a.txt', 'six\n')
  writeFileSync(join(base, 'docs', 'inbox', 'n1.md'), 'one\ntwo\nthree\n')
  writeFileSync(join(base, 'a.txt'), 'edited by hand\n')
  const r = await mergeBranch(wt2, 'true')
  expect(r.merged).toBe(false)
  expect(r.reason).toMatch(/uncommitted changes \(.*a\.txt/)
  expect(git(base, 'log', '-1', '--format=%s')).not.toMatch(/org notes/)   // nothing was committed on the way to refusing
  expect(readFileSync(join(base, 'a.txt'), 'utf8')).toBe('edited by hand\n')
})

it('a lookalike path (HOLON-LOG.md.bak, docs/inbox-old/) is not an org note', async () => {
  commit(base, 'HOLON-LOG.md.bak', 'x\n')
  mkdirSync(join(base, 'docs', 'inbox-old'), { recursive: true })
  commit(base, 'docs/inbox-old/n.md', 'x\n')
  for (const f of ['HOLON-LOG.md.bak', 'docs/inbox-old/n.md']) {
    const wt = addWorktree(base, join(root, `wt-${f.replace(/\W/g, '')}`), `holon/${f.replace(/\W/g, '')}`)
    commit(wt.path, f, 'branch\n')
    writeFileSync(join(base, f), 'changed\n')
    const r = await mergeBranch(wt, 'true')
    expect(r.merged, f).toBe(false)
    expect(r.reason).toContain('uncommitted changes')
    git(base, 'checkout', '--', f)
  }
})

it('says why a silent test run failed: the signal that killed it, the exit code, or the timeout', async () => {
  const wt = addWorktree(base, join(root, 'wt-silent'), 'holon/silent')
  commit(wt.path, 'silent.txt', 'x\n')
  const killed = await mergeBranch(wt, 'echo "RUN v2"; kill -KILL $$')
  expect(killed.merged).toBe(false)
  expect(killed.reason).toMatch(/tests failed: .*killed by SIGKILL/)
  const quiet = await mergeBranch(wt, 'exit 3')
  expect(quiet.reason).toMatch(/exited with code 3\) with no output/)
  const slow = await mergeBranch(wt, 'sleep 30', undefined, 300)
  expect(slow.reason).toMatch(/killed by SIGTERM after the 0s timeout|timeout/)
  const loud = await mergeBranch(wt, 'echo boom >&2; exit 1')
  expect(loud.reason).toMatch(/exited with code 1\)$/)
  expect(loud.output).toContain('boom')
})

it('a base file the branch changes is refused before any test runs', async () => {
  commit(base, 'early.txt', 'one\n')
  const wt = addWorktree(base, join(root, 'wt-early'), 'holon/early')
  commit(wt.path, 'early.txt', 'two\n')
  writeFileSync(join(base, 'early.txt'), 'edited in the base\n')
  const ran = join(root, 'ran-early')
  const r = await mergeBranch(wt, `echo x >> ${ran}`)
  expect(r.merged).toBe(false)
  expect(r.reason).toMatch(/uncommitted changes \(early\.txt\)/)
  expect(existsSync(ran)).toBe(false)
  git(base, 'checkout', '--', 'early.txt')
})

it('does not rerun the tests for a tree that already passed, only for a changed one', async () => {
  commit(base, 'again.txt', 'one\n')
  const wt = addWorktree(base, join(root, 'wt-again'), 'holon/again')
  commit(wt.path, 'again.txt', 'two\n')
  const runs = join(root, 'runs-again')
  const cmd = `echo x >> ${runs}`
  const count = () => Number(execFileSync('wc', ['-l', runs], { encoding: 'utf8' }).trim().split(/\s+/)[0])
  // Refused after the tests passed: the base file is edited while they run.
  const first = await mergeBranch(wt, `${cmd}; echo late >> ${join(base, 'again.txt')}`)
  expect(first.merged).toBe(false)
  expect(count()).toBe(1)
  git(base, 'checkout', '--', 'again.txt')
  // Same tree, same commands, base unchanged: it merges without running them again.
  const second = await mergeBranch(wt, `${cmd}; echo late >> ${join(base, 'again.txt')}`)
  expect(second.merged).toBe(true)
  expect(second.testsSkipped).toBe(true)
  expect(count()).toBe(1)
  expect(readFileSync(join(base, 'again.txt'), 'utf8')).toBe('two\n')
})

it('a moved base is a different tree: the tests run again, and a failure is never remembered', async () => {
  const wt = addWorktree(base, join(root, 'wt-moved'), 'holon/moved')
  commit(wt.path, 'moved-a.txt', 'a\n')
  const runs = join(root, 'runs-moved')
  const cmd = `echo x >> ${runs}; test -f ${join(root, 'pass-moved')}`
  const count = () => Number(execFileSync('wc', ['-l', runs], { encoding: 'utf8' }).trim().split(/\s+/)[0])
  expect((await mergeBranch(wt, cmd)).merged).toBe(false)   // fails: not remembered
  writeFileSync(join(root, 'pass-moved'), '')
  commit(base, 'moved-b.txt', 'base moved\n')
  const r = await mergeBranch(wt, cmd)
  expect(r.merged).toBe(true)
  expect(r.testsSkipped).toBeUndefined()
  expect(count()).toBe(2)
  expect(r.ms?.total).toBeGreaterThanOrEqual(0)
})
