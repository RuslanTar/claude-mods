### Task 03: Question queue (pure)

**Files:**
- Modify: `autopilot/hooks/autopilot.ts`
  - the type import from `'../types'` at the top (as tasks 01–02 left it) — add `Question`, `QueueInput`
  - insert a new block right after `waitTimeoutPrompt` (currently ends at line 755) and before `function parseRow` (currently line 757). Line numbers are as of `main` before tasks 01–02; anchor on the function names, not the numbers.
- Test: `autopilot/hooks/autopilot.test.ts`
  - line 3 (type import) — no change: task 01 already made it `import type { Avail, Awaiting, Question, Run, WaitReason } from '../types'`
  - lines 4–53 (the `./autopilot` import list) — add `FULL_QUEUE_TOOL`, `QUEUE_TOOL`, `QUEUE_WARN`, `addQuestion`, `answeredQuestion`, `parseQueueInput`, `questionIdFromNote`, `stripTag` (keep the list sorted the way it is: constants first, then functions alphabetically)
  - append a new `describe('question queue', …)` block at the end of the file (currently after line 1159)

**Interfaces:**
- Consumes (task 01, `autopilot/types/index.d.ts`):
  - `export type Question = { id: number; text: string; kind: 'answer' | 'action'; provisional: string | null; at: number }`
  - `export type QueueInput = { question: string; kind: 'answer' | 'action'; provisional: string | null }`
  - `Run` optional fields `questions?: Question[]; drain?: boolean; askingId?: number; nextQuestionId?: number`
  - `Awaiting` optional field `questionId?: number`
- Consumes (existing, module-private in `autopilot.ts`): `waitField(value, name, max)` (line 667), `INVISIBLE_ALL` (line 851, used through `waitField`).
- Produces (`autopilot/hooks/autopilot.ts`):
  - `export const QUEUE_WARN = 20`
  - `export const QUEUE_TOOL = 'queue_question'`
  - `export const FULL_QUEUE_TOOL = \`mcp__autopilot__${QUEUE_TOOL}\``
  - `export function parseQueueInput(input: unknown): QueueInput | string` — a string is the error text for the tool result
  - `export function stripTag(text: string): string`
  - `export function addQuestion(run: Run, input: QueueInput, now: number): { run: Run; id: number; isNew: boolean; warn: boolean }`
  - `export function questionIdFromNote(note: string | null, questions: readonly Question[]): number | null`
  - `export function answeredQuestion(run: Run): Run`
  - module-private `nextQuestionId(run: Run): number` (task 04 uses it from the same file; a caller that stores a question under that id must also set `run.nextQuestionId = id + 1`, as `addQuestion` does)

Behaviour decided here (spec §3.1, §5.2, §8, D6):
- A tag is `#<digits>` at the very start of the text (after spaces), not followed by a letter, digit or `_`, plus any spaces and `: . ) - – —` after it. `#3rd floor` is not a tag.
- `questionIdFromNote` reads only a **leading** tag, and only a `k` that is in the queue; anything else is `null` (nothing removed by mistake).
- Ids are never reused within the run (spec §3.1). The next id is `max(run.nextQuestionId ?? 1, max(question ids, askingId, awaiting.questionId) + 1)`: the counter task 01 adds to `Run` wins once set; an older run without it falls back to the highest id in use plus one (1 when none). `addQuestion` stores `nextQuestionId: id + 1`, so after the queue empties the next question does not get `#1` again and a stale `#1` wait note cannot match it.
- Dedupe is on the stripped, trimmed text; a duplicate returns the existing id, `isNew: false`, and the run unchanged.
- The queue never drops anything; `warn` is true when the queue holds more than `QUEUE_WARN` entries after the call.
- `answeredQuestion` removes `awaiting.questionId ?? askingId` when it is in the queue. When the queue is then empty it clears `drain` and `askingId`; when the removed id was `askingId` it clears `askingId` (the next role section names the next head and sets it again, task 07/09). Without either id it removes nothing — this is what keeps a hot reload safe (Review Focus 5): register calls it only behind the human flag.

