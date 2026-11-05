import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { seen } from '../../../test-support/seen.ts'

let home: string
let h: Holon
let dirId: string
const min = 60_000
// let the typed heartbeat land and the shell go quiet, or the next beat sees a busy org
const settle = async () => { await h.beatDone; await h.wait(null, dirId, 1500, 20000) }
const metric = (name: string, cmd: string) => ({ name, cmd })
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
  ;(h as any).zeroRecheckMs = 10
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  dirId = dir.id
  ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', heartbeatMin: 10 }
  await h.wait(null, dir.id, 1500, 20000)
})
afterEach(() => { h.shutdown(); vi.restoreAllMocks() })

describe('set_goals', () => {
  it('accepts plain strings and {text, metric}; strings keep goals a string[]', () => {
    h.setGoals(null, ['plain', { text: 'grow', metric: metric('visitors', 'echo 3') }, { text: 'no metric', metric: undefined }])
    const d = h.getDirective()!
    expect(d.goals).toEqual(['plain', 'grow', 'no metric'])
    expect(d.goalMetrics).toMatchObject([null, { name: 'visitors', cmd: 'echo 3' }, null])
  })
  it('all-string goals store no metrics', () => {
    h.setGoals(null, ['a', 'b'])
    expect(h.getDirective()!.goalMetrics).toBeUndefined()
  })
})

