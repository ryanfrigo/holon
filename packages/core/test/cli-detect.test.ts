import { expect, it } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedClis, preferredCli } from '../src/adapters.ts'

const bin = (...names: string[]) => {
  const d = mkdtempSync(join(tmpdir(), 'holon-'))
  for (const n of names) { writeFileSync(join(d, n), '#!/bin/sh\n'); chmodSync(join(d, n), 0o755) }
  return d
}

it('a Codex-only machine is offered codex and a shell, never claude, and defaults to codex', () => {
  const list = installedClis(bin('codex'))
  expect(list).toContain('codex')
  expect(list).toContain('shell')
  expect(list).not.toContain('claude')
  expect(preferredCli(c => list.includes(c))).toBe('codex')
})

it('claude stays the default when installed, or when nothing is (so the error names what to install)', () => {
  expect(preferredCli(c => c === 'claude')).toBe('claude')
  expect(preferredCli(c => c === 'claude' || c === 'codex')).toBe('claude')
  expect(preferredCli(() => false)).toBe('claude')
  expect(installedClis(bin('claude', 'codex'))).toEqual(expect.arrayContaining(['claude', 'codex']))
})