- [ ] **Step 1: Write the failing test**

In `autopilot/hooks/autopilot.test.ts`, the type import on line 3 already reads (task 01), and needs no change:

```ts
import type { Avail, Awaiting, Question, Run, WaitReason } from '../types'
```

Add these names to the `from './autopilot'` import list:

```ts
  FULL_QUEUE_TOOL,
  QUEUE_TOOL,
  QUEUE_WARN,
  addQuestion,
  answeredQuestion,
  parseQueueInput,
  questionIdFromNote,
  stripTag,
```

Append at the end of the file:

```ts
describe('question queue', () => {
  const NOW = 2_000_000

  const queued = (id: number, text: string, kind: Question['kind'] = 'answer'): Question => ({ id, text, kind, provisional: null, at: NOW - 1000 })

  const awaitingNote = (note: string, questionId?: number): Awaiting => ({
    reason: 'user-answer',
    from: 'the person',
    note,
    since: NOW - 5000,
    timeoutAt: null,
    pinged: false,
    ...(questionId === undefined ? {} : { questionId }),
  })

  test('the tool names and the warning size', async () => {
    expect(QUEUE_TOOL).toBe('queue_question')
    expect(FULL_QUEUE_TOOL).toBe('mcp__autopilot__queue_question')
    expect(QUEUE_WARN).toBe(20)
  })

  test('a valid input: question, kind, optional provisional', async () => {
    expect(parseQueueInput({ question: 'Push the release tag?', kind: 'answer', provisional: 'keep it local' })).toEqual({
      question: 'Push the release tag?',
      kind: 'answer',
      provisional: 'keep it local',
    })
    expect(parseQueueInput({ question: 'Log in to the staging VPN', kind: 'action' })).toEqual({
      question: 'Log in to the staging VPN',
      kind: 'action',
      provisional: null,
    })
    expect(parseQueueInput({ question: 'Rename the table?', kind: 'answer', provisional: null })).toEqual({
      question: 'Rename the table?',
      kind: 'answer',
      provisional: null,
    })
  })

  test('the input loses a leading #k tag and invisible characters', async () => {
    expect(parseQueueInput({ question: '#3 Push the release tag?', kind: 'answer' })).toEqual({
      question: 'Push the release tag?',
      kind: 'answer',
      provisional: null,
    })
    expect(parseQueueInput({ question: ' Push\u200B now?\u{E0041} ', kind: 'answer' })).toEqual({
      question: 'Push now?',
      kind: 'answer',
      provisional: null,
    })
  })

  test('a malformed input is an error text', async () => {
    for (const input of [null, 'Push?', 42, {}]) expect(typeof parseQueueInput(input)).toBe('string')
    expect(typeof parseQueueInput({ question: '', kind: 'answer' })).toBe('string')
    expect(typeof parseQueueInput({ question: '#4', kind: 'answer' })).toBe('string')
    expect(typeof parseQueueInput({ question: 7, kind: 'answer' })).toBe('string')
    expect(typeof parseQueueInput({ question: 'Push?', kind: 'decide' })).toBe('string')
    expect(typeof parseQueueInput({ question: 'Push?' })).toBe('string')
    expect(typeof parseQueueInput({ question: 'Push?', kind: 'answer', provisional: 3 })).toBe('string')
  })

  test('stripTag removes only a leading tag', async () => {
    expect(stripTag('#3 Push the tag?')).toBe('Push the tag?')
    expect(stripTag('  #12: Push the tag?')).toBe('Push the tag?')
    expect(stripTag('#2 — Push the tag?')).toBe('Push the tag?')
    expect(stripTag('#4')).toBe('')
    expect(stripTag('#3rd floor printer?')).toBe('#3rd floor printer?')
    expect(stripTag('Push tag #3?')).toBe('Push tag #3?')
    expect(stripTag('Push the tag?')).toBe('Push the tag?')
  })

  test('addQuestion appends at the tail with the next id', async () => {
    const first = addQuestion(run({}), { question: 'Push the tag?', kind: 'answer', provisional: null }, NOW)
    expect(first.id).toBe(1)
    expect(first.isNew).toBe(true)
    expect(first.warn).toBe(false)
    expect(first.run.questions).toEqual([{ id: 1, text: 'Push the tag?', kind: 'answer', provisional: null, at: NOW }])

    const second = addQuestion(first.run, { question: 'Log in to the VPN', kind: 'action', provisional: 'skip staging' }, NOW + 1)
    expect(second.id).toBe(2)
    expect(second.run.questions?.map(question => question.id)).toEqual([1, 2])
    expect(second.run.questions?.[1]).toEqual({ id: 2, text: 'Log in to the VPN', kind: 'action', provisional: 'skip staging', at: NOW + 1 })
  })

  test('addQuestion dedupes on the text without its tag', async () => {
    const base = run({ questions: [queued(1, 'Push the tag?')] })
    const again = addQuestion(base, { question: '#1 Push the tag?', kind: 'answer', provisional: 'later' }, NOW)
    expect(again.isNew).toBe(false)
    expect(again.id).toBe(1)
    expect(again.run).toBe(base)

    const other = addQuestion(base, { question: 'Push the tag now?', kind: 'answer', provisional: null }, NOW)
    expect(other.isNew).toBe(true)
    expect(other.run.questions).toHaveLength(2)
  })

  test('addQuestion never drops a question and warns above QUEUE_WARN', async () => {
    let current = run({})
    const warnings: boolean[] = []
    for (let index = 1; index <= QUEUE_WARN + 2; index++) {
      const added = addQuestion(current, { question: `Question ${index}?`, kind: 'answer', provisional: null }, NOW + index)
      warnings.push(added.warn)
      current = added.run
    }
    expect(current.questions).toHaveLength(QUEUE_WARN + 2)
    expect(warnings[QUEUE_WARN - 1]).toBe(false)
    expect(warnings[QUEUE_WARN]).toBe(true)
    expect(warnings[QUEUE_WARN + 1]).toBe(true)
  })

  test('a new id never repeats the question being asked or waited on', async () => {
    const asked = run({ questions: [queued(2, 'Rename the table?')], askingId: 3 })
    expect(addQuestion(asked, { question: 'Push?', kind: 'answer', provisional: null }, NOW).id).toBe(4)
    const waited = run({ questions: [], phase: 'awaiting', awaiting: awaitingNote('#6 Push?', 6) })
    expect(addQuestion(waited, { question: 'Merge?', kind: 'answer', provisional: null }, NOW).id).toBe(7)
  })

  test('an id is never reused after the queue empties', async () => {
    const first = addQuestion(run({}), { question: 'Push the tag?', kind: 'answer', provisional: null }, NOW)
    expect(first.id).toBe(1)
    expect(first.run.nextQuestionId).toBe(2)
    const emptied = answeredQuestion({ ...first.run, drain: true, askingId: 1 })
    expect(emptied.questions).toEqual([])
    expect(emptied.askingId).toBeUndefined()
    const next = addQuestion(emptied, { question: 'Merge the branch?', kind: 'answer', provisional: null }, NOW + 1)
    expect(next.id).toBe(2)
    expect(next.run.nextQuestionId).toBe(3)
    // The stored counter wins over the ids in use; a duplicate leaves it alone.
    expect(addQuestion(run({ questions: [queued(2, 'Push?')], nextQuestionId: 9 }), { question: 'Merge?', kind: 'answer', provisional: null }, NOW).id).toBe(9)
    expect(addQuestion(next.run, { question: 'Merge the branch?', kind: 'answer', provisional: null }, NOW).run.nextQuestionId).toBe(3)
  })

  test('questionIdFromNote: a leading #k that is in the queue', async () => {
    const questions = [queued(1, 'Push?'), queued(2, 'Merge?')]
    expect(questionIdFromNote('#2 Merge?', questions)).toBe(2)
    expect(questionIdFromNote('  #1: Push?', questions)).toBe(1)
    expect(questionIdFromNote('#5 Deploy?', questions)).toBeNull()
    expect(questionIdFromNote('Merge? #2', questions)).toBeNull()
    expect(questionIdFromNote('#2x Merge?', questions)).toBeNull()
    expect(questionIdFromNote('Merge?', questions)).toBeNull()
    expect(questionIdFromNote(null, questions)).toBeNull()
    expect(questionIdFromNote('#1 Push?', [])).toBeNull()
  })

  test('answeredQuestion removes the tagged wait question before the asked one', async () => {
    const tagged = run({
      questions: [queued(1, 'Push?'), queued(2, 'Merge?'), queued(3, 'Deploy?')],
      drain: true,
      askingId: 1,
      phase: 'awaiting',
      awaiting: awaitingNote('#2 Merge?', 2),
    })
    const after = answeredQuestion(tagged)
    expect(after.questions?.map(question => question.id)).toEqual([1, 3])
    expect(after.askingId).toBe(1)
    expect(after.drain).toBe(true)
  })

  test('answeredQuestion falls back to the asked question and clears askingId', async () => {
    const untagged = run({
      questions: [queued(1, 'Push?'), queued(2, 'Merge?')],
      drain: true,
      askingId: 1,
      phase: 'awaiting',
      awaiting: awaitingNote('Push the tag?'),
    })
    const after = answeredQuestion(untagged)
    expect(after.questions?.map(question => question.id)).toEqual([2])
    expect(after.askingId).toBeUndefined()
    expect(after.drain).toBe(true)
  })

  test('answering the last question ends the drain', async () => {
    const last = run({ questions: [queued(4, 'Push?')], drain: true, askingId: 4 })
    const after = answeredQuestion(last)
    expect(after.questions).toEqual([])
    expect(after.drain).toBe(false)
    expect(after.askingId).toBeUndefined()
  })

  test('without a question id nothing is removed (a reload never loses a question)', async () => {
    const reloaded = run({ questions: [queued(1, 'Push?'), queued(2, 'Merge?')], drain: true })
    expect(answeredQuestion(reloaded)).toBe(reloaded)
    const stale = run({ questions: [queued(2, 'Merge?')], drain: true, askingId: 1 })
    expect(answeredQuestion(stale).questions?.map(question => question.id)).toEqual([2])
  })

  test('an old stored run without queue fields is left alone', async () => {
    const old = run({}) as Partial<Run>
    delete old.askUser
    expect(answeredQuestion(old as Run)).toBe(old)
    expect(addQuestion(old as Run, { question: 'Push?', kind: 'answer', provisional: null }, NOW).id).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `claude plugin test autopilot` (from `/Users/vladyslavlieus/work/Everlabs/claude-mods-away`)
Expected: FAIL — `./autopilot` has no exports `QUEUE_TOOL`, `FULL_QUEUE_TOOL`, `QUEUE_WARN`, `parseQueueInput`, `stripTag`, `addQuestion`, `questionIdFromNote`, `answeredQuestion` (the test module fails to load / the new tests fail with "is not a function").

- [ ] **Step 3: Write minimal implementation**

In `autopilot/hooks/autopilot.ts`, add `Question` and `QueueInput` to the type import at the top of the file. The complete import after this task (tasks 01–02 names kept, sorted):

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
  Question,
  QueueInput,
  Run,
  StartCommand,
  TokenWindow,
  WaitReason,
} from '../types'
```

