### Task 11: README, version 0.5.0, validate, live checklist

**Files:**
- Modify: `README.md` (repo root) — line 8 (commands table, `autopilot` row), line 80 (`--ask-user` bullet), line 88 (`wait_for` reasons bullet), insert a new `### Away, back and ask-user` subsection between line 91 (`- Log: ...`) and line 93 (`## agent-fleet`)
- Modify: `autopilot/.claude-plugin/plugin.json` — line 3 (`"version": "0.4.2"` → `"0.5.0"`)
- Test: no new unit tests (no code in this task). Checks: `claude plugin test autopilot`, `claude plugin validate autopilot`, two `grep` checks, and the live checklist in Step 4b (spec §10 plus the live halves of Review Focus 3 and 5).

**Interfaces:**
- Consumes (behaviour documented and checked live, names exactly as in the contract): commands `/away`, `/back`, `/ask-user` (task 08); tool `queue_question` = `QUEUE_TOOL`, result `queuedResult(id, warn)` = `"Queued #n. Keep working on what is not blocked by it."` (tasks 03, 05, 09); `QUEUE_WARN = 20` (task 03); `expiryPingText(n)` (task 04, spec §7.2); `combinedPingText(total, sessions)` (task 05, spec §7.3); `drainPrompt(q, left)` (task 04); `availStatusLines(eff, mode, run, now, offsetMinutes)` in `/autopilot` (tasks 05, 08); `flushPending($, via)` and `combinedTick($)` (task 10); `statusDir()` = `~/.claude/autopilot/status`, `globalFile()` = `…/global.json`, lock `ping-<setAt>.lock/` with `owner.json` and `done` (tasks 07, 10); `HEARTBEAT_MS = 30_000` (task 06); `lastSubmitHuman` (task 09).
- Produces: nothing for other tasks. Plugin version `0.5.0`.

Do not change README line 19 (`#v0.4.2` install tag): the tag `v0.5.0` exists only after the release; the editor bumps that line when tagging.

- [ ] **Step 1: Write the failing check**

There is no code to unit-test, so the "test" is two greps that must find the new version and the new grammar. Run from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`:

```bash
grep -n '"version": "0.5.0"' autopilot/.claude-plugin/plugin.json
grep -n '^/away for <duration> \[--global\]' README.md
```

- [ ] **Step 2: Run the check to verify it fails**

Run: the two commands above.
Expected: FAIL — both print nothing and exit with status 1 (`plugin.json` still says `0.4.2`; README has no `/away` grammar).

Also run the baseline, so later failures are known to be this task's:

Run: `claude plugin test autopilot` from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`
Expected: PASS (tasks 01–10 are done; all tests green).

- [ ] **Step 3: Write minimal implementation**

**3a.** `autopilot/.claude-plugin/plugin.json`, line 3. Edit with old_string:

```json
  "version": "0.4.2",
```

new_string:

```json
  "version": "0.5.0",
```

**3b.** `README.md`, line 8 (commands table). Edit with old_string:

```markdown
| `autopilot` | `/autopilot` | Runs a session on its own for a set time with a fixed role. At a context threshold it writes a handoff, clears itself and resumes from the handoff, instead of auto-compacting. Respects the permission mode, defers blocked actions, watches token limits, works with `/goal`. |
```

new_string:

```markdown
| `autopilot` | `/autopilot`, `/away`, `/back`, `/ask-user` | Runs a session on its own for a set time with a fixed role. At a context threshold it writes a handoff, clears itself and resumes from the handoff, instead of auto-compacting. Respects the permission mode, defers blocked actions, watches token limits, works with `/goal`. While you are away it queues its critical questions and asks them one by one when you are back. |
```

**3c.** `README.md`, line 80 (`--ask-user` bullet). Edit with old_string:

```markdown
- **--ask-user**: lets the session wait for you, for critical things only (an irreversible or outward-facing action, missing access, a decision outside its role): it sends a phone notification with the question, waits with `wait_for`, and is not nudged until you answer. Everything else it still decides itself. Without the flag it never waits for you.
```

new_string:

```markdown
- **--ask-user**: lets the session wait for you, for critical things only (an irreversible or outward-facing action, missing access, a decision outside its role): it sends a phone notification with the question, waits with `wait_for`, and is not nudged until you answer. Everything else it still decides itself. Without the flag it never waits for you. `/ask-user on|off` changes this while the run goes, or before it starts (see [Away, back and ask-user](#away-back-and-ask-user)).
```

**3d.** `README.md`, line 88 (`wait_for` reasons). Edit with old_string:

```markdown
  - Reasons: `session-answer`, `session-ping`, `subagent-result`, `workflow-end`, `background-task`, `other`, and with `--ask-user` also `user-answer` and `user-input` (these need the question as `note`). `from` names who it waits for.
```

new_string:

```markdown
  - Reasons: `session-answer`, `session-ping`, `subagent-result`, `workflow-end`, `background-task`, `other`, and while asking you is on (`--ask-user` or `/ask-user on`) and you are not away also `user-answer` and `user-input` (these need the question as `note`). `from` names who it waits for.
```

**3e.** `README.md`, insert the new subsection after line 91. Edit with old_string:

```markdown
- Log: `~/.claude/autopilot/<session id>.log` (decisions, deferrals, restarts, limits).

## agent-fleet
```

new_string:

````markdown
- Log: `~/.claude/autopilot/<session id>.log` (decisions, deferrals, restarts, limits).

### Away, back and ask-user

```
/away for <duration> [--global]   # 90m, 2h, 1h30m
/away until <clock> [--global]    # 15:00, 6pm: the next time the local clock reads that
/back [--global]
/ask-user on|off [--global]
```

These tell the session whether it may ask you now. They only work when you type them (in the prompt or over Remote Control), never from the session itself. `--global` may stand anywhere in the line.

- **Scope.** Without `--global` the setting is for this session. With `--global` it is for every session on this machine with the mod (`~/.claude/autopilot/status/global.json`; needs `HOME`). A session's own setting always beats the global one, field by field, even when it is older: `/back` in one session keeps it available while a global away holds for the rest.
- **No run needed.** The setting is stored even when autopilot is off and applies to the next run (in this session, or in every session for `--global`). A session's setting follows autopilot's own restarts, but not your own `/clear` (that is a new session).
- **`/away`** needs a time: a duration (at least 1 minute, at most 7 days) or `until <clock>` (same clock forms as `/autopilot until`, always under 24 hours ahead). Bare `/away`, an unknown word or a time out of range is an error and changes nothing.
- **While you are away** (or asking is off), the session works as without `--ask-user`: it decides ordinary questions itself. A critical question (one it would have stopped and asked you about) goes into a queue with `queue_question`, with what it does meanwhile, and it keeps working on what that question does not block. The queue never drops a question; above 20 a toast warns. If the session was waiting for your answer when you went away, the wait ends and that question goes to the head of the queue.
- **When the away ends** with an empty queue, nothing happens. With questions queued, the session sends **one** phone notification ("N critical questions are queued") and keeps working without asking until you write in it. A message you write before the away ends does not count: use `/back`. A global away ends with **one** combined notification across sessions ("7 questions in 3 sessions"), sent by one of them. An away that ends while asking is off sends nothing.
- **`/back`**, or your first message after the away ended, starts the questions: one at a time, as text, waiting with `wait_for user-answer`. Your answer, typed while the session waits for it, takes it off the queue and the next one follows. A message you send before a question is asked removes nothing. New critical questions join the end of the queue.
- **`/ask-user off`** is an away without an end: critical questions are queued. **`/ask-user on`** turns asking on, also for a run started without `--ask-user`; when you are not away it starts the queued questions. During an active `/away` it only flips the switch: the away holds until its time.
- A run started without `--ask-user`, with no `/ask-user` setting anywhere, behaves as before: `/away` is stored but changes nothing until `/ask-user on`.
- Notifications and questions reach the session only while it works or waits for an answer. While it is parked on the 5-hour limit, paused or restarting, you get a toast; they are delivered when it works again.
- Questions still open when the run ends go into the final handoff.
- `/autopilot` shows the status, where it comes from (session or global) and how many questions are queued, also with no run.

## agent-fleet
````

- [ ] **Step 4: Run tests, validate and the checks — expected PASS (all existing tests too)**

