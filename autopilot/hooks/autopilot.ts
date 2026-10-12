import type { Awaiting, Command, FinalReason, FinishedRecord, Phase, Run, StartCommand, TokenWindow, WaitReason } from '../types'

export const RESTART_TOOL = 'restart_session'
export const WAIT_TOOL = 'wait_for'
/** The wait tool as the engine names it in a tool call. */
export const FULL_WAIT_TOOL = `mcp__autopilot__${WAIT_TOOL}`
export const WAIT_REASONS: readonly WaitReason[] = [
  'user-input',
  'user-answer',
  'session-answer',
  'session-ping',
  'workflow-end',
  'subagent-result',
  'background-task',
  'other',
]
const MAX_WAIT_FROM = 64
const MAX_WAIT_NOTE = 200
export const MAX_IDLE_TURNS = 2
/**
 * A threshold below this sits close to what a resume alone loads, so every
 * handoff after the first fires RESUME_BUMP points later. At or above it the
 * threshold stands as given.
 */
export const LOW_THRESHOLD = 50
export const RESUME_BUMP = 10
/**
 * The trigger always fires this many points before auto-compact would: room
 * for the handoff itself (reading state, writing the document).
 */
export const COMPACT_MARGIN = 10
/** The ceiling when auto-compact is off or its threshold is unknown. */
export const DEFAULT_CEILING = 90
export const DEFAULT_FIVE_HOUR_STOP = 95
export const DEFAULT_WEEK_STOP = 80
/** Resume this long after the 5-hour window resets, and wait this long when the reset time is unknown. */
export const RESET_MARGIN_MS = 2 * 60_000
export const UNKNOWN_RESET_WAIT_MS = 30 * 60_000

/**
 * The highest context % a handoff may wait for: COMPACT_MARGIN below the
 * session's auto-compact threshold, so a handoff always comes first.
 */
export function triggerCeiling(autoCompactTokens: number | undefined, windowTokens: number | undefined): number {
  if (!autoCompactTokens || !windowTokens) return DEFAULT_CEILING

  return Math.max(1, Math.floor((autoCompactTokens / windowTokens) * 100) - COMPACT_MARGIN)
}

/**
 * The context % that triggers the handoff now: the person's threshold; under
 * LOW_THRESHOLD, every handoff after the first RESUME_BUMP points later so a
 * resumed session cannot loop; never above the ceiling below auto-compact.
 */
export function effectiveTrigger(run: Run, ceiling: number): number {
  const isBumped = run.threshold < LOW_THRESHOLD && run.restarts > 0

  return Math.min(isBumped ? run.threshold + RESUME_BUMP : run.threshold, ceiling)
}

/** "90m", "2h", "1h30m", "45" (minutes) → milliseconds; null when unreadable. */
export function parseDuration(text: string): number | null {
  const ms = durationMs(text)
  if (ms === null || !Number.isFinite(ms)) return null

  return ms
}

function durationMs(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text) * 60_000
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text)
  if (!match || (!match[1] && !match[2])) return null

  return (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60_000
}

/** A moved end must stay at least this far ahead of now. */
const MIN_LEAD_MS = 60_000

/** How long after finishing on time or restarts the person can still bring a run back. */
export const GRACE_MS = 15 * 60_000

/** Whether a run that finished for this reason can be brought back (a time-out or used-up restarts only). */
export function isGraceEligible(reason: FinalReason | null): boolean {
  return reason === 'time' || reason === 'restarts'
}

export function isGraceLive(record: FinishedRecord, now: number): boolean {
  return now - record.finishedAt <= GRACE_MS
}

/** Whether a stored `finished:` value is a record still inside its grace period; anything malformed is not. */
export function isLiveFinishedValue(value: unknown, now: number): boolean {
  if (typeof value !== 'object' || value === null) return false
  const finishedAt = (value as { finishedAt?: unknown }).finishedAt
  if (typeof finishedAt !== 'number' || !Number.isFinite(finishedAt)) return false

  return isGraceLive(value as FinishedRecord, now)
}

/** What `/autopilot` says when there is no run but a finished one can still be brought back. */
export function graceStatusText(record: FinishedRecord, now: number): string {
  const minutesLeft = Math.max(0, Math.ceil((GRACE_MS - (now - record.finishedAt)) / 60_000))

  const ask = record.run.finalReason === 'restarts' ? 'extend --restarts N' : 'extend <time>'

  return `Autopilot finished (${record.run.finalReason}) at ${endClock(record.finishedAt, null)}; /autopilot ${ask} within ${minutesLeft}m brings it back from its handoff.`
}

/** How many times a grace resume asks the session to restart before it gives up. */
const MAX_GRACE_ASKS = 1

/**
 * What a finished main-loop turn means for a grace resume that is still
 * waiting for its restart: ask once more, or pause. Any
 * other run (an ordinary wrap-up included) is none of its business.
 */
export function graceTurnAction(run: Run): 'none' | 'ask' | 'pause' {
  if (run.phase !== 'wrapping' || !run.isGraceResume) return 'none'

  return (run.graceAsks ?? 0) < MAX_GRACE_ASKS ? 'ask' : 'pause'
}

/**
 * Whether a grace resume's handoff is the current one: written at or after the
 * final phase began (`ok`), older or unreadable (`stale`), or no start time to
 * compare with (`unknown`, which fails closed).
 */
export function graceHandoffCheck(mtimeMs: number | null, since: number | undefined): 'ok' | 'stale' | 'unknown' {
  if (since === undefined) return 'unknown'

  return mtimeMs !== null && mtimeMs >= since ? 'ok' : 'stale'
}

/** The prompt that makes a finished run restart from the handoff it already wrote. */
export function graceResumePrompt(until: number, offsetMinutes: number | null): string {
  return `Autopilot: the person brought this run back until ${endClock(until, offsetMinutes)}. Call ${RESTART_TOOL} with the path of the handoff you just wrote under thoughts/shared/handoffs/; autopilot will clear the session and resume from it. Do not start other work first.`
}

/** The most restarts a limit may reach. */
const MAX_RESTARTS = 99

