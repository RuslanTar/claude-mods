### Task 01: Types, record validation, effective status, `availMode`

**Files:**
- Modify: `autopilot/types/index.d.ts`, lines 26-36 (`Awaiting`: add `questionId?`), lines 41-81 (`Run`: add seven optional fields after `graceAsks?` at line 80), append new types after line 109 (end of file)
- Modify: `autopilot/hooks/autopilot.ts`, line 1 (type import), append a new block after line 1032 (end of file, after `DEFERRED_NOTE`)
- Test: `autopilot/hooks/autopilot.test.ts`, line 3 (type import), lines 4-53 (value import list), insert the `avail()` helper after line 80 (`START_DEFAULTS`), append a new `describe` after line 1159 (end of file)

**Interfaces:**
- Consumes: nothing from earlier tasks. Existing: `Run`, `Awaiting` (types), `run(over)` factory (autopilot.test.ts:55-78).
- Produces (types, `autopilot/types/index.d.ts`): `Mode`, `AwayField`, `AskField`, `Avail`, `Effective`, `Question`, `QueueInput`, `Pending`, `AvailCommand`, `BadgeAvail`, `LockOwner` exactly as in the index contract; `Run.questions?: Question[]`, `Run.drain?: boolean`, `Run.askingId?: number`, `Run.nextQuestionId?: number`, `Run.pingedFor?: number`, `Run.pending?: Pending[]`, `Run.lastMode?: Mode`; `Awaiting.questionId?: number`.
- Produces (functions, `autopilot/hooks/autopilot.ts`):
  - `validAvail(value: unknown, now: number): Avail | null`
  - `effective(run: Run | null, session: Avail | null, global: Avail | null): Effective`
  - `isAwayActive(away: AwayField | null, now: number): boolean`
  - `isAwayExpired(away: AwayField | null, now: number): boolean`
  - `availMode(run: Run, eff: Effective, now: number): Mode`
- Produces (test helper, module level in `autopilot.test.ts`, used by task 02 and later): `avail(over: Partial<Avail>): Avail`

Review Focus owned here: line 2 (`validAvail` on missing / empty / half-written / far-future `setAt`; never throws).

---

- [ ] **Step 1: Write the failing test**

1a. In `autopilot/hooks/autopilot.test.ts` replace line 3

```ts
import type { Awaiting, Run, WaitReason } from '../types'
```

with

```ts
import type { Avail, Awaiting, Question, Run, WaitReason } from '../types'
```

1b. In the value import list (lines 4-53) add five names, keeping the alphabetical order:
- after `  autoAnswersQuestions,` (line 12) add `  availMode,`
- before `  effectiveTrigger,` (line 14) add `  effective,`
- before `  isDoneAnswer,` (line 28) add `  isAwayActive,` and `  isAwayExpired,`
- after `  untilFromClock,` (line 46) add `  validAvail,`

The affected part of the list then reads:

```ts
  autoAnswersQuestions,
  availMode,
  canRestart,
  effective,
  effectiveTrigger,
  …
  identityFromRows,
  isAwayActive,
  isAwayExpired,
  isDoneAnswer,
  …
  untilFromClock,
  validAvail,
  waitPhaseRefusal,
```

1c. After line 80 (`const START_DEFAULTS = …`) insert:

```ts

/** An availability record with nothing set, then the given fields. */
function avail(over: Partial<Avail>): Avail {
  return { v: 1, away: null, askUser: null, ...over }
}
```

1d. Append at the end of the file (after line 1159):

