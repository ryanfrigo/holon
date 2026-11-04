#!/usr/bin/env node
// The tools a Holon lead uses to drive its reports. Launched by the lead's own CLI
// (Claude Code, Codex, ...) over stdio; every call is forwarded to the Holon daemon
// tagged with the lead's terminal id, so the daemon can enforce who drives whom.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { HolonClient } from '@holon/core/client'

const caller = process.env.HOLON_TERMINAL_ID
const socket = process.env.HOLON_SOCKET
if (!caller || !socket) {
  console.error('holon-mcp needs HOLON_TERMINAL_ID and HOLON_SOCKET')
  process.exit(1)
}

let client = await HolonClient.connect(socket)
const server = new McpServer({ name: 'holon', version: '0.0.1' })

const ok = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

async function call(method: string, params: Record<string, unknown>) {
  try {
    // A restarted daemon listens on the same socket: reconnect instead of failing every call
    // for the rest of the lead's session.
    if (client.closed) client = await HolonClient.connect(socket!)
    return ok(await client.call(method, { ...params, caller }))
  } catch (err) {
    return { ...ok(`error: ${(err as Error).message}`), isError: true }
  }
}

const id = z.string().describe('Terminal id of one of your reports (from list_reports)')

server.registerTool('list_reports', {
  description: 'List the terminals that report to you, with their id, label, CLI, working directory and state (running / quiet / exited).',
  inputSchema: {},
}, () => call('list_reports', {}))

server.registerTool('read_screen', {
  description: "Read what is on a report's terminal screen right now, exactly as a person would see it.",
  inputSchema: { id, scrollback: z.number().int().min(0).optional().describe('Extra lines of history above the visible screen') },
}, a => call('read_screen', a))

server.registerTool('type', {
  description: "Type text into a report's terminal. Presses Enter afterwards unless submit is false.",
  inputSchema: { id, text: z.string(), submit: z.boolean().optional() },
}, a => call('type', a))

server.registerTool('press', {
  description: "Press one key in a report's terminal: Enter, Escape, Tab, Up, Down, Left, Right, Backspace, Space, C-c, C-d, or a single character (e.g. a menu number).",
  inputSchema: { id, key: z.string() },
}, a => call('press', a))

server.registerTool('wait', {
  description: "Block until a report's screen has stopped changing for quietMs (default 3000), then return its state and the bottom of its screen. Returns state \"prompt\" with the prompt text when the report is waiting at a permission prompt, and state \"message\" the moment another seat messages you (read it, then wait again if you still need this report). Waits at least 2 minutes before timing out: every return costs you a turn that re-reads your whole conversation, so wait once instead of checking repeatedly. Use after type instead of polling.",
  inputSchema: {
    id,
    quietMs: z.number().int().min(200).optional(),
    timeoutMs: z.number().int().min(1000).optional().describe('Give up after this long (default 600000)'),
  },
}, a => call('wait', a))

server.registerTool('spawn', {
  description: 'Start a new terminal that reports to you. cli is claude, codex, opencode (free OpenRouter models, no runway cost) or shell. Set lead to true to give it these same tools for its own reports.',
  inputSchema: {
    label: z.string(),
    cli: z.enum(['claude', 'codex', 'gemini', 'opencode', 'shell']),
    cwd: z.string().describe('Absolute working directory'),
    lead: z.boolean().optional(),
    yolo: z.boolean().optional().describe('Skip its permission prompts entirely. Default: true for leads, false otherwise'),
    worktree: z.boolean().optional().describe('Give it its own git worktree and branch off cwd. Use for every builder that changes code, then bring the work back with merge_report.'),
    purpose: z.enum(['research', 'code']).optional().describe('code = will change the repo and merge; research = reads and reports. Default: code when worktree is true, else research.'),
    tier: z.enum(['light', 'standard', 'heavy']).optional().describe('Cheapest that can do the job: light (lookups, copy, simple edits), standard (most coding and most leads, the default), heavy (hard design, subtle production code). Runway is charged by tier.'),
    model: z.string().optional().describe('Overrides the tier with an exact model id'),
    why: z.string().optional().describe('Required above grade 0. Must start with the goal it serves: "G2: cut checkout errors" (G<n> is the 1-based index in the directive goals). Overhead with no goal: "G0: <reason>" or "no goal: <reason>". A builder above grade 0 also says why it needs paid labor. Logged for the org review; the heartbeat flags capacity spent on no goal.'),
    grade: z.number().int().min(0).max(3).optional().describe('Picks the model for you and overrides cli and tier: 0 free models (opencode, no runway cost; use for all well-specified execution), 1 light, 2 standard, 3 heavy (Opus). Give G0 builders small, explicit tasks.'),
    check: z.string().optional().describe('A shell command, run in the builder\'s worktree before its merge, that proves the task is done (e.g. "npx vitest run test/foo.test.ts"). The merge is refused if it fails.'),
  },
}, a => call('spawn', a))

