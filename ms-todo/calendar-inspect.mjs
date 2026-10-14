// Inspect the calendars and any existing events, to decide whether the
// calendar is a real input or effectively empty.
import { graphGet } from './graph.mjs'
import { shapeEvent } from './calendar.mjs'

const cals = await graphGet('/me/calendars')
console.log('calendars:')
for (const c of cals.value || []) {
  console.log(
    `  - ${c.name}  default=${c.isDefaultCalendar}  canEdit=${c.canEdit}  ` +
      `owner=${c.owner && c.owner.address}`,
  )
}

const now = new Date()
const from = new Date(now.getTime() - 7 * 86400000).toISOString()
const to = new Date(now.getTime() + 30 * 86400000).toISOString()
const res = await graphGet(
  `/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}`,
)
const events = (res.value || []).map(shapeEvent)
console.log(`\nevents within -7d..+30d: ${events.length}`)
for (const e of events) {
  console.log(
    `  - ${e.subject}\n    start=${e.start} tz=${e.startTz} allDay=${e.allDay} ` +
      `showAs=${e.showAs} cancelled=${e.isCancelled} dsh=${e.createdByDsh}`,
  )
}
