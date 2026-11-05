// A plain-English digest for the human: what the org did lately and what's happening now,
// written by a free model from the action log and everyone's status line.
import { execFile } from 'node:child_process'
import { redact } from './watcher.ts'

export const DIGEST_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free'
// When the free pool is out for the day (OpenRouter answers 429), a cheap paid model keeps the owner's
// digests and drafts coming: about $0.0005 a call.
export const FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'

// Runs a jev prompt on the free model, then on the fallback; the first usable answer wins.
export async function ask(prompt: string, input: string, ok: (out: string) => boolean, timeoutMs = 120_000, models = [DIGEST_MODEL, FALLBACK_MODEL]): Promise<string | null> {
  for (const model of models) {
    const out = await new Promise<string | null>(resolve => {
      const child = execFile('jev', [prompt], { env: { ...process.env, JEV_MODEL: model }, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : stdout))
      child.stdin?.end(redact(input))
    })
    if (out && ok(out)) return out
  }
  return null
}

const NOISE = new Set(['read_screen', 'wait', 'wait_done', 'press', 'type', 'restore', 'heartbeat'])

export interface DigestInput {
  directive: string
  goals: string[]
  roles: { label: string; dept?: string; grade?: number; state: string; status?: string }[]
  actions: { ts: string; who: string; action: string; detail: string }[]
  asksWaiting: string[]
}

export function digestPrompt(i: DigestInput, sinceMin: number) {
  return [
    `DIRECTIVE: ${i.directive.slice(0, 400)}`,
    // Headlines only: goal text carries old evidence ("Seen 10-30: ...") the model would report as news.
    `GOALS (background, not news):\n${i.goals.map(g => `- ${g.split(/(?<=\.)\s/)[0]!.slice(0, 120)}`).join('\n') || '- none yet'}`,
    `PEOPLE NOW:\n${i.roles.map(r => `- ${r.label}${r.dept ? ` (${r.dept})` : ''}${r.grade !== undefined ? ` G${r.grade}` : ''}, ${r.state}: ${r.status ?? ''}`).join('\n')}`,
    `WHAT HAPPENED IN THE LAST ${sinceMin} MIN:\n${i.actions.filter(a => !NOISE.has(a.action)).slice(-60).map(a => `${a.ts.slice(11, 16)} ${a.who} ${a.action} ${a.detail}`).join('\n') || 'nothing'}`,
    `WAITING ON THE OWNER: ${i.asksWaiting.length ? i.asksWaiting.join(' | ') : 'nothing'}`,
  ].join('\n\n')
}

const ASK = 'You brief the owner of a company run by AI agents. From the notes on stdin, write 4-6 bullets in plain English, ' +
  'at most 20 words each, no jargon, ids or file paths: what got done, what each busy department is doing now, and anything ' +
  'stuck. Report only what the people and the last minutes show; goals are background, never news. Name departments, not agents. If something is waiting on the owner, make the last bullet start with "Waiting on you:". ' +
  'Bullets only, each starting with "- ".'

export async function summarize(input: string): Promise<string | null> {
  const bullets = (o: string) => o.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).slice(0, 6)
  const out = await ask(ASK, input, o => bullets(o).length > 0, 90_000)
  return out ? bullets(out).join('\n') : null
}

const CLARIFY = 'Rewrite the owner\'s message on stdin as a clear brief for the AI org that works for them. First line: a short title ' +
  '(no "Title:" prefix). Then 2-5 bullets, each starting with "- ", stating concrete asks in plain words. Keep their intent and ' +
  'their key words; do not add ideas they did not express; drop filler and typos.'

export async function clarify(text: string): Promise<{ title: string; brief: string } | null> {
  const parse = (o: string) => {
    const lines = o.split('\n').map(l => l.trim()).filter(Boolean)
    const title = lines.find(l => !l.startsWith('- '))?.replace(/^#+\s*|\*\*/g, '').slice(0, 120)
    const bullets = lines.filter(l => l.startsWith('- ')).slice(0, 5)
    return title && bullets.length ? { title, brief: bullets.join('\n') } : null
  }
  const out = await ask(CLARIFY, text, o => !!parse(o), 90_000)
  return out ? parse(out) : null
}

const DRAFT_UPDATE = 'You maintain the directive of a company run by AI agents. Stdin has the CURRENT DIRECTIVE and NEW MESSAGES ' +
  'from the owner that are not in it yet. Rewrite the whole directive so it includes what the owner asked, in their spirit. ' +
  'Keep everything still true, keep every hard rule word for word, keep the structure and length roughly the same. ' +
  'Output only the new directive text, nothing before or after it.'

const DRAFT_NEW = 'Draft the directive for an AI org that will work on the project described on stdin (its README, package ' +
  'files and docs). Write 150-350 words: what the project is, what the org should achieve first (2-4 verifiable goals), and ' +
  'hard rules: spending money goes to the owner as a need; nothing public mentions the owner\'s employer or other projects; ' +
  'keep HOLON-LOG.md with what was verified, decided and shipped. End with: This directive is ongoing. ' +
  'Output only the directive text.'

async function draft(prompt: string, input: string): Promise<string | null> {
  const clean = (o: string) => o.trim().replace(/^```\w*\n?|\n?```$/g, '').trim()
  const out = await ask(prompt, input, o => clean(o).length >= 80)
  return out ? clean(out) : null
}

export const draftDirectiveUpdate = (current: string, messages: string[]) =>
  draft(DRAFT_UPDATE, `CURRENT DIRECTIVE:\n${current}\n\nNEW MESSAGES FROM THE OWNER:\n${messages.map(m => `- ${m}`).join('\n')}`)

export const draftNewDirective = (projectNotes: string) => draft(DRAFT_NEW, projectNotes)

const DESIGN = 'Design the departments of an AI org for the directive and project on stdin. Output ONLY a JSON array of 3-7 ' +
  'objects: {"dept": short name, "charter": what it owns and must review (1-2 sentences), "persona": temperament and voice ' +
  '(1 sentence), "grade": 1 for routine, 2 for most, 3 only for the hardest judgement, "gatePaths": optional array of regexes ' +
  'over changed file paths this department must approve, "reviewsFreeWork": true for the one department that reviews every ' +
  'free-model builder\'s merge}. Fit the departments to this project; do not copy a generic company. Always include "AR" ' +
  '(Agent Resources: audits and reshapes the org).'

export async function draftOrgDesign(input: string): Promise<unknown[] | null> {
  const parse = (o: string) => { try { const a = JSON.parse(o.slice(o.indexOf('['), o.lastIndexOf(']') + 1)); return Array.isArray(a) && a.length ? a : null } catch { return null } }
  const out = await ask(DESIGN, input, o => !!parse(o))
  return out ? parse(out) : null
}