server.registerTool('escalate', {
  description: 'Ask whoever you report to (your lead, or the human at the top) for something you cannot decide or do alone. Blocks until your lead answers; a question to the human returns at once and the answer is typed into your terminal later. In autopilot the human only takes kind "need": credentials, services, money or human-only actions.',
  inputSchema: {
    message: z.string().describe('The question or need, answerable from this text alone: for each decision one line saying what yes and no each do, and your recommendation. Long material (exact drafts) goes on one board card named by id, kept current with board_update.'),
    kind: z.enum(['need', 'question']).optional().describe('need: something only the human can provide (credentials, accounts, money, a phone call). Default question.'),
    blocks: z.string().optional().describe('Required for a need to the owner (errors without it): the goal and number this answer unblocks, e.g. "G4 outside builders 0 of 5", or "none" if no goal waits on it. The human sees it on the card and in the daily reminder.'),
    recommend: z.enum(['yes', 'no']).optional().describe('Required for kind need when the ask is yes/no: the answer you would pick. The human can answer from a notification button.'),
    items: z.array(z.string()).optional().describe('A need to the human with several decisions: one string per decision, so the human can answer some now and the rest later. Each answer is typed into your terminal as it comes. Numbered or bulleted lines in message are split the same way when you omit this.'),
    timeoutMs: z.number().int().min(10_000).optional().describe('(lead escalations only) Give up and use your judgment after this long (default 30 min); a later answer is still typed in'),
  },
}, a => call('escalate', a))

server.registerTool('answer', {
  description: 'Answer an escalation one of your reports sent you (it arrives in your terminal as "[holon] Escalation esc-…").',
  inputSchema: { id: z.string().describe('Escalation id, e.g. esc-1a2b'), text: z.string() },
}, a => call('answer', a))

server.registerTool('withdraw', {
  description: 'Withdraw an escalation you sent that no longer applies (answered some other way, or the blocker went away). Only the asker can.',
  inputSchema: { id: z.string(), reason: z.string() },
}, a => call('withdraw', a))

server.registerTool('set_status', {
  description: 'Post a one-line status the human sees on your card in the org chart (what you are doing, what is blocked, what is next). Keep it current.',
  inputSchema: { status: z.string().max(200) },
}, a => call('set_status', a))

server.registerTool('note_message', {
  description: 'Record what was done about one of the owner\'s messages (id m-xxxx from "From the human (m-xxxx)") and its status: doing, done or declined. It shows on the owner\'s Board next to the message.',
  inputSchema: {
    id: z.string().describe('The owner message id from the (m-xxxx) in "From the human (m-xxxx)"'),
    status: z.enum(['doing', 'done', 'declined']),
    text: z.string().describe('What was done about it: committed, merged, or why it was declined or is not being done'),
    owner: z.string().optional().describe('The department or role that owns getting it done (e.g. Engineering). Set it when you start.'),
  },
}, a => call('note_message', a))