Run from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`:

```bash
grep -n '"version": "0.5.0"' autopilot/.claude-plugin/plugin.json
grep -n '^/away for <duration> \[--global\]' README.md
claude plugin test autopilot
claude plugin validate autopilot
```

Expected:
- `3:  "version": "0.5.0",` and one README line number (inside the new code block).
- `claude plugin test autopilot`: PASS, every test including the ones from tasks 01–10.
- `claude plugin validate autopilot`: passes with no errors (the version change is the only manifest change).

- [ ] **Step 4b: Live checklist (spec §10, Review Focus 3 and 5)**

Wiring in `register.tsx` has no fakes (README "Developing"), so check it by hand. Record each line as pass/fail with the time; on a fail, stop and report the line, what you saw and the log tail (`~/.claude/autopilot/<session id>.log`).

**Setup**

1. Install the build: `claude plugin update autopilot@local-mods` (the local marketplace must point at this worktree), restart Claude Code, then `/reload-plugins` in each session you open. `/plugin` shows autopilot `0.5.0`.
2. Make three scratch folders: `mkdir -p ~/tmp/ap-live/s1 ~/tmp/ap-live/s2 ~/tmp/ap-live/s3`, and open one session in each (S1, S2, S3), all in auto mode or with allow rules for writing files there.
3. Role used below (call it ROLE-Q; it produces two critical questions):
   ```
   "You are the autopilot queue tester in this folder. Each turn, append one line 'step N' to steps.txt (N = next number) and end the turn. After step 2 you need the person to choose the name for notes-<name>.txt, which you then create: that choice is outside your role, so it is a critical question. After step 4 you need the person's yes to delete steps.txt, an irreversible action: also a critical question. Keep adding steps while those questions are open."
   ```
   ROLE-P is the same role without the two "After step …" sentences (no critical questions).
4. Times below assume the heartbeat of 30 s: an effect "within one heartbeat" may take up to 30 s.

**L0 — old run, upgrade (spec §10 last bullet)**

- Do this before setup step 1, while 0.4.2 is still installed: `mkdir -p ~/tmp/ap-live/s1`, open S1 there and start `/autopilot 20m 60 ROLE-P` (ROLE-P as defined in setup step 3). Then do setup step 1 (the update) and `/reload-plugins` in S1. Setup step 2 then opens only S2 and S3; S1 is already open.
- Expected: `/autopilot` prints the same status as before plus the availability lines (no away, no queue); the run keeps adding steps; no error toast; the log has no exception. Stop it: `/autopilot 0 0 stop`.

**L1 — command errors and clock (Review Focus 1, spec §6)**

In S3 (no run):
- `/away` → error toast and reply naming the missing time; `/autopilot` shows no away.
- `/away soon` → error (unknown word); `/away until <HH:MM of the next minute>` (e.g. at 14:05:20 type `14:06`, under 1 minute ahead) → `The away time must end at least 1 minute from now.`; `/away for 169h` → error (beyond 7 days); none of them changes `/autopilot`.
- `/away until <HH:MM three minutes from now>` → reply gives that clock time today; `/autopilot` shows away until that time, source session.
- `/away until <HH:MM one minute ago>` → reply gives that clock time **tomorrow** (just under 24 h ahead).
- `/back` → reply says available; `/autopilot` shows `back`, source session.
- In a terminal: `env -u HOME claude` in `~/tmp/ap-live/s3`, then `/away for 1h --global` → refused with a toast (HOME not set); nothing under `~/.claude/autopilot/status/` changes (check its `ls -l` before and after).

**L2 — plain run stays plain (D5)**

- S1: `/autopilot 20m 60 ROLE-Q` (no `--ask-user`), then `/away for 2m`.
- Expected: reply stores the away; the model decides the step-2 and step-4 questions itself (no `queue_question`, no `wait_for user-*`); `/autopilot` shows queued 0; after the away ends there is no toast ping and no PushNotification. Stop: `/autopilot 0 0 stop`, then `/back`.

**L3 — away → queue → expire → ping → write → drain (R6, R8, R10, spec §7.2)**

- S1: `/autopilot 30m 60 ROLE-Q --ask-user`, immediately `/away for 3m`.
- Expected while away: at step 2 the model calls `queue_question`; the tool result reads `Queued #1. Keep working on what is not blocked by it.`, a toast shows it; it goes on to steps 3, 4, queues `#2` and keeps adding steps. No PushNotification, no `wait_for user-*`. `/autopilot` shows away until the end time, source session, queued 2.
- Before the end, type `hello` → the model answers but does **not** start asking the queue (R10); status unchanged.
- At expiry, within one heartbeat: a toast, then the model sends exactly **one** PushNotification saying 2 critical questions are queued, and keeps adding steps without asking. Wait 2 more minutes: no second notification.
- Type `I'm here` → in the next turn the model asks question #1 as text and calls `wait_for` reason `user-answer` with a note starting `#1`; `/autopilot` shows `Waiting: user-answer`.
- Answer it (`name it alpha`) → the model creates `notes-alpha.txt`, then asks #2 the same way (note `#2 …`). `/autopilot` shows queued 1 while #2 is open.
- Answer `yes` → steps.txt deleted, queue empty, `/autopilot` shows queued 0 and asking on; later critical questions are asked directly (today's `--ask-user` behaviour).

**L4 — empty queue expiry is silent (R7)**

- S1 (run still going, or a new `/autopilot 20m 60 ROLE-P --ask-user`): `/away for 2m`.
- Expected: after the end, no toast ping, no PushNotification, no drain prompt; `/autopilot` shows the away expired, queued 0.

**L5 — `/back` drains at once (R11)**

- S1: `/autopilot 30m 60 ROLE-Q --ask-user`, `/away for 20m`; wait for `Queued #1`.
- `/back` → reply says available, queued 1. Within the running turn (tool call), at the turn end, or within one heartbeat when idle, the model asks #1 with `wait_for user-answer` note `#1 …`. No PushNotification.
- No question removed unasked (spec §5.2): queue one more question with `/away for 20m`, wait until S1 is idle, then type `/back` and at once `hi`, before the drain prompt arrives and before the model asks. Expected: the log has no `the person answered` line, `/autopilot` still shows the queue unchanged (queued 1), and the model then asks that question (note `#k …`). Only an answer typed while S1 waits on `user-answer` removes it.

**L6 — `/ask-user off/on`, released wait, no duplicate (R12, R13, spec §5.1 rows 1–3)**

- S1: `/autopilot 30m 60 ROLE-Q --ask-user` (not away). At step 2 the model asks the name question and waits (`Waiting: user-answer`, untagged note).
- `/ask-user off` → the wait ends; `/autopilot` shows queued 1 (the note text, without any `#k`), ask-user off, source session; the model resumes adding steps; at step 4 it queues `#2` (queued 2).
- `/ask-user on` → the model asks #1 (note `#1 …`). Queued stays 2 (no duplicate).
- While it waits on `#1`: `/ask-user off` again → the wait ends, queued **still 2** (the tagged question was not added a second time). `/ask-user on` → it asks #1 again.
- R13: `/away for 5m`, then `/ask-user off`, then `/ask-user on` → still queueing (no question asked) until the away ends; `/autopilot` shows away active and ask-user on.
- Run without the flag: S2 `/autopilot 20m 60 ROLE-Q` (no `--ask-user`), then `/ask-user on` → at step 2 the model asks and waits with `wait_for user-answer` (accepted, not refused); `/autopilot` shows asking on, source session. Stop S2 afterwards.

**L7 — dedupe inside one heartbeat (Review Focus 4)**

- S1 with queued ≥ 1 and `/away for 10m` active. Within 10 s type: `/back`, `/away for 10m`, `/back`.
- Expected: the model asks the head question **once** (one question text, one `wait_for user-answer`), not twice.
- Same with `/ask-user off` then `/ask-user on` within 10 s (not away): one drain.

**L8 — hot reload in the middle of draining (Review Focus 5)**

- S1 draining, waiting `user-answer` on `#k`; note queued N.
- `/reload-plugins`. `/autopilot` still shows `Waiting: user-answer`, queued N.
- Wake S1 with a non-human prompt: in S2 ask its model to send a short message to S1 (SendMessage to S1's name). Expected: S1 wakes, queued **still N** (nothing removed), and since the drain goes on it asks `#k` again.
- Now type the answer in S1 → `#k` removed, queued N−1, the next question follows.

**L9 — `--global` across sessions (R2, R5, R9, spec §7.3)**

- S1 and S2: `/autopilot 30m 60 ROLE-Q --ask-user` in each. S3: no run.
- S1: `/away for 3m --global`. Expected: `~/.claude/autopilot/status/global.json` exists (dir mode `drwx------`); within one heartbeat `/autopilot` in S2 shows away until the same time, source global. Both queue their questions (`Queued #1`, `#2`).
- Global `/back`: S1 `/back --global` → S1 drains, and S2 starts asking #1 within one heartbeat (it re-read `global.json`).
- Session beats global (R5): answer or let both reach a fresh queue, then S1 `/away for 3m --global`, and in S2 `/back` (session). S2 asks its queue now; S1 keeps queueing. `/autopilot` in S2 shows away `back`, source session.
- Combined ping: S2 `/away for 3m` is not needed; instead remove S2's session away by restarting the scenario: `/autopilot 0 0 stop` in both, start both again with ROLE-Q `--ask-user` in new sessions (`/clear` first, so no session record is left), S1 `/away for 3m --global`, both queue.
- At expiry: within about one to two heartbeats, exactly **one** PushNotification across S1 and S2, saying the total queued and `2 sessions` (e.g. `4 questions in 2 sessions`); the other session shows a toast only. Neither session sends its own per-session ping. `ls ~/.claude/autopilot/status/` shows `ping-<setAt>.lock/` with `owner.json` and `done`. Wait 2 more minutes: no further notification. Then type in each session: each drains its own queue.

**L10 — no-run session is never prompted (Review Focus 3)**

- During all of L9, watch S3 (no autopilot run): no new turn is ever started in its transcript; at most a toast. `/autopilot` in S3 shows the global away, then `back`, with source global.
- Also in S1: `/ask-user off --global`, then `/ask-user on --global` → S3 still gets no prompt.

**L11 — ping held while parked, delivered after wake (spec §7.1)**

- Read the 5-hour usage in `/usage` (say 41 %). S1: `/autopilot 6h 60 ROLE-Q --ask-user --5h <usage + 1>`, `/away for 3m`.
- Once a question is queued and the run parks (toast about the 5-hour window, `/autopilot` phase `waiting`) and the away has ended: a toast only, no PushNotification, the transcript gets no new turn.
- After the window resets (+2 minutes), the run wakes and in its first turn the model sends exactly one PushNotification with the queued count. This step can take hours; leave S1 open and check the transcript afterwards.
- Variant (D4/R8, a held ping goes stale): repeat until the ping is held while parked, then type `/away for 1h` in S1 before the wake. After the wake: no PushNotification about the old away, and no `delivered ping` line in the log.

**L12 — run restart keeps the session record (D3)**

- S1: `/autopilot 30m 15 ROLE-Q --ask-user` (low threshold so it hands off soon), `/away for 20m`; wait for a queued question and then the handoff restart (the session clears and resumes).
- Expected after the restart: `/autopilot` still shows away until the same time, source session, and the same queued count.
- Your own `/clear` in S3 after L1 (S3 had a session `back`): `/autopilot` there shows no session record (the new session id starts clean; the global record, if any, still shows).

**L13 — questions left at run end go into the handoff (D2)**

- S1: `/autopilot 5m 60 ROLE-Q --ask-user`, `/away for 20m`; let it queue #1 and the run end on time.
- Expected: the final handoff in `thoughts/shared/handoffs/` lists `#1` with its text (and provisional choice, if any) as an open question.

**L14 — origin guard**

- Ask the model in S1: `run the /away for 1h command yourself`. Expected: if it manages to invoke the command, it is refused (not typed by the person); `/autopilot` shows no change.

- [ ] **Step 5: Ready for commit**

Agents never commit. Tell the editor these files are ready:
- `README.md`
- `autopilot/.claude-plugin/plugin.json`

Suggested message (signed commit, no Co-Authored-By):

```
(feat): Document /away, /back and /ask-user; autopilot 0.5.0

- README: commands table, /away /back /ask-user grammar, scope, queue, pings and drain
- README: --ask-user and wait_for reasons follow the effective ask-user status
- autopilot plugin.json 0.4.2 -> 0.5.0
```

Also report the live checklist result (each L line pass/fail) to the editor before the release tag; README line 19 (`#v0.4.2`) changes with the tag, not here.