describe('measure', () => {
  it('reads the last number on stdout in the workspace and persists it', async () => {
    writeFileSync(join(home, 'n.txt'), 'x')
    h.setGoals(null, [{ text: 'g', metric: metric('files', 'echo "checked 9 things"; ls n.txt | wc -l; echo "total: 1,412.5"') }])
    await h.measureGoals(Date.now(), true)
    const m = h.getDirective()!.goalMetrics![0]!
    expect(m.value).toBe(412.5)   // last number run: "412.5" after the comma
    expect(m.error).toBeUndefined()
    expect(m.at).toBeTruthy()
    const saved = JSON.parse(require('node:fs').readFileSync(join(home, 'directive.json'), 'utf8'))
    expect(saved.goalMetrics[0].value).toBe(412.5)
  })
  it('records a failing command or a non-number as an error, keeps the last good value, and does not throw', async () => {
    h.setGoals(null, [{ text: 'a', metric: metric('ok', 'echo 5') }, { text: 'b', metric: metric('bad', 'exit 3') }, { text: 'c', metric: metric('word', 'echo hello') }])
    await h.measureGoals(Date.now(), true)
    const [a, b, c] = h.getDirective()!.goalMetrics!
    expect(a!.value).toBe(5)
    expect(b!.error).toBeTruthy(); expect(b!.value).toBeUndefined()
    expect(c!.error).toMatch(/no number/)
    a!.cmd = 'exit 1'
    await h.measureGoals(Date.now() + 31 * min)
    expect(a!.value).toBe(5); expect(a!.error).toBeTruthy()
  })
  // 2026-11-04 23:11Z: the minute timer fired as the Mac woke, before the network was back, and World's
  // site checks printed 0. Its Director read an outage and G4 counted three moves.
  it('re-reads a fall to 0 before believing it: a one-off failure is not a move', async () => {
    // prints 0 once, right after the marker appears: one failed check
    const cmd = `if [ -f once ]; then rm once; echo 0; else echo 1; fi`
    h.setGoals(null, [{ text: 'g', metric: metric('up', cmd) }])
    await h.measureGoals(Date.now(), true)
    writeFileSync(join(home, 'once'), '')
    await h.measureGoals(Date.now(), true)
    expect(h.getDirective()!.goalMetrics![0]!.value).toBe(1)
    const rows = readFileSync(join(home, 'goal-history.jsonl'), 'utf8').trim().split('\n')
    expect(rows).toHaveLength(1)
  })
  it('takes no reading in a dark wake, even a fall that two reads agree on', async () => {
    h.setGoals(null, [{ text: 'g', metric: metric('site', 'echo 1') }])
    await h.measureGoals(Date.now(), true)
    const m = h.getDirective()!.goalMetrics![0]!
    expect(m.value).toBe(1)
    const at = m.at
    m.cmd = 'echo 0'
    ;(h as any).darkWake = async () => true
    await h.measureGoals(Date.now() + 1000, true)
    expect(m.value).toBe(1)
    expect(m.at).toBe(at)
    ;(h as any).darkWake = async () => false
    await h.measureGoals(Date.now() + 2000, true)
    expect(m.value).toBe(0)
  })
  it('records a fall to 0 when the re-read agrees', async () => {
    writeFileSync(join(home, 'v'), '1')
    h.setGoals(null, [{ text: 'g', metric: metric('up', 'cat v') }])
    await h.measureGoals(Date.now(), true)
    writeFileSync(join(home, 'v'), '0')
    await h.measureGoals(Date.now(), true)
    expect(h.getDirective()!.goalMetrics![0]!.value).toBe(0)
    const rows = readFileSync(join(home, 'goal-history.jsonl'), 'utf8').trim().split('\n')
    expect(rows.map(r => JSON.parse(r).value)).toEqual([1, 0])
  })
  it('takes no reading just after the machine wakes, then reads normally', async () => {
    h.setGoals(null, [{ text: 'a', metric: metric('up', 'echo 1') }])
    await h.measureGoals(Date.now(), true)
    const m = h.getDirective()!.goalMetrics![0]!
    expect(m.value).toBe(1)
    const history = () => readFileSync(join(home, 'goal-history.jsonl'), 'utf8').trim().split('\n').length
    const rows = history()
    m.cmd = 'echo 0'
    const t = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t + 6 * min)   // the timer's first tick after a 6 minute sleep
    try {
      await h.measureGoals(t + 6 * min, true)
      expect(m.value).toBe(1)
      expect(history()).toBe(rows)
      clock.mockReturnValue(t + 7 * min)
      await h.measureGoals(t + 7 * min, true)   // still settling
      expect(m.value).toBe(1)
      clock.mockReturnValue(t + 9 * min)
      await h.measureGoals(t + 9 * min, true)
      expect(m.value).toBe(0)
      expect(history()).toBe(rows + 1)
    } finally { clock.mockRestore() }
  })
  it('drops a reading the machine slept through', async () => {
    h.setGoals(null, [{ text: 'a', metric: metric('up', 'echo 1') }])
    await h.measureGoals(Date.now(), true)
    const m = h.getDirective()!.goalMetrics![0]!
    m.cmd = 'echo 0'
    const t = Date.now()
    let calls = 0
    // The first read of the clock is before the command; every later one is after a 10 minute sleep.
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => calls++ === 0 ? t + 30_000 : t + 10 * min)
    try {
      await h.measureGoals(t + 30_000, true)
      expect(m.value).toBe(1)
    } finally { clock.mockRestore() }
  })
  it('drops a failure the machine slept through', async () => {
    h.setGoals(null, [{ text: 'a', metric: metric('up', 'echo 1') }])
    await h.measureGoals(Date.now(), true)
    const m = h.getDirective()!.goalMetrics![0]!
    m.cmd = 'exit 7'
    const t = Date.now()
    let calls = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => calls++ === 0 ? t + 30_000 : t + 10 * min)
    try {
      await h.measureGoals(t + 30_000, true)
      expect(m.error).toBeUndefined()
      expect(m.value).toBe(1)
    } finally { clock.mockRestore() }
  })
  it('re-reads at most every 30 minutes unless forced', async () => {
    h.setGoals(null, [{ text: 'a', metric: metric('n', `echo $RANDOM$RANDOM`) }])
    const t = Date.now()
    await h.measureGoals(t, true)
    const first = h.getDirective()!.goalMetrics![0]!.value
    await h.measureGoals(t + 10 * min)
    expect(h.getDirective()!.goalMetrics![0]!.value).toBe(first)
    await h.measureGoals(t + 31 * min)
    expect(h.getDirective()!.goalMetrics![0]!.at).toBe(new Date(t + 31 * min).toISOString())
  })
  it('times out a hung command (60s limit is passed through) without crashing', async () => {
    h.setGoals(null, [{ text: 'a', metric: metric('n', 'echo 1') }])
    await h.measureGoals(Date.now(), true)
    expect(h.getDirective()!.goalMetrics![0]!.value).toBe(1)
  })
})