```ts

describe('availability: records, effective status, mode', () => {
  const NOW = 1_000_000
  const MIN = 60_000
  const HOUR = 3_600_000
  const QUEUED: Question[] = [{ id: 1, text: 'Push the release tag?', kind: 'action', provisional: null, at: NOW }]
  const ACTIVE = { until: NOW + HOUR, setAt: 0 }
  const PAST = { until: NOW - 1, setAt: 0 }
  const OFF = { on: false, setAt: 0 }
  const ON = { on: true, setAt: 0 }
  const mode = (subject: Run, session: Avail | null, global: Avail | null, now = NOW) =>
    availMode(subject, effective(subject, session, global), now)

  test('validAvail keeps a well-formed record and only its known fields', async () => {
    const stored = {
      v: 1,
      away: { until: NOW + HOUR, setAt: NOW, extra: 'x' },
      askUser: { on: false, setAt: NOW - HOUR },
      note: 'x',
    }
    expect(validAvail(stored, NOW)).toEqual({
      v: 1,
      away: { until: NOW + HOUR, setAt: NOW },
      askUser: { on: false, setAt: NOW - HOUR },
    })
    expect(validAvail({ v: 1, away: { back: true, setAt: NOW }, askUser: null }, NOW)).toEqual({
      v: 1,
      away: { back: true, setAt: NOW },
      askUser: null,
    })
    // A record that sets nothing yet: both fields read as not set.
    expect(validAvail({ v: 1 }, NOW)).toEqual({ v: 1, away: null, askUser: null })
  })

  test('validAvail turns a missing, empty, half-written or foreign record into null, never throws', async () => {
    const bad: unknown[] = [
      undefined,
      null,
      '',
      '{"v":1,"away":',
      0,
      [],
      {},
      { v: 2, away: null, askUser: null },
      { v: '1', away: null, askUser: null },
      { v: 1, away: 'soon' },
      { v: 1, away: { until: NOW } },
      { v: 1, away: { until: 'later', setAt: NOW } },
      { v: 1, away: { until: Number.NaN, setAt: NOW } },
      { v: 1, away: { until: NOW, setAt: Number.POSITIVE_INFINITY } },
      { v: 1, away: { back: false, setAt: NOW } },
      { v: 1, away: { back: 'yes', until: NOW, setAt: NOW } },
      { v: 1, askUser: { on: 'yes', setAt: NOW } },
      { v: 1, askUser: { on: true } },
      { v: 1, askUser: true },
    ]
    for (const value of bad) expect(validAvail(value, NOW)).toBeNull()
  })

  test('validAvail rejects a setAt more than 5 minutes ahead of now', async () => {
    expect(validAvail({ v: 1, away: { until: NOW + HOUR, setAt: NOW + 5 * MIN }, askUser: null }, NOW)).not.toBe(null)
    expect(validAvail({ v: 1, away: { until: NOW + HOUR, setAt: NOW + 5 * MIN + 1 }, askUser: null }, NOW)).toBeNull()
    expect(validAvail({ v: 1, away: null, askUser: { on: true, setAt: NOW + 5 * MIN + 1 } }, NOW)).toBeNull()
    expect(validAvail({ v: 1, away: { back: true, setAt: NOW + 24 * HOUR }, askUser: null }, NOW)).toBeNull()
  })

  test('effective: the session beats the global record per field, even when older', async () => {
    const session = avail({ away: { until: NOW + HOUR, setAt: 1 } })
    const global = avail({ away: { until: NOW + 2 * HOUR, setAt: NOW }, askUser: { on: false, setAt: NOW } })
    expect(effective(run({ askUser: true }), session, global)).toEqual({
      away: { until: NOW + HOUR, setAt: 1 },
      awaySource: 'session',
      askOn: false,
      askRecorded: true,
    })
  })

  test('effective: a session /back hides a global away', async () => {
    const eff = effective(run({ askUser: true }), avail({ away: { back: true, setAt: 1 } }), avail({ away: ACTIVE }))
    expect(eff.away).toEqual({ back: true, setAt: 1 })
    expect(eff.awaySource).toBe('session')
    expect(isAwayActive(eff.away, NOW)).toBe(false)
  })

  test('effective: the global record fills a field the session leaves unset', async () => {
    expect(effective(run({}), avail({ askUser: ON }), avail({ away: ACTIVE }))).toEqual({
      away: ACTIVE,
      awaySource: 'global',
      askOn: true,
      askRecorded: true,
    })
    expect(effective(run({}), null, null)).toEqual({ away: null, awaySource: null, askOn: false, askRecorded: false })
  })

  test('effective: askOn comes from a record, else from the run flag', async () => {
    expect(effective(run({ askUser: true }), null, null).askOn).toBe(true)
    expect(effective(run({ askUser: false }), null, null).askOn).toBe(false)
    expect(effective(null, null, null).askOn).toBe(false)
    expect(effective(null, null, avail({ askUser: ON })).askOn).toBe(true)
    expect(effective(run({ askUser: false }), avail({ askUser: ON }), null).askOn).toBe(true)
    expect(effective(run({ askUser: true }), null, avail({ askUser: OFF })).askOn).toBe(false)
    // A run stored before --ask-user existed has no flag at all.
    const older = { ...run({}), askUser: undefined } as unknown as Run
    expect(effective(older, null, null).askOn).toBe(false)
  })

  test('an away is active before its end and expired from its end on; /back is neither', async () => {
    const away = { until: NOW, setAt: 0 }
    expect(isAwayActive(away, NOW - 1)).toBe(true)
    expect(isAwayExpired(away, NOW - 1)).toBe(false)
    expect(isAwayActive(away, NOW)).toBe(false)
    expect(isAwayExpired(away, NOW)).toBe(true)
    for (const none of [null, { back: true as const, setAt: 0 }]) {
      expect(isAwayActive(none, NOW)).toBe(false)
      expect(isAwayExpired(none, NOW)).toBe(false)
    }
  })

  test('availMode: no askUser record anywhere and no --ask-user stays plain (D5)', async () => {
    const plain = run({ questions: QUEUED, drain: true })
    expect(mode(plain, null, null)).toBe('plain')
    expect(mode(plain, avail({ away: ACTIVE }), null)).toBe('plain')
    expect(mode(plain, avail({ away: PAST }), null)).toBe('plain')
    expect(mode(plain, null, avail({ away: ACTIVE }))).toBe('plain')
  })

  test('availMode: asking switched off queues and never goes overdue (D4)', async () => {
    const asked = run({ askUser: true, questions: QUEUED, drain: true })
    expect(mode(asked, avail({ askUser: OFF }), null)).toBe('queueing')
    expect(mode(asked, avail({ askUser: OFF, away: PAST }), null)).toBe('queueing')
    expect(mode(asked, null, avail({ askUser: OFF, away: PAST }))).toBe('queueing')
    expect(mode(run({ askUser: true }), avail({ askUser: OFF }), null)).toBe('queueing')
  })

  test('availMode: an active away queues, even while draining and with asking on (R13)', async () => {
    const draining = run({ askUser: true, questions: QUEUED, drain: true })
    expect(mode(draining, avail({ away: ACTIVE }), null)).toBe('queueing')
    expect(mode(draining, null, avail({ away: ACTIVE }))).toBe('queueing')
    expect(mode(run({}), avail({ askUser: ON, away: ACTIVE }), null)).toBe('queueing')
  })

  test('availMode: draining needs the drain flag and a non-empty queue', async () => {
    expect(mode(run({ askUser: true, questions: QUEUED, drain: true }), null, null)).toBe('draining')
    expect(mode(run({ askUser: true, questions: QUEUED, drain: true }), avail({ away: PAST }), null)).toBe('draining')
    expect(mode(run({ askUser: true, questions: [], drain: true }), null, null)).toBe('asking')
    expect(mode(run({ askUser: true, drain: true }), null, null)).toBe('asking')
  })

  test('availMode: an expired away with questions is overdue until the drain starts; empty is silent (R7)', async () => {
    const queued = run({ askUser: true, questions: QUEUED })
    const endsNow = avail({ away: { until: NOW, setAt: 0 } })
    expect(mode(queued, endsNow, null, NOW - 1)).toBe('queueing')
    expect(mode(queued, endsNow, null, NOW)).toBe('overdue')
    expect(mode(queued, null, avail({ away: PAST }))).toBe('overdue')
    expect(mode(run({ askUser: true, questions: QUEUED, drain: true }), endsNow, null, NOW)).toBe('draining')
    expect(mode(run({ askUser: true, questions: [] }), endsNow, null, NOW)).toBe('asking')
  })

  test('availMode: asking is the default with --ask-user or an askUser record on', async () => {
    expect(mode(run({ askUser: true }), null, null)).toBe('asking')
    expect(mode(run({}), avail({ askUser: ON }), null)).toBe('asking')
    expect(mode(run({}), null, avail({ askUser: ON }))).toBe('asking')
    // /back with questions left: asking; applyMode (task 04) then starts the drain.
    expect(mode(run({ askUser: true, questions: QUEUED }), avail({ away: { back: true, setAt: 0 } }), null)).toBe('asking')
  })

  test('availMode: an old stored run without the new fields behaves as today', async () => {
    expect(mode(run({ askUser: true }), null, null)).toBe('asking')
    expect(mode(run({ askUser: false }), null, null)).toBe('plain')
    const older = { ...run({}), askUser: undefined } as unknown as Run
    expect(mode(older, null, null)).toBe('plain')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `claude plugin test autopilot` from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`
