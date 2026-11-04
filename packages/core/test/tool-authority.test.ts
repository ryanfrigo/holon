import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'

// Who may act on whom through the lead tools: a seat acts on its own reports, never on a peer, a
// superior, another project, or (for read-only seats) by writing.
let home: string
let h: Holon
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => h.shutdown())

const running = (directorId: string, extra: object = {}) => {
  ;(h as any).directive = { text: 't', workspace: home, directorId, goals: [], deliverables: [], status: 'running', startedAt: '', shape: 'hierarchy', template: 'departments', ...extra }
}
const seat = (label: string, parentId?: string, extra: object = {}) => h.create({ label, cli: 'shell', cwd: home, lead: true, parentId, ...extra })

describe('tool authority', () => {
  it('a lead cannot finish or drop a peer\'s claimed card, but may finish an unclaimed one', () => {
    const dir = seat('Director'); running(dir.id)
    const a = seat('Alice', dir.id), b = seat('Bob', dir.id)
    const card = h.postTask(a.id, 'a card')
    h.claimTask(a.id, card.id)
    expect(() => h.finishTask(b.id, card.id, 'done')).toThrow(/only its poster, its owner or a lead above/)
    expect(() => h.finishTask(b.id, card.id, 'nah', true)).toThrow(/lead above/)
    expect(h.finishTask(dir.id, card.id, 'ok').status).toBe('done')
    const free = h.postTask(a.id, 'unclaimed')
    expect(h.finishTask(b.id, free.id, 'did it').owner).toBe('Bob')
    const mine = h.postTask(a.id, 'dropped by a stranger')
    expect(() => h.finishTask(b.id, mine.id, 'drop', true)).toThrow(/lead above/)
  })

  it('read-only seats cannot claim or finish cards', () => {
    const dir = seat('Director'); running(dir.id)
    const ro = seat('Co-director', undefined, { readOnly: true })
    const card = h.postTask(dir.id, 'work')
    expect(() => h.claimTask(ro.id, card.id)).toThrow(/read-only/)
    expect(() => h.finishTask(ro.id, card.id, 'x')).toThrow(/read-only/)
  })

  it('the auditor and a co-director cannot set goals', () => {
    const dir = seat('Director')
    const auditor = seat('Auditor', undefined, { readOnly: true })
    running(dir.id, { auditorId: auditor.id })
    expect(() => h.setGoals(auditor.id, ['mine'])).toThrow(/only the top/)
    h.setGoals(dir.id, ['ship'])
    expect(h.getDirective()!.goals).toEqual(['ship'])
  })

  it('spawn reserves the label human but lets a seat work in any directory', () => {
    const dir = seat('Director'); running(dir.id)
    const lead = seat('Lead', dir.id)
    expect(() => h.spawn(lead.id, { label: 'Human', cli: 'shell', cwd: home })).toThrow(/reserved/)
    const elsewhere = mkdtempSync(join(tmpdir(), 'other-project-'))
    expect(h.spawn(lead.id, { label: 'Builder', cli: 'shell', cwd: elsewhere }).cwd).toBe(elsewhere)
    expect(h.spawn(lead.id, { label: 'Builder', cli: 'shell', cwd: home }).parentId).toBe(lead.id)
  })

  it('a reviewer (or any read-only seat) cannot ask for a second opinion', async () => {
    const dir = seat('Director'); running(dir.id)
    const rev = seat('Reviewer rev-1', dir.id, { readOnly: true })
    ;(h as any).reviews.set('rev-1', { resolve() {}, reviewer: rev.id, question: 'q' })
    await expect(h.secondOpinion(rev.id, 'q', '')).rejects.toThrow(/read-only/)
    const ro = seat('Co-director', undefined, { readOnly: true })
    await expect(h.secondOpinion(ro.id, 'q', '')).rejects.toThrow(/read-only/)
  })

  it('promote refuses the auditor, a council seat and any read-only seat', async () => {
    const dir = seat('Director')
    const auditor = seat('Auditor', undefined, { readOnly: true })
    const co = seat('Co-director', undefined, { readOnly: true })
    running(dir.id, { auditorId: auditor.id, council: { members: [dir.id, co.id], quorum: 2 } })
    const dept = h.getSettings().departments[0].dept
    await expect(h.promote(dir.id, auditor.id, dept)).rejects.toThrow(/read-only or council/)
    await expect(h.promote(dir.id, co.id, dept)).rejects.toThrow(/read-only or council/)
    expect(h.list().find(n => n.id === auditor.id)!.readOnly).toBe(true)
  })
})
