// What can the current credential actually reach?
// The scope granted at login was: offline_access Tasks.ReadWrite User.Read
import { graphGet, loadAuth } from './graph.mjs'

const auth = loadAuth()
console.log('granted scope:', auth.scope)
console.log('')

const probes = [
  ['Tasks (already working)', '/me/todo/lists?$top=1'],
  ['Calendar events', '/me/events?$top=1'],
  ['Calendar view (today)', '/me/calendarView?startDateTime=2026-10-01T00:00:00&endDateTime=2026-10-02T00:00:00'],
  ['Mailbox settings (working hours, timezone)', '/me/mailboxSettings'],
  ['Calendars collection', '/me/calendars'],
]

for (const [label, url] of probes) {
  try {
    const res = await graphGet(url)
    const n = Array.isArray(res.value) ? ` (${res.value.length} items)` : ''
    console.log(`  OK    ${label}${n}`)
  } catch (e) {
    const code =
      (e.body && e.body.error && e.body.error.code) || ''
    console.log(`  FAIL  ${label} -> ${e.status} ${code} ${String(e.message).slice(0, 90)}`)
  }
}
