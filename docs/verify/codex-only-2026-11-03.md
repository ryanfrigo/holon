# Codex-only install check (G2), 2026-11-03

**Result: pass.** A machine with Codex and no Claude Code clones Holon, installs, passes the tests, and gets a working org. No bugs found beyond 0872e6c (already fixed by the previous seat).

## Setup
- Commit under test: 0872e6c (branch `self`), cloned from the local repo into a fresh `mktemp -d` sandbox.
- `HOME=$SB/home`; PATH dir `$SB/bin` holds symlinks to node, npm, npx, git, codex only, plus `/usr/bin:/bin`. `PATH=$SB/bin command -v claude` prints nothing (confirmed "no claude").
- Only `auth.json` and `config.toml` copied to `$SB/home/.codex`. Not printed.
- Before starting: found a leftover daemon from the previous attempt (a daemon.ts, its `npm run daemon` parent, and a codex seat plus its MCP server, all under an older mktemp dir). Killed those only; nothing under ~/.holon or the real daemons was touched.
- The daemon listens on a unix socket under the sandbox HOME (`$SB/home/.holon/holon.sock`), so there is no TCP port to collide with the real daemons.

## Steps (all under `env -i HOME=$SB/home PATH=$SB/bin:/usr/bin:/bin`)
1. `npm install`: ok.
2. `npm test`: **55 files, 400 tests passed** in 132 s (no claude on PATH).
3. `npm run daemon &`: `holon daemon listening on .../home/.holon/holon.sock`.
4. Workspace: `git init` repo with one empty commit.
5. `node scripts/start-org.ts $SB/proj "create hello.txt containing hi"` printed `org started: Director director-c19d (codex)`.
6. Waited, polled `node scripts/status.ts`.

## Results
- Director spawned as **codex** (model gpt-6-astra), no question about claude, no "claude not found" error. The daemon log has zero mentions of claude.
- The Director reached its prompt, spun up Strategy (codex) then Delivery plus a builder `t-d7a2 hello.txt` (codex gpt-6-luna).
- `hello.txt` exists in the workspace and contains `hi`; commit `110185f Add hello.txt` was made by the org.

## Not covered
- The Electron app and its onboarding UI were not run (headless path via start-org.ts only). The defaultCli choice was verified through the spawn path (`defaultCli()` in packages/core/src/holon.ts picks codex when claude isn't installed), not by looking at a settings screen.
- Only the Director/department/builder path was run; no reviewer or merge-queue flow.

## Cleanup
Daemon, codex seats and MCP servers started here were killed; `ps` shows nothing left under the sandbox dir.
