import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { Terminal } from '../src/terminal.ts'
import { mergeSettings, DEFAULT_SETTINGS } from '../src/org.ts'

const DAY = 24 * 60 * 60_000
const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

// The tests run the clock days ahead, so commits are dated inside the window they ask about.
let n = 0
const landAt = (ms: number) => {
  const d = new Date(ms).toISOString()
  writeFileSync(join(repo, `f${++n}.ts`), String(n)); sh(repo, 'add', '.')
  execFileSync('git', ['-C', repo, 'commit', '-qm', `feat: change ${n}`], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } })
}

let home: string, repo: string, h: Holon, typed: { id: string; text: string }[]
beforeEach(() => {
  process.env.HOLON_FAKE_CLIS = '1'
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  repo = join(home, 'repo'); mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'feat: ship the widget')
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
  typed = []
  vi.spyOn(Terminal.prototype, 'type').mockImplementation(async function (this: Terminal, text: string) { typed.push({ id: (this as any).__id ?? '', text }) })
})
afterEach(() => { vi.restoreAllMocks(); h.shutdown() })

const director = (cli: 'claude' | 'codex' | 'opencode' = 'claude') => {
  const d = h.create({ label: 'Director', cli, cwd: repo, lead: true })
  ;(h as any).directive = { text: 'grow revenue', workspace: repo, directorId: d.id, goals: ['reach $1k MRR', 'cut signup steps'], deliverables: [], status: 'running', startedAt: '', shape: 'hierarchy', template: 'lean' }
  return d
}
const reviewers = () => h.list().filter(n => n.label === 'Needle Review')
const needleActions = () => h.recentActions().filter(a => a.action === 'needle_review')

