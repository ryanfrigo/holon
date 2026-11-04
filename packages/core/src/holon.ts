import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import * as net from 'node:net'
import { execFile } from 'node:child_process'
import serialize from '@xterm/addon-serialize'
import { Terminal, type TerminalState } from './terminal.ts'
import { CLIS, TIER_COST, isFree, assertInstalled, isInstalled, preferredCli, launchFor, modelFor, type Cli, type Tier } from './adapters.ts'
import { Kb, type KbKind } from './kb.ts'
import { chainBase, chattyHeads, classify, credentialHunt, diagnose, hookHang, promptOn, redact, redactJson, suspicious, CHATTY_COOLDOWN_MS, CHATTY_WINDOW_MS, type Finding, type MessageEvent } from './watcher.ts'
import { Trace, transcriptFor } from './trace.ts'
import { weekSurplus, type Plan } from './plans.ts'
import { claim, claudeTail, claudeUsage, codexSessions, codexUsage, opencodeSessions, total, type Usage } from './usage.ts'
import { AUDITOR_BRIEF, PEER_BRIEF, REVIEWER_NOTE, PEER_CLIS, newTask, type Shape, type Task } from './modes.ts'
import { rootOf } from './projects.ts'
import { Awake, claimWarner, orgsRunning, publishRunning, readPmset, runCaffeinate, type Power } from './awake.ts'
import { addWorktree, changedFiles, hasUnmergedWork, headCommit, unmergedCommits, mergeBranch, patchId, removeWorktree, type MergeResult, type Worktree } from './worktree.ts'
import { clarify, digestPrompt, draftDirectiveUpdate, draftNewDirective, draftOrgDesign, summarize } from './digest.ts'
import { countLanded, landedLog } from './landed.ts'
import { DEPARTMENTS, type Department, GRADE_NAMES, clampGrade, gatesFor, gradeOfTier, inWindow, loadSettings, mergeSettings, modelProvider, nextWindowStart, opencodeModels, place, roleBrief, saveSettings, type Grade, type Settings } from './org.ts'

// A role's track record; org reviews read it to promote and demote.
export interface RoleRecord { merges: number; rejections: number; stuck: number; tasksDone: number; approvals: number }
const emptyRecord = (): RoleRecord => ({ merges: 0, rejections: 0, stuck: 0, tasksDone: 0, approvals: 0 })

// How often one knowledge-base entry has been read, and by whom.
export interface KbReadStat { reads: number; lastRead: string; by: Record<string, number> }

export interface NodeInfo {
  id: string
  label: string
  cli: Cli
  cwd: string
  parentId: string | null
  lead: boolean
  yolo: boolean
  readOnly?: boolean      // reviewers and co-directors: can read everything, change nothing
  model?: string
  tier?: Tier
  status?: string         // the lead's own one-line summary, via set_status
  sessionId?: string      // claude's conversation id, so a restarted daemon can resume it
  worktree?: Worktree     // its own git worktree and branch, when it changes code
  check?: string          // an acceptance check run in its worktree before the merge; if it fails, the merge is refused
  blocked?: string        // why it can't work right now (e.g. out of quota), set by the watcher
  blockedUntil?: number   // epoch ms the wall is expected to lift (quotaOutUntil); the watcher stays quiet till then
  exited?: boolean        // its process ended; restore must not bring it back
  movedFrom?: { cli: Cli; model?: string; status?: string }   // a Director put back on Opus, until it starts
  createdAt: string
  grade?: Grade           // its model level: G0 free … G3 heavy
  dept?: string           // department it heads, with its charter and persona
  charter?: string
  persona?: string
  record?: RoleRecord
  pendingGrade?: Grade    // a grade change waiting for it to go quiet
  gradeFrom?: Grade       // its own grade while it runs lower because its vendor is out of quota
  cliFrom?: Cli           // its own CLI while it runs on opencode because that vendor is out of quota
  fallbackAt?: string
  brief?: string          // the last task its lead typed in (non-claude seats), re-typed after a daemon restart
  goal?: number           // the directive goal (1-based) this seat serves; 0 = declared overhead, no goal. Unset: inherits its lead's
}

export interface NodeView extends NodeInfo {
  state: TerminalState
  headline: string   // the agent's latest status/message line, e.g. "Ran node --test"
  reroute?: string   // set when spawn sent this role to another pool because its own was out
}

export interface Escalation {
  id: string
  from: string            // terminal id
  to: string | null       // its lead, or null for you
  message: string
  kind?: 'need' | 'question'   // need: something only the human can provide
  blocks?: string         // human asks: what stays stuck until it is answered
  recommend?: 'yes' | 'no'   // human asks: the answer the asker would pick
  items?: AskItem[]       // human asks with 2+ decisions: answered one by one; the ask closes with the last
  lastNudgedAt?: string   // when the human was last re-notified about this open ask
  status: 'open' | 'answered'
  answer?: string
  answeredBy?: string | null
  ts: string
}

// Agent CLIs prefix their messages and tool calls with a bullet; the last such line
// is the best one-line summary of what an agent is doing.
const HEADLINE = /^\s*[⏺●•✻✶✳✢·*]\s+(\S.*)$/
function headline(screen: string): string {
  const lines = screen.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = HEADLINE.exec(lines[i])
    if (m) return m[1].trim().slice(0, 160)
  }
  return ''
}

const goalText = (g: unknown): string => typeof g === 'string' ? g : String((g as { text?: unknown })?.text ?? '')

export interface Action {
  ts: string
  caller: string | null   // terminal id, or null for you
  target: string | null
  action: string
  args: Record<string, unknown>
}

// What counts as the org getting something done, for pacing heartbeats and reviews.
const SHIPPED = new Set(['merged', 'deliver', 'board_done', 'complete'])

// "3d" / "5h" / "20m": how long a number has sat still.
const flatFor = (ms: number) => ms >= 24 * 3600_000 ? `${Math.floor(ms / (24 * 3600_000))}d` : ms >= 3600_000 ? `${Math.floor(ms / 3600_000)}h` : `${Math.max(0, Math.floor(ms / 60_000))}m`

// A goal's number: a shell command that prints it (the last number on stdout is the value).
export interface GoalMetric {
  name: string
  cmd: string
  kind?: 'outcome' | 'output'   // output counts the org's own work; absent means outcome
  value?: number
  at?: string          // when value was measured
  error?: string       // why the last measurement failed; value keeps the last good reading
  beatValue?: number   // value at the last heartbeat: a goal 'moved' when value differs from it
  changedAt?: string   // when value last changed (first measurement counts); history is in goal-history.jsonl
}
export type GoalInput = string | { text: string; metric?: { name: string; cmd: string; kind?: 'outcome' | 'output' } }

export interface Directive {
  text: string
  workspace: string
  directorId: string
  goals: string[]
  goalMetrics?: (GoalMetric | null)[]   // parallel to goals; G1 is index 0
  deliverables: Deliverable[]
  status: 'running' | 'complete' | 'dead'
  summary?: string
  startedAt: string
  completedAt?: string
  treasury?: Treasury
  // Ongoing directives never finish: when the whole org has been idle this long, the
  // Director is nudged to review progress and pick the next most valuable work.
  heartbeatMin?: number
  testCmd?: string   // what the merge queue runs before anything reaches the base branch
  // Autopilot: the org decides everything itself and asks the human only for needs
  // (credentials, services, money, human-only actions). Updates keep the human informed.
  autopilot?: boolean
  updates?: { ts: string; by: string; text: string }[]
  digest?: { ts: string; text: string }   // plain-English summary for the human, by a free model
  messages?: OwnerMessage[]               // everything the human told the org, kept and clarified
  drafts?: DirectiveDraft[]               // suggested rewrites of the directive, waiting on the owner
  shape?: Shape
  tasks?: Task[]
  auditorId?: string
  lastAuditAt?: string
  lastNeedleAt?: string   // when the last daily needle review started
  autoscaleMin?: number   // retire helpers idle this long
  benched?: Record<string, { id: string; at: string; status?: string; transcript?: string }>   // departments whose idle head was closed; woken on demand
  template?: 'departments' | 'lean'   // departments: standing heads under the Director
  approvals?: Record<string, string[]>   // `${branch}@${commit}` → departments that approved it
  usage?: { billing: 'subscription' | 'api'; tokens: number; costUsd: number; unpriced: string[]; updatedAt: string }
  council?: { members: string[]; quorum: number }   // the Director plus co-directors
  proposals?: Proposal[]
  // Seat-minutes by hour, last 24h: hour (ISO, truncated) → "G<n>" or "-:<label>" (no goal) → minutes.
  seatMin?: Record<string, Record<string, number>>
}

// A big decision the council votes on. The proposer's vote counts as yes.
export interface Verdict { decision: 'approve' | 'revise' | 'reject' | 'none'; reasoning: string }

export interface Proposal {
  id: string
  by: string
  title: string
  rationale: string
  votes: Record<string, { vote: 'yes' | 'no'; reason: string }>
  critic?: string      // holon shape: must argue against it before anyone votes
  tiebreaker?: string  // the auditor, voting only when the able members are evenly split in number
  critique?: string
  status: 'open' | 'passed' | 'rejected' | 'expired'
  ts: string
}

export const CODIRECTOR_BRIEF = (text: string, workspace: string, director: string, others: string) => `You are a co-director of an org in Holon, on a council with ${others}. The Director (${director}) runs the org day to day; you don't. Your job is judgment.

The org's directive from the human:
"${text}"

Workspace: ${workspace}. Its HOLON-LOG.md and docs/holon/ are the org's record; read them now.

Big decisions need a majority of the council: goals, production deploys of risky changes, pivots, pricing and positioning, killing a workstream, and anything sent to the human for money. When "[holon] Council proposal p-…" arrives in your terminal, read the evidence yourself (code, data, logs), then vote with the vote tool: yes or no, with a reason the others can check. Vote no when the evidence is weak or the plan doesn't move revenue; that's the point of you. You can propose too, with propose.

You cost runway whenever you're working. Between proposals, stay idle unless you see something the Director is missing, and then propose it.`

// The org's runway, in agent-minutes: every running terminal spends one per minute, and
// settled revenue (measured by a command the org can't edit) earns more. At zero the org dies.
export interface Treasury {
  budgetMin: number
  spentMin: number
  earnedMin: number
  minPerDollar: number     // agent-minutes earned per $1 of MRR, per month
  mrr: number
  revenueCmd?: string
  revenueError?: string
  mrrCheckedAt?: string
  spentBy: Record<string, number>
}

export const runway = (t: Treasury) => t.budgetMin + t.earnedMin - t.spentMin

export interface Deliverable {
  label: string
  kind: 'url' | 'file' | 'command'
  value: string
  note?: string
  ts: string
}

import { LIMITS } from './limits.ts'
import { dueNudges, splitItems, type AskItem } from './asks.ts'
export { LIMITS }

export const DIRECTOR_BRIEF = (text: string, workspace: string) => `You are the Director of a new org in Holon. The human gave you this directive:

"${text}"

Workspace (create everything under it): ${workspace}

How to run the org:
1. Strategy first. spawn a "Strategy" lead (cli claude, lead true) in the workspace. Have it
   research and propose 3-5 concrete, verifiable goals and a plan. Review and tighten them,
   then record them with set_goals. Every goal gets a number and a command that measures it
   (visitors, replies, signups, MRR, entities: a shell command whose last output is the number).
   Commits are not progress; the number moving is. Heartbeats report each number and its change.
2. Staff it. For each workstream, spawn a lead (lead true). Brief each lead fully; they spawn
   and drive their own builders. Capacity is the scarce resource: default builders to
   cli opencode (free models, no runway cost), use cli claude for subtle production code,
   and keep cli codex for review and the council only, because its quota runs out within
   hours. Keep it small: at most ${LIMITS.maxReports}
   reports per lead.
3. Manage. wait on your leads in turn, read their screens, unblock them, answer their
   escalations. Keep set_status current so the human can see where things stand.
4. Autopilot. Decide everything yourself; the human is not your approver. Escalate to them
   only for needs you cannot meet alone, with kind "need": credentials, accounts or
   services you don't have, money to spend, or actions only a person can take (a phone
   call, a signature). Say exactly what you need and why. Keep them informed instead:
   update_human with a short note whenever something real ships, changes or breaks.
   Use the org's knowledge base: kb_search before deciding anything, and kb_write every
   decision (with why), fact (numbers, with source and date), lesson (what failed and the
   fix) and playbook (how to do a recurring task). It outlives every terminal; your log
   and screens don't. Brief your leads to do the same.
5. Verify. Check the outcomes yourself against the goals before you call anything done.
   Before risky moves (production deploys of non-trivial changes, anything touching secrets,
   credentials or billing, pricing changes, pivots), call second_opinion with the question and
   your evidence. A reviewer from another model family checks it read-only. Follow its verdict
   unless you have specific evidence it is wrong, and record why with kb_write.
6. Deliver. For everything the human should open, read or run, call deliver: the running
   site's URL, key files (absolute paths), and the command to start or test it. Make sure
   anything you deliver as a URL is actually running.
7. Finish. When every goal is met and verified, call complete with a short summary of
   what exists, where, and anything left undone. That shuts down your reports. If the
   human asks for more afterwards ("From the human: ..."), staff up again as needed.

Delegate ruthlessly.
- You own goals, allocation (grades and runway) and conflicts between heads. Nothing else.
- If a task would take you more than about three tool calls (diagnosis, code, research, a merge), hand it to a head or a builder with the evidence you have, and move on.
- Heads decide inside their charters and message each other directly. Never make them wait for your approval; they report results in one line.
- Answer an escalation with a decision, not a question back. If the same kind of question reaches you twice, write the rule into CULTURE.md or a playbook.
- Give every free (G0) builder a small spec: one goal, the files it may touch, file:line pointers, a check it can run, the commit message, and spawn it with check set to that command.
- Judge heads by what lands (merges, goals met), not by how busy they look, and move grades toward what ships.
- Talk to few. Work goes on the board and through the merge queue, not through you: post a task, let whoever owns it pick it up, and read results when they land. Every turn re-reads your whole conversation, so one batched message beats five, and checking on someone who has not finished is waste.
- An idle head is fine; an idle org is not. A head with nothing to do is closed and woken when work arrives (a review, a message to its department). But unused quota is lost: while a goal is unmet, end every heartbeat with work staffed on the most valuable goal the owner doesn't block, on the cheapest grade that can do it. A question to the owner blocks only the work that needs its answer. When every goal waits on the owner, staff work that still moves the directive: tests for untested paths, bugs from logs and traces, a review, research a goal will need, prep so the answer lands the moment it comes. Hold only when even that is done; then say which goals wait, and what you need.`

// The departments template: the Director founds the org, then runs it through standing heads.
export const DEPARTMENTS_NOTE = (depts: string[]) => `

This org runs with departments. Before step 2 (Staff it):
a. Found the culture. Write CULTURE.md with set_culture: 5-10 short lines on what the org values,
   how decisions get made (who decides what, when to ask for a second opinion), and what "done"
   means here. Every role is briefed with it; amend it when it stops being true.
b. Open the departments with open_department, one call each: ${depts.join(', ')}. Each head owns
   its area, plans and reviews, and hands execution to free G0 builders. Security and QA gate merges
   in their areas; the merge queue enforces it.
Skip step 1's Strategy lead: the department heads are your strategy team. Set goals from their plans.
c. Your job is now strategy and allocation, not doing the work. Set goals, give each head the goals
   it owns, settle conflicts between them, and move runway and grades to whoever is producing:
   set_grade promotes or demotes any role under you (G0 free, G1 light, G2 standard, G3 heavy),
   always with a reason. Department heads don't count against your report limit.`

export interface DirectiveDraft {
  id: string
  ts: string
  by: string            // the Director, or Holon drafting from the owner's messages
  text: string
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'superseded'
  note?: string         // the owner's note when deciding
}

export interface OwnerMessage {
  id: string
  ts: string
  text: string          // what the human wrote, scrubbed of secrets
  title?: string        // a free model's clarification: a title and concrete asks
  brief?: string
  folded?: string       // when the Director folded it into the directive
  status?: 'new' | 'doing' | 'done' | 'declined'
  owner?: string        // the department (or role) that owns getting it done
  actions?: { ts: string; by: string; text: string }[]   // what was done about it, newest last
}

export interface HolonOptions {
  home: string
  socketPath: string
  mcpEntry: string
  plans?: () => Promise<Plan[]>   // vendor limits with reset times; the daemon reads the real ones
  power?: () => Promise<Power | null>                  // battery and AC state; tests inject it, never real pmset
  caffeinate?: (pid: number) => { stop(): void }      // sleep assertion; tests inject it, never real caffeinate
  gatewayUp?: (host: string, port: number) => Promise<boolean>   // tests inject it, never a real socket
}

// TCP probe with a 1s cap: true on connect, false on error or timeout; the socket always dies.
const probeGateway = (host: string, port: number) => new Promise<boolean>(resolve => {
  const sock = net.connect({ host, port })
  const done = (up: boolean) => { sock.destroy(); resolve(up) }
  sock.setTimeout(1000)
  sock.once('connect', () => done(true))
  sock.once('error', () => done(false))
  sock.once('timeout', () => done(false))
})

export interface CreateParams {
  label: string
  cli: Cli
  cwd: string
  parentId?: string | null
  lead?: boolean
  yolo?: boolean      // default: true for leads, false for reports
  model?: string
  tier?: Tier         // picks the model when none is given: light, standard (reports), heavy (leads)
  readOnly?: boolean
  worktree?: boolean  // give it its own git worktree branched from cwd
  purpose?: 'research' | 'code'   // code changes the repo and merges; research reads and reports
  grade?: Grade       // picks cli, tier and model from the project's settings; overrides tier
  dept?: string
  charter?: string
  persona?: string
  record?: RoleRecord
  why?: string        // a builder above G0: why it needs paid labor
  goal?: number       // set by spawn from the "G<n>" in why; 0 = no goal
  check?: string      // a shell command run in the worktree before the merge; if it fails, the merge is refused
}

// What restore() needs to bring a terminal back exactly as it was.
type Restore = Pick<NodeInfo, 'id' | 'sessionId' | 'createdAt' | 'status' | 'worktree'>

interface Entry { info: NodeInfo; term: Terminal; serializer: serialize.SerializeAddon }

// The org: terminals, who reports to whom, and the log of everything leads do.
export class Holon extends EventEmitter {
  private nodes = new Map<string, Entry>()
  private escalations = new Map<string, Escalation & { resolve?: (answer: string) => void }>()
  private recent: Action[] = []
  private directive: Directive | null = null
  private kb: Kb | null = null
  private kbReads: Map<string, KbReadStat> | null = null
  private trace: Trace | null = null

  readonly opts: HolonOptions
  private settings: Settings
  private freeTurn = 0   // rotates G0 roles across the free pools
  // Vendors whose pool is out of quota, and until when: new spawns on them wait.
  private quotaOutUntil: Partial<Record<Cli, number>> = {}
  private providerOutUntil: Record<string, number> = {}   // OpenCode providers (opencode-go, opencode, ...) that walled, by reset time
  private gatewayUp = probeGateway
  private omnirouteUp = true   // last probe result: 'gateway_down' logs only on the flip from up to down
  // A paused org runs no agents and spends nothing; org.json keeps the seats for resume.
  paused: { at: string; reason: string; until?: string } | null = null

  constructor(opts: HolonOptions) {
    super()
    this.opts = opts
    if (opts.gatewayUp) this.gatewayUp = opts.gatewayUp
    mkdirSync(join(opts.home, 'mcp'), { recursive: true })
    this.settings = loadSettings(opts.home)
    const pausedFile = join(opts.home, 'paused.json')
    if (existsSync(pausedFile)) this.paused = JSON.parse(readFileSync(pausedFile, 'utf8'))
  }

  // ── staying awake: a sleeping Mac stops every org, so hold it awake and say when it will not stay ──
  readonly awake = new Awake({
    power: () => (this.opts.power ?? readPmset)(),
    caffeinate: pid => (this.opts.caffeinate ?? runCaffeinate)(pid),
    running: () => this.seatsRunning(),
    claim: () => claimWarner(this.opts.home),
    orgs: () => { publishRunning(this.opts.home, this.seatsRunning()); return orgsRunning(this.opts.home) },
    notify: (action, args) => this.log(null, null, action, args),
    ask: message => {
      const esc: Escalation = { id: `esc-${randomBytes(2).toString('hex')}`, from: 'holon', to: null, message, kind: 'need', status: 'open', ts: new Date().toISOString() }
      this.escalations.set(esc.id, { ...esc })
      this.log('holon', null, 'escalate', { id: esc.id, message })
      this.saveEscalations()
      return esc.id
    },
    clearAsk: (id, why) => { if (this.escalations.get(id)?.status === 'open') this.answer(null, id, why) },
  })

  // Every minute from the daemon.
  private seatsRunning() { return this.paused ? 0 : this.list().filter(n => n.state === 'running').length }
  async checkAwake() {
    publishRunning(this.opts.home, this.seatsRunning())   // peers add these up when they warn
    const slept = await this.awake.check()
    if (slept) this.log(null, null, 'slept', { minutes: slept.sleptMin })
  }
  // From the app: the system is about to sleep, or the screen locked.
  systemSuspend(reason: string, lock = false) { return this.awake.suspending(reason, lock) }
  // From the app, on wake: how long the machine was out, so efficiency numbers can discount it.
  systemResume(sleptMs: number) {
    const slept = this.awake.resumed(Math.max(0, sleptMs))
    if (sleptMs >= 60_000) this.log(null, null, 'slept', { minutes: slept.sleptMin })   // an unlock after a plain lock is not a sleep
    return slept
  }

  getSettings(): Settings {
    return this.settings
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.settings = mergeSettings(this.settings, patch)
    saveSettings(this.opts.home, this.settings)
    this.emit('settings', this.settings)
    return this.settings
  }

  // ── for you (the UI and CLI): unrestricted ─────────────────────────────

  create(p: CreateParams, restore?: Restore): NodeView {
    if (this.paused && p.cli !== 'shell') throw new Error(`this org is paused (since ${this.paused.at.slice(0, 16)}); resume it first`)
    if (p.grade !== undefined && p.model === undefined && p.cli !== 'shell') {
      const at = place(clampGrade(p.grade), p.cli, this.settings, this.freeTurn++, p => (this.providerOutUntil[p] ?? 0) > Date.now())
      p = { ...p, cli: at.cli, tier: at.tier, model: at.model, grade: at.grade }
    }
    if (!CLIS.includes(p.cli)) throw new Error(`unknown cli "${p.cli}" (use ${CLIS.join(', ')})`)
    if (p.parentId && !this.nodes.has(p.parentId)) throw new Error(`no terminal "${p.parentId}"`)
    if (!restore && process.env.HOLON_FAKE_CLIS !== '1') assertInstalled(p.cli)
    const id = restore?.id ?? `${p.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 't'}-${randomBytes(2).toString('hex')}`
    const worktree = restore?.worktree
      ? addWorktree(restore.worktree.base, restore.worktree.path, restore.worktree.branch)
      : p.worktree ? addWorktree(p.cwd, join(this.opts.home, 'worktrees', id), `holon/${id}`) : undefined
    const info: NodeInfo = {
      id, label: p.label, cli: p.cli, cwd: worktree?.path ?? p.cwd, parentId: p.parentId ?? null, worktree,
      lead: p.lead ?? false, yolo: p.yolo ?? p.lead ?? false, readOnly: p.readOnly, status: restore?.status,
      // Only a top-level lead (the Director) defaults to heavy; leads under it ask for heavy when they need it.
      tier: p.tier ?? (p.lead && !p.parentId ? 'heavy' : 'standard'),
      model: modelFor(p.cli, p.tier ?? (p.lead && !p.parentId ? 'heavy' : 'standard'), p.model, this.settings.opencodeGo),
      sessionId: p.cli === 'claude' ? restore?.sessionId ?? randomUUID() : undefined,
      createdAt: restore?.createdAt ?? new Date().toISOString(),
      dept: p.dept, charter: p.charter, persona: p.persona, record: p.record ?? emptyRecord(),
      check: p.check, goal: p.goal,
    }
    if (info.goal === undefined) delete info.goal
    info.grade = p.grade ?? (isFree(info.cli, info.model) ? 0 : gradeOfTier(info.tier!))
    if (info.cli === 'shell') delete info.grade
    const launch = launchFor(info.cli, {
      id, cwd: info.cwd, lead: info.lead, yolo: info.yolo, readOnly: info.readOnly, model: info.model,
      sessionId: info.sessionId, resume: !!restore?.sessionId, ...this.opts,
    })
    // Tests never start real agent CLIs (they cost quota); every terminal runs a plain shell.
    const fake = process.env.HOLON_FAKE_CLIS === '1' && info.cli !== 'shell'
    const term = new Terminal({ command: fake ? '/bin/sh' : launch.command, args: fake ? [] : launch.args, cwd: fake ? info.cwd : launch.cwd ?? info.cwd, env: launch.env })
    const serializer = new serialize.SerializeAddon()
    term.screen.loadAddon(serializer)
    term.on('data', data => this.emit('data', { id, data }))
    term.on('exit', code => { info.exited = true; this.emit('exit', { id, code }); this.saveOrg() })
    this.nodes.set(id, { info, term, serializer })
    this.saveOrg()
    return this.view(id)
  }