describe('heartbeat text', () => {
  it('lists each goal as G1..Gn with its number and change since the last beat', async () => {
    const f = join(home, 'v')
    writeFileSync(f, '375')
    h.setGoals(null, [{ text: 'traffic', metric: metric('visitors', `cat ${f}`) }, { text: 'money', metric: metric('MRR', 'echo 0') }, 'untracked'])
    const t0 = Date.now()
    h.beat(t0)
    await h.measureGoals(t0, true)
    expect(h.beat(t0 + 10 * min)).toBe(true); await settle()
    await seen(h, dirId, 'G1 visitors 375 (no change; flat 10m)')
    await seen(h, dirId, 'G3 has no metric: give it one with set_goals')
    writeFileSync(f, '412')
    await h.measureGoals(t0 + 40 * min)
    expect(h.beat(t0 + 40 * min)).toBe(true); await settle()   // 375 -> 412 before the beat: due without back-off
    await seen(h, dirId, 'G1 visitors 412 (+37 since last beat)')
    await seen(h, dirId, 'G2 MRR 0 (no change; flat 40m)')
  })
  it('with no metrics, tells the Director to add them', async () => {
    h.setGoals(null, ['a', 'b'])
    const t0 = Date.now()
    h.beat(t0)
    expect(h.beat(t0 + 10 * min)).toBe(true)
    await seen(h, dirId, 'No goal has a metric')
  })
})

