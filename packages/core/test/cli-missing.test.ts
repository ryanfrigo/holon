import { afterEach, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '../src/terminal.ts'
import { assertInstalled, isInstalled } from '../src/adapters.ts'
import { Holon } from '../src/holon.ts'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('names the missing CLI and where to get it, and passes once a fake one is on PATH', () => {
  const empty = mkdtempSync(join(tmpdir(), 'holon-'))
  expect(() => assertInstalled('claude', empty)).toThrow(/claude is not installed or not on PATH; install Claude Code/)
  expect(() => assertInstalled('opencode', empty)).toThrow(/opencode\.ai/)
  const bin = mkdtempSync(join(tmpdir(), 'holon-'))
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n')
  chmodSync(join(bin, 'claude'), 0o755)
  expect(() => assertInstalled('claude', `${empty}:${bin}`)).not.toThrow()
})

it('starting a terminal for an absent CLI fails before anything is created', () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  const h = new Holon({ home, socketPath: join(home, 's'), mcpEntry: '/dev/null' })
  vi.stubEnv('HOLON_FAKE_CLIS', '0')
  vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'holon-')))
  try {
    expect(() => h.create({ label: 'Lead', cli: 'codex', cwd: home })).toThrow(/codex is not installed/)
    expect(h.list()).toEqual([])
  } finally { h.shutdown() }
})

it('a fresh org with only Codex on PATH starts its Director and heads on Codex and restores them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  const bin = mkdtempSync(join(tmpdir(), 'holon-'))
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\n')
  chmodSync(join(bin, 'codex'), 0o755)
  vi.stubEnv('PATH', bin)
  // Keep fake terminals enabled; exercise real PATH detection without launching agent CLIs.
  vi.spyOn(Holon.prototype as any, 'installed').mockImplementation((cli: any) => isInstalled(cli))
  vi.spyOn(Terminal.prototype, 'type').mockResolvedValue(undefined)
  vi.spyOn(Terminal.prototype, 'waitQuiet').mockResolvedValue(undefined as never)
  let h = new Holon({ home, socketPath: join(home, 's'), mcpEntry: '/dev/null' })
  try {
    const director = await h.startDirective('Ship a useful product', home)
    expect(director).toMatchObject({ cli: 'codex', grade: 3, model: h.getSettings().gradeModels.codex[3] })
    const head = await h.openDepartment(director.id, 'Engineering')
    expect(head).toMatchObject({ cli: 'codex', grade: 2, model: h.getSettings().gradeModels.codex[2] })
    const builder = h.spawn(head.id, { label: 'Builder', cli: 'claude', grade: 0, cwd: home })
    expect(builder).toMatchObject({ cli: 'codex', grade: 1, model: h.getSettings().gradeModels.codex[1] })
    expect(h.needleCli(director.cli)).toBe('codex')
    vi.mocked(Terminal.prototype.type).mockImplementation(async text => {
      const id = text.match(/verdict tool once with id "([^"]+)"/)?.[1]
      if (id) h.verdict(h.list().find(n => n.label === `Reviewer ${id}`)!.id, id, 'approve', 'Checked')
    })
    expect(await h.secondOpinion(director.id, 'Ready?', 'The checks passed')).toMatchObject({ decision: 'approve' })
    expect(h.recentActions().find(a => a.action === 'second_opinion')?.args.cli).toBe('codex')
    h.shutdown()
    h = new Holon({ home, socketPath: join(home, 's'), mcpEntry: '/dev/null' })
    await h.restore()
    expect(h.list().find(n => n.id === director.id)).toMatchObject({ cli: 'codex', model: h.getSettings().gradeModels.codex[3] })
  } finally { h.shutdown() }
})
