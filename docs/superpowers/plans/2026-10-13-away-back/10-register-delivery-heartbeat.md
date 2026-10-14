### Task 10: Delivery of `run.pending`, the heartbeat block, the combined-ping lock

Wires spec §7.1 (pending prompts) and §7.3 (combined ping) into `register.tsx`. Every prompt the feature must get to the model (`ping`, `combined-ping`, `drain`, `continue`) already sits in `run.pending` (tasks 04, 07, 08, 09 push it); this task hands it over by the first of: the next generic `tool.call` (as `context`), `turn.complete` (instead of `CONTINUE_PROMPT`), the idle heartbeat (`$.prompt.submit`). Only while `canDeliver(run.phase)`; otherwise a ping is toasted once and stays pending. An entry leaves `run.pending` only once handed to the model; a dropped or failed submit puts it back.

Two small pure parsers are added to `autopilot.ts` so the file reads in `combinedTick` are unit-tested; the rest of the wiring has no fakes (README.md:119) and is checked live (Step 4b).

Review Focus owned here (live side only): **3** — `combinedTick` returns before touching any lock or pending entry unless `eligibleForCombined` (task 06) is true, which is false for `run === null`; **4** — `flushPending` never schedules a second submit while one is in flight (`flushingText`), and the `tool` path takes the entries before its first `await`, so parallel tool calls deliver once.

