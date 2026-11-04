import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanAdded } from '../src/secretscan.ts'
import { addWorktree, mergeBranch } from '../src/worktree.ts'

// The key is built here, never written out: a real-looking key in a test file is exactly
// what this scan is meant to catch.
const FAKE_KEY = 'sk-' + 'a'.repeat(40)

// A slug that only looks like a key: 'sk-' inside 'disk-' is not a word start.
const LOOKALIKE = 'disk-nearly-full-on-the-org-machine-2026-10-21'

// The unified diff of a file that only adds lines.
const diffOf = (path: string, lines: string[]) => [
  `diff --git a/${path} b/${path}`,
  'index 1111111..2222222 100644',
  `--- a/${path}`,
  `+++ b/${path}`,
  `@@ -0,0 +1,${lines.length} @@`,
  ...lines.map(l => `+${l}`),
  '',
].join('\n')

describe('scanAdded()', () => {
  it('flags an added key by file and line, and never repeats the key', () => {
    const res = scanAdded(diffOf('src/config.ts', [`const key = "${FAKE_KEY}"`, 'export const other = 1']))
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0].file).toBe('src/config.ts')
    expect(res.warnings[0].line).toBe(1)
    expect(res.warnings[0].rule).toBeTruthy()
    expect(JSON.stringify(res)).not.toContain(FAKE_KEY)
  })

  it('lists a line with the allow marker instead of warning about it', () => {
    const res = scanAdded(diffOf('src/config.ts', [`const key = "${FAKE_KEY}" // secret-scan:allow`]))
    expect(res.warnings).toHaveLength(0)
    expect(res.allowed).toEqual([{ file: 'src/config.ts', line: 1 }])
    expect(JSON.stringify(res)).not.toContain(FAKE_KEY)
  })

  it('does not flag a slug that only looks like a key', () => {
    const res = scanAdded(diffOf('docs/notes.md', [`const slug = "${LOOKALIKE}"`]))
    expect(res.warnings).toHaveLength(0)
    expect(res.allowed).toHaveLength(0)
  })

  it('flags a PEM header even without its end line', () => {
    const res = scanAdded(diffOf('keys/id.pem', ['-----BEGIN RSA PRIVATE KEY-----']))
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0].rule).toBe('pem')
    expect(res.warnings[0].file).toBe('keys/id.pem')
  })

  it('counts the new-side line across the hunks of one file', () => {
    const two = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -3 +3 @@',
      '-old line',
      `+const key = "${FAKE_KEY}"`,
      '@@ -26 +26 @@',
      '-another old line',
      `+const other = "${FAKE_KEY}"`,
      '',
    ].join('\n')
    const res = scanAdded(two)
    expect(res.warnings.map(w => w.line)).toEqual([3, 26])
    expect(res.warnings.every(w => w.file === 'src/app.ts')).toBe(true)
  })

  it('skips a binary file', () => {
    const binary = ['diff --git a/logo.png b/logo.png', 'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ', ''].join('\n')
    expect(scanAdded(binary).warnings).toHaveLength(0)
  })

  it('finds a key buried in a very long line', () => {
    const res = scanAdded(diffOf('src/blob.ts', [`${'x'.repeat(9000)} ${FAKE_KEY}`]))
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0].file).toBe('src/blob.ts')
  })

  it('scans a 200 KB diff in well under 200 ms', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i} // a plain line of code with nothing secret in it`)
    const text = diffOf('src/big.ts', lines)
    expect(text.length).toBeGreaterThan(200_000)
    const t0 = performance.now()
    const res = scanAdded(text)
    const ms = performance.now() - t0
    expect(res.warnings).toHaveLength(0)
    expect(ms).toBeLessThan(200)
  })
})

describe('the secret scan in the merge flow', () => {
  // A plain repo and a builder in its own worktree, the way a builder branch arrives.
  const builderRepo = (branch: string) => {
    const root = mkdtempSync(join(tmpdir(), 'sec-'))
    const base = join(root, 'repo')
    mkdirSync(base, { recursive: true })
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
    git(root, 'init', '-q', '-b', 'main', base)
    git(base, 'config', 'user.email', 't@t'); git(base, 'config', 'user.name', 't')
    writeFileSync(join(base, 'README.md'), 'hi\n')
    git(base, 'add', '.'); git(base, 'commit', '-qm', 'init')
    const wt = addWorktree(base, join(root, 'wt'), branch)
    return { git, wt }
  }

  it('refuses to merge an added key, naming file:line and never repeating the key', async () => {
    const { git, wt } = builderRepo('holon/b-secret')
    writeFileSync(join(wt.path, 'config.ts'), `const key = "${FAKE_KEY}"\n`)
    git(wt.path, 'add', '.'); git(wt.path, 'commit', '-qm', 'add a key')

    const r = await mergeBranch(wt, 'true')
    expect(r.merged).toBe(false)
    expect(r.reason).toContain('secret scan: 1 warning(s) at config.ts:1')
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY)
  })

  it('says the scan was clean when the branch adds nothing secret-shaped', async () => {
    const { git, wt } = builderRepo('holon/b-clean')
    writeFileSync(join(wt.path, 'app.ts'), `const slug = "${LOOKALIKE}"\n`)
    git(wt.path, 'add', '.'); git(wt.path, 'commit', '-qm', 'add a slug')

    const r = await mergeBranch(wt, 'true')
    expect(r.merged).toBe(true)
    expect(r.output).toContain('secret scan: clean')
  })
})
