import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The scan config may exempt the redaction test's fake secrets and nothing else: an allowlisted
// source file would hide a real leak from a stranger's scan and from ours.
it('.gitleaks.toml allowlists only test files', () => {
  const toml = readFileSync(join(import.meta.dirname, '../../../.gitleaks.toml'), 'utf8')
  const paths = [...toml.matchAll(/'''([^']+)'''/g)].map(m => m[1])
  expect(paths.length).toBeGreaterThan(0)
  for (const p of paths) expect(p).toMatch(/^packages\/[a-z]+\/test\//)
})
