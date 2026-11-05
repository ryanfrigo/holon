import { describe, expect, it } from 'vitest'
import { digestPrompt } from '../src/digest.ts'

describe('digest prompt', () => {
  it('gives the model goal headlines only, so old evidence in goal text is not reported as news', () => {
    const goals = ['UI: run screens daily. Seen 2026-10-30: the Board log overlaps Updates.', 'x'.repeat(300)]
    const p = digestPrompt({ directive: 'd', goals, roles: [], actions: [], asksWaiting: [] }, 30)
    expect(p).toContain('- UI: run screens daily.')
    expect(p).not.toContain('overlaps')
    expect(p).toContain(`- ${'x'.repeat(120)}\n`)
    expect(p).not.toContain('x'.repeat(121))
  })
})