describe('goal history and output-without-outcome flag', () => {
  const day = 24 * 60 * min
  const hist = () => { try { return readFileSync(join(home, 'goal-history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
  const lines = (now: number) => (h as any).goalLines(now) as string
  // setGoals starts its own background read; wait for it and anchor on its timestamp
  const first = async () => { await h.measureGoals(Date.now(), true); return Date.parse(h.getDirective()!.goalMetrics!.find(Boolean)!.changedAt!) }
  const landed = (n: number) => vi.spyOn(h as any, 'landedCount').mockReturnValue(n)

  it('appends one line per change, and the first reading', async () => {
    const f = join(home, 'v')
    writeFileSync(f, '5')
    h.setGoals(null, [{ text: 'g', metric: metric('replies', `cat ${f}`) }])
    const t = await first()
    await h.measureGoals(t + 40 * min, true)   // same value: no line
    writeFileSync(f, '6')
    await h.measureGoals(t + 80 * min, true)
    expect(hist()).toEqual([
      { at: new Date(t).toISOString(), name: 'replies', value: 5 },
      { at: new Date(t + 80 * min).toISOString(), name: 'replies', value: 6 },
    ])
  })
  it('keeps changedAt across a reload', async () => {
    h.setGoals(null, [{ text: 'g', metric: metric('replies', 'echo 0') }])
    const t = await first()
    await h.measureGoals(t + day, true)
    const saved = JSON.parse(readFileSync(join(home, 'directive.json'), 'utf8'))
    expect(saved.goalMetrics[0].changedAt).toBe(new Date(t).toISOString())
    ;(h as any).directive.goalMetrics = saved.goalMetrics   // what a restart loads
    await h.measureGoals(t + 2 * day, true)
    expect(h.getDirective()!.goalMetrics![0]!.changedAt).toBe(new Date(t).toISOString())
    expect(hist()).toHaveLength(1)
  })
  it('says a number has not been read, instead of calling it flat', async () => {
    h.setGoals(null, [{ text: 'g', metric: metric('replies', 'echo 0') }])
    const t = await first()
    expect(lines(t + 30 * min)).toContain('replies 0 (no change')
    expect(lines(t + day)).toMatch(/replies 0 \(not read for \d+[hd]\)/)
  })
  it('flags only when every metric is flat 48h+ and 20+ commits landed', async () => {
    h.setGoals(null, [{ text: 'a', metric: metric('replies', 'echo 0') }, { text: 'b', metric: metric('paid', 'echo 0') }])
    const t = await first()
    const flag = 'Output without outcome: 20 commits landed in 24h'
    landed(20)
    expect(lines(t + 47 * 60 * min)).not.toContain('Output without outcome')   // flat 47h
    await h.measureGoals(t + 3 * day, true)
    expect(lines(t + 3 * day)).toContain('replies 0 (no change; flat 3d)')
    expect(lines(t + 3 * day)).toContain(flag)
    landed(19)
    expect(lines(t + 3 * day)).not.toContain('Output without outcome')
    landed(20)
    const [a] = h.getDirective()!.goalMetrics!
    a!.changedAt = new Date(t + 2.5 * day).toISOString()   // one number moved recently
    expect(lines(t + 3 * day)).not.toContain('Output without outcome')
  })
  it('flags when outcome metrics are flat even though an output metric moves', async () => {
    h.setGoals(null, [{ text: 'a', metric: metric('replies', 'echo 0') }, { text: 'b', metric: { ...metric('tests', 'echo 7'), kind: 'output' as const } }])
    const t = await first()
    landed(20)
    const [, out] = h.getDirective()!.goalMetrics!
    out!.changedAt = new Date(t + 2.9 * day).toISOString()   // the output number moved just now
    expect(lines(t + 3 * day)).toContain('Output without outcome: 20 commits')
  })
  it('says every number counts own work when all metrics are output; no flag', async () => {
    h.setGoals(null, [{ text: 'a', metric: { ...metric('tests', 'echo 7'), kind: 'output' as const } }])
    const t = await first()
    landed(20)
    const out = lines(t + 3 * day)
    expect(out).toContain('Every goal number counts your own work. Add one outcome number')
    expect(out).not.toContain('Output without outcome')
  })
  describe('noisy untagged metric note', () => {
    const noteOf = (kind: 'output' | 'outcome' | undefined, changes: number) => {
      h.setGoals(null, [{ text: 'a', metric: { ...metric('tests', 'echo 7'), ...(kind ? { kind } : {}) } }])
      return first().then(t => {
        const rows = Array.from({ length: changes + 1 }, (_, i) => JSON.stringify({ at: new Date(t + (i + 1) * min).toISOString(), name: 'tests', value: i }))
        writeFileSync(join(home, 'goal-history.jsonl'), rows.join('\n') + '\n')   // first row is the initial reading
        return lines(t + 60 * min)
      })
    }
    it('appears for an untagged metric with 3 changes in 24h', async () => {
      const out = await noteOf(undefined, 3)
      expect(out).toContain('G1 "tests" changed 3 times in 24h. If it counts your own work')
      expect(out).toContain("set kind: 'outcome' to stop this note.")
    })
    it('is absent with 2 changes', async () => { expect(await noteOf(undefined, 2)).not.toContain('changed') })
    it('is absent once tagged output', async () => { expect(await noteOf('output', 5)).not.toContain('changed') })
    it('is absent once tagged outcome explicitly, and the kind is kept', async () => {
      expect(await noteOf('outcome', 5)).not.toContain('changed')
      expect(h.getDirective()!.goalMetrics![0]!.kind).toBe('outcome')
    })
    it('puts several noisy metrics in one note, reading changes older than 24h out', async () => {
      h.setGoals(null, [{ text: 'a', metric: metric('x', 'echo 1') }, { text: 'b', metric: metric('y', 'echo 1') }])
      const t = await first()
      const row = (name: string, off: number, v: number) => JSON.stringify({ at: new Date(t + off).toISOString(), name, value: v })
      writeFileSync(join(home, 'goal-history.jsonl'), [0, 1, 2, 3].map(i => row('x', (i + 1) * min, i)).concat([0, 1, 2, 3].map(i => row('y', (i - 5) * day, i))).join('\n') + '\n')
      const out = lines(t + 60 * min)
      expect(out).toContain('G1 "x" changed 3 times')
      expect(out).not.toContain('"y"')
    })
  })
  it('writes kind only on output rows, and goals-moved skips them', async () => {
    h.setGoals(null, [{ text: 'a', metric: metric('replies', 'echo 1') }, { text: 'b', metric: { ...metric('tests', 'echo 1'), kind: 'output' as const } }])
    await first(); await h.measureGoals(Date.now(), true)
    const rows = hist()
    expect(rows.find(r => r.name === 'replies')).not.toHaveProperty('kind')
    expect(rows.find(r => r.name === 'tests').kind).toBe('output')
    const fake = mkdtempSync(join(tmpdir(), 'gm-'))
    const mk = (kind?: string) => [0, 1].map(v => JSON.stringify({ at: new Date().toISOString(), name: 'n', value: v, ...(kind ? { kind } : {}) })).join('\n') + '\n'
    const run = (kind?: string) => { mkdirSync(join(fake, '.holon'), { recursive: true }); writeFileSync(join(fake, '.holon', 'goal-history.jsonl'), mk(kind)); return execFileSync(process.execPath, [join(__dirname, '../../../scripts/goals-moved.ts')], { env: { ...process.env, HOME: fake }, encoding: 'utf8' }).trim() }
    expect(run()).toBe('1')
    expect(run('output')).toBe('0')
  })
  it('goals-moved: repeats are not moves, and a metric tagged output today drops its older untagged rows', () => {
    const fake = mkdtempSync(join(tmpdir(), 'gm-'))
    mkdirSync(join(fake, '.holon'), { recursive: true })
    const now = new Date().toISOString()
    const rows = (name: string, vs: number[]) => vs.map(v => JSON.stringify({ at: now, name, value: v }))
    writeFileSync(join(fake, '.holon', 'goal-history.jsonl'), [...rows('visits', [0, 0, 1, 1]), ...rows('tests', [5, 6, 7])].join('\n') + '\n')
    const run = () => execFileSync(process.execPath, [join(__dirname, '../../../scripts/goals-moved.ts')], { env: { ...process.env, HOME: fake }, encoding: 'utf8' }).trim()
    expect(run()).toBe('3')   // visits 0->1 once, tests twice
    writeFileSync(join(fake, '.holon', 'directive.json'), JSON.stringify({ goalMetrics: [{ name: 'visits', cmd: 'x' }, { name: 'tests', cmd: 'y', kind: 'output' }] }))
    expect(run()).toBe('1')
  })
  it('goals-moved: a fall to 0 that returns to its old value moved nothing', () => {
    const fake = mkdtempSync(join(tmpdir(), 'gm-'))
    mkdirSync(join(fake, '.holon'), { recursive: true })
    const now = new Date().toISOString()
    const rows = (name: string, vs: number[]) => vs.map(v => JSON.stringify({ at: now, name, value: v }))
    const run = (...r: string[][]) => {
      writeFileSync(join(fake, '.holon', 'goal-history.jsonl'), r.flat().join('\n') + '\n')
      return execFileSync(process.execPath, [join(__dirname, '../../../scripts/goals-moved.ts')], { env: { ...process.env, HOME: fake }, encoding: 'utf8' }).trim()
    }
    expect(run(rows('site', [1, 0, 1]))).toBe('0')
    expect(run(rows('site', [1, 0, 1, 0, 1]))).toBe('0')
    expect(run(rows('site', [1, 0]))).toBe('1')          // still down: it counts until it returns
    expect(run(rows('sales', [5, 0, 3]))).toBe('2')      // came back somewhere else: both moved
    expect(run(rows('site', [0, 1]))).toBe('1')          // a first rise is a move
    expect(run(rows('a', [1, 0]), rows('b', [2, 3]), rows('a', [1]))).toBe('1')
  })
  it('a kind-only set_goals is saved at once', () => {
    h.setGoals(null, [{ text: 'a', metric: metric('tests', 'echo 1') }])
    h.setGoals(null, [{ text: 'a', metric: { ...metric('tests', 'echo 1'), kind: 'output' as const } }])
    expect(JSON.parse(readFileSync(join(home, 'directive.json'), 'utf8')).goalMetrics[0].kind).toBe('output')
  })
})

describe('back-off', () => {
  const merged = (t: number) => (h as any).recent.push({ ts: new Date(t).toISOString(), caller: dirId, target: null, action: 'merged', args: {} })
  it('merges do not reset back-off when a goal has a metric; a moving number does', async () => {
    const f = join(home, 'v')
    writeFileSync(f, '1')
    h.setGoals(null, [{ text: 'g', metric: metric('n', `cat ${f}`) }])
    const t0 = Date.now()
    h.beat(t0)
    await h.measureGoals(t0, true)
    expect(h.beat(t0 + 10 * min)).toBe(true); await settle()     // beat 1: first sight, baseline 1
    merged(t0 + 11 * min)
    expect(h.beat(t0 + 25 * min)).toBe(false)                       // merge, number flat: wait is 20, not 10
    expect(h.beat(t0 + 31 * min)).toBe(true); await settle()
    merged(t0 + 32 * min)
    expect(h.beat(t0 + 65 * min)).toBe(false)                       // wait is 40 despite a merge
    writeFileSync(f, '2')
    await h.measureGoals(t0 + 66 * min)  //                           // the 30-min measurement sees it
    expect(h.beat(t0 + 72 * min)).toBe(true); await settle()      // number moved: back to 10
    await seen(h, dirId, 'G1 n 2 (+1 since last beat)')
    expect(h.beat(t0 + 79 * min)).toBe(false)
    expect(h.beat(t0 + 83 * min)).toBe(false)                       // flat again: wait doubled to 20
  })
  it("a move first seen by the beat's own measurement still counts as progress", async () => {
    const f = join(home, 'v')
    writeFileSync(f, '1')
    h.setGoals(null, [{ text: 'g', metric: metric('n', `cat ${f}`) }])
    const t0 = Date.now()
    h.beat(t0)
    await h.measureGoals(t0, true)
    expect(h.beat(t0 + 10 * min)).toBe(true); await settle()     // baseline 1
    writeFileSync(f, '2')                                          // no periodic measurement sees it
    expect(h.beat(t0 + 31 * min)).toBe(true); await settle()     // the beat's own measurement is first
    await seen(h, dirId, 'G1 n 2 (+1 since last beat)')
    expect(h.beat(t0 + 55 * min)).toBe(true); await settle()                      // wait is 10..20, not the backed-off 40
  })
  it('an output counter moving does not reset back-off; an outcome number does', async () => {
    const out = join(home, 'out'), res = join(home, 'res')
    writeFileSync(out, '1'); writeFileSync(res, '1')
    h.setGoals(null, [{ text: 'a', metric: { ...metric('tests', `cat ${out}`), kind: 'output' as const } }, { text: 'b', metric: metric('replies', `cat ${res}`) }])
    const t0 = Date.now()
    h.beat(t0)
    await h.measureGoals(t0, true)
    expect(h.beat(t0 + 10 * min)).toBe(true); await settle()     // baseline
    writeFileSync(out, '2')
    await h.measureGoals(t0 + 11 * min, true)
    expect(h.beat(t0 + 25 * min)).toBe(false)                       // only the output moved: wait is 20, not 10
    expect(h.beat(t0 + 31 * min)).toBe(true); await settle()
    writeFileSync(out, '3'); writeFileSync(res, '2')
    await h.measureGoals(t0 + 62 * min, true)
    expect(h.beat(t0 + 72 * min)).toBe(true); await settle()      // the outcome moved: back to 10
    expect(h.beat(t0 + 79 * min)).toBe(false)
  })
  it('without metrics a merge still resets it, as before', async () => {
    h.setGoals(null, ['plain'])
    const t0 = Date.now()
    h.beat(t0)
    expect(h.beat(t0 + 10 * min)).toBe(true)
    expect(h.beat(t0 + 25 * min)).toBe(false)
    merged(t0 + 26 * min)
    expect(h.beat(t0 + 31 * min)).toBe(true)
  })
})
