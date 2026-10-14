// Daily secretary: gather one day's context, then apply a plan.
//
//   node day.mjs context [--date YYYY-MM-DD] [--away]
//   node day.mjs materialize <plan.json>
//
// The judgement lives with the model, not here. This file only collects inputs
// and writes what it is told; it never invents a schedule on its own.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadState, saveState, graphDelete, isLoggedIn } from './graph.mjs'
import { shape, localMinute, tzOf, allLists, liveTasks } from './todo.mjs'
import { eventsBetween, workingHours, createBlock, deleteEvent, shapeEvent, MARKER } from './calendar.mjs'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n) {
  return String(n).padStart(2, '0')
}
function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function wall(dateStr, hhmm) {
  return `${dateStr}T${hhmm.length === 5 ? hhmm + ':00' : hhmm}`
}
function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return WEEKDAYS[new Date(y, m - 1, d).getDay()]
}

// Estimates are keyed by the title with its "[project] " prefix stripped, so
// they survive a project being rebuilt with a new goal (new task ids).
// The title without its "[project] " prefix, case intact: this is what a human
// reads.
export function displayLabel(title) {
  return String(title)
    .trim()
    .replace(/^\[[^\]]*\]\s*/, '')
    .trim()
}

// The same thing lowercased, for matching tasks to remembered estimates.
// Mixing the two up is how `准备上课的PPT` once got reported as
// `准备上课的ppt` — which reads exactly like the user renamed it.
export function normalizeKey(title) {
  return displayLabel(title).toLowerCase()
}

// Graph wants Windows timezone names; the machine reports IANA ones. The
// Outlook mailbox here reports "Greenwich Standard Time" while the machine is
// Asia/Shanghai, so the mailbox setting is NOT a reliable source — the machine
// is, because that is where the user actually is.
const IANA_TO_WINDOWS = {
  'Asia/Shanghai': 'China Standard Time',
  'Asia/Chongqing': 'China Standard Time',
  'Asia/Harbin': 'China Standard Time',
  'Asia/Hong_Kong': 'China Standard Time',
  'Asia/Macau': 'China Standard Time',
  'Asia/Taipei': 'Taipei Standard Time',
  'Asia/Tokyo': 'Tokyo Standard Time',
  'Asia/Seoul': 'Korea Standard Time',
  'Asia/Singapore': 'Singapore Standard Time',
  'Asia/Bangkok': 'SE Asia Standard Time',
  'Asia/Kolkata': 'India Standard Time',
  'Asia/Dubai': 'Arabian Standard Time',
  'Europe/London': 'GMT Standard Time',
  'Europe/Paris': 'W. Europe Standard Time',
  'Europe/Berlin': 'W. Europe Standard Time',
  'Europe/Moscow': 'Russian Standard Time',
  'America/New_York': 'Eastern Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Los_Angeles': 'Pacific Standard Time',
  'Australia/Sydney': 'AUS Eastern Standard Time',
  UTC: 'UTC',
  'Etc/UTC': 'UTC',
}

export function machineTimeZone() {
  const iana = Intl.DateTimeFormat().resolvedOptions().timeZone
  return { iana, windows: IANA_TO_WINDOWS[iana] || null }
}

// Keep the scheduling zone following the machine, unless the user pinned one
// deliberately (a manual `timeZone` with no detection marker).
export function syncTimeZone(state) {
  const { iana, windows } = machineTimeZone()
  const pinned = state.timeZone && !state.timeZoneDetectedFrom
  if (pinned || !windows) {
    return { changed: false, current: state.timeZone, iana, mapped: Boolean(windows), pinned: Boolean(pinned) }
  }
  if (state.timeZone === windows) return { changed: false, current: windows, iana, mapped: true }
  const from = state.timeZone
  state.timeZone = windows
  state.timeZoneDetectedFrom = iana
  return { changed: true, from, to: windows, iana }
}

function localDayBoundsUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return {
    startIso: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
    endIso: new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString(),
  }
}