/** The furthest the end of a run may be moved ahead of now. */
export const MAX_AHEAD_MS = 7 * 24 * 60 * 60_000

/** "18:30", "7:30" (24-hour) or "6pm", "6:30pm", "12am" (12-hour, no space, any case) → hours and minutes; null when unreadable. */
export function parseClock(text: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i.exec(text)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2] ?? 0)
  const suffix = match[3]?.toLowerCase()
  if (minutes > 59) return null
  if (!suffix) return match[2] === undefined || hours > 23 ? null : { hours, minutes }
  if (hours < 1 || hours > 12) return null

  return { hours: (hours % 12) + (suffix === 'pm' ? 12 : 0), minutes }
}

/** `date +%z` output ("+0300", "-0530") → minutes east of UTC; null when unreadable. */
export function parseUtcOffset(text: string): number | null {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(text.trim())
  if (!match) return null
  const minutes = Number(match[2]) * 60 + Number(match[3])

  return match[1] === '-' ? -minutes : minutes
}

/**
 * The next instant strictly after `now` whose local clock (UTC + offset) reads hours:minutes.
 * Today's offset is applied: a DST switch before the target shifts it by an hour.
 */
export function untilFromClock(hours: number, minutes: number, now: number, offsetMinutes: number): number {
  const DAY_MS = 24 * 60 * 60_000
  const localNow = now + offsetMinutes * 60_000
  const localMidnight = localNow - (((localNow % DAY_MS) + DAY_MS) % DAY_MS)
  const today = localMidnight + (hours * 60 + minutes) * 60_000 - offsetMinutes * 60_000

  return today > now ? today : today + DAY_MS
}

export const NOT_RUNNING_TEXT = 'Autopilot is not running. Start a new run: /autopilot <time> <threshold%> "<role>".'

/** Where a change to the run's end and restart limit lands. */
export type RetimeTarget = { until: number; maxRestarts: number | null }

export type RetimeAction =
  | ({ kind: 'set' } & RetimeTarget)
  | ({ kind: 'revive'; phase: 'running' | 'waiting'; waitUntil: number | null } & RetimeTarget)
  | { kind: 'refuse'; message: string }

type RetimeCommand = Extract<Command, { kind: 'extend' | 'shorten' | 'until' }>

/**
 * The end and restart limit a retime command asks for, with a note for the
 * reply when the restarts part changed nothing or hit zero left.
 */
export function targetChange(
  command: RetimeCommand,
  run: Run,
  now: number,
  offset: number | null,
): (RetimeTarget & { note: string | null }) | { refuse: string } {
  if (command.kind === 'until') {
    if (offset === null) return { refuse: 'Cannot read the local time zone; use /autopilot extend or shorten instead.' }

    return { until: untilFromClock(command.hours, command.minutes, now, offset), maxRestarts: run.maxRestarts, note: null }
  }

  const isExtend = command.kind === 'extend'
  const isRestartsOnly = command.deltaMs === 0
  if (isRestartsOnly && run.until <= now && !endsForGood(run)) {
    return {
      refuse: isExtend
        ? "The run's time is over; add time too, e.g. /autopilot extend 1h --restarts N."
        : "The run's time is over; restarts cannot be changed on a finished time, add time with /autopilot extend.",
    }
  }
  // A restarts-only change leaves the end alone (its past end is refused above); an extend counts from now when the end already passed.
  const until = isExtend && !isRestartsOnly ? Math.max(run.until, now) + command.deltaMs : run.until - command.deltaMs
  if (command.restarts === 0) return { until, maxRestarts: run.maxRestarts, note: null }

  if (isExtend) {
    const raised = (run.maxRestarts ?? run.restarts) + command.restarts

    return { until, maxRestarts: Math.max(run.restarts, Math.min(raised, MAX_RESTARTS)), note: raised > MAX_RESTARTS ? `Restart limit capped at ${MAX_RESTARTS}.` : null }
  }
  if (run.maxRestarts === null) {
    return { until, maxRestarts: null, note: 'Restarts are unlimited in this run; --restarts on shorten was ignored.' }
  }
  const lowered = run.maxRestarts - command.restarts
  const note = lowered <= run.restarts ? `No restarts left after this change (${run.restarts} used).` : null

  return { until, maxRestarts: Math.max(run.restarts, lowered), note }
}

const FINAL_REASON_TEXT: Record<string, string> = {
  goal: 'its goal is met',
  week: 'the weekly token limit was reached',
  restarts: 'it used all its restarts',
  done: 'the session reported its work complete',
}

/**
 * What moving the run to `target` does: set it, bring a finished run back
 * (a time-out, or an exhausted restart limit that was raised, with time left),
 * or refuse. `limit` is what the token windows call for now (limitAction): a
 * revive is refused at the weekly stop, and lands in `waiting` while a 5-hour
 * wait is pending or the 5-hour window is at its stop.
 */
export function retime(run: Run | null, target: RetimeTarget, now: number, limit: LimitAction = null): RetimeAction {
  if (!run) return { kind: 'refuse', message: NOT_RUNNING_TEXT }
  if (!Number.isFinite(target.until) || target.until - now > MAX_AHEAD_MS) {
    return { kind: 'refuse', message: 'The end can be at most 7 days from now.' }
  }
  const isFinal = run.phase === 'final'
  if (endsForGood(run)) return { kind: 'refuse', message: finishingText(run.finalReason) }
  if (target.until <= now) {
    return { kind: 'refuse', message: 'The new end would be in the past. To hand back now: /autopilot 0 0 stop.' }
  }
  if (target.until - now < MIN_LEAD_MS) {
    return { kind: 'refuse', message: 'The new end must be at least 1 minute ahead. To hand back now: /autopilot 0 0 stop.' }
  }
  const { until, maxRestarts } = target
  if (!isFinal) return { kind: 'set', until, maxRestarts }
  const isRestartsRaised = target.maxRestarts === null || target.maxRestarts > run.restarts
  if (run.finalReason === 'restarts' && !isRestartsRaised) return { kind: 'refuse', message: finishingText('restarts') }

  if (limit?.kind === 'week') {
    return { kind: 'refuse', message: `The weekly token limit is at its stop (${run.weekStop}%); the run cannot continue.` }
  }
  if (limit?.kind === 'five-hour') return { kind: 'revive', phase: 'waiting', waitUntil: limit.waitUntil, until, maxRestarts }
  if (run.waitUntil && run.waitUntil > now) return { kind: 'revive', phase: 'waiting', waitUntil: run.waitUntil, until, maxRestarts }

  return { kind: 'revive', phase: 'running', waitUntil: null, until, maxRestarts }
}

