import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  test: {
    testTimeout: 30_000,
    include: ['packages/*/test/**/*.test.ts'],
    globalSetup: ['./test-support/machine-lock.ts'],
    // Test terminals run a plain sh: a login zsh with a full profile boots slowly and
    // unpredictably, which made shell-driven tests race its startup.
    env: { SHELL: fileURLToPath(new URL('./test-support/plain-sh', import.meta.url)), BASH_SILENCE_DEPRECATION_WARNING: '1', HOLON_FAKE_CLIS: '1' },
    // Overseer ask (2026-10-22 pty exhaustion): bound a run's pty peak; the machine-wide
    // test lock (ddb18c7) serialises runs, this bounds each run's concurrent terminals.
    maxWorkers: 2,
  },
})