Insert after `waitTimeoutPrompt` (after its closing `}`, before `function parseRow`):

```ts
/** Above this many queued questions queue_question still accepts, with a warning. */
export const QUEUE_WARN = 20
export const QUEUE_TOOL = 'queue_question'
/** The queue tool as the engine names it in a tool call. */
export const FULL_QUEUE_TOOL = `mcp__autopilot__${QUEUE_TOOL}`
const MAX_QUESTION = 500
const MAX_PROVISIONAL = 200
const QUESTION_KINDS: readonly Question['kind'][] = ['answer', 'action']

/** A leading `#k` tag: digits not run on into a word, then any separator. */
const LEADING_TAG = /^\s*#(\d+)(?!\w)[\s:.)–—-]*/

/** The text without a leading `#k` tag the model may have copied from a wait note. */
export function stripTag(text: string): string {
  return text.replace(LEADING_TAG, '').trim()
}

/**
 * The queue_question tool's input: the question (tag stripped), its kind and
 * an optional provisional decision; a string is the error the model reads.
 */
export function parseQueueInput(input: unknown): QueueInput | string {
  if (!input || typeof input !== 'object') return `${QUEUE_TOOL} needs an input object.`
  const fields = input as Record<string, unknown>
  const question = waitField(fields.question, 'question', MAX_QUESTION)
  if ('error' in question) return question.error
  const text = stripTag(question.value ?? '')
  if (!text) return 'question must be the question or the action for the person, in a sentence or two.'
  const kind = QUESTION_KINDS.find(known => known === fields.kind)
  if (!kind) return 'kind must be answer (the person decides) or action (the person must do something).'
  const provisional = fields.provisional === null ? { value: null } : waitField(fields.provisional, 'provisional', MAX_PROVISIONAL)
  if ('error' in provisional) return provisional.error

  return { question: text, kind, provisional: provisional.value }
}