/** A final handoff that more time or restarts cannot undo (anything but a time-out or used-up restarts). */
function endsForGood(run: Run): boolean {
  return run.phase === 'final' && run.finalReason !== 'time' && run.finalReason !== 'restarts'
}

function finishingText(reason: FinalReason | null): string {
  const reasonText = (reason && FINAL_REASON_TEXT[reason]) || 'it is wrapping up'

  return `Autopilot is finishing because ${reasonText}; more time does not change that. Start a new run after it hands back.`
}

/** `HH:MM (HH:MM UTC)` on the clock `offsetMinutes` east of UTC, or `HH:MM UTC` when the offset is unknown. */
export function endClock(until: number, offsetMinutes: number | null): string {
  const utc = new Date(until).toISOString().slice(11, 16)
  if (offsetMinutes === null) return `${utc} UTC`

  return `${new Date(until + offsetMinutes * 60_000).toISOString().slice(11, 16)} (${utc} UTC)`
}

/**
 * The prompt that brings a finished run back to work. `restarts` is given when
 * the run was revived from used-up restarts: the text then names them, not the time.
 */
export function revivePrompt(until: number, offsetMinutes: number | null, restarts?: { used: number; limit: number | null }): string {
  const tail = 'The final handoff is cancelled: do not write it now. Keep working within your role.'
  const when = endClock(until, offsetMinutes)
  if (restarts) {
    return `Autopilot: the person added restarts (now ${restarts.used}/${restarts.limit ?? 'unlimited'}); the run continues until ${when}. ${tail}`
  }

  return `Autopilot: the person extended this run until ${when}. ${tail}`
}

/** Takes `--name value` out of the arguments; a quoted value may hold spaces. */
function takeFlag(text: string, name: string): { value: string | null; rest: string } {
  const pattern = new RegExp(`\\s--${name}\\s+(?:"([^"]*)"|“([^”]*)”|«([^»]*)»|'([^']*)'|(\\S+))`)
  const match = pattern.exec(` ${text}`)
  if (!match) return { value: null, rest: text }
  const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? ''

  return { value, rest: ` ${text}`.replace(match[0], '').trim() }
}

/** Takes every `--name` switch (no value) out of the arguments; whether there was one. */
function takeSwitch(text: string, name: string): { isOn: boolean; rest: string } {
  const pattern = new RegExp(`\\s--${name}(?=\\s|$)`, 'g')
  const rest = ` ${text}`.replace(pattern, '')

  return { isOn: rest.length !== text.length + 1, rest: rest.trim() }
}

function percentFlag(value: string | null, fallback: number, label: string): number | string {
  if (value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1 || number > 100) return `${label} must be a percentage between 1 and 100.`

  return number
}

const ROLE_QUOTES: Record<string, string> = { '"': '"', '“': '”', '«': '»', "'": "'" }

const FLAG_NAMES = ['--goal', '--5h', '--week']
/** Flags that take no value. */
const SWITCH_NAMES = ['--ask-user']
const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char)

/**
 * For each position, whether the text from there to the end is only flag
 * syntax, the same as `^(\s+--(goal|5h|week)\s+(<quoted value>|\S+)|\s+--ask-user(?=\s|$))*\s*$`
 * with the value quoted in any supported style. Read in one pass from the end,
 * each position's answer from one further on, so it stays linear: a regex
 * tried at every closing quote would rescan the tail for each of them.
 */
function flagsOnlyFrom(text: string): Uint8Array {
  const size = text.length
  const isFlagsOnly = new Uint8Array(size + 1)
  const nextSpace = new Int32Array(size + 1)
  const nextNonSpace = new Int32Array(size + 1)
  const nextCloser: Record<string, Int32Array> = {}
  for (const closer of Object.values(ROLE_QUOTES)) nextCloser[closer] = new Int32Array(size + 1).fill(-1)
  isFlagsOnly[size] = 1
  nextSpace[size] = size
  nextNonSpace[size] = size

  for (let at = size - 1; at >= 0; at -= 1) {
    const char = text.charAt(at)
    const isWhitespace = isSpace(char)
    nextSpace[at] = isWhitespace ? at : (nextSpace[at + 1] ?? size)
    nextNonSpace[at] = isWhitespace ? (nextNonSpace[at + 1] ?? size) : at
    for (const [closer, next] of Object.entries(nextCloser)) next[at] = char === closer ? at : (next[at + 1] ?? -1)
    if (!isWhitespace) continue

    const flagAt = nextNonSpace[at] ?? size
    if (flagAt === size) {
      isFlagsOnly[at] = 1
      continue
    }
    // A switch ends at the next space or the end; what follows it decides.
    const switchName = SWITCH_NAMES.find(flag => text.startsWith(flag, flagAt))
    const switchEnd = flagAt + (switchName?.length ?? 0)
    if (switchName && (switchEnd === size || isSpace(text[switchEnd]))) {
      isFlagsOnly[at] = isFlagsOnly[switchEnd] ?? 0
      continue
    }
    const name = FLAG_NAMES.find(flag => text.startsWith(flag, flagAt))
    if (!name || !isSpace(text[flagAt + name.length])) continue
    const valueAt = nextNonSpace[flagAt + name.length] ?? size
    if (valueAt === size) continue

    // A bare word runs to the next space; a quoted value to its closing quote.
    if (isFlagsOnly[nextSpace[valueAt] ?? size]) {
      isFlagsOnly[at] = 1
      continue
    }
    const closer = ROLE_QUOTES[text.charAt(valueAt)]
    const closeAt = closer ? (nextCloser[closer]?.[valueAt + 1] ?? -1) : -1
    if (closeAt !== -1 && isFlagsOnly[closeAt + 1]) isFlagsOnly[at] = 1
  }

  return isFlagsOnly
}

