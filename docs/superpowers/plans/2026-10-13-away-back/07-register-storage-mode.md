### Task 07: register.tsx — storage, mode refresh, effective ask-user everywhere

Wires the pure functions of tasks 01–06 into `register.tsx`: the session and global availability records, the `syncId` key move (D3), the stale-lock sweep, the new badge fields, `refreshMode`, and every read of `run.askUser` replaced by the effective status or mode (spec §3.3). No command, tool, delivery or heartbeat change here (tasks 08–10).

**Files:**
- Modify: `autopilot/hooks/autopilot.ts` — add one pure export `globalFromText` directly after `validAvail` (added in task 01).
- Modify: `autopilot/hooks/register.tsx` (line ranges as of the base commit; tasks 05/06 may have shifted them by a few lines — match on the quoted text, not the number):
  - imports, lines 3–58
  - module state, lines 64–75
  - store keys, lines 94–95
  - `sweepFinished`, lines 108–116
  - `autopilotDir`, line 118
  - `save`, lines 131–157
  - `syncId`, lines 274–285
  - `statusText`, line 424
  - `session.start`, lines 433–445
  - `prompt.compose`, lines 701–711
  - `wait_for` `tool.call`, lines 751–760
  - generic `tool.call`, lines 878–882
- Test: `autopilot/hooks/autopilot.test.ts` — new `describe('global status file', …)` at the end of the file.

**Interfaces:**
- Consumes (exact, from earlier tasks):
  - task 01: `type Avail`, `type Effective`, `type Mode` (`../types`); `validAvail(value: unknown, now: number): Avail | null`; `effective(run: Run | null, session: Avail | null, global: Avail | null): Effective`; `availMode(run: Run, eff: Effective, now: number): Mode`
  - task 03: `Run.questions?: Question[]`
  - task 04: `applyMode(run: Run, next: Mode, eff: Effective, now: number): { run: Run; combined: boolean }` (sets `lastMode = next`)
  - task 05: `waitRefusal(awaiting: Awaiting, mode: Mode): string | null`; `askAnswer(mode: Mode): string`; `roleSection(run: Run, now: number, mode?: Mode): string`; `drainingQuestion(run: Run): Question | null`
  - task 06: `HEARTBEAT_MS` (`30_000`, exported from `autopilot.ts`)
