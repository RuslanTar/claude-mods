### Task 06: Combined-ping math (`HEARTBEAT_MS`, `eligibleForCombined`, `sumQueued`, `lockStale`)

Pure helpers for the global-expiry combined ping (spec §7.3, R9). Task 10 wires them into the heartbeat (`combinedTick`). This task owns **Review Focus 3** on the pure side: a session with no autopilot run is never eligible, so it never gets a prompt.

**Files:**
- Modify: `autopilot/hooks/autopilot.ts`
  - the multi-line `import type { … } from '../types'` at the top (task 01's, extended by 02–04): add `BadgeAvail`, `LockOwner` (`Effective` and `Mode` are already there); the complete list is shown in Step 3
  - append a new section at the end of the file (after `DEFERRED_NOTE`, currently lines 1030–1032; after any code tasks 01–05 appended)
- Modify: `autopilot/hooks/register.tsx`
  - the value import list from `./autopilot` (lines 4–~60): add `HEARTBEAT_MS` in alphabetical order (after `GRACE…`/`FULL_…` entries, before `NOT_RUNNING_TEXT`)
  - line 484 `$.clock.every(30_000, () => {` → `$.clock.every(HEARTBEAT_MS, () => {` (find it by that text; line may have shifted by a few lines after task 05)
- Test: `autopilot/hooks/autopilot.test.ts`
  - the `import type { … } from '../types'` line (line 3): add `BadgeAvail`, `LockOwner` (`Effective` is there since task 04); the complete line is shown in Step 1
  - the value import list from `./autopilot` (lines 4–53 before tasks 01–05): add `HEARTBEAT_MS`, `eligibleForCombined`, `lockStale`, `sumQueued` in alphabetical order (upper-case constants first, as now)
  - append a new `describe('combined ping', …)` block at the end of the file (after `describe('hardening', …)`, currently ending at line 1159)

**Interfaces:**
- Consumes (task 01, `autopilot/types/index.d.ts`):
  - `type Mode = 'plain' | 'queueing' | 'overdue' | 'draining' | 'asking'`
  - `type AwayField = { until: number; setAt: number } | { back: true; setAt: number }`
  - `type Effective = { away: AwayField | null; awaySource: 'session' | 'global' | null; askOn: boolean; askRecorded: boolean }`
  - `type BadgeAvail = { queued: number; awaySource: 'session' | 'global' | null; awaySetAt: number | null; beat: number }`
  - `type LockOwner = { sid: string; at: number }`
  - existing `Run`, `Phase`
- Produces (`autopilot/hooks/autopilot.ts`):
  - `export const HEARTBEAT_MS = 30_000`
  - `export function eligibleForCombined(run: Run | null, eff: Effective, mode: Mode | null, globalSetAt: number): boolean`
  - `export function sumQueued(badges: readonly BadgeAvail[], setAt: number, now: number): { total: number; sessions: number }`
  - `export function lockStale(owner: LockOwner | null, done: boolean, now: number): boolean`

**Decisions this task fixes (task 10 relies on them):**
- `eligibleForCombined` is true only when **all** hold: `run !== null`; `run.phase` is `running` or `awaiting`; `eff.awaySource === 'global'`; `eff.away` is an `{until}` record whose `setAt === globalSetAt`; `eff.askOn`; `mode` is `overdue`, `draining` or `asking`. `plain` (D5), `queueing` (still away, or ask-user off — D4) and `null` (no run) are never eligible. The session's own queue may be empty: it can still own the lock and send the sum of the others.
- `sumQueued` counts a badge when `awaySource === 'global'`, `awaySetAt === setAt`, `now - beat <= 2 * HEARTBEAT_MS` (dead sessions drop out), and `queued` is a finite number `> 0`. `sessions` = how many badges counted; `total` = sum of their `queued` (floored).
- `lockStale`: `done` → `false` (a finished ping is never taken over); `owner === null` (missing or unreadable `owner.json`) → `true`; otherwise `now - owner.at > 2 * HEARTBEAT_MS`. An `at` in the future is not stale.

- [ ] **Step 1: Write the failing test**

In `autopilot/hooks/autopilot.test.ts`, the type import on line 3 becomes (complete list after tasks 01–06):

```ts
import type { Avail, Awaiting, BadgeAvail, Effective, LockOwner, Pending, Question, Run, WaitReason } from '../types'
```

Add to the value import list from `./autopilot`, in alphabetical order:

```ts
  HEARTBEAT_MS,
```
(right after `GRACE_MS,`, before `QUEUE_TOOL,` added by task 03), and
```ts
  eligibleForCombined,
```
(between `effectiveTrigger,` and `endClock,`, after any `effective…` names tasks 01–05 added),
```ts
  lockStale,
```
(between `limitAction,` and `namedSkills,`),
```ts
  sumQueued,
```
(between `stripTag,` (task 03) and `targetChange,`).

Append at the end of the file:

```ts
describe('combined ping', () => {
  const SET_AT = 5_000_000
  const NOW = 10_000_000

  /** The effective status of a session whose away is the global record set at `setAt`. */
  function globalAway(over: Partial<Effective> = {}, setAt = SET_AT): Effective {
    return { away: { until: SET_AT + 3_600_000, setAt }, awaySource: 'global', askOn: true, askRecorded: true, ...over }
  }

  function badge(over: Partial<BadgeAvail>): BadgeAvail {
    return { queued: 2, awaySource: 'global', awaySetAt: SET_AT, beat: NOW - 1_000, ...over }
  }

  test('the heartbeat is 30 seconds', async () => {
    expect(HEARTBEAT_MS).toBe(30_000)
  })

  test('a running or awaiting session on that global away, asking on, after expiry is eligible', async () => {
    for (const mode of ['overdue', 'draining', 'asking'] as const) {
      expect(eligibleForCombined(run({}), globalAway(), mode, SET_AT)).toBe(true)
    }
    expect(eligibleForCombined(run({ phase: 'awaiting' }), globalAway(), 'overdue', SET_AT)).toBe(true)
    // An empty own queue still qualifies: the owner reports the sum over all sessions.
    expect(eligibleForCombined(run({ questions: [] }), globalAway(), 'asking', SET_AT)).toBe(true)
  })

  test('a session with no autopilot run is never eligible', async () => {
    expect(eligibleForCombined(null, globalAway(), null, SET_AT)).toBe(false)
    expect(eligibleForCombined(null, globalAway(), 'overdue', SET_AT)).toBe(false)
    expect(eligibleForCombined(run({}), globalAway(), null, SET_AT)).toBe(false)
  })

  test('a run outside running and awaiting only toasts', async () => {
    for (const phase of ['wrapping', 'restarting', 'resuming', 'waiting', 'final', 'paused'] as const) {
      expect(eligibleForCombined(run({ phase }), globalAway(), 'overdue', SET_AT)).toBe(false)
    }
  })

  test('a session-sourced away, another global away or a back record is excluded', async () => {
    expect(eligibleForCombined(run({}), globalAway({ awaySource: 'session' }), 'overdue', SET_AT)).toBe(false)
    expect(eligibleForCombined(run({}), globalAway({}, SET_AT + 1), 'overdue', SET_AT)).toBe(false)
    expect(eligibleForCombined(run({}), globalAway({ away: { back: true, setAt: SET_AT } }), 'asking', SET_AT)).toBe(false)
    expect(eligibleForCombined(run({}), globalAway({ away: null, awaySource: null }), 'asking', SET_AT)).toBe(false)
  })

  test('asking off, plain or still queueing is excluded (D4, D5)', async () => {
    expect(eligibleForCombined(run({}), globalAway({ askOn: false }), 'overdue', SET_AT)).toBe(false)
    expect(eligibleForCombined(run({}), globalAway(), 'plain', SET_AT)).toBe(false)
    expect(eligibleForCombined(run({}), globalAway(), 'queueing', SET_AT)).toBe(false)
  })

  test('an old stored run without the new fields is judged by phase and status only', async () => {
    const stored = run({
      questions: [{ id: 1, text: 'Push?', kind: 'answer', provisional: null, at: 0 }],
      lastMode: 'overdue',
    }) as Partial<Run>
    expect(eligibleForCombined(stored as Run, globalAway(), 'overdue', SET_AT)).toBe(true)
    // Stored by 0.4.x: no queue, no last mode, not even the --ask-user flag.
    delete stored.questions
    delete stored.lastMode
    delete stored.askUser
    expect(eligibleForCombined(stored as Run, globalAway(), 'overdue', SET_AT)).toBe(true)
    expect(eligibleForCombined(stored as Run, globalAway(), 'queueing', SET_AT)).toBe(false)
  })

  test('sumQueued adds queued questions of live sessions on the same global away', async () => {
    expect(sumQueued([badge({ queued: 3 }), badge({ queued: 4 }), badge({ queued: 1 })], SET_AT, NOW)).toEqual({ total: 8, sessions: 3 })
  })

  test('sumQueued drops a session whose heartbeat is older than two beats', async () => {
    const edge = badge({ queued: 1, beat: NOW - 2 * HEARTBEAT_MS })
    const stale = badge({ queued: 5, beat: NOW - 2 * HEARTBEAT_MS - 1 })
    expect(sumQueued([badge({ queued: 2 }), edge, stale], SET_AT, NOW)).toEqual({ total: 3, sessions: 2 })
  })

  test('sumQueued skips another away, a session-sourced away and sessions with nothing queued', async () => {
    const badges = [
      badge({ queued: 2 }),
      badge({ queued: 9, awaySetAt: SET_AT + 1 }),
      badge({ queued: 9, awaySetAt: null }),
      badge({ queued: 9, awaySource: 'session' }),
      badge({ queued: 9, awaySource: null }),
      badge({ queued: 0 }),
      badge({ queued: Number.NaN }),
      badge({ queued: -3 }),
    ]
    expect(sumQueued(badges, SET_AT, NOW)).toEqual({ total: 2, sessions: 1 })
  })

  test('sumQueued with no live queues is zero (R7: no ping)', async () => {
    expect(sumQueued([], SET_AT, NOW)).toEqual({ total: 0, sessions: 0 })
    expect(sumQueued([badge({ queued: 0 })], SET_AT, NOW)).toEqual({ total: 0, sessions: 0 })
  })

  test('a lock with done is never stale', async () => {
    const owner: LockOwner = { sid: 'a', at: 0 }
    expect(lockStale(owner, true, NOW)).toBe(false)
    expect(lockStale(null, true, NOW)).toBe(false)
  })

  test('a lock without done goes stale after two heartbeats or without an owner', async () => {
    expect(lockStale({ sid: 'a', at: NOW - 2 * HEARTBEAT_MS }, false, NOW)).toBe(false)
    expect(lockStale({ sid: 'a', at: NOW - 2 * HEARTBEAT_MS - 1 }, false, NOW)).toBe(true)
    expect(lockStale({ sid: 'a', at: NOW + 60_000 }, false, NOW)).toBe(false)
    expect(lockStale(null, false, NOW)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `claude plugin test autopilot` (from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`)