server.registerTool('set_goals', {
  description: "Record the org's goals (top of the org only), numbered G1..Gn in order. Every goal needs a number and a command that measures it: pass {text, metric: {name, cmd}} where cmd is a shell command (run in the workspace, 60s limit) whose last printed number is the value, e.g. visitors, replies, signups, MRR, entities. Heartbeats report each number and its change, and an org whose numbers do not move backs off, however many commits land. A plain string is still accepted but has no number. Metric kind: 'output' counts the org's own work (commits, tests, entities, log freshness); 'outcome' (the default) is something outside the org did (users, replies, payments, visits). Shown at the top of the human's board.",
  inputSchema: {
    goals: z.array(z.union([z.string(), z.object({
      text: z.string(),
      metric: z.object({ name: z.string().describe('Short label for the number, e.g. visitors'), cmd: z.string().describe('Shell command; the last number it prints is the value'), kind: z.enum(['outcome', 'output']).optional().describe('outcome (default): a user, customer or market did it. output: counts the org\'s own work') }).optional(),
    })])).min(1).max(8),
    proposalId: z.string().optional().describe('Required when the org has a council: the id of the passed proposal'),
  },
}, a => call('set_goals', a))

server.registerTool('deliver', {
  description: 'Director only. Hand the human something to open, read or run: a URL that is running, an absolute file path, or a shell command. Re-delivering the same label replaces it.',
  inputSchema: {
    label: z.string().describe('Short name, e.g. "Steam site"'),
    kind: z.enum(['url', 'file', 'command']),
    value: z.string(),
    note: z.string().optional(),
  },
}, a => call('deliver', a))

server.registerTool('complete', {
  description: 'Director only. Declare the directive met once every goal is verified. Shuts down your reports; you stay available for follow-ups.',
  inputSchema: {
    summary: z.string().describe('What exists, where, and anything left undone'),
    proposalId: z.string().optional().describe('Required when the org has a council: the id of the passed proposal'),
  },
}, a => call('complete', a))

server.registerTool('treasury', {
  description: "The org's runway in agent-minutes: every running terminal spends one per minute, settled revenue earns more, and at zero the whole org is shut down. Shows burn, MRR, what your team has spent and the top spenders. Check it before you staff up.",
  inputSchema: {},
}, () => call('treasury', {}))

server.registerTool('propose', {
  description: "Council members only. Put a big decision to the council (goals, risky deploys, pivots, pricing, killing a workstream, money asks). It is typed into the other members' terminals; this call waits until a majority decides, then returns the outcome and every vote.",
  inputSchema: {
    title: z.string().describe('The decision, stated so yes/no is unambiguous'),
    rationale: z.string().describe('Evidence and expected effect, with paths or numbers others can check'),
    timeoutMs: z.number().int().min(60_000).optional(),
  },
}, a => call('propose', a))

server.registerTool('vote', {
  description: 'Council members only. Vote on a proposal ("[holon] Council proposal p-…"). Check the evidence yourself first; vote no when it is weak.',
  inputSchema: { id: z.string(), vote: z.enum(['yes', 'no']), reason: z.string() },
}, a => call('vote', a))

server.registerTool('kill_report', {
  description: 'Close one of your reports (and any reports under it) when its work is done or no longer needed. You must give a one-line reason: it is kept in the trace so the next reader can see why the builder died. Its branch and KB entries are kept. Cheaper than leaving it idle. Refuses terminals less than 5 minutes old unless force is true.',
  inputSchema: {
    id,
    reason: z.string().describe('One line: why you are closing it (merged, stuck at a prompt, pool out, spec wrong)'),
    force: z.boolean().optional().describe('Kill a terminal under 5 minutes old anyway, after you have read its screen and confirmed it is stuck or done.'),
  },
}, a => call('kill_report', a))

server.registerTool('merge_report', {
  description: "Bring a worktree report's committed work back: it is queued, rebased onto the base branch, tested (the org's test command unless you pass one), and fast-forwarded only if the tests pass. On conflicts or failures nothing is merged and you get the reason, conflicting files and test output to hand back to the builder.",
  inputSchema: { id, testCmd: z.string().optional().describe('Overrides the org test command for this merge') },
}, a => call('merge_report', a))

