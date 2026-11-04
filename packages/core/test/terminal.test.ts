import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '../src/terminal.ts'

let t: Terminal | undefined
afterEach(() => t?.kill())

const bash = () => new Terminal({ command: 'bash', args: ['--noprofile', '--norc'], cwd: process.cwd(), env: { PS1: '$ ', BASH_SILENCE_DEPRECATION_WARNING: '1' } })

describe('Terminal', () => {
  it('types a command and reads its output from the screen', async () => {
    t = bash()
    await t.type('echo hello-holon')
    await t.waitQuiet(300)
    expect(t.readScreen().text).toMatch(/^hello-holon$/m)
  })

  it('waitQuiet resolves only after output stops', async () => {
    t = bash()
    const start = Date.now()
    await t.type('for i in 1 2 3; do echo tick; sleep 0.3; done')
    const r = await t.waitQuiet(500)
    expect(Date.now() - start).toBeGreaterThan(900)
    expect(r.state).toBe('quiet')
  })

  it('press C-c interrupts a running command', async () => {
    t = bash()
    await t.type('sleep 100')
    await new Promise(r => setTimeout(r, 300))
    const start = Date.now()
    t.press('C-c')
    await t.type('echo after-interrupt')
    await t.waitQuiet(300)
    expect(t.readScreen().text).toMatch(/^after-interrupt$/m)
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('marks the terminal exited when the process ends', async () => {
    t = bash()
    const exited = new Promise(r => t!.once('exit', r))
    await t.type('exit')
    await exited
    expect(t.state).toBe('exited')
    expect((await t.waitQuiet(200)).state).toBe('exited')
  })

  it('rejects unknown keys', () => {
    t = bash()
    expect(() => t!.press('Hyper')).toThrow(/unknown key/)
  })
})

describe('Terminal.type with bracketed paste', () => {
  it('wraps multi-line text in paste markers when the app enables bracketed paste', async () => {
    t = new Terminal({ command: 'bash', args: ['-c', "printf '\\033[?2004h'; stty -echo; cat -v"], cwd: process.cwd() })
    await t.waitQuiet(300)
    expect(t.screen.modes.bracketedPasteMode).toBe(true)
    await t.type('line one\nline two', false)
    t.write('\r')
    await t.waitQuiet(300)
    expect(t.readScreen().text).toContain('^[[200~line one')
    expect(t.readScreen().text).toContain('line two^[[201~')
  })

  it('types short single-line text plainly', async () => {
    t = new Terminal({ command: 'bash', args: ['-c', "printf '\\033[?2004h'; stty -echo; cat -v"], cwd: process.cwd() })
    await t.waitQuiet(300)
    await t.type('short')
    await t.waitQuiet(300)
    expect(t.readScreen().text).toMatch(/^short$/m)
  })
})

it('terminals give back every pty when they exit, so a long run never hits the system limit', async () => {
  const { execSync } = await import('node:child_process')
  const ptys = () => Number(execSync(`/usr/sbin/lsof -p ${process.pid} 2>/dev/null | grep -c ptmx || true`, { encoding: 'utf8' }).trim())
  const base = ptys()
  const ts = Array.from({ length: 10 }, () => new Terminal({ command: '/bin/sh', cwd: '/tmp' }))
  expect(ptys() - base).toBe(10)   // one each while running, not two
  await Promise.all(ts.map(t => new Promise(r => { t.on('exit', r); t.kill() })))
  await new Promise(r => setTimeout(r, 300))
  expect(ptys()).toBeLessThanOrEqual(base)   // an earlier test's terminal may still be closing at the baseline
})

it('gives a terminal a UTF-8 locale when the daemon has none (an app started from Finder)', async () => {
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE }
  delete process.env.LANG; delete process.env.LC_ALL; delete process.env.LC_CTYPE
  const t = new Terminal({ command: '/bin/sh', args: ['-c', 'echo locale=$LANG'], cwd: '/tmp' })
  try {
    await t.waitQuiet(300)
    expect(t.readScreen().text).toContain('locale=en_US.UTF-8')
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
    t.kill()
  }
})