Expected: FAIL — `HEARTBEAT_MS`, `eligibleForCombined`, `sumQueued` and `lockStale` are not exported by `./autopilot` (missing export / "is not a function"); every `combined ping` test fails, all earlier tests still pass.

- [ ] **Step 3: Write minimal implementation**

In `autopilot/hooks/autopilot.ts`, the type import at the top becomes (complete and final list after tasks 01–06; `BadgeAvail` and `LockOwner` are new):

```ts
import type {
  Avail,
  AvailCommand,
  Awaiting,
  AwayField,
  BadgeAvail,
  Command,
  Effective,
  FinalReason,
  FinishedRecord,
  LockOwner,
  Mode,
  Pending,
  Phase,
  Question,
  QueueInput,
  Run,
  StartCommand,
  TokenWindow,
  WaitReason,
} from '../types'
```

Append at the end of the file:

```ts
/** How often the heartbeat runs in register.tsx; the combined ping measures liveness and lock age in beats. */
export const HEARTBEAT_MS = 30_000

/** Modes in which a global away is over and asking is on: the ones a combined ping may reach. */
const COMBINED_MODES: readonly Mode[] = ['overdue', 'draining', 'asking']

/**
 * Whether this session takes part in the combined ping for the global away
 * set at `globalSetAt`: a live run (`running` or `awaiting`) whose effective
 * away is that global record, with asking on and the away over. No run, a
 * session-sourced away, another global away, asking off (D4) or a plain run
 * (D5) never is, so such a session is never sent a prompt.
 */
export function eligibleForCombined(run: Run | null, eff: Effective, mode: Mode | null, globalSetAt: number): boolean {
  if (!run || mode === null) return false
  if (run.phase !== 'running' && run.phase !== 'awaiting') return false
  if (eff.awaySource !== 'global' || !eff.away || !('until' in eff.away)) return false
  if (eff.away.setAt !== globalSetAt || !eff.askOn) return false

  return COMBINED_MODES.includes(mode)
}

/**
 * Queued questions across sessions on the global away set at `setAt`: only
 * badges with that away, a heartbeat within two beats (dead sessions do not
 * count) and at least one question. `sessions` counts those badges.
 */
export function sumQueued(badges: readonly BadgeAvail[], setAt: number, now: number): { total: number; sessions: number } {
  let total = 0
  let sessions = 0
  for (const badge of badges) {
    if (badge.awaySource !== 'global' || badge.awaySetAt !== setAt) continue
    if (now - badge.beat > 2 * HEARTBEAT_MS) continue
    if (!Number.isFinite(badge.queued) || badge.queued <= 0) continue
    total += Math.floor(badge.queued)
    sessions++
  }

  return { total, sessions }
}

/**
 * Whether another eligible session may take over a combined-ping lock: never
 * once `done` is written; yes when `owner.json` is missing or unreadable, or
 * its owner has not refreshed it for more than two heartbeats.
 */
export function lockStale(owner: LockOwner | null, done: boolean, now: number): boolean {
  if (done) return false
  if (!owner) return true

  return now - owner.at > 2 * HEARTBEAT_MS
}
```

