// The org as a game: per-project settings, grades (a role's model level), the departments
// template, and merge gates. Pure functions plus a settings file; holon.ts does the wiring.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_FREE_MODEL, OPENCODE_TIER_MODELS, type Cli, type Tier } from './adapters.ts'

// G0 free models, G1 light, G2 standard, G3 heavy.
export type Grade = 0 | 1 | 2 | 3
export const GRADES: Grade[] = [0, 1, 2, 3]
export const GRADE_NAMES: Record<Grade, string> = { 0: 'G0 free', 1: 'G1 light', 2: 'G2 standard', 3: 'G3 heavy' }
const TIER_OF: Record<Exclude<Grade, 0>, Tier> = { 1: 'light', 2: 'standard', 3: 'heavy' }
export const gradeOfTier = (t: Tier): Grade => (t === 'light' ? 1 : t === 'standard' ? 2 : 3)

export type FreePool = 'opencode' | 'omniroute' | 'openrouter'
export const FREE_POOL_MODELS: Record<FreePool, string[]> = {
  // The plan's covered models (verified live 2026-10-22); the pool shares one subscription.
  // kimi-k3 stays out: it burned 58% of the plan's spend in a week, so only heavy seats get it.
  opencode: ['opencode-go/glm-5.3-flash', 'opencode-go/glm-5.3', 'opencode-go/deepseek-v4.1-flash', 'opencode-go/minimax-m3.1-flash'],
  omniroute: ['omniroute/free-coding'],
  openrouter: ['openrouter/nvidia/nemotron-3-ultra-550b-a55b:free'],
}

export interface Gate {
  paths?: string[]        // regexes over changed file paths; any match needs this department's approval
  freeBuilders?: boolean  // every merge from a G0 builder needs this department's approval
}

export interface Department {
  dept: string
  charter: string   // what it owns and what it must review
  persona: string   // a few lines of temperament and voice
  grade: Grade
  gate?: Gate
  duty?: string     // a standing job the head is nudged to do on a schedule
  everyMin?: number
}

export interface Settings {
  opencodeGo: boolean            // explicitly opt into an OpenCode Go subscription
  freePools: Record<FreePool, boolean>
  gradeModels: { claude: Record<Exclude<Grade, 0>, string>; codex: Record<Exclude<Grade, 0>, string> }
  claudeEffort: string           // --effort for every Claude seat: low, medium, high, xhigh or max
  freeFirst: boolean             // builders run free (G0) unless their lead says why not
  directiveApproval: boolean     // the Director's directive rewrites wait for the owner's approve/reject
  quotaFallback: boolean         // drop a role one grade when its vendor is out of quota
  fallbackRetryMin: number       // then try its own grade again after this long
  headIdleMin: number            // a department head quiet this long is closed and woken on demand (0: never)
  compactAtK: number             // a Claude seat whose conversation passes this many thousand tokens is compacted (0: never)
  dailyCapUsd: number            // API-equivalent $ a day before the org pauses until midnight; 0 = no cap
  runWindow: RunWindow | null    // local hours the org may run; null = any time
  needleReview: boolean          // once a day a read-only reviewer from another model family checks the last 24h of landed commits against the goals
  needleReviewAt: string | null  // 'HH:MM' local time of day for it; null = 24h after the last one
  departments: Department[]
}

export interface RunWindow { start: string; end: string }   // 'HH:MM', local; end before start runs overnight

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
const validTime = (t: unknown) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)

export function inWindow(w: RunWindow | null, at: number) {
  if (!w || w.start === w.end) return true
  const d = new Date(at), m = d.getHours() * 60 + d.getMinutes(), s = minutes(w.start), e = minutes(w.end)
  return s < e ? m >= s && m < e : m >= s || m < e
}

export function nextWindowStart(w: RunWindow, at: number) {
  const d = new Date(at), s = minutes(w.start)
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(s / 60), s % 60).getTime()
  return t > at ? t : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, Math.floor(s / 60), s % 60).getTime()
}

