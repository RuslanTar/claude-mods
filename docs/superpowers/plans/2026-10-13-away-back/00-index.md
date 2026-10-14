# Autopilot `/away`, `/back`, `/ask-user` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person mark themselves away / back and toggle `--ask-user` per session or globally, so autopilot queues critical questions while they cannot answer and asks them one by one when they return.

**Architecture:** All decisions are pure functions in `autopilot/hooks/autopilot.ts` (records, effective status, ordered mode list, mode-change effects, queue, texts, combined-ping math), unit-tested in `autopilot.test.ts`. `autopilot/hooks/register.tsx` only wires them to engine events: three new commands, one new tool, `prompt.submit`, `turn.start`, the heartbeat, and a persisted `run.pending` delivery queue. Session records live in `$.store`; the global record and the combined-ping lock live under `~/.claude/autopilot/status/`.

**Tech Stack:** Claude Code mod API (engine 2.1.296; CI pins 2.1.295), TypeScript/TSX hooks module, `claude-code/testing` (`describe/test/expect`), `claude plugin test|validate`.

**Spec:** `docs/superpowers/specs/2026-10-13-away-back-ask-user-design.md` (revision 2). Read it before any task.

**Plan files:** this index, then one file per task: `01-…md` … `11-…md` in this folder. Execute in order.

## Global Constraints

- Worktree `~/work/Everlabs/claude-mods-away`, branch `feat/away-back`. **No git commits by agents** — every "Commit" step means: stop and tell the editor which files are ready; the editor makes a signed commit `(<type>): <Subject>` + bullets, without Co-Authored-By.
- Time only through `$.clock.now/after/every` in `register.tsx`; pure functions take `now` as a parameter. No `Date.now()`, no `setTimeout`.
- Human-only commands: refuse unless `e.origin.kind` is `composer` or `bridge` (copy the guard at register.tsx:514-518).
- New `Run`/`Awaiting` fields are optional; every read defaults safely (old stored runs lack them).
- Every read of `run.askUser` goes through the effective status / mode (spec §3.3).
- Queue never drops a question; warn above `QUEUE_WARN = 20`.
- Prompts to the model are delivered only while `run.phase` is `running` or `awaiting` (spec §7.1).
- English for all code, prompts and texts (existing style).
- Tests: `claude plugin test autopilot`; also `claude plugin validate autopilot`. Do not open `node_modules`. Edit files only with Edit/Write tools.
- Bump `autopilot/.claude-plugin/plugin.json` to `0.5.0` (task 11 only).

## Review Focus

1. `/away until 00:10` typed at 23:55, and around a DST change — must resolve to the next occurrence in the session's UTC offset, within `MAX_AHEAD_MS`; tested in task 02.
2. `global.json` missing, empty, half-written or with a `setAt` far in the future — the session keeps the last good value and never throws; tested in task 01 (`validAvail`) and task 07 (reader).
3. A session with **no autopilot run** that sees a `--global` change or a global expiry — no prompt is ever submitted into that conversation; guarded in task 07 (`refreshMode($)` returns `null` and never calls `applyMode` when there is no run), tested in task 06 (`eligibleForCombined(null, …)` is false), checked live in task 11 (L10).
4. `/away` then `/back` (or `/ask-user off` then `on`) inside one heartbeat — exactly one `drain` pending, no duplicates of the same kind; tested in task 04 (`pushPending` dedupes by kind+key).
5. Hot reload in the middle of draining (module variable `lastSubmitHuman` resets to false) — no question is removed unless a human prompt was seen after the reload; the guard is the `lastSubmitHuman` check in task 09 (`turn.start` calls `answeredQuestion` only when it is true, and `prompt.submit` sets it only while the run awaits a `user-answer`/`user-input` wait, so no question is removed unasked — spec §5.2); `askingId` is stored on the run, so unit tests cannot cover a reload — checked live in task 09 Step 4 item 6 and task 11 L8.

---

## Interface contract (all tasks use exactly these names)

### `autopilot/types/index.d.ts` (task 01)