server.registerTool('board_list', {
  description: "The org's shared task board. Check it before starting work.",
  inputSchema: { status: z.enum(['open', 'claimed', 'done', 'dropped']).optional() },
}, a => call('board_list', a))

server.registerTool('board_post', {
  description: 'Post a task anyone in the org can pick up: what, why, and how to know it is done.',
  inputSchema: { title: z.string().max(120), detail: z.string().optional() },
}, a => call('board_post', a))

server.registerTool('board_update', {
  description: 'Edit an open card in place (title and/or detail). Corrections, addenda and "final" versions go here: never post a new card that replaces or adds to an old one, because asks and messages point at the old id.',
  inputSchema: { id: z.string(), title: z.string().max(120).optional(), detail: z.string().optional() },
}, a => call('board_update', a))

server.registerTool('board_claim', {
  description: 'Claim an open task from the board so nobody else starts it.',
  inputSchema: { id: z.string() },
}, a => call('board_claim', a))

server.registerTool('board_done', {
  description: 'Finish a task you claimed, with the evidence (commit, test output, URL). Set dropped to abandon it with the reason.',
  inputSchema: { id: z.string(), result: z.string(), dropped: z.boolean().optional() },
}, a => call('board_done', a))

server.registerTool('second_opinion', {
  description: 'Before a risky move (non-trivial production deploy, secrets, credentials, billing, pricing, a pivot), get an independent read-only review from a different model family. Waits for the verdict (approve, revise or reject, with reasoning) and closes the reviewer afterwards.',
  inputSchema: {
    question: z.string().describe('The decision you are about to make, stated plainly'),
    evidence: z.string().optional().describe('What you checked and why you think it is right: paths, commits, numbers'),
    timeoutMs: z.number().int().min(60_000).optional(),
  },
}, a => call('second_opinion', a))

server.registerTool('verdict', {
  description: 'Reviewers only: give your second-opinion verdict for the review id you were given.',
  inputSchema: { id: z.string(), decision: z.enum(['approve', 'revise', 'reject']), reasoning: z.string() },
}, a => call('verdict', a))

server.registerTool('critique', {
  description: 'Holon shape: when you are the designated critic of a proposal, post the strongest honest case against it. Votes open once it is posted.',
  inputSchema: { id: z.string(), text: z.string() },
}, a => call('critique', a))

server.registerTool('update_human', {
  description: 'Top of the org only. Post a short progress note to the human (what shipped, changed, broke, or what you decided and why). No answer expected; it shows on their board and as a desktop notification. Keep it to a sentence or two.',
  inputSchema: { text: z.string().max(400) },
}, a => call('update_human', a))

const kind = z.enum(['decision', 'fact', 'lesson', 'playbook', 'person'])

server.registerTool('kb_search', {
  description: "Search the org's knowledge base (decisions, facts, lessons, playbooks and people that outlive every terminal) and the shared brain (lessons and playbooks from every Holon project; paths start with shared:). Search before you start work or decide anything.",
  inputSchema: { query: z.string(), kind: kind.optional() },
}, a => call('kb_search', a))

server.registerTool('kb_read', {
  description: 'Read one knowledge-base entry in full, by the path kb_search returned.',
  inputSchema: { path: z.string() },
}, a => call('kb_read', a))

server.registerTool('kb_write', {
  description: 'Record something the org should remember. decision: what was decided and why. fact: a number or finding, with source and date. lesson: what failed and the fix. playbook: steps for a recurring task. person: a customer or contact. Writing an existing title in the same kind updates it.',
  inputSchema: { kind, title: z.string().max(120), body: z.string(),
    shared: z.boolean().optional().describe('Also useful to other projects? Put a lesson or playbook in the shared brain every Holon org searches (e.g. email deliverability, deploy tricks, how to brief free models). Never project secrets or customer data.') },
}, a => call('kb_write', a))

