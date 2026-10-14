// Verify our request payload shape against Microsoft's own published Graph
// schema, instead of trusting the fake server to agree with us.
//
//   node schema-check.mjs
//
// Fetches the public CSDL metadata (no credentials needed) and checks that
// every property and enum value we send actually exists.
//
// Note: in the CSDL, type names are unprefixed inside the `microsoft.graph`
// schema (`todoTask`, not `microsoft.graph.todoTask`); property *types*
// reference `graph.*`. Delete graph-metadata.xml to refetch after a schema
// change.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CACHE = path.join(HERE, 'graph-metadata.xml')
const METADATA = 'https://graph.microsoft.com/v1.0/$metadata'

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name + (detail ? ' — ' + detail : ''))
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}
function block(xml, kind, name) {
  const m = xml.match(new RegExp(`<${kind} Name="${name}"[^>]*>([\\s\\S]*?)</${kind}>`))
  return m ? m[1] : null
}
const entityBlock = (xml, name) => block(xml, 'EntityType', name)
const complexBlock = (xml, name) => block(xml, 'ComplexType', name)
const propertyNames = (b) => (b ? [...b.matchAll(/<Property Name="([^"]+)"/g)].map((x) => x[1]) : [])
const navigationNames = (b) =>
  b ? [...b.matchAll(/<NavigationProperty Name="([^"]+)"/g)].map((x) => x[1]) : []
function enumValues(xml, name) {
  const b = block(xml, 'EnumType', name)
  return b ? [...b.matchAll(/Member Name="([^"]+)"/g)].map((x) => x[1]) : null
}

let xml
if (fs.existsSync(CACHE)) {
  xml = fs.readFileSync(CACHE, 'utf8')
  console.log(`using cached schema (${CACHE})`)
} else {
  console.log(`fetching ${METADATA} ...`)
  const res = await fetch(METADATA, { signal: AbortSignal.timeout(120000) })
  xml = await res.text()
  if (res.status !== 200) {
    console.log(`could not fetch schema: HTTP ${res.status}`)
    process.exit(1)
  }
  fs.writeFileSync(CACHE, xml, 'utf8')
}
console.log(`schema size: ${xml.length} bytes\n`)

// --- todoTask: every field we put in a create request ---------------------

const todoTask = entityBlock(xml, 'todoTask')
check('EntityType todoTask exists', Boolean(todoTask))
const taskProps = propertyNames(todoTask)
console.log(`  todoTask properties:\n    ${taskProps.join(', ')}\n`)

for (const prop of [
  'title',
  'importance',
  'dueDateTime',
  'reminderDateTime',
  'isReminderOn',
  'body',
  'status',
  'completedDateTime',
]) {
  check(`todoTask.${prop} is a real property`, taskProps.includes(prop), `not in [${taskProps.join(',')}]`)
}
check(
  'todoTask.checklistItems is a navigation property',
  navigationNames(todoTask).includes('checklistItems'),
  `found [${navigationNames(todoTask).join(',')}]`,
)

// --- event: the reminder fields that carry the day's "start now" nudge -----
//
// The nudge moved off the tasks and onto the calendar blocks (a To Do reminder
// on a task invites completing it by accident), so these fields are now
// load-bearing rather than decorative.

const event = entityBlock(xml, 'event')
check('EntityType event exists', Boolean(event))
const eventProps = propertyNames(event)
for (const prop of ['isReminderOn', 'reminderMinutesBeforeStart', 'start', 'end', 'showAs', 'subject']) {
  check(`event.${prop} is a real property`, eventProps.includes(prop), `not in [${eventProps.join(',')}]`)
}

// --- dateTimeTimeZone -----------------------------------------------------

const dttz = propertyNames(complexBlock(xml, 'dateTimeTimeZone'))
console.log(`  dateTimeTimeZone properties: ${dttz.join(', ')}\n`)
check('dateTimeTimeZone.dateTime exists (we send it)', dttz.includes('dateTime'))
check('dateTimeTimeZone.timeZone exists (we send it)', dttz.includes('timeZone'))

// --- enums ----------------------------------------------------------------

const importance = enumValues(xml, 'importance')
console.log(`  importance values: ${importance ? importance.join(', ') : '(not found)'}`)
check('importance enum exists', Boolean(importance))
for (const value of ['low', 'normal', 'high']) {
  check(`importance "${value}" is valid (we send it)`, Boolean(importance && importance.includes(value)))
}

const taskStatus = enumValues(xml, 'taskStatus')
console.log(`  taskStatus values: ${taskStatus ? taskStatus.join(', ') : '(not found)'}\n`)
check('taskStatus enum exists', Boolean(taskStatus))
for (const value of ['notStarted', 'completed']) {
  check(`taskStatus "${value}" is valid (we compare against it)`, Boolean(taskStatus && taskStatus.includes(value)))
}

// --- itemBody -------------------------------------------------------------

const itemBody = propertyNames(complexBlock(xml, 'itemBody'))
console.log(`  itemBody properties: ${itemBody.join(', ')}`)
check('itemBody.content exists (we send it)', itemBody.includes('content'))
check('itemBody.contentType exists (we send it)', itemBody.includes('contentType'))
const bodyTypes = enumValues(xml, 'bodyType')
console.log(`  bodyType values: ${bodyTypes ? bodyTypes.join(', ') : '(not found)'}\n`)
check('we send contentType "text", which is valid', Boolean(bodyTypes && bodyTypes.includes('text')))

// --- checklistItem --------------------------------------------------------

const checklistProps = propertyNames(entityBlock(xml, 'checklistItem'))
console.log(`  checklistItem properties: ${checklistProps.join(', ')}\n`)
check('checklistItem.displayName exists (we send it)', checklistProps.includes('displayName'))

// --- container path -------------------------------------------------------

const listBlock = entityBlock(xml, 'todoTaskList')
check(
  'todoTaskList.tasks is a navigation property to todoTask',
  /<NavigationProperty Name="tasks" Type="Collection\(graph\.todoTask\)"/.test(listBlock || ''),
)

console.log('')
if (failures.length) {
  console.log(`FAIL ${failures.length} / ${passed + failures.length}`)
  for (const f of failures) console.log('  x ' + f)
  process.exit(1)
}
console.log(`PASS all ${passed} schema assertions`)
