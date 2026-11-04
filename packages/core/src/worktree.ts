import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { scanAdded } from './secretscan.ts'

// Each code-changing builder gets its own git worktree and branch, so builders never edit
// the same checkout. Work comes back through mergeBranch, one at a time.
export interface Worktree {
  path: string
  branch: string
  base: string        // the checkout it branched from
  baseBranch: string  // the branch it merges back into
}

export interface MergeResult {
  merged: boolean
  reason?: string
  conflicts?: string[]
  commit?: string
  output?: string
  checkFailed?: boolean  // the builder's acceptance check failed on the rebased tree
  testsSkipped?: boolean // this exact tree already passed the same check and tests, so they were not run again
  ms?: { rebase?: number; test?: number; total?: number }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function addWorktree(base: string, path: string, branch: string): Worktree {
  const baseBranch = git(base, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (!existsSync(path)) git(base, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD')
  // Untracked config the app needs to run, and installed dependencies, come along.
  for (const f of readdirSync(base).filter(f => /^\.env/.test(f))) {
    if (!existsSync(join(path, f))) copyFileSync(join(base, f), join(path, f))
  }
  if (existsSync(join(base, 'node_modules')) && !existsSync(join(path, 'node_modules'))) {
    symlinkSync(join(base, 'node_modules'), join(path, 'node_modules'))
  }
  return { path, branch, base, baseBranch }
}

// Why a command failed, in words: the exit code, the signal that killed it, or the timeout.
// A suite killed from outside prints nothing, and the banner alone tells the lead nothing.
function whyFailed(err: unknown, timeoutMs: number): string {
  const x = err as { code?: number | string; signal?: string | null; killed?: boolean }
  if (x.killed && x.signal) return `killed by ${x.signal} after the ${Math.round(timeoutMs / 1000)}s timeout (or by something else sending it)`
  if (x.signal) return `killed by ${x.signal}`
  if (typeof x.code === 'number') return `exited with code ${x.code}`
  return `could not run (${x.code ?? (err as Error)?.message ?? 'unknown error'})`
}

function run(cmd: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string; why?: string }> {
  return new Promise(resolve => execFile(process.env.SHELL || '/bin/zsh', ['-lc', cmd], { cwd, timeout: timeoutMs, maxBuffer: 20 << 20 },
    (err, stdout, stderr) => resolve({ ok: !err, output: (stdout + stderr).slice(-3000), ...(err ? { why: whyFailed(err, timeoutMs) } : {}) })))
}

// A builder's acceptance check: a shell command that proves its work is done.
// Async on purpose: a slow check (a test suite, say) must not freeze the daemon
// and every terminal in the org with it.
function runCheck(check: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', check], { cwd, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 10 << 20 },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '')
        const errOut = String(stderr ?? '')
        if (!err) return resolve(out)
        const e = err as Error & { stdout?: string; stderr?: string }
        e.stdout ??= out
        e.stderr ??= errOut
        reject(e)
      })
  })
}

