// Unit tests for the pure policy helpers in todo.mjs.
// Run: node test.mjs
import { reminderFor, taskTitle, stamp, shape, diffSnapshots, localDay, localMinute, validatePlan } from './todo.mjs'
import { normalizeKey, displayLabel, syncTimeZone, machineTimeZone } from './day.mjs'

let passed = 0
const failures = []

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
  } else {
    failures.push(`${name}\n     actual:   ${a}\n     expected: ${e}`)
  }
}

const TZ = 'China Standard Time'
// Explicit offsets: the policy reads wall-clock time in the host's own zone,
// so the fixtures must not depend on where this test happens to run.
const MORNING = Date.parse('2026-03-10T02:00:00+08:00')
const LATE = Date.parse('2026-03-10T10:00:00+08:00')

// --- reminder policy -------------------------------------------------------

check(
  'far deadline -> morning of the day before',
  reminderFor('2026-03-20', undefined, TZ, MORNING),
  { dateTime: '2026-03-19T09:00:00', timeZone: TZ },
)

check(
  'deadline tomorrow -> today 09:00 (the day before)',
  reminderFor('2026-03-11', undefined, TZ, MORNING),
  { dateTime: '2026-03-10T09:00:00', timeZone: TZ },
)

check(
  'deadline today, still before 09:00 -> today 09:00',
  reminderFor('2026-03-10', undefined, TZ, MORNING),
  { dateTime: '2026-03-10T09:00:00', timeZone: TZ },
)

check(
  'deadline already passed today -> now + 15 min',
  reminderFor('2026-03-10', undefined, TZ, LATE),
  { dateTime: '2026-03-10T02:15:00', timeZone: 'UTC' },
)

check(
  'explicit reminder always wins',
  reminderFor('2026-03-20', '2026-03-18T20:00:00', TZ, MORNING),
  { dateTime: '2026-03-18T20:00:00', timeZone: TZ },
)

check('no deadline -> no reminder', reminderFor(undefined, undefined, TZ, MORNING), undefined)

check(
  'explicit reminder without a deadline still applies',
  reminderFor(undefined, '2026-03-18T08:30', TZ, MORNING),
  { dateTime: '2026-03-18T08:30:00', timeZone: TZ },
)

// --- stamping --------------------------------------------------------------

check('date-only due becomes local midnight', stamp('2026-03-20', TZ), {
  dateTime: '2026-03-20T00:00:00',
  timeZone: TZ,
})

check('minute-precision input is padded to seconds', stamp('2026-03-20T08:30', TZ), {
  dateTime: '2026-03-20T08:30:00',
  timeZone: TZ,
})

check('full timestamp passes through', stamp('2026-03-20T08:30:15', TZ), {
  dateTime: '2026-03-20T08:30:15',
  timeZone: TZ,
})

// --- title convention ------------------------------------------------------

check('default mode prefixes the project', taskTitle('官网改版', '完成首页视觉稿', 'default'), '[官网改版] 完成首页视觉稿')
check('milestone mode leaves the title bare', taskTitle('官网改版', '完成首页视觉稿', 'milestone'), '完成首页视觉稿')

// --- reading back what the real service returns ----------------------------
//
// The live service does NOT echo the timeZone we send: it stores the instant
// and returns it UTC-normalized (observed 2026-10-01 via probe.mjs). Slicing
// that string directly reads every date back 8 hours — and often a whole day —
// early.
check(
  'host zone is UTC+8, which the China Standard Time default assumes',
  -new Date().getTimezoneOffset(),
  480,
)

check(
  'a UTC-normalized due instant reads back as the intended local day',
  localDay({ dateTime: '2026-10-03T16:00:00.0000000', timeZone: 'UTC' }),
  '2026-10-04',
)

check(
  'a UTC-normalized reminder reads back as the intended local minute',
  localMinute({ dateTime: '2026-10-03T01:00:00.0000000', timeZone: 'UTC' }),
  '2026-10-03T09:00',
)

check(
  'a UTC instant already carrying Z is converted too',
  localDay({ dateTime: '2026-10-03T16:00:00Z', timeZone: 'UTC' }),
  '2026-10-04',
)

check(
  'a wall clock in our own zone is taken at face value, not shifted',
  localMinute({ dateTime: '2026-10-04T00:00:00.0000000', timeZone: TZ }),
  '2026-10-04T00:00',
)

check(
  'a task with no due date reads back as null, not an error',
  localDay(null),
  null,
)

// --- shaping ---------------------------------------------------------------

