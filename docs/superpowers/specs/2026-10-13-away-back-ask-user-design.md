# Autopilot: `/away`, `/back`, `/ask-user` — design

Date: 2026-10-13 · Branch: `feat/away-back` · Target version: autopilot 0.5.0
Engine: Claude Code 2.1.296 (typings checked: `prompt.submit` carries `origin.kind`; `CommandSpec.immediate` exists).
Revision 2: after an adversarial review (17 confirmed findings folded in).

## 1. Goal

A person running autopilot sessions with `--ask-user` cannot always answer (in a meeting, asleep, or wanting to talk to one session only for a while). They need to:

- say "I'm away for 1h / until 15:00" — the session keeps working like a run without `--ask-user`, but parks its **critical** questions in a queue instead of stopping;
- come back — the session asks the queued questions **one by one** with the existing mechanism (question as text + `wait_for user-answer`);
- turn `--ask-user` on or off for a running session at any time.

Success: no critical question is lost, duplicated or silently decided while the person is away; on return they get exactly one question at a time; nothing changes for runs that never use the new commands.

## 2. Agreed requirements (from the person)

| # | Requirement |
|---|---|
| R1 | Separate commands, not `/autopilot` flags: `/away for <duration>` \| `/away until <clock>`, `/back`, `/ask-user on\|off`. |
| R2 | Each takes `--global`. Default scope = current session; `--global` = all sessions. |
| R3 | `/away` without a time is an error. |
| R4 | Status is stored even when no autopilot run is active; it applies to a later run (this session, or all sessions if global). |
| R5 | Session status **always** beats global status (per field, even when older). |
| R6 | While away: ordinary questions are decided by the model (as without `--ask-user`); **only critical questions** (where `--ask-user` would stop and `wait_for user-answer`) go to a queue, with an optional provisional decision; the session keeps working on what is not blocked. |
| R7 | Away expires with an empty queue → silently available, no ping. |
| R8 | Away expires with a non-empty queue → **one** ping ("N questions waiting"), then keep working without asking until the person writes in the session. No repeat pings. |
| R9 | A global away that expires → **one combined** ping across sessions ("7 questions in 3 sessions"), not one per session. |
| R10 | Person writes in the session **after** expiry → start asking the queue one by one. Writing **before** expiry is ignored for this purpose (they use `/back`). |
| R11 | `/back` → start asking right away. |
| R12 | `/ask-user off` → like an open-ended away: critical questions are queued. `/ask-user on` → enables asking; if not away, starts draining the queue. |
| R13 | `/ask-user on` during an active `/away` only flips the toggle; away still holds until its time. |
| R14 | Questions are asked as now: text + `wait_for user-answer`, one at a time. `AskUserQuestion` stays denied. |

Defaults chosen by the lead (not objected to):

- D1 New model tool name: `queue_question`.
- D2 Unanswered questions at run end go into the final handoff.
- D3 A session record does not follow the person's own `/clear` (new session id); it follows the run's own restart (`syncId`, register.tsx:279-283).
- D4 `/away` ends while `--ask-user` is off → the session stays in queue mode, **no ping** (an open-ended away never pings; the person turned asking off themselves).
- D5 A run started **without** `--ask-user` and with no `askUser` record anywhere keeps today's behaviour exactly (no queue). `/away` on such a run is stored but changes nothing until `/ask-user on`.
- D6 The queue never drops a question. Above 20 entries `queue_question` still accepts, with a toast warning.

## 3. State

### 3.1 Records and run fields (types/index.d.ts)

```ts
type Avail = {
  v: 1;
  away: { until: number; setAt: number } | { back: true; setAt: number } | null; // null = not set at this level
  askUser: { on: boolean; setAt: number } | null;                                // null = not set at this level
};

type Question = {
  id: number;                 // 1..n within the run, never reused
  text: string;               // as the person will read it, without any "#k" tag
  kind: 'answer' | 'action';
  provisional: string | null; // what the model does meanwhile, if anything
  at: number;
};

type Pending = {              // a prompt that must reach the model, kept until delivered
  kind: 'ping' | 'combined-ping' | 'drain' | 'continue';
  text: string;
  key: number;                // away.setAt for pings; 0 otherwise
};
```