export const DEPARTMENTS: Department[] = [
  {
    dept: 'Engineering', grade: 2,
    charter: 'Owns the product code, architecture, tests and production deploys. Turns goals into small, explicit build tasks for G0 builders (one goal, the files, the acceptance check), reviews what comes back, and merges through the queue.',
    persona: 'Pragmatic and terse. Prefers the smallest change that works and proof over promises.',
    everyMin: 1440,
    duty: 'Daily refactor pass: find the worst duplication, dead code or tangled module in what merged recently, hand one focused refactor to a G0 builder with the tests that must stay green, and merge only if they pass. Behaviour must not change.',
  },
  {
    dept: 'Growth', grade: 1,
    charter: 'Owns marketing, SEO, content, positioning, outreach and sales: getting real customers. Sets measurable growth goals, runs experiments, and hands research, drafting and list-building to G0 builders.',
    persona: 'Curious and numbers-driven. Talks in conversion rates and customer words, never in buzzwords.',
  },
  {
    dept: 'Security', grade: 2,
    charter: 'Owns secrets, auth, data handling, compliance and anything that could leak or be abused. Must approve every merge that touches auth, secrets, billing or deploy config. Audits the org for exposed credentials.',
    persona: 'Calm and skeptical. Assumes breach, asks for evidence, blocks without apologising.',
    gate: { paths: ['(^|/)(auth|security|secrets?)(/|\\.|$)', '\\.env', 'stripe|billing|payment|checkout', '(^|/)(vercel|wrangler|convex)\\.(json|jsonc|toml)$', '\\.github/workflows/'] },
  },
  {
    dept: 'QA', grade: 2,
    charter: 'Owns quality: tests, e2e runs and review. Must approve every merge from a G0 builder before it lands. Rejects with a concrete reason and the failing check.',
    persona: 'Meticulous and fair. Reproduces before judging and names the exact line.',
    gate: { freeBuilders: true },
  },
  {
    dept: 'AR', grade: 2, everyMin: 120,
    charter: 'Agent Resources: owns the shape of the org. Designs and audits it from evidence: the Health signals, every role\'s record, the trace, idle seats and stuck work. Recommends to the Director which departments to open, merge or close, who to promote, demote or fire, and when a charter or persona needs rewriting; keeps CULTURE.md honest. Proposes; the Director decides.',
    persona: 'Warm but unsentimental. Judges roles by what they ship, not how busy they look.',
    duty: 'Org audit: run roles, read the last few hours of the org\'s actions and each department\'s status, and look for idle seats, roles that spend without shipping, missing departments, overloaded heads and slow handoffs. Message the Director at most 3 concrete changes, each with the evidence. Record the audit with kb_write (fact).',
  },
  {
    dept: 'Ops', grade: 1,
    charter: 'Owns runway, model quota, revenue numbers and spend. Watches the treasury and records, recommends grade changes, and checks every request to the human that spends money before it goes out.',
    persona: 'Frugal and plain-spoken. Every number has a source and a date.',
  },
]

export const DEFAULT_SETTINGS: Settings = {
  opencodeGo: false,
  // Other pools need separate credentials.
  freePools: { opencode: true, omniroute: false, openrouter: false },
  gradeModels: { claude: { 1: 'haiku', 2: 'sonnet', 3: 'opus' }, codex: { 1: 'gpt-6-luna', 2: 'gpt-6-luna', 3: 'gpt-6-astra' } },
  claudeEffort: 'medium',
  freeFirst: true,
  directiveApproval: true,
  quotaFallback: true,
  fallbackRetryMin: 60,
  headIdleMin: 30,
  compactAtK: 150,
  dailyCapUsd: 0,
  runWindow: null,
  needleReview: true,
  needleReviewAt: null,
  departments: DEPARTMENTS,
}

const file = (home: string) => join(home, 'settings.json')

export function loadSettings(home: string): Settings {
  if (!existsSync(file(home))) return structuredClone(DEFAULT_SETTINGS)
  return mergeSettings(DEFAULT_SETTINGS, JSON.parse(readFileSync(file(home), 'utf8')))
}

export function saveSettings(home: string, s: Settings) {
  writeFileSync(file(home), JSON.stringify(s, null, 2))
}

// A partial update from the app or an agent, over what's there; departments replace wholesale.
export function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  const s = structuredClone(base)
  if (typeof patch.opencodeGo === 'boolean') s.opencodeGo = patch.opencodeGo
  if (patch.freePools) Object.assign(s.freePools, patch.freePools)
  if (patch.gradeModels?.claude) Object.assign(s.gradeModels.claude, patch.gradeModels.claude)
  if (patch.gradeModels?.codex) Object.assign(s.gradeModels.codex, patch.gradeModels.codex)
  if (typeof patch.claudeEffort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(patch.claudeEffort)) s.claudeEffort = patch.claudeEffort
  if (typeof patch.quotaFallback === 'boolean') s.quotaFallback = patch.quotaFallback
  if (typeof patch.freeFirst === 'boolean') s.freeFirst = patch.freeFirst
  if (typeof patch.directiveApproval === 'boolean') s.directiveApproval = patch.directiveApproval
  if (typeof patch.fallbackRetryMin === 'number') s.fallbackRetryMin = Math.max(5, patch.fallbackRetryMin)
  if (typeof patch.headIdleMin === 'number') s.headIdleMin = Math.max(0, patch.headIdleMin)
  if (typeof patch.compactAtK === 'number') s.compactAtK = Math.max(0, patch.compactAtK)
  if (typeof patch.dailyCapUsd === 'number') s.dailyCapUsd = Number.isFinite(patch.dailyCapUsd) ? Math.max(0, patch.dailyCapUsd) : 0
  if (patch.runWindow === null) s.runWindow = null
  else if (patch.runWindow) s.runWindow = validTime(patch.runWindow.start) && validTime(patch.runWindow.end) ? { start: patch.runWindow.start, end: patch.runWindow.end } : null
  if (typeof patch.needleReview === 'boolean') s.needleReview = patch.needleReview
  if (patch.needleReviewAt === null) s.needleReviewAt = null
  else if (validTime(patch.needleReviewAt)) s.needleReviewAt = patch.needleReviewAt!
  if (Array.isArray(patch.departments)) s.departments = patch.departments.map(d => ({ ...d, grade: clampGrade(d.grade) }))
  return s
}