/**
 * The next question id, never reused within the run: the stored counter, and
 * never at or below an id in the queue or the one being asked or waited on
 * (an older run has no counter).
 */
function nextQuestionId(run: Run): number {
  const ids = (run.questions ?? []).map(question => question.id)
  const inUse = Math.max(0, ...ids, run.askingId ?? 0, run.awaiting?.questionId ?? 0) + 1

  return Math.max(run.nextQuestionId ?? 1, inUse)
}

/** Appends a question to the queue; the same text again keeps the queued one. Nothing is ever dropped. */
export function addQuestion(run: Run, input: QueueInput, now: number): { run: Run; id: number; isNew: boolean; warn: boolean } {
  const questions = run.questions ?? []
  const text = stripTag(input.question)
  const same = questions.find(question => question.text === text)
  if (same) return { run, id: same.id, isNew: false, warn: questions.length > QUEUE_WARN }

  const id = nextQuestionId(run)
  const next = [...questions, { id, text, kind: input.kind, provisional: input.provisional, at: now }]

  return { run: { ...run, questions: next, nextQuestionId: id + 1 }, id, isNew: true, warn: next.length > QUEUE_WARN }
}

/** The queued question a wait note names with a leading `#k`; null when untagged or not queued. */
export function questionIdFromNote(note: string | null, questions: readonly Question[]): number | null {
  const match = note ? LEADING_TAG.exec(note) : null
  if (!match) return null
  const id = Number(match[1])

  return questions.some(question => question.id === id) ? id : null
}