/**
 * Splits a quoted role off the arguments: `head` runs through the role's
 * closing quote, `rest` is what follows, the only place flags are read from.
 * The role closes at the first closing quote after which only flags follow,
 * so a quote or apostrophe inside the role stays in it. null when the role
 * is not quoted.
 */
function splitQuotedRole(text: string): { head: string; rest: string } | null {
  const match = /^(?:until\s+)?\S+\s+\d{1,3}%?\s+(?:\d{1,2}\s+)?(["“«'])/i.exec(text)
  if (!match) return null
  const opener = match[1] ?? ''
  const closer = ROLE_QUOTES[opener] ?? opener
  const isFlagsOnly = flagsOnlyFrom(text)
  for (let closeAt = text.indexOf(closer, match[0].length); closeAt !== -1; closeAt = text.indexOf(closer, closeAt + 1)) {
    if (isFlagsOnly[closeAt + 1]) return { head: text.slice(0, closeAt + 1), rest: text.slice(closeAt + 1) }
  }

  // Unclosed, or no closing quote is followed by flags alone: everything after the opening quote is the role.
  return { head: text, rest: '' }
}

const USAGE =
  'Usage: /autopilot <time | until <clock>> <threshold%> [max restarts] "<role>" [--goal "<condition>"] [--5h 95] [--week 80] [--ask-user]  ·  /autopilot extend [<time>] [--restarts N]  ·  /autopilot shorten [<time>] [--restarts N]  ·  /autopilot until HH:MM  ·  /autopilot 0 0 stop'
const MAX_ECHOED = 40

/** The person's raw text as an error reply shows it: invisible characters out, capped at 40 characters. */
function echoed(raw: string): string {
  const text = raw.replace(INVISIBLE_ALL, '')

  return text.length > MAX_ECHOED ? `${text.slice(0, MAX_ECHOED)}…` : text
}

const CLOCK_TEXT ='Give the end as HH:MM (24-hour) or with am/pm, e.g. until 18:30 or until 6:30pm (local time).'
const RESTARTS_FLAG_TEXT = '--restarts needs a whole number from 1 to 99.'

/**
 * `/autopilot` arguments: nothing (status), `stop` or `0 0 stop`, or
 * `<duration> <threshold%> [max restarts] "<role>"` with optional flags
 * `--goal "<condition>"`, `--5h <%>`, `--week <%>`, `--ask-user`. No max means as many
 * restarts as the time allows.
 */
export function parseCommand(args: string): Command {
  const text = args.trim()
  if (!text) return { kind: 'status' }
  if (/^(0\s+0\s+)?stop$/i.test(text)) return { kind: 'stop' }

  const dashed = /^--(extend|shorten|until)\b\s*(.*)$/i.exec(text)
  if (dashed) {
    const rest = echoed((dashed[2] ?? '').trim())

    return { kind: 'error', message: `Did you mean /autopilot ${dashed[1]?.toLowerCase()}${rest ? ` ${rest}` : ''}?` }
  }
  const retimeMatch = /^(extend|shorten)(?:\s+([\s\S]*))?$/i.exec(text)
  if (retimeMatch) {
    const kind = retimeMatch[1]?.toLowerCase() === 'extend' ? 'extend' : 'shorten'
    const usage = { kind: 'error', message: `Usage: /autopilot ${kind} [<time>] [--restarts N]` } as const
    const restartsFlag = takeFlag(retimeMatch[2] ?? '', 'restarts')
    const rawTime = restartsFlag.rest
    const restarts = restartsFlag.value === null ? 0 : Number(restartsFlag.value)
    if (restartsFlag.value !== null && (!/^\d{1,2}$/.test(restartsFlag.value) || restarts < 1)) {
      return { kind: 'error', message: RESTARTS_FLAG_TEXT }
    }
    if (/\s|^--/.test(rawTime)) return usage
    if (!rawTime && restarts === 0) return usage
    if (!rawTime) return { kind, deltaMs: 0, restarts }

    const deltaMs = parseDuration(rawTime)
    if (deltaMs === null || deltaMs <= 0) {
      return { kind: 'error', message: `Cannot read the time "${echoed(rawTime)}" (try 90m, 2h, 1h30m).` }
    }

    return { kind, deltaMs, restarts }
  }
  if (/^until$/i.test(text)) return { kind: 'error', message: 'Usage: /autopilot until HH:MM' }
  if (/^until\s/i.test(text) && /\s--restarts(?=\s|$)/i.test(text)) {
    return { kind: 'error', message: 'until takes no --restarts; use /autopilot extend --restarts N.' }
  }
  // `until <clock>` alone moves the end; with more after it, it is a start with an end time.
  const untilMatch = /^until\s+(\S+)$/i.exec(text)
  if (untilMatch) {
    const clock = parseClock(untilMatch[1] ?? '')
    if (!clock) return { kind: 'error', message: CLOCK_TEXT }

    return { kind: 'until', ...clock }
  }

  return parseStart(text)
}

/** A start: `<time | until <clock>> <threshold%> [max restarts] "<role>"` with the flags anywhere outside the role. */
function parseStart(args: string): Command {
  let text = args
  // Flags are read only outside a quoted role: a role may not carry its own --goal.
  const quoted = splitQuotedRole(text)
  let flagText = quoted ? quoted.rest : text
  const goalFlag = takeFlag(flagText, 'goal')
  flagText = goalFlag.rest
  const fiveHourFlag = takeFlag(flagText, '5h')
  flagText = fiveHourFlag.rest
  const weekFlag = takeFlag(flagText, 'week')
  flagText = weekFlag.rest
  // After the valued flags, so a quoted --goal holding the word keeps it.
  const askUserFlag = takeSwitch(flagText, 'ask-user')
  flagText = askUserFlag.rest
  text = quoted ? `${quoted.head}${flagText}`.trim() : flagText

  const fiveHourStop = percentFlag(fiveHourFlag.value, DEFAULT_FIVE_HOUR_STOP, '--5h')
  if (typeof fiveHourStop === 'string') return { kind: 'error', message: fiveHourStop }
  const weekStop = percentFlag(weekFlag.value, DEFAULT_WEEK_STOP, '--week')
  if (typeof weekStop === 'string') return { kind: 'error', message: weekStop }
  const goal = goalFlag.value?.trim() || null
  if (goalFlag.value !== null && !goal) return { kind: 'error', message: '--goal needs a condition in quotes.' }

  const match = /^(?:until\s+(\S+)|(?!until\s)(\S+))\s+(\d{1,3})%?\s+(?:(\d{1,2})\s+)?(["'“«][\s\S]+|[^\d\s][\s\S]*)$/i.exec(text)
  if (!match) return { kind: 'error', message: USAGE }
  const [, rawClock, rawDuration = '', rawThreshold = '', rawRestarts, rawRole = ''] = match
  const clock = rawClock === undefined ? null : parseClock(rawClock)
  if (rawClock !== undefined && !clock) return { kind: 'error', message: CLOCK_TEXT }
  const ms = parseDuration(rawDuration)
  if (!clock && (ms === null || ms <= 0)) {
    return { kind: 'error', message: `Cannot read the time "${echoed(rawDuration)}" (try 90m, 2h, 1h30m).` }
  }
  const end: StartCommand['end'] = clock ? { kind: 'clock', ...clock } : { kind: 'duration', ms: ms ?? 0 }
  const threshold = Number(rawThreshold)
  if (threshold < 1 || threshold > 95) return { kind: 'error', message: 'The context threshold must be between 1 and 95 (%).' }
  const role = rawRole.trim().replace(/^["'“«]|["'”»]$/g, '').trim()
  if (role.length < 10) {
    return { kind: 'error', message: 'Give the role in a sentence or more: who the session is and what it is responsible for.' }
  }

  return {
    kind: 'start',
    end,
    threshold,
    maxRestarts: rawRestarts === undefined ? null : Number(rawRestarts),
    role,
    goal,
    fiveHourStop,
    weekStop,
    askUser: askUserFlag.isOn,
  }
}

/**
 * The skills a role names as `/name`, kept only when the session has a
 * command of that name that is not built in (a skill, a plugin's command).
 */
export function namedSkills(role: string, skillNames: readonly string[]): string[] {
  const known = new Set(skillNames)
  const found: string[] = []
  for (const match of role.matchAll(/(?:^|[\s("'“«`])\/([a-z0-9][\w:.-]*)/gi)) {
    const name = trimTrailingPunctuation(match[1] ?? '')
    if (name && known.has(name) && !found.includes(name)) found.push(name)
  }

  return found
}

const TRAILING_PUNCTUATION = '.,;:!?)'

/** Drops trailing `.,;:!?)` in one linear pass (a regex here backtracks on long runs). */
function trimTrailingPunctuation(text: string): string {
  let end = text.length
  while (end > 0 && TRAILING_PUNCTUATION.includes(text.charAt(end - 1))) end -= 1

  return text.slice(0, end)
}

/** Whether another handoff restart is allowed; time alone limits a run with no max. */
export function canRestart(run: Run): boolean {
  return run.maxRestarts === null || run.restarts < run.maxRestarts
}

export function restartsText(run: Run): string {
  return `${run.restarts}/${run.maxRestarts ?? '∞'}`
}

export type LimitAction = { kind: 'week' } | { kind: 'five-hour'; waitUntil: number } | null

/**
 * What the token windows call for: the weekly one past its stop ends the run
 * for good; the 5-hour one past its stop parks it until the window resets.
 */
export function limitAction(run: Run, windows: readonly TokenWindow[], now: number): LimitAction {
  const week = windows.find(window => window.kind === 'seven_day')
  if (week && week.percentUsed >= run.weekStop) return { kind: 'week' }

  const fiveHour = windows.find(window => window.kind === 'five_hour')
  if (!fiveHour || fiveHour.percentUsed < run.fiveHourStop) return null
  const resetsAt = fiveHour.resetsAt ? Date.parse(fiveHour.resetsAt) : Number.NaN

  return {
    kind: 'five-hour',
    waitUntil: Number.isFinite(resetsAt) && resetsAt > now ? resetsAt + RESET_MARGIN_MS : now + UNKNOWN_RESET_WAIT_MS,
  }
}

export type TurnAction = 'continue' | 'wrapup' | 'final' | 'pause' | 'finish' | 'resume-done' | 'none'

/**
 * What to do when a main-loop turn ends, from the run, the context fill, the
 * time, whether the turn called any tool, and the ceiling below auto-compact.
 * The token windows are judged apart (limitAction), before this.
 */
export function afterTurn(
  run: Run,
  now: number,
  percent: number | null,
  calledTools: boolean,
  ceiling = DEFAULT_CEILING,
): TurnAction {
  // The turn that called the restart tool ends before /clear runs: queue nothing,
  // or a prompt could reach the fresh conversation ahead of the resume.
  if (run.phase === 'paused' || run.phase === 'restarting' || run.phase === 'waiting') return 'none'
  // The session declared a wait: no nudge; the next turn that starts wakes it.
  // The context trigger and the limits are checked again on that turn; time is the 30 s clock's.
  if (run.phase === 'awaiting') return 'none'
  // The turn /resume-handoff-doc started: the resume ran; back to work.
  if (run.phase === 'resuming') return 'resume-done'
  // A wrap-up turn ended; the model either called the restart tool or not.
  if (run.phase === 'wrapping') return 'none'
  if (run.phase === 'final') return 'finish'

  if (now >= run.until) return 'final'
  if (percent !== null && percent >= effectiveTrigger(run, ceiling)) return canRestart(run) ? 'wrapup' : 'final'
  if (!calledTools && run.idleTurns + 1 >= MAX_IDLE_TURNS) return 'pause'

  return 'continue'
}

/** Whether a tool result mid-turn should carry the wrap-up instruction now. */
export function wrapMidTurn(
  run: Run,
  now: number,
  percent: number | null,
  ceiling = DEFAULT_CEILING,
): 'wrapup' | 'final' | null {
  // A resume turn often does real work right away: it is watched as well.
  if (run.phase !== 'running' && run.phase !== 'resuming') return null
  if (now >= run.until) return 'final'
  if (percent !== null && percent >= effectiveTrigger(run, ceiling)) return canRestart(run) ? 'wrapup' : 'final'

  return null
}

/** Phases in which the session must be able to end its turn: a goal's Stop hook may not hold it. */
export function shouldDropStopBlock(phase: Phase): boolean {
  return phase === 'wrapping' || phase === 'restarting' || phase === 'final' || phase === 'awaiting'
}

/**
 * Whether autopilot answers AskUserQuestion and marks refused actions as
 * deferred: not while paused or waiting, when the person is in control.
 * A declared wait (awaiting) still counts as away.
 */
export function autoAnswersQuestions(phase: Phase): boolean {
  return phase !== 'paused' && phase !== 'waiting'
}

/** A free-text wait field: invisible characters out, trimmed, capped; empty is null. */
function waitField(value: unknown, name: string, max: number): { value: string | null } | { error: string } {
  if (value === undefined) return { value: null }
  if (typeof value !== 'string') return { error: `${name} must be a string.` }
  const text = value.replace(INVISIBLE_ALL, '').trim().slice(0, max)

  return { value: text || null }
}

/**
 * The wait_for tool's input as a wait starting now: a known reason, optional
 * `from` and `note`, and an optional `timeout` ("30m", "1h") after which
 * autopilot checks once, never later than the run's end.
 */
export function parseWaitInput(
  input: unknown,
  now: number,
  until: number,
): { kind: 'ok'; awaiting: Awaiting } | { kind: 'error'; message: string } {
  if (!input || typeof input !== 'object') return { kind: 'error', message: 'wait_for needs an input object.' }
  const fields = input as Record<string, unknown>
  const reason = WAIT_REASONS.find(known => known === fields.reason)
  if (!reason) return { kind: 'error', message: `reason must be one of: ${WAIT_REASONS.join(', ')}.` }
  const from = waitField(fields.from, 'from', MAX_WAIT_FROM)
  if ('error' in from) return { kind: 'error', message: from.error }
  const note = waitField(fields.note, 'note', MAX_WAIT_NOTE)
  if ('error' in note) return { kind: 'error', message: note.error }

  let timeoutAt: number | null = null
  if (fields.timeout !== undefined) {
    if (typeof fields.timeout !== 'string') return { kind: 'error', message: 'timeout must be a string such as "30m" or "1h".' }
    const ms = parseDuration(fields.timeout.trim())
    if (ms === null || ms <= 0) return { kind: 'error', message: `Cannot read the timeout ${quoteValue(fields.timeout)} (try 30m, 1h, 1h30m).` }
    timeoutAt = Math.min(now + ms, until)
  }

  return { kind: 'ok', awaiting: { reason, from: from.value, note: note.value, since: now, timeoutAt, pinged: false } }
}

/** Whether a main-loop tool call ends a declared wait: any tool but the wait tool itself means the session went on working. */
export function endsWait(phase: Phase, tool: string): boolean {
  return phase === 'awaiting' && tool !== FULL_WAIT_TOOL
}

/**
 * Why wait_for is refused in this phase, or null when allowed: while running,
 * and again while awaiting (a repeat replaces the wait).
 */
export function waitPhaseRefusal(phase: Phase): string | null {
  if (phase === 'running' || phase === 'awaiting') return null
  if (phase === 'resuming') {
    return `Autopilot is finishing the resume from the handoff: end this turn normally; you can call ${WAIT_TOOL} in the next turn.`
  }

  return 'Autopilot is not driving right now: no wait needed.'
}

const PERSON_REASONS: readonly WaitReason[] = ['user-answer', 'user-input']

/**
 * Why a wait is refused, or null when allowed. Waiting for the person needs
 * --ask-user, and then the question or action as its note.
 */
export function waitRefusal(awaiting: Awaiting, askUser: boolean): string | null {
  if (!PERSON_REASONS.includes(awaiting.reason)) return null
  if (!askUser) {
    return 'This run does not wait for the person (no --ask-user): decide yourself, or send one PushNotification and continue with other work.'
  }
  if (!awaiting.note) return `A wait for ${awaiting.reason} needs the question or the action for the person as its note.`

  return null
}

/** The wait as one short line: reason, who from, how long, the note. */
export function waitText(awaiting: Awaiting, now: number): string {
  return [
    awaiting.reason,
    ...(awaiting.from ? [` ← ${quoteValue(awaiting.from)}`] : []),
    ` · ${formatLeft(now - awaiting.since)}`,
    ...(awaiting.note ? [` — ${quoteValue(awaiting.note)}`] : []),
  ].join('')
}

/** The one check autopilot sends when a declared wait runs past its timeout. */
export function waitTimeoutPrompt(awaiting: Awaiting, now: number): string {
  const from = awaiting.from ? ` from ${quoteValue(awaiting.from)}` : ''
  const note = awaiting.note ? ` (${quoteValue(awaiting.note)})` : ''

  return `Autopilot: you have waited ${formatLeft(now - awaiting.since)} for ${awaiting.reason}${from}${note}. Check whether it arrived or is stuck; escalate within your role if needed (PushNotification for the person), then continue or call ${WAIT_TOOL} again.`
}

function parseRow(line: string): Record<string, unknown> | null {
  try {
    const row: unknown = JSON.parse(line)
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null

    return row as Record<string, unknown>
  } catch {
    // A malformed line: skip it.
    return null
  }
}

export type GoalVerdict = { met: boolean; condition: string }

/**
 * The goal evaluator's verdicts from whole transcript lines. The engine writes
 * each as a top-level attachment row (`{"type":"attachment","attachment":
 * {"type":"goal_status","met":…,"condition":…}}`); a verdict anywhere else (a
 * tool input, message text) is not the engine's and is ignored.
 */
export function goalVerdictsFromRows(lines: readonly string[]): GoalVerdict[] {
  const verdicts: GoalVerdict[] = []
  for (const line of lines) {
    const row = parseRow(line)
    if (!row || row.type !== 'attachment') continue
    const attachment = row.attachment as Record<string, unknown> | null | undefined
    if (!attachment || typeof attachment !== 'object' || attachment.type !== 'goal_status') continue
    if (typeof attachment.met !== 'boolean' || typeof attachment.condition !== 'string') continue
    verdicts.push({ met: attachment.met, condition: attachment.condition })
  }

  return verdicts
}

/** The last verdict for this condition decides. None yet, or not met, is still active. */
export function goalState(verdicts: readonly GoalVerdict[], condition: string): 'achieved' | 'active' {
  const matching = verdicts.filter(verdict => verdict.condition === condition)
  const last = matching[matching.length - 1]

  return last?.met === true ? 'achieved' : 'active'
}

const IDENTITY_KEYS: Record<string, string> = {
  'custom-title': 'customTitle',
  'agent-name': 'agentName',
  'agent-color': 'agentColor',
}

/** The color names a session can carry (the same keys as agent-fleet's SESSION_COLORS; not imported across mods). */
const SESSION_COLOR_NAMES: Record<string, true> = {
  red: true,
  blue: true,
  green: true,
  yellow: true,
  purple: true,
  orange: true,
  pink: true,
  cyan: true,
}

/** Whether a phase is the one where the run follows the session to its new id: only its own /clear restart. */
export function followsNewSessionId(phase: Phase): boolean {
  return phase === 'restarting'
}

/**
 * The session's name and color from whole transcript lines, only from
 * top-level identity rows, the last of each kind winning: /rename's title,
 * else the agent name.
 */
export function identityFromRows(lines: readonly string[]): { name: string | null; color: string | null } {
  const last: Record<string, string> = {}
  for (const line of lines) {
    const row = parseRow(line)
    const kind = typeof row?.type === 'string' ? row.type : ''
    const key = IDENTITY_KEYS[kind]
    if (!row || !key) continue
    const value = row[key]
    if (typeof value !== 'string' || !value) continue
    if (kind === 'agent-color' && !Object.hasOwn(SESSION_COLOR_NAMES, value)) continue
    last[kind] = value
  }

  return { name: last['custom-title'] ?? last['agent-name'] ?? null, color: last['agent-color'] ?? null }
}

const MAX_SHOWN_VALUE = 80

/**
 * Control and invisible characters: every control (Cc), format (Cf: bidi
 * marks, zero-width, soft hyphen, tag characters) and the line and paragraph
 * separators (Zl, Zp).
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const INVISIBLE_ALL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** Trailing slashes off a path, in one linear pass (a regex backtracks on a long run). */
function trimTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') end--

  return path.slice(0, end)
}

/** A transcript value shown to the model as data: control and invisible characters out, capped, JSON-quoted. */
function quoteValue(value: string): string {
  return JSON.stringify(value.replace(INVISIBLE_ALL, '').slice(0, MAX_SHOWN_VALUE))
}

/**
 * Whether a handoff path the model gave is one autopilot may resume from: a
 * `.md` file under `<root>/thoughts/shared/handoffs/`, relative paths taken
 * against the root, no control characters, no `..` segment.
 */
export function isValidHandoffPath(root: string, path: string): boolean {
  if (!path || INVISIBLE.test(path)) return false
  if (path.split('/').includes('..')) return false
  if (!path.endsWith('.md')) return false
  const handoffs = `${trimTrailingSlashes(root)}/thoughts/shared/handoffs/`
  const absolute = resolveHandoffPath(root, path)

  return absolute.startsWith(handoffs) && absolute.length > handoffs.length
}

/** A handoff path as an absolute one: relative paths are taken against the root. */
export function resolveHandoffPath(root: string, path: string): string {
  if (path.startsWith('/')) return path

  return `${trimTrailingSlashes(root)}/${path}`
}

export function formatLeft(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

function skillsLine(run: Run): string[] {
  if (run.skills.length === 0) return []

  return [
    `- Skills named in your role: ${run.skills.map(name => `/${name}`).join(', ')}. These are skills, not plain text: invoke them with the Skill tool wherever your role calls for them.`,
  ]
}

function identityLines(run: Run): string {
  return [
    `- Role and responsibilities: ${run.role}`,
    ...skillsLine(run),
    ...(run.goal ? [`- Goal (completion condition): ${run.goal}`] : []),
    `- Session name: ${run.name ? quoteValue(run.name) : '(none set)'}`,
    `- Session color: ${run.color ? quoteValue(run.color) : '(none set)'}`,
  ].join('\n')
}

const PAUSED_SECTION =
  '# Autopilot is paused\nThe person is in control. Follow their messages as usual; the autopilot rules do not apply until it resumes.'

const WAITING_SECTION =
  '# Autopilot is waiting\nAutopilot is parked until the 5-hour token window resets, and the person is in control meanwhile. Follow their messages as usual; the autopilot rules do not apply until it resumes.'

/** The system prompt section pinned while a run is on; survives /clear. */
export function roleSection(run: Run, now: number): string {
  // Parked or stalled: the person may be back, and the away rules must not override them.
  if (run.phase === 'paused') return PAUSED_SECTION
  if (run.phase === 'waiting') return WAITING_SECTION

  return [
    '# Autopilot: you are working while the person is away',
    'The person started this run with /autopilot. These lines are their instructions about who you are.',
    identityLines(run),
    `- Time left: ${formatLeft(run.until - now)}; context threshold ${run.threshold}%; restarts used ${restartsText(run)}.`,
    ...(run.handoffPath
      ? [`- Latest handoff: ${JSON.stringify(run.handoffPath)}. If you do not know where you are, read it and continue from there; never start the work over.`]
      : []),
    'Rules while the person is away:',
    '- Ordinary questions: decide yourself within your role, prefer the reversible option, and record the decision (question, options, choice, why) for your handoff.',
    '- Permissions stay exactly as they are. If an action is denied or needs the person (a push, a commit, anything the permission mode blocks), never retry it another way to get around the denial: note it as deferred until the person returns, and continue with other work.',
    ...(run.askUser === true
      ? [
          `- Only when the person is truly required — an irreversible or outward-facing action, missing access or credentials, a decision outside your role, or something that blocks all useful work and that autopilot cannot decide — call PushNotification with the one-line question, then call ${WAIT_TOOL} with reason user-answer (or user-input for an action the person must take) and the question as note, and end your turn. Everything else you decide yourself.`,
        ]
      : [
          '- Only when a question truly cannot wait for the person and blocks all useful work, call the PushNotification tool with a one-line question (under 200 characters), then continue with whatever else you can do.',
        ]),
    `- When you hand work to another session, a subagent, a workflow or a background task${run.askUser === true ? ', or need the person' : ''}, and nothing else useful is left for you: call the ${WAIT_TOOL} tool with the reason (and who from), then end your turn. Do not invent work while waiting and do not poll; any incoming message wakes you. Autopilot will not nudge you meanwhile.`,
    ...(run.phase === 'awaiting' && run.awaiting ? [`- Right now you are waiting: ${waitText(run.awaiting, now)}.`] : []),
    '- You may refine the goal of the next stage. You may never change your purpose, role or responsibilities.',
    '- Ending this session is autopilot\'s call, not yours: never write a handoff or wind down on your own. Autopilot tells you when (context threshold, time, limits) and how. A previous handoff saying a session ended means that session, not this one: keep working.',
  ].join('\n')
}

export function kickoffPrompt(run: Run, now: number): string {
  return [
    `Autopilot is on for ${formatLeft(run.until - now)}. Your role:`,
    run.role,
    ...skillsLine(run),
    ...(run.goal ? [`Goal: ${run.goal}`] : []),
    'Work toward your goal now. Start by stating in two lines what you will do first, then do it.',
  ].join('\n')
}

/** The line a session answers with when everything its role covers is done. */
export const DONE_MARKER = 'AUTOPILOT_DONE'

export const CONTINUE_PROMPT = `Autopilot: keep going toward your goal within your role. If the current stage is done, pick the next most valuable step within your role and do it. Deferred actions wait for the person. If everything your role covers is complete and no valuable step is left, do not invent work: answer with the line ${DONE_MARKER} and a one-line reason. If you are waiting for another session, a subagent, a workflow or the person, call ${WAIT_TOOL} instead of working around it.`

/** Whether a turn's answer declares the role's work complete: the marker opens a line, never mid-sentence. */
export function isDoneAnswer(answer: string): boolean {
  // Spaces and tabs only: `\s` would match line breaks too and backtrack quadratically on blank lines.
  return /^[ \t]*AUTOPILOT_DONE\b/m.test(answer)
}

export function wrapupPrompt(run: Run, percent: number | null): string {
  return [
    `Autopilot: the context has reached the handoff point (${percent ?? run.threshold}%). Finish this session gracefully, before auto-compact:`,
    '1. Stop at the right moment: finish or safely park the step in progress. Start nothing new.',
    '2. Use the /create-handoff-doc skill. Put this block at the very top of the handoff, verbatim, as the initial prompt of the next session, marked as important and not to be ignored:',
    identityLines(run),
    '   Then: the goal of the next stage (you may refine it), what is done, what is next, the decisions you made yourself, and the deferred actions waiting for the person.',
    `3. Call the ${RESTART_TOOL} tool with the path of the handoff document. It clears this session and resumes from the handoff.`,
  ].join('\n')
}

const FINAL_OPENING: Record<FinalReason, (run: Run) => string> = {
  time: () => 'Autopilot: the autonomous time is over. Finish gracefully and hand back to the person:',
  restarts: run => `Autopilot: the restart limit (${restartsText(run)}) is reached. Finish gracefully and hand back to the person:`,
  goal: run => `Autopilot: the goal is achieved (${run.goal ?? ''}). Finish gracefully and hand back to the person:`,
  done: () => 'Autopilot: you reported the work your role covers as complete. Finish gracefully and hand back to the person:',
  week: run =>
    `Autopilot: ABSOLUTE STOP: the weekly token limit has reached ${run.weekStop}% used. Stop all work now and hand back to the person:`,
}

export function finalPrompt(run: Run, reason: FinalReason): string {
  return [
    FINAL_OPENING[reason](run),
    '1. Finish or safely park the step in progress. Start nothing new.',
    '2. Use the /create-handoff-doc skill, with this block at the top, verbatim:',
    identityLines(run),
    '   Then: what is done, what is next, the decisions you made yourself, and the deferred actions waiting for the person.',
    ...(reason === 'week'
      ? [
          `3. Call the PushNotification tool once: "Autopilot stopped: weekly token limit at ${run.weekStop}%. Handoff written, waiting for you."`,
          `4. Do NOT call ${RESTART_TOOL}. End with a short summary for the person.`,
        ]
      : [`3. Do NOT call ${RESTART_TOOL}. End with a short summary for the person.`]),
  ].join('\n')
}

export function waitPrompt(run: Run, waitUntil: number): string {
  return [
    `Autopilot: the 5-hour token window has reached ${run.fiveHourStop}% used. Park now:`,
    '1. Finish or safely park the step in progress so nothing is left half-done. Start nothing new.',
    `2. Write two lines on where you stopped and what comes next, then end your turn. Autopilot resumes you after the window resets (about ${new Date(waitUntil).toISOString().slice(11, 16)} UTC). No handoff, no restart.`,
  ].join('\n')
}

export const RESUME_AFTER_WAIT_PROMPT =
  'Autopilot: the 5-hour token window has reset. Continue from where you parked, within your role.'

/** The answer an AskUserQuestion gets while the person is away. */
export const ASK_ANSWER =
  'The person is away (autopilot). Decide this yourself within your role, prefer the reversible option, record the decision for the handoff, and continue. If it truly cannot wait and blocks all useful work, send one PushNotification with the question and continue with other work.'

/** The AskUserQuestion answer for this run: with --ask-user it points to the critical-only wait. */
export function askAnswer(askUser: boolean): string {
  if (!askUser) return ASK_ANSWER

  return `${ASK_ANSWER} If the person is truly required (see your rules), use PushNotification and ${WAIT_TOOL} user-answer instead of asking here.`
}

/** What the model reads after an action the permission mode refused. */
export const DEFERRED_NOTE =
  'Autopilot: this action was refused by the permission mode. Do not try to get around it. It is logged as deferred until the person returns; put it in your handoff and continue with other work.'
