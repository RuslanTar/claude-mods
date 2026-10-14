### Task 02: Command parsers, away end time, record update

**Files:**
- Modify: `autopilot/hooks/autopilot.ts` — the multi-line type import added by task 01 (lines 1-15 after task 01: add `AvailCommand`); append a new block at the end of the file (after task 01's `availMode`)
- Test: `autopilot/hooks/autopilot.test.ts` — value import list (lines 4-58 after task 01); append a new `describe` at the end of the file (after task 01's `availability: records, effective status, mode` block)

Line numbers below are the ones the file has once task 01 is applied; anchor on the quoted text, not on the number.

**Interfaces:**
- Consumes:
  - task 01: types `Avail`, `AvailCommand` (`autopilot/types/index.d.ts`); test helper `avail(over: Partial<Avail>): Avail` (module level in `autopilot.test.ts`)
  - existing, module-private in `autopilot.ts` (so the parsers live in this file): `takeSwitch(text, name)` :329, `echoed(raw)` :433, `MIN_LEAD_MS` :78; exported: `parseDuration` :62, `parseClock` :154, `untilFromClock` :180, `MAX_AHEAD_MS` :151
- Produces (`autopilot/hooks/autopilot.ts`):
  - `parseAway(args: string): AvailCommand`
  - `parseBack(args: string): AvailCommand`
  - `parseAskUser(args: string): AvailCommand`
  - `awayUntil(end: Extract<AvailCommand, { kind: 'away' }>['end'], now: number, offsetMinutes: number): number | string` — epoch ms, or the error text
  - `applyAvail(rec: Avail | null, cmd: Exclude<AvailCommand, { kind: 'error' }>, until: number | null, now: number): Avail`
- Reply texts task 08 shows as-is (module-private here, quoted verbatim in the tests):
  - `Usage: /away for <duration> [--global] (90m, 2h, 1h30m)  ·  /away until <clock> [--global] (15:00, 6pm, local time)`
  - `Give the time as HH:MM (24-hour) or with am/pm, e.g. /away until 15:00 or /away until 6pm (local time).`
  - `Cannot read the time "<raw>" (try 90m, 2h, 1h30m).`
  - `The away time must end at least 1 minute from now.`
  - `The away time can be at most 7 days from now.`
  - `Usage: /back [--global]`
  - `Usage: /ask-user on|off [--global]`

Review Focus owned here: line 1 (`/away until 00:10` typed at 23:55, and around a DST change: next occurrence in the session's UTC offset, within `MAX_AHEAD_MS`).

Note for task 08: `awayUntil` takes a numeric offset. For `end.kind === 'clock'` the caller refuses when `utcOffset($)` is null (as `/autopilot until` does, autopilot.ts:212); for `end.kind === 'duration'` the offset is not read, so the caller may pass `0`.

---

- [ ] **Step 1: Write the failing test**

1a. In the value import list of `autopilot/hooks/autopilot.test.ts` add five names, keeping the alphabetical order:
- after `  afterTurn,` add `  applyAvail,`
- after `  availMode,` (added by task 01) add `  awayUntil,`
- before `  parseClock,` add `  parseAskUser,`, `  parseAway,`, `  parseBack,`

The affected parts then read:

```ts
  afterTurn,
  applyAvail,
  askAnswer,
  autoAnswersQuestions,
  availMode,
  awayUntil,
  canRestart,
  …
  namedSkills,
  parseAskUser,
  parseAway,
  parseBack,
  parseClock,
  parseCommand,
```

1b. Append at the end of the file:

```ts

describe('availability commands', () => {
  const NOW = 1_000_000
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 24 * HOUR
  const AWAY_USAGE =
    'Usage: /away for <duration> [--global] (90m, 2h, 1h30m)  ·  /away until <clock> [--global] (15:00, 6pm, local time)'
  const AWAY_CLOCK = 'Give the time as HH:MM (24-hour) or with am/pm, e.g. /away until 15:00 or /away until 6pm (local time).'
  const TOO_SOON = 'The away time must end at least 1 minute from now.'
  const TOO_FAR = 'The away time can be at most 7 days from now.'
  const midnight = Date.UTC(2026, 9, 12)
  const clock = (hours: number, minutes: number) => ({ kind: 'clock' as const, hours, minutes })
  const duration = (ms: number) => ({ kind: 'duration' as const, ms })

  test('/away reads a duration or a clock time, with --global anywhere', async () => {
    expect(parseAway('for 90m')).toEqual({ kind: 'away', end: duration(90 * MIN), global: false })
    expect(parseAway('for 1h30m --global')).toEqual({ kind: 'away', end: duration(90 * MIN), global: true })
    expect(parseAway('--global for 2h')).toEqual({ kind: 'away', end: duration(2 * HOUR), global: true })
    expect(parseAway('for --global 45')).toEqual({ kind: 'away', end: duration(45 * MIN), global: true })
    expect(parseAway('  FOR 2h  ')).toEqual({ kind: 'away', end: duration(2 * HOUR), global: false })
    expect(parseAway('until 15:00')).toEqual({ kind: 'away', end: clock(15, 0), global: false })
    expect(parseAway('until 6pm --global')).toEqual({ kind: 'away', end: clock(18, 0), global: true })
    expect(parseAway('Until 6:30PM')).toEqual({ kind: 'away', end: clock(18, 30), global: false })
    expect(parseAway('until 00:10')).toEqual({ kind: 'away', end: clock(0, 10), global: false })
  })

  test('/away without a time, or with an unknown word, is an error (R3)', async () => {
    for (const args of ['', '   ', '--global', 'for', 'until', '1h', 'tomorrow', 'for 1h now', 'for 1h --globally', 'away for 1h']) {
      expect(parseAway(args)).toEqual({ kind: 'error', message: AWAY_USAGE })
    }
  })

  test('/away with a time it cannot read says so', async () => {
    expect(parseAway('for soon')).toEqual({ kind: 'error', message: 'Cannot read the time "soon" (try 90m, 2h, 1h30m).' })
    expect(parseAway('for 0m')).toEqual({ kind: 'error', message: 'Cannot read the time "0m" (try 90m, 2h, 1h30m).' })
    expect(parseAway('for 0 --global')).toEqual({ kind: 'error', message: 'Cannot read the time "0" (try 90m, 2h, 1h30m).' })
    for (const args of ['until 25:00', 'until 15', 'until 13pm', 'until 9:75']) {
      expect(parseAway(args)).toEqual({ kind: 'error', message: AWAY_CLOCK })
    }
  })

  test('/back takes only --global', async () => {
    expect(parseBack('')).toEqual({ kind: 'back', global: false })
    expect(parseBack('  --global ')).toEqual({ kind: 'back', global: true })
    expect(parseBack('now')).toEqual({ kind: 'error', message: 'Usage: /back [--global]' })
    expect(parseBack('--global now')).toEqual({ kind: 'error', message: 'Usage: /back [--global]' })
  })

  test('/ask-user takes on or off, with --global anywhere', async () => {
    expect(parseAskUser('on')).toEqual({ kind: 'ask-user', on: true, global: false })
    expect(parseAskUser('OFF --global')).toEqual({ kind: 'ask-user', on: false, global: true })
    expect(parseAskUser('--global on')).toEqual({ kind: 'ask-user', on: true, global: true })
    for (const args of ['', '--global', 'maybe', 'on off', 'true']) {
      expect(parseAskUser(args)).toEqual({ kind: 'error', message: 'Usage: /ask-user on|off [--global]' })
    }
  })

  test('awayUntil: a duration counts from now, between 1 minute and 7 days ahead', async () => {
    expect(awayUntil(duration(90 * MIN), NOW, 0)).toBe(NOW + 90 * MIN)
    expect(awayUntil(duration(90 * MIN), NOW, -300)).toBe(NOW + 90 * MIN)
    expect(awayUntil(duration(MIN), NOW, 0)).toBe(NOW + MIN)
    expect(awayUntil(duration(MIN - 1), NOW, 0)).toBe(TOO_SOON)
    expect(awayUntil(duration(7 * DAY), NOW, 0)).toBe(NOW + 7 * DAY)
    expect(awayUntil(duration(7 * DAY + 1), NOW, 0)).toBe(TOO_FAR)
  })

  test('awayUntil: /away until 00:10 typed at 23:55 ends 15 minutes later, not tomorrow', async () => {
    // Offset +3: local 23:55 is 20:55 UTC; 00:10 local is 21:10 UTC.
    const east = midnight + 20 * HOUR + 55 * MIN
    expect(awayUntil(clock(0, 10), east, 180)).toBe(midnight + 21 * HOUR + 10 * MIN)
    // Offset -5: local 23:55 is 04:55 UTC; 00:10 local is 05:10 UTC.
    const west = midnight + 4 * HOUR + 55 * MIN
    expect(awayUntil(clock(0, 10), west, -300)).toBe(midnight + 5 * HOUR + 10 * MIN)
  })

  test("awayUntil: around a DST change the session's current offset decides, and the end stays within a day", async () => {
    const now = midnight + 20 * HOUR + 55 * MIN
    // The same instant read before (+3, local 23:55) and after (+2, local 22:55) a switch.
    expect(awayUntil(clock(0, 10), now, 180)).toBe(midnight + 21 * HOUR + 10 * MIN)
    expect(awayUntil(clock(0, 10), now, 120)).toBe(midnight + 22 * HOUR + 10 * MIN)
    for (const offset of [180, 120, 60, 0, -240, -300, 330, 345, 195]) {
      const until = awayUntil(clock(0, 10), now, offset)
      expect(typeof until).toBe('number')
      const ahead = (until as number) - now
      expect(ahead >= MIN && ahead <= DAY && ahead <= 7 * DAY).toBe(true)
    }
  })

  test('awayUntil: a clock time under a minute ahead is refused; the current minute means tomorrow', async () => {
    // Offset +3, local 23:55:30.
    const now = midnight + 20 * HOUR + 55 * MIN + 30_000
    expect(awayUntil(clock(23, 56), now, 180)).toBe(TOO_SOON)
    expect(awayUntil(clock(23, 55), now, 180)).toBe(midnight + 44 * HOUR + 55 * MIN)
    // Exactly local 23:55: the next 23:55 is a full day later.
    const onTheMinute = midnight + 20 * HOUR + 55 * MIN
    expect(awayUntil(clock(23, 55), onTheMinute, 180)).toBe(onTheMinute + DAY)
  })

  test('applyAvail writes one field and keeps the other', async () => {
    const away = { kind: 'away' as const, end: duration(HOUR), global: false }
    expect(applyAvail(null, away, NOW + HOUR, NOW)).toEqual({ v: 1, away: { until: NOW + HOUR, setAt: NOW }, askUser: null })
    const stored = avail({ away: { until: NOW - HOUR, setAt: 5 }, askUser: { on: true, setAt: 5 } })
    const before = JSON.stringify(stored)
    expect(applyAvail(stored, { kind: 'back', global: true }, null, NOW)).toEqual({
      v: 1,
      away: { back: true, setAt: NOW },
      askUser: { on: true, setAt: 5 },
    })
    expect(applyAvail(stored, { kind: 'ask-user', on: false, global: false }, null, NOW)).toEqual({
      v: 1,
      away: { until: NOW - HOUR, setAt: 5 },
      askUser: { on: false, setAt: NOW },
    })
    expect(applyAvail(stored, away, NOW + 2 * HOUR, NOW)).toEqual({
      v: 1,
      away: { until: NOW + 2 * HOUR, setAt: NOW },
      askUser: { on: true, setAt: 5 },
    })
    // The stored record is never changed in place.
    expect(JSON.stringify(stored)).toBe(before)
  })

  test('applyAvail: an away without an end time writes nothing', async () => {
    const stored = avail({ askUser: { on: false, setAt: 5 } })
    expect(applyAvail(stored, { kind: 'away', end: duration(HOUR), global: false }, null, NOW)).toEqual(stored)
    expect(applyAvail(null, { kind: 'away', end: duration(HOUR), global: false }, null, NOW)).toEqual(avail({}))
  })

  test('a parsed /away goes through awayUntil into a record', async () => {
    const command = parseAway('until 00:10 --global')
    if (command.kind !== 'away') throw new Error(`expected an away command, got ${command.kind}`)
    const now = midnight + 20 * HOUR + 55 * MIN
    const until = awayUntil(command.end, now, 180)
    if (typeof until === 'string') throw new Error(until)
    expect(command.global).toBe(true)
    expect(applyAvail(null, command, until, now)).toEqual({ v: 1, away: { until: now + 15 * MIN, setAt: now }, askUser: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `claude plugin test autopilot` from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`
Expected: FAIL — the test module does not load: `./autopilot` has no export `parseAway` (likewise `parseBack`, `parseAskUser`, `awayUntil`, `applyAvail`).

- [ ] **Step 3: Write minimal implementation**

3a. `autopilot/hooks/autopilot.ts` — in the type import task 01 wrote at the top of the file, add `AvailCommand,` after `  Avail,`:

```ts
import type {
  Avail,
  AvailCommand,
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

3b. Same file — append at the end (after task 01's `availMode`):

```ts

const AWAY_USAGE =
  'Usage: /away for <duration> [--global] (90m, 2h, 1h30m)  ·  /away until <clock> [--global] (15:00, 6pm, local time)'
const AWAY_CLOCK_TEXT = 'Give the time as HH:MM (24-hour) or with am/pm, e.g. /away until 15:00 or /away until 6pm (local time).'
const AWAY_TOO_SOON_TEXT = 'The away time must end at least 1 minute from now.'
const AWAY_TOO_FAR_TEXT = 'The away time can be at most 7 days from now.'
const BACK_USAGE = 'Usage: /back [--global]'
const ASK_USER_USAGE = 'Usage: /ask-user on|off [--global]'

type AwayEnd = Extract<AvailCommand, { kind: 'away' }>['end']

/** `/away` arguments: `for <duration>` or `until <clock>`, with `--global` anywhere. A bare /away is an error (R3). */
export function parseAway(args: string): AvailCommand {
  const scope = takeSwitch(args.trim(), 'global')
  const match = /^(for|until)\s+(\S+)$/i.exec(scope.rest)
  if (!match) return { kind: 'error', message: AWAY_USAGE }
  const [, word = '', raw = ''] = match
  if (word.toLowerCase() === 'until') {
    const clock = parseClock(raw)
    if (!clock) return { kind: 'error', message: AWAY_CLOCK_TEXT }

    return { kind: 'away', end: { kind: 'clock', ...clock }, global: scope.isOn }
  }
  const ms = parseDuration(raw)
  if (ms === null || ms <= 0) return { kind: 'error', message: `Cannot read the time "${echoed(raw)}" (try 90m, 2h, 1h30m).` }

  return { kind: 'away', end: { kind: 'duration', ms }, global: scope.isOn }
}

/** `/back` arguments: nothing but an optional `--global`. */
export function parseBack(args: string): AvailCommand {
  const scope = takeSwitch(args.trim(), 'global')
  if (scope.rest) return { kind: 'error', message: BACK_USAGE }

  return { kind: 'back', global: scope.isOn }
}

/** `/ask-user` arguments: `on` or `off`, with `--global` anywhere. */
export function parseAskUser(args: string): AvailCommand {
  const scope = takeSwitch(args.trim(), 'global')
  const match = /^(on|off)$/i.exec(scope.rest)
  if (!match) return { kind: 'error', message: ASK_USER_USAGE }

  return { kind: 'ask-user', on: match[1]?.toLowerCase() === 'on', global: scope.isOn }
}

/**
 * When an away ends: a duration from now, or the next local `hours:minutes`
 * on the clock `offsetMinutes` east of UTC (the session's offset now; see
 * untilFromClock about DST). An error text when it lands under MIN_LEAD_MS
 * or beyond MAX_AHEAD_MS from now.
 */
export function awayUntil(end: AwayEnd, now: number, offsetMinutes: number): number | string {
  const until = end.kind === 'duration' ? now + end.ms : untilFromClock(end.hours, end.minutes, now, offsetMinutes)
  if (until - now < MIN_LEAD_MS) return AWAY_TOO_SOON_TEXT
  if (until - now > MAX_AHEAD_MS) return AWAY_TOO_FAR_TEXT

  return until
}

/**
 * The record after a command: `/away` sets `away` to its end, `/back` sets
 * `away` to back, `/ask-user` sets `askUser`; the other field stays. The
 * caller picks the record by scope (`global`). Never changes `rec` in place.
 */
export function applyAvail(
  rec: Avail | null,
  cmd: Exclude<AvailCommand, { kind: 'error' }>,
  until: number | null,
  now: number,
): Avail {
  const base: Avail = { v: 1, away: rec?.away ?? null, askUser: rec?.askUser ?? null }
  if (cmd.kind === 'ask-user') return { ...base, askUser: { on: cmd.on, setAt: now } }
  if (cmd.kind === 'back') return { ...base, away: { back: true, setAt: now } }
  // An away whose end awayUntil refused: nothing to write.
  if (until === null) return base

  return { ...base, away: { until, setAt: now } }
}
```

- [ ] **Step 4: Run tests, expected PASS (all existing tests too)**

Run: `claude plugin test autopilot` from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`
Expected: PASS — every existing `describe`, task 01's block, and `availability commands` (12 tests). Then `claude plugin validate autopilot`: no errors.

- [ ] **Step 5: Ready for commit**

Agents do not commit. Tell the editor these files are ready:
- `autopilot/hooks/autopilot.ts`
- `autopilot/hooks/autopilot.test.ts`

Suggested message:

```
(feat): Add /away, /back and /ask-user parsers

- parseAway: for <duration> | until <clock>, --global anywhere; bare /away is an error
- parseBack, parseAskUser: --global anywhere, unknown words refused
- awayUntil: next local clock time in the session's offset, 1 min to 7 days ahead
- applyAvail: writes one field, keeps the other, never mutates the stored record
```