describe('daily needle review', () => {
  it('first review is due 15 minutes after the daemon starts, then once a day', async () => {
    director()
    const t0 = Date.now(), MIN = 60_000
    landAt(t0 + 15 * MIN); landAt(t0 + DAY); landAt(t0 + 2 * DAY)
    expect(await h.needleReview(t0 + 10 * MIN)).toBeNull()          // a restarted daemon is not due yet
    expect(await h.needleReview(t0 + 16 * MIN)).toBeTruthy()        // no lastNeedleAt: 15 minutes is enough, not 24h
    expect(reviewers()).toHaveLength(1)
    expect(await h.needleReview(t0 + 20 * MIN)).toBeNull()          // one at a time
    ;(h as any).closeNeedle('done', 'x')
    expect(await h.needleReview(t0 + 3_600_000)).toBeNull()         // same day
    expect(await h.needleReview(t0 + DAY + 15 * MIN)).toBeNull()    // 24h after the last start has not passed (16 min in)
    expect(await h.needleReview(t0 + DAY + 17 * MIN)).toBeTruthy()  // next day
  })

  it('a reviewer restored after a daemon restart is closed, and the review runs again', async () => {
    const d = director()
    const t0 = Date.now()
    landAt(t0 + 15 * 60_000)
    const first = (await h.needleReview(t0 + 16 * 60_000))!
    expect(first).toBeTruthy()
    // The daemon restarts: the new process has the reviewer as a node but no memory of the review.
    ;(h as any).needle = null
    ;(h as any).needleBase = t0 + 100 * 60_000
    expect(await h.needleReview(t0 + 101 * 60_000)).toBeNull()      // closes the orphan, and is not due for 15 minutes
    expect(reviewers()).toHaveLength(0)
    expect(needleActions().some(a => String(a.args.failed).includes('orphaned'))).toBe(true)
    const again = await h.needleReview(t0 + 120 * 60_000)           // the day's review was not lost
    expect(again).toBeTruthy()
    expect(reviewers()).toHaveLength(1)
    expect(h.list().find(n => n.id === again)!.parentId).toBe(d.id)
  })

  it('can be turned off, and a time of day is honoured', async () => {
    director()
    h.setSettings({ needleReview: false })
    expect(await h.needleReview(Date.now() + 3 * DAY)).toBeNull()
    expect(DEFAULT_SETTINGS.needleReview).toBe(true)
    expect(mergeSettings(DEFAULT_SETTINGS, { needleReviewAt: 'nope' as any }).needleReviewAt).toBeNull()
    h.setSettings({ needleReview: true, needleReviewAt: '06:30' })
    const day = new Date(Date.now() + 2 * DAY); day.setHours(6, 0, 0, 0)
    landAt(day.getTime() - 3600_000)
    expect(await h.needleReview(day.getTime())).toBeNull()          // before 06:30
    day.setHours(6, 31, 0, 0)
    expect(await h.needleReview(day.getTime())).toBeTruthy()        // after it, not yet run today
    ;(h as any).closeNeedle('done', 'x')
    day.setHours(9, 0, 0, 0)
    expect(await h.needleReview(day.getTime())).toBeNull()          // already ran today
  })

  it('picks the other model family: claude -> codex, codex -> claude, opencode as fallback, never the same', async () => {
    const d = director('claude')
    landAt(Date.now() + DAY); landAt(Date.now() + 2 * DAY)
    expect(h.needleCli('claude')).toBe('codex')
    expect(h.needleCli('codex')).toBe('claude')
    expect(h.needleCli('opencode')).toBe('claude')
    ;(h as any).quotaOutUntil.codex = Date.now() + 10 * DAY      // out of quota
    expect(h.needleCli('claude')).toBe('opencode')
    ;(h as any).quotaOutUntil.opencode = Date.now() + 10 * DAY
    expect(h.needleCli('claude')).toBeNull()                       // never claude for a claude Director
    expect(await h.needleReview(Date.now() + DAY + 1000)).toBeNull()
    expect(needleActions().at(-1)!.args.skipped).toMatch(/no other model family/)
    ;(h as any).quotaOutUntil = {}
    const id = await h.needleReview(Date.now() + 2 * DAY + 5000)
    expect(h.list().find(n => n.id === id)!.cli).toBe('codex')
    expect(d.cli).toBe('claude')
  })

  it('falls back to opencode when the other family is not installed', async () => {
    delete process.env.HOLON_FAKE_CLIS
    try {
      const real = await import('../src/adapters.ts')
      const missing = (c: string) => c === 'claude' || c === 'opencode' ? true : false
      vi.spyOn(h as any, 'installed').mockImplementation(((c: string) => missing(c)) as any)
      expect(h.needleCli('claude')).toBe('opencode')
      expect(real.CLIS).toContain('opencode')
    } finally { process.env.HOLON_FAKE_CLIS = '1' }
  })

  it('briefs the reviewer with the goals, the last 24h of commits, and the read-only report format', async () => {
    const d = director('claude')
    landAt(Date.now() + DAY)
    const id = (await h.needleReview(Date.now() + DAY + 1000))!
    const node = h.list().find(n => n.id === id)!
    expect(node.readOnly).toBe(true)
    expect(node.parentId).toBe(d.id)
    expect(node.worktree).toBeUndefined()
    const brief = typed.map(t => t.text).join('\n')
    expect(brief).toContain('reach $1k MRR')
    expect(brief).toContain('cut signup steps')
    // The log is a file, not typed: the brief names it and the commit count per repo, and stays short.
    expect(brief.length).toBeLessThan(3000)
    expect(brief).toMatch(/: 1 commit\n/)
    const file = brief.match(/is in (\S+\.log);/)![1]
    expect(file.startsWith(join(home, 'needle'))).toBe(true)
    const log = readFileSync(file, 'utf8')
    expect(log).toMatch(/feat: change \d/)
    expect(log).toMatch(/f\d+\.ts \| 1 \+/)                              // stats
    expect(brief).not.toMatch(/feat: change/)
    expect(brief).toMatch(/do not edit files, commit, push/)
    expect(brief).toMatch(/four parts/)
    expect(brief).toMatch(/4\) any real bugs you found, each as file:line with what breaks \(read the diff before you claim one\)/)
    expect(brief).toMatch(/Start from the numbers/)
    expect(brief).toMatch(/bottleneck/)
    expect(brief).toMatch(/moved nothing/)
    expect(brief).toMatch(/1-3 changes most likely to move a number this week/)
    expect(brief).toMatch(/the org or the owner/)
    expect(brief).toContain(`to "${d.id}"`)
  })

  it('puts each goal metric, value, changedAt, flat duration and recent history in the brief', async () => {
    director('claude')
    const now = Date.now() + DAY + 1000
    const iso = (ms: number) => new Date(ms).toISOString()
    const dir = (h as any).directive
    dir.goalMetrics = [
      { name: 'pilot replies', cmd: 'echo 0', value: 0, changedAt: iso(now - 3 * DAY - 3600_000) },
      { name: 'paid users', cmd: 'echo 4', value: 4, changedAt: iso(now - 5 * 3600_000) },
    ]
    writeFileSync(join(home, 'goal-history.jsonl'), [
      { at: iso(now - 9 * DAY), name: 'pilot replies', value: 2 },
      { at: iso(now - 3 * DAY - 3600_000), name: 'pilot replies', value: 0 },
      { at: iso(now - 5 * 3600_000), name: 'paid users', value: 4 },
    ].map(r => JSON.stringify(r)).join('\n') + '\n')
    landAt(now - 1000)
    await h.needleReview(now)
    const brief = typed.map(t => t.text).join('\n')
    expect(brief).toContain('metric: pilot replies = 0')
    expect(brief).toContain(`changedAt ${iso(now - 3 * DAY - 3600_000)}; flat for 3d`)
    expect(brief).toContain('metric: paid users = 4')
    expect(brief).toContain('flat for 5h')
    expect(brief).toContain(`${iso(now - 9 * DAY)} 2; ${iso(now - 3 * DAY - 3600_000)} 0`)
    expect(brief.length).toBeLessThan(3000)
  })

  it('leaves out commits older than 24h and skips the review when nothing landed', async () => {
    director()
    expect(await h.needleReview(Date.now() + 30 * DAY)).toBeNull()  // everything is older than 24h at that time
    expect(needleActions().at(-1)!.args.skipped).toMatch(/no commits/)
    expect(reviewers()).toHaveLength(0)
  })

  it('closes the reviewer after it messages the Director, and logs needle_review with the result', async () => {
    const d = director('claude')
    landAt(Date.now() + DAY)
    const id = (await h.needleReview(Date.now() + DAY + 1000))!
    expect(reviewers()).toHaveLength(1)
    await h.message(id, d.id, 'Moved: MRR goal. Polish: renames. Bug: a.ts:1. Tomorrow: 1) fix signup.')
    expect(reviewers()).toHaveLength(0)
    const done = needleActions().at(-1)!
    expect(done.args.result).toContain('Bug: a.ts:1')
    expect(typed.some(t => t.text.includes('[message from Needle Review'))).toBe(true)
    expect(h.recentActions().some(a => a.action === 'needle_review' && a.args.started)).toBe(true)
  })

  it('closes a reviewer that never reports once its time is up', async () => {
    director()
    const t = Date.now() + DAY + 1000
    landAt(t - 1000)
    await h.needleReview(t)
    await h.needleReview(t + 60_000)
    expect(reviewers()).toHaveLength(1)
    await h.needleReview(t + h.needleTimeoutMs + 1000)
    expect(reviewers()).toHaveLength(0)
    expect(needleActions().at(-1)!.args.failed).toBeTruthy()
  })

  it('a large day of commits stays out of the typed brief', async () => {
    director()
    landAt(Date.now() + DAY - 5000)
    for (let i = 0; i < 300; i++) { writeFileSync(join(repo, `big${i}.ts`), 'x'); sh(repo, 'add', '.') ; if (i % 20 === 19) landAt(Date.now() + DAY - 4000) }
    landAt(Date.now() + DAY - 3000)
    await h.needleReview(Date.now() + DAY + 1000)
    const brief = typed.map(t => t.text).join('\n')
    expect(brief.length).toBeLessThan(3000)
    expect(readFileSync(brief.match(/is in (\S+\.log);/)![1], 'utf8').length).toBeGreaterThan(brief.length)
  })
})