  list(): NodeView[] {
    return [...this.nodes.keys()].map(id => this.view(id))
  }

  write(id: string, data: string) {
    this.entry(id).term.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    this.entry(id).term.resize(cols, rows)
  }

  // Escape sequences that redraw the current screen, for a viewer attaching late.
  snapshot(id: string): string {
    return this.entry(id).serializer.serialize()
  }

  kill(id: string) {
    for (const child of this.list().filter(n => n.parentId === id)) this.kill(child.id)
    const e = this.entry(id)
    e.term.kill()
    // The branch always survives; the checkout goes only if nothing uncommitted is in it.
    if (e.info.worktree) { try { removeWorktree(e.info.worktree) } catch {} }
    this.nodes.delete(id)
    this.saveOrg()
  }

  // A lead closing one of its own reports (and that report's whole team).
  // The reason is required and kept in the trace: a kill without one is a builder that died for no visible reason.
  killReport(caller: string | null, id: string, reason: string, force = false) {
    const e = this.entry(id)
    if (caller !== null && e.info.parentId !== caller) throw new Error(`"${id}" is not your report`)
    if (caller !== null && !reason.trim()) throw new Error('kill_report needs a reason: one line on why this report is being closed (done and merged? stuck at a prompt? pool out?)')
    const ageMin = (Date.now() - Date.parse(e.info.createdAt)) / 60_000
    if (caller !== null && !force && ageMin < 5) {
      const min = Math.max(1, Math.round(ageMin))
      throw new Error(`"${id}" is only ${min} min old. A quiet new builder is usually working or waiting at a prompt: read_screen it first. Pass force: true to kill it anyway.`)
    }
    this.log(caller, id, 'kill', { label: e.info.label, reason: reason.trim().slice(0, 200) })
    this.noteWallAtKill(e)
    this.kill(id)
  }

  // A seat that dies of a quota wall within seconds of launch is gone before heal's 2-minute pass
  // (and its 20 s stillness test) can see it, so its pool stayed "in" and the next spawn walled the
  // same way: 8 G0 builders on 10-27/28 lived 12-22 s each. Read the wall off the screen at the kill.
  private noteWallAtKill(e: { info: NodeInfo; term: Terminal }) {
    const cli = e.info.cli
    if (cli !== 'claude' && cli !== 'codex' && cli !== 'opencode') return
    const seen = { label: e.info.label, cli, screen: e.term.readScreen().text, quietMs: Infinity, exitCode: e.term.exitCode, hasLead: e.info.parentId !== null }
    if (diagnose(seen)?.issue !== 'quota') return
    const now = Date.now()
    this.quotaOutUntil[cli] = Math.max(this.quotaOutUntil[cli] ?? 0, now + this.settings.fallbackRetryMin * 60_000)
    this.log(null, e.info.id, 'quota_wall', { label: e.info.label, cli, until: new Date(this.quotaOutUntil[cli]!).toISOString(), via: 'kill' })
    void this.resetOf(cli, now).then(t => { this.quotaOutUntil[cli] = Math.max(this.quotaOutUntil[cli] ?? 0, t) }, () => {})
  }

  // ── merge queue: work in worktrees comes back one branch at a time ─────

  private mergeChain: Promise<unknown> = Promise.resolve()
  private mergesInFlight = 0   // queued or running; ship-self waits for none before a restart
  merging() { return this.mergesInFlight }
  // Seats mid-command right now: the same signal the summary's "working" count and the heartbeat use
  // (the rendered screen changed in the last second; a running command's spinner/timer repaints it).
  busySeats() { return this.list().filter(n => n.state === 'running').map(n => n.id) }
  private askedReview = new Set<string>()   // `${branch@commit}:${dept}` already asked to review
  // Branches that asked to merge and are held on a gate: the last approval lands them right away.
  private pendingMerges = new Map<string, { caller: string | null; testCmd?: string }>()
  // Branches the queue has landed, and the commit it landed: a merge_report after the fact
  // says "merged" instead of "nothing to merge".
  private landed = new Map<string, string>()

  // Queues the report's branch: rebase onto its base, run the tests, fast-forward the base.
  async mergeReport(caller: string | null, id: string, testCmd?: string): Promise<MergeResult> {
    this.notAuditor(caller, 'merge work')
    const e = this.entry(id)
    if (caller !== null && e.info.parentId !== caller) throw new Error(`"${id}" is not your report`)
    if (!e.info.worktree) throw new Error(`"${id}" has no worktree; spawn builders with worktree: true`)
    // Gates: departments whose area the branch touches (or QA, for G0 work) approve it first.
    const gate = this.missingApprovals(caller, e)
    if (gate.depts.length) {
      for (const dept of gate.depts) if (this.directive?.benched?.[dept]) await this.wakeHead(dept, `a review of branch ${e.info.worktree.branch}`)
      const heads = this.list().filter(n => n.dept && gate.depts.includes(n.dept))
      for (const h of heads) {
        if (this.askedReview.has(`${gate.key}:${h.dept}`)) continue
        this.askedReview.add(`${gate.key}:${h.dept}`)
        const wt = e.info.worktree
        void this.entry(h.id).term.type(`[holon] Review request: "${e.info.label}" (${e.info.id}, ${GRADE_NAMES[e.info.grade ?? 2]}) wants to merge branch ${wt.branch}, which touches ${gate.files.slice(0, 12).join(', ')}${gate.files.length > 12 ? ' …' : ''}. ` +
          `Read it: git -C ${wt.path} diff ${wt.baseBranch}...HEAD. Then call approve with id ${e.info.id}, or reject with id ${e.info.id} and a concrete reason.`)
      }
      this.log(caller, id, 'gate_wait', { branch: e.info.worktree.branch, depts: gate.depts })
      this.pendingMerges.set(id, { caller, testCmd })
      return { merged: false, reason: `waiting for approval from ${gate.depts.join(' and ')} (${heads.map(h => h.id).join(', ')}); they were asked to review. Run merge_report again once they approve.` }
    }
    const cmd = testCmd ?? this.directive?.testCmd
    const asked = Date.now()
    const job = this.mergeChain.then(async () => {
      const wt = e.info.worktree!
      this.pendingMerges.delete(id)
      // A gate's approval may have landed this branch already: the work is on the base.
      const landed = this.landed.get(wt.branch)
      if (landed && landed === headCommit(wt)) return { merged: true, commit: landed.slice(0, 7) }
      this.log(caller, id, 'merge', { branch: wt.branch, testCmd: cmd ?? null, waitMs: Date.now() - asked })   // waitMs: time in the queue behind other merges
      // The builder's own acceptance check runs inside mergeBranch, on the tree rebased onto the
      // base: a branch cut before a fix landed must not fail on tests the base already repaired.
      const check = e.info.check
      const r = await mergeBranch(wt, cmd, check)
      if (r.checkFailed) {
        this.log(caller, id, 'check_failed', { label: e.info.label, check, output: (r.output ?? '').slice(-2000) })
        this.bump(id, 'rejections')
        return { merged: false, reason: r.reason }
      }
      if (check && r.merged) this.log(caller, id, 'check_passed', { label: e.info.label, check })
      this.log(caller, id, r.merged ? 'merged' : 'merge_refused', { commit: r.commit, reason: r.reason, conflicts: r.conflicts, ms: r.ms, ...(r.testsSkipped ? { testsSkipped: true } : {}) })
      if (r.merged) { this.bump(id, 'merges'); this.landed.set(wt.branch, headCommit(wt)) }
      return r
    }).finally(() => { this.mergesInFlight-- })
    this.mergesInFlight++
    this.mergeChain = job.catch(() => {})
    return job
  }

  setTestCmd(cmd: string | null) {
    if (!this.directive) throw new Error('no directive is running')
    if (cmd) this.directive.testCmd = cmd
    else delete this.directive.testCmd
    this.saveDirective()
  }

  shutdown() {
    this.awake.shutdown()
    for (const { term } of this.nodes.values()) term.kill()
    this.nodes.clear()
  }

  // Stops every agent in this org so it spends nothing, and keeps it stopped across daemon
  // restarts. The seats stay in org.json; resume brings them back as a restart would, Claude
  // sessions with their conversation. Shell terminals keep running: they cost nothing.
  // With `until`, the org resumes on its own once that time has passed (see wake).
  pause(reason = '', until?: number) {
    if (this.paused) return this.paused
    this.saveOrg()
    this.paused = { at: new Date().toISOString(), reason, ...(until ? { until: new Date(until).toISOString() } : {}) }
    writeFileSync(join(this.opts.home, 'paused.json'), JSON.stringify(this.paused, null, 2))
    let stopped = 0
    for (const [id, e] of [...this.nodes]) {
      if (e.info.cli === 'shell') continue
      e.term.removeAllListeners('exit')
      e.term.kill()
      this.nodes.delete(id)
      stopped++
    }
    this.log(null, null, 'pause', { reason, stopped })
    this.emit('org', this.list())
    this.emit('paused', this.paused)
    return this.paused
  }

  // What a paused org will bring back, for the app to show: the seats on disk, not running.
  pausedSeats() {
    if (!this.paused) return []
    const file = join(this.opts.home, 'org.json')
    if (!existsSync(file)) return []
    const dirId = this.directive?.status !== 'dead' ? this.directive?.directorId : undefined
    return (JSON.parse(readFileSync(file, 'utf8')) as NodeInfo[])
      .filter(n => (!n.exited || n.id === dirId) && !this.nodes.has(n.id))
      .map(n => ({ ...n, state: 'paused' as const, headline: n.status ?? '' }))
  }

  // One row for the all-projects dashboard: state, seats, tokens, spend and merges.
  summary(now = Date.now()) {
    const seats = [...this.list(), ...this.pausedSeats()].filter(n => n.cli !== 'shell')
    if (!this.usageCache.size) this.loadUsage()
    const rows = [...this.usageCache.values()]
    const actFile = join(this.opts.home, 'actions.jsonl')
    let mergesToday = 0, merges7d = 0, mergesAll = 0, lastActionAt: string | null = null
    const midnight = new Date(now).setHours(0, 0, 0, 0)
    if (existsSync(actFile)) for (const line of readFileSync(actFile, 'utf8').split('\n')) {
      if (!line) continue
      const ts = line.slice(7, 31)   // {"ts":"<iso>" leads every line
      // The daemon's own bookkeeping is not the org doing anything.
      if (!/"action":"(restore_paused|restore|pause|resume|director_on_opus)"/.test(line)) lastActionAt = ts
      if (!line.includes('"action":"merged"')) continue
      const t = Date.parse(ts)
      mergesAll++
      if (t >= now - 7 * 864e5) merges7d++
      if (t >= midnight) mergesToday++
    }
    const dir = this.directive
    const director = seats.find(n => n.id === dir?.directorId)
    return {
      paused: this.paused,
      directive: dir ? { text: dir.text, status: dir.status, autopilot: !!dir.autopilot, workspace: dir.workspace } : null,
      director: director ? { cli: director.cli, model: director.model ?? null } : null,
      seats: seats.length,
      working: seats.filter(n => n.state === 'running').length,
      tokensIn: rows.reduce((s, r) => s + r.input + r.cacheRead + r.cacheWrite, 0),
      tokensOut: rows.reduce((s, r) => s + r.output, 0),
      costUsd: Math.round(rows.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 100) / 100,
      spentTodayUsd: this.spentToday(),
      mergesToday, merges7d, mergesAll,
      goalMetrics: (dir?.goalMetrics ?? []).flatMap(m => m ? [{ name: m.name, value: m.value, changedAt: m.changedAt, error: m.error }] : []),
      openTasks: (dir?.tasks ?? []).filter(t => t.status === 'open' || t.status === 'claimed').length,
      asks: this.listEscalations().filter(e => e.to === null && e.status === 'open').length,
      lastActionAt,
    }
  }

  // A timed pause ends by itself; a pause without `until` waits for the owner.
  async wake(now = Date.now()) {
    if (!this.paused?.until || now < Date.parse(this.paused.until)) return 0
    const w = this.settings.runWindow
    if (w && !inWindow(w, now) && !this.windowOverride) {
      // Ended outside the run window: wait for the window instead of starting every seat to stop it again.
      const until = nextWindowStart(w, now)
      const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      this.paused = { ...this.paused, reason: `outside its run window (${w.start}–${w.end}); resumes at ${at}`, until: new Date(until).toISOString() }
      writeFileSync(join(this.opts.home, 'paused.json'), JSON.stringify(this.paused, null, 2))
      this.emit('paused', this.paused)
      return 0
    }
    this.log(null, null, 'wake', { reason: this.paused.reason, until: this.paused.until })
    return this.resume('wake', now)
  }

  // Outside its run window the org pauses until the window opens. An owner who resumes it
  // outside the window keeps it running until the window has opened and closed again.
  private windowOverride = false
  checkWindow(now = Date.now()) {
    const w = this.settings.runWindow
    if (!w || inWindow(w, now)) { this.windowOverride = false; return }
    if (this.paused || this.windowOverride) return
    const until = nextWindowStart(w, now)
    const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    this.log(null, null, 'run_window', { start: w.start, end: w.end, until: new Date(until).toISOString() })
    this.pause(`outside its run window (${w.start}–${w.end}); resumes at ${at}`, until)
  }

  // Today's API-equivalent spend, counted as it grows: each refresh adds what every seat spent
  // since the last one (a seat on a new session counts that session in full). The cap pauses the
  // org once a day, until midnight; an owner who resumes it after that keeps it running today.
  private spend: { day: string; usd: number; prev: Record<string, number>; cappedDay?: string } | null = null
  countSpend(now = Date.now()) {
    const file = join(this.opts.home, 'spend-day.json')
    const day = new Date(now).toLocaleDateString('en-CA')
    const costs = new Map([...this.usageCache].map(([id, u]) => [id, u.costUsd ?? 0]))
    this.spend ??= existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { day, usd: 0, prev: Object.fromEntries(costs) }
    const sp = this.spend!
    if (sp.day !== day) { sp.day = day; sp.usd = 0 }
    for (const [id, cur] of costs) {
      const was = sp.prev[id]
      sp.usd += was === undefined ? cur : cur >= was ? cur - was : cur
      sp.prev[id] = cur
    }
    sp.usd = Math.round(sp.usd * 100) / 100
    writeFileSync(file, JSON.stringify(sp))
    const cap = this.settings.dailyCapUsd
    if (cap > 0 && sp.usd >= cap && sp.cappedDay !== day && !this.paused) {
      sp.cappedDay = day
      writeFileSync(file, JSON.stringify(sp))
      const d = new Date(now)
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      this.log(null, null, 'cap_reached', { capUsd: cap, spentUsd: sp.usd })
      if (this.directive) this.directive.updates = [...(this.directive.updates ?? []).slice(-49), { ts: d.toISOString(), by: 'Watcher', text: `Paused: daily cap $${cap} reached ($${sp.usd} today).` }]
      this.pause(`daily cap $${cap} reached ($${sp.usd} spent today); resumes at midnight`, midnight)
    }
  }

  spentToday() { return this.spend?.usd ?? 0 }

  async resume(by: 'owner' | 'wake' = 'owner', now = Date.now()) {
    if (!this.paused) return 0
    if (by === 'owner' && !inWindow(this.settings.runWindow, now)) this.windowOverride = true
    const since = this.paused.at
    this.paused = null
    rmSync(join(this.opts.home, 'paused.json'), { force: true })
    this.log(null, null, 'resume', { since })
    this.emit('paused', null)
    return this.restore('Holon resumed this org after a pause')
  }

  // ── for leads (the MCP tools): limited to direct reports ───────────────

  listReports(caller: string | null): NodeView[] {
    return this.list().filter(n => n.parentId === caller)
  }

  readScreen(caller: string | null, id: string, scrollback = 0) {
    const term = this.report(caller, id)
    if (caller !== null) this.log(caller, id, 'read_screen', { scrollback })
    const s = term.readScreen(scrollback)
    return { ...s, prompt: promptOn(s.text) ?? undefined }
  }

  async type(caller: string | null, id: string, text: string, submit = true) {
    const term = this.report(caller, id)
    this.log(caller, id, 'type', { text, submit })
    // A long brief from a lead is the seat's whole task. Remember it: a codex/opencode
    // builder comes back from a daemon restart to a blank screen, and this is what it lost.
    const info = this.entry(id).info
    if (caller !== null && submit && text.length >= 200 && info.cli !== 'claude' && info.cli !== 'shell' && info.parentId === caller) {
      info.brief = redact(text).slice(0, 8000)
      this.saveOrg()
    }
    await term.type(text, submit)
  }

  press(caller: string | null, id: string, key: string) {
    const term = this.report(caller, id)
    this.log(caller, id, 'press', { key })
    term.press(key)
  }

  // Messages that reached a seat while it sat in wait(): the wait ends so the message is read now,
  // not when the report it was watching finally goes quiet (up to 10 minutes later).
  private inboxAt = new Map<string, number>()

  async wait(caller: string | null, id: string, quietMs = 3000, timeoutMs = 600_000): Promise<{ state: TerminalState | 'timeout' | 'prompt' | 'message'; prompt?: string; screen: string }> {
    const term = this.report(caller, id)
    // Every return is a turn that re-reads the caller's whole conversation: a short timeout is polling.
    timeoutMs = Math.max(timeoutMs, 120_000)
    this.log(caller, id, 'wait', { quietMs })
    const began = Date.now()
    const { state } = await term.waitQuiet(quietMs, timeoutMs, caller === null ? undefined : () => (this.inboxAt.get(caller) ?? 0) >= began)
    const text = term.readScreen().text
    const screen = text.split('\n').slice(-40).join('\n')
    if (state === 'stopped') {
      this.log(caller, id, 'wait_done', { state: 'message' })
      return { state: 'message', screen }
    }
    // A dead terminal's frozen screen can still show a prompt; it must never claim one.
    const prompt = state !== 'exited' ? promptOn(text) : undefined
    this.log(caller, id, 'wait_done', { state: prompt ? 'prompt' : state })
    return prompt ? { state: 'prompt' as const, prompt, screen } : { state, screen }
  }

  // 'human' is the owner's name on the board and in the log; no seat takes it.
  private checkSpawnPlace(p: Omit<CreateParams, 'parentId'>) {
    if (p.label.trim().toLowerCase() === 'human') throw new Error('the label "human" is reserved for the owner; pick another')
  }

  private defaultCli(): Cli { return preferredCli(c => this.installed(c)) }

  // Tests never see the machine's real CLIs: every CLI counts as installed unless a test lifts HOLON_FAKE_CLIS.
  private installed(cli: Cli) { return process.env.HOLON_FAKE_CLIS === '1' || isInstalled(cli) }

  spawn(caller: string | null, p: Omit<CreateParams, 'parentId'>): NodeView {
    this.notAuditor(caller, 'spawn terminals')
    // A read-only seat (reviewer, co-director) is a lead so it can use the holon tools; it must not
    // be able to hire a seat that can write, so spawning is closed to it.
    if (caller !== null && this.entry(caller).info.readOnly) throw new Error('you are a read-only seat: you can read, vote and record findings, but you cannot spawn terminals')
    const dir = this.directive
    if (caller !== null) this.checkSpawnPlace(p)
    if (caller !== null && dir?.shape !== 'holon' && dir?.council?.members.includes(caller) && caller !== dir.directorId) {
      throw new Error("co-directors vote and review; they don't run teams. Propose the work to the council or post it to the board, and the Director staffs it.")
    }
    if (caller !== null) {
      if (this.depth(caller) + 1 >= LIMITS.maxDepth) throw new Error(`org depth limit (${LIMITS.maxDepth}) reached; delegate within your existing reports`)
      // Department heads are standing seats, not staff: they don't count against the cap.
      if (this.listReports(caller).filter(n => !n.dept).length >= LIMITS.maxReports) throw new Error(`you already have ${LIMITS.maxReports} reports; reuse one or kill one first`)
    }
    // Free first: a builder (not a lead) on paid labor needs a reason, which goes on the record.
    const paid = p.grade !== undefined ? p.grade > 0 : !isFree(p.cli, p.model) && p.cli !== 'shell'
    if (caller !== null && !p.lead && paid && this.settings.freeFirst && !p.why?.trim()) {
      throw new Error('free first: builders run on grade 0 (free models, no runway, no quota). Spawn it with grade 0 and a small, explicit task, ' +
        'or say why it needs paid labor (why: "...", e.g. subtle auth code a free model got wrong). The reason is logged for the org review.')
    }
    // A vendor whose pool is out of quota takes no new work: builders and leads go to the free
    // pool, and when that is out too, leads go to the other paid pool or the configured
    // OpenCode models. The reroute tells them which pool they received.
    let reroute: string | undefined
    // An agent that asks for claude on a machine without it gets the installed paid CLI instead.
    if (p.cli === 'claude' && this.defaultCli() !== 'claude') p = { ...p, cli: this.defaultCli(), model: undefined, tier: undefined }
    // G0 runs on OpenCode: while that pool is out, a free builder would wall within seconds and
    // be killed and respawned until it resets (days, for Go's weekly limit). The cheapest paid
    // grade with room does the work instead.
    // The same goes when OpenCode isn't installed at all (a machine with only Claude or Codex).
    const outUntil = this.quotaOutUntil.opencode ?? 0
    const noOpencode = !this.installed('opencode')
    if (p.grade === 0 && (outUntil > Date.now() || noOpencode)) {
      const usable = (c: Cli) => this.installed(c) && (this.quotaOutUntil[c] ?? 0) <= Date.now()
      const to = usable('claude') ? 'claude' as Cli : usable('codex') ? 'codex' as Cli : null
      if (!to && noOpencode && !this.installed('claude') && !this.installed('codex')) {
        throw new Error('no agent CLI to staff this on: install Claude Code (https://docs.anthropic.com/en/docs/claude-code), Codex (https://github.com/openai/codex) or OpenCode (https://opencode.ai) and sign in')
      }
      if (to) {
        const at = new Date(outUntil).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
        p = { ...p, cli: to, grade: 1, model: undefined, tier: undefined }
        reroute = noOpencode ? `rerouted: opencode is not installed, now ${to} G1` : `rerouted: opencode pool out until ${at}, now ${to} G1`
        this.log(caller, null, 'quota_route', { label: p.label, fromCli: 'opencode', toCli: to, grade: 1, lead: !!p.lead })
      }
    }
    if (!reroute && (p.cli === 'claude' || p.cli === 'codex') && (this.quotaOutUntil[p.cli] ?? 0) > Date.now()) {
      const fromCli = p.cli
      const otherPaid = fromCli === 'claude' ? 'codex' as Cli : 'claude' as Cli
      const otherOut = (this.quotaOutUntil[otherPaid] ?? 0) > Date.now()
      if (p.lead && !otherOut) {
        p = { ...p, cli: otherPaid, model: undefined, tier: undefined }
        reroute = `rerouted: ${fromCli} quota out, now ${otherPaid}`
        this.log(caller, null, 'quota_route', { label: p.label, fromCli, toCli: otherPaid, lead: true })
      } else {
        p = { ...p, cli: 'opencode', model: undefined, tier: undefined, ...(p.lead ? {} : { grade: 0 }) }
        reroute = otherOut ? `rerouted: ${fromCli} and ${otherPaid} quota out, now opencode (${this.settings.opencodeGo ? 'OpenCode Go' : 'free models'})` : `rerouted: ${fromCli} quota out, now opencode`
        this.log(caller, null, 'quota_route', { label: p.label, fromCli, toCli: 'opencode', lead: !!p.lead })
      }
    }
    // A Director re-creating a department's head by hand gets an on-call head, not a stray lead
    // the bench can never close again.
    const d = !p.dept && p.lead && caller !== null && caller === dir?.directorId ? this.settings.departments.find(x => x.dept.toLowerCase() === p.label.toLowerCase()) : undefined
    if (d && !this.list().some(n => n.dept === d.dept)) {
      p = { ...p, dept: d.dept, charter: p.charter ?? d.charter, persona: p.persona ?? d.persona }
      if (dir?.benched?.[d.dept]) { delete dir.benched[d.dept]; this.saveDirective() }
    }
    // Goal accounting: a paid spawn names the goal it serves, so capacity cannot drift to side work unseen.
    // A department head is a standing seat, not work, so it is not held to one.
    const goal = this.parseGoal(caller, p.why, paid && !p.dept)
    if (goal !== undefined) p = { ...p, goal }
    const node = this.create({ ...p, parentId: caller })
    // A seat that changes the repo and merges is code; one that reads and reports is research.
    const purpose = p.purpose ?? (p.worktree ? 'code' : 'research')
    const base = chainBase(p.label)
    // The chain is read from the log, so it is read before this spawn is in it.
    const chain = caller === null || node.lead || purpose !== 'code' ? null : this.chainHistory(caller, base)
    this.log(caller, node.id, 'spawn', { why: p.why ?? null, goal: p.goal ?? null, label: p.label, cli: node.cli, tier: node.tier, grade: node.grade, model: node.model, cwd: node.cwd, lead: node.lead, yolo: node.yolo, worktree: !!node.worktree, purpose, check: p.check ?? null })
    this.warnRetryChain(caller, node, base, chain)
    return reroute ? { ...node, reroute } : node
  }

