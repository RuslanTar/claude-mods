### Task 08: `/away`, `/back`, `/ask-user` commands and the status text

**Files:**
- Modify: `autopilot/hooks/register.tsx`
  - import block from `'../types'` (line 3) and from `'./autopilot'` (lines 4-58)
  - after `statusText` (lines 417-430): two new module-private helpers `availHeadline`, `setAvail`
  - `session.start`, after the `autopilot` command registration (lines 447-451): three `$.command.register` calls
  - `command.run` for `autopilot`, the status branch (lines 507-511)
  - after the `command.run` for `autopilot` block, which ends with `}).catch(() => ({ text: 'Autopilot: the command failed; nothing changed. Try again.' }))` (line 699): three `command.run` hooks
- Test: `autopilot/hooks/autopilot.test.ts` (new `describe` at the end of the file, after `describe('hardening', …)`)

Line numbers are those of the file **before task 07**. Task 07 moves code; locate each spot by the quoted anchor text, not by the number.

**Interfaces:**
- Consumes (task 01): `effective(run, session, global): Effective`, `availMode(run, eff, now): Mode`, `isAwayActive(away, now): boolean`; types `Avail`, `AvailCommand`, `Effective`, `Mode`.
- Consumes (task 02): `parseAway(args: string): AvailCommand`, `parseBack(args: string): AvailCommand`, `parseAskUser(args: string): AvailCommand`, `awayUntil(end, now: number, offsetMinutes: number): number | string`, `applyAvail(rec: Avail | null, cmd: Exclude<AvailCommand, {kind:'error'}>, until: number | null, now: number): Avail`.
- Consumes (task 04): `applyMode(run, next, eff, now): { run: Run; combined: boolean }` (tests only).
- Consumes (task 05): `availStatusLines(eff: Effective, mode: Mode | null, run: Run | null, now: number, offsetMinutes: number | null): string[]`.
- Consumes (task 07, module helpers in `register.tsx`, `$` first): `readSessionAvail($): Promise<Avail | null>`, `writeSessionAvail($, rec: Avail): Promise<void>`, `readGlobalAvail($, force?: boolean): Promise<Avail | null>`, `writeGlobalAvail($, rec: Avail): Promise<void>`, `refreshMode($): Promise<Mode | null>` (it reads both records first, also with no run), the module caches `sessionAvail` / `globalAvail` with the imported `effective(run, session, global)` (no second read after `refreshMode`), `statusText(now, isAskShown = true)`; existing `home`, `syncId($)`, `log($, line)`, `utcOffset($)`, `endClock`.
- Produces: `command.run` handlers for `away`, `back`, `ask-user` (registered `immediate: true`); module-private `availHeadline(cmd, until, offset): string` and `setAvail($, isPerson, cmd, typed): Promise<{ text: string }>`; `/autopilot` status (with or without a run) followed by the effective availability lines.

---

- [ ] **Step 1: Pin the chain the handlers run (no failing test in this task)**

The wiring in `register.tsx` has no fakes (README.md:119), so this task has no failing unit test: its code is the handlers, checked live in Step 4. These tests pin the pure chain each command runs — parse → end time → record at its scope → effective → mode → mode effects — including Review Focus 4 (`/away` then `/back` inside one heartbeat: exactly one `drain` pending) at command level.

Add `AvailCommand` to the type import at the top of `autopilot/hooks/autopilot.test.ts` (line 3), so it reads (complete list after tasks 01–07):

```ts
import type { Avail, AvailCommand, Awaiting, BadgeAvail, Effective, LockOwner, Pending, Question, Run, WaitReason } from '../types'
```
 Add to the `'./autopilot'` import list every one of these names that is not already imported, keeping the list alphabetical as it is: `applyAvail`, `applyMode`, `availMode`, `availStatusLines`, `awayUntil`, `effective`, `isAwayActive`, `parseAskUser`, `parseAway`, `parseBack`.

Append at the end of the file:

```ts
describe('away, back and ask-user commands', () => {
  const now = 100 * 60 * 60_000
  const HOUR = 60 * 60_000

  /** A command the handler goes on with: an error stops it before anything is written. */
  function ok(cmd: AvailCommand): Exclude<AvailCommand, { kind: 'error' }> {
    if (cmd.kind === 'error') throw new Error(cmd.message)

    return cmd
  }

  /** What setAvail records for one command at one scope. */
  function record(rec: Avail | null, cmd: AvailCommand, at: number): Avail {
    const valid = ok(cmd)
    const until = valid.kind === 'away' ? awayUntil(valid.end, at, 0) : null
    if (typeof until === 'string') throw new Error(until)

    return applyAvail(rec, valid, until, at)
  }

  // setAvail writes nothing when either of these refuses; that is checked live (Step 4, items 1-2).
  test('an error is refused by the parser, an end out of range by awayUntil', async () => {
    expect(parseAway('').kind).toBe('error')
    expect(parseAway('soon').kind).toBe('error')
    expect(parseBack('later').kind).toBe('error')
    expect(parseAskUser('maybe').kind).toBe('error')
    expect(typeof awayUntil({ kind: 'duration', ms: 1_000 }, now, 0)).toBe('string')
    expect(typeof awayUntil({ kind: 'duration', ms: 8 * 24 * HOUR }, now, 0)).toBe('string')
  })

  test('/away for 1h with no run is stored and shown (R4)', async () => {
    const session = record(null, parseAway('for 1h'), now)
    const eff = effective(null, session, null)
    expect(eff.awaySource).toBe('session')
    expect(isAwayActive(eff.away, now + HOUR - 1)).toBe(true)
    expect(isAwayActive(eff.away, now + HOUR)).toBe(false)
    // now is 100 h after the epoch (04:00 UTC); the away ends at 05:00.
    expect(availStatusLines(eff, null, null, now, 0)).toEqual([
      'Away: until 05:00 (05:00 UTC), 1h00m left (session, set 0s ago)',
      'Asks the person: off (not set)',
    ])
  })

  test('/away on a run without --ask-user and no ask-user record changes nothing (D5)', async () => {
    const r = run({ askUser: false, until: now + 10 * HOUR })
    const session = record(null, parseAway('for 1h'), now)
    expect(availMode(r, effective(r, session, null), now)).toBe('plain')
  })

  test('/ask-user on makes a run started without the flag ask; off queues; the session record beats the global one (R5)', async () => {
    const r = run({ askUser: false, until: now + 10 * HOUR })
    expect(availMode(r, effective(r, null, null), now)).toBe('plain')
    const session = record(null, parseAskUser('on'), now)
    expect(availMode(r, effective(r, session, null), now)).toBe('asking')
    const off = parseAskUser('off --global')
    expect(off).toEqual({ kind: 'ask-user', on: false, global: true })
    const global = record(null, off, now + 1_000)
    expect(availMode(r, effective(r, null, global), now + 1_000)).toBe('queueing')
    // The session record is older and still wins.
    expect(availMode(r, effective(r, session, global), now + 1_000)).toBe('asking')
  })

  test('/back --global writes only the global record: a session away still holds', async () => {
    const r = run({ askUser: true, until: now + 10 * HOUR })
    const session = record(null, parseAway('for 1h'), now)
    const global = record(null, parseBack('--global'), now + 1_000)
    const eff = effective(r, session, global)
    expect(eff.awaySource).toBe('session')
    expect(availMode(r, eff, now + 1_000)).toBe('queueing')
  })

  test('/back, /away, /back inside one heartbeat leaves exactly one drain pending (Review Focus 4)', async () => {
    const question = { id: 1, text: 'Push to prod?', kind: 'action' as const, provisional: null, at: now }
    let r = run({ askUser: true, until: now + 10 * HOUR, questions: [question], lastMode: 'queueing' })
    let session: Avail | null = null
    // What setAvail does per command: record at the session scope, then refreshMode's mode rule.
    const step = (cmd: AvailCommand, at: number) => {
      session = record(session, cmd, at)
      const eff = effective(r, session, null)
      r = applyMode(r, availMode(r, eff, at), eff, at).run
    }
    step(parseBack(''), now)
    expect(r.drain).toBe(true)
    step(parseAway('for 1h'), now + 1_000)
    expect(r.drain ?? false).toBe(false)
    step(parseBack(''), now + 2_000)
    expect(r.drain).toBe(true)
    expect((r.pending ?? []).filter(p => p.kind === 'drain').length).toBe(1)
    expect(r.questions).toEqual([question])
  })
})
```

