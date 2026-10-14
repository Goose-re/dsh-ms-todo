// Outlook calendar + mailbox settings.
//
// Needs the scopes: Calendars.ReadWrite, MailboxSettings.Read.
// Like the tasks API, these endpoints reject $select on some collections, so
// nothing here narrows server-side — full objects are fetched and trimmed
// locally by the callers.
import { graphGet, graphPost, graphDelete, GRAPH_BASE } from './graph.mjs'

// Marks calendar events DSH created, so a re-plan can replace its own blocks
// without ever touching events the user made.
export const MARKER = '[DSH-PLAN]'

export async function mailboxSettings() {
  return graphGet('/me/mailboxSettings')
}

// Outlook's configured working hours, or a sane default when unset.
// Returns { days: [0..6 Sun..Sat], start: 'HH:mm', end: 'HH:mm', timeZone }.
const DEFAULTS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:30' }

export async function workingHours() {
  try {
    const s = await mailboxSettings()
    const wh = s && s.workingHours
    if (!wh || !wh.startTime || !wh.endTime) {
      return { ...DEFAULTS, timeZone: (s && s.timeZone) || 'China Standard Time', source: 'default' }
    }
    return {
      days: Array.isArray(wh.daysOfWeek) && wh.daysOfWeek.length ? wh.daysOfWeek : DEFAULTS.days,
      start: String(wh.startTime).slice(0, 5),
      end: String(wh.endTime).slice(0, 5),
      timeZone: (s && s.timeZone) || 'China Standard Time',
      source: 'outlook',
    }
  } catch (e) {
    return { ...DEFAULTS, timeZone: 'China Standard Time', source: 'default', error: String(e.message || e) }
  }
}

async function paged(url) {
  const out = []
  let next = url
  let guard = 0
  while (next && guard++ < 30) {
    const res = await graphGet(next)
    if (Array.isArray(res.value)) out.push(...res.value)
    next = res['@odata.nextLink'] ? res['@odata.nextLink'].replace(GRAPH_BASE, '') : null
  }
  return out
}

// Events overlapping [startIso, endIso). calendarView expands recurrences,
// which /me/events does not.
export async function eventsBetween(startIso, endIso) {
  return paged(`/me/calendarView?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endIso)}`)
}

export function shapeEvent(e) {
  const allDay = e.isAllDay === true
  return {
    id: e.id,
    subject: e.subject || '(无标题)',
    allDay,
    start: e.start ? e.start.dateTime : null,
    end: e.end ? e.end.dateTime : null,
    startTz: e.start ? e.start.timeZone : null,
    showAs: e.showAs || null,
    isCancelled: e.isCancelled === true,
    location: e.location && e.location.displayName ? e.location.displayName : null,
    organizer: e.organizer && e.organizer.emailAddress ? e.organizer.emailAddress.name : null,
    // Events DSH created carry this marker so a re-plan can replace them
    // without touching anything the user made.
    createdByDsh: Boolean(e.bodyPreview && e.bodyPreview.includes(MARKER)),
  }
}

// Time blocks carry the day's "start now" nudge, and this is where it belongs.
// In Microsoft To Do, completing a task and dismissing its reminder are the same
// tap, so a nudge attached to a task invites finishing it by accident
// (2026-10-01: a two-hour block was ticked 8.9s after its reminder fired). A
// calendar notification cannot complete anything.
export async function createBlock({
  subject,
  startWall,
  endWall,
  timeZone,
  body,
  remindAtStart = true,
}) {
  return graphPost('/me/events', {
    subject,
    start: { dateTime: startWall, timeZone },
    end: { dateTime: endWall, timeZone },
    body: { contentType: 'text', content: `${MARKER}\n${body || ''}` },
    showAs: 'busy',
    isReminderOn: remindAtStart,
    // Only meaningful while the reminder is on.
    ...(remindAtStart ? { reminderMinutesBeforeStart: 0 } : {}),
  })
}

export async function deleteEvent(id) {
  return graphDelete(`/me/events/${id}`)
}