- Produces:
  - `autopilot.ts`: `globalFromText(text: string | null, now: number, last: Avail | null): Avail | null`
  - `register.tsx` (module-private): `statusDir(): string`, `globalFile(): string`, `availKey(id: string): string`; module caches `sessionAvail: Avail | null`, `globalAvail: Avail | null`, `globalMtime: number | null`, `lastBeat: number`
  - `readSessionAvail($: EngineInterface): Promise<Avail | null>` / `writeSessionAvail($: EngineInterface, rec: Avail): Promise<void>`
  - `readGlobalAvail($: EngineInterface, force?: boolean): Promise<Avail | null>` / `writeGlobalAvail($: EngineInterface, rec: Avail): Promise<void>` (throws when `HOME` is unset or the rename fails)
  - `currentEffective($: EngineInterface): Promise<Effective>`
  - `refreshMode($: EngineInterface): Promise<Mode | null>`
  - `askOnNow(): boolean`
  - `statusText(now: number, isAskShown = true): string` (task 08's status branch passes `false`)
  - badge file fields `queued: number`, `awaySource: 'session' | 'global' | null`, `awaySetAt: number | null`, `beat: number`

> Contract note: `home` is only known after `session.start`, so the paths are functions like the existing `autopilotDir()` (a constant would be computed with an empty `home`), and every helper takes `$` first, as every existing helper in this file does (`save($)`, `log($, …)`). Tasks 08–10 call `statusDir()`, `globalFile()`, `readGlobalAvail($)`, `writeGlobalAvail($, rec)`, `writeSessionAvail($, rec)`, `currentEffective($)`, `refreshMode($)`.

Design points this task fixes:
- `global.json` missing, empty, half-written, wrong shape or with a `setAt` more than 5 min ahead → the last good value stays (Review Focus 2). The pure decision is `globalFromText`; the reader never throws (every fs call is caught).
- The heartbeat re-reads `global.json` only when its `mtimeMs` changed; `force` re-reads anyway (session start).
- `refreshMode` is the one place the mode rule runs: it recomputes `availMode`, calls `applyMode`, saves, logs a mode change.
- `refreshMode` saves when the run changed, or when the badge's `beat` is older than half a heartbeat, so a heartbeat that calls it (task 10) keeps `beat` fresh for the combined-ping count (`sumQueued` drops beats older than `2 * HEARTBEAT_MS`).
- `refreshMode` logs `applyMode().combined` (a global away just ended here); the combined ping itself is task 10's `combinedTick`.
- `prompt.compose` does **not** run `refreshMode`: compose fires for every model request and also when another plugin calls `$.prompt.compose()` ("composed for nobody to send"), and spec §5.1 does not list it as a trigger. It only reads the mode from the cached records (`availMode(run, effective(run, sessionAvail, globalAvail), now)`, no I/O, no effects) and, in `draining`, records the head question as `run.askingId` (the question the role section names, spec §8). The records are fresh there: `turn.start` (task 09) runs `refreshMode` before the turn's first request.
- The badge's `queued` counts the queue only while asking is on (`eff.askOn`); with asking off it is `0`, so the combined ping (task 10) never counts questions that will not be asked when the person writes there (D4).
- Lock directories `ping-<setAt>.lock` older than 24 h (the `mtimeMs` of the `$.fs.list` entry) are removed with `/bin/rm -rf` (`$.fs` has no delete).

- [ ] **Step 1: Write the failing test**

In `autopilot/hooks/autopilot.test.ts`:

1. The type import on line 3 needs no change: after tasks 01–06 it already reads (complete list)

```ts
import type { Avail, Awaiting, BadgeAvail, Effective, LockOwner, Pending, Question, Run, WaitReason } from '../types'
```

2. Add `globalFromText` to the import list from `'./autopilot'`, alphabetically between `formatLeft,` and `goalState,`:

```ts
  formatLeft,
  globalFromText,
  goalState,
```

3. Append at the very end of the file:

```ts
describe('global status file', () => {
  const NOW = 1_000_000
  const good: Avail = { v: 1, away: { until: 2_000_000, setAt: 900_000 }, askUser: { on: true, setAt: 900_000 } }
  const last: Avail = { v: 1, away: { back: true, setAt: 800_000 }, askUser: null }

  test('a whole, valid file is read', async () => {
    expect(globalFromText(JSON.stringify(good), NOW, last)).toEqual(good)
  })

  test('a file with both fields cleared is a valid record, not a failure', async () => {
    const cleared: Avail = { v: 1, away: null, askUser: null }
    expect(globalFromText(JSON.stringify(cleared), NOW, last)).toEqual(cleared)
  })

  test('a missing file keeps the last good value', async () => {
    expect(globalFromText(null, NOW, last)).toEqual(last)
  })

  test('an empty file keeps the last good value', async () => {
    expect(globalFromText('', NOW, last)).toEqual(last)
    expect(globalFromText('   \n', NOW, last)).toEqual(last)
  })

  test('a half-written file keeps the last good value', async () => {
    const whole = JSON.stringify(good)
    for (const cut of [1, 10, 25, whole.length - 1]) {
      expect(globalFromText(whole.slice(0, cut), NOW, last)).toEqual(last)
    }
  })

  test('a setAt far in the future keeps the last good value', async () => {
    const future: Avail = { v: 1, away: { until: NOW + 3_600_000, setAt: NOW + 10 * 60_000 }, askUser: null }
    expect(globalFromText(JSON.stringify(future), NOW, last)).toEqual(last)
    const futureAsk: Avail = { v: 1, away: null, askUser: { on: false, setAt: NOW + 24 * 3_600_000 } }
    expect(globalFromText(JSON.stringify(futureAsk), NOW, last)).toEqual(last)
  })

  test('a setAt a little ahead (clock skew under 5 minutes) is accepted', async () => {
    const skewed: Avail = { v: 1, away: { until: NOW + 3_600_000, setAt: NOW + 60_000 }, askUser: null }
    expect(globalFromText(JSON.stringify(skewed), NOW, last)).toEqual(skewed)
  })

  test('a wrong shape keeps the last good value', async () => {
    for (const text of ['{"v":2,"away":null,"askUser":null}', 'null', '[]', '"away"', '42', '{"v":1,"away":{"until":"later","setAt":1},"askUser":null}']) {
      expect(globalFromText(text, NOW, last)).toEqual(last)
    }
  })

  test('with no last good value, a bad file reads as no record', async () => {
    expect(globalFromText('', NOW, null)).toBeNull()
    expect(globalFromText(null, NOW, null)).toBeNull()
    expect(globalFromText('{"v":1,', NOW, null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `claude plugin test autopilot` (from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`)