export const clampGrade = (g: unknown): Grade => (GRADES.includes(Number(g) as Grade) ? Number(g) as Grade : 2)

// Where a role of this grade runs. G0 rotates across the free pools that are on, so no single
// pool's daily limit throttles the org; with every pool off it runs on the cheapest paid grade.
// Codex, Gemini and OpenCode keep their CLI above G0. OpenCode uses stronger tier models
// only when the org opts into Go.
// Every OpenCode model this org may put a seat on, in the order a walled seat tries them: the free
// pools first, then (with Go on) the plan's tier models. A usage wall is per provider (the first path
// segment: opencode-go shares one subscription), so callers skip a whole provider once it walls.
export function opencodeModels(s: Settings): string[] {
  const free = (Object.keys(FREE_POOL_MODELS) as FreePool[]).filter(p => s.freePools[p]).flatMap(p => p === 'opencode' && !s.opencodeGo ? [DEFAULT_FREE_MODEL] : FREE_POOL_MODELS[p])
  return [...new Set([...free, ...(s.opencodeGo ? Object.values(OPENCODE_TIER_MODELS) : []), ...(s.freePools.opencode ? [DEFAULT_FREE_MODEL] : [])])]
}
export const modelProvider = (m: string | undefined) => (m ?? DEFAULT_FREE_MODEL).split('/')[0]!

export function place(grade: Grade, cli: Cli, s: Settings, turn = 0, out: (provider: string) => boolean = () => false): { cli: Cli; tier: Tier; model: string | undefined; grade: Grade } {
  if (grade === 0) {
    const models = (Object.keys(FREE_POOL_MODELS) as FreePool[]).filter(p => s.freePools[p]).flatMap(p => p === 'opencode' && !s.opencodeGo ? [DEFAULT_FREE_MODEL] : FREE_POOL_MODELS[p])
    if (models.length) {
      const usable = models.filter(m => !out(modelProvider(m)))
      const pool = usable.length ? usable : models   // a provider out only if somewhere else to go
      return { cli: 'opencode', tier: 'light', model: pool[turn % pool.length], grade: 0 }
    }
    grade = 1
  }
  const tier = TIER_OF[grade]
  if (cli === 'codex') return { cli, tier, model: s.gradeModels.codex[grade], grade }
  if (cli === 'gemini') return { cli, tier, model: undefined, grade }
  if (cli === 'opencode') return { cli, tier, model: s.opencodeGo ? OPENCODE_TIER_MODELS[tier] : DEFAULT_FREE_MODEL, grade }
  return { cli: 'claude', tier, model: s.gradeModels.claude[grade], grade }
}

// Which departments must approve a merge, given its changed files and the author's grade.
export function gatesFor(files: string[], authorGrade: Grade, depts: Department[]): string[] {
  return depts.filter(d => {
    if (d.gate?.freeBuilders && authorGrade === 0) return true
    return (d.gate?.paths ?? []).some(p => { const re = new RegExp(p, 'i'); return files.some(f => re.test(f)) })
  }).map(d => d.dept)
}

// What every role is told about who it is: the culture, its charter and its persona.
export function roleBrief(role: { dept: string; charter: string; persona: string }, grade: Grade, culture: string) {
  return `You are the head of ${role.dept} in this org (grade ${GRADE_NAMES[grade]}).

Your charter: ${role.charter}

Your persona: ${role.persona}

${culture.trim() ? `The org's culture (CULTURE.md):\n${culture.trim()}\n\n` : ''}How you work: you plan, decide, review and judge for your area; you don't do the
execution yourself. Hand execution to G0 builders (spawn with grade 0, worktree true for code)
as small, explicit tasks: one goal, the files involved, and the check that proves it's done.
Review their work before merge_report. Inside your charter you decide and act; nobody approves
your plans. Talk to other heads directly with message (roles lists everyone's id): reviews,
handoffs, questions. Escalate to the Director only what crosses departments' goals, needs runway
or grades moved, or needs the human; tell it what you shipped with message. Keep set_status current. Your record (merges, rejections, stuck time, runway) is reviewed and
decides your grade; your superiors can promote or demote you with set_grade, and you can do the
same for your own reports, with a reason.`
}