  // "G2: cut checkout errors" → 2. "G0" or "no goal: reason" → 0 (declared overhead). Without goals
  // set, or for free (G0-grade) work with no tag, there is nothing to hold it to.
  private parseGoal(caller: string | null, why: string | undefined, paid: boolean): number | undefined {
    const goals = this.directive?.goals ?? []
    const w = (why ?? '').trim()
    const m = /^G(\d+)\b/i.exec(w)
    if (m) {
      const n = Number(m[1])
      if (goals.length && n > goals.length) throw new Error(`why names G${n} but the directive has ${goals.length} goal(s). ${this.goalList()}`)
      return n
    }
    if (/^no goal\b/i.test(w)) return 0
    if (caller === null || !paid || !goals.length) return undefined
    throw new Error('this spawn is above grade 0, so why must name the goal it serves, starting "G<n>:" (e.g. "G2: cut checkout errors"), ' +
      'or "G0:" / "no goal: <reason>" if it is overhead. ' + this.goalList())
  }

  private goalList() {
    const goals = this.directive?.goals ?? []
    return goals.length ? 'Goals: ' + goals.map((g, i) => `G${i + 1} ${goalText(g)}`).join('; ') : 'The directive has no goals set.'
  }

  // The goal a seat's minutes count toward: its own, else its lead's, up to the top.
  private goalOf(id: string): number | undefined {
    for (let n = this.nodes.get(id)?.info; n; n = n.parentId ? this.nodes.get(n.parentId)?.info : undefined) {
      if (n.goal !== undefined) return n.goal
    }
    return undefined
  }

  // Charges this tick's running minutes to the hour's goal bucket. The top seats and department
  // heads are the org itself, not work, so they are not counted.
  private accrueSeatMin(dtMs: number, now = Date.now()) {
    const dir = this.directive
    if (!dir || dir.status === 'dead') return
    const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString()
    const buckets = dir.seatMin ??= {}
    const b = buckets[hour] ??= {}
    for (const n of this.list()) {
      if (n.state !== 'running' || n.parentId === null || n.dept) continue
      const g = this.goalOf(n.id)
      const key = g ? `G${g}` : `-:${n.label}`
      b[key] = (b[key] ?? 0) + dtMs / 60_000
    }
    const cutoff = now - 24 * 3_600_000
    for (const h of Object.keys(buckets)) if (Date.parse(h) + 3_600_000 <= cutoff) delete buckets[h]
  }

  // Seat-minutes over the last 24h by goal, and the labels of the work that served none.
  goalMinutes(now = Date.now()) {
    const byGoal: Record<string, number> = {}
    const noGoal: Record<string, number> = {}
    let total = 0
    for (const [hour, b] of Object.entries(this.directive?.seatMin ?? {})) {
      if (Date.parse(hour) + 3_600_000 <= now - 24 * 3_600_000) continue
      for (const [k, m] of Object.entries(b)) {
        total += m
        if (k.startsWith('-:')) noGoal[k.slice(2)] = (noGoal[k.slice(2)] ?? 0) + m
        else byGoal[k] = (byGoal[k] ?? 0) + m
      }
    }
    const none = Object.values(noGoal).reduce((a, m) => a + m, 0)
    return { total, none, byGoal, noGoal }
  }

