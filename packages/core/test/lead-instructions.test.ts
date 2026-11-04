import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leadInstructions, launchFor } from '../src/adapters.ts'

let home: string
afterEach(() => {
  vi.unstubAllEnvs()
  if (home) rmSync(home, { recursive: true, force: true })
})

it.each([
  { jev: false, opencode: false, omni: false, fake: false },
  { jev: true, opencode: true, omni: true, fake: false },
  { jev: true, opencode: false, omni: true, fake: false },
  { jev: false, opencode: true, omni: false, fake: false },
  { jev: false, opencode: false, omni: false, fake: true },
])('builds lead instructions for %j', ({ jev, opencode, omni, fake }) => {
  home = mkdtempSync(join(tmpdir(), 'holon-brief-'))
  const bin = join(home, 'bin')
  mkdirSync(bin)
  mkdirSync(join(home, 'mcp'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('PATH', bin)
  vi.stubEnv('HOLON_FAKE_CLIS', fake ? '1' : '0')
  vi.stubEnv('OMNIROUTE_API_KEY', omni ? 'fake-omni-key' : '')
  // These files are only inspected, never executed.
  if (jev) writeFileSync(join(bin, 'jev'), '', { mode: 0o755 })
  if (opencode) writeFileSync(join(bin, 'opencode'), '', { mode: 0o755 })

  const brief = leadInstructions()
  expect(brief.includes('use the jev CLI')).toBe(jev || fake)
  for (const text of ['cli opencode', 'glm-5.3-flash', 'kimi-k3', 'gpt-6-luna', 'opencode/big-pickle']) {
    expect(brief.includes(text)).toBe(opencode || fake)
  }
  expect(brief.includes('omniroute/free-coding')).toBe((opencode || fake) && omni)
  if (opencode && omni) expect(brief).toContain(`- cli opencode defaults to opencode/big-pickle (free, no subscription or OpenRouter key).
  Only with the org setting opencodeGo enabled does it use Go: glm-5.3-flash for light work,
  glm-5.3 for most code, kimi-k3 for heavy work; claude-haiku-5-5 and gpt-6-luna are covered too.
  Builders AND leads run on it, and it costs no runway and no Claude/Codex quota — but it is
  still weaker than Claude on subtle production code: prefer claude or codex there when their
  quota allows. When those are out of quota, opencode is the whole org's working pool.
  Fallback models with no separate cost: opencode/big-pickle, opencode/deepseek-v4.1-flash-free,
  opencode/minimax-m3.1-flash-free (OpenCode's own), and omniroute/free-coding (a local gateway
  that falls over between free models when one is rate-limited).`)
  expect(brief).toContain('- treasury shows')
  if (jev || fake) expect(brief).toContain(`- For bulk reading (big JSON, logs, many files), use the jev CLI in your own shell:
  jev "question" file...  It sends text to a cheap model and returns a short answer, which
  saves your context and the org's runway. Treat its output as a lead and spot-check it.
  Never pipe secrets, .env files or customer personal data through it.`)

  const launch = launchFor('claude', { id: 'lead', cwd: home, home, socketPath: 's', mcpEntry: 'm', lead: true, yolo: false })
  expect(launch.args[launch.args.indexOf('--append-system-prompt') + 1]).toBe(brief)
  if (!jev && !fake) {
    writeFileSync(join(bin, 'jev'), '', { mode: 0o644 })
    expect(leadInstructions()).not.toContain('use the jev CLI')
  }
})