Expected: FAIL — the test module does not load: `globalFromText` is not exported by `./autopilot` (import / `is not a function` error), so the `global status file` tests fail.

- [ ] **Step 3: Write minimal implementation**

**3a. `autopilot/hooks/autopilot.ts`** — insert directly after the `validAvail` function (task 01). `Avail` is already in this file's type import from task 01.

```ts
/**
 * The global record after reading global.json: the file's record when it is
 * whole and valid; otherwise (missing, empty, half-written, wrong shape, set
 * in the future) the last good one, so a bad read never changes the status.
 */
export function globalFromText(text: string | null, now: number, last: Avail | null): Avail | null {
  if (text === null) return last
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return last
  }

  return validAvail(value, now) ?? last
}
```

**3b. `autopilot/hooks/register.tsx` — imports (lines 3–58).**

Replace line 3:

```ts
import type { FinalReason, FinishedRecord, Run, TokenWindow } from '../types'
```

with (complete list at this point; tasks 01–06 do not touch this line):

```ts
import type { Avail, Effective, FinalReason, FinishedRecord, Mode, Run, TokenWindow } from '../types'
```

In the value import list from `'./autopilot'`, add each of these names if it is not there yet, in the list's alphabetical order (uppercase constants first, as now):

- `HEARTBEAT_MS,` after `FULL_WAIT_TOOL,`
- `applyMode,` after `afterTurn,`
- `availMode,` after `autoAnswersQuestions,`
- `drainingQuestion,` and `effective,` before `effectiveTrigger,`
- `globalFromText,` after `formatLeft,`
- `validAvail,` after `untilFromClock,`

**3c. Module state — after line 75 (`let ceiling = DEFAULT_CEILING`).** Insert:

```ts
// The availability records as last read: this session's ($.store) and the global one (global.json).
let sessionAvail: Avail | null = null
let globalAvail: Avail | null = null
// global.json's mtime at the last read; the heartbeat re-reads it only when this changes.
let globalMtime: number | null = null
// When the badge last carried a heartbeat time.
let lastBeat = 0
```

**3d. Store keys — after line 95 (`const finishedKey = …`).** Insert:

```ts
const availKey = (id: string) => `away:${id}`
```

**3e. `sweepFinished` (lines 108–116).** Replace the whole function with:

```ts
/** A combined-ping lock lives this long; then the sweep removes it. */
const LOCK_TTL_MS = 24 * 60 * 60_000

/** Deletes every finished-run record, of any session, that is past its grace period or malformed, and old combined-ping locks. */
async function sweepFinished($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('finished:')) continue
    const value = await $.store.get(key)
    if (!isLiveFinishedValue(value, now)) await $.store.delete(key)
  }
  if (!home) return
  const entries = await $.fs.list(statusDir()).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'dir' || !/^ping-\d+\.lock$/.test(entry.name)) continue
    // The list entry carries the directory's mtime: no extra stat.
    if (now - entry.mtimeMs < LOCK_TTL_MS) continue
    await $.process.run(['/bin/rm', '-rf', '--', `${statusDir()}/${entry.name}`]).catch(() => undefined)
  }
}
```

`sweepFinished` calls `statusDir()`, defined below it; that is fine (called only after `session.start` sets `home`).

**3f. Paths — after line 118 (`const autopilotDir =() => …`).** Insert:

```ts
const statusDir = () => `${autopilotDir()}/status`
const globalFile = () => `${statusDir()}/global.json`
```

**3g. Availability helpers — insert after `utcOffset` (after line 129, before `async function save`).**