In `autopilot/hooks/register.tsx`, add `HEARTBEAT_MS,` to the value import list from `./autopilot` (alphabetically, after `FULL_WAIT_TOOL,` and before `NOT_RUNNING_TEXT,`), and replace

```ts
    $.clock.every(30_000, () => {
```

with

```ts
    $.clock.every(HEARTBEAT_MS, () => {
```

Nothing else in `register.tsx` changes in this task.

- [ ] **Step 4: Run tests, expected PASS (all existing tests too)**

Run: `claude plugin test autopilot` (from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`)
Expected: PASS — all `combined ping` tests and every earlier test (tasks 01–05 and the original suite).

Run: `claude plugin validate autopilot`
Expected: no errors (the `register.tsx` import and heartbeat interval still type-check).

- [ ] **Step 5: Ready for commit**

Tell the editor these files are ready (agents do not commit):
- `autopilot/hooks/autopilot.ts`
- `autopilot/hooks/autopilot.test.ts`
- `autopilot/hooks/register.tsx`

Suggested message:

```
(feat): Add combined-ping math for global away expiry

- Export HEARTBEAT_MS and use it for the register.tsx heartbeat
- eligibleForCombined: only live runs on that global away, asking on, away over
- sumQueued: sum queued questions over live badges of the same global away
- lockStale: take over a combined-ping lock only without done and after two beats
```