`Run` gains optional fields (old stored runs lack them; every read defaults safely):

- `questions?: Question[]`
- `drain?: boolean` — draining is active
- `askingId?: number` — the question the current drain role section names
- `pingedFor?: number` — session away `setAt` whose ping was **delivered**
- `pending?: Pending[]` — prompts awaiting delivery (§7.1)
- `lastMode?: Mode` — the mode the last heartbeat or command acted on (§5.1)

`Awaiting` gains `questionId?: number`.

### 3.2 Storage

| Record | Where | Writer |
|---|---|---|
| Session | `$.store` key `away:<sessionId>` | that session only |
| Global | `~/.claude/autopilot/status/global.json` (dir `chmod 700`, as register.tsx:437-440) | any session; written to `global.json.tmp-<sid>` then `/bin/mv` (atomic rename) |
| Combined-ping lock | `~/.claude/autopilot/status/ping-<setAt>.lock/` (mkdir), with `owner.json` `{sid, at}` and, once delivered, `done` | see §7.3 |

- Readers of `global.json` wrap the parse in try/catch, keep the last good value, and reject a `setAt` more than 5 min in the future. The heartbeat re-reads it only when its `mtimeMs` changed. `--global` with `HOME` unset is refused with a toast.
- `syncId`'s run-restart branch (register.tsx:279-283) also moves `away:<old>` to `away:<new>` and deletes the old key (D3).
- `sweepFinished` also removes `ping-*.lock` directories older than 24 h.
- The badge file (`save()`, register.tsx:131-157) gains fields `validBadge` ignores (fleet.ts:246-273): `queued` (count), `awaySource` (`'session' | 'global' | null`), `awaySetAt`, `beat` (last heartbeat time). Used only by the combined ping (§7.3).

### 3.3 Effective status (pure, per field — R5)

```
away    = session.away    ?? global.away    ?? null   // with its source; {back} = not away
askUser = session.askUser ?? global.askUser ?? null
askOn   = askUser ? askUser.on : run.askUser === true
awayActive  = away is {until} and now < until
awayExpired = away is {until} and now >= until
```

**Every** existing read of `run.askUser` is replaced by the effective `askOn` (or the mode): `roleSection` (autopilot.ts:937, :944), `waitRefusal` (register.tsx:760), `askAnswer` (register.tsx:881), `statusText` (register.tsx:424). Without this, `/ask-user on` on a run started without the flag would have no effect.

## 4. Modes

`availMode(run, session, global, now)` is an **ordered** decision list; the first match wins:

| # | Mode | Condition | Model behaviour |
|---|---|---|---|
| 1 | `plain` | no `askUser` record anywhere and `run.askUser !== true` (D5) | today's no-ask behaviour, no queue |
| 2 | `queueing` | `askOn` is false (an `askUser` record says off) | decide ordinary questions; `queue_question` for critical ones; keep working |
| 3 | `queueing` | `awayActive` | same |
| 4 | `draining` | `run.drain` and queue non-empty | ask the named question via text + `wait_for user-answer`; new critical questions still go through `queue_question` (appended to the tail) |
| 5 | `overdue` | `awayExpired` and queue non-empty, and asking was not turned on after the away ended (`askSetAt < away.until`; else the person is here → `asking`, R12; final-review fix I1, 2026-10-14) | as `queueing` (no asking); the one ping is pending or delivered |
| 6 | `asking` | otherwise | today's `--ask-user` behaviour |

`run.phase` gates **delivery**, not the mode: prompts are delivered only while the phase is `running` or `awaiting` (§7.1). Draining ends when the queue is empty (`drain=false`, `askingId` cleared).

## 5. Transitions

### 5.1 Mode change rule (one place, all triggers)

`modeEffects(prev, next, run)` is pure and returns effects; it runs after **every** trigger that can change the mode: each command, every heartbeat (including a `global.json` change made by another session — R2), `prompt.submit`, `turn.start`. Then `run.lastMode = next`.