check(
  'shape extracts the tracked leaf fields',
  shape({
    title: 't',
    status: 'notStarted',
    dueDateTime: { dateTime: '2026-03-20T00:00:00.0000000', timeZone: TZ },
    reminderDateTime: { dateTime: '2026-03-19T09:00:00.0000000', timeZone: TZ },
    isReminderOn: true,
    completedDateTime: null,
    lastModifiedDateTime: '2026-03-01T00:00:00Z',
  }),
  {
    title: 't',
    status: 'notStarted',
    due: '2026-03-20',
    reminder: '2026-03-19T09:00',
    reminderOn: true,
    completed: null,
    modified: '2026-03-01T00:00:00Z',
  },
)

// --- change detection ------------------------------------------------------

const before = {
  a: { project: 'P', title: 'A', status: 'notStarted', due: '2026-03-20', reminder: '2026-03-19T09:00', reminderOn: true, completed: null },
  b: { project: 'P', title: 'B', status: 'notStarted', due: '2026-03-21', reminder: null, reminderOn: false, completed: null },
  c: { project: 'P', title: 'C', status: 'notStarted', due: null, reminder: null, reminderOn: false, completed: null },
  d: { project: 'P', title: 'D', status: 'notStarted', due: null, reminder: null, reminderOn: false, completed: null },
  f: { project: 'P', title: 'F', status: 'notStarted', due: null, reminder: '2026-03-19T09:00', reminderOn: true, completed: null },
}

const after = {
  a: { project: 'P', title: 'A', status: 'completed', due: '2026-03-20', reminder: '2026-03-19T09:00', reminderOn: true, completed: '2026-03-12T10:00:00Z' },
  b: { project: 'P', title: 'B 改名了', status: 'notStarted', due: '2026-03-25', reminder: null, reminderOn: false, completed: null },
  c: { project: 'P', title: 'C', status: 'notStarted', due: null, reminder: null, reminderOn: false, completed: null },
  e: { project: 'P', title: 'E', status: 'notStarted', due: '2026-04-01', reminder: null, reminderOn: false, completed: null },
  f: { project: 'P', title: 'F', status: 'notStarted', due: null, reminder: '2026-03-19T09:00', reminderOn: false, completed: null },
}

const changes = diffSnapshots(before, after)
const kinds = changes.map((c) => `${c.id}:${c.change}`).sort()

check(
  'diffSnapshots reports completion, rename, reschedule, reminder toggle, creation and deletion',
  kinds,
  ['a:completed', 'b:due-changed', 'b:renamed', 'd:deleted', 'e:created', 'f:reminder-toggled'],
)

check('an untouched task produces no change', changes.some((c) => c.id === 'c'), false)

check(
  'completion carries the timestamp and target status',
  changes.find((c) => c.id === 'a'),
  {
    id: 'a',
    change: 'completed',
    title: 'A',
    project: 'P',
    from: 'notStarted',
    to: 'completed',
    completedAt: '2026-03-12T10:00:00Z',
  },
)

check('no difference -> no changes', diffSnapshots(before, before), [])

// --- estimate keys and schedule timezone (day planner) ---------------------

check('estimate key drops the project prefix', normalizeKey('[官网改版] 完成首页视觉稿'), '完成首页视觉稿')
check('estimate key is case- and space-insensitive', normalizeKey('  [X]  Fix   the BUG '), 'fix   the bug')
check('estimate key survives an untagged title', normalizeKey('写周报'), '写周报')

// The label is for humans, so it must NOT be lowercased. Getting this wrong
// once made '准备上课的PPT' print as '准备上课的ppt', which reads exactly like
// the user had renamed the task.
check('display label drops the prefix but keeps case', displayLabel('[深职院授课] 准备上课的PPT'), '准备上课的PPT')
check('display label trims an untagged title', displayLabel('  写周报  '), '写周报')
check(
  'normalizeKey is the lowercased display label',
  normalizeKey('[深职院授课] 准备上课的PPT'),
  displayLabel('[深职院授课] 准备上课的PPT').toLowerCase(),
)

check(
  'the machine zone maps to a Windows zone name for Graph',
  machineTimeZone().windows,
  'China Standard Time',
)

const detected = syncTimeZone({})
check('an unpinned zone is auto-detected from the machine', detected.to, 'China Standard Time')
check('auto-detection records where it came from', detected.iana, 'Asia/Shanghai')

const pinnedState = { timeZone: 'Tokyo Standard Time' }
check(
  'a deliberately pinned zone is never overwritten',
  syncTimeZone(pinnedState).changed,
  false,
)
check('the pinned zone survives', pinnedState.timeZone, 'Tokyo Standard Time')

const already = { timeZone: 'China Standard Time', timeZoneDetectedFrom: 'Asia/Shanghai' }
check('a previously detected zone needs no rewrite', syncTimeZone(already).changed, false)

