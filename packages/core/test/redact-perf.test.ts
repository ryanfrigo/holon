import { describe, expect, it } from 'vitest'
import { redact } from '../src/watcher.ts'

// The key is built here, never written out: a real-looking key in a test file is exactly
// what the secret scan is meant to catch.
const FAKE_KEY = 'sk-' + 'a'.repeat(40)

// A slug that only looks like a key: 'sk-' inside 'disk-' is not a word start.
const LOOKALIKE = 'disk-nearly-full-on-the-org-machine-2026-10-21'

const BASE64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5' + 'abcdefghijklmnopqrstuvwxyz0123456789+/'

// redact() runs on every screen, trace and log write, so one long line - a minified file
// printed in a terminal - must not be able to freeze the daemon. Three of its patterns used
// to walk a long line quadratically: a URL scheme that scanned to the end of the line, a
// value whose digit was looked for at the end of the line, and an upper-case name whose
// keyword was searched for one position at a time. The three long lines below are the ones
// that took 14 s, 3 s and 4 s.
const LINES: [string, string][] = [
  ['assignments', 'a='.repeat(75_000)],
  ['one long word', 'x'.repeat(150_000)],
  ['base64', BASE64.repeat(2_000)],
  ['a key on every word', 'secret='.repeat(25_000)],
  ['dash separated words', 'a-'.repeat(75_000)],
  ['upper case names', 'SECRET'.repeat(21_000)],
]

// Terminal-wrapped text (80-column lines, the shape the unwrap pass joins) is measured against
// a looser limit: 150 KB takes 25-75 ms, and a merge running beside three others measured 138.
// The failure to catch is a blowup, not a slow machine: the first version of the unwrap pass
// took 4-5 s here, 15x past this limit.
const WRAPPED: [string, string][] = [
  ['wrapped dash words', 'a-'.repeat(75_000)],
  ['wrapped one long word', 'x'.repeat(150_000)],
  ['wrapped key on every word', 'secret='.repeat(25_000)],
].map(([label, text]) => [label, (text.match(/.{1,80}/g) ?? []).join('\n')])

// The fastest of three runs: the machine may be busy, the work must not be.
const ms = (line: string): number => {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    redact(line)
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe('redact() on a long line', () => {
  for (const [label, line] of LINES) {
    it(`redacts a 150 KB ${label} line in under 100 ms`, () => {
      expect(line.length).toBeGreaterThan(100_000)
      const took = ms(line)
      expect(took, `${label}: ${took.toFixed(1)} ms`).toBeLessThan(100)
    })
  }

  for (const [label, line] of WRAPPED) {
    it(`redacts a 150 KB ${label} text in under 300 ms`, () => {
      expect(line.length).toBeGreaterThan(100_000)
      let best = Infinity
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        redact(line)
        best = Math.min(best, performance.now() - t0)
      }
      expect(best, `${label}: ${best.toFixed(1)} ms`).toBeLessThan(300)
    })
  }

  it('still finds a key in the middle of a 150 KB line', () => {
    const line = `${'x'.repeat(75_000)} ${FAKE_KEY} ${'y'.repeat(75_000)}`
    const out = redact(line)
    expect(out).not.toContain(FAKE_KEY)
    expect(out).toContain('[secret]')
    expect(out.length).toBe(line.length - FAKE_KEY.length + '[secret]'.length)
  })

  it('leaves a slug that only looks like a key alone on a long line', () => {
    const line = `${'x'.repeat(75_000)} ${LOOKALIKE} ${'y'.repeat(75_000)}`
    expect(redact(line)).toBe(line)
  })

  it('redacts a password in the middle of a long line', () => {
    const line = `${'x'.repeat(75_000)} password=secretvalue123 ${'y'.repeat(75_000)}`
    const out = redact(line)
    expect(out).not.toContain('secretvalue123')
    expect(out).toContain('password=[secret]')
  })
})