Expected: FAIL — the test module does not load: `./autopilot` has no export `validAvail` (likewise `effective`, `isAwayActive`, `isAwayExpired`, `availMode`), and `Avail` / `Question` are not exported from `../types`.

- [ ] **Step 3: Write minimal implementation**

3a. `autopilot/types/index.d.ts` — in `Awaiting`, after `pinged: boolean` (line 35) add:

```ts
  /** In draining: the queued question this wait asks (its note carried `#k` and k was queued). Missing when untagged and in older runs. */
  questionId?: number
```

3b. Same file — in `Run`, after `graceAsks?: number` (line 80) add:

```ts
  /** Critical questions parked while the person cannot answer (/away, /ask-user off), oldest first. Missing in older runs. */
  questions?: Question[]
  /** Whether the queue is being asked one question at a time. */
  drain?: boolean
  /** The question the current drain role section names. */
  askingId?: number
  /** The id the next queued question gets; only grows, so an id is never reused within the run (spec §3.1). Missing in older runs. */
  nextQuestionId?: number
  /** The session away `setAt` whose expiry ping was handed to the model. */
  pingedFor?: number
  /** Prompts that must reach the model, kept until delivered (only while running or awaiting). */
  pending?: Pending[]
  /** The mode the last heartbeat or command acted on. */
  lastMode?: Mode