// --- plan provenance gate (anti-invention) ---------------------------------
//
// On 2026-10-01 the user was told eight things and handed 24 tasks: the
// assistant had designed four projects, complete with steps and deadlines the
// user never mentioned. The fix for that is not a request to behave - it is
// apply refusing the plan. These lock in the three rules.

const mentions = (problems, re) => problems.some((p) => re.test(p))

check(
  'a fully sourced, derived deadline passes',
  validatePlan({
    project: '数控机床改造',
    tasks: [
      {
        title: '确定方案',
        source: '用户说：最终 DDL 十一月十五，要提前一个月确定方案。',
        due: '2026-10-15',
        dueBasis: 'derived',
        dueFrom: '用户给的 11/15 提前一个月 -> 10/15',
      },
    ],
  }),
  [],
)

check(
  'a stated deadline passes',
  validatePlan({
    project: 'P',
    tasks: [{ title: 't', source: '用户说：10月8日上课。', due: '2026-10-08', dueBasis: 'stated' }],
  }),
  [],
)

check(
  'an undated task needs nothing more',
  validatePlan({ project: 'P', tasks: [{ title: 't', source: '用户说：t。' }] }),
  [],
)

check('a non-object plan is rejected', validatePlan(null).length > 0, true)
check('a missing project is reported', mentions(validatePlan({ tasks: [] }), /plan\.project/), true)
check(
  'tasks must be an array',
  mentions(validatePlan({ project: 'P', tasks: {} }), /tasks must be an array/),
  true,
)

check(
  'a task with no source is rejected',
  mentions(validatePlan({ project: 'P', tasks: [{ title: '凭空想出来的活' }] }), /source/),
  true,
)

check(
  'a whitespace-only source is rejected',
  mentions(validatePlan({ project: 'P', tasks: [{ title: 't', source: '   ' }] }), /source/),
  true,
)

check(
  'a missing title is reported',
  mentions(validatePlan({ project: 'P', tasks: [{ source: 's' }] }), /title is required/),
  true,
)

check(
  'steps are rejected unless the user supplied them',
  mentions(validatePlan({ project: 'P', tasks: [{ title: 't', source: 's', steps: ['第一步'] }] }), /stepsFromUser/),
  true,
)

check(
  'steps pass once the plan declares they came from the user',
  validatePlan({ project: 'P', stepsFromUser: true, tasks: [{ title: 't', source: 's', steps: ['第一步'] }] }),
  [],
)

check(
  'an empty steps array is not decomposition',
  validatePlan({ project: 'P', tasks: [{ title: 't', source: 's', steps: [] }] }),
  [],
)

check(
  'a deadline with no dueBasis is rejected',
  mentions(validatePlan({ project: 'P', tasks: [{ title: 't', source: 's', due: '2026-10-08' }] }), /dueBasis/),
  true,
)

check(
  'an unrecognised dueBasis is rejected',
  mentions(
    validatePlan({ project: 'P', tasks: [{ title: 't', source: 's', due: '2026-10-08', dueBasis: '大概吧' }] }),
    /dueBasis/,
  ),
  true,
)

check(
  'a derived deadline without the arithmetic is rejected',
  mentions(
    validatePlan({ project: 'P', tasks: [{ title: 't', source: 's', due: '2026-10-08', dueBasis: 'derived' }] }),
    /dueFrom/,
  ),
  true,
)

check(
  'the rejection names the offending task',
  mentions(validatePlan({ project: 'P', tasks: [{ title: '出课纲二稿' }] }), /出课纲二稿/),
  true,
)

// The actual regression: the shape of the plan that shipped on 2026-10-01.
const asShippedOn1001 = {
  project: '导轨项目',
  tasks: [
    {
      title: '理解导轨皮带安装现状与上翻需求',
      due: '2026-10-02',
      importance: 'high',
      steps: ['看现有结构图', '确认上翻的原始诉求'],
    },
    { title: '出皮带安装上翻的结构方案草图', due: '2026-10-04' },
  ],
}
const shippedProblems = validatePlan(asShippedOn1001)
check('the plan shipped on 2026-10-01 is now rejected', shippedProblems.length > 0, true)
check(
  'it is rejected for all three reasons',
  [
    mentions(shippedProblems, /source/),
    mentions(shippedProblems, /stepsFromUser/),
    mentions(shippedProblems, /dueBasis/),
  ],
  [true, true, true],
)

// --- report ----------------------------------------------------------------

if (failures.length) {
  console.log(`FAIL ${failures.length} of ${passed + failures.length}`)
  for (const f of failures) console.log('  x ' + f)
  process.exit(1)
}
console.log(`PASS all ${passed} assertions`)
