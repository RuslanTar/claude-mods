### Task 09: `queue_question` tool, `wait_for` tagging, `prompt.submit`, answer removal at `turn.start`

**Files:**
- Modify: `autopilot/hooks/register.tsx`
  - `'./autopilot'` import list (lines 4-58)
  - module variables (lines 64-75): new `lastSubmitHuman`
  - after `statusText` (lines 417-430; after task 08's `setAvail` if present): module-private `queueRefusal`, `removeAnswered`
  - `session.start`, after the `WAIT_TOOL` registration (lines 467-481): `QUEUE_TOOL` registration
  - `turn.start` hook (lines 733-743): consume `lastSubmitHuman`, remove the answered question before `endWait`, refresh the mode after it
  - before `turn.start` (line 733): new `prompt.submit` hook
  - `wait_for` handler (lines 745-789), after the refusal block (lines 760-764): `questionId` tagging
  - after the `wait_for` handler, which ends with `}).catch(() => ({ deny: 'Autopilot could not record the wait. Continue your work.' }))` (line 789): `queue_question` handler
- Test: `autopilot/hooks/autopilot.test.ts` (new `describe` at the end of the file)

Line numbers are those of the file **before tasks 07 and 08**. Locate each spot by the quoted anchor text, not by the number.

**Interfaces:**
- Consumes (task 01): `effective(run, session, global): Effective`, `availMode(run, eff, now): Mode`; types `Mode`, `Question`, `QueueInput`, `Avail`; `Awaiting.questionId?: number`; `Run.questions?`, `Run.drain?`, `Run.askingId?`, `Run.lastMode?`.
- Consumes (task 03): `QUEUE_WARN = 20`, `QUEUE_TOOL = 'queue_question'`, `FULL_QUEUE_TOOL = 'mcp__autopilot__queue_question'`, `parseQueueInput(input: unknown): QueueInput | string`, `addQuestion(run, input, now): { run: Run; id: number; isNew: boolean; warn: boolean }`, `questionIdFromNote(note: string | null, questions: readonly Question[]): number | null`, `answeredQuestion(run: Run): Run`.
- Consumes (task 04): `humanSubmit(run: Run, mode: Mode): Run`.
- Consumes (task 05): `queuedResult(id: number, warn: boolean): string`; `drainingQuestion(run: Run): Question | null` in the test only (in `register.tsx` task 07 imports and uses it).
- Consumes (task 07, `register.tsx`): `refreshMode($: EngineInterface): Promise<Mode | null>` (recomputes the mode, applies `applyMode`, saves, sets `run.lastMode`; `null` when no run); `prompt.compose` already sets `run.askingId` to the drain's head question (task 07 Step 3m); existing `syncId`, `save`, `log`, `endWait`.
- Consumes (task 08, `register.tsx`): `const isPerson = (kind: string) => kind === 'composer' || kind === 'bridge'` (inside `register`, declared before `prompt.compose`/`turn.start`, so in scope for the `prompt.submit` hook below).
- Produces (`register.tsx`, module-private): `let lastSubmitHuman: boolean`; `queueRefusal(mode: Mode | null): string | null`; `removeAnswered($: EngineInterface): Promise<void>`; the `queue_question` tool (registration + `tool.call` handler); `prompt.submit` hook; `wait_for` sets `awaiting.questionId`; `turn.start` removes the answered question and refreshes the mode (spec §5.1 trigger).

Rules this task implements (spec §5.2, §8):
- `queue_question` is accepted only in modes `queueing`, `overdue`, `draining`; otherwise refused with a pointer to `wait_for` (asking) or to deciding (plain).
- A person's prompt (`composer` | `bridge`, not a slash command) in `overdue` sets `drain` (R10); in `queueing` it does nothing; in `draining`, an idle one (no `turnId`) marks the next turn as their answer **only while the run awaits a `user-answer`/`user-input` wait** (the question was actually put to the person; spec §5.2). Without such a wait (the drain prompt not yet delivered, the question not yet asked) it removes nothing: no question leaves the queue unasked.
- Every `prompt.submit` overwrites `lastSubmitHuman`, and `turn.start` reads and resets it, so only the prompt that starts the turn can count as an answer. A hot reload resets it to `false`: nothing is removed until a person's prompt is seen by the new module (Review Focus 5).
- Removal happens at `turn.start`, **before** `endWait`, which drops the wait and its `questionId`.
- `wait_for user-*` gets `questionId = k` only when the note starts with `#k` and `k` is in the queue. The tag is set whatever the mode: a `user-*` wait is accepted only in `asking`/`draining` (task 05's `waitRefusal`), and outside a drain the tag is never read.

---

- [ ] **Step 1: Pin the chain the hooks run (no failing test in this task)**

The wiring has no fakes (README.md:119), so this task has no failing unit test: its code is register wiring, checked live in Step 4. These tests pin the pure chain the hooks below rely on: the tool's input as the hook receives it (the whole event, reserved keys included), and the queue across away → expiry → the person writes → drain → tagged and untagged answers. The single-function cases (`questionIdFromNote`, the no-id guard, D6) are tested where they are defined, in task 03, and are not repeated here.

Add to the `'./autopilot'` import list of `autopilot/hooks/autopilot.test.ts` each of these names not already imported, keeping the list alphabetical: `FULL_QUEUE_TOOL`, `addQuestion`, `answeredQuestion`, `availMode`, `drainingQuestion`, `effective`, `humanSubmit`, `parseQueueInput`, `queuedResult`, `questionIdFromNote` (after tasks 01–05 all of them are already there). Add `Avail` to the `'../types'` type import if not already there.

Append at the end of the file:

```ts
describe('queue wiring', () => {
  const now = 100 * 60 * 60_000
  const HOUR = 60 * 60_000
  const away: Avail = { v: 1, away: { until: now + HOUR, setAt: now }, askUser: null }

  test('the tool reads its input from the whole tool.call event, reserved keys ignored', async () => {
    const input = parseQueueInput({ tool: FULL_QUEUE_TOOL, tool_use_id: 'toolu_1', question: 'Push to prod?', kind: 'action' })
    expect(input).toEqual({ question: 'Push to prod?', kind: 'action', provisional: null })
    expect(typeof parseQueueInput({ tool: FULL_QUEUE_TOOL, question: 'Push to prod?', kind: 'maybe' })).toBe('string')
    expect(typeof parseQueueInput({ tool: FULL_QUEUE_TOOL, kind: 'answer' })).toBe('string')
  })

  test('away, expiry, the person writes, drain, answers: each question leaves once', async () => {
    let r = run({ askUser: true, until: now + 10 * HOUR })
    expect(availMode(r, effective(r, away, null), now)).toBe('queueing')

    const first = addQuestion(r, { question: '#7 Push to prod?', kind: 'action', provisional: 'keep it on the branch' }, now)
    expect(first.isNew).toBe(true)
    expect(first.run.questions?.[0]?.text).toBe('Push to prod?')
    const second = addQuestion(first.run, { question: 'Rename the API?', kind: 'answer', provisional: null }, now + 1)
    const again = addQuestion(second.run, { question: 'Rename the API?', kind: 'answer', provisional: null }, now + 2)
    expect(again.isNew).toBe(false)
    expect(again.id).toBe(second.id)
    r = again.run
    expect(r.questions?.length).toBe(2)
    expect(queuedResult(first.id, false)).toContain(`#${first.id}`)

    // Writing before the away ends changes nothing (R10).
    expect(humanSubmit(r, 'queueing')).toEqual(r)

    const later = now + 2 * HOUR
    expect(availMode(r, effective(r, away, null), later)).toBe('overdue')
    r = humanSubmit(r, 'overdue')
    expect(availMode(r, effective(r, away, null), later)).toBe('draining')
    expect(drainingQuestion(r)?.id).toBe(first.id)

    // A tagged wait: the note names the question, which leaves the queue.
    const note = `#${first.id} Push to prod?`
    const questionId = questionIdFromNote(note, r.questions ?? [])
    expect(questionId).toBe(first.id)
    const awaiting: Awaiting = { reason: 'user-answer', from: null, note, since: later, timeoutAt: null, pinged: false, questionId: first.id }
    r = answeredQuestion({ ...r, phase: 'awaiting', awaiting, askingId: first.id })
    expect(r.questions?.map(q => q.id)).toEqual([second.id])
    expect(availMode(r, effective(r, away, null), later)).toBe('draining')

    // An untagged answer: the question the role section named (askingId) leaves.
    r = answeredQuestion({ ...r, phase: 'running', awaiting: null, askingId: second.id })
    expect(r.questions ?? []).toEqual([])
    expect(r.drain ?? false).toBe(false)
    expect(r.askingId).toBeUndefined()
    expect(availMode(r, effective(r, away, null), later)).toBe('asking')
  })
})
```

- [ ] **Step 2: Run the pinned chain (it passes at once)**

Run: `claude plugin test autopilot` (from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`)
Expected: the new `describe` **PASSES at once**: everything it calls exists since tasks 01–05; it pins the behaviour the hooks below rely on and does not test `register.tsx` (no fakes). If any of these tests FAILS, STOP and report BLOCKED: an earlier task deviated from the interface contract; do not change those functions here.