- [ ] **Step 2: Run the pinned chain (it passes at once)**

Run: `claude plugin test autopilot` (from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`)
Expected: the new `describe` **PASSES at once**: every function it calls exists since tasks 01–05; the tests pin the chain the handlers below run, they do not test `register.tsx` itself (no fakes). If any of them FAILS, STOP and report BLOCKED: an earlier task deviated from the interface contract; do not change those functions here.

Also run `claude plugin validate autopilot` — Expected: PASS (nothing in `register.tsx` changed yet).

- [ ] **Step 3: Write minimal implementation**

**3a. Imports.** In `autopilot/hooks/register.tsx` line 3, add `AvailCommand` to the type import, so it reads (complete list after task 07; `Effective` is needed by task 07's `currentEffective`):

```ts
import type { Avail, AvailCommand, Effective, FinalReason, FinishedRecord, Mode, Run, TokenWindow } from '../types'
```

In the `'./autopilot'` import list add, alphabetically, each of these not already there: `applyAvail`, `availStatusLines`, `awayUntil`, `parseAskUser`, `parseAway`, `parseBack`.

**3b. Helpers.** Insert directly after the closing `}` of `function statusText(now: number, isAskShown = true): string { … }` (anchor: the line `    home ? \`Log: ${autopilotDir()}/${sessionId}.log\` : 'Log: none (HOME is not set)',` followed by `  ].join('\n')` and `}`), before `export const register: Register = on => {`:

```ts
const AVAIL_FAILED_TEXT = 'Autopilot: the command failed; nothing changed. Try again.'

/** The first line of an /away, /back or /ask-user reply: what was recorded, and for whom. */
function availHeadline(cmd: Exclude<AvailCommand, { kind: 'error' }>, until: number | null, offset: number | null): string {
  const scope = cmd.global ? 'all sessions' : 'this session'
  if (cmd.kind === 'away') return `Away until ${endClock(until ?? 0, offset)} (${scope}).`
  if (cmd.kind === 'back') return `Back (${scope}).`

  return `Ask-user ${cmd.on ? 'on' : 'off'} (${scope}).`
}

/**
 * /away, /back and /ask-user: the person's own availability. Stored even with
 * no run, so it applies to a later one (R4). Errors write nothing; a record
 * written at its scope goes through the mode rule, which may release a wait,
 * start a drain or queue a ping.
 */
async function setAvail($: EngineInterface, isPerson: boolean, cmd: AvailCommand, typed: string): Promise<{ text: string }> {
  await syncId($)
  if (!isPerson) {
    await log($, `${typed} refused: not typed by the person`)

    return { text: 'Only the person can say they are away or back, or turn asking on or off (type it in the prompt or over Remote Control).' }
  }
  if (cmd.kind === 'error') {
    $.ui.toast(`Autopilot: ${cmd.message}`)

    return { text: cmd.message }
  }
  if (cmd.global && !home) {
    const text = 'Cannot use --global: HOME is not set, so there is no shared status file. Leave out --global to set it for this session.'
    $.ui.toast(`Autopilot: ${text}`)

    return { text }
  }
  // A clock end needs the offset; every reply shows times in it.
  const offset = await utcOffset($)
  // The process call took time: decide on the clock as it is now.
  const now = await $.clock.now()
  let until: number | null = null
  if (cmd.kind === 'away') {
    if (cmd.end.kind === 'clock' && offset === null) {
      const text = 'Cannot read the local time zone; use a duration such as /away for 2h instead.'
      $.ui.toast(`Autopilot: ${text}`)

      return { text }
    }
    const end = awayUntil(cmd.end, now, offset ?? 0)
    if (typeof end === 'string') {
      $.ui.toast(`Autopilot: ${end}`)

      return { text: end }
    }
    until = end
  }

  const session = await readSessionAvail($)
  // The global file may have changed in another session since the last heartbeat.
  const before = cmd.global ? await readGlobalAvail($, true) : session
  const next = applyAvail(before, cmd, until, now)
  try {
    if (cmd.global) await writeGlobalAvail($, next)
    else await writeSessionAvail($, next)
  } catch (error) {
    await log($, `could not record ${typed}: ${String(error)}`).catch(() => undefined)

    return { text: 'Autopilot could not record the change; nothing changed.' }
  }
  const headline = availHeadline(cmd, until, offset)
  await log($, `set by the person: ${headline}`)

  const mode = await refreshMode($)
  // refreshMode just read both records: the cached ones are current, no second read.
  const eff = effective(run, sessionAvail, globalAvail)
  // A session record beats the global one per field, even when older (R5).
  const shadowed = cmd.global && (cmd.kind === 'ask-user' ? session?.askUser : session?.away)
  const notes = [
    ...(shadowed ? [`Note: this session has its own ${cmd.kind === 'ask-user' ? 'ask-user' : 'away'} setting, which wins over the global one here.`] : []),
    ...(cmd.kind === 'away' && mode === 'plain'
      ? ['Note: this run does not ask you (no --ask-user), so being away changes nothing until /ask-user on.']
      : []),
  ]

  return { text: [headline, ...notes, ...availStatusLines(eff, mode, run, now, offset)].join('\n') }
}
```

**3c. Registration.** In `session.start`, directly after

```ts
    await $.command.register({
      name: 'autopilot',
      …
    })
```

(lines 447-451) and before `await $.tool.register({ name: RESTART_TOOL,`, insert:

```ts
    // Immediate: typed mid-turn they run at once, so stepping away never waits for a long turn.
    await $.command.register({
      name: 'away',
      description: 'Autopilot: you are away; critical questions are queued instead of asked, then asked one by one when you are back',
      argumentHint: 'for <90m|2h|1h30m> | until <15:00|6pm> [--global]',
      immediate: true,
    })
    await $.command.register({
      name: 'back',
      description: 'Autopilot: you are back; the queued questions are asked one by one',
      argumentHint: '[--global]',
      immediate: true,
    })
    await $.command.register({
      name: 'ask-user',
      description: 'Autopilot: turn asking you critical questions on or off (off queues them until you turn it on)',
      argumentHint: 'on|off [--global]',
      immediate: true,
    })
```

**3d. Status branch.** In `on('command.run', { command: 'autopilot' }, …)` replace

```ts
    if (command.kind === 'status') {
      const finished = run ? null : await loadFinished($, now)

      return { text: finished ? graceStatusText(finished, now) : statusText(now) }
    }
```

with

```ts
    if (command.kind === 'status') {
      const finished = run ? null : await loadFinished($, now)
      // The records first, so the status reads them fresh, not as of the last heartbeat.
      const mode = await refreshMode($)
      // availStatusLines carries the one ask-user line, so statusText leaves its own out.
      const text = finished ? graceStatusText(finished, now) : statusText(now, false)
      // Away and ask-user show with or without a run, with their source (session or global).
      const offset = await utcOffset($)
      // refreshMode read both records (also with no run): the cached ones are current.
      const lines = availStatusLines(effective(run, sessionAvail, globalAvail), mode, run, now, offset)

      return { text: [text, ...lines].join('\n') }
    }
```

The start reply (`${statusText(now)}\nEnd: …`) keeps the default and its `Asks the person: critical only` line.

