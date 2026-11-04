export type Cli = 'claude' | 'codex' | 'gemini' | 'opencode' | 'shell'
export type State = 'running' | 'quiet' | 'exited' | 'paused'

export interface Node {
  id: string
  label: string
  cli: Cli
  cwd: string
  parentId: string | null
  lead: boolean
  yolo: boolean
  readOnly?: boolean
  tier?: 'light' | 'standard' | 'heavy'
  model?: string
  grade?: Grade
  dept?: string
  charter?: string
  persona?: string
  pendingGrade?: Grade
  gradeFrom?: Grade
  status?: string
  headline: string
  state: State
}

export interface Action {
  ts: string
  caller: string | null
  target: string | null
  action: string
  args: Record<string, unknown>
}

export interface Escalation {
  id: string
  from: string
  to: string | null
  message: string
  kind?: 'need' | 'question'
  blocks?: string
  recommend?: 'yes' | 'no'
  items?: { text: string; answer?: string }[]
  lastNudgedAt?: string
  status: 'open' | 'answered'
  answer?: string
  answeredBy?: string | null
  ts: string
}

export interface Directive {
  text: string
  workspace: string
  directorId: string
  goals: string[]
  deliverables: Deliverable[]
  status: 'running' | 'complete' | 'dead'
  summary?: string
  startedAt: string
  completedAt?: string
  heartbeatMin?: number
  treasury?: Treasury
  autopilot?: boolean
  usage?: { billing?: 'subscription' | 'api'; tokens: number; costUsd: number; unpriced: string[]; updatedAt: string }
  shape?: 'hierarchy' | 'holon'
  template?: 'departments' | 'lean'
  digest?: { ts: string; text: string }
  drafts?: { id: string; ts: string; by: string; text: string; reason: string; status: 'pending' | 'approved' | 'rejected' | 'superseded'; note?: string }[]
  messages?: { id: string; ts: string; text: string; title?: string; brief?: string; folded?: string; status?: 'new' | 'doing' | 'done' | 'declined'; owner?: string; actions?: { ts: string; by: string; text: string }[] }[]
  tasks?: { id: string; title: string; detail: string; by: string; owner?: string; status: 'open' | 'claimed' | 'done' | 'dropped'; result?: string; ts: string }[]
  auditorId?: string
  updates?: { ts: string; by: string; text: string }[]
  council?: { members: string[]; quorum: number }
  proposals?: Proposal[]
}

export interface Proposal {
  id: string
  by: string
  title: string
  rationale: string
  votes: Record<string, { vote: 'yes' | 'no'; reason: string }>
  status: 'open' | 'passed' | 'rejected' | 'expired'
  ts: string
}

export interface Treasury {
  budgetMin: number
  spentMin: number
  earnedMin: number
  minPerDollar: number
  mrr: number
  revenueError?: string
  mrrCheckedAt?: string
}

export interface Deliverable {
  label: string
  kind: 'url' | 'file' | 'command'
  value: string
  note?: string
  ts: string
}

export interface Project { slug: string; name: string; home: string; workspace?: string }

export interface PlanBar { label: string; usedPct: number; resetsAt?: string }
export interface Plan { provider: string; plan?: string; bars: PlanBar[]; note?: string; checkedAt: string; error?: string }
export interface ModelUsage { model: string; cli: string; tokens: number; output: number; cacheRead: number; usd: number; agents: number }

export type Grade = 0 | 1 | 2 | 3
export const GRADE_LABEL: Record<Grade, string> = { 0: 'G0 free', 1: 'G1 light', 2: 'G2 standard', 3: 'G3 heavy' }

export interface RoleRecord { merges: number; rejections: number; stuck: number; tasksDone: number; approvals: number }
export interface Role {
  id: string; label: string; dept: string | null; parentId: string | null; cli: Cli; model?: string
  grade: Grade | null; pendingGrade: Grade | null; gradeFrom: Grade | null; record: RoleRecord; spentMin: number; state: State
  charter: string | null; persona: string | null; lead: boolean
}

export type FreePool = 'opencode' | 'omniroute' | 'openrouter'
export interface Department { dept: string; charter: string; persona: string; grade: Grade; gate?: { paths?: string[]; freeBuilders?: boolean } }
export interface Settings {
  opencodeGo: boolean
  freePools: Record<FreePool, boolean>
  gradeModels: { claude: Record<1 | 2 | 3, string>; codex: Record<1 | 2 | 3, string> }
  freeFirst: boolean
  directiveApproval: boolean
  quotaFallback: boolean
  fallbackRetryMin: number
  dailyCapUsd: number
  runWindow: { start: string; end: string } | null
  departments: Department[]
}

type Msg = { slug: string; event: string; payload: any }
interface Bridge {
  home: string
  open(kind: string, value: string): Promise<void>
  projects(): Promise<Project[]>
  pickFolder(): Promise<string | null>
  clis(): Promise<Cli[]>
  plans(): Promise<Plan[]>
  usage(): Promise<ModelUsage[]>
  advice(): Promise<{ text: string; at: string; path: string } | null>
  addProject(name: string, workspace?: string): Promise<Project>
  call<T = any>(slug: string, method: string, params?: Record<string, unknown>): Promise<T>
  onEvent(fn: (msg: Msg) => void): () => void
  onOpenProject(fn: (slug: string) => void): () => void
}

const bridge = (window as unknown as { holon: Bridge }).holon

// Everything below the tab bar talks to the project in the active tab.
let current = ''
export const setProject = (slug: string) => { current = slug }

export const holon = {
  home: bridge.home,
  open: bridge.open,
  projects: bridge.projects,
  pickFolder: bridge.pickFolder,
  clis: bridge.clis,
  plans: bridge.plans,
  usage: bridge.usage,
  advice: bridge.advice,
  addProject: bridge.addProject,
  call: <T = any>(method: string, params?: Record<string, unknown>) => bridge.call<T>(current, method, params),
  callIn: <T = any>(slug: string, method: string, params?: Record<string, unknown>) => bridge.call<T>(slug, method, params),
  onOpenProject: bridge.onOpenProject,
  onEvent: (fn: (msg: { event: string; payload: any }) => void) => bridge.onEvent(m => { if (m.slug === current) fn(m) }),
}

export const errorText = (err: unknown) =>
  (err as Error).message.replace(/^Error invoking remote method 'holon:call': Error: /, '')