Also run `claude plugin validate autopilot` — Expected: PASS (nothing in `register.tsx` changed yet).

- [ ] **Step 3: Write minimal implementation**

**3a. Imports.** In the `'./autopilot'` import list of `autopilot/hooks/register.tsx` add, alphabetically, each of these not already there: `FULL_QUEUE_TOOL`, `QUEUE_TOOL`, `QUEUE_WARN`, `addQuestion`, `answeredQuestion`, `humanSubmit`, `parseQueueInput`, `queuedResult`, `questionIdFromNote` (`drainingQuestion` is already there from task 07). The `'../types'` type import needs no new name here; after tasks 07–08 it reads, complete:

```ts
import type { Avail, AvailCommand, Effective, FinalReason, FinishedRecord, Mode, Run, TokenWindow } from '../types'
```

**3b. Module flag.** After

```ts
// The highest context % a handoff may wait for, below auto-compact.
let ceiling = DEFAULT_CEILING
```

insert:

```ts
// Whether the prompt that starts the next turn is the person's answer during a drain.
// A reload resets it: no question leaves the queue until this module sees the person write.
let lastSubmitHuman = false
```

**3c. Helpers.** Insert before `export const register: Register = on => {` (after task 08's `setAvail` when present, else after `statusText`):

```ts
const QUEUE_FAILED_TEXT =
  'Autopilot could not queue the question. Decide it yourself within your role, record the decision for the handoff, and continue.'
const NO_QUEUE_TEXT = 'Autopilot is not driving right now: no queue.'

/** Why queue_question is refused in this mode, or null when it is accepted. */
function queueRefusal(mode: Mode | null): string | null {
  if (mode === 'queueing' || mode === 'overdue' || mode === 'draining') return null
  if (mode === 'asking') {
    return `The person can be asked right now: do not queue. If they are truly required, send one PushNotification with the question, call ${WAIT_TOOL} with reason user-answer (or user-input) and the question as note, and end your turn.`
  }
  if (mode === 'plain') return 'This run does not ask the person (no --ask-user): decide yourself within your role, record the decision for the handoff, and continue.'

  return NO_QUEUE_TEXT
}

/**
 * The person answered during a drain: their question leaves the queue (the
 * tagged wait's, else the one the role section named). Runs before endWait,
 * which drops the wait and its tag. Nothing removed (no id, or the id is no
 * longer queued): nothing saved, nothing logged.
 */
async function removeAnswered($: EngineInterface): Promise<void> {
  if (!run) return
  const id = run.awaiting?.questionId ?? run.askingId ?? null
  if (id === null) return
  const before = run.questions?.length ?? 0
  run = answeredQuestion(run)
  if ((run.questions?.length ?? 0) === before) return
  await save($)
  await log($, `the person answered #${id}: ${run.questions?.length ?? 0} questions left`)
  await refreshMode($)
}
```

**3d. Tool registration.** In `session.start`, directly after the `$.tool.register({ name: WAIT_TOOL, … })` call (ends with `required: ['reason'],` / `},` / `})`), insert:

```ts
    await $.tool.register({
      name: QUEUE_TOOL,
      description: `Autopilot only: while the person is away or has asking turned off, parks a critical question (one you would otherwise stop for with ${WAIT_TOOL} user-answer) for them to answer later, one by one. Keep working on what is not blocked by it. Refused when the person can be asked directly.`,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question or the action for the person, in one line, as they will read it' },
          kind: { type: 'string', enum: ['answer', 'action'], description: 'answer: a decision only the person can make; action: something the person must do' },
          provisional: { type: 'string', description: 'What you do meanwhile, if anything (prefer a reversible default)' },
        },
        required: ['question', 'kind'],
      },
    })