**3e. Command hooks.** Directly after the line `  }).catch(() => ({ text: 'Autopilot: the command failed; nothing changed. Try again.' }))` that closes the `autopilot` `command.run` hook, insert:

```ts
  // Human-only: another plugin, a peer or the SDK may not say the person is away or back.
  const isPerson = (kind: string) => kind === 'composer' || kind === 'bridge'

  on('command.run', { command: 'away' }, async ($, e) => setAvail($, isPerson(e.origin.kind), parseAway(e.args), '/away')).catch(() => ({
    text: AVAIL_FAILED_TEXT,
  }))

  on('command.run', { command: 'back' }, async ($, e) => setAvail($, isPerson(e.origin.kind), parseBack(e.args), '/back')).catch(() => ({
    text: AVAIL_FAILED_TEXT,
  }))

  on('command.run', { command: 'ask-user' }, async ($, e) =>
    setAvail($, isPerson(e.origin.kind), parseAskUser(e.args), '/ask-user'),
  ).catch(() => ({ text: AVAIL_FAILED_TEXT }))
```

- [ ] **Step 4: Run tests, expected PASS (all existing tests too)**

Run: `claude plugin test autopilot` — Expected: PASS, every test including the earlier ones.
Run: `claude plugin validate autopilot` — Expected: PASS (the TSX type-checks; `immediate: true` is accepted by `CommandSpec`).

Live check (in a session on this worktree, after `/reload-plugins`; no run needed for 1–6):

1. `/away` → toast `Autopilot: <parseAway's error>`; the same text printed; `/autopilot` shows no away line from the session.
2. `/away until <HH:MM of the next minute>` (e.g. at 14:05:20 type `/away until 14:06`; it ends under 1 minute ahead) → toast and text `The away time must end at least 1 minute from now.`; nothing written. Do not use the current HH:MM: `untilFromClock` rolls a time not after now to tomorrow, which is accepted. `/away for 169h` → `The away time can be at most 7 days from now.`; nothing written. (`parseDuration` takes no seconds: `/away for 30s` gives the parse error, not these.)
3. `/away for 1h` → first line `Away until HH:MM (this session).` (local time, one hour ahead), then `availStatusLines` (away, source session). `/autopilot` (no run) prints `Autopilot is off.` and the same availability lines.
4. `/ask-user maybe` → error toast and text. `/ask-user off --global` → `Ask-user off (all sessions).`; `cat ~/.claude/autopilot/status/global.json` shows `"v":1` and `"askUser":{"on":false,…}`.
5. `/ask-user on` (session) after step 4 → `Ask-user on (this session).`; then `/ask-user off --global` again → reply carries `Note: this session has its own ask-user setting, which wins over the global one here.`
6. `/back` → `Back (this session).`
7. With a run started without `--ask-user` and no ask-user record (`/autopilot 30m 60 "Test role"` in a fresh session): `/away for 1h` → reply carries `Note: this run does not ask you (no --ask-user), so being away changes nothing until /ask-user on.`
7b. With a run started with `--ask-user`, `/autopilot` shows exactly one `Asks the person:` line (`on (run started with --ask-user)`, from `availStatusLines`), not also `critical only`.
8. While a turn streams, type `/away for 20m` → the reply prints at once, without waiting for the turn (immediate).
9. Optional: `env -u HOME claude`, then `/back --global` → `Cannot use --global: HOME is not set…` toast and text.

- [ ] **Step 5: Ready for commit**

Tell the editor (agents never commit): files ready —
- `autopilot/hooks/register.tsx`
- `autopilot/hooks/autopilot.test.ts`

Suggested message:

```
(feat): Add /away, /back and /ask-user commands

- Register the three commands as immediate, human-only (composer or bridge)
- Parse, record at session or global scope, then apply the mode rule
- Refuse --global without HOME and a clock end without the time zone
- Show away and ask-user status with its source in /autopilot, with or without a run
- Test the command chain, incl. one drain after /away then /back
```