```ts
/** This session's availability record, read again from the store; null when none or malformed. */
async function readSessionAvail($: EngineInterface): Promise<Avail | null> {
  if (!sessionId) {
    sessionAvail = null
    return null
  }
  const value = await $.store.get(availKey(sessionId)).catch(() => undefined)
  sessionAvail = validAvail(value, await $.clock.now())

  return sessionAvail
}

async function writeSessionAvail($: EngineInterface, rec: Avail): Promise<void> {
  if (!sessionId) return
  await $.store.set(availKey(sessionId), rec)
  sessionAvail = rec
}

/**
 * The global record. Re-read only when global.json changed (or `force`); a
 * missing, empty, half-written or future-dated file keeps the last good value.
 * Never throws.
 */
async function readGlobalAvail($: EngineInterface, force = false): Promise<Avail | null> {
  if (!home) return globalAvail
  const stat = await $.fs.stat(globalFile()).catch(() => null)
  if (!stat) return globalAvail
  if (!force && stat.mtimeMs === globalMtime) return globalAvail
  const text = await $.fs.read(globalFile()).catch(() => null)
  globalAvail = globalFromText(text, await $.clock.now(), globalAvail)
  globalMtime = stat.mtimeMs

  return globalAvail
}

/** Writes global.json for every session: a temp file of this session, then an atomic rename. */
async function writeGlobalAvail($: EngineInterface, rec: Avail): Promise<void> {
  if (!home) throw new Error('HOME is not set')
  const tmp = `${globalFile()}.tmp-${sessionId}`
  await $.fs.write(tmp, JSON.stringify(rec))
  const moved = await $.process.run(['/bin/mv', '-f', '--', tmp, globalFile()])
  if (moved.exitCode !== 0) throw new Error(`could not write ${globalFile()}: ${moved.stderr.trim()}`)
  globalAvail = rec
  globalMtime = (await $.fs.stat(globalFile()).catch(() => null))?.mtimeMs ?? null
}

/** The effective status: session record over global record per field, else the run's --ask-user flag. */
async function currentEffective($: EngineInterface): Promise<Effective> {
  await readSessionAvail($)
  await readGlobalAvail($)

  return effective(run, sessionAvail, globalAvail)
}

/** Whether questions go to the person now, from the records as last read (no I/O). */
function askOnNow(): boolean {
  return effective(run, sessionAvail, globalAvail).askOn
}
```

**3h. `save` (lines 131–157).** Replace the whole function with:

```ts
async function save($: EngineInterface): Promise<void> {
  if (!sessionId) return
  const now = await $.clock.now()
  if (!run) {
    await $.store.delete(storeKey(sessionId))
    if (home) await $.fs.write(`${autopilotDir()}/${sessionId}.json`, JSON.stringify({ isOn: false }))
    return
  }
  await $.store.set(storeKey(sessionId), run)
  if (!home) return
  const eff = effective(run, sessionAvail, globalAvail)
  // Read by the fleet dashboard for its badge; the last four fields only by the combined ping,
  // which counts only questions that will be asked: none while asking is off (D4).
  await $.fs.write(
    `${autopilotDir()}/${sessionId}.json`,
    JSON.stringify({
      isOn: true,
      phase: run.phase,
      until: run.until,
      threshold: run.threshold,
      restarts: run.restarts,
      maxRestarts: run.maxRestarts,
      waitUntil: run.waitUntil,
      hasGoal: run.goal !== null,
      waitingFor: run.awaiting?.reason ?? null,
      waitingFrom: run.awaiting?.from ?? null,
      waitingSince: run.awaiting?.since ?? null,
      queued: eff.askOn ? (run.questions?.length ?? 0) : 0,
      awaySource: eff.awaySource,
      awaySetAt: eff.away?.setAt ?? null,
      beat: now,
    }),
  )
  lastBeat = now
}
```

(The clock is read before `run` is checked, so no new await sits between the check and the writes.)

**3i. `syncId` (lines 274–285).** Replace the whole function with:

```ts
/**
 * /clear and /resume change the session id under a running module. Only the
 * run's own /clear (phase restarting) moves it to the new id, with this
 * session's availability record; any other new id is another conversation,
 * which the run does not drive: it stays stored under its old id, and the new
 * id's own run and record, if any, are loaded.
 */
async function syncId($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  if (id === sessionId) return
  const previous = sessionId
  sessionId = id
  if (run && followsNewSessionId(run.phase)) {
    if (previous) {
      await $.store.delete(storeKey(previous))
      const away = await $.store.get(availKey(previous))
      if (away !== undefined) {
        await $.store.set(availKey(id), away)
        await $.store.delete(availKey(previous))
      }
    }
    await save($)
    return
  }
  run = ((await $.store.get(storeKey(id))) as Run | undefined) ?? null
  await readSessionAvail($)
}
```

**3j. `refreshMode` — insert directly after `syncId`.**