```

3c. Same file — append after line 109 (end of file):

```ts

/**
 * How a run treats questions for the person, decided by availMode in order:
 * - plain: no --ask-user and no askUser record anywhere; today's no-ask behaviour, no queue
 * - queueing: asking is off, or the person is away; critical questions go to the queue
 * - draining: the queue is asked one question at a time
 * - overdue: the away ended with questions queued; no asking until the person writes
 * - asking: today's --ask-user behaviour
 */
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

/** A critical question parked for the person; ids run 1..n within the run and are never reused (`Run.nextQuestionId`). */
export type Question = { id: number; text: string; kind: 'answer' | 'action'; provisional: string | null; at: number }
export type QueueInput = { question: string; kind: 'answer' | 'action'; provisional: string | null }

/** A prompt that must reach the model; `key` is the away `setAt` for pings, 0 otherwise. */
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

3d. `autopilot/hooks/autopilot.ts` — replace line 1

```ts
import type { Awaiting, Command, FinalReason, FinishedRecord, Phase, Run, StartCommand, TokenWindow, WaitReason } from '../types'
```

with

```ts
import type {
  Avail,
  Awaiting,
  AwayField,
  Command,
  Effective,
  FinalReason,
  FinishedRecord,
  Mode,
  Phase,
  Run,
  StartCommand,
  TokenWindow,
  WaitReason,
} from '../types'
```

3e. Same file — append after the last line (`DEFERRED_NOTE`, line 1032 before 3d; 1046 after it):