```

**3e.** (No step: task 07 Step 3m already sets `run.askingId` to the drain's head question in `prompt.compose`, which reads the mode from the cached records without running `refreshMode`. Leave `prompt.compose` as task 07 left it.)

**3f. `prompt.submit`.** Insert directly before `on('turn.start', async ($, e, next) => {`:

```ts
  // The person writing after an away ended starts the drain (R10); during a
  // drain, their idle prompt is the answer the next turn starts with, but only
  // once the question was put to them. A prompt from a plugin, a peer, a
  // notification or the SDK answers nothing.
  on('prompt.submit', async ($, e, next) => {
    // Every prompt overwrites the flag: only the one that starts the turn counts.
    lastSubmitHuman = false
    // A slash command typed by the person is not a message to the session. (isPerson: task 08's helper.)
    if (!isPerson(e.origin.kind) || e.text.trimStart().startsWith('/')) return next(e)
    await syncId($)
    if (!run) return next(e)
    const mode = await refreshMode($)
    if (mode === 'overdue' && run) {
      run = humanSubmit(run, mode)
      await save($)
      await log($, 'the person wrote after the away time: asking the queued questions one by one')
      await refreshMode($)

      return next(e)
    }
    // Typed into a running turn (turnId set) it reaches that turn, not the next one.
    // Only an answer to a question put to the person counts: while the drain prompt
    // is still on its way, or the model has not asked yet, nothing leaves the queue
    // (spec §5.2: no question removed unasked).
    const awaitsPerson = run?.phase === 'awaiting' && (run.awaiting?.reason === 'user-answer' || run.awaiting?.reason === 'user-input')
    if (mode === 'draining' && !e.turnId && awaitsPerson) lastSubmitHuman = true

    return next(e)
  }).catch(($, e, next) => next(e))
```

**3g. `turn.start`.** Replace

```ts
  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    toolsThisTurn = 0
    turnSeq += 1
    await syncId($)
    // turn.start carries no agentId: it is the main loop's turn.
    await endWait($)
```

with (the lines after `await endWait($)`, `await refreshIdentity($)` and `return next(e)`, stay as they are; tasks 05–08 do not touch `turn.start`):

```ts
  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    toolsThisTurn = 0
    turnSeq += 1
    // Read and reset before any await: only the prompt that starts this turn can be the answer.
    const isAnswer = lastSubmitHuman
    lastSubmitHuman = false
    await syncId($)
    if (isAnswer) await removeAnswered($)
    // turn.start carries no agentId: it is the main loop's turn.
    await endWait($)
    // A turn start is a mode-rule trigger (spec §5.1): the wait just ended may change the mode.
    await refreshMode($)
```

**3h. `wait_for` tagging.** In `on('tool.call', { tool: FULL_WAIT_TOOL }, …)`, directly after the refusal block

```ts
    if (refusal) {
      await log($, `wait refused (${parsed.awaiting.reason}): ${refusal}`)
      return { deny: refusal }
    }
```

(its `waitRefusal(…)` call is task 07's), and before `const previous = { phase: run.phase, awaiting: run.awaiting ?? null }`, insert:

```ts
    // A drain question asked: "#k" in the note names it, only while k is queued; untagged removes nothing by mistake.
    if (parsed.awaiting.reason === 'user-answer' || parsed.awaiting.reason === 'user-input') {
      const questionId = questionIdFromNote(parsed.awaiting.note, run.questions ?? [])
      if (questionId !== null) parsed.awaiting.questionId = questionId
    }
```

No `await` comes before the existing flip, so a parallel call still cannot interleave.

**3i. `queue_question` handler.** Directly after the line `  }).catch(() => ({ deny: 'Autopilot could not record the wait. Continue your work.' }))` that closes the `wait_for` handler, insert:

```ts
  on('tool.call', { tool: FULL_QUEUE_TOOL }, async ($, e) => {
    // Only the main loop asks the person; a subagent reports to it instead.
    if (e.agentId) {
      await log($, `queue refused: called by a subagent (${e.agentId})`)
      return { deny: 'Only the main session may queue questions for the person under autopilot; a subagent may not.' }
    }
    await syncId($)
    const mode = await refreshMode($)
    const refusal = queueRefusal(mode)
    if (refusal) return { deny: refusal }
    const now = await $.clock.now()
    // Stopped while the clock was read.
    if (!run) return { deny: NO_QUEUE_TEXT }
    const input = parseQueueInput(e)
    if (typeof input === 'string') return { deny: input }

    // Add and swap before the next await: a parallel call queues after this one, never over it.
    const before = run
    const added = addQuestion(run, input, now)
    run = added.run
    try {
      await save($)
    } catch (error) {
      // Not recorded: back to where it was, or the run would differ from what is stored.
      run = before
      await save($).catch(() => undefined)
      await log($, `could not record the question: ${String(error)}`).catch(() => undefined)
      return { deny: QUEUE_FAILED_TEXT }
    }
    const count = run?.questions?.length ?? 0
    const meanwhile = input.provisional ? ` · meanwhile: ${input.provisional}` : ''
    await log($, added.isNew ? `queued #${added.id} (${input.kind}, ${count} waiting): ${input.question}${meanwhile}` : `queue: same as #${added.id}, not added again`)
    $.ui.toast(added.isNew ? `Autopilot: question #${added.id} queued for you (${count} waiting).` : `Autopilot: question #${added.id} was already queued.`)
    // Never dropped (D6): past the mark the person only hears how many wait.
    if (added.warn) $.ui.toast(`Autopilot: ${count} questions are queued (more than ${QUEUE_WARN}); none is dropped. /back to answer them.`)

    return { result: queuedResult(added.id, added.warn) }
  }).catch(() => ({ deny: QUEUE_FAILED_TEXT }))