```ts
/**
 * The mode rule, one place for every trigger (spec §5.1): recomputes the
 * mode from the records, applies its effects to the run and saves. Saves
 * at least every half heartbeat, so the badge's `beat` stays fresh. Null
 * when no run.
 */
async function refreshMode($: EngineInterface): Promise<Mode | null> {
  await currentEffective($)
  const now = await $.clock.now()
  if (!run) return null
  // Decided and applied with no await in between: a parallel trigger acts on the result.
  const eff = effective(run, sessionAvail, globalAvail)
  const prev = run.lastMode ?? null
  const before = JSON.stringify(run)
  const next = availMode(run, eff, now)
  const applied = applyMode(run, next, eff, now)
  run = applied.run
  const isChanged = JSON.stringify(run) !== before
  if (isChanged || now - lastBeat >= HEARTBEAT_MS / 2) await save($)
  if (prev !== next) await log($, `availability mode ${prev ?? 'none'} -> ${next}`)
  // Informational: the combined ping itself comes from the heartbeat's combinedTick (task 10).
  if (applied.combined) await log($, 'global away over here: the combined ping is decided by the heartbeat')

  return next
}
```

**3k. `statusText` (lines 417 and 424).** The status reply of task 08 appends `availStatusLines`, which carries its own `Asks the person: …` line; the start reply (line 698, `${statusText(now)}\nEnd: …`) does not. So `statusText` prints its ask-user line only when asked to, and the status branch turns it off (task 08 Step 3d), so the reply has a single ask-user line.

Replace line 417:

```ts
function statusText(now: number): string {
```

with:

```ts
/** `isAskShown` false when the caller appends availStatusLines, which has its own ask-user line. */
function statusText(now: number, isAskShown = true): string {
```

and line 424:

```ts
    ...(run.askUser === true ? ['Asks the person: critical only'] : []),
```

with:

```ts
    ...(isAskShown && askOnNow() ? ['Asks the person: critical only'] : []),
```

Callers stay as they are in this task (both use the default `true`).

**3l. `session.start` (lines 436–442).** Replace:

```ts
    // State and logs are the person's alone: the folder is closed to other users.
    if (home) {
      await $.process.run(['/bin/mkdir', '-p', autopilotDir()]).catch(() => undefined)
      await $.process.run(['/bin/chmod', '700', autopilotDir()]).catch(() => undefined)
    }
    sessionId = await $.session.id()
    run = ((await $.store.get(storeKey(sessionId))) as Run | undefined) ?? null
```

with:

```ts
    // State and logs are the person's alone: the folders are closed to other users.
    if (home) {
      await $.process.run(['/bin/mkdir', '-p', autopilotDir(), statusDir()]).catch(() => undefined)
      await $.process.run(['/bin/chmod', '700', autopilotDir(), statusDir()]).catch(() => undefined)
    }
    sessionId = await $.session.id()
    run = ((await $.store.get(storeKey(sessionId))) as Run | undefined) ?? null
    // The status applies even before a run starts (R4); a reload re-reads both records.
    await readSessionAvail($)
    await readGlobalAvail($, true)
```

**3m. `prompt.compose` (lines 701–711).** Replace the whole handler with:

```ts
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!run) return composed
    const now = await $.clock.now()
    if (!run) return composed
    // Read only: compose fires for every model request and for other plugins' $.prompt.compose(),
    // so it runs no mode effects and reads no file; the records were refreshed at turn.start.
    const mode = availMode(run, effective(run, sessionAvail, globalAvail), now)
    // While draining, the role section names the head question: that is the one an answer removes.
    const head = mode === 'draining' ? drainingQuestion(run) : null
    if (head && run.askingId !== head.id) {
      run.askingId = head.id
      await save($)
    }

    return {
      sections: [
        ...composed.sections,
        { id: 'autopilot:role', text: roleSection(run, now, mode), scope: 'session' as const },
      ],
    }
  })
```

**3n. `wait_for` `tool.call` (lines 751–760).** Replace:

```ts
    await syncId($)
    const now = await $.clock.now()
```

(the pair inside the `FULL_WAIT_TOOL` handler, lines 751–752) with:

```ts
    await syncId($)
    // The mode first: everything from the clock read on stays free of awaits until the flip.
    const mode = await refreshMode($)
    const now = await $.clock.now()
```

and replace the line that computes the refusal (line 760; after task 05 its second argument may already differ — replace the whole line whatever that argument is):

```ts
    const refusal = waitRefusal(parsed.awaiting, run.askUser === true)
```

with:

```ts
    const refusal = waitRefusal(parsed.awaiting, mode ?? 'plain')
```

**3o. Generic `tool.call` (lines 879–882).** Replace:

```ts
    if (isAway && e.tool === 'AskUserQuestion') {
      await log($, `question answered by autopilot (decide yourself): ${JSON.stringify(e).slice(0, 400)}`)
      return { deny: askAnswer(run.askUser === true) }
    }
```

