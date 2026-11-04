// Asks to the human that sit unanswered get re-sent once a day. This file is the pure part:
// which asks are due, how old they are, and the words of the nudge.

export interface HumanAsk {
  id: string
  to: string | null
  status: 'open' | 'answered'
  message: string
  ts: string
  blocks?: string
  recommend?: 'yes' | 'no'
  items?: AskItem[]       // a need to the human with 2+ decisions: each is answered on its own
  lastNudgedAt?: string
}

export interface AskItem { text: string; answer?: string }

const ITEM = /^\s*(?:\d+[.)]|[-*•])\s+(\S.*)$/

/** Each numbered or bulleted entry with the lines it spans. A line right under an entry continues it; a blank line ends it. */
function entries(message: string): { text: string; from: number; to: number }[] {
  const out: { text: string; from: number; to: number }[] = []
  let open = false
  message.split('\n').forEach((line, i) => {
    const m = ITEM.exec(line)
    if (m) { out.push({ text: m[1].trim(), from: i, to: i }); open = true }
    else if (open && line.trim()) { const e = out[out.length - 1]; e.text += ' ' + line.trim(); e.to = i }
    else open = false
  })
  return out
}

/** The decisions in a message: list entries that end in "?", and only when there are two or more.
 *  Bulleted evidence ("- visits 0 since 10-30") is not a decision, so it neither counts nor becomes an item. */
export function splitItems(message: string): string[] | null {
  const qs = entries(message).filter(e => e.text.endsWith('?'))
  return qs.length >= 2 ? qs.map(e => e.text) : null
}

/** The message without the lines that became items: what they are about, and the evidence. */
export function askPreamble(message: string): string {
  const qs = entries(message).filter(e => e.text.endsWith('?'))
  if (qs.length < 2) return message.trim()
  return message.split('\n').filter((_, i) => !qs.some(e => i >= e.from && i <= e.to)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Index of the first item still waiting for an answer, or -1 (also -1 for an ask without items). */
export const firstOpenItem = (e: Pick<HumanAsk, 'items'>): number => e.items?.findIndex(i => i.answer === undefined) ?? -1

/** The question to show in a notification: the first unanswered item when the ask has items. */
export function askHeadline(e: Pick<HumanAsk, 'items' | 'message'>): string {
  const i = firstOpenItem(e)
  if (i < 0 || !e.items) return e.message
  const left = e.items.filter(x => x.answer === undefined).length
  return `${e.items[i].text}${left > 1 ? ` (+${left - 1} more)` : ''}`
}

export const DAY = 24 * 60 * 60_000

/** "5 min", "3 hours", "1 day", "9 days": how long an ask has been waiting. */
export function askAge(ts: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(ts))
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (ms < 60 * 60_000) return unit(Math.max(1, Math.round(ms / 60_000)), 'min').replace('mins', 'min')
  if (ms < DAY) return unit(Math.floor(ms / (60 * 60_000)), 'hour')
  return unit(Math.floor(ms / DAY), 'day')
}

/** What the All projects view shows per org: how many asks wait on the human, the oldest one's age, and the first "blocks" line among them (oldest first). */
export function openAskSummary(asks: HumanAsk[], now = Date.now()): { count: number; age: string; blocks?: string } | null {
  const open = asks.filter(e => e.to === null && e.status === 'open')
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  if (!open.length) return null
  const blocks = open.find(e => e.blocks?.trim())?.blocks?.trim().split('\n')[0].trim()
  return { count: open.length, age: askAge(open[0].ts, now), ...(blocks ? { blocks } : {}) }
}

/** Open human asks older than a day that have not been nudged in the last day. */
export function dueNudges<T extends HumanAsk>(asks: T[], now = Date.now()): T[] {
  return asks.filter(e =>
    e.to === null && e.status === 'open' &&
    now - Date.parse(e.ts) >= DAY &&
    (!e.lastNudgedAt || now - Date.parse(e.lastNudgedAt) >= DAY))
}

/** The notification body: the question, its age, what it blocks, the recommended answer marked. */
export function nudgeBody(e: HumanAsk, now = Date.now()): string {
  const q = askHeadline(e).replace(/\s+/g, ' ').trim()
  return [
    q.length > 200 ? q.slice(0, 200) + '…' : q,
    `Waiting ${askAge(e.ts, now)}.${e.blocks ? ` Blocks: ${e.blocks}.` : ''}`,
    e.recommend ? `Recommended: ${e.recommend === 'yes' ? 'Yes' : 'No'}` : '',
  ].filter(Boolean).join('\n')
}

/** Buttons for the notification. Only a yes/no ask (one with a recommendation) gets them, the
 *  recommended answer first and starred; an open-ended ask gets none, so one tap can't answer it. */
export function nudgeButtons(e: Pick<HumanAsk, 'recommend' | 'items'>): { text: string; answer: 'yes' | 'no' }[] {
  if (!e.recommend || e.items) return []   // the recommendation covers the whole ask, so one tap must not answer every item
  const yes = { text: e.recommend === 'yes' ? '★ Yes' : 'Yes', answer: 'yes' as const }
  const no = { text: e.recommend === 'no' ? '★ No' : 'No', answer: 'no' as const }
  return e.recommend === 'no' ? [no, yes] : [yes, no]
}