/**
 * The run after the person answered during a drain: the wait's tagged
 * question goes, else the one the drain asked. No id, nothing removed.
 */
export function answeredQuestion(run: Run): Run {
  const id = run.awaiting?.questionId ?? run.askingId
  const questions = run.questions ?? []
  const left = questions.filter(question => question.id !== id)
  if (left.length === 0 && questions.length > 0) return { ...run, questions: left, drain: false, askingId: undefined }
  if (left.length === questions.length) return run

  return { ...run, questions: left, askingId: run.askingId === id ? undefined : run.askingId }
}
```

- [ ] **Step 4: Run tests, expected PASS (all existing tests too)**

Run: `claude plugin test autopilot`
Expected: PASS — every existing `describe` block plus `question queue`. Then `claude plugin validate autopilot`: no errors.

- [ ] **Step 5: Ready for commit**

Tell the editor (agents never commit) the files are ready:
- `autopilot/hooks/autopilot.ts`
- `autopilot/hooks/autopilot.test.ts`

Suggested message:

```
(feat): Add the question queue for away mode

- queue_question tool names and the QUEUE_WARN size
- parseQueueInput and stripTag: tag-free, sanitized questions
- addQuestion: dedupe on text, never drop, warn above 20, ids never reused (Run.nextQuestionId)
- questionIdFromNote and answeredQuestion: remove only a tagged or asked question
```