```ts

/** How far ahead of now a record's `setAt` may lie (two processes' clocks differ a little); further is a broken or forged write. */
const MAX_SET_AT_AHEAD_MS = 5 * 60_000

/** A record timestamp: a finite number at most MAX_SET_AT_AHEAD_MS after now. */
function isSetAt(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value <= now + MAX_SET_AT_AHEAD_MS
}

/** A stored `away` field: null when not set, false when malformed. */
function awayField(value: unknown, now: number): AwayField | null | false {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return false
  const { until, back, setAt } = value as { until?: unknown; back?: unknown; setAt?: unknown }
  if (!isSetAt(setAt, now)) return false
  if (back !== undefined) return back === true ? { back: true, setAt } : false
  if (typeof until !== 'number' || !Number.isFinite(until)) return false

  return { until, setAt }
}

/** A stored `askUser` field: null when not set, false when malformed. */
function askField(value: unknown, now: number): { on: boolean; setAt: number } | null | false {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return false
  const { on, setAt } = value as { on?: unknown; setAt?: unknown }
  if (!isSetAt(setAt, now)) return false
  if (typeof on !== 'boolean') return false

  return { on, setAt }
}

/**
 * A stored availability record, or null when it is not one: wrong shape, a
 * version other than 1, or a `setAt` more than 5 minutes ahead of now. A
 * missing `away` or `askUser` reads as not set; only known fields are kept.
 */
export function validAvail(value: unknown, now: number): Avail | null {
  if (typeof value !== 'object' || value === null) return null
  const fields = value as { v?: unknown; away?: unknown; askUser?: unknown }
  if (fields.v !== 1) return null
  const away = awayField(fields.away, now)
  if (away === false) return null
  const askUser = askField(fields.askUser, now)
  if (askUser === false) return null

  return { v: 1, away, askUser }
}

/**
 * The status in force, per field (R5): the session record wins over the
 * global one even when older. Ask-user without a record anywhere falls back
 * to the run's --ask-user flag.
 */
export function effective(run: Run | null, session: Avail | null, global: Avail | null): Effective {
  const sessionAway = session?.away ?? null
  const away = sessionAway ?? global?.away ?? null
  const askUser = session?.askUser ?? global?.askUser ?? null

  return {
    away,
    awaySource: sessionAway ? 'session' : away ? 'global' : null,
    askOn: askUser ? askUser.on : run?.askUser === true,
    askRecorded: askUser !== null,
  }
}

/** Whether an `until` away is still running; /back and no away are not. */
export function isAwayActive(away: AwayField | null, now: number): boolean {
  return away !== null && 'until' in away && now < away.until
}

/** Whether an `until` away has reached its end; /back and no away have not. */
export function isAwayExpired(away: AwayField | null, now: number): boolean {
  return away !== null && 'until' in away && now >= away.until
}

/** The run's mode: an ordered list, the first match wins (spec §4). */
export function availMode(run: Run, eff: Effective, now: number): Mode {
  if (!eff.askRecorded && run.askUser !== true) return 'plain'
  if (!eff.askOn) return 'queueing'
  if (isAwayActive(eff.away, now)) return 'queueing'
  const hasQuestions = (run.questions?.length ?? 0) > 0
  if (run.drain === true && hasQuestions) return 'draining'
  if (isAwayExpired(eff.away, now) && hasQuestions) return 'overdue'

  return 'asking'
}
```

- [ ] **Step 4: Run tests, expected PASS (all existing tests too)**

Run: `claude plugin test autopilot` from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`
Expected: PASS — every existing `describe` plus `availability: records, effective status, mode` (15 tests). Then `claude plugin validate autopilot`: no errors (register.tsx still compiles: the new `Run`/`Awaiting` fields are optional).

- [ ] **Step 5: Ready for commit**

Agents do not commit. Tell the editor these files are ready:
- `autopilot/types/index.d.ts`
- `autopilot/hooks/autopilot.ts`
- `autopilot/hooks/autopilot.test.ts`

Suggested message:

```
(feat): Add availability types, effective status and mode

- types: Avail, Effective, Mode, Question, Pending, AvailCommand, BadgeAvail, LockOwner; optional Run/Awaiting fields
- validAvail rejects malformed records and a setAt more than 5 min ahead
- effective resolves session over global per field, askOn falls back to --ask-user
- availMode: ordered plain/queueing/draining/overdue/asking list (spec §4)
```