| prev → next | Effects |
|---|---|
| any → `queueing` while the run awaits `user-*` | release the wait: if `awaiting.questionId` is set, just end the wait (the question is still queued); otherwise put the note (with any `#k` tag stripped) at the queue head. Then `drain=false` and pending `continue`: `RELEASE_PROMPT` when the question is queued (tagged, or a non-empty note, or the same text already queued); `RELEASE_UNQUEUED_PROMPT` when the wait had no note — the model is told the question was **not** queued and must put it through `queue_question` itself (editor's decision 2026-10-14: a note is optional on `wait_for`, so nothing may claim a question is queued when it is not). |
| any → `queueing` (no wait) | `drain=false`, `askingId` cleared |
| any → `asking` with queue non-empty | `drain=true`; undelivered `ping` and `combined-ping` dropped (the person is back; editor's decision 2026-10-14); pending `drain` (`drainPrompt`) — so `/back`, `/ask-user on`, their `--global` forms in other sessions, and expiry-then-write all start the drain the same way |
| `queueing` → `overdue` (away just expired, queue non-empty, `askOn`) | if the away source is **session** and `pingedFor !== away.setAt`: pending `ping`. If the source is **global**: §7.3. |
| `queueing` → `asking` with queue empty (away expired) | nothing — silent (R7) |

### 5.2 Triggers

| Trigger | Writes | Then |
|---|---|---|
| `/away for X` \| `until T` | `away={until,setAt}` at scope | mode rule |
| `/back` | `away={back,setAt}` at scope (global form replaces only the global `away`; session records untouched — R5) | mode rule; from `overdue`/`queueing`-by-away to `asking` → drain |
| `/ask-user off` | `askUser={on:false}` at scope | mode rule (→ `queueing`, releases a wait — R12) |
| `/ask-user on` | `askUser={on:true}` at scope | mode rule (if still away: stays `queueing` — R13) |
| `prompt.submit`, `origin.kind` composer\|bridge, mode `overdue` | `drain=true` | mode → `draining` (R10) |
| same, mode `queueing` | nothing (R10) | — |
| same, mode `draining`, **only while** `run.phase` is `awaiting` with reason `user-answer` or `user-input` (the question was put to the person) | remember `lastSubmitHuman` | at the next `turn.start`: remove `awaiting.questionId` if set, else `askingId`; then `endWait` |
| same, mode `draining`, no such wait (the drain prompt not yet delivered, or the question not yet asked) | nothing | the prompt reaches the model as usual; nothing is removed, so a question never leaves the queue unasked (e.g. "hi" typed right after `/back`) |
| non-human prompt during `draining` (task-notification, peer, scheduled, plugin) | — | ends the wait as today; the question stays queued |
| `wait_for user-*` in `draining` | `questionId` = `k` only if the note carries `#k` **and** `k` is in the queue | untagged otherwise (nothing is removed by mistake) |
| run ends with questions left | — | listed in `finalPrompt` / `wrapupPrompt` / `PAUSED_SECTION` (D2) |
| a new `/autopilot` run starts in a session whose run still had questions | the new run keeps `questions` + `nextQuestionId` | asked when asking is on; the start reply says how many were kept (editor's decision 2026-10-14, final-review I2 option A) |
| `/autopilot 0 0 stop` with questions left | — | the reply lists them (`questionsBlock`); nothing is asked after the stop |

## 6. Commands

All three: registered in `session.start` with `immediate: true`; served by `command.run`; refused unless `e.origin.kind` is `composer` or `bridge` (copy register.tsx:514-518); reply `{ text }` with scope, effective status and its source, end time, queue count.

Grammar (pure parsers in `autopilot.ts`, reusing `parseDuration` :62, `parseClock` :154, `untilFromClock` :180, `takeSwitch` :329, `MIN_LEAD_MS` :78, `MAX_AHEAD_MS` :151 — all module-private, so the parsers stay in this file):

```
/away for <duration> [--global]     # 90m, 2h, 1h30m
/away until <clock> [--global]      # 15:00, 6pm (next occurrence < 24h)
/back [--global]
/ask-user on|off [--global]
```

Errors (toast + text, nothing written): bare `/away`, unknown word, duration below `MIN_LEAD_MS` or beyond `MAX_AHEAD_MS`, `--global` without `HOME`.

`/autopilot` with no run still prints the effective status and its source (session/global, age).

## 7. Delivery and pings

### 7.1 Pending prompts

There is no push API in the mod; a ping is `$.ui.toast` plus an instruction to the model to send exactly one PushNotification (< 200 chars). Every prompt the feature must get to the model (`ping`, `combined-ping`, `drain`, `continue`) is appended to `run.pending` and saved, then delivered by the first of:

1. the next generic `tool.call` of a running turn — appended to its `context` (as limits do, register.tsx:896-897);
2. `turn.complete` — the next prompt is the pending text instead of `CONTINUE_PROMPT`;
3. the heartbeat, when idle — `queue(text)`; kept pending if `queue` dropped it (register.tsx:184-189).

Only while `run.phase` is `running` or `awaiting`. In `waiting` (5-hour park), `paused`, `restarting`, `resuming`, `wrapping`, `final`: toast only, the entry stays pending and is flushed when the run returns to `running` (`wake`, resume-done, revive). An entry is removed — and for a ping `pingedFor` set — only once handed to the model. A reload keeps it (it is on the stored run).

### 7.2 Session expiry ping (R8)

Text (`expiryPingText`, existing "Autopilot:" style; N via `criticalCount`, so "1 critical question is"): `"Autopilot: the away time is over; N critical questions are queued. Send one PushNotification saying so (under 200 characters), then keep working without asking until the person writes in this session."` Only for a session-sourced away, only when `askOn` (D4).

### 7.3 Global expiry, combined ping (R9)

- Eligible: sessions whose effective away is that global record (`awaySource='global'`, same `awaySetAt`), `askOn`, with a run in `running` or `awaiting`. Others only toast.
- An eligible session creates `ping-<setAt>.lock` (mkdir, atomic) and writes `owner.json`. If the lock exists without `done` and `owner.json.at` is older than 2 heartbeats, an eligible session replaces the owner and takes over.
- The owner waits one heartbeat (≤ 30 s), then sums `queued` over badge files with `awaySource='global'`, the same `awaySetAt`, and `beat` newer than 2 heartbeats (dead sessions do not count). Sum > 0 → pending `combined-ping` in its own run ("7 questions in 3 sessions"); sum 0 → nothing (R7).
- On delivery the owner writes `done` into the lock (and remembers it in memory, so a failed `done` write never repeats the ping). `global.json` is never written by the ping (no lost update of a concurrent `/away --global`).
- A session in `draining` (the person is back there) neither sends, claims nor refreshes the lock; its undelivered `combined-ping` is dropped at drain start (§5.1). After 2 heartbeats another eligible session takes over and sends the one ping (editor's decision 2026-10-14).
- No combined ping 24 h (`LOCK_TTL_MS`) or more after the global away's end: it is moot, and the stale-lock sweep may have removed its lock (editor's decision 2026-10-14).

## 8. Model-facing changes

- New tool `queue_question({ question, kind, provisional? })`, registered next to `wait_for` (register.tsx:467-481). Accepted in `queueing`, `overdue` and `draining`; otherwise returns an error pointing to `wait_for`. Strips a leading `#k`; dedupes on identical text; never drops (D6). Result: `"Queued #n. Keep working on what is not blocked by it."` Logged and toasted.
- `waitRefusal(awaiting, mode)`: in `queueing`/`overdue` refuse `user-*` and point to `queue_question`; in `plain` refuse as today; in `asking`/`draining` accept (tagging per §5.2).
- `askAnswer(mode)` for the `AskUserQuestion` deny text (register.tsx:877-882): stays a deny in every mode.
- `roleSection(run, now, mode)` (autopilot.ts:921):
  - `queueing`/`overdue`: today's no-ask text (:941-943) without the per-question PushNotification line, plus the queue rule, plus "if everything is blocked by queued questions: `wait_for` reason `other`, from `the person (queued)`" (avoids the idle pause, autopilot.ts:632).
  - `draining`: names exactly one question `#k` (sets `askingId`) with its provisional choice; ask it as text, `wait_for user-answer` with note `#k …`, end the turn; new critical questions → `queue_question`.
  - `asking`: today's ask text, now chosen by mode instead of `run.askUser`.
  - `plain`: unchanged.

## 9. Files

| File | Change |
|---|---|
| `autopilot/types/index.d.ts` | `Avail`, `Question`, `Pending`, `Mode`, optional `Run`/`Awaiting` fields, command types |
| `autopilot/hooks/autopilot.ts` | pure: `parseAway`, `parseBack`, `parseAskUser`, `validAvail`, `effective`, `availMode`, `modeEffects`, `parseQueueInput`, `questionIdFromNote`, `waitRefusal`, `askAnswer`, `roleSection` branches, `eligibleForCombined`, `sumQueued`, texts (`queuedResult`, `expiryPingText`, `combinedPingText`, `drainPrompt`, `availStatusLines`), queue in `PAUSED_SECTION`/`finalPrompt`/`wrapupPrompt` |
| `autopilot/hooks/register.tsx` | 3 commands + handlers; `queue_question` tool; `prompt.submit` hook; `turn.start` removal; heartbeat block **before** the `!run \|\| isTurnRunning` guard (:484-487) for the global re-read and mode rule; `run.pending` delivery in generic `tool.call`, `turn.complete`, heartbeat and the return-to-running paths; global file read/write; lock; `syncId` key move; `sweepFinished` lock cleanup; badge fields; status text; all `run.askUser` reads → effective |
| `autopilot/hooks/autopilot.test.ts` | tests below |
| `README.md` (repo root) | commands table and grammar (README.md:5-8, 49-91) |
| `autopilot/.claude-plugin/plugin.json` | 0.4.2 → 0.5.0 |

Not changed: agent-fleet (badge stays compatible).

## 10. Tests (`claude plugin test autopilot`)

Pure functions only, `now` passed as a constant (existing style, autopilot.test.ts:366-380), `run(over)` factory (:56-78):

- parsers: every valid form, every error, `--global` anywhere in args;
- `effective`: session beats global per field, even when older; `{back}` at session hides a global away; `askOn` from record vs run flag;
- `availMode`: the ordered list over askUser flag/record × away none/active/expired/back × queue empty/non-empty × drain; D5 (`plain`); D4 (`queueing`, never `overdue`, when off);
- `modeEffects`: every row of §5.1, incl. release with and without `questionId` (no duplicate), global-triggered `→ asking` drains, no ping when off or when the away is global-sourced;
- tagging: `#k` present in queue / absent / not in queue; removal by `questionId` vs `askingId`;
- `queue_question` input: `#k` stripped, dedupe, > 20 accepted;
- `eligibleForCombined` / `sumQueued`: stale `beat`, other `awaySetAt`, session-sourced away excluded;
- `waitRefusal`/`askAnswer` per mode; `roleSection` text per mode (`asking` on a run started without the flag); queue listed in pause/final/wrap-up texts;
- an old stored run without the new fields behaves as today.

Also `claude plugin validate autopilot`. Wiring in `register.tsx` has no fakes (README.md:119), so it is checked by hand in a live session: away → queue → expire → ping → write → drain; `/back`; `/ask-user off/on` (incl. a wait released into the queue); `--global` across two sessions (other session drains on global `/back`; one combined ping); ping held while parked and delivered after wake; run restart keeps the session record.

## 11. Risks

- Whether a typed slash command also fires `prompt.submit` is not documented; the design does not depend on it.
- `$.store` freshness across processes is not documented; it is used only for single-session keys.
- The model must send exactly one PushNotification and tag its note with `#k`; an untagged note removes nothing (the `askingId` fallback covers the answer).
- The combined ping waits up to one extra heartbeat (≤ 30 s) after expiry, and up to two more if the lock owner died.