// What the branch adds, scanned for credentials: the file and the line of anything that looks
// like a secret, never the secret itself. A warning refuses the merge; a line carrying the
// secret-scan:allow marker does not. A scan that cannot run also refuses: a security gate that
// lets the merge through when it is blind is not a gate.
const secretScan = (wt: Worktree): { text: string; blocked: { file: string; line: number }[]; failed: boolean } => {
  try {
    const diff = execFileSync('git', ['-C', wt.path, 'diff', '-U0', `${wt.baseBranch}...HEAD`],
      { encoding: 'utf8', maxBuffer: 20 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
    const { warnings, allowed } = scanAdded(diff)
    if (!warnings.length && !allowed.length) return { text: 'secret scan: clean', blocked: [], failed: false }
    const at = (xs: { file: string; line: number }[]) => xs.map(x => `${x.file}:${x.line}`).join(', ')
    return {
      text: `secret scan: ${warnings.length} warnings${warnings.length ? ` (${at(warnings)})` : ''}, ` +
        `${allowed.length} allowed${allowed.length ? ` (${at(allowed)})` : ''}`,
      blocked: warnings,
      failed: false,
    }
  } catch {
    // The git error is not repeated: it can quote the diff it failed on.
    return { text: 'secret scan: could not run', blocked: [], failed: true }
  }
}

// Trees that passed their check and tests, keyed by content (the tree of the rebased HEAD), the
// checkout and the commands. A merge refused for a reason outside the tests (the base checkout
// had a dirty file, the fast-forward raced) and submitted again on an unchanged base is the same
// tree: the suite is not paid for twice. A moved base gives a different tree, so it is tested anew.
// A failure is never remembered, and nothing is fast-forwarded that was not tested as it stands.
const passed = new Set<string>()
const remember = (key: string) => { passed.add(key); if (passed.size > 500) passed.delete(passed.values().next().value!) }

// Uncommitted base files the branch also changes: those, and only those, stop a fast-forward.
const blockingBaseFiles = (wt: Worktree): string[] => {
  const dirty = git(wt.base, 'status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean).map(l => l.replace(/^\s*\S+\s+/, ''))
  const touched = new Set(git(wt.path, 'diff', '--name-only', `${wt.baseBranch}...HEAD`).split('\n').filter(Boolean))
  return dirty.filter(f => !isNotes(f) && touched.has(f))
}
const baseBlockedReason = (wt: Worktree, files: string[]) =>
  `the base checkout ${wt.base} has uncommitted changes (${files.slice(0, 5).join(', ')}) in files this branch changes; commit them there, then merge_report again`

// Files leads append to in the base checkout itself, between merges.
const isNotes = (path: string) => path === 'HOLON-LOG.md' || path.startsWith('docs/inbox/')

// Rebase onto the base branch, run the acceptance check and the tests in the worktree, then
// fast-forward the base. Nothing reaches the base unless both pass on the rebased code.
export async function mergeBranch(wt: Worktree, testCmd?: string, check?: string, timeoutMs = 20 * 60_000, retried = false): Promise<MergeResult> {
  const t0 = Date.now()
  const r = await mergeBranchInner(wt, testCmd, check, timeoutMs, retried, { rebase: 0, test: 0 })
  return { ...r, ms: { ...r.ms, total: Date.now() - t0 } }
}

async function mergeBranchInner(wt: Worktree, testCmd: string | undefined, check: string | undefined, timeoutMs: number, retried: boolean, ms: { rebase: number; test: number }): Promise<MergeResult> {
  if (git(wt.path, 'status', '--porcelain', '--untracked-files=no')) return { merged: false, reason: 'uncommitted changes in the worktree; commit them first' }
  if (git(wt.path, 'rev-list', '--count', `${wt.baseBranch}..HEAD`) === '0') return { merged: false, reason: 'nothing to merge: the branch has no new commits' }
  // Known before any test minute is spent: a refusal here costs the queue nothing.
  const early = blockingBaseFiles(wt)
  if (early.length) return { merged: false, reason: baseBlockedReason(wt, early), ms }
  // Before the rebase and the tests: what the branch adds, scanned for credentials. A warning
  // refuses the merge outright; otherwise the scan line rides along in the output as before.
  const scan = secretScan(wt)
  if (scan.failed) return { merged: false, reason: 'secret scan could not run; merge refused until the branch can be scanned' }
  if (scan.blocked.length) {
    const at = scan.blocked.map(x => `${x.file}:${x.line}`).join(', ')
    return { merged: false, reason: `secret scan: ${scan.blocked.length} warning(s) at ${at}; add // secret-scan:allow to lines that are not secrets` }
  }
  const withScan = (out: string) => (out ? `${out}\n${scan.text}` : scan.text)
  const tr = Date.now()
  try {
    git(wt.path, 'rebase', '-q', wt.baseBranch)
  } catch {
    const conflicts = git(wt.path, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
    git(wt.path, 'rebase', '--abort')
    return { merged: false, reason: `conflicts with ${wt.baseBranch}; resolve them in the worktree (rebase onto ${wt.baseBranch}) and submit again`, conflicts, ms }
  }
  ms.rebase = Date.now() - tr
  let output = ''
  const key = `${git(wt.path, 'rev-parse', 'HEAD^{tree}')}\0${wt.base}\0${check ?? ''}\0${testCmd ?? ''}`
  const already = passed.has(key)
  if (check && !already) {
    try {
      await runCheck(check, wt.path)
    } catch (err) {
      const x = err as { stdout?: string; stderr?: string }
      output = `${x.stdout ?? ''}${x.stderr ?? ''}`
      return { merged: false, checkFailed: true, reason: `the acceptance check failed: ${check}\n${output.slice(-1500)}`, output: withScan(output.slice(-3000)) }
    }
  }
  if (testCmd && !already) {
    const tt = Date.now()
    const t = await run(testCmd, wt.path, timeoutMs)
    ms.test += Date.now() - tt
    output = t.output
    if (!t.ok) {
      const quiet = !output.trim()
      return { merged: false, reason: `tests failed: ${testCmd} (${t.why})${quiet ? ' with no output' : ''}`, output: withScan(output), ms }
    }
  }
  if (!already && (check || testCmd)) remember(key)
  // Uncommitted edits in the base only stop the fast-forward when the branch changes the same
  // file; a log or data file the org appends to (outreach CSVs, say) is left as it is.
  const blocking = blockingBaseFiles(wt)
  if (blocking.length) return { merged: false, reason: baseBlockedReason(wt, blocking), output: withScan(output), ms }
  const dirty = git(wt.base, 'status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean).map(l => l.replace(/^\s*\S+\s+/, ''))
  // An org's own notes (its log, its inbox) are committed for it rather than refused, and the
  // branch is rebased onto that commit; notes cannot change test results, so no second run.
  const notes = dirty.filter(isNotes)
  if (notes.length) {
    git(wt.base, 'commit', '-qm', `chore: commit org notes before merge (${notes.join(', ')})`, '--', ...notes)
    try {
      git(wt.path, 'rebase', '-q', wt.baseBranch)
    } catch {
      const conflicts = git(wt.path, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
      git(wt.path, 'rebase', '--abort')
      return { merged: false, reason: `conflicts with ${wt.baseBranch}; resolve them in the worktree (rebase onto ${wt.baseBranch}) and submit again`, conflicts, ms }
    }
  }
  try {
    git(wt.base, 'merge', '-q', '--ff-only', wt.branch)
  } catch (err) {
    // The base moved while the tests ran (a lead committed its log, another merge landed):
    // rebase onto it and test again, once, rather than bouncing the work back.
    const moved = git(wt.path, 'rev-list', '--count', `HEAD..${wt.baseBranch}`) !== '0'
    if (moved && !retried) return mergeBranchInner(wt, testCmd, check, timeoutMs, true, ms)
    return { merged: false, reason: `the base checkout refused the fast-forward: ${(err as Error).message.split('\n')[0]}`, output: withScan(output), ms }
  }
  return { merged: true, commit: git(wt.base, 'rev-parse', '--short', 'HEAD'), output: withScan(output).slice(-1500), ...(already && (check || testCmd) ? { testsSkipped: true } : {}), ms }
}

// What a branch changes against its base branch, and the commit an approval is pinned to.
export const changedFiles = (wt: Worktree) => git(wt.path, 'diff', '--name-only', `${wt.baseBranch}...HEAD`).split('\n').filter(Boolean)
export const headCommit = (wt: Worktree) => git(wt.path, 'rev-parse', 'HEAD')

// Commits on the branch that the base doesn't have yet (uncommitted files don't count).
export const unmergedCommits = (wt: Worktree): number => {
  try { return Number(git(wt.path, 'rev-list', '--count', `${wt.baseBranch}..HEAD`)) || 0 } catch { return 0 }
}

// True when the builder still holds work the base branch does not: commits the merge queue
// has not landed, or edits in the tree nobody committed. Retiring a builder like this would
// throw the work away, so the caller keeps the seat until the work is merged.
export const hasUnmergedWork = (wt: Worktree): boolean => {
  try {
    if (Number(git(wt.path, 'rev-list', '--count', `${wt.baseBranch}..HEAD`)) > 0) return true
    return git(wt.path, 'status', '--porcelain').length > 0
  } catch {
    return false
  }
}

// The diff's stable identity, unchanged by a rebase onto a newer base. Approvals keyed by
// this survive the merge queue's own rebase.
export const patchId = (wt: Worktree) => {
  const diff = execFileSync('git', ['-C', wt.path, 'diff', `${wt.baseBranch}...HEAD`], { encoding: 'utf8', maxBuffer: 20 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
  if (!diff.trim()) return ''
  const out = execFileSync('git', ['-C', wt.path, 'patch-id', '--stable'], { input: diff, encoding: 'utf8', maxBuffer: 20 << 20 })
  return out.trim().split(/\s+/)[0] ?? ''
}

// Removes the worktree only when nothing uncommitted would be lost. The branch stays.
export function removeWorktree(wt: Worktree): boolean {
  if (!existsSync(wt.path)) return true
  if (git(wt.path, 'status', '--porcelain', '--untracked-files=no')) return false
  git(wt.base, 'worktree', 'remove', '--force', wt.path)
  return true
}