**Files:**
- Modify: `autopilot/hooks/autopilot.ts`
  - the `import type { … } from '../types'` line (line 1; tasks 01–06 extend it): make sure it includes `BadgeAvail` and `LockOwner` (task 06 adds both; add only if missing)
  - append a new section at the end of the file (after task 06's `lockStale`)
- Modify: `autopilot/hooks/register.tsx` (line numbers are those of the file before tasks 06–09; find each place by the quoted text)
  - line 3 `import type { … } from '../types'`: becomes the complete list shown in Step 3b (adds `BadgeAvail`, `LockOwner`, `Pending` to what tasks 07–08 put there)
  - lines 4–58, value import list from `./autopilot`: add the names listed in Step 3b that are not there yet
  - after line 75 (`let ceiling = DEFAULT_CEILING`): two module variables
  - after `checkWaitTimeout` (lines 406–415), before `function statusText` (line 417): new helpers `lockDir`, `readLockOwner`, `readBadges`, `claimLock`, `toastGlobal`, `combinedTick`, `toastHeld`, `markDelivered`, `submitPending`, `flushPending`
  - lines 483–497: the heartbeat `$.clock.every(…)` block (task 06 changed `30_000` to `HEARTBEAT_MS`; task 07 may have added a `refreshMode` call) — replaced whole
  - lines 870–915: the generic `on('tool.call', async ($, e, next) => {` handler — the part after the `ran.deny` block (lines 891–914)
  - lines 973–979 (`if (action === 'continue') {`) and 980–989 (`if (action === 'resume-done') {`) in `turn.complete`
- Test: `autopilot/hooks/autopilot.test.ts`
  - the `import type { … } from '../types'` line: `BadgeAvail`, `LockOwner` are already there after task 06
  - the value import list from `./autopilot`: add `parseBadgeAvail`, `parseLockOwner`
  - append `describe('combined ping files', …)` at the end of the file (after task 06's `describe('combined ping', …)`)

**Interfaces:**
- Consumes:
  - task 01 types: `Mode`, `Avail`, `Effective`, `Pending = { kind: 'ping' | 'combined-ping' | 'drain' | 'continue'; text: string; key: number }`, `BadgeAvail = { queued: number; awaySource: 'session' | 'global' | null; awaySetAt: number | null; beat: number }`, `LockOwner = { sid: string; at: number }`; `Run.pending?: Pending[]`, `Run.questions?: Question[]`
  - task 01: `availMode(run: Run, eff: Effective, now: number): Mode`
  - task 04: `pushPending(run: Run, p: Pending): Run`, `deliveredPending(run: Run, p: Pending): Run`, `canDeliver(phase: Phase): boolean`
  - task 04: `criticalCount(n: number): string` (the ping toast's count)
  - task 05: `combinedPingText(total: number, sessions: number): string`, `queuedAcross(total: number, sessions: number): string` (the "others only toast" count)
  - task 06: `HEARTBEAT_MS = 30_000`, `eligibleForCombined(run: Run | null, eff: Effective, mode: Mode | null, globalSetAt: number): boolean`, `sumQueued(badges: readonly BadgeAvail[], setAt: number, now: number): { total: number; sessions: number }`, `lockStale(owner: LockOwner | null, done: boolean, now: number): boolean`
  - task 07 (register.tsx): `statusDir()` (the status folder, `${autopilotDir()}/status`), `readGlobalAvail($: EngineInterface, force?: boolean): Promise<Avail | null>`, `currentEffective($): Promise<Effective>`, `refreshMode($): Promise<Mode | null>`, and `save($)` writing the badge fields `queued`, `awaySource`, `awaySetAt`, `beat` (with `beat` taken from the clock at save time)
  - existing register.tsx: `run`, `sessionId`, `home`, `isTurnRunning`, `autopilotDir()`, `save`, `log`, `queue`, `wake`, `enterFinal`, `checkWaitTimeout`, `FULL_RESTART_TOOL`, `FULL_WAIT_TOOL`
- Produces:
  - `autopilot.ts`: `export function parseBadgeAvail(value: unknown): BadgeAvail | null`, `export function parseLockOwner(value: unknown): LockOwner | null`
  - `register.tsx`: `async function flushPending($: EngineInterface, via: 'tool' | 'turn' | 'idle'): Promise<string | null>` — `tool`: takes the deliverable entries and returns their text for the caller's `context`; `turn`/`idle`: schedules one submit and returns its text (non-null means "a prompt is on its way, queue nothing else"); null when nothing is pending or nothing can be delivered
  - `register.tsx`: `async function combinedTick($: EngineInterface): Promise<void>` — lock, wait one beat after expiry, sum, pending `combined-ping`; `done` is written by `markDelivered` when that entry is handed over; a session on the same global away that sends no ping (not the owner, or its run outside `running`/`awaiting`) toasts once per `setAt` (`toastGlobal`)

**Decisions this task fixes:**
- The owner waits until `now >= away.until + HEARTBEAT_MS` before summing: by then every live session has passed one heartbeat after the expiry and refreshed its badge. No extra wait state is stored.
- The owner rewrites `owner.json` (`at = now`) on every heartbeat until `done`, so `lockStale` (two beats) only fires for a dead owner. While its `combined-ping` waits for delivery, the owner keeps refreshing the lock **whatever its eligibility** (parked in `waiting`, paused, or its own away changed), so no other session takes over and sends a second combined ping (R9). If the entry is dropped (task 04: the owner went back to `queueing`), the refresh stops, and after two beats another eligible session takes over and sends the one ping.
- Ownership is whatever `owner.json` says at the start of a heartbeat. A session that just made the lock (`mkdir` exit 0) or replaced a stale owner acts as owner from the next heartbeat on; two racing takers resolve to the last writer.
- `combined-ping` and `ping` show a toast when handed to the model (the human-facing half of the ping, §7.1); while held (phase not `running`/`awaiting`) one toast per entry per module load. `drain`/`continue` are never toasted.
- "Others only toast" (§7.3): a session whose effective away is that global record with `askOn`, and that sends no combined ping, toasts once per global `setAt` (key `global:<setAt>` in `heldToasts`, so once per module load): an eligible non-owner once the owner wrote `done`; a run outside `running`/`awaiting` one heartbeat after the expiry. Both only when the badge sum is above 0 (R7). A session with no run gets nothing (Review Focus 3).
- No delivery on the results of `wait_for` and `restart_session`: both tell the session to end its turn; the entries wait for the next path.
- `wake` and the revive path stay as they are: the run is back in `running`, so the resumed turn's first tool call (or its `turn.complete`) delivers. `resume-done` without a goal sends the pending text instead of `CONTINUE_PROMPT`, like `continue`.

- [ ] **Step 1: Write the failing test**

In `autopilot/hooks/autopilot.test.ts`, add to the value import list from `./autopilot`, in alphabetical order:

```ts
  parseBadgeAvail,
```
(between `parseAway,`/`parseAskUser,`… as tasks 02–03 placed them and `parseClock,`; the list stays alphabetical), and
```ts
  parseLockOwner,
```
(between `parseCommand,` and `parseQueueInput,` / `parseUtcOffset,`, alphabetically).

Append at the end of the file:

```ts
describe('combined ping files', () => {
  test('a badge with the away fields reads as BadgeAvail', async () => {
    const badge = { isOn: true, phase: 'running', until: 9_000_000, queued: 3, awaySource: 'global', awaySetAt: 5_000_000, beat: 9_000_000 }
    expect(parseBadgeAvail(badge)).toEqual({ queued: 3, awaySource: 'global', awaySetAt: 5_000_000, beat: 9_000_000 })
    expect(parseBadgeAvail({ ...badge, awaySource: null, awaySetAt: null })).toEqual({ queued: 3, awaySource: null, awaySetAt: null, beat: 9_000_000 })
    expect(parseBadgeAvail({ ...badge, awaySource: 'session' })).toEqual({ queued: 3, awaySource: 'session', awaySetAt: 5_000_000, beat: 9_000_000 })
  })

  test('an old badge, an off badge or garbage is not counted', async () => {
    // Written by 0.4.x: no away fields.
    expect(parseBadgeAvail({ isOn: true, phase: 'running', until: 9_000_000 })).toBe(null)
    expect(parseBadgeAvail({ isOn: false })).toBe(null)
    expect(parseBadgeAvail(null)).toBe(null)
    expect(parseBadgeAvail('x')).toBe(null)
    expect(parseBadgeAvail([])).toBe(null)
    const badge = { isOn: true, queued: 3, awaySource: 'global', awaySetAt: 5_000_000, beat: 9_000_000 }
    expect(parseBadgeAvail({ ...badge, queued: '3' })).toBe(null)
    expect(parseBadgeAvail({ ...badge, beat: Number.NaN })).toBe(null)
    expect(parseBadgeAvail({ ...badge, awaySource: 'other' })).toBe(null)
    expect(parseBadgeAvail({ ...badge, awaySetAt: '5000000' })).toBe(null)
  })

  test('a lock owner reads as sid and time, extra fields dropped', async () => {
    expect(parseLockOwner({ sid: 'abc', at: 5_000_000 })).toEqual({ sid: 'abc', at: 5_000_000 })
    expect(parseLockOwner({ sid: 'abc', at: 5_000_000, extra: true })).toEqual({ sid: 'abc', at: 5_000_000 })
  })

  test('an unreadable lock owner is null, so the lock counts as stale', async () => {
    expect(parseLockOwner(null)).toBe(null)
    expect(parseLockOwner('abc')).toBe(null)
    expect(parseLockOwner({ sid: '', at: 5_000_000 })).toBe(null)
    expect(parseLockOwner({ sid: 'abc' })).toBe(null)
    expect(parseLockOwner({ sid: 'abc', at: '5000000' })).toBe(null)
    expect(parseLockOwner({ sid: 'abc', at: Number.POSITIVE_INFINITY })).toBe(null)
    expect(parseLockOwner({ sid: 7, at: 5_000_000 })).toBe(null)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `claude plugin test autopilot` (from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`)
Expected: FAIL — `parseBadgeAvail` and `parseLockOwner` are not exported by `./autopilot` (missing export / "is not a function"); every `combined ping files` test fails, all earlier tests still pass.

- [ ] **Step 3: Write minimal implementation**

**3a. `autopilot/hooks/autopilot.ts`** — append at the end of the file:

```ts
/**
 * The away fields of one fleet badge file (`<session id>.json`), for the
 * combined ping. A badge written before 0.5.0, an off badge or anything
 * malformed is null: it counts no questions.
 */
export function parseBadgeAvail(value: unknown): BadgeAvail | null {
  if (typeof value !== 'object' || value === null) return null
  const badge = value as Record<string, unknown>
  if (badge.isOn !== true) return null
  const { queued, awaySource, awaySetAt, beat } = badge
  if (typeof queued !== 'number' || !Number.isFinite(queued)) return null
  if (typeof beat !== 'number' || !Number.isFinite(beat)) return null
  if (awaySource !== 'session' && awaySource !== 'global' && awaySource !== null) return null
  if (awaySetAt !== null && (typeof awaySetAt !== 'number' || !Number.isFinite(awaySetAt))) return null

  return { queued, awaySource, awaySetAt, beat }
}

/** The `owner.json` of a combined-ping lock; null when missing fields or malformed (the lock is then stale). */
export function parseLockOwner(value: unknown): LockOwner | null {
  if (typeof value !== 'object' || value === null) return null
  const { sid, at } = value as Record<string, unknown>
  if (typeof sid !== 'string' || sid === '') return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null

  return { sid, at }
}
```

Make sure line 1's type import includes `BadgeAvail` and `LockOwner` (task 06 added them).

**3b. `autopilot/hooks/register.tsx` — imports.**

Line 3: the type import becomes, complete (tasks 07–08 added `Avail`, `AvailCommand`, `Effective`, `Mode`; this task adds `BadgeAvail`, `LockOwner`, `Pending`):

```ts
import type { Avail, AvailCommand, BadgeAvail, Effective, FinalReason, FinishedRecord, LockOwner, Mode, Pending, Run, TokenWindow } from '../types'
```

Value import list from `./autopilot`: add each of these not already present, keeping the list alphabetical (upper-case constants first, as now):

```ts
  HEARTBEAT_MS,
  availMode,
  canDeliver,
  combinedPingText,
  criticalCount,
  deliveredPending,
  eligibleForCombined,
  lockStale,
  parseBadgeAvail,
  parseLockOwner,
  pushPending,
  queuedAcross,
  sumQueued,
```

The toasts below build their counts with `criticalCount` (task 04) and `queuedAcross` (task 05): no count or plural is written by hand here.

**3c. `register.tsx` — module variables.** After line 75 (`let ceiling = DEFAULT_CEILING`), add:

```ts
// The text of a pending submit that is scheduled and not yet answered; a second one waits for it.
let flushingText: string | null = null
// Toasts already shown: held pings (`kind:key`) and global-away toasts (`global:<setAt>`), so each shows once, not every heartbeat.
const heldToasts = new Set<string>()
```

**3d. `register.tsx` — helpers.** After `checkWaitTimeout` (ends at line 415: `queue($, waitTimeoutPrompt(awaiting, now))` / `}`), before `function statusText`, add:

```ts
/** The combined-ping lock of the global away set at `setAt` (a directory: mkdir is atomic). */
const lockDir = (setAt: number) => `${statusDir()}/ping-${setAt}.lock`

async function readLockOwner($: EngineInterface, dir: string): Promise<LockOwner | null> {
  try {
    return parseLockOwner(JSON.parse(await $.fs.read(`${dir}/owner.json`)))
  } catch {
    return null
  }
}

/** The away fields of every session's badge; a missing, half-written or old badge is skipped. */
async function readBadges($: EngineInterface): Promise<BadgeAvail[]> {
  const entries = await $.fs.list(autopilotDir()).catch(() => [])
  const badges: BadgeAvail[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const badge = parseBadgeAvail(JSON.parse(await $.fs.read(`${autopilotDir()}/${entry.name}`)))
      if (badge) badges.push(badge)
    } catch {
      continue
    }
  }

  return badges
}

/**
 * Makes the lock (mkdir fails when it exists) or takes over one whose owner
 * stopped refreshing it. Either way this session acts as owner from the next
 * heartbeat on, if `owner.json` still names it then.
 */
async function claimLock($: EngineInterface, dir: string, owner: LockOwner | null, now: number): Promise<void> {
  const made = await $.process.run(['/bin/mkdir', dir]).catch(() => null)
  const isNew = made?.exitCode === 0
  if (!isNew && !lockStale(owner, false, now)) return
  await $.fs.write(`${dir}/owner.json`, JSON.stringify({ sid: sessionId, at: now }))
  await log($, isNew ? `combined ping: took the lock ${dir}` : `combined ping: took over a stale lock ${dir} (owner ${owner?.sid ?? 'unknown'})`)
}

/**
 * A session on the global away that sends no combined ping ("others only
 * toast", §7.3): one toast per away, one heartbeat after the expiry, only
 * when questions are queued somewhere (R7).
 */
async function toastGlobal($: EngineInterface, away: { until: number; setAt: number }, now: number, tail: string): Promise<void> {
  const id = `global:${away.setAt}`
  if (heldToasts.has(id)) return
  // One heartbeat after the expiry every live badge is fresh, as for the owner's sum.
  if (now < away.until + HEARTBEAT_MS) return
  heldToasts.add(id)
  const { total, sessions } = sumQueued(await readBadges($), away.setAt, now)
  if (total === 0) return
  $.ui.toast(`Autopilot: the global away time is over; ${queuedAcross(total, sessions)}. ${tail}`)
}

/**
 * One heartbeat of the combined ping (§7.3, R9). Only an eligible session
 * (a live run on that global away, asking on, away over) touches the lock, so
 * a session with no run never gets a prompt. The owner waits one heartbeat
 * after the expiry, sums the live badges and queues one `combined-ping`;
 * `done` is written when that ping is handed to the model. Every other run on
 * the same away only toasts, once.
 */
async function combinedTick($: EngineInterface): Promise<void> {
  if (!home || !run) return
  const global = await readGlobalAvail($)
  const away = global?.away ?? null
  if (!away || !('until' in away)) return
  const now = await $.clock.now()
  const eff = await currentEffective($)
  // Stopped while the files were read.
  if (!run) return
  const dir = lockDir(away.setAt)
  // The owner holding its undelivered combined ping keeps the lock alive, eligible or not
  // (parked, or its own away changed): nobody takes over and sends a second ping (R9).
  if ((run.pending ?? []).some(p => p.kind === 'combined-ping' && p.key === away.setAt)) {
    await $.fs.write(`${dir}/owner.json`, JSON.stringify({ sid: sessionId, at: now }))
    return
  }
  // A session record beats the global one (R5), or asking is off (D4): this away is not ours.
  const isOnThisAway = eff.awaySource === 'global' && !!eff.away && 'until' in eff.away && eff.away.setAt === away.setAt && eff.askOn
  if (!isOnThisAway) return
  if (!eligibleForCombined(run, eff, availMode(run, eff, now), away.setAt)) {
    // Parked, paused or wrapping: no prompt now, the person learns of it from a toast.
    if (run.phase !== 'running' && run.phase !== 'awaiting') {
      await toastGlobal($, away, now, `This session asks once it is back to work (now ${run.phase}).`)
    }
    return
  }

  const owner = await readLockOwner($, dir)
  if (await $.fs.exists(`${dir}/done`)) {
    // Another session sent the notification; the owner toasted when it delivered.
    if (owner?.sid !== sessionId) await toastGlobal($, away, now, 'Another session sent the notification; write here to answer this one.')
    return
  }
  if (owner?.sid !== sessionId) {
    await claimLock($, dir, owner, now)
    return
  }
  // Still alive: no one takes over while the owner waits for the sum.
  await $.fs.write(`${dir}/owner.json`, JSON.stringify({ sid: sessionId, at: now }))
  // One heartbeat after the expiry every live session has refreshed its badge.
  if (now < away.until + HEARTBEAT_MS) return

  const { total, sessions } = sumQueued(await readBadges($), away.setAt, now)
  if (total === 0) {
    // Nothing queued anywhere: silently over (R7).
    await $.fs.write(`${dir}/done`, String(now))
    await log($, 'combined ping: global away over, no questions queued in any session')
    return
  }
  if (!run) return
  run = pushPending(run, { kind: 'combined-ping', text: combinedPingText(total, sessions), key: away.setAt })
  await save($)
  await log($, `combined ping: ${total} questions in ${sessions} sessions, pending delivery`)
}

/** A run that cannot take a prompt now (parked, paused, wrapping…): the person still learns of a ping, once. */
function toastHeld($: EngineInterface, items: readonly Pending[], phase: string): void {
  for (const pending of items) {
    if (pending.kind !== 'ping' && pending.kind !== 'combined-ping') continue
    const id = `${pending.kind}:${pending.key}`
    if (heldToasts.has(id)) continue
    heldToasts.add(id)
    $.ui.toast(`Autopilot: away time is over and questions are queued; the session tells you once it is back to work (now ${phase}).`)
  }
}

/** Records entries handed to the model: saved, logged, pings toasted, a combined ping's lock marked done. */
async function markDelivered($: EngineInterface, items: readonly Pending[], via: 'tool' | 'turn' | 'idle'): Promise<void> {
  await save($)
  for (const pending of items) {
    heldToasts.delete(`${pending.kind}:${pending.key}`)
    await log($, `delivered ${pending.kind} (${via})`)
    if (pending.kind === 'ping') {
      $.ui.toast(`Autopilot: away time is over; ${criticalCount(run?.questions?.length ?? 0)} queued.`)
    }
    if (pending.kind !== 'combined-ping') continue
    $.ui.toast('Autopilot: away time is over; critical questions are queued in your sessions.')
    if (!home) continue
    await $.fs
      .write(`${lockDir(pending.key)}/done`, String(await $.clock.now()))
      .catch(async error => log($, `combined ping: could not mark the lock done: ${String(error)}`))
  }
}

/**
 * Submits pending entries once the session is idle. They leave the queue
 * before the submit, so a tool call of the turn it starts cannot hand them
 * over again; a dropped or failed submit puts them back.
 */
async function submitPending($: EngineInterface, items: readonly Pending[], via: 'turn' | 'idle'): Promise<void> {
  try {
    // A turn started meanwhile (the person, the goal loop) or the run moved on: they stay pending.
    if (isTurnRunning || !run || !canDeliver(run.phase)) return
    const pending = run.pending ?? []
    // A tool call may have taken some already.
    const taken = items.filter(item => pending.some(p => p.kind === item.kind && p.key === item.key))
    if (taken.length === 0) return
    run = taken.reduce((acc, item) => deliveredPending(acc, item), run)
    const answer = await $.prompt.submit({ text: taken.map(item => item.text).join('\n\n') }).catch(() => null)
    if (answer && answer.drop === undefined) {
      await markDelivered($, taken, via)
      return
    }
    if (run) run = taken.reduce((acc, item) => pushPending(acc, item), run)
    await save($)
    await log($, `pending prompt not delivered (${via}): ${answer?.drop ?? 'the submit failed'}`)
  } finally {
    flushingText = null
  }
}

/**
 * Hands `run.pending` to the model (§7.1). `tool`: taken now, the text goes
 * into the tool result's context. `turn` / `idle`: one submit once idle; the
 * text returned means a prompt is on its way, so the caller queues nothing
 * else. Null when nothing is pending or the phase cannot take a prompt.
 */
async function flushPending($: EngineInterface, via: 'tool' | 'turn' | 'idle'): Promise<string | null> {
  if (!run) return null
  const items = run.pending ?? []
  if (items.length === 0) return null
  if (!canDeliver(run.phase)) {
    toastHeld($, items, run.phase)
    return null
  }
  const text = items.map(item => item.text).join('\n\n')
  if (via === 'tool') {
    // Taken before the first await: a parallel tool call finds nothing left.
    run = items.reduce((acc, item) => deliveredPending(acc, item), run)
    await markDelivered($, items, via)

    return text
  }
  if (flushingText !== null) return flushingText
  flushingText = text
  const submitVia: 'turn' | 'idle' = via
  $.clock.after(300, () => void submitPending($, items, submitVia))

  return text
}
```

**3e. `register.tsx` — the heartbeat.** Replace the whole block at lines 483–497 (from the comment `// Time and the 5-hour reset can come while the session sits idle …` through the closing `})` of `$.clock.every`; it reads `$.clock.every(HEARTBEAT_MS, …)` after task 06, and any `refreshMode` call task 07 put in it is replaced by the one below) with:

```ts
    // Time and the 5-hour reset can come while the session sits idle (or after a reload lost the timers).
    $.clock.every(HEARTBEAT_MS, () => {
      void (async () => {
        await syncId($)
        // Before the idle guard: an away running out or a global change by another
        // session (R2) changes the mode mid-turn too. No run: nothing is ever queued.
        // refreshMode also saves at least every half heartbeat, which keeps the badge's
        // beat fresh for the combined ping (live sessions only); no second save here.
        await refreshMode($)
        await combinedTick($).catch(async error => log($, `combined ping failed: ${String(error)}`))
        if (!run || isTurnRunning) return
        const now = await $.clock.now()
        if ((run.phase === 'running' || run.phase === 'waiting' || run.phase === 'awaiting') && now >= run.until) {
          const instruction = await enterFinal($, 'time')
          if (instruction) queue($, instruction)
          return
        }
        if (run.phase === 'waiting' && run.waitUntil && now >= run.waitUntil) {
          // The resumed turn's first tool call, or its end, carries what is pending.
          await wake($)
          return
        }
        // A delivered prompt wakes a wait too: its timeout check can wait a beat.
        if (await flushPending($, 'idle')) return
        await checkWaitTimeout($, now)
      })()
    })
```

**3f. `register.tsx` — the generic `tool.call`.** In `on('tool.call', async ($, e, next) => {` (lines 870–915), replace the part from `const usage = await $.session.usage().catch(() => null)` (line 891) through `return { ...ran, context: [...(ran.context ?? []), instruction] }` (line 914) with the block below. The first line alone is not a unique anchor: `const usage = await $.session.usage().catch(() => null)` also occurs in `turn.complete` (line 946). The Edit's `old_string` must be the whole range 891–914, from that line through `return { ...ran, context: [...(ran.context ?? []), instruction] }`; that range is unique.

```ts
    // What must reach the model (a ping, the drain, a released wait) rides on this result,
    // but not on wait_for or the restart: both tell the session to end its turn.
    const isTurnEnding = e.tool === FULL_WAIT_TOOL || e.tool === FULL_RESTART_TOOL
    const pendingText = isTurnEnding ? null : await flushPending($, 'tool')
    const pendingContext = pendingText ? [pendingText] : []

    const usage = await $.session.usage().catch(() => null)
    const percent = usage?.context.percent ?? null
    const now = await $.clock.now()

    // Token limits come before the context trigger.
    const limitInstruction = await applyLimits($, usage?.rateLimits ?? [], now)
    if (limitInstruction) return { ...ran, context: [...(ran.context ?? []), ...pendingContext, limitInstruction] }

    // Parallel tool calls finish together: decide and flip the phase with no
    // await in between, so only the first of them carries the instruction.
    const action = wrapMidTurn(run, now, percent, ceiling)
    if (!action) return pendingText ? { ...ran, context: [...(ran.context ?? []), ...pendingContext] } : ran
    const reason = now >= run.until ? 'time' : 'restarts'
    run.phase = action === 'wrapup' ? 'wrapping' : 'final'
    if (action === 'final') {
      run.finalReason = reason
      run.finalAt = now
    }
    await save($)
    await log($, `${action} requested mid-turn at ${percent ?? '?'}% context (trigger ${effectiveTrigger(run, ceiling)}%)`)
    if (action === 'final') await clearGoal($)
    const instruction = action === 'wrapup' ? wrapupPrompt(run, percent) : finalPrompt(run, reason)

    return { ...ran, context: [...(ran.context ?? []), ...pendingContext, instruction] }
```

Everything above line 891 in that handler (the `agentId`/paused guard, `toolsThisTurn`, `endWait`, the `AskUserQuestion` deny as task 07 left it, `next(e)`, the `ran.deny` block) stays as it is.

**3g. `register.tsx` — `turn.complete`.** Replace lines 973–979:

```ts
    if (action === 'continue') {
      run.idleTurns = calledTools ? 0 : run.idleTurns + 1
      await save($)
      // With a goal set, its own loop starts the next turn; autopilot only watches.
      if (run.goal && isGoalSet) watchGoal($)
      else queue($, CONTINUE_PROMPT)
    }
```

with:

```ts
    if (action === 'continue') {
      run.idleTurns = calledTools ? 0 : run.idleTurns + 1
      await save($)
      // With a goal set, its own loop starts the next turn; autopilot only watches.
      // Otherwise a pending prompt (a ping, the drain) is the next prompt instead of the nudge.
      if (run.goal && isGoalSet) watchGoal($)
      else if (!(await flushPending($, 'turn'))) queue($, CONTINUE_PROMPT)
    }
```

and in the `resume-done` branch (lines 980–989) replace

```ts
      // With a goal: setting it again starts the next turn, so no prompt of ours.
      if (run.goal) await setGoal($)
      else queue($, CONTINUE_PROMPT)
```

with

```ts
      // With a goal: setting it again starts the next turn, so no prompt of ours.
      // Otherwise what waited through the restart goes first.
      if (run.goal) await setGoal($)
      else if (!(await flushPending($, 'turn'))) queue($, CONTINUE_PROMPT)
```

Nothing else changes: `wake` and the revive path return the run to `running`, and the paths above deliver from there.

- [ ] **Step 4: Run tests, expected PASS (all existing tests too)**

Run: `claude plugin test autopilot` (from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`)
Expected: PASS — the `combined ping files` tests and every earlier test (tasks 01–09 and the original suite).

Run: `claude plugin validate autopilot`
Expected: no errors (register.tsx type-checks: `Pending`, `BadgeAvail`, `LockOwner` imported; `answer.drop` narrows `PromptSubmitResult`; `$.fs.list` entries carry `kind`/`name`).

- [ ] **Step 4b: Live check (no fakes for register.tsx)**

`/reload-plugins` in two sessions A and B of the worktree, each with `/autopilot 2h 70 "test role" --ask-user`. Watch `~/.claude/autopilot/<sid>.log` and `~/.claude/autopilot/status/`.

1. **Session expiry ping, delivered on a tool call.** In A: `/away for 2m`. Ask A's model to call `queue_question` once (a critical question) and then keep reading files. After 2 min, within one heartbeat: A's log has `delivered ping (tool)` (or `(turn)`/`(idle)` if A was idle), a toast `Autopilot: away time is over; 1 critical question is queued.`, and the model sends exactly one PushNotification. `/autopilot` in A no longer lists a `ping` pending. No second ping on later heartbeats.
2. **Held while parked.** Start A's run with `--5h 1` so its first tool call parks it in `waiting`, then repeat 1 while it is parked. At expiry: one toast `… the session tells you once it is back to work (now waiting).`, no prompt submitted, log has no `delivered`. After the 5-hour wake: `delivered ping (tool)` or `(turn)` in the log.
3. **Drain via turn.** In A: `/away for 2m`, queue one question, then `/back` while A is idle. Next heartbeat: log `delivered drain (idle)`; one prompt asks question `#1`. With A mid-turn instead: the drain prompt arrives as context of the next tool call (`delivered drain (tool)`), and no duplicate drain prompt follows at turn end.
4. **`/away` then `/back` within one heartbeat** (Focus 4): exactly one `delivered drain` line in the log.
5. **Combined ping** (R9). In A: `/away for 2m --global`. Queue one question in A and two in B. After expiry plus ~30–60 s: exactly one of A/B logs `combined ping: took the lock …/ping-<setAt>.lock`, then `combined ping: 3 questions in 2 sessions, pending delivery`, then `delivered combined-ping (…)`; one toast there; `status/ping-<setAt>.lock/done` exists; the other session logs no `delivered combined-ping` and, within one heartbeat after `done`, shows one toast `Autopilot: the global away time is over; 3 critical questions are queued across 2 sessions. Another session sent the notification; …` (no second one on later heartbeats). Every eligible session still drains on its own when the person writes in it.
6. **No run, no prompt** (Focus 3). A third session C with no autopilot run, same `--global` away and expiry: C's log shows nothing for the combined ping, C gets no prompt, and `owner.json` never names C.
7. **Dead owner.** Repeat 5; as soon as the owner logs `took the lock`, quit that session. Within ~2–3 heartbeats the other logs `took over a stale lock` and delivers the combined ping once.
8. **Nothing queued** (R7). `/away for 2m --global` with empty queues: after expiry the owner logs `no questions queued in any session`, `done` exists, no toast in either session, no prompt.
9. **Parked on a global away.** Repeat 5 with B parked in `waiting` (`--5h 1`, as in 2): A sends the combined ping; B shows one toast `… This session asks once it is back to work (now waiting).`, no prompt, no `delivered` line.
10. **A held ping is dropped when the person is away again** (task 04, D4/R8). Repeat 2 until the ping is held while A is parked; then `/away for 1h` (or `/ask-user off`) in A. After the 5-hour wake: no `delivered ping` line, and no PushNotification about the old away.
11. **A parked owner keeps its combined ping** (R9). Repeat 5, and once the owner logs `pending delivery`, park it (`--5h 1` run, as in 2). The other session never logs `took over a stale lock` while the owner is parked; after the owner's wake it logs `delivered combined-ping` once.

- [ ] **Step 5: Ready for commit**

Tell the editor these files are ready (agents do not commit):
- `autopilot/hooks/autopilot.ts`
- `autopilot/hooks/autopilot.test.ts`
- `autopilot/hooks/register.tsx`

Suggested message:

```
(feat): Deliver pending autopilot prompts and the combined ping

- flushPending hands run.pending to the model on a tool call, at turn end or when idle
- An entry leaves the queue only once handed over; a dropped submit puts it back
- Held pings toast once while the run is parked, paused or wrapping
- Heartbeat refreshes the mode, the badge beat and the combined-ping lock before the idle guard
- combinedTick: mkdir lock, owner refresh, takeover after two beats, one ping per global away
- Other sessions on the global away toast once instead of pinging
- parseBadgeAvail and parseLockOwner read the badge and lock files safely
```
