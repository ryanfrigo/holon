import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// 2026-11-02: vitest run from packages/core never loaded the root vitest.config.ts, so HOLON_FAKE_CLIS
// was unset and three test seats started the real claude binary. The guard must not depend on that env.
const core = fileURLToPath(new URL('..', import.meta.url))
// A dummy `claude` on the child's PATH: on a Codex-only machine the install check would otherwise throw
// "claude is not installed" before the guard under test is reached (verified 2026-11-03 with no claude on PATH).
const bin = mkdtempSync(join(tmpdir(), 'holon-bin-'))
writeFileSync(join(bin, 'claude'), '#!/bin/sh\n'); chmodSync(join(bin, 'claude'), 0o755)
const run = (env: Record<string, string>, code: string) =>
  execFileSync(process.execPath, ['-e', code], { cwd: core, env: { PATH: bin + delimiter + process.env.PATH!, HOME: process.env.HOME!, ...env }, encoding: 'utf8' }).trim()

it('refuses a real agent CLI under vitest even with no HOLON_FAKE_CLIS, from packages/core', () => {
  const code = `import('./src/holon.ts').then(async ({ Holon }) => {
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'holon-')); const h = new Holon({ home, socketPath: join(home, 's.sock'), mcpEntry: '/dev/null' })
    let msg = 'started'
    try { h.create({ label: 'X', cli: 'claude', cwd: home }) } catch (e) { msg = String(e.message) }
    console.log(msg); h.shutdown(); process.exit(0)
  })`
  expect(run({ VITEST: 'true' }, code)).toMatch(/refusing to start a real agent CLI/)
  expect(run({ NODE_ENV: 'test' }, code)).toMatch(/refusing to start a real agent CLI/)
}, 30_000)
