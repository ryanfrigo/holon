import { expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kb } from '../src/kb.ts'

it('writes, updates in place, reads and searches entries', () => {
  const kb = new Kb(join(mkdtempSync(join(tmpdir(), 'kb-')), 'org'))
  const p = kb.write('decision', 'Pricing is $99 per month', 'Chosen because competitors charge $150+.', 'director')
  kb.write('lesson', 'Codex update prompt eats tasks', 'Start codex with check_for_update_on_startup=false.', 'holon')
  kb.write('decision', 'Pricing is $99 per month', 'Confirmed by the council on Oct 21.', 'director')
  expect(kb.stats()).toMatchObject({ decision: 1, lesson: 1 })
  expect(kb.read(p).body).toContain('Confirmed by the council')
  expect(kb.search('pricing competitors')[0].title).toBe('Pricing is $99 per month')
  expect(kb.search('codex', 'lesson')).toHaveLength(1)
  expect(() => kb.read('../../etc/passwd')).toThrow(/no kb entry/)
})