```ts
export type Mode = 'plain' | 'queueing' | 'overdue' | 'draining' | 'asking'

export type AwayField = { until: number; setAt: number } | { back: true; setAt: number }
export type AskField = { on: boolean; setAt: number }
/** Availability record, session ($.store `away:<sid>`) or global (~/.claude/autopilot/status/global.json). */
export type Avail = { v: 1; away: AwayField | null; askUser: AskField | null }

export type Effective = {
  away: AwayField | null
  awaySource: 'session' | 'global' | null
  /** Effective ask-user: the record if any, else the run's --ask-user flag. */
  askOn: boolean
  /** Whether any level holds an askUser record (D5: no record + flag off = plain). */
  askRecorded: boolean
}

export type Question = { id: number; text: string; kind: 'answer' | 'action'; provisional: string | null; at: number }
export type QueueInput = { question: string; kind: 'answer' | 'action'; provisional: string | null }

export type Pending = { kind: 'ping' | 'combined-ping' | 'drain' | 'continue'; text: string; key: number }

export type AvailCommand =
  | { kind: 'away'; end: { kind: 'duration'; ms: number } | { kind: 'clock'; hours: number; minutes: number }; global: boolean }
  | { kind: 'back'; global: boolean }
  | { kind: 'ask-user'; on: boolean; global: boolean }
  | { kind: 'error'; message: string }

/** What the combined ping reads from other sessions' badge files. */
export type BadgeAvail = { queued: number; awaySource: 'session' | 'global' | null; awaySetAt: number | null; beat: number }
export type LockOwner = { sid: string; at: number }
```

`Run` gains: `questions?: Question[]; nextQuestionId?: number; drain?: boolean; askingId?: number; pingedFor?: number; pending?: Pending[]; lastMode?: Mode`. `nextQuestionId` is the next id to hand out, so ids are never reused (spec §3.1).
`Awaiting` gains: `questionId?: number`.

### `autopilot/hooks/autopilot.ts` — new / changed exports

