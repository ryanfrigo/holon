import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { diagnose, PROMPT_NUDGE_MS, type Seen } from '../src/watcher.ts'

const PROMPT = ['Bash command', '  curl -A "bot ryan@example.com" https://efts.sec.gov/x', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'].join('\n')
const seen = (over: Partial<Seen>): Seen => ({ label: 'b1', cli: 'claude', screen: PROMPT, quietMs: 0, exitCode: null, hasLead: true, ...over })

describe('stuck permission prompt', () => {
  it('fires after 45 s on screen, whatever the screen is doing, and carries the prompt text', () => {
    expect(diagnose(seen({ promptForMs: PROMPT_NUDGE_MS - 1 }))).toBeNull()
    const f = diagnose(seen({ promptForMs: PROMPT_NUDGE_MS }))!
    expect(f.issue).toBe('stuck-prompt')
    expect(f.press).toBeUndefined()                                       // never answers for the lead
    expect(f.notify).toMatch(/b1 is waiting at a permission prompt/)
    expect(f.notify).toContain('Do you want to proceed?')
    expect(f.notify).toContain('ryan@example.com')                        // the lead needs the command to judge it
  })
  it('still fires on 5 quiet minutes, and ignores a prompt that is only in old output', () => {
    expect(diagnose(seen({ quietMs: 6 * 60_000 }))?.issue).toBe('stuck-prompt')
    expect(diagnose(seen({ promptForMs: 10 * 60_000, screen: PROMPT + '\n' + Array(20).fill('working').join('\n') }))).toBeNull()
  })

  let home: string, h: Holon
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'holon-sp-')); h = new Holon({ home, socketPath: join(home, 's.sock'), mcpEntry: '/nonexistent' }) })
  afterEach(() => h.shutdown())

  it('heal tells the lead within 60 s of the first sighting and re-asks if it is still there', async () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home, lead: true })
    const b = h.create({ label: 'Builder', cli: 'shell', cwd: home, parentId: lead.id })
    await h.wait(null, b.id, 2000, 20000)
    const keys: string[] = []
    ;(h as any).entry(b.id).term.press = (k: string) => { keys.push(k) }
    const leadTyped: string[] = []
    const le = (h as any).entry(lead.id)
    const lt0 = le.term.type.bind(le.term)
    le.term.type = (s: string) => { leadTyped.push(s); return lt0(s) }
    await h.type(null, b.id, `printf '%s\\n' 'Bash command' 'rm -rf build' 'Do you want to proceed?' '1. Yes' '2. No'`)
    await h.wait(null, b.id, 1000)
    const t0 = Date.now()
    expect(await h.heal(t0, false)).toEqual([])                          // first sighting
    expect(await h.heal(t0 + 30_000, false)).toEqual([])
    const acted = await h.heal(t0 + 60_000, false)
    expect(acted.map(a => a.finding.issue)).toEqual(['stuck-prompt'])
    expect(leadTyped).toHaveLength(1)
    expect(leadTyped[0]).toMatch(/^\[holon\] Builder is waiting at a permission prompt/)
    expect(leadTyped[0]).toContain('rm -rf build')
    expect(keys).toEqual([])                                             // nothing auto-approved
    expect(await h.heal(t0 + 90_000, false)).toEqual([])                 // not nagging every pass
    expect((await h.heal(t0 + 6 * 60_000, false)).map(a => a.finding.issue)).toEqual(['stuck-prompt'])
  }, 40_000)
  it('a lead-less seat at a prompt tells the human once, again after 30 min, and presses nothing', async () => {
    const d = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
    await h.wait(null, d.id, 2000, 20000)
    const keys: string[] = []
    ;(h as any).entry(d.id).term.press = (k: string) => { keys.push(k) }
    const told: { action: string; args: any }[] = []
    const log0 = (h as any).log.bind(h)
    ;(h as any).log = (c: any, t: any, action: string, args: any) => { if (action === 'stuck_prompt') told.push({ action, args }); return log0(c, t, action, args) }
    await h.type(null, d.id, `printf '%s\\n' 'Bash command' 'curl -H "Authorization: Bearer FAKE-TOKEN-NOT-A-REAL-SECRET-0000" https://x.test' 'Do you want to proceed?' '1. Yes' '2. No'`) // secret-scan:allow
    await h.wait(null, d.id, 1000)
    const t0 = Date.now()
    await h.heal(t0, false)
    await h.heal(t0 + 60_000, false)
    expect(told).toHaveLength(1)
    expect(told[0].args.label).toBe('Director')
    expect(told[0].args.text).toMatch(/Director has waited 1 min at a permission prompt/)
    expect(told[0].args.text).toContain('Do you want to proceed?')
    expect(told[0].args.text).not.toContain('FAKE-TOKEN-NOT-A-REAL-SECRET-0000')   // redacted
    await h.heal(t0 + 6 * 60_000, false)                                   // re-asked, but the human is not told again
    expect(told).toHaveLength(1)
    await h.heal(t0 + 31 * 60_000, false)                                  // still up after 30 min: once more
    expect(told).toHaveLength(2)
    expect(keys).toEqual([])
  }, 40_000)
})