function out(v) {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n')
}
function fail(msg, extra) {
  out({ ok: false, error: msg, ...(extra || {}) })
  process.exit(1)
}
function argOf(args, flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

// ---------- gathering ----------

// Every open task DSH tracks, across all projects, with its deadline pressure.
async function openTasks(state) {
  const rows = []
  for (const [project, entry] of Object.entries(state.projects || {})) {
    const tracked = new Set(Object.keys(entry.tasks || {}))
    let live = []
    try {
      live = await liveTasks(entry.listId)
    } catch (e) {
      rows.push({ project, error: String((e && e.message) || e) })
      continue
    }
    for (const t of live) {
      if (!tracked.has(t.id) || t.status === 'completed') continue
      const s = shape(t)
      const est = state.estimates && state.estimates[normalizeKey(s.title)]
      rows.push({
        id: t.id,
        project,
        listId: entry.listId,
        title: s.title,
        label: displayLabel(s.title),
        due: s.due,
        reminder: s.reminder,
        importance: t.importance || 'normal',
        estimateMinutes: est ? est.minutes : null,
        estimateSource: est ? est.source : null,
      })
    }
  }
  return rows
}

async function context(dateStr, away) {
  const state = loadState()
  const tzSync = syncTimeZone(state)
  if (tzSync.changed) saveState(state)
  const tz = tzOf(state)
  const wh = await workingHours()
  const { startIso, endIso } = localDayBoundsUtc(dateStr)

  let events = []
  let calendarError = null
  try {
    events = (await eventsBetween(startIso, endIso)).map(shapeEvent)
  } catch (e) {
    calendarError = String((e && e.message) || e)
  }
  const timed = events.filter((e) => !e.allDay && !e.isCancelled)
  const busy = timed
    .filter((e) => e.showAs !== 'free' && e.start && e.end)
    .map((e) => ({
      subject: e.subject,
      from: localMinute({ dateTime: e.start, timeZone: e.startTz }),
      to: localMinute({ dateTime: e.end, timeZone: e.startTz }),
      createdByDsh: e.createdByDsh,
    }))
    .sort((a, b) => String(a.from).localeCompare(String(b.from)))

  const tasks = await openTasks(state)
  const now = new Date()
  for (const t of tasks) {
    if (!t.due) continue
    t.daysLeft = Math.round(
      (Date.parse(t.due + 'T00:00:00') - Date.parse(todayKey(now) + 'T00:00:00')) / 86400000,
    )
    t.overdue = t.daysLeft < 0
    t.dueToday = t.daysLeft === 0
  }

  return {
    ok: true,
    date: dateStr,
    weekday: weekdayOf(dateStr),
    now: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    away,
    timeZone: tz,
    timeZoneSync: tzSync,
    // The user has no fixed working days or hours (stated directly). Outlook's
    // Mon-Fri 08:00-17:00 is just its default and must not drive scheduling.
    noFixedSchedule: Boolean(state.noFixedSchedule),
    workingHours: wh,
    planningNotes: [
      ...(state.noFixedSchedule
        ? [
            '用户没有固定的工作日和工作时间。不要用 Outlook 的 08:00–17:00 排程。',
            '当天可支配时间由用户报的「上线」和「休息」两个信号决定，不是由工作时段决定。',
          ]
        : []),
      ...(calendarError ? [`日历读取失败：${calendarError}，不要把"没有会议"当成已知事实。`] : []),
      ...(events.length === 0
        ? ['日历是空的：把它当作输出（把安排写进去），而不是输入（没有会议需要避开）。']
        : []),
    ],
    calendar: {
      error: calendarError,
      eventCount: events.length,
      empty: events.length === 0,
      events,
      busy,
      allDay: events.filter((e) => e.allDay).map((e) => e.subject),
    },
    openTasks: tasks,
    estimates: state.estimates || {},
    todayPlan: (state.days && state.days[dateStr]) || null,
  }
}

// ---------- applying a plan ----------

async function clearOwnCalendarBlocks(dateStr, dryRun) {
  const { startIso, endIso } = localDayBoundsUtc(dateStr)
  let events = []
  try {
    events = await eventsBetween(startIso, endIso)
  } catch {
    return { removed: 0, skipped: true }
  }
  const mine = events.filter(
    (e) => e.bodyPreview && e.bodyPreview.includes(MARKER) && !e.isCancelled,
  )
  if (!dryRun) {
    for (const e of mine) await deleteEvent(e.id)
  }
  return { removed: mine.length, skipped: false }
}

async function materialize(planPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8').replace(/^\uFEFF/, ''))
  const state = loadState()
  const tz = tzOf(state)
  const dateStr = plan.date || todayKey()
  const dryRun = process.argv.includes('--dry-run')
  state.days = state.days || {}
  state.estimates = state.estimates || {}

  // Learn the estimates the model supplied so they stay stable next time.
  for (const [key, minutes] of Object.entries(plan.estimates || {})) {
    const k = normalizeKey(key)
    const prev = state.estimates[k]
    state.estimates[k] = {
      minutes,
      source: prev && prev.source === 'user' ? 'user' : 'guessed',
      updatedAt: new Date().toISOString(),
    }
  }

  const previous = state.days[dateStr]
  const report = { removedAgendaTasks: 0, removedCalendarBlocks: 0, calendarBlocks: [], errors: [] }

  // 1. Retire this day's previous plan (ours only).
  if (previous && previous.agendaTaskId && previous.agendaListId && !dryRun) {
    try {
      await graphDelete(`/me/todo/lists/${previous.agendaListId}/tasks/${previous.agendaTaskId}`)
      report.removedAgendaTasks++
    } catch (e) {
      report.errors.push('delete old agenda task: ' + String((e && e.message) || e))
    }
  }
  const cal = await clearOwnCalendarBlocks(dateStr, dryRun)
  if (cal.skipped) report.errors.push('could not read calendar to clear old blocks')
  report.removedCalendarBlocks = cal.removed

  // 2. The plan lives on the calendar, not in To Do.
  //
  // It used to be a "今日安排" task in the default list — narrative in the body,
  // one checklist item per block — with a reminder written onto each task at its
  // block start. Two things were wrong with that:
  //
  //   - In Microsoft To Do, completing a task and dismissing its reminder are
  //     the same tap, so a "start now" nudge attached to a task invites
  //     finishing it by accident. On 2026-10-01 a two-hour block was ticked 8.9
  //     seconds after its reminder fired.
  //   - The nudge overwrote the task's own deadline reminder, which is the one
  //     reminder a task should own.
  //
  // The calendar is the right surface for both, so the agenda task is gone and
  // the block events carry the nudge (see step 4). Step 1 still retires the
  // previous run's agenda task, so older ones get cleaned up.

  // 4. The time blocks, now the only surface the day lives on.
  //
  // Every block becomes an event so that every block can remind you when it
  // starts. Quick blocks used to be skipped as too small to be worth a calendar
  // entry, but with the task reminder gone that would leave them with no nudge
  // at all. Set `"calendar": false` on a block to opt it out explicitly.
  if (plan.writeCalendar !== false) {
    for (const b of plan.blocks || []) {
      if (b.calendar === false) continue
      if (dryRun) {
        report.calendarBlocks.push({ subject: b.label, from: b.start, to: b.end, dryRun: true })
        continue
      }
      try {
        const ev = await createBlock({
          subject: b.label || b.title || '专注时段',
          startWall: wall(dateStr, b.start),
          endWall: wall(dateStr, b.end),
          timeZone: tz,
          body: (b.reason ? b.reason + '\n' : '') + (plan.narrative || ''),
        })
        report.calendarBlocks.push({
          id: ev.id,
          subject: ev.subject,
          from: b.start,
          to: b.end,
          remindsAtStart: ev.isReminderOn === true,
        })
      } catch (e) {
        report.errors.push(`calendar block ${b.label}: ` + String((e && e.message) || e))
      }
    }
  }

  if (!dryRun) {
    state.days[dateStr] = {
      away: Boolean(plan.away),
      openedAt: new Date().toISOString(),
      // No agenda task and no agenda list any more — the plan is the calendar
      // blocks below. Section 1 still reads the old fields off a previous
      // record, so a day planned before this change is cleaned up on re-plan.
      blocks: plan.blocks || [],
      unscheduled: plan.unscheduled || [],
      narrative: plan.narrative || '',
    }
    saveState(state)
  }

  return { ok: true, date: dateStr, dryRun, ...report }
}

// ---------- main ----------

export async function main(argv) {
  const [command, ...args] = argv
  if (!isLoggedIn()) fail('NOT_LOGGED_IN: run `node login.mjs` once to authorize')
  try {
    if (command === 'context') {
      const dateStr = argOf(args, '--date') || todayKey()
      out(await context(dateStr, args.includes('--away')))
    } else if (command === 'materialize') {
      const planPath = args.find((a) => !a.startsWith('--'))
      if (!planPath) fail('USAGE: materialize <plan.json>')
      out(await materialize(planPath))
    } else {
      fail('UNKNOWN_COMMAND: ' + String(command))
    }
  } catch (e) {
    fail(String((e && e.message) || e), e && e.body ? { detail: e.body } : undefined)
  }
}

// Guarded so the module can be imported by tests without running the CLI.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) await main(process.argv.slice(2))