| Task | Export | Signature |
|---|---|---|
| 01 | `validAvail` | `(value: unknown, now: number): Avail \| null` — rejects wrong shape and `setAt > now + 5 min` |
| 01 | `effective` | `(run: Run \| null, session: Avail \| null, global: Avail \| null): Effective` |
| 01 | `isAwayActive` / `isAwayExpired` | `(away: AwayField \| null, now: number): boolean` |
| 01 | `availMode` | `(run: Run, eff: Effective, now: number): Mode` — ordered list, spec §4 |
| 07 | `globalFromText` | `(text: string \| null, now: number, last: Avail \| null): Avail \| null` — parse `global.json` text via `validAvail`; on missing / empty / half-written / invalid keeps `last` (added right after `validAvail`) |
| 02 | `parseAway` | `(args: string): AvailCommand` |
| 02 | `parseBack` | `(args: string): AvailCommand` |
| 02 | `parseAskUser` | `(args: string): AvailCommand` |
| 02 | `awayUntil` | `(end: Extract<AvailCommand, {kind:'away'}>['end'], now: number, offsetMinutes: number): number \| string` — epoch ms, or an error text (below `MIN_LEAD_MS` / beyond `MAX_AHEAD_MS`) |
| 02 | `applyAvail` | `(rec: Avail \| null, cmd: Exclude<AvailCommand, {kind:'error'}>, until: number \| null, now: number): Avail` |
| 03 | `QUEUE_WARN` | `20` |
| 03 | `QUEUE_TOOL` / `FULL_QUEUE_TOOL` | `'queue_question'` / `` `mcp__autopilot__${QUEUE_TOOL}` `` |
| 03 | `parseQueueInput` | `(input: unknown): QueueInput \| string` (string = error text) |
| 03 | `stripTag` | `(text: string): string` — removes a leading `#k` and spaces |
| 03 | `addQuestion` | `(run: Run, input: QueueInput, now: number): { run: Run; id: number; isNew: boolean; warn: boolean }` — dedupe on stripped text; new id = `max(run.nextQuestionId ?? 1, max(ids, askingId, awaiting.questionId) + 1)`, then bumps `run.nextQuestionId` (ids never reused) |
| 03 | `questionIdFromNote` | `(note: string \| null, questions: readonly Question[]): number \| null` |
| 03 | `answeredQuestion` | `(run: Run): Run` — removes `awaiting.questionId` ?? `askingId`; clears `drain`/`askingId` when the queue empties |
| 04 | `pushPending` | `(run: Run, p: Pending): Run` — dedupe by `kind`+`key` |
| 04 | `deliveredPending` | `(run: Run, p: Pending): Run` — removes it; for `ping` sets `pingedFor = p.key` |
| 04 | `canDeliver` | `(phase: Phase): boolean` — `running` \| `awaiting` |
| 04 | `applyMode` | `(run: Run, next: Mode, eff: Effective, now: number): { run: Run; combined: boolean }` — spec §5.1 using `run.lastMode` as prev; sets `lastMode = next`; `next === 'queueing'` also drops pending `ping` / `combined-ping` (the away is not over: D4, R8); `combined` is informational (logged by `refreshMode`) |
| 04 | `humanSubmit` | `(run: Run, mode: Mode): Run` — `overdue` → `drain = true`; else unchanged |
| 04 | `RELEASE_PROMPT` | `string` — the `continue` text after a wait is released into the queue (spec §5.1 row 1) |
| 04 | `RELEASE_UNQUEUED_PROMPT` | `string` — the `continue` text when a released wait had no note, so nothing was queued: tells the model to call `queue_question` itself (spec §5.1 row 1; fix round after task 04 review) |
| 04 | `criticalCount` | `(n: number): string` — `'1 critical question is'` / `'N critical questions are'`; the one count text for every ping and toast (05, 10 reuse it) |
| 04 | `askQuestionText` | `(q: Question): string` — how to ask one queued question (quoted text, then `wait_for` with the `#k` note); used by `drainPrompt` and 05's draining role line |
| 04 | `expiryPingText` | `(n: number): string` — built on `criticalCount`; defined only here |
| 04 | `drainPrompt` | `(q: Question, left: number): string` — `left` = questions queued, the asked one included; count prefix + `askQuestionText(q)` + "New critical questions still go through queue_question."; defined only here |
| 04 | `quoteValue` (module-private, changed) | `(value: string, max = MAX_SHOWN_VALUE): string` — the one quoting helper; 04/05 pass `MAX_QUESTION` / `MAX_PROVISIONAL` (task 03) |
| 05 | `waitRefusal` | **changed**: `(awaiting: Awaiting, mode: Mode): string \| null` |
| 05 | `askAnswer` | **changed**: `(mode: Mode): string` |
| 05 | `roleSection` | **changed**: `(run: Run, now: number, mode?: Mode): string` — default mode `run.askUser === true ? 'asking' : 'plain'` |
| 05 | `drainingQuestion` | `(run: Run): Question \| null` — the head question |
| 05 | `queuedAcross` | `(total: number, sessions: number): string` — `criticalCount(total)` + `queued across N session(s)`; used by `combinedPingText` and task 10's toast |
| 05 | `queuedResult` / `combinedPingText` / `questionsBlock` / `availStatusLines` | `(id: number, warn: boolean): string` / `(total: number, sessions: number): string` (built on `queuedAcross`) / `(run: Run): string` (empty string when no questions) / `(eff: Effective, mode: Mode \| null, run: Run \| null, now: number, offsetMinutes: number \| null): string[]` — `availStatusLines` prints the single ask-user status line |
| 05 | `wrapupPrompt` / `finalPrompt` / `PAUSED_SECTION` users | include `questionsBlock(run)` |
| 06 | `HEARTBEAT_MS` | `30_000` (export it if the constant lives only in register.tsx; register then imports it) |
| 06 | `eligibleForCombined` | `(run: Run \| null, eff: Effective, mode: Mode \| null, globalSetAt: number): boolean` |
| 06 | `sumQueued` | `(badges: readonly BadgeAvail[], setAt: number, now: number): { total: number; sessions: number }` — counts `beat` within `2 * HEARTBEAT_MS` |
| 06 | `lockStale` | `(owner: LockOwner \| null, done: boolean, now: number): boolean` |
| 10 | `parseBadgeAvail` | `(value: unknown): BadgeAvail \| null` — null on wrong shape |
| 10 | `parseLockOwner` | `(value: unknown): LockOwner \| null` — null on wrong shape |

### `autopilot/hooks/register.tsx` — new module helpers (tasks 07–10)

Every helper that touches the engine takes `$: EngineInterface` as its **first** parameter; every call passes `$`.