```

The generic `on('tool.call', async ($, e, next) => { … })` hook is unchanged: a `queue_question` call while `awaiting` ends the wait there (`endsWait` is true for every tool but `wait_for`), as any other work does.

- [ ] **Step 4: Run tests, expected PASS (all existing tests too)**

Run: `claude plugin test autopilot` — Expected: PASS, every test including the earlier ones.
Run: `claude plugin validate autopilot` — Expected: PASS.

Live check (session on this worktree, `/reload-plugins` first; the ping and the idle delivery of the drain come with task 10, so here the drain starts when the person writes):

1. `/away for 2m`, then `/autopilot 30m 60 "Test role: create notes.txt; before choosing its name between a.txt and b.txt, treat the choice as critical and ask the person" --ask-user`. Expected: the model calls `queue_question` → toast `Autopilot: question #1 queued for you (1 waiting).`; the log has `queued #1 (answer, 1 waiting): …`; the model keeps working on what is not blocked.
2. Let the model call `queue_question` again with the same text → toast `Autopilot: question #1 was already queued.`; nothing added.
3. Before the two minutes pass, type `hi` → no drain (`/autopilot` lists the queue, no asking). After they pass, type `go on` → log `the person wrote after the away time: asking the queued questions one by one`; the next turn asks #1 as text and calls `wait_for` user-answer with a note starting `#1`.
4. Answer `a.txt` → log `the person answered #1: 0 questions left`; `/autopilot` shows an empty queue and asking mode.
5. Mode `asking` (after 4): a `queue_question` call is denied with `The person can be asked right now: do not queue…`.
6. Review Focus 5: repeat 1–3 until the session awaits user-answer on a question; save `register.tsx` unchanged and run `/reload-plugins`; send the session a peer message from another session (or let a background task finish) → the wait ends, no `the person answered` line, the question stays queued. Then type the answer → it is removed.
7. Type `/autopilot` during a drain while the session awaits the answer → the question stays queued (a slash command is not an answer).
8. No question removed unasked (spec §5.2): with one question queued and away active, type `/back`, then type `hi` at once, before the drain prompt arrives (the session is not yet waiting on `user-answer`) → no `the person answered` line in the log, `/autopilot` still shows queued 1, and the model then asks #1. (The drain prompt's delivery comes with task 10; before task 10, start the drain by the expiry-then-write path of item 3 and type a second message before the model asks.)

- [ ] **Step 5: Ready for commit**

Tell the editor (agents never commit): files ready —
- `autopilot/hooks/register.tsx`
- `autopilot/hooks/autopilot.test.ts`

Suggested message:

```
(feat): Queue critical questions and take answers from the person

- Add the queue_question tool, accepted while queueing, overdue or draining
- Tag wait_for user-* with #k when k is queued
- Start the drain when the person writes after an away ends
- Remove the answered question at turn start, only after a person's prompt to a question put to them
- Refresh the availability mode at turn start
- Pin the queue chain and the tool's input as the hook receives it
```