const anyId = z.string().describe('Terminal id of a role in the org (from roles or list_reports)')

server.registerTool('roles', {
  description: 'Every role in the org with its department, grade (G0 free, G1 light, G2 standard, G3 heavy), and record: merges, tasks done, rejections, times stuck, runway spent. Use it to decide promotions and demotions.',
  inputSchema: {},
}, a => call('roles', a))

server.registerTool('set_grade', {
  description: "Promote or demote a role anywhere below you: 0 free, 1 light, 2 standard, 3 heavy. It takes effect when the role next goes quiet; a Claude role that stays on Claude keeps its conversation. Always give the reason from its record.",
  inputSchema: { id: anyId, grade: z.number().int().min(0).max(3), reason: z.string() },
}, a => call('set_grade', a))

server.registerTool('message', {
  description: "Send a message straight to anyone in the org (another department head, a builder, the Director) without going up the chain and without waiting. Use it for reviews, handoffs, questions and status. roles lists everyone's id. A department name (\"QA\", \"Security\") reaches its head; an idle head is closed and a message to it, by name or its old id, wakes a fresh one. Batch what you have into one message.",
  inputSchema: { to: anyId, text: z.string() },
}, a => call('message', a))

server.registerTool('set_directive', {
  description: "Director only. Rewrite the org's directive when the human widens or changes the vision (their messages arrive as \"From the human: ...\"). Keep what still holds, fold in the new, keep the hard rules. Unless the owner turned approval off, this becomes a suggestion they approve or reject; carry on with the current directive meanwhile. Once approved, every department head is sent the new version.",
  inputSchema: { text: z.string(), reason: z.string() },
}, a => call('set_directive', a))

server.registerTool('fire', {
  description: 'Remove a role anywhere below you, and its team, with the reason from its record. Its branch and KB entries stay. A fired department head leaves its seat vacant for the Director to refill.',
  inputSchema: { id: anyId, reason: z.string() },
}, a => call('fire', a))

server.registerTool('promote', {
  description: "Director only. Move a role that has earned it (often a strong G0 builder) into a vacant department seat: it reports to you, gets the department's charter, persona and lead tools, and the grade you give (default: the department's).",
  inputSchema: { id: anyId, dept: z.string(), grade: z.number().int().min(0).max(3).optional() },
}, a => call('promote', a))

server.registerTool('open_department', {
  description: "Director only. Open a department: one from the project's template by name (e.g. Engineering, QA), or a new one you design for this directive by also passing charter, persona, grade and optionally gate (paths: regexes of files it must approve; freeBuilders: it approves every G0 builder's merge). Spawns its head and briefs it. Heads don't count against your report limit.",
  inputSchema: { dept: z.string(), charter: z.string().optional(), persona: z.string().optional(), grade: z.number().int().min(0).max(3).optional(), gate: z.object({ paths: z.array(z.string()).optional(), freeBuilders: z.boolean().optional() }).optional() },
}, a => call('open_department', a))

server.registerTool('approve', {
  description: "Department heads with a gate (e.g. Security, QA): approve a branch you were asked to review, at its current commit. Read the diff first. The requester's lead is told to merge again.",
  inputSchema: { id: anyId, note: z.string().optional() },
}, a => call('approve', a))

server.registerTool('reject', {
  description: 'Department heads with a gate: reject a branch you were asked to review, with a concrete reason (the failing check, the exact line). Counts against the author\'s record; their lead is told to fix it.',
  inputSchema: { id: anyId, reason: z.string() },
}, a => call('reject', a))

server.registerTool('culture', {
  description: "Read the org's CULTURE.md: its values, how decisions get made, and what done means.",
  inputSchema: {},
}, a => call('culture', a))

server.registerTool('set_culture', {
  description: "Director only. Replace CULTURE.md (5-10 short lines). Every role is briefed with it. Others: propose changes to the Director.",
  inputSchema: { text: z.string(), reason: z.string() },
}, a => call('set_culture', a))

await server.connect(new StdioServerTransport())