| Task | Helper | Role |
|---|---|---|
| 07 | `statusDir(): string`, `globalFile(): string` (functions, not constants) | `${autopilotDir()}/status`, `${statusDir()}/global.json` |
| 07 | `readSessionAvail($: EngineInterface): Promise<Avail \| null>` / `writeSessionAvail($: EngineInterface, rec: Avail): Promise<void>` | `$.store` key `away:<sessionId>` |
| 07 | `readGlobalAvail($: EngineInterface, force = false): Promise<Avail \| null>` / `writeGlobalAvail($: EngineInterface, rec: Avail): Promise<void>` | mtime cache, last good value via `globalFromText`, tmp + `/bin/mv` |
| 07 | `currentEffective($: EngineInterface): Promise<Effective>` | `effective(run, session, global)` |
| 07 | `refreshMode($: EngineInterface): Promise<Mode \| null>` | recompute, `applyMode`, save, log (also logs `applyMode().combined`, which is informational; the combined ping comes only from task 10's heartbeat `combinedTick($)`); `null` (and no `applyMode`) when no run. Triggers: commands and status (08), `wait_for`/AskUserQuestion (07), `queue_question`/`prompt.submit`/`turn.start` (09), heartbeat (10). `prompt.compose` does **not** call it: compose only reads the mode from the cached records (no I/O, no effects) and records `askingId` |
| 07 | `askOnNow(): boolean` | sync accessor used where `run.askUser` was read (no `$`) |
| 07 | `statusText(now, isAskShown = true)` | owns the status text; prints its ask-user line by default (start reply); the status branch (08) passes `false` so `availStatusLines` prints the single ask-user line |
| 08 | `command.run` handlers for `away`, `back`, `ask-user` | parse → write record → `refreshMode($)` → reply; status calls `refreshMode($)` before `statusText(now)` |
| 09 | `queue_question` tool handler, `prompt.submit` hook, `lastSubmitHuman` module flag | `lastSubmitHuman` is set only for an idle person's prompt in `draining` while the run awaits a `user-answer`/`user-input` wait (spec §5.2); `turn.start` calls `await refreshMode($)` after `endWait` |
| 10 | `flushPending($: EngineInterface, via: 'tool' \| 'turn' \| 'idle'): Promise<string \| null>` | delivery of `run.pending`: `tool` returns the text for the caller's `context`; `turn`/`idle` schedule one submit (non-null = a prompt is on its way); null when nothing can be delivered |
| 10 | `combinedTick($: EngineInterface): Promise<void>` | lock (`${statusDir()}/ping-<setAt>.lock`), wait one beat after expiry, sum, pending `combined-ping`; `done` written by `markDelivered`; an owner holding its pending `combined-ping` keeps refreshing `owner.json` whatever its eligibility (one ping, R9). Non-owner eligible sessions and runs outside `running`/`awaiting` toast once per global `setAt` (module `Set` `heldToasts`) |

## Tasks

| # | File | Deliverable |
|---|---|---|
| 01 | `01-types-effective-mode.md` | types; `validAvail`, `effective`, `isAwayActive/Expired`, `availMode` + tests |
| 02 | `02-parsers.md` | `parseAway`, `parseBack`, `parseAskUser`, `awayUntil`, `applyAvail` + tests |
| 03 | `03-queue.md` | queue constants and functions (ids never reused via `nextQuestionId`) + tests |
| 04 | `04-mode-effects-pending.md` | `pushPending`, `deliveredPending`, `canDeliver`, `applyMode`, `humanSubmit`, `RELEASE_PROMPT`, `criticalCount`, `askQuestionText`, `expiryPingText`, `drainPrompt` (`quoteValue` gains a cap) + tests |
| 05 | `05-model-texts.md` | mode-aware `roleSection`/`waitRefusal`/`askAnswer`, texts (`queuedAcross`, `combinedPingText`, `queuedResult`), question lists + tests (existing call sites in register.tsx keep compiling) |
| 06 | `06-combined-math.md` | `HEARTBEAT_MS`, `eligibleForCombined`, `sumQueued`, `lockStale` + tests |
| 07 | `07-register-storage-mode.md` | storage, `syncId` move, sweep, badge fields, `refreshMode`, all `run.askUser` reads replaced |
| 08 | `08-register-commands.md` | `/away`, `/back`, `/ask-user` commands, status text |
| 09 | `09-register-queue-tool-human-input.md` | `queue_question` tool, `wait_for` tagging, `prompt.submit`, `turn.start` removal |
| 10 | `10-register-delivery-heartbeat.md` | `run.pending` delivery, heartbeat block, combined-ping lock |
| 11 | `11-docs-version-live-check.md` | README, version 0.5.0, validate, live checklist |