  // Appended to the heartbeat: capacity that went to no goal while a goal is still unmet.
  goalNote(now = Date.now()) {
    const dir = this.directive
    if (!dir?.goals.length) return ''
    const { total, none, noGoal } = this.goalMinutes(now)
    if (total <= 0 || none / total <= 0.25) return ''
    const labels = Object.entries(noGoal).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, m]) => `${l} (${Math.round(m)})`).join(', ')
    return `\nIn the last 24h ${Math.round(none / total * 100)}% of seat-minutes (${Math.round(none)} of ${Math.round(total)}) went to work tied to no goal: ${labels}. Put capacity on the goals.`
  }

  // ── retry chains: the same task spawned again and again, with nothing merged ──

  // The chains this org has run, told once each. 13 chains, 35 spawns, 0 merges.
  private warnedChains = new Set<string>()

  // The code seats this caller already spawned for the same task, and whether any of them
  // merged. The log is the record: a builder that was killed and respawned is gone from the
  // org, but its spawn and its merge are still in actions.jsonl.
  private chainHistory(caller: string, base: string): { attempts: number; merged: boolean } {
    const file = join(this.opts.home, 'actions.jsonl')
    if (!existsSync(file)) return { attempts: 0, merged: false }
    let lines: string[]
    try { lines = readFileSync(file, 'utf8').split('\n') } catch { return { attempts: 0, merged: false } }
    const spawned = new Set<string>()
    const merged = new Set<string>()
    for (const line of lines) {
      if (!line.trim()) continue
      let a: Action
      try { a = JSON.parse(line) as Action } catch { continue }
      if (a.action === 'merged' && a.target) merged.add(a.target)
      if (a.action !== 'spawn' || a.caller !== caller || !a.target) continue
      const args = (a.args ?? {}) as Record<string, unknown>
      const purpose = (args.purpose ?? (args.worktree ? 'code' : 'research')) as string
      if (purpose !== 'code') continue                      // a research seat never merges
      if (chainBase(String(args.label ?? '')) !== base) continue
      spawned.add(a.target)
    }
    return { attempts: spawned.size, merged: [...spawned].some(id => merged.has(id)) }
  }

  // A lead that spawns the same task a third time with nothing merged in between is told
  // once to diagnose the cause. It never blocks the spawn: the lead decides.
  private warnRetryChain(caller: string | null, node: NodeView, base: string, chain: { attempts: number; merged: boolean } | null) {
    if (caller === null || !chain) return
    if (chain.attempts < 2 || chain.merged) return          // fewer than two earlier attempts, or one of them merged
    const key = `${caller}:${base}`
    if (this.warnedChains.has(key)) return                  // once per base per caller
    this.warnedChains.add(key)
    // count: the attempts in this chain, this one included.
    this.log(caller, node.id, 'retry-chain', { label: node.label, base, count: chain.attempts + 1 })
    void this.entry(caller).term.type(`Third attempt at ${base} with no merge. Check why before spawning again: is the model pool dead (read_screen a previous attempt), is the spec too big, is the check wrong? Do not raise the grade just to retry.`)
  }

  // ── directive: the top of the org ───────────────────────────────────────

  // Starts a Director for the directive and hands it the brief. Only one per daemon.
  async startDirective(text: string, workspace: string, heartbeatMin?: number, shape: Shape = 'hierarchy', audit = shape === 'holon', template: 'departments' | 'lean' = 'lean'): Promise<NodeView> {
    const prev = this.directive
    if (prev && this.nodes.has(prev.directorId)) {
      if (prev.status === 'running') throw new Error('a directive is already running; kill its Director first')
      // A completed directive's top retires when the next one starts.
      for (const id of [...(prev.council?.members ?? [prev.directorId]), prev.auditorId]) if (id && this.nodes.has(id)) this.kill(id)
    }
    mkdirSync(workspace, { recursive: true })
    this.openKb(workspace)
    this.trace = Trace.forRun(this.opts.home, workspace, new Date().toISOString())
    const tops = shape === 'holon'
      ? PEER_CLIS.filter(cli => this.installed(cli)).map(cli => this.create({
          label: cli === 'opencode' ? 'Reviewer (Opencode)' : `Peer (${cli[0].toUpperCase()}${cli.slice(1)})`, cli, cwd: workspace, lead: true,
          readOnly: cli === 'opencode',
        }))
      : [this.create({ label: 'Director', cli: this.defaultCli(), grade: 3, cwd: workspace, lead: true })]
    const members = tops.map(t => t.id)
    this.directive = {
      text, workspace, directorId: members[0], goals: [], deliverables: [], status: 'running',
      startedAt: new Date().toISOString(), heartbeatMin, autopilot: true, shape, tasks: [], ...(shape === 'hierarchy' ? { template } : {}),
      ...(shape === 'holon' ? { council: { members, quorum: Math.floor(members.length / 2) + 1 }, proposals: [], autoscaleMin: 20 } : {}),
    }
    // Free models don't self-start reliably, so the auditor uses a paid light grade.
    if (audit) this.directive.auditorId = this.create({ label: 'Auditor', cli: this.defaultCli(), grade: 1, cwd: workspace, lead: true, readOnly: true }).id
    this.log(null, members[0], 'directive', { text, workspace, shape })
    this.saveDirective()
    const label = (id: string) => `"${this.entry(id).info.label}" (${id})`
    await Promise.all([...members, ...(audit ? [this.directive.auditorId!] : [])].map(async id => {
      await this.clearStartup(id)
      const brief = id === this.directive!.auditorId ? AUDITOR_BRIEF(text, workspace)
        : shape === 'holon' ? PEER_BRIEF(text, workspace, label(id), members.filter(m => m !== id).map(label).join(' and ')) +
          (this.entry(id).info.cli === 'opencode' ? REVIEWER_NOTE : '')
        : DIRECTOR_BRIEF(text, workspace) + (template === 'departments' ? DEPARTMENTS_NOTE(this.settings.departments.map(d => d.dept)) : '')
      await this.entry(id).term.type(brief)
    }))
    return this.view(members[0])
  }

  // The auditor checks; it never builds, decides or drives. Enforced, since briefs alone
  // didn't hold it to the role.
  private notAuditor(caller: string | null, what: string) {
    if (caller !== null && caller === this.directive?.auditorId) {
      throw new Error(`you are the auditor: you can't ${what}. Read the evidence yourself, record findings with kb_write, and board_post anything that needs fixing.`)
    }
  }

  // A read-only seat (reviewer, co-director, auditor) reads and records; it does not take work or close it.
  private notReadOnly(caller: string | null, what: string) {
    if (caller !== null && this.entry(caller).info.readOnly) throw new Error(`you are a read-only seat: you can't ${what}`)
  }

  // ── task board: work anyone in the org can post, claim and finish ──────

  private board(): Task[] {
    if (!this.directive) throw new Error('no directive is running')
    return (this.directive.tasks ??= [])
  }

  postTask(caller: string | null, title: string, detail = '') {
    const t = newTask(caller ? this.entry(caller).info.label : 'human', title, detail)
    if (caller) t.byId = caller
    this.board().push(t)
    this.log(caller, null, 'board_post', { id: t.id, title })
    this.saveDirective()
    return t
  }

  // A correction edits the card everyone already points at; a repost leaves the owner's ask
  // pointing at a dead card (one org posted 19 versions of one owner card in 80 minutes).
  updateTask(caller: string | null, id: string, p: { title?: string; detail?: string }) {
    const t = this.board().find(x => x.id === id)
    if (!t) throw new Error(`no task "${id}"`)
    if (t.status === 'done' || t.status === 'dropped') throw new Error(`task ${id} is ${t.status}; reopen work with a new card`)
    this.mayEditCard(caller, t)
    if (p.title !== undefined) t.title = p.title
    if (p.detail !== undefined) t.detail = p.detail
    t.updatedAt = new Date().toISOString()
    this.log(caller, null, 'board_update', { id, title: t.title })
    this.saveDirective()
    return t
  }

  // A card is edited by the seat that posted it, the seat that owns it, a lead above either, or
  // the human. If neither seat exists any more, any lead may take it over rather than orphan it.
  private mayEditCard(caller: string | null, t: Task) {
    if (caller === null) return
    const me = this.entry(caller).info
    // By terminal id: labels are not unique, so a seat that shares the poster's label is not the poster.
    // A card from before ids were kept has only labels to go on.
    const isPoster = (id: string, label: string) => t.byId ? id === t.byId : label === t.by
    const isOwner = (id: string, label: string) => t.ownerId ? id === t.ownerId : label === t.owner
    if (isPoster(caller, me.label) || isOwner(caller, me.label)) return
    const seats = [...this.nodes.entries()].filter(([id, n]) => isPoster(id, n.info.label) || isOwner(id, n.info.label))
    if (me.lead && (seats.length === 0 || seats.some(([id]) => this.isAncestor(caller, id)))) return
    throw new Error(`task ${t.id} belongs to ${t.owner ?? t.by}: only its poster, its owner or a lead above them can edit it. Post a new card or message them.`)
  }

  // The card an id names now: a dropped card whose result names its replacement leads there.
  boardCard(id: string) {
    const board = this.board()
    let t = board.find(x => x.id === id)
    for (let hops = 0; t && t.status === 'dropped' && hops < 30; hops++) {
      const next = t.result?.match(/\bt-[0-9a-f]{4}\b/)?.[0]
      const n = next && next !== t.id ? board.find(x => x.id === next) : undefined
      if (!n) break
      t = n
    }
    return t ?? null
  }

  claimTask(caller: string | null, id: string) {
    this.notAuditor(caller, 'claim tasks')
    this.notReadOnly(caller, 'claim tasks')
    if (caller && this.directive?.shape === 'holon' && this.entry(caller).info.label.startsWith('Reviewer')) {
      throw new Error('you are the reviewer: critique, vote and review merged work; the peers claim build tasks')
    }
    const t = this.board().find(x => x.id === id)
    if (!t) throw new Error(`no task "${id}"`)
    if (t.status !== 'open') throw new Error(`task ${id} is already ${t.status}${t.owner ? ` by ${t.owner}` : ''}`)
    t.status = 'claimed'
    t.owner = caller ? this.entry(caller).info.label : 'human'
    if (caller) t.ownerId = caller; else delete t.ownerId
    this.log(caller, null, 'board_claim', { id, title: t.title })
    this.saveDirective()
    return t
  }

  finishTask(caller: string | null, id: string, result: string, dropped = false) {
    this.notAuditor(caller, 'finish tasks')
    this.notReadOnly(caller, 'finish tasks')
    const t = this.board().find(x => x.id === id)
    if (!t) throw new Error(`no task "${id}"`)
    // A claimed card is its owner's to finish; an unclaimed one may be finished by whoever did the
    // work, but not dropped by a seat that has no say over it.
    if (t.owner || dropped) this.mayEditCard(caller, t)
    t.status = dropped ? 'dropped' : 'done'
    t.result = result
    if (!t.owner) { t.owner = caller ? this.entry(caller).info.label : 'human'; if (caller) t.ownerId = caller }   // finished without a claim: whoever did it owns it
    if (!dropped) this.bump(caller, 'tasksDone')
    this.log(caller, null, 'board_done', { id, title: t.title, result: result.slice(0, 200), dropped })
    this.saveDirective()
    return t
  }

  listTasks(status?: Task['status']) {
    return this.board().filter(t => !status || t.status === status)
  }

  // ── roles: grades, departments, culture and merge gates ─────────────────

  private isAncestor(anc: string, id: string) {
    for (let p = this.entry(id).info.parentId; p; p = this.nodes.get(p)?.info.parentId ?? null) if (p === anc) return true
    return false
  }

  // Puts a role on a new grade: same id, same reports, same worktree, a new process on the new
  // model. A Claude role that stays on Claude keeps its conversation; anything else gets a handoff.
  async reseat(id: string, grade: Grade, note: string, to?: Partial<{ cli: Cli; tier: Tier; model: string | undefined }>) {
    const { info, term } = this.entry(id)
    const at = { ...place(grade, info.cliFrom ?? (info.cli === 'opencode' ? this.defaultCli() : info.cli), this.settings, this.freeTurn++, p => (this.providerOutUntil[p] ?? 0) > Date.now()), ...to }
    const keep = at.cli === 'claude' && !!info.sessionId && (info.cli === 'claude' || info.cliFrom === 'claude')
    const carry = { gradeFrom: info.gradeFrom, fallbackAt: info.fallbackAt, cliFrom: info.cliFrom, brief: info.brief }
    term.removeAllListeners('exit')
    term.kill()
    this.nodes.delete(id)
    this.create({
      label: info.label, cli: at.cli, tier: at.tier, model: at.model, grade: at.grade, cwd: info.worktree?.base ?? info.cwd, worktree: false,
      parentId: info.parentId, lead: info.lead, yolo: info.yolo, readOnly: info.readOnly,
      dept: info.dept, charter: info.charter, persona: info.persona, record: info.record, check: info.check,
    }, { id, sessionId: keep ? info.sessionId : undefined, createdAt: info.createdAt, status: info.status, worktree: info.worktree })
    Object.assign(this.entry(id).info, carry)
    this.saveOrg()
    await this.clearStartup(id)
    // A lead can kill the seat while the new process boots; there is nothing left to brief.
    if (!this.nodes.has(id)) return null
    const now = this.entry(id)
    const parent = info.parentId && this.nodes.has(info.parentId) ? this.entry(info.parentId).info.label : 'the human'
    await now.term.type(keep
      ? `[holon] Your grade is now ${GRADE_NAMES[at.grade]} (${note}). Carry on where you left off.`
      : (info.dept ? roleBrief({ dept: info.dept, charter: info.charter ?? '', persona: info.persona ?? '' }, at.grade, this.culture()) + '\n\n' : '') +
        `[holon] You are "${info.label}", reporting to ${parent}, now on ${GRADE_NAMES[at.grade]} (${note}). The previous holder of this seat ` +
        `was replaced, so its conversation is gone. Its last status: ${info.status ?? 'none'}. Your workspace is ${now.info.cwd}: read git log, ` +
        `HOLON-LOG.md and the KB${info.lead ? ', and list_reports' : ''} to pick up where it left off.` +
        (info.brief ? `\n\nYour task, as your lead last gave it:\n\n${info.brief}` : ''))
    if (!keep && info.parentId && this.nodes.has(info.parentId)) {
      void this.entry(info.parentId).term.type(`[holon] Your report "${info.label}" (${id}) was reseated on ${GRADE_NAMES[at.grade]} (${note}) and lost its conversation. Re-brief it on its current task.`)
    }
    return this.nodes.has(id) ? this.view(id) : null
  }

  // A superior (or the human) changes a role's grade. It applies once the role goes quiet, so
  // nobody is swapped out mid-task.
  setGrade(caller: string | null, id: string, grade: number, reason: string) {
    const e = this.entry(id)
    if (caller !== null && !this.isAncestor(caller, id)) throw new Error(`only someone above "${e.info.label}" can change its grade`)
    const g = clampGrade(grade)
    delete e.info.gradeFrom; delete e.info.fallbackAt
    this.log(caller, id, 'set_grade', { label: e.info.label, from: e.info.grade ?? null, to: g, reason })
    this.kb?.write('decision', `Grade: ${e.info.label} → ${GRADE_NAMES[g]}`, `${new Date().toISOString().slice(0, 16)} by ${caller ? this.entry(caller).info.label : 'the human'}: ${reason}`, 'holon')
    if (e.info.grade === g) { delete e.info.pendingGrade; this.saveOrg(); return this.view(id) }
    e.info.pendingGrade = g
    this.saveOrg()
    return this.view(id)
  }

  // A superior (or the human) removes a role and its team, with a reason that goes on record.
  // A department head's seat falls vacant; the Director can reopen it or promote someone into it.
  fire(caller: string | null, id: string, reason: string) {
    const e = this.entry(id)
    if (caller !== null && !this.isAncestor(caller, id)) throw new Error(`only someone above "${e.info.label}" can fire it`)
    if (id === this.directive?.directorId) throw new Error('the Director can only be replaced by the human, by starting a new directive')
    const { label, dept, record, parentId } = e.info
    this.log(caller, id, 'fire', { label, dept: dept ?? null, reason, record })
    this.kb?.write('decision', `Fired: ${label}`, `${new Date().toISOString().slice(0, 16)} by ${caller ? this.entry(caller).info.label : 'the human'}: ${reason}\nRecord: ${JSON.stringify(record)}`, 'holon')
    this.kill(id)
    const dir = this.directive
    if (dept && dir && this.nodes.has(dir.directorId) && caller !== dir.directorId) {
      void this.entry(dir.directorId).term.type(`[holon] ${label} was fired (${reason}); the ${dept} seat is vacant. Reopen it with open_department, or promote someone who has earned it.`)
    } else if (parentId && parentId !== caller && this.nodes.has(parentId)) {
      void this.entry(parentId).term.type(`[holon] Your report "${label}" was fired: ${reason}. Its branch is kept.`)
    }
    return { fired: id }
  }

  // The Director (or the human) moves a role into a vacant department seat: it reports to the
  // Director, gets the department's charter and persona, lead tools, and a grade.
  async promote(caller: string | null, id: string, dept: string, grade?: number) {
    const dir = this.directive
    if (!dir) throw new Error('no directive is running')
    if (caller !== null && caller !== dir.directorId) throw new Error('only the Director promotes into a department')
    const d = this.settings.departments.find(x => x.dept.toLowerCase() === dept.toLowerCase())
    if (!d) throw new Error(`no department "${dept}" in this project's settings`)
    const held = this.list().find(n => n.dept === d.dept && n.id !== id)
    if (held) throw new Error(`${d.dept} already has a head: ${held.id}; fire or move it first`)
    const e = this.entry(id)
    if (id === dir.directorId) throw new Error('the Director already runs every department')
    // Promotion clears readOnly, so it must never reach a seat that was made read-only on purpose.
    if (e.info.readOnly || id === dir.auditorId || dir.council?.members.includes(id)) throw new Error(`"${e.info.label}" is a read-only or council seat; promote a builder instead`)
    const from = e.info.label
    Object.assign(e.info, { parentId: dir.directorId, lead: true, yolo: true, readOnly: false, dept: d.dept, charter: d.charter, persona: d.persona, label: d.dept })
    delete e.info.pendingGrade
    this.log(caller, id, 'promote', { from, dept: d.dept, grade: clampGrade(grade ?? d.grade) })
    return this.reseat(id, clampGrade(grade ?? d.grade), `promoted from ${from} to head of ${d.dept}`)
  }

  // The human (or anyone above it) rewrites a role's charter or persona; it is told at once.
  updateRole(caller: string | null, id: string, patch: { charter?: string; persona?: string }) {
    const e = this.entry(id)
    if (caller !== null && !this.isAncestor(caller, id)) throw new Error(`only someone above "${e.info.label}" can change its role`)
    if (typeof patch.charter === 'string') e.info.charter = patch.charter
    if (typeof patch.persona === 'string') e.info.persona = patch.persona
    this.log(caller, id, 'update_role', { label: e.info.label, charter: patch.charter !== undefined, persona: patch.persona !== undefined })
    this.saveOrg()
    void e.term.type(`[holon] Your role was updated.${patch.charter !== undefined ? `\nCharter: ${e.info.charter}` : ''}${patch.persona !== undefined ? `\nPersona: ${e.info.persona}` : ''}\nWork to it from now on.`)
    return this.view(id)
  }

  // Run by the daemon every minute: pending grade changes on quiet roles, and roles that fell
  // back for quota trying their own grade again.
  // Standing duties: a department with a recurring job (a cost review, a security audit) is
  // nudged to do it on its schedule, whenever its head is free. Run by the daemon every minute.
  private dutyAt = new Map<string, number>()
  duties(now = Date.now()) {
    const due: string[] = []
    for (const d of this.settings.departments.filter(d => d.duty && d.everyMin)) {
      const head = this.list().find(n => n.dept === d.dept)
      if (!head || head.state === 'running') continue
      const last = this.dutyAt.get(head.id) ?? Date.parse(head.createdAt)
      if (now - last < d.everyMin! * 60_000) continue
      this.dutyAt.set(head.id, now)
      this.log(null, head.id, 'duty', { dept: d.dept })
      void this.entry(head.id).term.type(`[holon] Standing duty, ${new Date(now).toLocaleString()}: ${d.duty}`)
      due.push(head.id)
    }
    return due
  }

  async regrade(now = Date.now()) {
    const done: string[] = []
    for (const id of [...this.nodes.keys()]) {
      const e = this.nodes.get(id)
      if (!e || e.term.state === 'running') continue
      if (e.info.pendingGrade !== undefined) {
        const g = e.info.pendingGrade
        delete e.info.pendingGrade
        await this.reseat(id, g, 'grade changed by a superior')
        done.push(id)
      } else if (e.info.gradeFrom !== undefined && (id === this.directive?.directorId || (e.info.gradeFrom === e.info.grade && !e.info.cliFrom))) {
        // Already on its own grade and CLI (or the Director, which never falls back): just drop the marker.
        delete e.info.gradeFrom; delete e.info.fallbackAt; delete e.info.cliFrom
        this.saveOrg()
      } else if (e.info.gradeFrom !== undefined && now - Date.parse(e.info.fallbackAt ?? '0') > this.settings.fallbackRetryMin * 60_000) {
        // Restore only once the pool it came from has gone quiet for a couple of hours: a dead
        // account shows a wall again minutes after a restore, which would churn the seat forever.
        const backCli = e.info.cliFrom ?? (e.info.cli === 'opencode' ? this.defaultCli() : e.info.cli)
        if (backCli !== 'opencode' && (this.quotaOutUntil[backCli] ?? 0) > now - 2 * 60 * 60_000) continue
        const g = e.info.gradeFrom
        delete e.info.gradeFrom; delete e.info.fallbackAt; delete e.info.cliFrom
        this.log(null, id, 'quota_restore', { label: e.info.label, to: g })
        await this.reseat(id, g, 'quota should have reset; back on its own grade')
        done.push(id)
      }
    }
    return done
  }

  // Every few minutes: a vendor whose plan reports an exhausted window is out until it resets,
  // known before any seat hits the wall (and after a restart, which forgets the walls).
  async refreshPools(now = Date.now()) {
    if (!this.opts.plans) return
    const clis: Record<string, Cli> = { Claude: 'claude', Codex: 'codex', 'OpenCode Go Plus': 'opencode' }
    for (const p of await this.opts.plans()) {
      const cli = clis[p.provider]
      if (!cli || (cli === 'opencode' && !this.settings.opencodeGo)) continue
      const resets = p.bars.filter(b => b.usedPct >= 100 && b.resetsAt).map(b => Date.parse(b.resetsAt!)).filter(t => t > now)
      if (resets.length) this.quotaOutUntil[cli] = Math.max(this.quotaOutUntil[cli] ?? 0, ...resets)
    }
  }

  // When a pool is walled: the vendor's own reset if its plan reports one for an exhausted
  // window, else the retry window. OpenCode Go's comes from the refusal it recorded.
  private async resetOf(cli: Cli, now: number) {
    const fallback = now + this.settings.fallbackRetryMin * 60_000
    const provider = cli === 'claude' ? 'Claude' : cli === 'codex' ? 'Codex' : cli === 'opencode' && this.settings.opencodeGo ? 'OpenCode Go Plus' : null
    if (!provider || !this.opts.plans) return fallback
    try {
      const plan = (await this.opts.plans()).find(p => p.provider === provider)
      const resets = (plan?.bars ?? []).filter(b => b.usedPct >= 100 && b.resetsAt).map(b => Date.parse(b.resetsAt!)).filter(t => t > now)
      return resets.length ? Math.max(...resets) : fallback
    } catch { return fallback }
  }

  // Every pool this org can use is out (its seats' vendors, the ones fallen-back seats came from,
  // and opencode, where walled seats cross to): reseating between them only burns walls, so the
  // org pauses until the first one comes back. Returns true when it paused.
  private pauseIfPoolsOut(now: number) {
    if (this.paused) return false
    const seats = this.list().filter(n => n.cli !== 'shell')
    if (!seats.length) return false
    const pools = new Set<Cli>(['opencode'])
    for (const n of seats) {
      pools.add(n.cli)
      if (n.gradeFrom !== undefined) pools.add(n.cliFrom ?? (n.cli === 'opencode' ? this.defaultCli() : n.cli))
    }
    const outs = [...pools].map(p => this.quotaOutUntil[p] ?? 0)
    if (outs.some(t => t <= now)) return false
    const until = Math.min(...outs)
    const names = [...pools].sort()
    const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const reason = `every model pool this org can use is out (${names.join(', ')}); resumes at ${at}`
    this.log(null, null, 'pools_out', { pools: names, until: new Date(until).toISOString() })
    if (this.directive) this.directive.updates = [...(this.directive.updates ?? []).slice(-49), { ts: new Date(now).toISOString(), by: 'Watcher', text: `Paused: ${reason}.` }]
    this.pause(reason, until)
    return true
  }

  // Out of quota: drop one grade on the same CLI and keep the conversation. When that lowest
  // model is walled too, the vendor as a whole is out: cross to opencode on the plan's models
  // at the original grade. regrade puts the seat back when that vendor has gone quiet for a while.
  private async fallBack(id: string, summary: string, now: number) {
    const e = this.entry(id)
    const from = e.info.grade ?? 0
    const cli = e.info.cli
    if (cli === 'shell') return false
    // The Director always runs on Opus: it waits out a quota wall rather than drop a grade or vendor.
    if (id === this.directive?.directorId) return false
    if (cli === 'opencode') {
      const next = this.opencodeNext(e.info, now)
      if (!next) return false
      if (next.cli !== 'opencode') { e.info.gradeFrom ??= from; e.info.fallbackAt = new Date(now).toISOString() }
      this.log(null, id, 'quota_route', { label: e.info.label, fromCli: cli, fromModel: e.info.model ?? null, toCli: next.cli, toModel: next.model ?? null, grade: next.grade, summary })
      await this.reseat(id, next.grade, `${summary}; moved to ${next.cli}${next.model ? ' ' + next.model : ''}`, { cli: next.cli, tier: next.tier, model: next.model })
      return true
    }
    if (!this.settings.quotaFallback) return false
    if (e.info.gradeFrom !== undefined && from > 0) {
      // Already demoted once and walled again: the vendor is out, not just this seat's window.
      e.info.cliFrom ??= cli
      const at = Math.max(e.info.gradeFrom, from) as Grade
      const tier = (['light', 'standard', 'heavy'] as const)[at - 1]
      this.log(null, id, 'quota_route', { label: e.info.label, fromCli: cli, toCli: 'opencode', grade: at, summary })
      await this.reseat(id, at, `${summary}; on opencode (${this.settings.opencodeGo ? 'OpenCode Go' : 'free models'}) until ${cli} works again`, { cli: 'opencode', tier, model: modelFor('opencode', tier, undefined, this.settings.opencodeGo) })
      return true
    }
    if (from === 0) return false
    const to = (from - 1) as Grade
    e.info.gradeFrom ??= from
    e.info.fallbackAt = new Date(now).toISOString()
    this.log(null, id, 'quota_fallback', { label: e.info.label, from, to, summary })
    await this.reseat(id, to, `${summary}; on ${GRADE_NAMES[to]} until it resets`)
    return true
  }

  // Where a seat that walled on OpenCode goes next: another OpenCode model on a provider that has
  // not walled, else (with the grade setting on) a paid CLI with room, one grade up from G0 or back
  // at the grade it fell from. null when nothing is left.
  private opencodeNext(info: NodeInfo, now: number): { cli: Cli; tier: Tier; model: string | undefined; grade: Grade } | null {
    const grade = (info.grade ?? 0) as Grade
    const model = opencodeModels(this.settings).find(m => (this.providerOutUntil[modelProvider(m)] ?? 0) <= now)
    if (model) return { cli: 'opencode', tier: info.tier ?? 'light', model, grade }
    if (!this.settings.quotaFallback) return null
    const cli = ([info.cliFrom, 'claude', 'codex'] as (Cli | undefined)[]).find((c): c is Cli => !!c && c !== 'opencode' && c !== 'shell' && this.installed(c) && (this.quotaOutUntil[c] ?? 0) <= now)
    if (!cli) return null
    return place(Math.max(info.gradeFrom ?? grade, 1) as Grade, cli, this.settings)
  }

  private bump(id: string | null | undefined, field: keyof RoleRecord) {
    const e = id ? this.nodes.get(id) : undefined
    if (!e) return
    e.info.record ??= emptyRecord()
    e.info.record[field]++
    this.saveOrg()
  }

  roles() {
    const t = this.directive?.treasury
    return this.list().map(n => ({
      id: n.id, label: n.label, dept: n.dept ?? null, parentId: n.parentId, cli: n.cli, model: n.model, grade: n.grade ?? null,
      charter: n.charter ?? null, persona: n.persona ?? null, lead: n.lead,
      pendingGrade: n.pendingGrade ?? null, gradeFrom: n.gradeFrom ?? null, record: n.record ?? emptyRecord(),
      spentMin: Math.round(t?.spentBy[n.id] ?? 0),
      // API-equivalent dollars from usage.json costUsd, not a bill
      spentUsd: Math.round((this.usageCache.get(n.id)?.costUsd ?? 0) * 100) / 100, state: n.state,
    }))
  }

  // CULTURE.md lives in the project's home: values, how decisions get made, what done means.
  culture(): string {
    const f = join(this.opts.home, 'CULTURE.md')
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }

  setCulture(caller: string | null, text: string, reason = '') {
    if (caller !== null && caller !== this.directive?.directorId) throw new Error('only the Director (or the human) edits CULTURE.md; propose your change to the Director')
    writeFileSync(join(this.opts.home, 'CULTURE.md'), text)
    this.log(caller, null, 'set_culture', { reason, chars: text.length })
    this.emit('culture', text)
    return true
  }

  // The Director opens a department from the project's template: a standing head that owns an area.
  async openDepartment(caller: string | null, dept: string, def?: { charter: string; persona?: string; grade?: number; gate?: { paths?: string[]; freeBuilders?: boolean } }) {
    const dir = this.directive
    if (!dir) throw new Error('no directive is running')
    if (caller !== null && caller !== dir.directorId) throw new Error('only the Director opens departments')
    let d = this.settings.departments.find(x => x.dept.toLowerCase() === dept.toLowerCase())
    if (!d) {
      if (!def) throw new Error(`no department "${dept}" in this project's settings (have: ${this.settings.departments.map(x => x.dept).join(', ')}) (or define a new one: pass charter, persona, grade and optional gate)`)
      const paths = def.gate?.paths ?? []
      if (paths.length > 20) throw new Error('a gate takes at most 20 paths')
      for (const p of paths) {
        if (p.length > 200) throw new Error('gate path is too long: ' + p.slice(0, 40))
        try { new RegExp(p, 'i') } catch { throw new Error('gate path is not a valid regex: ' + p) }
      }
      d = { dept, charter: def.charter, persona: def.persona ?? '', grade: clampGrade(def.grade ?? 2), gate: def.gate }
      this.setSettings({ departments: [...this.settings.departments, d] })
      this.log(caller, null, 'define_department', { dept, gate: !!def.gate })
    }
    const open = this.list().find(n => n.dept === d.dept)
    if (open) throw new Error(`${d.dept} already has a head: ${open.id}`)
    if (dir.benched?.[d.dept]) { delete dir.benched[d.dept]; this.saveDirective() }
    const head = this.spawn(dir.directorId, { label: d.dept, cli: this.defaultCli(), cwd: dir.workspace, lead: true, grade: d.grade, dept: d.dept, charter: d.charter, persona: d.persona })
    this.log(caller, head.id, 'open_department', { dept: d.dept, grade: head.grade })
    await this.clearStartup(head.id)
    await this.entry(head.id).term.type(roleBrief(d, head.grade ?? d.grade, this.culture()) +
      `\n\nThe org's directive: "${dir.text}"\nWorkspace: ${dir.workspace}\nCurrent goals:\n${dir.goals.map((g, i) => `- G${i + 1} ${g}${dir.goalMetrics?.[i] ? ` [metric ${dir.goalMetrics[i]!.name}: ${dir.goalMetrics[i]!.value ?? 'not measured'}]` : ''}`).join('\n') || '- (none set yet: the Director is setting them and they will be typed in here. Do not escalate to ask for goals; start reading the workspace, HOLON-LOG.md and the KB now.)'}\n\n` +
      'Start by reading the workspace, HOLON-LOG.md and the KB (kb_search) for your area. Then message the Director (id ' + dir.directorId + ') a short plan, the 1-3 things you will move first and how you will measure them, and start on them at once: do not wait for approval.')
    return this.view(head.id)
  }

  // Which departments still need to approve this branch at its current commit.
  private missingApprovals(caller: string | null, e: Entry): { depts: string[]; key: string; files: string[] } {
    const wt = e.info.worktree!
    const key = `${wt.branch}@${headCommit(wt)}`
    const patchKey = `${wt.branch}#${patchId(wt)}`
    const files = changedFiles(wt)
    const heads = new Map<string, string>([...Object.entries(this.directive?.benched ?? {}).map(([d, b]) => [d, b.id] as [string, string]), ...this.list().filter(n => n.dept).map(n => [n.dept!, n.id] as [string, string])])
    const callerDept = caller ? this.nodes.get(caller)?.info.dept : undefined
    const have = new Set([...(this.directive?.approvals?.[key] ?? []), ...(this.directive?.approvals?.[patchKey] ?? []), ...(callerDept ? [callerDept] : [])])
    // no grade (a shell seat, say) is gated like a free builder: nothing lands ungated
    const depts = gatesFor(files, e.info.grade ?? 0, this.settings.departments.filter(d => heads.has(d.dept))).filter(d => !have.has(d))
    return { depts, key, files }
  }

  approve(caller: string | null, id: string, note = '') {
    const e = this.entry(id)
    const dept = caller ? this.nodes.get(caller)?.info.dept : 'human'
    if (!dept) throw new Error('only a department head (or the human) can approve merges')
    if (!e.info.worktree) throw new Error(`"${id}" has no worktree to approve`)
    const key = `${e.info.worktree.branch}@${headCommit(e.info.worktree)}`
    const patchKey = `${e.info.worktree.branch}#${patchId(e.info.worktree)}`
    const dir = this.directive
    if (dir) {
      dir.approvals ??= {}
      const approved = [...(dir.approvals[key] ?? []), ...(dept === 'human' ? this.settings.departments.map(d => d.dept) : [dept])]
      dir.approvals[key] = [...new Set(approved)]
      dir.approvals[patchKey] = [...new Set([...(dir.approvals[patchKey] ?? []), ...approved])]
      this.saveDirective()
    }
    this.bump(caller, 'approvals')
    this.log(caller, id, 'approve', { dept, branch: e.info.worktree.branch, note })
    const parent = e.info.parentId
    const tell = (text: string) => { if (parent && parent !== caller && this.nodes.has(parent)) void this.entry(parent).term.type(text) }
    // The last gate's approval lands the branch it was already holding: nobody waits for a lead to notice.
    const pending = this.pendingMerges.get(id)
    if (pending) {
      const gate = this.missingApprovals(pending.caller, e)
      if (!gate.depts.length) {
        void this.mergeReport(pending.caller, id, pending.testCmd).then(r => tell(r.merged
          ? `[holon] All gates approved "${e.info.label}" (${id}); merged as ${r.commit}.`
          : `[holon] All gates approved "${e.info.label}" (${id}); merge was refused: ${r.reason ?? 'unknown reason'}.`)).catch(() => {})
        return { approved: key }
      }
      tell(`[holon] ${dept} approved "${e.info.label}" (${id}) at its current commit${note ? `: ${note}` : ''}. Still waiting for ${gate.depts.join(' and ')}.`)
      return { approved: key }
    }
    tell(`[holon] ${dept} approved "${e.info.label}" (${id}) at its current commit${note ? `: ${note}` : ''}. Run merge_report again.`)
    return { approved: key }
  }

  reject(caller: string | null, id: string, reason: string) {
    const e = this.entry(id)
    const dept = caller ? this.nodes.get(caller)?.info.dept : 'human'
    if (!dept) throw new Error('only a department head (or the human) can reject merges')
    this.pendingMerges.delete(id)
    this.bump(id, 'rejections')
    this.log(caller, id, 'reject', { dept, reason })
    if (e.info.parentId && e.info.parentId !== caller && this.nodes.has(e.info.parentId)) {
      void this.entry(e.info.parentId).term.type(`[holon] ${dept} rejected "${e.info.label}" (${id}): ${reason}\nFix it in the worktree, commit, and merge_report again.`)
    }
    return { rejected: true }
  }

  // ── digest: what's going on, in plain English, for the human ────────────

  // Run by the daemon every 10 minutes (and on demand): only when something happened since the last one.
  async refreshDigest(now = Date.now(), force = false, summarizer: (input: string) => Promise<string | null> = summarize) {
    const dir = this.directive
    if (!dir || dir.status === 'dead') return null
    const since = dir.digest ? Date.parse(dir.digest.ts) : Date.parse(dir.startedAt)
    const sinceMin = Math.max(1, Math.round((now - since) / 60_000))
    const quiet = new Set(['read_screen', 'wait', 'wait_done', 'press', 'type', 'restore', 'heartbeat'])
    const fresh = this.recent.filter(a => Date.parse(a.ts) > since && !quiet.has(a.action))
    if (!force && !fresh.length) return dir.digest ?? null
    const name = (id: string | null) => (id === null ? 'the owner' : this.nodes.get(id)?.info.label ?? id)
    const input = redact(digestPrompt({
      directive: dir.text, goals: dir.goals,
      roles: this.list().map(n => ({ label: n.label, dept: n.dept, grade: n.grade, state: n.state, status: n.status })),
      actions: (fresh.length ? fresh : this.recent.slice(-30)).map(a => ({
        ts: a.ts, who: name(a.caller) + (a.target && a.target !== a.caller ? ` -> ${name(a.target)}` : ''), action: a.action,
        detail: JSON.stringify(a.args).slice(0, 220),
      })),
      asksWaiting: this.listEscalations().filter(e => e.to === null && e.status === 'open').map(e => e.message.slice(0, 160)),
    }, sinceMin))
    const text = await summarizer(input)
    if (!text) return dir.digest ?? null
    dir.digest = { ts: new Date(now).toISOString(), text }
    this.saveDirective()
    return dir.digest
  }

  // ── self-healing watcher: run by the daemon every couple of minutes ────

  private healedAt = new Map<string, number>()   // `${id}:${issue}` → last time acted
  private classifiedAt = new Map<string, number>()
  private hookSince = new Map<string, number>()      // id → when its "running ... hook" line was first seen
  private promptSince = new Map<string, number>()    // id → when its permission prompt was first seen
  private hookHangs = new Map<string, number[]>()    // id → times we interrupted it for a hung hook
  private promptToldHuman = new Map<string, number>() // id → when the human was last told about its lead-less prompt (cleared when the prompt is answered)

  async heal(now = Date.now(), useModel = true): Promise<{ id: string; finding: Finding }[]> {
    const acted: { id: string; finding: Finding }[] = []
    // OmniRoute's gateway is local: while it refuses connections every G0 seat placed on it dies.
    if (this.settings.freePools.omniroute) {
      const up = await this.gatewayUp('127.0.0.1', 20128)
      if (up) delete this.providerOutUntil.omniroute
      else this.providerOutUntil.omniroute = now + 2 * 60_000
      if (!up && this.omnirouteUp) this.log(null, null, 'gateway_down', { host: '127.0.0.1', port: 20128 })
      this.omnirouteUp = up
    }
    for (const [id, e] of [...this.nodes]) {   // a snapshot: falling back reseats terminals
      if (this.nodes.get(id) !== e) continue
      const screen = e.term.readScreen().text
      // The same hook line on two passes minutes apart: hooks take milliseconds, so this one is hung.
      if (hookHang(screen)) { if (!this.hookSince.has(id)) this.hookSince.set(id, now) } else this.hookSince.delete(id)
      if (promptOn(screen)) { if (!this.promptSince.has(id)) this.promptSince.set(id, now) }
      else if (this.promptSince.delete(id)) { this.healedAt.delete(`${id}:stuck-prompt`); this.promptToldHuman.delete(id) }   // answered: the next prompt is new
      const seen = {
        label: e.info.label, cli: e.info.cli, screen, quietMs: e.term.quietForMs(now),
        exitCode: e.term.exitCode, hasLead: e.info.parentId !== null,
        promptForMs: this.promptSince.has(id) ? now - this.promptSince.get(id)! : undefined,
        hookForMs: this.hookSince.has(id) ? now - this.hookSince.get(id)! : undefined,
      }
      let finding = diagnose(seen)
      let evidence: string | undefined
      if (finding?.issue === 'hook-hang') {
        this.hookSince.delete(id)
        const hangs = [...(this.hookHangs.get(id) ?? []).filter(t => now - t < 60 * 60_000), now]
        this.hookHangs.set(id, hangs)
        evidence = hookHang(screen)?.line
        if (hangs.length >= 3) finding = { ...finding, notify: `${e.info.label}'s hooks have hung ${hangs.length} times in the last hour (${evidence}); each time I interrupted it. A hook that never returns is a problem in the owner's hook config (~/.claude/settings.json or ~/.holon/claude-settings.json), not in the seat.` }
      }
      // Flagged apart from findings: a credential search never counts toward 'stuck'.
      const hunt = credentialHunt(seen.screen)
      if (hunt && now - (this.healedAt.get(`${id}:credential-hunt`) ?? 0) > 20 * 60_000) {
        this.healedAt.set(`${id}:credential-hunt`, now)
        this.log(null, id, 'credential-hunt', { label: e.info.label, command: hunt })
        const to = e.info.parentId && this.nodes.has(e.info.parentId) ? e.info.parentId : null
        if (to) void this.entry(to).term.type(`[holon watcher] ${e.info.label} ran a broad credential search (${hunt}). Credentials come only from files the human or your brief names. Check why.`)
      }
      // A walled seat is reported once and then left alone until its pool is due back: a screen that
      // scrolls past the wall message or a model re-classifying it must not clear or repeat the report.
      const walled = !!e.info.blocked && (e.info.blockedUntil ?? 0) > now
      if (e.info.blocked && !walled && finding?.issue !== 'quota') { delete e.info.blocked; delete e.info.blockedUntil; this.saveOrg() }
      if (walled && (!finding || finding.issue === 'quota')) continue
      if (!finding && useModel && suspicious(seen) && now - (this.classifiedAt.get(id) ?? 0) > 30 * 60_000) {
        this.classifiedAt.set(id, now)
        finding = await classify(seen)
        // Verbatim evidence for a future rule: what the model saw when no rule matched.
        if (finding) evidence = redact(seen.screen.split('\n').slice(-12).join('\n')).slice(-1500)
      }
      // The awaits above (and the key presses below) give a lead time to close this seat.
      if (!finding || this.nodes.get(id) !== e) continue
      // The classifier names it its own way ("model:go-usage-limit"); a wall is a wall.
      if (/^model:.*(usage|quota|rate)-?limit|^model:.*quota/.test(finding.issue)) finding = { ...finding, issue: 'quota', summary: `${e.info.label} is out of model quota` }
      const key = `${id}:${finding.issue}`
      const cooldown = finding.issue === 'crashed' ? 24 * 60 * 60_000 : finding.issue === 'hook-hang' || finding.issue === 'stuck-prompt' ? 5 * 60_000 : 20 * 60_000
      if (now - (this.healedAt.get(key) ?? 0) < cooldown) continue
      this.healedAt.set(key, now)
      let quotaUntil = 0
      if (finding.issue === 'quota') {
        quotaUntil = Math.max(this.quotaOutUntil[e.info.cli] ?? 0, await this.resetOf(e.info.cli, now))
        if (this.nodes.get(id) !== e) continue
        if (e.info.cli === 'opencode') this.providerOutUntil[modelProvider(e.info.model)] = Math.max(this.providerOutUntil[modelProvider(e.info.model)] ?? 0, quotaUntil)
        if ((e.info.cli === 'opencode' && !this.opencodeNext(e.info, now)) || e.info.cli === 'shell' || (e.info.cli !== 'opencode' && !this.settings.quotaFallback)) {
          // Nowhere to drop to: say so once, with the time the pool is due back.
          finding = { ...finding, notify: `${e.info.label} (${e.info.cli}) has hit its usage limit and can't work until it resets (not due back until ${new Date(quotaUntil).toISOString()}). It has no lower grade to fall back to: kill it or reassign its task to a pool that is in quota. I won't repeat this until then.` }
        }
      }
      for (const k of finding.press ?? []) { e.term.press(k); await new Promise(r => setTimeout(r, 300)) }
      if (finding.type) await e.term.type(finding.type)
      if (this.nodes.get(id) !== e) continue
      if (finding.notify) {
        const to = e.info.parentId && this.nodes.has(e.info.parentId) ? e.info.parentId : null
        if (to) void this.entry(to).term.type(`${finding.issue === 'stuck-prompt' ? '[holon]' : '[holon watcher]'} ${finding.notify}`)
        else {
          if (this.directive) this.directive.updates = [...(this.directive.updates ?? []).slice(-49), { ts: new Date(now).toISOString(), by: 'Watcher', text: finding.summary }]
          // Nobody above this seat reads a typed line, and updates go unread: a prompt on a lead-less seat
          // stops its whole org, so tell the person. Once per prompt, once more if it is still up after 30 min.
          if (finding.issue === 'stuck-prompt') {
            const told = this.promptToldHuman.get(id)
            if (told === undefined || now - told >= 30 * 60_000) {
              this.promptToldHuman.set(id, now)
              const mins = Math.round((seen.promptForMs ?? 0) / 60_000)
              const wait = mins >= 1 ? `${mins} min` : `${Math.round((seen.promptForMs ?? 0) / 1000)} s`
              const text = `${e.info.label} has waited ${wait} at a permission prompt and the org is stopped until you answer it.\n${redact(promptOn(screen) ?? '')}`
              this.log(null, id, 'stuck_prompt', { label: e.info.label, waitedMs: seen.promptForMs ?? 0, text })
            }
          }
        }
      }
      if (finding.issue === 'quota') {
        // The whole pool is out, not just this terminal: new spawns on that vendor wait
        // for the free pool until the retry window passes. A fallback keeps the same CLI,
        // so it would land on the dead pool again.
        const walled = e.info.cli
        // An OpenCode seat that can move to another provider leaves the pool open: only that provider walled.
        if (walled !== 'opencode' || this.opencodeNext(e.info, now)?.cli !== 'opencode') this.quotaOutUntil[walled] = Math.max(this.quotaOutUntil[walled] ?? 0, quotaUntil)
        if (this.nodes.get(id) !== e) continue
        if (await this.fallBack(id, finding.summary, now)) {
          if (walled === 'opencode') this.healedAt.delete(key)   // the next model may wall too: that is a new wall, not a repeat
          this.log(null, id, 'heal', { label: e.info.label, issue: finding.issue, summary: finding.summary, pressed: [] })
          acted.push({ id, finding })
          if (this.pauseIfPoolsOut(now)) break
          continue
        }
      }
      if (finding.issue !== 'quota' && finding.issue !== 'api-dropped' && finding.issue !== 'hook-hang') this.bump(id, 'stuck')
      if (finding.issue === 'quota') {
        e.info.blocked = finding.summary
        e.info.blockedUntil = quotaUntil
        this.saveOrg()
        // In a ring, a blocked peer's work goes back on the board and the others are told to cover it.
        if (this.directive?.shape === 'holon' && e.info.parentId === null) {
          for (const t of this.directive.tasks ?? []) if (t.status === 'claimed' && t.owner === e.info.label) { t.status = 'open'; delete t.owner }
          for (const m of this.directive.council?.members ?? []) {
            if (m !== id && this.nodes.has(m) && !this.entry(m).info.blocked) void this.entry(m).term.type(`[holon] ${e.info.label} is out of model quota and can't work until it resets. Its tasks are back on the board; pick up what it would have done (board_list).`)
          }
          this.saveDirective()
        }
      }
      this.log(null, id, 'heal', { label: e.info.label, issue: finding.issue, summary: finding.summary, pressed: finding.press ?? [], ...(evidence ? { screen: evidence } : {}) })
      this.kb?.write('lesson', `Watcher: ${finding.issue}`, `Last seen ${new Date(now).toISOString().slice(0, 16)} on ${e.info.label} (${e.info.cli}).\n\n${finding.summary}`, 'watcher')
      acted.push({ id, finding })
      if (finding.issue === 'quota' && this.pauseIfPoolsOut(now)) break
    }
    if (acted.length) this.saveDirective()
    return acted
  }

  // ── self-optimizing: a periodic scorecard and a reorg through the council ─

  private lastReview = Date.now()

  // Per-team numbers: what each subtree spent, shipped and finished, and how long it's been idle.
  scorecard(now = Date.now()) {
    const t = this.directive?.treasury
    const subtree = (id: string): string[] => [id, ...this.list().filter(n => n.parentId === id).flatMap(n => subtree(n.id))]
    return this.list().filter(n => n.parentId === null || n.lead).map(n => {
      const ids = new Set(subtree(n.id))
      const acts = this.recent.filter(a => (a.caller && ids.has(a.caller)) || (a.target && ids.has(a.target)))
      return {
        team: n.label, id: n.id, cli: n.cli, members: ids.size,
        spentMin: Math.round([...ids].reduce((s, i) => s + (t?.spentBy[i] ?? 0), 0)),
        merges: acts.filter(a => a.action === 'merged').length,
        tasksDone: acts.filter(a => a.action === 'board_done').length,
        idleMin: Math.round(Math.min(...[...ids].map(i => this.entry(i).term.quietForMs(now))) / 60_000),
      }
    })
  }

  // Asks the Director to review the org's shape every reviewMin, or sooner once it's all idle.
  review(now = Date.now(), reviewMin = 120, force = false) {
    const dir = this.directive
    if (!dir || dir.status === 'dead' || !this.nodes.has(dir.directorId)) return false
    const allIdle = this.list().every(n => n.state !== 'running') && this.list().every(n => this.entry(n.id).term.quietForMs(now) > 30 * 60_000)
    if (!force && now - this.lastReview < reviewMin * 60_000 && !(allIdle && now - this.lastReview > 30 * 60_000)) return false
    // Nothing merged since the last review: the scorecard can't have changed much. Once a day is enough.
    // The Director's complete is not shipping: it closes every round, the review's own included.
    const since = new Date(this.lastReview).toISOString()
    if (!force && now - this.lastReview < 24 * 60 * 60_000 && !this.recent.some(a => a.ts > since && SHIPPED.has(a.action) && a.action !== 'complete')) return false
    this.lastReview = now
    const rows = this.scorecard(now).map(r => `- ${r.team} (${r.cli}, ${r.members} terminals): spent ${r.spentMin} min, ${r.merges} merges, ${r.tasksDone} tasks done, idle ${r.idleMin} min`)
    const via = dir.council ? 'Put the reorg to the council with propose, then carry out what passes' : 'Then carry it out'
    const roles = this.roles().map(r => `- ${r.label}${r.dept ? ` [${r.dept}]` : ''} ${r.grade === null ? '' : GRADE_NAMES[r.grade as Grade]}: ` +
      `${r.record.merges} merges, ${r.record.tasksDone} tasks, ${r.record.rejections} rejected, ${r.record.stuck} stuck, ${r.spentMin} runway min`)
    const opencode = this.quotaOutUntil.opencode ?? 0, claude = this.quotaOutUntil.claude ?? 0, codex = this.quotaOutUntil.codex ?? 0
    let staffing = 'Put unblocked work that does not need Claude (research, prospect lists, content, tests, reviews) on free cli opencode builders, which cost no runway. '
    if (!this.installed('opencode')) {
      staffing = 'OpenCode is not installed, so there are no free builders: spawning G0 already routes to the cheapest installed paid pool at G1. The review must staff at least one bounded task from an unblocked goal now, or name for each goal why it cannot move. '
    } else if (opencode > now) {
      const pool = claude <= now ? 'claude' : codex <= now ? 'codex' : null
      staffing = pool
        ? `OpenCode is out until ${new Date(opencode).toISOString()}; spawning G0 already routes to the cheapest available paid pool (${pool}) at G1. The review must staff at least one bounded task from an unblocked goal now, or name for each goal why it cannot move. `
        : `Every model pool is out; hold until the earliest reset at ${new Date(Math.min(opencode, claude, codex)).toISOString()} rather than spawn. `
    }
    void this.entry(dir.directorId).term.type(`[holon] Org review. Scorecard per team:\n${rows.join('\n')}\nEvery role, its grade and record:\n${roles.join('\n')}\n` +
      'Promote roles that ship and demote ones that spend without shipping (set_grade, with the reason from their record); move execution to G0 builders wherever it fits. ' +
      'Is this the right shape for the next most valuable work? Look for duplicated work, teams that spend without shipping, ' +
      'idle terminals, and work that is blocked. Decide the leanest org that moves the goals: kill or merge teams, reassign work. ' + staffing +
      `Spawn only what is needed (leads with builders under them, not a flat list). ${via}, record the new shape with kb_write, and post a one-line update_human.`)
    this.log(null, dir.directorId, 'org_review', { teams: rows.length })
    return true
  }

  // ── needle review: once a day, a read-only reviewer from another model family ──

  private needle: { id: string; startedAt: number } | null = null
  private needleBase = Date.now()   // when this daemon started: the first review is due 15 minutes later
  needleTimeoutMs = 45 * 60_000

  // The other family: claude <-> codex, then opencode when that one is missing or out of quota.
  // With only one installed family, use an independent seat on that CLI.
  needleCli(directorCli: Cli, now = Date.now()): Cli | null {
    const usable = (c: Cli) => this.installed(c) && (this.quotaOutUntil[c] ?? 0) <= now
    const order: Cli[] = directorCli === 'claude' ? ['codex', 'opencode'] : directorCli === 'codex' ? ['claude', 'opencode'] : ['claude', 'codex']
    return order.find(c => usable(c)) ?? (order.every(c => !this.installed(c)) && usable(directorCli) ? directorCli : null)
  }

  private needleDue(now: number) {
    const last = Date.parse(this.directive?.lastNeedleAt ?? '')
    const at = this.settings.needleReviewAt
    // Daemons restart several times a day, so a first review must not wait a full day from the start.
    if (!at) return Number.isNaN(last) ? now - this.needleBase >= 15 * 60_000 : now - last >= 24 * 60 * 60_000
    const [hh, mm] = at.split(':').map(Number), d = new Date(now)
    const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).getTime()
    return now >= slot && (Number.isNaN(last) || last < slot)
  }

  // Run by the daemon every minute. Starts the daily review when it is due, and closes a reviewer
  // that died or ran out of time. Returns the reviewer's id when one was started.
  async needleReview(now = Date.now(), force = false): Promise<string | null> {
    const dir = this.directive
    if (this.needle) {
      const e = this.nodes.get(this.needle.id)
      if (!e || e.term.exitCode !== null || now - this.needle.startedAt > this.needleTimeoutMs) {
        this.closeNeedle(e ? 'no report before it ended or timed out' : 'the reviewer was closed before it reported')
      }
      return null
    }
    if (!dir || dir.status === 'dead' || this.paused || !this.nodes.has(dir.directorId)) return null
    // A reviewer restored after a daemon restart has lost its conversation and nothing tracks it:
    // close it, and let the review run again.
    for (const o of this.list().filter(n => n.label === 'Needle Review' && n.parentId === dir.directorId)) {
      this.kill(o.id)
      delete dir.lastNeedleAt
      this.saveDirective()
      this.log(null, o.id, 'needle_review', { failed: 'orphaned by a daemon restart; closed' })
    }
    if (!force && (!this.settings.needleReview || !this.needleDue(now))) return null
    dir.lastNeedleAt = new Date(now).toISOString()
    this.saveDirective()
    const since = new Date(now - 24 * 60 * 60_000).toISOString()
    const logs = landedLog(this.opts.home, dir.workspace, since, new Date(now).toISOString())
    if (!logs.length) { this.log(null, dir.directorId, 'needle_review', { skipped: 'no commits landed in the last 24h' }); return null }
    const director = this.entry(dir.directorId).info
    // The log goes to a file: typing tens of thousands of characters into a TUI gets cut off.
    const logFile = join(this.opts.home, 'needle', `${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.log`)
    mkdirSync(dirname(logFile), { recursive: true })
    writeFileSync(logFile, logs.map(l => `== ${l.repo} @ ${l.ref} (${l.count} commits) ==\n${l.log}`).join('\n\n') + '\n')
    const summary = logs.map(l => `- ${l.repo} @ ${l.ref}: ${l.count} commit${l.count === 1 ? '' : 's'}`).join('\n')
    const cli = this.needleCli(director.cli, now)
    if (!cli) { this.log(null, dir.directorId, 'needle_review', { skipped: `no other model family available (Director is on ${director.cli})` }); return null }
    const reviewer = this.create({ label: 'Needle Review', cli, cwd: dir.workspace, parentId: dir.directorId, lead: true, readOnly: true, tier: cli === 'opencode' ? 'standard' : 'heavy' })
    this.needle = { id: reviewer.id, startedAt: now }
    this.log(null, reviewer.id, 'needle_review', { started: true, cli, model: reviewer.model, director: director.cli })
    try {
      await this.clearStartup(reviewer.id)
      await this.entry(reviewer.id).term.type(
        `You are the daily needle reviewer (${cli}) for an org whose Director (${director.label}, id ${dir.directorId}) runs on ${director.cli}. ` +
        'You are read-only: do not edit files, commit, push, merge or run anything that changes state. You may read code and diffs (git show, git diff).\n\n' +
        `Directive: ${dir.text.slice(0, 600)}\nWorkspace: ${dir.workspace}\n\n` +
        `Start from the numbers, not the commits. Goals and their metrics (value, when it last changed, how long it has been flat, recent history):\n${this.needleGoalBrief(now)}\n\n` +
        `Commits landed on the org's base branch in the last 24h:\n${summary}\nThe full git log with stats is in ${logFile}; read it after the numbers, then read the diffs you need.\n\n` +
        `Then send ONE message to the Director (message tool, to "${dir.directorId}") with four parts: ` +
        '1) for each flat number, the bottleneck, and whether any landed commit could plausibly move it (read the diff before you say yes); also say which metrics count the org\'s own work (commits, tests, entities, log freshness) rather than an outcome, and propose an outcome number (something a user, customer or market did) for that goal; ' +
        '2) the commits that moved nothing, by hash; ' +
        '3) the 1-3 changes most likely to move a number this week, each naming which number and who has to act (the org or the owner); ' +
        '4) any real bugs you found, each as file:line with what breaks (read the diff before you claim one). ' +
        'Sending that message ends your job: you are closed right after.')
    } catch (err) {
      this.closeNeedle(`could not brief the reviewer: ${(err as Error).message}`)
    }
    return reviewer.id
  }

  // Per goal: metric, current value, changedAt, how long it has been flat, and the last few history rows.
  private needleGoalBrief(now: number): string {
    const dir = this.directive!
    let rows: { at: string; name: string; value: number }[] = []
    try {
      rows = readFileSync(join(this.opts.home, 'goal-history.jsonl'), 'utf8').split('\n').filter(Boolean)
        .flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
    } catch { /* no history yet */ }
    return dir.goals.slice(0, 10).map((g, i) => {
      const head = `- G${i + 1} ${g.slice(0, 300)}`
      const m = dir.goalMetrics?.[i]
      if (!m) return `${head}\n  metric: none`
      const flat = m.changedAt ? `flat for ${flatFor(now - Date.parse(m.changedAt))}` : 'flat duration unknown'
      const hist = rows.filter(r => r.name === m.name).slice(-4).map(r => `${r.at} ${r.value}`).join('; ') || 'none'
      return `${head}\n  metric: ${m.name} = ${m.value ?? '?'}; changedAt ${m.changedAt ?? 'never'}; ${flat}\n  last changes: ${hist}`
    }).join('\n') || '- (none set)'
  }

  private closeNeedle(reason: string, result?: string) {
    const n = this.needle
    if (!n) return
    this.needle = null
    if (this.nodes.has(n.id)) this.kill(n.id)
    this.log(null, n.id, 'needle_review', result === undefined ? { failed: reason } : { result: result.slice(0, 4000) })
  }

  // ── autoscale and audit: run by the daemon every minute ────────────────

  // Retires helpers (non-leads with a parent) that have been idle past the limit.
  autoscale(now = Date.now()) {
    if (!this.directive) return []
    const limit = this.directive.autoscaleMin ?? 20
    const retired: string[] = []
    for (const n of this.list()) {
      if (n.lead || n.parentId === null || n.state === 'running') continue
      if (this.entry(n.id).term.quietForMs(now) < limit * 60_000) continue
      // A builder holding work the base branch does not have yet keeps its seat.
      if (n.worktree && hasUnmergedWork(n.worktree)) continue
      // A seat waiting on its own background shell (Claude shows "1 shell" in its footer) is not idle.
      if (/\b\d+ (?:background )?shells?\b/.test(this.entry(n.id).term.readScreen().text.split('\n').slice(-6).join('\n'))) continue
      this.kill(n.id)
      retired.push(n.id)
      this.log(null, n.id, 'retired', { label: n.label, idleMin: limit })
      if (this.nodes.has(n.parentId)) void this.entry(n.parentId).term.type(`[holon] Retired your idle helper "${n.label}" (${n.id}) after ${limit} quiet minutes. Its branch is kept; spawn again if you need it.`)
    }
    return retired
  }

  // ── on-call heads and compaction: long-lived seats stay short ──────────

  // A department head with nothing to do is closed instead of kept open: every turn re-reads its
  // whole conversation. The department stays. A review gate, a message to the head's old id or
  // its department's name, or open_department wakes a fresh head briefed from the KB.
  bench(now = Date.now()) {
    const dir = this.directive
    const limit = this.settings.headIdleMin
    if (!dir || !limit) return []
    const benched: string[] = []
    for (const n of this.list()) {
      if (!n.dept || n.id === dir.directorId || n.id === dir.auditorId || n.state === 'running') continue
      if (this.entry(n.id).term.quietForMs(now) < limit * 60_000) continue
      if (this.listReports(n.id).length) continue
      if (n.worktree && hasUnmergedWork(n.worktree)) continue
      // What the next head picks up from: the closed one's last status and its conversation.
      const info = this.entry(n.id).info
      dir.benched = { ...(dir.benched ?? {}), [n.dept]: { id: n.id, at: new Date(now).toISOString(), status: n.status, transcript: transcriptFor(info.cli, info.cwd, info.sessionId) } }
      this.log(null, n.id, 'benched', { label: n.label, dept: n.dept, idleMin: limit })
      this.kill(n.id)
      benched.push(n.id)
    }
    if (benched.length) this.saveDirective()
    return benched
  }

  // The live head for an id or a department name, waking a benched one. Undefined when `to`
  // names neither a benched head nor a department.
  private async headFor(to: string, why: string): Promise<string | undefined> {
    if (this.nodes.has(to)) return to
    const dept = Object.entries(this.directive?.benched ?? {}).find(([d, b]) => b.id === to || d.toLowerCase() === to.toLowerCase())?.[0]
      ?? this.settings.departments.find(d => d.dept.toLowerCase() === to.toLowerCase())?.dept
    if (!dept) return undefined
    const open = this.list().find(n => n.dept === dept)
    if (open) return open.id
    if (!this.directive?.benched?.[dept]) return undefined
    return (await this.wakeHead(dept, why)).id
  }

  private async wakeHead(dept: string, why: string) {
    const dir = this.directive!
    const d = this.settings.departments.find(x => x.dept === dept)
    if (!d) throw new Error(`no department "${dept}"`)
    const prev = dir.benched?.[dept]
    delete dir.benched?.[dept]
    const head = this.spawn(dir.directorId, { label: d.dept, cli: this.defaultCli(), cwd: dir.workspace, lead: true, grade: d.grade, dept: d.dept, charter: d.charter, persona: d.persona })
    this.log(null, head.id, 'wake_head', { dept, why })
    this.saveDirective()
    await this.clearStartup(head.id)
    await this.entry(head.id).term.type(roleBrief(d, head.grade ?? d.grade, this.culture()) +
      `\n\nThe org's directive: "${dir.text}"\nWorkspace: ${dir.workspace}\n\nYou are on call: you were woken for ${why}, and that comes first. ` +
      (prev?.status ? `The head before you was closed while idle; its last status: "${prev.status}"${prev.transcript ? ` (its conversation: ${prev.transcript}; read the tail only if your task continues that work)` : ''}. ` : '') +
      'Read only what it needs (kb_search your area for history). Write anything the next head should know to the KB. ' +
      'When nothing is left, stop: an idle head is closed and a fresh one is woken when it is needed.')
    return head
  }

  // A Claude seat whose conversation has grown past compactAtK is compacted while it is quiet.
  // Not in the first minutes after a daemon start: restore types a resume message into each seat then.
  private compactedAt = new Map<string, number>()
  private bootAt = Date.now()
  private interruptedAt = new Map<string, number>()
  private resumeAfterCompact = new Map<string, number>()   // seats we interrupted, then compacted: their turn is typed back in
  compact(now = Date.now()) {
    const limit = this.settings.compactAtK * 1000
    if (!limit || now - this.bootAt < 10 * 60_000) return []
    const done: string[] = []
    for (const n of this.list()) {
      if (n.cli !== 'claude') continue
      const e = this.entry(n.id)
      const file = transcriptFor('claude', e.info.cwd, e.info.sessionId)
      const { context, atPrompt, compacted } = file ? claudeTail(file) : { context: 0, atPrompt: false, compacted: false }
      // An interrupt cut the seat's turn off; once /compact has finished, tell it to carry on.
      const since = this.resumeAfterCompact.get(n.id)
      if (since !== undefined) {
        if (now - since > 30 * 60_000) this.resumeAfterCompact.delete(n.id)
        else if (compacted && e.term.quietForMs(now) >= 20_000 && !promptOn(e.term.readScreen().text)) {
          this.resumeAfterCompact.delete(n.id)
          this.log(null, n.id, 'resume_after_compact', { label: n.label })
          void e.term.type('continue')
        }
      }
      if (now - (this.compactedAt.get(n.id) ?? 0) < 30 * 60_000) continue
      if (context < limit) continue
      // A seat that chains tool calls rarely reaches its prompt (the three biggest seats of 2026-11-02 ended
      // 3 of 593, 13 of 544 and 10 of 415 turns past 150k with end_turn), so the checks below almost never
      // pass for it. Past four thirds of the limit (200k at the default), every call re-reads the lot: interrupt
      // the turn whatever its state, and the next pass compacts it at the prompt. Again after 30 minutes if it
      // ran on without compacting.
      if (!atPrompt && context >= (4 / 3) * limit && now - (this.interruptedAt.get(n.id) ?? 0) >= 30 * 60_000) {
        this.interruptedAt.set(n.id, now)
        this.log(null, n.id, 'interrupt_to_compact', { label: n.label, contextK: Math.round(context / 1000) })
        e.term.press('Escape')
        continue
      }
      // At a transcript-confirmed prompt (end_turn, or an interrupt) 30 s of quiet is enough. Two minutes almost
      // never held: the next message arrives within 14 s for half the Judges lead's turn ends.
      if (n.state === 'running' || e.term.quietForMs(now) < 30_000) continue
      if (!atPrompt || promptOn(e.term.readScreen().text)) continue
      if (this.interruptedAt.delete(n.id)) this.resumeAfterCompact.set(n.id, now)
      this.compactedAt.set(n.id, now)
      this.log(null, n.id, 'compact', { label: n.label, contextK: Math.round(context / 1000) })
      void e.term.type('/compact Keep: your role, the directive and goals, your current task and where it stands, the ids of your reports and who you are waiting on, open commitments, and decisions with their reasons. Drop tool output and screens already acted on.')
      done.push(n.id)
    }
    return done
  }

  // Sends the auditor the org's claims since the last round, at most every auditMin.
  audit(now = Date.now(), auditMin = 30) {
    const dir = this.directive
    if (!dir?.auditorId || !this.nodes.has(dir.auditorId) || dir.status === 'dead') return false
    const since = dir.lastAuditAt ?? dir.startedAt
    if (now - Date.parse(since) < auditMin * 60_000) return false
    const CLAIMS = new Set(['update', 'complete', 'deliver', 'merged', 'board_done', 'set_goals', 'proposal_passed'])
    const claims = this.recent.filter(a => CLAIMS.has(a.action) && a.ts >= since)
    if (!claims.length) return false
    dir.lastAuditAt = new Date(now).toISOString()
    this.saveDirective()
    const lines = claims.map(a => `- ${a.ts.slice(11, 16)} ${a.caller ? this.nodes.get(a.caller)?.info.label ?? a.caller : 'human'} ${a.action}: ${JSON.stringify(a.args).slice(0, 220)}`)
    const title = `Audit ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}`
    void this.entry(dir.auditorId).term.type(`[holon] Audit round. Claims since ${since.slice(0, 16).replace('T', ' ')}:\n${lines.join('\n')}\n` +
      `Check each claim against the evidence in ${dir.workspace} (git log, files, run the tests). Then call kb_write with kind "fact" and title ` +
      `"${title}", listing each claim as VERIFIED, FALSE or UNVERIFIABLE with its evidence. board_post a task for anything FALSE. Do nothing else.`)
    this.log(null, dir.auditorId, 'audit_round', { claims: claims.length })
    return true
  }

  getDirective(): Directive | null {
    return this.directive
  }

  setGoals(caller: string | null, input: GoalInput[], proposalId?: string) {
    if (!this.directive) throw new Error('no directive is running')
    // The auditor and a co-director are top-level seats too, but neither sets goals.
    this.topOnly(caller, 'set goals; propose them to your lead instead')
    this.requirePassed(caller, proposalId, 'set goals')
    const goals = input.map(g => typeof g === 'string' ? g : g.text)
    const prevM = this.directive.goalMetrics ?? []
    const metrics = input.map((g, i): GoalMetric | null => {
      const m = typeof g === 'string' ? undefined : g.metric
      if (!m?.name?.trim() || !m.cmd?.trim()) return null
      // The same metric on the same slot keeps its readings.
      const old = prevM[i]
      const kind = m.kind === 'output' || m.kind === 'outcome' ? m.kind : undefined
      // A copy, not the stored object: the change check below must still see a kind-only edit.
      if (old && old.name === m.name && old.cmd === m.cmd) { const { kind: _, ...rest } = old; return { ...rest, ...(kind ? { kind } : {}) } }
      return { name: m.name.trim(), cmd: m.cmd, ...(kind ? { kind } : {}) }
    })
    const hasMetrics = metrics.some(Boolean)
    if (JSON.stringify(this.directive.goals) === JSON.stringify(goals) &&
      JSON.stringify((this.directive.goalMetrics ?? []).map(m => m && [m.name, m.cmd, m.kind])) === JSON.stringify(hasMetrics ? metrics.map(m => m && [m.name, m.cmd, m.kind]) : [])) return
    this.directive.goals = goals
    if (hasMetrics) this.directive.goalMetrics = metrics; else delete this.directive.goalMetrics
    // New goals reopen a finished directive, the same as asking the Director something.
    if (this.directive.status === 'complete') { this.directive.status = 'running'; delete this.directive.completedAt }
    this.log(caller, null, 'set_goals', { goals, ...(hasMetrics ? { metrics: metrics.map(m => m && `${m.name}: ${m.cmd}`) } : {}) })
    this.saveDirective()
    const lines = goals.map((g, i) => `- G${i + 1} ${g}${metrics[i] ? ` [metric ${metrics[i]!.name}]` : ' [no metric yet: give it one with set_goals]'}`)
    for (const n of this.list()) {
      if (n.dept && n.state !== 'exited') {
        void this.entry(n.id).term.type('[holon] Goals are set:\n' + lines.join('\n') + '\nMap your plan onto them.').catch(() => {})
      }
    }
    if (hasMetrics) void this.measureGoals(Date.now(), true)
  }

  // Runs each goal's metric command in the workspace and stores the reading. A failure is
  // recorded on the goal, never thrown. Unforced, a metric is re-read at most every 30 minutes.
  async measureGoals(now = Date.now(), force = false) {
    const dir = this.directive
    const ms = dir?.goalMetrics
    if (!dir || !ms?.some(Boolean) || dir.status === 'dead') return
    const shell = process.env.SHELL || '/bin/zsh'
    await Promise.all(ms.map(async m => {
      if (!m || (!force && m.at && now - Date.parse(m.at) < 30 * 60_000)) return
      try {
        const out = await new Promise<string>((resolve, reject) =>
          execFile(shell, ['-lc', m.cmd], { cwd: dir.workspace, timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout) => err ? reject(err) : resolve(stdout)))
        const nums = out.match(/-?\d+(?:\.\d+)?/g)
        if (!nums) throw new Error(`printed no number: ${JSON.stringify(out.trim().slice(-80))}`)
        const v = Number(nums.at(-1))
        if (v !== m.value || !m.changedAt) {
          m.changedAt = new Date(now).toISOString()
          try { appendFileSync(join(this.opts.home, 'goal-history.jsonl'), JSON.stringify({ at: m.changedAt, name: m.name, value: v, ...(m.kind === 'output' ? { kind: 'output' } : {}) }) + '\n') } catch { /* history is best effort */ }
        }
        m.value = v; delete m.error
      } catch (err) {
        m.error = (err as Error).message.slice(0, 200)
      }
      m.at = new Date(now).toISOString()
    }))
    this.saveDirective()
  }

  // One line per goal for the heartbeat, then marks the readings as seen so the next beat's change is measured from here.
  private goalLines(now = Date.now()): string {
    const dir = this.directive!
    const ms = dir.goalMetrics ?? []
    const lines = dir.goals.map((g, i) => {
      const m = ms[i]
      if (!m) return `G${i + 1} has no metric: give it one with set_goals (a name and a command that prints the number). Goal: ${g}`
      const d = m.value === undefined ? undefined : m.value - (m.beatValue ?? m.value)
      const change = d === undefined ? 'not measured yet' : d === 0 ? 'no change' : `${d > 0 ? '+' : ''}${Math.round(d * 1000) / 1000} since last beat`
      const flat = d === 0 && m.changedAt ? `; flat ${flatFor(now - Date.parse(m.changedAt))}` : ''
      return `G${i + 1} ${m.name} ${m.value ?? '?'} (${change}${flat})${m.error ? ` [last measurement failed: ${m.error}]` : ''}`
    })
    for (const m of ms) if (m && m.value !== undefined) m.beatValue = m.value
    // Many commits and no number moving: say so once, in one line.
    const real = ms.filter((m): m is GoalMetric => !!m)
    if (real.length && real.every(m => m.kind === 'output')) lines.push('Every goal number counts your own work. Add one outcome number (something a user, customer or market did) with set_goals.')
    // A number that keeps moving and was never tagged is probably the org's own work: ask once per beat, in one line.
    const untagged = dir.goals.flatMap((_, i) => { const m = ms[i]; return m && !m.kind && m.value !== undefined ? [{ n: i + 1, m }] : [] })
    if (untagged.length) {
      const since = now - 24 * 3600_000
      const seenRows = new Set<string>()
      const changes = new Map<string, number>()
      try {
        for (const l of readFileSync(join(this.opts.home, 'goal-history.jsonl'), 'utf8').split('\n')) {
          if (!l) continue
          let r: { at?: string; name?: string }
          try { r = JSON.parse(l) } catch { continue }
          if (typeof r.name !== 'string') continue
          if (!seenRows.has(r.name)) { seenRows.add(r.name); continue }   // the first reading is not a change
          if (Date.parse(r.at ?? '') >= since) changes.set(r.name, (changes.get(r.name) ?? 0) + 1)
        }
      } catch { /* no history yet */ }
      const noisy = untagged.filter(u => (changes.get(u.m.name) ?? 0) >= 3)
      if (noisy.length) lines.push(noisy.map(u => `G${u.n} "${u.m.name}" changed ${changes.get(u.m.name)} times in 24h. If it counts your own work (commits, tests, entities, log freshness), re-run set_goals with kind: 'output' for it and keep one outcome number per goal; if outside people moved it, set kind: 'outcome' to stop this note.`).join('\n'))
    }
    const metered = real.filter(m => m.kind !== 'output' && m.value !== undefined && !!m.changedAt)
    if (metered.length && metered.every(m => now - Date.parse(m.changedAt!) >= 48 * 3600_000)) {
      const n = this.landedCount(now)
      if (n >= 20) lines.push(`Output without outcome: ${n} commits landed in 24h and no goal number moved in 48h+. Stop adding code that doesn't move a number. Name the bottleneck for the flattest goal, put the next seats on it, or escalate the owner-blocked step.`)
    }
    return lines.join('\n')
  }

  // Commits the org landed in the last 24h.
  private landedCount(now: number): number {
    try { return countLanded(this.opts.home, this.directive?.workspace, new Date(now - 24 * 3600_000).toISOString(), new Date(now).toISOString()) } catch { return 0 }
  }

  // True when some outcome number differs from what the last heartbeat saw. Output counters (the org's
  // own commits, tests, entities) move whenever it works, so they must not reset the back-off.
  private goalMoved(): boolean {
    return (this.directive?.goalMetrics ?? []).some(m => m && m.kind !== 'output' && m.value !== undefined && m.beatValue !== undefined && m.value !== m.beatValue)
  }

  // Anything the human should open, read or run: a link, a file, a command.
  deliver(caller: string | null, d: Omit<Deliverable, 'ts'>) {
    const dir = this.topOnly(caller, 'deliver')
    const item = { ...d, ts: new Date().toISOString() }
    dir.deliverables = [...dir.deliverables.filter(x => x.label !== d.label), item]
    this.log(caller, null, 'deliver', { ...d })
    this.saveDirective()
  }

  // The Director declares the directive met: its sub-org shuts down, the Director stays.
  complete(caller: string | null, summary: string, proposalId?: string) {
    const dir = this.topOnly(caller, 'complete the directive')
    this.requirePassed(caller, proposalId, 'complete the directive')
    dir.status = 'complete'
    dir.summary = summary
    dir.completedAt = new Date().toISOString()
    this.log(caller, null, 'complete', { summary })
    this.kb?.write('fact', `Round completed ${dir.completedAt.slice(0, 16).replace('T', ' ')}`, summary, 'director')
    // A round ends: temporary teams close, but department heads are standing seats. They keep their
    // conversation and memory; only their builders close, and they wait for the next round.
    for (const r of this.listReports(dir.directorId)) {
      if (!r.dept) { this.kill(r.id); continue }
      for (const b of this.listReports(r.id)) this.kill(b.id)
    }
    this.saveDirective()
  }

  // You talking to the top of the org. Reopens a completed directive.
  async askDirector(text: string) {
    if (!this.directive || !this.nodes.has(this.directive.directorId)) throw new Error('no Director is running')
    const dir = this.directive
    if (dir.status === 'complete') {
      dir.status = 'running'
      delete dir.completedAt
      this.saveDirective()
    }
    this.log(null, dir.directorId, 'ask', { text })
    const msg: OwnerMessage = { id: `m-${randomBytes(2).toString('hex')}`, ts: new Date().toISOString(), text: redact(text), status: 'new' }
    dir.messages = [...(dir.messages ?? []), msg].slice(-200)
    this.saveDirective()
    if (process.env.HOLON_FAKE_CLIS !== '1') void this.clarifyMessage(msg.id)   // tests never call a model
    const tops = dir.shape === 'holon' ? (dir.council?.members ?? []).filter(m => this.nodes.has(m)) : [dir.directorId]
    // Typing into the Director's terminal takes seconds. The message is already saved and shown,
    // so the reply goes back now and the typing carries on in the background.
    void Promise.all(tops.map(t => this.entry(t).term.type(`From the human (${msg.id}): ${text.replace(/\s+/g, ' ')}` +
      ` (If this changes what the org is for or how far it reaches, fold it into the directive with set_directive so every role works from the new version. Record what you do about it with note_message, id ${msg.id}.)`))).catch(() => {})
    return msg
  }

  // What was done about one of the owner's messages. Only a lead (or the human) records it;
  // it shows on the owner's Board next to the message.
  noteMessage(caller: string | null, id: string, status: OwnerMessage['status'], text: string, owner?: string) {
    const m = this.directive?.messages?.find(x => x.id === id)
    if (!m) throw new Error(`no owner message "${id}"`)
    if (caller !== null && !this.entry(caller).info.lead) throw new Error('only a lead (or the human) records what was done about an owner message')
    if (status !== 'new' && status !== 'doing' && status !== 'done' && status !== 'declined') throw new Error(`unknown status "${String(status)}" (use new, doing, done or declined)`)
    m.status = status
    if (owner) m.owner = owner
    m.actions = [...(m.actions ?? []).slice(-19), { ts: new Date().toISOString(), by: caller === null ? 'human' : this.entry(caller).info.label, text: redact(text).slice(0, 500) }]
    this.log(caller, null, 'note_message', { id, status })
    this.saveDirective()
    return m
  }

  // Anyone in the org messages anyone else directly, without blocking and without going up the
  // chain: a department asks another for a review, a handoff, a fact. Logged like everything else.
  async message(caller: string | null, to: string, text: string) {
    to = (await this.headFor(to, `a message from ${caller === null ? 'the human' : this.nodes.get(caller)?.info.label ?? caller}`)) ?? to
    const target = this.entry(to)
    const from = caller === null ? 'the human' : this.entry(caller).info.label
    if (caller === to) throw new Error('that is you')
    this.log(caller, to, 'message', { text })
    this.inboxAt.set(to, Date.now())
    this.watchChattyHead(caller, to)
    const needleDone = this.needle && caller === this.needle.id && to === this.directive?.directorId
    await target.term.type(`[message from ${from}${caller ? ` (${caller})` : ''}] ${text.replace(/\s+/g, ' ')}${caller ? ` — reply with message to ${caller} if needed.` : ''}`)
    if (needleDone) this.closeNeedle('', text)
    return { sent: to }
  }

  // ── chatty heads: one head, one target, far too many messages ──

  // The messages of the last 10 minutes, so the count is the org's own record.
  private messageEvents: MessageEvent[] = []

  // The pairs already told, so the note goes once per pair per 30 minutes.
  private warnedChatty = new Map<string, number>()

  // A head that sends one seat more than 30 messages in 10 minutes is told once, by its lead,
  // to batch its status into one message. It never blocks or drops a message: the head decides.
  private watchChattyHead(caller: string | null, target: string) {
    if (caller === null) return                              // the human has no lead to tell
    try {
      const now = Date.now()
      this.messageEvents.push({ ts: now, caller, target })
      this.messageEvents = this.messageEvents.filter(e => now - e.ts <= CHATTY_WINDOW_MS)
      for (const pair of chattyHeads(this.messageEvents.filter(e => e.caller === caller), now)) {
        const key = `${pair.caller}:${pair.target}`
        const last = this.warnedChatty.get(key) ?? 0
        if (now - last < CHATTY_COOLDOWN_MS) continue         // once per pair per 30 minutes
        this.warnedChatty.set(key, now)
        const label = this.entry(pair.caller).info.label
        const to = this.entry(pair.target).info.label
        this.log(pair.caller, pair.target, 'chatty-head', { caller: label, target: to, count: pair.count })
        const lead = this.entry(pair.caller).info.parentId
        if (!lead || !this.nodes.has(lead)) continue             // the Director has no lead
        void this.entry(lead).term.type(`${label} sent ${pair.count} messages to ${to} in 10 min. Batch status into one message; use note_message for what was done.`)
      }
    } catch { /* a flag never blocks a message */ }
  }

  // Turns a raw message into a titled brief, kept with the directive and in the KB.
  async clarifyMessage(id: string, clarifier: (text: string) => Promise<{ title: string; brief: string } | null> = clarify) {
    const m = this.directive?.messages?.find(x => x.id === id)
    if (!m) return null
    const c = await clarifier(m.text)
    if (!c) return null
    Object.assign(m, c)
    this.kb?.write('decision', `Owner: ${c.title}`, `${m.ts.slice(0, 16)}, from the owner.\n\n${c.brief}\n\nIn their words:\n${m.text}`, 'human')
    this.saveDirective()
    return m
  }

  // The directive evolves: the Director (or the human) rewrites it, and every department head,
  // every future brief, heartbeat and digest works from the new version.
  async setDirective(caller: string | null, text: string, reason = '') {
    const dir = this.directive
    if (!dir) throw new Error('no directive is running')
    if (caller !== null && caller !== dir.directorId) throw new Error('only the Director (or the human) rewrites the directive; escalate your proposal to the Director')
    if (!text.trim()) throw new Error('the directive cannot be empty')
    // The owner approves changes to what the org is for: the Director's rewrite becomes a suggestion.
    if (caller !== null && this.settings.directiveApproval) return this.suggestDirective('the Director', text, reason)
    return this.applyDirective(caller, text, reason)
  }

  suggestDirective(by: string, text: string, reason: string) {
    const dir = this.directive
    if (!dir) throw new Error('no directive is running')
    for (const d of dir.drafts ?? []) if (d.status === 'pending') d.status = 'superseded'
    const draft: DirectiveDraft = { id: `dd-${randomBytes(2).toString('hex')}`, ts: new Date().toISOString(), by, text: redact(text.trim()), reason, status: 'pending' }
    dir.drafts = [...(dir.drafts ?? []), draft].slice(-30)
    this.log(by === 'the Director' ? dir.directorId : null, dir.directorId, 'directive_suggested', { id: draft.id, by, reason })
    this.saveDirective()
    return { pending: draft.id, note: 'Suggested to the owner; it takes effect when they approve it. Carry on with the current directive meanwhile.' }
  }

  // The owner approves (optionally after editing) or rejects a suggested directive.
  async decideDirective(id: string, approve: boolean, note = '', text?: string) {
    const dir = this.directive
    const d = dir?.drafts?.find(x => x.id === id)
    if (!dir || !d) throw new Error(`no suggestion "${id}"`)
    if (d.status !== 'pending') throw new Error(`that suggestion is already ${d.status}`)
    d.status = approve ? 'approved' : 'rejected'
    if (note) d.note = note
    this.log(null, dir.directorId, approve ? 'directive_approved' : 'directive_rejected', { id, note })
    if (approve) return this.applyDirective(null, text?.trim() || d.text, `approved: ${d.reason}${note ? `; ${note}` : ''}`)
    this.saveDirective()
    if (this.nodes.has(dir.directorId)) await this.entry(dir.directorId).term.type(`[holon] The owner rejected the suggested directive (${d.reason})${note ? `: ${note}` : '.'} The current directive stands.`)
    return dir
  }

  // Run with the digest: owner messages not yet in the directive become a drafted update.
  async draftFromMessages(drafter: (current: string, messages: string[]) => Promise<string | null> = draftDirectiveUpdate) {
    const dir = this.directive
    if (!dir || dir.drafts?.some(d => d.status === 'pending')) return null
    const open = (dir.messages ?? []).filter(m => !m.folded)
    if (!open.length) return null
    const text = await drafter(dir.text, open.map(m => m.title ? `${m.title}: ${m.brief?.replace(/\n/g, ' ') ?? m.text}` : m.text))
    if (!text) return null
    return this.suggestDirective('Holon, from your messages', text, `folds in ${open.length} message${open.length === 1 ? '' : 's'}: ${open.map(m => m.title ?? m.text.slice(0, 40)).join('; ')}`)
  }

  // A first directive for a project, drafted from what is in its folder.
  async draftDirectiveFor(workspace: string, drafter: (notes: string) => Promise<string | null> = draftNewDirective) {
    const read = (f: string, n = 4000) => { try { return readFileSync(join(workspace, f), 'utf8').slice(0, n) } catch { return '' } }
    let files = ''
    try { files = readdirSync(workspace).filter(f => !f.startsWith('.')).slice(0, 60).join(', ') } catch { throw new Error(`no folder at ${workspace}`) }
    let docs = ''
    try { docs = readdirSync(join(workspace, 'docs')).filter(f => f.endsWith('.md')).slice(0, 20).join(', ') } catch {}
    const notes = [`FOLDER: ${workspace}`, `FILES: ${files}`, docs && `DOCS: ${docs}`, `README:\n${read('README.md') || read('readme.md') || '(none)'}`,
      `PACKAGE:\n${read('package.json', 1500)}`, `CLAUDE.md:\n${read('CLAUDE.md', 2000)}`].filter(Boolean).join('\n\n')
    const text = await drafter(notes)
    if (!text) throw new Error('could not draft a directive right now; try again or write one')
    return { text }
  }

  // Departments fitted to this directive and repo, drafted by a model and checked before use.
  async designOrg(text: string, workspace: string, designer: (input: string) => Promise<unknown[] | null> = draftOrgDesign): Promise<Department[]> {
    const read = (f: string, n: number) => { try { return readFileSync(join(workspace, f), 'utf8').slice(0, n) } catch { return '' } }
    const raw = await designer(`DIRECTIVE:\n${text}\n\nREADME:\n${read('README.md', 3000) || '(none)'}\n\nPACKAGE:\n${read('package.json', 1200)}`)
    if (!raw) throw new Error('could not design the org right now; try again or use the template')
    const ok = (re: string) => { try { new RegExp(re); return true } catch { return false } }
    const depts = raw.flatMap((d: any): Department[] => {
      if (!d || typeof d.dept !== 'string' || typeof d.charter !== 'string' || !d.dept.trim()) return []
      const paths = Array.isArray(d.gatePaths) ? d.gatePaths.filter((p: unknown) => typeof p === 'string' && ok(p)) : []
      const gate = paths.length || d.reviewsFreeWork ? { ...(paths.length ? { paths } : {}), ...(d.reviewsFreeWork ? { freeBuilders: true } : {}) } : undefined
      return [{ dept: d.dept.trim().slice(0, 30), charter: d.charter.slice(0, 600), persona: String(d.persona ?? '').slice(0, 300), grade: clampGrade(d.grade ?? 2), ...(gate ? { gate } : {}) }]
    }).slice(0, 8)
    if (!depts.some(d => d.dept.toLowerCase() === 'ar')) depts.push(DEPARTMENTS.find(d => d.dept === 'AR')!)
    return depts
  }

  // Changes a running org's shape without losing it: the knowledge base, the owner's backlog, goals,
  // deliverables, culture and repo carry over; the old leadership and its teams are closed (their
  // branches stay) and the new top is briefed on what came before.
  async reshape(shape: Shape, template: 'departments' | 'lean', departments?: Department[]) {
    const prev = this.directive
    if (!prev) throw new Error('no directive is running')
    if (departments?.length) this.setSettings({ departments })
    const carry = { goals: prev.goals, goalMetrics: prev.goalMetrics, deliverables: prev.deliverables, messages: prev.messages, drafts: prev.drafts, updates: prev.updates,
      treasury: prev.treasury, testCmd: prev.testCmd, approvals: prev.approvals, autopilot: prev.autopilot }
    const before = this.list().map(n => `${n.label}${n.dept ? ` (${n.dept})` : ''}: ${n.status ?? n.headline ?? ''}`.slice(0, 160))
    for (const id of [...(prev.council?.members ?? []), prev.directorId, prev.auditorId]) if (id && this.nodes.has(id)) this.kill(id)
    for (const n of this.list()) if (n.parentId === null) this.kill(n.id)
    prev.status = 'complete'
    const top = await this.startDirective(prev.text, prev.workspace, prev.heartbeatMin, shape, shape === 'holon', template)
    Object.assign(this.directive!, carry)
    this.log(null, top.id, 'reshape', { from: `${prev.shape ?? 'hierarchy'}/${prev.template ?? 'lean'}`, to: `${shape}/${template}` })
    this.saveDirective()
    await this.entry(top.id).term.type(`[holon] This org was just reorganized from ${prev.shape ?? 'hierarchy'}${prev.template ? ` (${prev.template})` : ''} to ${shape}${shape === 'hierarchy' ? ` (${template})` : ''} by the owner. ` +
      `Nothing is lost: the KB, HOLON-LOG.md, the repo and its branches, the goals (${prev.goals.length}) and the owner's backlog carry over. Read them first. ` +
      `The previous team and what each was doing:\n${before.join('\n') || '(nobody)'}\nPick up the open work rather than starting over.`)
    return this.view(top.id)
  }

  private async applyDirective(caller: string | null, text: string, reason: string) {
    const dir = this.directive!
    const before = dir.text
    dir.text = text.trim()
    this.log(caller, dir.directorId, 'set_directive', { reason, chars: dir.text.length })
    for (const m of dir.messages ?? []) m.folded ??= new Date().toISOString()
    this.kb?.write('decision', `Directive revised ${new Date().toISOString().slice(0, 16)}`, `By ${caller ? 'the Director' : 'the human'}: ${reason}\n\nBefore:\n${before}\n\nNow:\n${dir.text}`, 'holon')
    this.saveDirective()
    this.writeManifest()
    const told = this.list().filter(n => n.dept || (caller === null && n.id === dir.directorId))
    await Promise.all(told.map(n => this.entry(n.id).term.type(`[holon] The directive was revised${reason ? ` (${reason})` : ''}. Work from this version now; re-plan your area if it changes your goals, and escalate the new plan:\n\n${dir.text}`)))
    return dir
  }

  // ── knowledge base: the org's shared memory ────────────────────────────

  private openKb(workspace: string) {
    this.kb = new Kb(join(this.opts.home, 'kb', basename(workspace).replace(/[^\w.-]+/g, '-')))
  }

  private requireKb(): Kb {
    if (!this.kb) throw new Error('no directive is running, so there is no knowledge base')
    return this.kb
  }

  // The shared brain: lessons and playbooks every project's org can learn from. Project decisions,
  // facts and contacts stay in the project's own KB.
  private sharedKb() {
    return new Kb(join(rootOf(this.opts.home), 'kb-shared'))
  }

  // How often each entry has been read, so the owner can see whether the org's memory is used
  // at all. Loaded once from kb-reads.json and kept in memory; the file is written after each read.
  private readStats(): Map<string, KbReadStat> {
    if (!this.kbReads) {
      this.kbReads = new Map()
      try {
        const raw = JSON.parse(readFileSync(join(this.opts.home, 'kb-reads.json'), 'utf8')) as Record<string, KbReadStat>
        for (const [path, stat] of Object.entries(raw)) {
          if (stat && typeof stat.reads === 'number') this.kbReads.set(path, { reads: stat.reads, lastRead: stat.lastRead ?? '', by: stat.by ?? {} })
        }
      } catch {}
    }
    return this.kbReads
  }

  // One agent read of one entry. The counter is a nicety: if it can't be written, the read still happened.
  private countRead(caller: string, path: string) {
    try {
      const stats = this.readStats()
      const stat = stats.get(path) ?? { reads: 0, lastRead: '', by: {} }
      stat.reads += 1
      stat.lastRead = new Date().toISOString()
      const label = this.nodes.get(caller)?.info.label ?? caller
      stat.by[label] = (stat.by[label] ?? 0) + 1
      stats.set(path, stat)
      writeFileSync(join(this.opts.home, 'kb-reads.json'), JSON.stringify(Object.fromEntries(stats), null, 2))
    } catch {}
  }

  kbSearch(query: string, kind?: KbKind) {
    const stats = this.readStats()
    const own = this.requireKb().search(query, kind)
    const shared = this.sharedKb().search(query, kind, 4).map(e => ({ ...e, path: `shared:${e.path}`, shared: true }))
    return [...own, ...shared].map(e => ({ ...e, reads: stats.get(e.path)?.reads ?? 0, lastRead: stats.get(e.path)?.lastRead ?? '' }))
  }

  // An agent reads an entry; the owner browsing the Memory tab does not (caller is null there).
  kbRead(caller: string | null, path: string) {
    const entry = path.startsWith('shared:') ? this.sharedKb().read(path.slice(7)) : this.requireKb().read(path)
    if (caller !== null) this.countRead(caller, path)
    const stat = this.readStats().get(path)
    return { ...entry, reads: stat?.reads ?? 0, lastRead: stat?.lastRead ?? '', readBy: stat?.by ?? {} }
  }

  kbWrite(caller: string | null, kind: KbKind, title: string, body: string, shared = false) {
    const by = caller === null ? 'human' : this.nodes.get(caller)?.info.label ?? caller
    if (shared && kind !== 'lesson' && kind !== 'playbook') throw new Error('only lessons and playbooks go in the shared brain; keep decisions, facts and people in this project')
    const project = this.directive ? basename(this.directive.workspace) : 'unknown'
    // The KB is read by every agent and outlives them all: secrets never go in, whatever an agent pastes.
    const path = shared
      ? `shared:${this.sharedKb().write(kind, redact(title), `${redact(body)}\n\n(from ${project})`, `${by} (${project})`)}`
      : this.requireKb().write(kind, redact(title), redact(body), by)
    this.log(caller, null, 'kb_write', { kind, title, path, shared })
    return { path }
  }

  kbOverview() {
    if (!this.kb) return null
    return { dir: this.kb.dir, counts: this.kb.stats(), recent: this.kb.all().sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 8).map(e => ({ path: e.path, kind: e.kind, title: e.title, by: e.by, updated: e.updated })) }
  }

  // Every entry the org has written, newest first: what the owner browses in the Memory tab.
  kbList() {
    if (!this.kb) return []
    const stats = this.readStats()
    return this.kb.all()
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .map(e => ({ path: e.path, kind: e.kind, title: e.title, by: e.by, updated: e.updated, reads: stats.get(e.path)?.reads ?? 0, lastRead: stats.get(e.path)?.lastRead ?? '' }))
  }

  // ── second opinion: a reviewer from another model family, only when it matters ──

  private reviews = new Map<string, { resolve: (v: Verdict) => void; reviewer: string; question: string }>()

  // Spawns a read-only reviewer from a different vendor than the caller, waits for its
  // verdict, then closes it. Cross-vendor judgment for risky calls, with no standing seat.
  async secondOpinion(caller: string | null, question: string, evidence: string, timeoutMs = 20 * 60_000,
    reviewers?: { cli: Cli; model?: string }[]): Promise<Verdict> {
    if (caller === null) throw new Error('only a terminal asks for a second opinion')
    const asker = this.entry(caller).info
    // A reviewer is read-only and spawns nothing: asking for a second opinion would hire another seat.
    if ([...this.reviews.values()].some(r => r.reviewer === caller) || asker.readOnly) throw new Error('you are a read-only seat: you cannot ask for a second opinion (that spawns a reviewer)')
    // Another model family first; if a reviewer runs out of quota or dies, the next one takes over.
    const order = reviewers ?? (['codex', 'opencode', 'claude'] as Cli[]).filter(c => this.installed(c)).sort((a, b) => Number(a === asker.cli) - Number(b === asker.cli)).map(cli => ({ cli, model: undefined as string | undefined }))
    const deadline = Date.now() + timeoutMs
    const tried: string[] = []
    for (const { cli, model } of order) {
      const id = `rev-${randomBytes(2).toString('hex')}`
      const reviewer = this.create({ label: `Reviewer ${id}`, cli, model, cwd: this.directive?.workspace ?? asker.cwd, parentId: caller, lead: true, readOnly: true, tier: 'heavy' })
      this.log(caller, reviewer.id, 'second_opinion', { id, question, cli, model: reviewer.model })
      let resolveVerdict!: (v: Verdict) => void
      const verdict = new Promise<Verdict>(r => { resolveVerdict = r })
      this.reviews.set(id, { resolve: resolveVerdict, reviewer: reviewer.id, question })
      await this.clearStartup(reviewer.id)
      await this.entry(reviewer.id).term.type(`You are an independent reviewer (${cli}) giving a second opinion to ${asker.label}, who runs on ${asker.cli}. ` +
        `You can read everything and change nothing.\n\nQuestion: ${question}\n\nEvidence and context from them:\n${evidence}\n\n` +
        `Check the evidence yourself in ${this.directive?.workspace ?? asker.cwd} (code, git log, tests, data). Look for what they might be missing. ` +
        `Then call the verdict tool once with id "${id}": decision approve, revise or reject, and your reasoning with specifics.`)
      // Wait for the verdict, checking the reviewer can still work.
      const result = await new Promise<Verdict | 'failed'>(resolve => {
        const tick = setInterval(() => {
          const e = this.nodes.get(reviewer.id)
          const issue = e ? diagnose({ label: '', cli, screen: e.term.readScreen().text, quietMs: Math.max(e.term.quietForMs(), 60_000), exitCode: e.term.exitCode, hasLead: true })?.issue : undefined
          const stuck = !e || e.term.exitCode !== null || issue === 'quota' || issue === 'stuck-prompt'
          if (stuck) { clearInterval(tick); resolve('failed') }
          else if (Date.now() > deadline) { clearInterval(tick); resolve({ decision: 'none', reasoning: 'no verdict before the timeout; use your own judgment' }) }
        }, this.reviewPollMs)
        verdict.then(v => { clearInterval(tick); resolve(v) })
      })
      this.reviews.delete(id)
      if (this.nodes.has(reviewer.id)) this.kill(reviewer.id)
      if (result === 'failed') { tried.push(cli); this.log(caller, null, 'reviewer_failover', { from: cli }); continue }
      this.kb?.write('decision', `Second opinion: ${question.replace(/\s+/g, ' ').slice(0, 70)}`,
        `Asked by ${asker.label}; reviewer ${cli}${tried.length ? ` (after ${tried.join(', ')} could not answer)` : ''}.\n\nVerdict: ${result.decision}\n\n${result.reasoning}`, 'reviewer')
      return result
    }
    return { decision: 'none', reasoning: `no reviewer could answer (${tried.join(', ')} unavailable); use your own judgment` }
  }

  reviewPollMs = 10_000

  verdict(caller: string | null, id: string, decision: Verdict['decision'], reasoning: string) {
    const r = this.reviews.get(id)
    if (!r || r.reviewer !== caller) throw new Error(`no review "${id}" assigned to you`)
    this.log(caller, null, 'verdict', { id, decision, reasoning: reasoning.slice(0, 300) })
    r.resolve({ decision, reasoning })
    return { ok: true }
  }

  dissolveCouncil() {
    const dir = this.directive
    if (!dir?.council) return []
    const gone = dir.council.members.filter(m => m !== dir.directorId && this.nodes.has(m))
    for (const m of gone) this.kill(m)
    delete dir.council
    this.log(null, null, 'dissolve_council', { members: gone.length })
    this.saveDirective()
    return gone
  }

  // ── council: co-directors who must agree on big decisions ──────────────

  // Seats co-directors beside the Director. Each is a top-level lead with its own brief.
  async seatCouncil(clis: Cli[]): Promise<NodeView[]> {
    const dir = this.directive
    if (!dir || !this.nodes.has(dir.directorId)) throw new Error('no Director is running')
    const label = (c: Cli) => `Co-director (${c[0].toUpperCase()}${c.slice(1)})`
    // Co-directors judge; they never change anything, so their CLIs run read-only.
    const seats = clis.map(cli => this.create({ label: label(cli), cli, cwd: dir.workspace, lead: true, readOnly: true }))
    // Seating more co-directors later adds to the council instead of replacing it.
    const sitting = (dir.council?.members ?? [dir.directorId]).filter(m => this.nodes.has(m))
    const members = [...sitting, ...seats.map(s => s.id)]
    dir.council = { members, quorum: Math.floor(members.length / 2) + 1 }
    dir.proposals ??= []
    this.saveDirective()
    const names = (except: string) => members.filter(m => m !== except).map(m => `"${this.entry(m).info.label}" (${m})`).join(' and ')
    await Promise.all(seats.map(async s => {
      await this.clearStartup(s.id)
      await this.entry(s.id).term.type(CODIRECTOR_BRIEF(dir.text, dir.workspace, `"Director" (${dir.directorId})`, names(s.id)))
    }))
    await this.entry(dir.directorId).term.type(`[holon] The human seated a council: you, ${names(dir.directorId)}. ` +
      `From now on, big decisions need ${dir.council.quorum} of ${members.length} votes: goals, risky production deploys, pivots, pricing and ` +
      'positioning, killing a workstream, and anything sent to the human for money. Use propose (it waits for the vote) and act only on ' +
      'what passes. set_goals and complete now require a passed proposal id. You still run the org day to day.')
    this.log(null, null, 'seat_council', { members: members.map(m => this.entry(m).info.label) })
    return seats
  }

  // Blocks until the council decides. The proposal is typed into each other member's terminal.
  async propose(caller: string | null, title: string, rationale: string, timeoutMs = 30 * 60_000): Promise<Proposal> {
    this.notAuditor(caller, 'propose (post a task with your finding instead)')
    const dir = this.directive, council = dir?.council
    if (!dir || !council) throw new Error('this org has no council')
    if (caller === null || !council.members.includes(caller)) throw new Error('only council members propose')
    const p: Proposal = {
      id: `p-${randomBytes(2).toString('hex')}`, by: caller, title, rationale,
      votes: { [caller]: { vote: 'yes', reason: 'proposer' } }, status: 'open', ts: new Date().toISOString(),
    }
    const others = council.members.filter(m => m !== caller && this.nodes.has(m))
    const able = others.filter(m => !this.entry(m).info.blocked)
    if (dir.shape === 'holon' && able.length) p.critic = able[(dir.proposals ?? []).length % able.length]
    // An even number of voters can tie forever; the neutral auditor breaks it.
    const auditor = dir.auditorId && this.nodes.has(dir.auditorId) && !this.entry(dir.auditorId).info.blocked ? dir.auditorId : undefined
    if (auditor && (able.length + 1) % 2 === 0) p.tiebreaker = auditor
    dir.proposals = [...(dir.proposals ?? []), p]
    this.log(caller, null, 'propose', { id: p.id, title, critic: p.critic })
    this.saveDirective()
    const from = this.entry(caller).info.label
    if (p.tiebreaker) {
      void this.entry(p.tiebreaker).term.type(`[holon] Council proposal ${p.id} from ${from}: ${title}. Rationale: ${rationale.replace(/\s+/g, ' ')} — ` +
        `the council has an even number of voters, so you cast a deciding vote. Wait for the critique, check the evidence, then vote with the vote tool (id ${p.id}).`)
    }
    for (const m of others) {
      const role = !p.critic ? 'check the evidence yourself, then vote with the vote tool'
        : m === p.critic ? 'you are the designated critic: post the strongest honest case against it with the critique tool, then vote'
        : `wait for the critic (${this.entry(p.critic).info.label}) to post the case against, then vote with the vote tool`
      void this.entry(m).term.type(`[holon] Council proposal ${p.id} from ${from}: ${title}. Rationale: ${rationale.replace(/\s+/g, ' ')} — ${role} (id ${p.id}).`)
    }
    const decided = new Promise<void>(resolve => this.once(`decided:${p.id}`, () => resolve()))
    let timer: NodeJS.Timeout | undefined
    const failover = p.critic ? setInterval(() => this.reassignCritic(p, others), this.critiqueTimeoutMs) : undefined
    await Promise.race([decided, new Promise<void>(r => { timer = setTimeout(r, timeoutMs) })])
    clearTimeout(timer)
    clearInterval(failover)
    if (p.status === 'open') { p.status = 'expired'; this.saveDirective() }
    return p
  }

  vote(caller: string | null, id: string, vote: 'yes' | 'no', reason: string) {
    const council = this.directive?.council
    const p = this.directive?.proposals?.find(x => x.id === id)
    if (!council || !p) throw new Error(`no proposal "${id}"`)
    if (caller === null || (!council.members.includes(caller) && caller !== p.tiebreaker)) throw new Error('only council members vote')
    if (p.status !== 'open') throw new Error(`proposal ${id} is already ${p.status}`)
    if (p.votes[caller]) throw new Error('you already voted on this')
    if (p.critic && !p.critique) throw new Error(p.critic === caller ? 'post your critique first (critique tool), then vote' : 'wait for the critic to post the case against before voting')
    p.votes[caller] = { vote, reason }
    // Only members who can vote count: one out of quota or gone mustn't deadlock the council.
    const able = [...council.members, ...(p.tiebreaker ? [p.tiebreaker] : [])].filter(m => p.votes[m] || (this.nodes.has(m) && !this.entry(m).info.blocked))
    const quorum = Math.min(council.quorum, Math.floor(able.length / 2) + 1)
    const yes = Object.values(p.votes).filter(v => v.vote === 'yes').length
    const no = Object.values(p.votes).filter(v => v.vote === 'no').length
    if (yes >= quorum) p.status = 'passed'
    else if (no > able.length - quorum || (yes + no >= able.length && yes === no)) p.status = 'rejected'   // a full tie keeps the status quo
    this.log(caller, null, 'vote', { id, vote, reason })
    this.saveDirective()
    if (p.status !== 'open') {
      if (p.status === 'passed' && /^ask the human/i.test(p.title)) {
        // The council agreed to ask for something: it reaches the human as a need, not just a vote.
        void this.escalate(p.by, `${p.title}\n\n${p.rationale}`, 7 * 24 * 60 * 60_000, 'need', { blocks: 'none' }).catch(() => {})
      }
      if (p.status === 'passed') {
        const votes = Object.entries(p.votes).map(([m, v]) => `- ${this.nodes.get(m)?.info.label ?? m}: ${v.vote} (${v.reason})`).join('\n')
        this.kb?.write('decision', p.title, `Passed by the council (${p.id}, ${p.ts.slice(0, 10)}).\n\n${p.rationale}\n\nVotes:\n${votes}`, 'council')
      }
      this.log(null, null, `proposal_${p.status}`, { id, title: p.title })
      this.emit(`decided:${p.id}`)
    }
    return p
  }

  critiqueTimeoutMs = 5 * 60_000

  // A silent critic (out of quota, crashed, busy) must not stall the council: the role passes
  // to the next member who can work, and if nobody can, votes open without a critique.
  private reassignCritic(p: Proposal, others: string[]) {
    if (p.status !== 'open' || p.critique || !p.critic) return
    const was = p.critic
    const next = others.filter(m => m !== was && this.nodes.has(m) && !this.entry(m).info.blocked && !p.votes[m])[0]
    const name = (id: string) => this.nodes.get(id)?.info.label ?? id
    p.critic = next
    this.log(null, null, 'critic_reassigned', { id: p.id, from: name(was), to: next ? name(next) : null })
    this.saveDirective()
    if (next) void this.entry(next).term.type(`[holon] ${name(was)} didn't post a critique of ${p.id} in time, so you are now its critic: post the strongest honest case against it with the critique tool, then vote.`)
    else for (const m of this.directive?.council?.members ?? []) {
      if (this.nodes.has(m) && m !== was) void this.entry(m).term.type(`[holon] No critic could be found for ${p.id}; votes are open without a critique. Vote with the vote tool.`)
    }
  }

  critique(caller: string | null, id: string, text: string) {
    const p = this.directive?.proposals?.find(x => x.id === id)
    if (!p) throw new Error(`no proposal "${id}"`)
    if (p.critic !== caller) throw new Error('only the designated critic posts the critique')
    if (p.critique) throw new Error('the critique is already posted')
    p.critique = text
    this.log(caller, null, 'critique', { id, text: text.slice(0, 300) })
    this.saveDirective()
    for (const m of [...this.directive!.council!.members, ...(p.tiebreaker ? [p.tiebreaker] : [])].filter(m => m !== caller && this.nodes.has(m))) {
      void this.entry(m).term.type(`[holon] Critique of ${id} by ${this.entry(caller!).info.label}: ${text.replace(/\s+/g, ' ')} — now vote with the vote tool (id ${id}).`)
    }
    return p
  }

  private requirePassed(caller: string | null, proposalId: string | undefined, what: string) {
    if (caller === null || !this.directive?.council) return
    const p = this.directive.proposals?.find(x => x.id === proposalId)
    if (!p || p.status !== 'passed') throw new Error(`the council must pass a proposal before you ${what}; call propose, then pass its id`)
  }

  // Gets a fresh agent CLI past its first-run screens (folder trust and the like).
  private async clearStartup(id: string) {
    // A fake CLI is a plain shell: it has no folder-trust screen, and waiting 3 s for one made every
    // seat a test opens cost 3 s.
    if (process.env.HOLON_FAKE_CLIS === '1') return
    const term = this.entry(id).term
    for (let i = 0; i < 3; i++) {
      await term.waitQuiet(3000, 60_000)
      const s = term.readScreen().text
      if (/trust this folder/i.test(s) && /No, exit/.test(s)) { term.press('Down'); await new Promise(r => setTimeout(r, 300)); term.press('Enter') }
      else if (/Trust and continue|Do you trust/i.test(s)) term.press('Enter')
      else return
    }
  }


  private topOnly(caller: string | null, what: string): Directive {
    if (!this.directive) throw new Error('no directive is running')
    const top = this.directive.shape === 'holon' ? this.directive.council?.members ?? [] : [this.directive.directorId]
    if (caller !== null && !top.includes(caller)) throw new Error(`only the top of the org can ${what}; tell your lead instead`)
    return this.directive
  }

  // A progress note for the human: no answer expected. Top of the org only.
  update(caller: string | null, text: string) {
    this.notAuditor(caller, 'post updates to the human')
    const dir = this.directive
    if (!dir) throw new Error('no directive is running')
    if (caller !== null && this.entry(caller).info.parentId !== null) throw new Error('only the top of the org posts updates; tell your lead')
    const by = caller === null ? 'human' : this.entry(caller).info.label
    dir.updates = [...(dir.updates ?? []).slice(-49), { ts: new Date().toISOString(), by, text }]
    this.log(caller, null, 'update', { text })
    this.saveDirective()
  }

  setAutopilot(on: boolean) {
    if (!this.directive) throw new Error('no directive is running')
    this.directive.autopilot = on
    this.saveDirective()
  }

  setStatus(caller: string | null, status: string) {
    if (caller === null) throw new Error('only a terminal has a status')
    this.entry(caller).info.status = status
    this.log(caller, null, 'set_status', { status })
    this.saveOrg()
  }

  // ── escalation: a question travels up one level; your inbox is the top ──

  // Blocks until whoever is above the caller answers — unless that is the human, who
  // answers at their own pace: then it returns at once and the answer is typed in later.
  async escalate(caller: string | null, message: string, timeoutMs = 30 * 60_000, kind: 'need' | 'question' = 'question', extra: { blocks?: string; recommend?: 'yes' | 'no'; items?: string[] } = {}): Promise<string> {
    if (caller === null) throw new Error('only a terminal can escalate')
    const from = this.entry(caller).info
    if (from.parentId === null && this.directive?.autopilot && kind !== 'need') {
      throw new Error('Autopilot is on: the human only handles needs (credentials, accounts or services you lack, money, ' +
        'or actions only a person can take). Decide this yourself, putting big decisions to the council with propose if ' +
        'there is one, record it with kb_write, and tell the human what you decided with update_human.')
    }
    const blocks = extra.blocks?.trim()
    if (from.parentId === null && kind === 'need' && !blocks) {
      throw new Error('Say what this answer unblocks: pass blocks naming the goal and its number, e.g. "G4 outside builders 0 of 5", or "none" if no goal waits on it.')
    }
    // A need to the human holding several decisions is split, so part of it can be answered and the rest waits.
    const split = from.parentId === null ? (extra.items?.map(t => String(t).trim()).filter(Boolean) ?? splitItems(message)) : null
    const items = split && split.length >= 2 ? split.map(text => ({ text })) : undefined
    const esc: Escalation = {
      id: `esc-${randomBytes(2).toString('hex')}`, from: caller, to: from.parentId,
      message, kind, status: 'open', ts: new Date().toISOString(),
      ...(blocks && blocks.toLowerCase() !== 'none' ? { blocks } : {}),
      ...(extra.recommend === 'yes' || extra.recommend === 'no' ? { recommend: extra.recommend } : {}),
      ...(items ? { items } : {}),
    }
    const answered = new Promise<string>(resolve => this.escalations.set(esc.id, { ...esc, resolve }))
    this.log(caller, esc.to, 'escalate', { id: esc.id, message })
    this.saveEscalations()
    this.emit('escalation', this.listEscalations())
    if (esc.to !== null) {
      // The lead above is a terminal too: the question arrives as a message typed into it.
      await this.entry(esc.to).term.type(
        `[holon] Escalation ${esc.id} from your report "${from.label}" (${caller}): ${message.replace(/\s+/g, ' ')} ` +
        `— reply with the answer tool, id ${esc.id}.`)
    }
    if (esc.to === null) {
      // The human is the top of the org: don't freeze the asker waiting for a person.
      // Drop the stored resolve so the answer, whenever it comes, is typed in instead of lost.
      const e = this.escalations.get(esc.id)
      if (e) delete e.resolve
      return `Asked the human (${esc.id}${items ? `, ${items.length} items the human answers one by one; each answer is typed in as it comes` : ''}). Keep working on whatever doesn't depend on the answer; it will be typed into your terminal as "[holon] Answer to your escalation ${esc.id} …".`
    }
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<string>(r => { timer = setTimeout(() => {
      // Timed out, but the escalation stays open: a late answer is typed in, not dropped.
      const e = this.escalations.get(esc.id)
      if (e) delete e.resolve
      r('(no answer before timeout; use your judgment. If an answer comes later it will be typed in.)')
    }, timeoutMs) })
    const answer = await Promise.race([answered, timeout])
    clearTimeout(timer)
    return answer
  }

  answer(caller: string | null, id: string, text: string) {
    const esc = this.escalations.get(id)
    if (!esc) throw new Error(`no escalation "${id}"`)
    if (esc.status !== 'open') throw new Error(`escalation "${id}" is already answered`)
    if (esc.to !== caller) throw new Error(`escalation "${id}" was not sent to you`)
    esc.status = 'answered'
    esc.answer = text
    esc.answeredBy = caller
    // One answer to the whole ask settles every item still open.
    for (const item of esc.items ?? []) item.answer ??= text
    if (esc.resolve) esc.resolve(text)
    else if (this.nodes.has(esc.from)) {
      // Asked before a daemon restart: the original tool call is gone, so the answer is typed in.
      void this.entry(esc.from).term.type(`[holon] Answer to your escalation ${esc.id} ("${esc.message.replace(/\s+/g, ' ').slice(0, 80)}…"): ${text}`)
    }
    this.saveEscalations()
    if (caller === null) {
      this.kb?.write('decision', `Human: ${esc.message.replace(/\s+/g, ' ').slice(0, 70)}`,
        `Asked by ${this.nodes.get(esc.from)?.info.label ?? esc.from} on ${esc.ts.slice(0, 10)}:\n\n${esc.message}\n\nThe human answered:\n\n${text}`, 'human')
    }
    this.log(caller, esc.from, 'answer', { id, text })
    this.emit('escalation', this.listEscalations())
  }

  // The asker retires its own stale escalation: the blocker went away or it was answered some other way.
  withdraw(caller: string | null, id: string, reason: string) {
    const esc = this.escalations.get(id)
    if (!esc) throw new Error(`no escalation "${id}"`)
    if (esc.status !== 'open') throw new Error(`escalation "${id}" is already answered`)
    if (esc.from !== caller) throw new Error('only the asker can withdraw')
    const text = `withdrawn by asker: ${reason}`
    esc.status = 'answered'
    esc.answer = text
    esc.answeredBy = caller
    for (const item of esc.items ?? []) item.answer ??= text
    if (esc.resolve) esc.resolve(text)
    this.saveEscalations()
    this.log(caller, esc.from, 'withdraw', { id, reason })
    this.emit('escalation', this.listEscalations())
  }

  // Answers one decision of a multi-item ask to the human. It reaches the asker at once; the ask
  // closes when the last item is answered.
  answerItem(caller: string | null, id: string, index: number, text: string) {
    const esc = this.escalations.get(id)
    if (!esc) throw new Error(`no escalation "${id}"`)
    if (esc.status !== 'open') throw new Error(`escalation "${id}" is already answered`)
    if (esc.to !== caller) throw new Error(`escalation "${id}" was not sent to you`)
    const item = esc.items?.[index]
    if (!item) throw new Error(`escalation "${id}" has no item ${index + 1}`)
    if (item.answer !== undefined) throw new Error(`item ${index + 1} of "${id}" is already answered`)
    item.answer = text
    const items = esc.items!
    const left = items.filter(i => i.answer === undefined).length
    if (this.nodes.has(esc.from)) {
      void this.entry(esc.from).term.type(`[holon] Answer to item ${index + 1} of ${items.length} of your escalation ${esc.id} ("${item.text.replace(/\s+/g, ' ').slice(0, 80)}"): ${text}` +
        (left ? ` — ${left} still open; start on what this unblocks.` : ' — that was the last item.'))
    }
    if (!left) {
      esc.status = 'answered'
      esc.answer = items.map((i, n) => `${n + 1}. ${i.answer}`).join('\n')
      esc.answeredBy = caller
      if (caller === null) {
        this.kb?.write('decision', `Human: ${esc.message.replace(/\s+/g, ' ').slice(0, 70)}`,
          `Asked by ${this.nodes.get(esc.from)?.info.label ?? esc.from} on ${esc.ts.slice(0, 10)}:\n\n${esc.message}\n\nThe human answered:\n\n${esc.answer}`, 'human')
      }
    }
    this.saveEscalations()
    this.log(caller, esc.from, 'answer', { id, item: index + 1, text })
    this.emit('escalation', this.listEscalations())
  }

  // Human asks that have waited over a day, once a day each. Handing them out records the nudge,
  // so two callers (or a restart) never send the same ask twice in a day.
  dueNudges(now = Date.now()): Escalation[] {
    const due = dueNudges(this.listEscalations(), now)
    for (const e of due) this.escalations.get(e.id)!.lastNudgedAt = new Date(now).toISOString()
    if (due.length) this.saveEscalations()
    return due.map(e => ({ ...e, lastNudgedAt: new Date(now).toISOString() }))
  }

  listEscalations(): Escalation[] {
    return [...this.escalations.values()].map(({ resolve, ...e }) => e)
  }

  recentActions(): Action[] {
    return this.recent
  }

  // ── internals ──────────────────────────────────────────────────────────

  private depth(id: string): number {
    let d = 0
    for (let p = this.entry(id).info.parentId; p; p = this.entry(p).info.parentId) d++
    return d
  }

  private entry(id: string): Entry {
    const e = this.nodes.get(id)
    if (!e) throw new Error(`no terminal "${id}"`)
    return e
  }

  private view(id: string): NodeView {
    const { info, term } = this.entry(id)
    return { ...info, state: term.state, headline: headline(term.readScreen().text) }
  }

  private report(caller: string | null, id: string): Terminal {
    const e = this.entry(id)
    if (caller !== null && e.info.parentId !== caller) throw new Error(`"${id}" is not your report`)
    return e.term
  }

  private log(caller: string | null, target: string | null, action: string, args: Record<string, unknown>) {
    const entry: Action = { ts: new Date().toISOString(), caller, target, action, args: redactJson(args) }
    this.recent = [...this.recent.slice(-499), entry]
    this.trace?.action(entry)
    appendFileSync(join(this.opts.home, 'actions.jsonl'), JSON.stringify(entry) + '\n')
    this.emit('action', entry)
  }

  private saveOrg() {
    if (this.paused) return   // the seats on disk are what resume brings back
    const infos = [...this.nodes.values()].map(e => e.info)
    writeFileSync(join(this.opts.home, 'org.json'), JSON.stringify(infos, null, 2))
    this.trace?.org(infos)
    this.writeManifest()
    this.emit('org', this.list())
  }

  // ── traces: a reviewable record of the run ─────────────────────────────

  // Called by the daemon every 15 seconds: snapshots every screen that changed.
  snapshotScreens() {
    if (!this.trace) return 0
    let n = 0
    for (const [id, e] of this.nodes) if (this.trace.screen(id, e.info.label, e.term.state, e.term.readScreen(60).text)) n++
    return n
  }

  private seenTerminals = new Map<string, object>()

  private writeManifest() {
    if (!this.trace || !this.directive) return
    for (const { info } of this.nodes.values()) {
      this.seenTerminals.set(info.id, {
        id: info.id, label: info.label, cli: info.cli, model: info.model, tier: info.tier, parentId: info.parentId,
        lead: info.lead, readOnly: info.readOnly, cwd: info.cwd, createdAt: info.createdAt,
        transcript: transcriptFor(info.cli, info.cwd, info.sessionId),
      })
    }
    const { text, workspace, shape, startedAt, goals } = this.directive
    this.trace.manifest({ directive: text, workspace, shape: shape ?? 'hierarchy', startedAt, goals, terminals: [...this.seenTerminals.values()] })
  }

  // ── usage: tokens and cost per terminal, from each CLI's own records ────

  // Kept on disk: totals must survive daemon restarts and include agents that have finished.
  private usageCache = new Map<string, Usage & { label: string; cli: string; model?: string }>()
  private usageLoaded = false

  private loadUsage() {
    if (this.usageLoaded) return
    this.usageLoaded = true
    const f = join(this.opts.home, 'usage.json')
    if (existsSync(f)) { try { for (const [id, u] of Object.entries(JSON.parse(readFileSync(f, 'utf8')))) this.usageCache.set(id, u as any) } catch {} }
    // Codex rows kept from before Codex had default rates carry no cost; an exited seat is never
    // read again, so price it from its session file now.
    for (const [id, u] of this.usageCache) {
      if (u.cli === 'codex' && u.costUsd === null && u.source && existsSync(u.source)) this.usageCache.set(id, { ...codexUsage(u.source, this.opts.home, u.model), label: u.label, cli: u.cli, model: u.model })
    }
    // Agents from this run that finished before usage was kept: their Claude transcripts are in the trace manifest.
    const manifest = this.trace ? join(this.trace.dir, 'manifest.json') : ''
    if (manifest && existsSync(manifest)) {
      try {
        const m = JSON.parse(readFileSync(manifest, 'utf8')) as { terminals?: { id: string; label: string; cli: string; model?: string; transcript?: string }[] }
        for (const t of m.terminals ?? []) {
          if (this.usageCache.has(t.id) || t.cli !== 'claude' || !t.transcript || !existsSync(t.transcript)) continue
          this.usageCache.set(t.id, { ...claudeUsage(t.transcript), label: t.label, cli: t.cli, model: t.model })
        }
      } catch {}
    }
  }

  async refreshUsage() {
    this.loadUsage()
    const infos = [...this.nodes.values()].map(e => e.info)
    const since = Math.min(...infos.map(i => Date.parse(i.createdAt))) - 60_000
    const codex = infos.some(i => i.cli === 'codex') ? codexSessions(since) : []
    const oc = infos.some(i => i.cli === 'opencode') ? await opencodeSessions(since) : []
    const claimed = new Set<string>()
    for (const i of infos.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const created = Date.parse(i.createdAt)
      let u: Usage | undefined
      if (i.cli === 'claude') { const f = transcriptFor('claude', i.cwd, i.sessionId); if (f) u = claudeUsage(f) }
      else if (i.cli === 'codex') { const s = claim(codex, i.cwd, created, claimed); if (s) { claimed.add(s.file); u = codexUsage(s.file, this.opts.home, i.model) } }
      else if (i.cli === 'opencode') { const s = claim(oc, i.cwd, created, claimed); if (s) { claimed.add(s.file); u = s.usage; if (s.model) i.model = s.model } }
      if (u) this.usageCache.set(i.id, { ...u, label: i.label, cli: i.cli, model: i.model })
    }
    writeFileSync(join(this.opts.home, 'usage.json'), JSON.stringify(Object.fromEntries(this.usageCache)))
    this.countSpend()
    if (this.directive) {
      const rows = [...this.usageCache.values()]
      this.directive.usage = {
        // On a subscription (the default) there is no per-token bill: show tokens, not dollars.
        billing: process.env.HOLON_BILLING === 'api' ? 'api' : 'subscription',
        tokens: rows.reduce((s, r) => s + total(r), 0),
        costUsd: rows.reduce((s, r) => s + (r.costUsd ?? 0), 0),
        unpriced: rows.filter(r => r.costUsd === null).map(r => r.label),
        updatedAt: new Date().toISOString(),
      }
      this.saveDirective()
    }
    return this.usageReport()
  }

  usageReport() {
    return [...this.usageCache.entries()].map(([id, u]) => ({ id, label: u.label, cli: u.cli, model: u.model, tokens: total(u), input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, costUsd: u.costUsd }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens)
  }

  traceDir() {
    return this.trace?.dir ?? null
  }

  private saveEscalations() {
    writeFileSync(join(this.opts.home, 'escalations.json'), JSON.stringify(redactJson(this.listEscalations()), null, 2))
    this.emit('escalation', this.listEscalations())
  }

  private saveDirective() {
    writeFileSync(join(this.opts.home, 'directive.json'), JSON.stringify(redactJson(this.directive), null, 2))
    if (this.trace) writeFileSync(join(this.trace.dir, 'directive.json'), JSON.stringify(redactJson(this.directive), null, 2))
    this.emit('directive', this.directive)
  }

  // ── durability: bring the org back after the daemon restarts ───────────

  // Recreates every terminal from org.json, parents first. Claude sessions resume their
  // conversation; other CLIs start fresh. Leads are told what happened.
  async restore(why = 'The Holon daemon restarted'): Promise<number> {
    const orgFile = join(this.opts.home, 'org.json'), dirFile = join(this.opts.home, 'directive.json')
    if (existsSync(dirFile)) this.directive = JSON.parse(readFileSync(dirFile, 'utf8'))
    // Recent history feeds the scorecard and audits; it shouldn't reset with the daemon.
    const actFile = join(this.opts.home, 'actions.jsonl')
    if (existsSync(actFile)) this.recent = readFileSync(actFile, 'utf8').trim().split('\n').slice(-500).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
    if (this.directive) {
      this.openKb(this.directive.workspace)
      this.trace = Trace.forRun(this.opts.home, this.directive.workspace, this.directive.startedAt)
      // A run traced for the first time gets its earlier history from the global log.
      const traced = join(this.trace.dir, 'actions.jsonl'), global = join(this.opts.home, 'actions.jsonl')
      if (!existsSync(traced) && existsSync(global)) {
        const since = this.directive.startedAt
        const lines = readFileSync(global, 'utf8').split('\n').filter(l => { try { return JSON.parse(l).ts >= since } catch { return false } })
        if (lines.length) writeFileSync(traced, lines.join('\n') + '\n')
      }
    }
    const escFile = join(this.opts.home, 'escalations.json')
    if (existsSync(escFile)) for (const e of JSON.parse(readFileSync(escFile, 'utf8')) as Escalation[]) this.escalations.set(e.id, e)
    if (!existsSync(orgFile)) return 0
    // Restore the Director to the installed paid CLI's heavy grade, including while paused.
    const directorId = this.directive?.status !== 'dead' ? this.directive?.directorId : undefined
    const all = JSON.parse(readFileSync(orgFile, 'utf8')) as NodeInfo[]
    const dirSeat = all.find(n => n.id === directorId)
    const directorPlace = place(3, this.defaultCli(), this.settings)
    if (dirSeat && (dirSeat.cli !== directorPlace.cli || dirSeat.model !== directorPlace.model)) {
      dirSeat.movedFrom ??= { cli: dirSeat.cli, model: dirSeat.model, status: dirSeat.status }
      if (dirSeat.cli !== directorPlace.cli) delete dirSeat.sessionId
      Object.assign(dirSeat, directorPlace)
      for (const k of ['gradeFrom', 'fallbackAt', 'cliFrom', 'blocked', 'blockedUntil', 'pendingGrade'] as const) delete dirSeat[k]
      writeFileSync(orgFile, JSON.stringify(all, null, 2))
      this.log(null, dirSeat.id, 'director_on_opus', { fromCli: dirSeat.movedFrom.cli, fromModel: dirSeat.movedFrom.model ?? null })
    }
    // It never falls back now, so markers from an older fallback mean nothing.
    if (dirSeat) for (const k of ['gradeFrom', 'fallbackAt', 'cliFrom', 'blocked', 'blockedUntil'] as const) delete dirSeat[k]
    const reseated = dirSeat?.movedFrom && dirSeat.movedFrom.cli !== directorPlace.cli ? { id: dirSeat.id, ...dirSeat.movedFrom } : undefined
    if (this.paused) { this.log(null, null, 'restore_paused', { since: this.paused.at }); return 0 }
    // Terminals that had already exited stay gone; their work is in their branches and the KB.
    // Reviewers live only as long as their review, which a restart ends. The Director of a live
    // directive always comes back: without it the org is headless.
    const saved = all.filter(n => (!n.exited || n.id === directorId) && !n.label.startsWith('Reviewer rev-') && !this.nodes.has(n.id))
    const pending = [...saved]
    while (pending.length) {
      const i = pending.findIndex(n => n.parentId === null || this.nodes.has(n.parentId))
      if (i < 0) break // orphans of a parent that didn't come back
      const [n] = pending.splice(i, 1)
      const seat = this.directive && n.id !== this.directive.directorId && (this.directive.council?.members.includes(n.id) || n.id === this.directive.auditorId)
      const readOnly = n.readOnly || (seat && this.directive?.shape !== 'holon') || n.id === this.directive?.auditorId
      this.create({ ...n, cwd: n.worktree?.base ?? n.cwd, worktree: false, readOnly }, n)
      Object.assign(this.entry(n.id).info, { gradeFrom: n.gradeFrom, fallbackAt: n.fallbackAt, pendingGrade: n.pendingGrade, brief: n.brief })
    }
    const leads = this.list().filter(n => n.lead)
    await Promise.all(leads.map(async n => {
      const term = this.entry(n.id).term
      await term.waitQuiet(4000, 90_000)
      if (n.id === reseated?.id) {
        return term.type(`[holon] You are the Director, now on ${n.cli === 'claude' && n.model === 'opus' ? 'Claude Opus' : `${n.cli} ${n.model}`} (the seat ran on ${reseated.cli} ${reseated.model ?? ''} after a quota fallback, ` +
          `so its conversation is gone). Its last status: ${reseated.status ?? 'none'}. Your workspace is ${n.cwd}: read git log, HOLON-LOG.md and the KB, ` +
          'run list_reports and read each screen, then carry on where it left off.')
      }
      const reports = this.listReports(n.id)
      await term.type(`[holon] ${why} and your session was resumed. ` + (reports.length
        ? `Your reports were restarted too: ${reports.map(r => `${r.label} (${r.cli === 'claude' ? 'kept its conversation' : 'started fresh and was sent its last task'})`).join(', ')}. ` +
          'Run list_reports and read each screen, re-brief anyone who lost context, then carry on where you left off.'
        : 'You have no reports right now; anything you had spawned before is gone. Check git log and the KB, then carry on where you left off.'))
    }))
    // A builder that starts fresh comes back to a blank screen: hand it the task its
    // lead last gave it, so the restart costs it no more than the context it had.
    const rebuild = this.list().filter(n => !n.lead && n.cli !== 'claude' && n.cli !== 'shell' && n.brief)
    await Promise.all(rebuild.map(async n => {
      const term = this.entry(n.id).term
      await term.waitQuiet(4000, 90_000)
      await term.type('[holon] The daemon restarted and you lost your conversation. Check git status and git log in your working directory first: part of the work may already be done. Your task, as your lead last gave it:\n\n' + n.brief)
    }))
    this.log(null, null, 'restore', { terminals: this.nodes.size })
    return this.nodes.size
  }

  // ── heartbeat: keeps an ongoing directive moving ────────────────────────

  private idleSince = 0
  private lastBeat = 0
  private seatSavedAt = 0
  private beatHeads = ''   // unmerged report heads (id:sha) as of the last beat
  private quietBeats = 0   // heartbeats in a row that were followed by no merge or delivery

  // Called every minute by the daemon. Nudges the Director when the whole org has been
  // idle for heartbeatMin and no beat went out recently. Open questions to the human don't
  // stop it: the org should keep doing whatever isn't blocked on them.
  beat(now = Date.now()) {
    const dir = this.directive
    if (!dir?.heartbeatMin || dir.status === 'dead' || !this.nodes.has(dir.directorId)) return false
    const busy = this.list().some(n => n.state === 'running')
    const waitingOnYou = this.listEscalations().filter(e => e.to === null && e.status === 'open')
    if (busy) { this.idleSince = 0; return false }
    this.idleSince ||= now
    // A beat that leads to nothing shipped doubles the wait for the next one, up to 6 hours: idle
    // orgs were waking an Opus Director ~70 times a day to find nothing to do. Progress resets it.
    const since = new Date(this.lastBeat).toISOString()
    // A Director's own complete is how it answers a beat, so it is not progress here; only work landing is.
    // A report branch with commits not yet merged counts too, but only when the set of unmerged heads
    // changed since the last beat: a branch that just sits there must not hold the wait at its minimum.
    const unmerged = this.list().filter(n => n.parentId !== null && n.worktree && unmergedCommits(n.worktree) > 0)
    const heads = unmerged.map(n => `${n.id}:${headCommit(n.worktree!)}`).sort().join(',')
    // With a metric on any goal, only a goal number moving counts: commits and deliveries are not the goal.
    const metered = !!dir.goalMetrics?.some(Boolean)
    const progressed = !this.lastBeat || (metered ? this.goalMoved() : (heads !== '' && heads !== this.beatHeads) || this.recent.some(a => a.ts > since && SHIPPED.has(a.action) && a.action !== 'complete'))
    // Unused week about to reset is lost, so no back-off while there is a surplus to spend.
    const surplus = weekSurplus(join(rootOf(this.opts.home), 'claude-plan.json'), now)
    const quiet = progressed || surplus ? 0 : this.quietBeats
    // While goals are unmet and not all of them wait on the human, an idle org must not sleep for hours.
    const unmet = dir.goals.length > waitingOnYou.length
    const period = Math.min(dir.heartbeatMin * 2 ** quiet, Math.max(unmet ? 60 : 6 * 60, dir.heartbeatMin)) * 60_000
    if (now - this.idleSince < dir.heartbeatMin * 60_000 || now - this.lastBeat < period) return false
    this.lastBeat = now
    this.beatHeads = heads
    this.quietBeats = quiet + 1
    if (dir.status === 'complete') { dir.status = 'running'; delete dir.completedAt }
    this.log(null, dir.directorId, 'heartbeat', { idleMin: Math.round((now - this.idleSince) / 60_000) })
    this.saveDirective()
    const t = dir.treasury
    const money = (t ? ` Runway: ${Math.round(runway(t))} agent-minutes left; settled MRR $${t.mrr}.` : '') +
      (surplus ? ` ${surplus.unusedPct}% of the Claude week is unused and it resets in ${surplus.hoursLeft}h. What isn't spent is lost, so staff parallel work now on Claude grades.` : '')
    const tops = dir.shape === 'holon' ? (dir.council?.members ?? []).filter(m => this.nodes.has(m)) : [dir.directorId]
    const merge = unmerged.length
      ? `\nThese report branches have commits that are not merged: ${unmerged.map(n => `${n.label} (${n.worktree!.branch})`).join(', ')}. Merge or gate each one now.`
      : ''
    const send = (goals: string) => {
      for (const top of tops) void this.entry(top).term.type(`[holon] Heartbeat, ${new Date(now).toLocaleString()}.${money} The org has been idle for ` +
        `${dir.heartbeatMin}+ minutes. This directive is ongoing: review progress against the goals and your log, check the ` +
        'numbers that matter, decide the next most valuable work, staff it and continue. ' +
        (waitingOnYou.length
          ? `${waitingOnYou.length} question(s) are still waiting on the human (${waitingOnYou.map(e => `${e.id}${e.blocks ? ` blocks: ${e.blocks.replace(/\s+/g, ' ').slice(0, 120)}` : ' blocks no named goal'}`).join('; ')}); don't re-ask, keep going on everything they don't block.`
          : 'If you are blocked on the human, escalate.') + goals + merge +
        (unmet && !this.listReports(top).some(n => n.state === 'running')
          ? '\nYou have unmet goals and no one working. Staff the most valuable goal the human does not block.' : '') + this.backlogNote(now) + this.goalNote(now))
    }
    if (!dir.goals.length) send('')
    else if (!metered) {
      send('\nNo goal has a metric, so commits are all this beat can count as progress. Call set_goals again and give every goal a name and a shell command that prints its number (visitors, replies, signups, MRR).')
    } else {
      // The decision above ran on the last reading; if this forced measurement is the first to see a move,
      // count it now, or goalLines() overwrites beatValue and no later beat ever sees the change.
      this.beatDone = this.measureGoals(now, true).catch(() => {}).then(() => { if (this.goalMoved()) this.quietBeats = 1 }).then(() => send('\nGoals, with change since the last beat:\n' + this.goalLines(now)))
    }
    return true
  }
  beatDone: Promise<void> = Promise.resolve()

  // The owner's open items, oldest first: every heartbeat reminds the Director until each is done or declined.
  backlogNote(now = Date.now()) {
    const open = (this.directive?.messages ?? []).filter(m => m.status !== 'done' && m.status !== 'declined')
    if (!open.length) return ''
    const age = (m: OwnerMessage) => Math.round((now - Date.parse(m.actions?.at(-1)?.ts ?? m.ts)) / 60_000)
    return `\nThe owner's backlog still has ${open.length} open item(s); move each to done (with what shipped) or declined (with why) using note_message, and give each an owner:\n` +
      open.slice(0, 12).map(m => `- ${m.id} [${m.status ?? 'new'}${m.owner ? `, ${m.owner}` : ', no owner'}] ${m.title ?? m.text.slice(0, 80)} (last touched ${age(m)} min ago)`).join('\n')
  }

  // ── treasury ─────────────────────────────────────────────────────────

  setTreasury(p: { budgetMin: number; minPerDollar?: number; revenueCmd?: string }) {
    if (!this.directive) throw new Error('no directive is running')
    const prev = this.directive.treasury
    this.directive.treasury = {
      budgetMin: p.budgetMin, minPerDollar: p.minPerDollar ?? 50, revenueCmd: p.revenueCmd,
      spentMin: prev?.spentMin ?? 0, earnedMin: prev?.earnedMin ?? 0, mrr: prev?.mrr ?? 0, spentBy: prev?.spentBy ?? {},
    }
    this.log(null, null, 'set_treasury', { budgetMin: p.budgetMin, minPerDollar: p.minPerDollar ?? 50 })
    this.saveDirective()
    void this.refreshRevenue()
  }

  // Called by the daemon every few seconds: charges running terminals, credits revenue,
  // and shuts the org down when the runway is gone.
  tick(dtMs: number) {
    const dir = this.directive, t = dir?.treasury
    if (dir && dir.status !== 'dead') {
      this.accrueSeatMin(dtMs)
      // Without a treasury nothing else saves; the hourly bucket loses nothing sitting in memory for a minute.
      if (!t && Date.now() - this.seatSavedAt >= 60_000) { this.seatSavedAt = Date.now(); this.saveDirective() }
    }
    if (!dir || !t || dir.status === 'dead') return
    const minutes = dtMs / 60_000
    for (const n of this.list()) {
      if (n.state !== 'running' || isFree(n.cli, n.model)) continue
      const cost = minutes * TIER_COST[n.tier ?? 'heavy']
      t.spentMin += cost
      t.spentBy[n.id] = (t.spentBy[n.id] ?? 0) + cost
    }
    t.earnedMin += t.mrr * t.minPerDollar * minutes / (30 * 24 * 60)
    if (runway(t) <= 0) return this.die()
    this.saveDirective()
  }

  async refreshRevenue() {
    const t = this.directive?.treasury
    if (!t?.revenueCmd) return
    const shell = process.env.SHELL || '/bin/zsh'
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(shell, ['-lc', t.revenueCmd!], { timeout: 120_000 }, (err, stdout) => err ? reject(err) : resolve(stdout)))
      const last = out.trim().split('\n').pop() ?? ''
      const mrr = last.startsWith('{') ? Number(JSON.parse(last).mrr) : Number(last)
      if (!Number.isFinite(mrr)) throw new Error(`revenue command printed ${JSON.stringify(last)}`)
      t.mrr = mrr
      delete t.revenueError
    } catch (err) {
      t.revenueError = (err as Error).message.slice(0, 200)
    }
    t.mrrCheckedAt = new Date().toISOString()
    this.saveDirective()
  }

  treasuryView(caller: string | null) {
    // keyed by role id: two terminals may share a label
    const spentUsdBy = Object.fromEntries([...this.usageCache].map(([id, u]) => [id, Math.round((u.costUsd ?? 0) * 100) / 100]))
    const costBasis = 'api-equivalent estimate, not billed spend'
    const t = this.directive?.treasury
    if (!t) return { treasury: 'none: this org has no budget limit', spentUsdBy, costBasis }
    const running = this.list().filter(n => n.state === 'running').length
    const left = runway(t)
    const subtree = (id: string): string[] => [id, ...this.list().filter(n => n.parentId === id).flatMap(n => subtree(n.id))]
    const label = (id: string) => this.nodes.get(id)?.info.label ?? `${id} (gone)`
    return {
      runwayMin: Math.round(left),
      hoursLeftAtCurrentBurn: running ? Math.round(left / running / 60 * 10) / 10 : null,
      runningNow: running,
      budgetMin: t.budgetMin, spentMin: Math.round(t.spentMin), earnedMin: Math.round(t.earnedMin),
      spentUsdBy, costBasis,
      settledMrr: t.mrr, minPerDollarPerMonth: t.minPerDollar,
      yourTeamSpentMin: caller && this.nodes.has(caller) ? Math.round(subtree(caller).reduce((s, id) => s + (t.spentBy[id] ?? 0), 0)) : undefined,
      topSpenders: Object.entries(t.spentBy).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, m]) => `${label(id)}: ${Math.round(m)} min`),
    }
  }

  private die() {
    const dir = this.directive!
    dir.status = 'dead'
    this.log(null, dir.directorId, 'org_died', { spentMin: Math.round(dir.treasury!.spentMin) })
    if (this.nodes.has(dir.directorId)) this.kill(dir.directorId)
    this.saveDirective()
  }

  setHeartbeat(minutes: number | null) {
    if (!this.directive) throw new Error('no directive is running')
    if (minutes === null) delete this.directive.heartbeatMin
    else this.directive.heartbeatMin = Math.max(5, minutes)
    this.saveDirective()
  }
}
