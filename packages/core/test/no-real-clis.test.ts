import { describe, expect, it } from 'vitest'
import { Terminal } from '../src/terminal.ts'
import { AGENT_COMMANDS, CLIS, CLI_TABLE } from '../src/adapters.ts'

// HOLON_FAKE_CLIS=1 comes from vitest.config.ts: no test may launch a real agent CLI.
describe('tests cannot start real agent CLIs', () => {
  it('refuses claude', () => {
    expect(() => new Terminal({ command: 'claude', cwd: process.cwd() })).toThrow(/refusing/)
  })

  it('refuses opencode', () => {
    expect(() => new Terminal({ command: 'opencode', cwd: process.cwd() })).toThrow(/refusing/)
  })

  it('refuses a codex by absolute path too', () => {
    expect(() => new Terminal({ command: '/usr/local/bin/codex', cwd: process.cwd() })).toThrow(/refusing/)
  })

  // A new adapter entry is covered automatically: its launch command must be refused too.
  it('refuses the launch command of every registered CLI except the shell, and jev', () => {
    for (const cli of CLIS.filter(c => c !== 'shell')) {
      const command = CLI_TABLE[cli].command
      expect(AGENT_COMMANDS.has(command), cli).toBe(true)
      expect(() => new Terminal({ command, cwd: process.cwd() }), cli).toThrow(/refusing/)
    }
    expect(() => new Terminal({ command: 'jev', cwd: process.cwd() })).toThrow(/refusing/)
  })

  it('still starts an ordinary shell', async () => {
    const t = new Terminal({ command: '/bin/sh', cwd: process.cwd() })
    await t.type('echo alive')
    await t.waitQuiet(300)
    expect(t.readScreen().text).toMatch(/^alive$/m)
    t.kill()
  })
})