(after task 05 the `askAnswer` argument may already differ — replace the whole block) with:

```ts
    if (isAway && e.tool === 'AskUserQuestion') {
      const mode = await refreshMode($)
      await log($, `question answered by autopilot (decide yourself): ${JSON.stringify(e).slice(0, 400)}`)
      return { deny: askAnswer(mode ?? 'plain') }
    }
```

After these edits, check: `grep -n "askUser" autopilot/hooks/register.tsx` lists only `askUser: command.askUser` (run start) and `command.askUser` in the start log line — no `run.askUser` read is left.

- [ ] **Step 4: Run tests, expected PASS (all existing tests too)**

Run, from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`:

```bash
claude plugin test autopilot
claude plugin validate autopilot
```

Expected: every test passes, including the 9 new `global status file` tests and all tests of tasks 01–06; validate reports no errors (it type-checks `register.tsx`, so a wrong import or signature fails here).

Manual live check (wiring has no fakes; README.md:119). In a Claude Code session in any project, `/reload-plugins`, then:

1. **Status dir.** `ls -ld ~/.claude/autopilot/status` → exists, `drwx------`.
2. **Effective ask-user in status, no records.** `/autopilot 30m 60 "Test role"` (no `--ask-user`) → `/autopilot` shows no `Asks the person` line. `/autopilot 0 0 stop`. Start again with `--ask-user` → `/autopilot` shows `Asks the person: critical only`.
3. **Global record read, bad file kept out.** With that run on, in a shell:
   `printf '{"v":1,"away":null,"askUser":{"on":false,"setAt":%s}}' "$(($(date +%s)*1000))" > ~/.claude/autopilot/status/global.json`
   Then trigger the mode rule. With task 07 alone, ask the model to call `AskUserQuestion` (its deny runs `refreshMode`; compose does not). Once task 09 is in, any prompt works (turn.start), and once task 10 is in, waiting ≥ 30 s works (the heartbeat) → `/autopilot` no longer shows `Asks the person`; the log (`~/.claude/autopilot/<sid>.log`) has `availability mode … -> queueing` (the first trigger after the start logs `none -> …`).
   Then `printf '{"v":1,"away":' > ~/.claude/autopilot/status/global.json` (half-written) and trigger again the same way → still no `Asks the person` line (last good value kept), no error toast, nothing new about modes in the log.
   Then write a record with `setAt` one hour ahead: `printf '{"v":1,"away":null,"askUser":{"on":true,"setAt":%s}}' "$(( ($(date +%s)+3600)*1000 ))" > …/global.json` → status unchanged (rejected).
   Clean up: `rm ~/.claude/autopilot/status/global.json`.
4. **Badge fields.** `cat ~/.claude/autopilot/<sid>.json` → has `queued: 0`, `awaySource`, `awaySetAt`, `beat` (a recent epoch ms), and all the old fields; the fleet dashboard badge still renders.
5. **Lock sweep.** `mkdir ~/.claude/autopilot/status/ping-1.lock && touch -t 202001010000 ~/.claude/autopilot/status/ping-1.lock`, also `mkdir ~/.claude/autopilot/status/ping-2.lock` (fresh); restart the session (sweep runs on `session.start`) → `ping-1.lock` is gone, `ping-2.lock` stays. Remove `ping-2.lock` by hand.
6. **Session record follows the run's restart, not `/clear`** (needs task 08's `/away`; run it in task 11's live check if 08 is not done): with a run on, `/away for 1h`, let the run restart from a handoff → `/autopilot` in the new session still reports the away; a manual `/clear` in another session with a record → the record does not follow.
7. `/autopilot 0 0 stop`.

- [ ] **Step 5: Ready for commit**

Stop and tell the editor these files are ready (agents never commit):

- `autopilot/hooks/autopilot.ts`
- `autopilot/hooks/autopilot.test.ts`
- `autopilot/hooks/register.tsx`

Suggested message:

```
(feat): Store availability records and apply the mode in autopilot

- Read and write the session record ($.store away:<sid>) and global.json (temp file + atomic rename, last good value on a bad read, mtime cache)
- Move the session record with the run's own restart; sweep combined-ping locks older than 24 h
- Add queued, awaySource, awaySetAt and beat to the badge file
- refreshMode applies the mode rule and saves; wait_for and AskUserQuestion use it, prompt.compose only reads the mode
- The badge counts queued questions only while asking is on
- Replace every run.askUser read with the effective status
```
