import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { Terminal } from '../src/terminal.ts'
import { askHeadline, askPreamble, nudgeBody, nudgeButtons, splitItems } from '../src/asks.ts'

let home: string
let h: Holon
let typed: string[]
beforeEach(() => {
  process.env.HOLON_FAKE_CLIS = '1'
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
  typed = []
  vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
})
afterEach(() => { vi.restoreAllMocks(); h.shutdown() })

const SEVEN = 'Seven calls before launch:\n1. Ship the beta on Friday?\n2) Charge $9 a month?\n- Use the new logo,\n  the blue one?\n\nRecommend yes to all.'

it('splits numbered and bulleted decisions, keeps continuation lines, needs two or more', () => {
  expect(splitItems(SEVEN)).toEqual(['Ship the beta on Friday?', 'Charge $9 a month?', 'Use the new logo, the blue one?'])
  expect(splitItems('Just one thing:\n1. Ship it?')).toBeNull()
  expect(splitItems('JSON or CSV?')).toBeNull()
  expect(askPreamble(SEVEN)).toBe('Seven calls before launch:\n\nRecommend yes to all.')
})

it('bulleted evidence is not split into items; only the questions are', async () => {
  const evidence = 'Traffic is flat.\n- visits 0 since 10-30\n- 2 signups in 9 days\n- ad spend $0'
  expect(splitItems(evidence)).toBeNull()
  expect(splitItems(evidence + '\nShould we spend on ads?')).toBeNull()
  expect(splitItems('1. Ship on Friday?\n- visits 0 since 10-30\n2. Charge $9?')).toEqual(['Ship on Friday?', 'Charge $9?'])
  expect(askPreamble('Why:\n- visits 0\n1. Ship?\n2. Charge?')).toBe('Why:\n- visits 0')
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  await h.escalate(dir.id, evidence, 1000, 'need', { blocks: 'none' })
  expect(h.listEscalations()[0].items).toBeUndefined()
  await h.escalate(dir.id, evidence, 1000, 'need', { blocks: 'none', items: ['Spend on ads?', 'Pause the launch?'] })
  expect(h.listEscalations()[1].items).toHaveLength(2)
})

it('a need to the human with items is answerable item by item; each answer reaches the asker at once', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  await h.escalate(dir.id, SEVEN, 1000, 'need', { blocks: 'none' })
  const [esc] = h.listEscalations()
  expect(esc.items).toHaveLength(3)

  h.answerItem(null, esc.id, 1, 'no')
  expect(typed.join('\n')).toMatch(/item 2 of 3 .*Charge \$9.*: no — 2 still open/)
  expect(h.listEscalations()[0]).toMatchObject({ status: 'open' })
  expect(askHeadline(h.listEscalations()[0])).toBe('Ship the beta on Friday? (+1 more)')   // notifications lead with the first unanswered item

  expect(() => h.answerItem(null, esc.id, 1, 'yes')).toThrow(/already answered/)
  expect(() => h.answerItem(null, esc.id, 9, 'yes')).toThrow(/no item 10/)
  expect(() => h.answerItem(dir.id, esc.id, 0, 'yes')).toThrow(/not sent to you/)

  h.answerItem(null, esc.id, 0, 'yes')
  expect(h.listEscalations()[0].status).toBe('open')
  h.answerItem(null, esc.id, 2, 'yes')
  expect(typed.at(-1)).toContain('that was the last item')
  expect(h.listEscalations()[0]).toMatchObject({ status: 'answered', answer: '1. yes\n2. no\n3. yes', answeredBy: null })
})

it('an explicit items list is used as given, and a message with no list stays a plain ask', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  await h.escalate(dir.id, 'Two things', 1000, 'need', { blocks: 'none', items: ['Domain?', ' ', 'Logo?'] })
  await h.escalate(dir.id, 'JSON or CSV?', 1000, 'need', { blocks: 'none' })
  const [a, b] = h.listEscalations()
  expect(a.items).toEqual([{ text: 'Domain?' }, { text: 'Logo?' }])
  expect(b.items).toBeUndefined()
  h.answer(null, b.id, 'csv')
  expect(h.listEscalations()[1]).toMatchObject({ status: 'answered', answer: 'csv' })
  expect(() => h.answerItem(null, b.id, 0, 'x')).toThrow(/already answered/)
})

it('answering the whole ask closes it and settles the items still open', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  await h.escalate(dir.id, SEVEN, 1000, 'need', { blocks: 'none' })
  const [esc] = h.listEscalations()
  h.answerItem(null, esc.id, 0, 'no')
  h.answer(null, esc.id, 'yes to the rest')
  expect(h.listEscalations()[0]).toMatchObject({ status: 'answered' })
  expect(h.listEscalations()[0].items!.map(i => i.answer)).toEqual(['no', 'yes to the rest', 'yes to the rest'])
})

it('items to a lead are not split, and the nudge shows the first open item with no one-tap buttons', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  const rep = h.spawn(dir.id, { label: 'Rep', cli: 'shell', cwd: home })
  void h.escalate(rep.id, SEVEN, 1000)
  expect(h.listEscalations()[0].items).toBeUndefined()
  await h.escalate(dir.id, SEVEN, 1000, 'need', { blocks: 'none', recommend: 'yes' })
  const e = h.listEscalations()[1]
  expect(nudgeButtons(e)).toEqual([])
  expect(nudgeBody(e)).toContain('Ship the beta on Friday?')
  expect(nudgeBody(e)).not.toContain('Charge $9')
})
