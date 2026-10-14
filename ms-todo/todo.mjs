// Microsoft To Do bridge for DSH.
//
//   node todo.mjs lists                     list every To Do list
//   node todo.mjs tasks [listName]          dump live tasks of one list
//   node todo.mjs apply <plan.json>         replace a project's tasks with the plan
//   node todo.mjs status                    diff tracked tasks against live To Do
//   node todo.mjs snapshot                  record live state as the watch baseline
//   node todo.mjs watch [--interval N] [--timeout N]   long-poll; exits on change
//                                                     (defaults: 20s / 14400s)
//   node todo.mjs raw <METHOD> <path> [body]           raw Graph call (debug)
//
// Every command prints JSON on stdout.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DIR,
  GRAPH_BASE,
  loadState,
  saveState,
  graphGet,
  graphPost,
  graphPatch,
  graphDelete,
  isLoggedIn,
} from './graph.mjs'

const DEFAULT_TZ = 'China Standard Time'
// ---------- pure helpers (exported for tests) ----------

function pad(n) {
  return String(n).padStart(2, '0')
}

export function tzOf(state) {
  return (state && state.timeZone) || DEFAULT_TZ
}

// "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm:ss" -> Graph dateTimeTimeZone.
export function stamp(value, timeZone, defaultTime = '00:00:00') {
  const raw = String(value)
  const iso = raw.includes('T') ? raw : raw + 'T' + defaultTime
  const padded = iso.length === 16 ? iso + ':00' : iso
  return { dateTime: padded, timeZone: timeZone || DEFAULT_TZ }
}

// Pick a sane reminder instant for a due date.
//   1. explicit reminder wins
//   2. the morning before the deadline (09:00), if still in the future
//   3. the deadline morning (09:00), if still in the future
//   4. otherwise now + 15 minutes
// `now` is injectable so the policy is testable.
export function reminderFor(due, explicit, timeZone, now = Date.now()) {
  const tz = timeZone || DEFAULT_TZ
  if (explicit) return stamp(explicit, tz)
  if (!due) return undefined
  const dueDay = String(due).slice(0, 10)
  const parts = dueDay.split('-').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined

  // Pure calendar arithmetic on the date itself: never derive the previous
  // calendar day from an instant, which would silently depend on the host
  // machine's zone rather than the task's configured zone.
  const prev = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) - 86400000)
  const dayBeforeWall =
    `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}T09:00:00`

  // Wall-clock comparisons read the machine's own zone, which is the zone the
  // configured Graph timeZone names (China Standard Time on this host).
  const dueMorningMs = Date.parse(dueDay + 'T09:00:00')
  if (Date.parse(dayBeforeWall) > now + 15 * 60000) return stamp(dayBeforeWall, tz)
  if (dueMorningMs > now + 15 * 60000) return stamp(dueDay + 'T09:00:00', tz)
  return { dateTime: new Date(now + 15 * 60000).toISOString().slice(0, 19), timeZone: 'UTC' }
}

export function taskTitle(project, title, mode) {
  return mode === 'milestone' ? title : `[${project}] ${title}`
}

// A plan records what the user said. It is NOT a licence to design their
// project for them.
//
// The user pushed back hard on 2026-10-01: told "导轨项目皮带安装要上翻" and
// nothing else, the assistant produced a four-step plan with deadlines the user
// never mentioned - 24 tasks where the user had said about eight things. Asking
// nicely in SKILL.md is what failed, so the rules live here, where apply cannot
// skip them.
//
// Three rules, each aimed at one flavour of invention:
//   - every task quotes the user (`source`)      -> invents no work
//   - `steps` needs `stepsFromUser: true`        -> invents no decomposition
//   - a `due` declares `dueBasis`                -> invents no deadlines
//
// Returning problems instead of throwing keeps this testable without a network.
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return ['plan must be a JSON object']
  }
  const problems = []
  if (!plan.project) problems.push('plan.project is required')
  if (!Array.isArray(plan.tasks)) {
    problems.push('plan.tasks must be an array')
    return problems
  }

  const withSteps = plan.tasks.filter((t) => t && Array.isArray(t.steps) && t.steps.length)
  if (withSteps.length && plan.stepsFromUser !== true) {
    problems.push(
      `"steps" appears on ${withSteps.length} task(s) but steps are only allowed when the ` +
        'user supplied them. Drop them, or set "stepsFromUser": true if the user really did ' +
        'name the steps themselves.',
    )
  }

  plan.tasks.forEach((item, i) => {
    const at = `tasks[${i}]`
    if (!item || typeof item !== 'object') {
      problems.push(`${at} must be an object`)
      return
    }
    if (!item.title) {
      problems.push(`${at}.title is required`)
      return
    }
    const label = `"${item.title}"`

    if (typeof item.source !== 'string' || !item.source.trim()) {
      problems.push(
        `${at} ${label} has no "source". Put the user's own words that produced this task in ` +
          '"source". If you cannot quote the user, the task is invented - do not create it.',
      )
    }

    if (item.due) {
      if (item.dueBasis !== 'stated' && item.dueBasis !== 'derived') {
        problems.push(
          `${at} ${label} sets a deadline with no "dueBasis". Use "stated" when the user named ` +
            'the date, or "derived" when it follows from numbers the user gave. No third ' +
            'option: an undated task beats a deadline you made up.',
        )
      } else if (item.dueBasis === 'derived' && !(typeof item.dueFrom === 'string' && item.dueFrom.trim())) {
        problems.push(
          `${at} ${label} is "dueBasis": "derived" - show the arithmetic in "dueFrom", e.g. ` +
            '"user gave DDL 11/15 and said one month early -> 10/15".',
        )
      }
    }
  })

  return problems
}

// Graph stores an instant in UTC and returns it with timeZone "UTC", so slicing
// the raw string reads every date back 8 hours (often a whole day) early.
// Convert to the host's wall clock — the zone the configured Graph timeZone
// names — before slicing.
export function wallClock(dt) {
  if (!dt || !dt.dateTime) return null
  const raw = String(dt.dateTime)
  // Trim sub-millisecond precision: JS only accepts 3 fractional digits.
  const trimmed = raw.includes('.') ? raw.slice(0, 23) : raw
  const explicitOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)
  const name = String(dt.timeZone || '').toUpperCase()
  const ms = explicitOffset
    ? Date.parse(trimmed)
    : name === 'UTC'
      ? Date.parse(trimmed + 'Z')
      : Date.parse(trimmed) // already a wall clock in the host's own zone
  return Number.isNaN(ms) ? null : new Date(ms)
}

export function localDay(dt) {
  const d = wallClock(dt)
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null
}

export function localMinute(dt) {
  const d = wallClock(dt)
  if (!d) return null
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

export function shape(task) {
  return {
    title: task.title,
    status: task.status,
    due: localDay(task.dueDateTime),
    reminder: localMinute(task.reminderDateTime),
    reminderOn: task.isReminderOn === true,
    completed: task.completedDateTime ? localMinute(task.completedDateTime) : null,
    modified: task.lastModifiedDateTime,
  }
}

export function diffSnapshots(before, after) {
  const changes = []
  for (const [id, now] of Object.entries(after)) {
    const was = before[id]
    if (!was) {
      changes.push({ id, change: 'created', title: now.title, project: now.project, due: now.due, status: now.status })
      continue
    }
    if (was.status !== now.status) {
      changes.push({
        id,
        change: now.status === 'completed' ? 'completed' : 'status',
        title: now.title,
        project: now.project,
        from: was.status,
        to: now.status,
        completedAt: now.completed,
      })
    }
    if (was.due !== now.due) {
      changes.push({ id, change: 'due-changed', title: now.title, project: now.project, from: was.due, to: now.due })
    }
    if (was.title !== now.title) {
      changes.push({ id, change: 'renamed', project: now.project, from: was.title, to: now.title })
    }
    if (was.reminder !== now.reminder) {
      changes.push({
        id,
        change: 'reminder-changed',
        title: now.title,
        project: now.project,
        from: was.reminder,
        to: now.reminder,
      })
    }
    // Completing a task makes To Do clear the reminder by itself, so reporting
    // the toggle too would double-report a single user action as two changes.
    const justCompleted = was.status !== 'completed' && now.status === 'completed'
    if (!justCompleted && was.reminderOn !== now.reminderOn) {
      changes.push({
        id,
        change: 'reminder-toggled',
        title: now.title,
        project: now.project,
        from: was.reminderOn,
        to: now.reminderOn,
      })
    }
  }
  for (const [id, was] of Object.entries(before)) {
    if (!after[id]) changes.push({ id, change: 'deleted', title: was.title, project: was.project })
  }
  return changes
}

// ---------- Graph ----------

// Follow @odata.nextLink so a list with more than one page is never truncated.
async function paged(url) {
  const items = []
  let next = url
  let guard = 0
  while (next && guard++ < 50) {
    const res = await graphGet(next)
    if (Array.isArray(res.value)) items.push(...res.value)
    const link = res['@odata.nextLink']
    next = link ? link.replace(GRAPH_BASE, '') : null
  }
  return items
}

export async function allLists() {
  return paged('/me/todo/lists?$top=100')
}

export async function defaultList() {
  const lists = await allLists()
  const found = lists.find((l) => l.wellknownListName === 'defaultList')
  if (!found) throw new Error('NO_DEFAULT_LIST')
  return found
}

async function ensureList(name) {
  const lists = await allLists()
  const found = lists.find((l) => l.displayName === name)
  if (found) return found
  return graphPost('/me/todo/lists', { displayName: name })
}

// NOTE: Graph rejects `$select` on this collection with
// "RequestBroker--ParseUri" (verified live), so the full task object is
// fetched and narrowed locally by shape(). $top works.
export async function liveTasks(listId) {
  return paged(`/me/todo/lists/${listId}/tasks?$top=100`)
}

// ---------- commands ----------

function out(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function fail(message, extra) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...(extra || {}) }, null, 2) + '\n')
  process.exit(1)
}

function argOf(args, flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

async function cmdLists() {
  const lists = await allLists()
  out({
    ok: true,
    lists: lists.map((l) => ({
      id: l.id,
      name: l.displayName,
      wellknown: l.wellknownListName,
      isDefault: l.wellknownListName === 'defaultList',
    })),
  })
}

async function cmdTasks(listName) {
  const list = listName ? await ensureList(listName) : await defaultList()
  const tasks = await liveTasks(list.id)
  out({
    ok: true,
    list: list.displayName,
    count: tasks.length,
    tasks: tasks.map((t) => ({ id: t.id, ...shape(t) })),
  })
}

async function cmdApply(planPath) {
  if (!planPath) fail('USAGE: apply <plan.json>')
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8').replace(/^\uFEFF/, ''))

  // Reject before touching the network: a plan that fails here must not get as
  // far as retiring the previous generation, or a bad plan would delete real
  // tasks and then abort.
  const problems = validatePlan(plan)
  if (problems.length) {
    fail('plan rejected - nothing was changed:\n  - ' + problems.join('\n  - '))
  }

  const project = plan.project
  const mode = plan.mode === 'milestone' ? 'milestone' : 'default'
  const state = loadState()
  state.projects = state.projects || {}
  const tz = tzOf(state)

  const list = mode === 'milestone' ? await ensureList(plan.list || project) : await defaultList()

  // 1. Retire the previous generation of this project's tasks.
  //
  // The recorded status in state.json is only as fresh as the last
  // snapshot/watch, so it must never decide whether a task survives: a task the
  // user finished in the app would still read `notStarted` here and be deleted
  // instead of kept as history. Reconcile against live To Do first.
  const previous = state.projects[project]
  const removed = []
  const kept = []
  const alreadyGone = []
  const previousIds = previous && previous.tasks ? Object.keys(previous.tasks) : []
  let liveById = null
  if (previousIds.length) {
    try {
      liveById = new Map((await liveTasks(previous.listId)).map((t) => [t.id, t]))
    } catch {
      liveById = null // fall back to the recorded status rather than delete blind
    }
  }
  for (const id of previousIds) {
    const meta = previous.tasks[id]
    const live = liveById ? liveById.get(id) : undefined
    if (liveById && !live) {
      alreadyGone.push({ id, title: meta.title })
      continue
    }
    const status = live ? live.status : meta.status
    const title = live ? live.title : meta.title
    if (status === 'completed' && !plan.purgeCompleted) {
      // Record the live due/reminder too: a carried-over entry with no due
      // date would otherwise look "changed" on every later status check.
      const shaped = live ? shape(live) : null
      kept.push({
        id,
        title,
        due: shaped ? shaped.due : (meta.due ?? null),
        reminder: shaped ? shaped.reminder : (meta.reminder ?? null),
      })
      continue
    }
    try {
      await graphDelete(`/me/todo/lists/${previous.listId}/tasks/${id}`)
      removed.push({ id, title })
    } catch (e) {
      removed.push({ id, title, error: String((e && e.message) || e) })
    }
  }

  // 2. Create the new generation.
  const created = []
  const stepErrors = []
  for (const item of plan.tasks || []) {
    if (!item || !item.title) continue
    const body = {
      title: taskTitle(project, item.title, mode),
      importance: item.importance || 'normal',
    }
    if (item.due) body.dueDateTime = stamp(item.due, tz)
    const reminder = reminderFor(item.due, item.reminder, tz)
    if (reminder) {
      body.reminderDateTime = reminder
      // reminderDateTime only stores an instant; isReminderOn is the flag To Do
      // actually fires on, so without this the reminder never goes off.
      body.isReminderOn = true
    }
    const note = [item.note, item.source].filter(Boolean).join('\n\n')
    if (note) body.body = { content: note, contentType: 'text' }

    const task = await graphPost(`/me/todo/lists/${list.id}/tasks`, body)

    // Checklist items are a separate collection: they cannot be set at creation.
    if (Array.isArray(item.steps)) {
      for (const step of item.steps) {
        if (!step) continue
        try {
          await graphPost(`/me/todo/lists/${list.id}/tasks/${task.id}/checklistItems`, {
            displayName: String(step),
          })
        } catch (e) {
          stepErrors.push({ task: task.title, step: String(step), error: String((e && e.message) || e) })
        }
      }
    }

    created.push({ id: task.id, ...shape(task) })
  }

  const tasks = {}
  for (const t of created) {
    tasks[t.id] = { title: t.title, due: t.due, reminder: t.reminder, status: t.status, modified: t.modified }
  }
  for (const k of kept) {
    tasks[k.id] = {
      title: k.title,
      due: k.due ?? null,
      reminder: k.reminder ?? null,
      status: 'completed',
      carriedOver: true,
    }
  }
  state.projects[project] = {
    mode,
    listId: list.id,
    listName: list.displayName,
    updatedAt: new Date().toISOString(),
    tasks,
  }
  saveState(state)

  out({
    ok: true,
    project,
    mode,
    list: list.displayName,
    removed,
    keptCompleted: kept,
    alreadyGone,
    created,
    ...(stepErrors.length ? { stepErrors } : {}),
  })
}

async function cmdStatus() {
  const state = loadState()
  const report = []
  let readErrors = 0
  // Same reason as readSnapshot: one read per list, not one per project. The
  // failure is cached too, so a list that cannot be read is reported once per
  // project that lives in it rather than re-fetched for each.
  const byList = new Map()
  for (const [project, entry] of Object.entries(state.projects || {})) {
    const tracked = new Set(Object.keys(entry.tasks || {}))
    if (!byList.has(entry.listId)) {
      try {
        byList.set(entry.listId, { live: await liveTasks(entry.listId) })
      } catch (e) {
        byList.set(entry.listId, { error: String((e && e.message) || e) })
      }
    }
    const cached = byList.get(entry.listId)
    if (cached.error) {
      // Never let a failed read masquerade as "nothing changed".
      readErrors++
      report.push({ project, list: entry.listName, error: cached.error })
      continue
    }
    const live = cached.live.filter((t) => tracked.has(t.id))
    const byId = new Map(live.map((t) => [t.id, t]))
    const changes = []
    for (const [id, meta] of Object.entries(entry.tasks || {})) {
      const now = byId.get(id)
      if (!now) {
        changes.push({ id, title: meta.title, change: 'deleted-in-todo' })
        continue
      }
      // Compare through the same local-time conversion used to record them.
      const due = localDay(now.dueDateTime)
      const reminder = localMinute(now.reminderDateTime)
      // Finishing a task clears its reminder; that is not a separate edit.
      const completedNow = meta.status !== 'completed' && now.status === 'completed'
      if (meta.status !== now.status) {
        changes.push({
          id,
          title: now.title,
          change: 'status',
          from: meta.status,
          to: now.status,
          completedAt: now.completedDateTime ? localMinute(now.completedDateTime) : null,
        })
      }
      if ((meta.due ?? null) !== due) {
        changes.push({ id, title: now.title, change: 'due', from: meta.due ?? null, to: due })
      }
      if (!completedNow && (meta.reminder ?? null) !== reminder) {
        changes.push({ id, title: now.title, change: 'reminder', from: meta.reminder ?? null, to: reminder })
      }
      if (meta.title !== now.title) {
        changes.push({ id, title: now.title, change: 'renamed', from: meta.title, to: now.title })
      }
    }
    report.push({
      project,
      list: entry.listName,
      updatedAt: entry.updatedAt,
      open: live.filter((t) => t.status !== 'completed').length,
      completed: live.filter((t) => t.status === 'completed').length,
      changes,
    })
  }
  return {
    payload: {
      ok: readErrors === 0,
      projects: report,
      hasChanges: readErrors === 0 && report.some((r) => (r.changes || []).length > 0),
      ...(readErrors
        ? { error: `${readErrors} 个清单读取失败，本次 hasChanges 不可信`, readErrors }
        : {}),
    },
    exitCode: readErrors ? 1 : 0,
  }
}

// Must never swallow a read error. Returning a partial or empty snapshot makes
// a network outage indistinguishable from "the user deleted every task", which
// would be reported to the user as mass deletion. Let it throw; the caller
// counts it as a failed poll instead.
//
// Only tasks DSH created are tracked. The user chose to keep everything in
// their default list, so that list also holds their own unrelated tasks —
// reporting those as "changes" would bury the signal in noise on every call.
async function readSnapshot(state) {
  const snap = {}
  // Projects usually share one list — the user keeps everything in the default
  // list — so fetching per project re-read the same collection once per project
  // (4x the traffic here, every poll). Read each list once per snapshot.
  const byList = new Map()
  for (const [project, entry] of Object.entries(state.projects || {})) {
    const tracked = new Set(Object.keys(entry.tasks || {}))
    if (!byList.has(entry.listId)) byList.set(entry.listId, await liveTasks(entry.listId))
    const live = byList.get(entry.listId)
    for (const t of live) {
      if (tracked.has(t.id)) snap[t.id] = { project, ...shape(t) }
    }
  }
  return snap
}

// Bring the per-project record that `status` diffs against into line with what
// To Do currently says, for tasks we already track.
//
// `watch` advanced only its own baseline, and nothing except `apply` ever wrote
// state.projects — so a single tick in the app was re-reported as a change by
// every later `status`, `hasChanges` could never return to false, and smoke.mjs
// (which asserts exactly that it does) failed. Absorbing is what makes "I have
// now seen the current truth" actually true.
//
// Only already-tracked tasks are touched. Adopting a task the user created
// themselves would make every later status report it as ours.
export function absorb(state, snap) {
  let absorbed = 0
  for (const [project, entry] of Object.entries(state.projects || {})) {
    for (const [id, meta] of Object.entries(entry.tasks || {})) {
      const now = snap[id]
      if (!now || now.project !== project) continue
      const due = now.due ?? null
      const reminder = now.reminder ?? null
      if (
        meta.title === now.title &&
        (meta.due ?? null) === due &&
        (meta.reminder ?? null) === reminder &&
        meta.status === now.status
      ) {
        continue
      }
      entry.tasks[id] = {
        ...meta,
        title: now.title,
        due,
        reminder,
        status: now.status,
        modified: now.modified,
      }
      absorbed++
    }
  }
  return absorbed
}

async function cmdSnapshot() {
  const state = loadState()
  const snap = await readSnapshot(state)
  // Load-bearing: without this, `status` keeps replaying edits the user already
  // made and that we already acted on.
  const absorbed = absorb(state, snap)
  state.watch = { baseline: snap, updatedAt: new Date().toISOString() }
  saveState(state)
  out({
    ok: true,
    tracked: Object.keys(snap).length,
    absorbed,
    updatedAt: state.watch.updatedAt,
  })
}

function cmdWatch(args) {
  const interval = Number(argOf(args, '--interval') || 20) * 1000
  // Four hours by default. Every window that expires costs the caller a whole
  // turn to restart, and the polling itself is free, so a longer window is
  // strictly cheaper. Background jobs have no runtime cap.
  const timeout = Number(argOf(args, '--timeout') || 14400) * 1000
  const started = Date.now()
  const state = loadState()
  if (!state.watch || !state.watch.baseline) fail('NO_BASELINE: run `snapshot` first')
  const baseline = state.watch.baseline

  return (async () => {
    let okPolls = 0
    let failedPolls = 0
    let lastError = null
    while (Date.now() - started < timeout) {
      await new Promise((r) => setTimeout(r, interval))
      let current
      try {
        current = await readSnapshot(state)
      } catch (e) {
        failedPolls++
        lastError = String((e && e.message) || e)
        // stderr, so stdout stays exactly one JSON document for the caller.
        process.stderr.write(JSON.stringify({ note: 'poll-error', error: lastError }) + '\n')
        continue
      }
      okPolls++
      const changes = diffSnapshots(baseline, current)
      if (changes.length) {
        const next = loadState()
        absorb(next, current)
        next.watch = { baseline: current, updatedAt: new Date().toISOString() }
        saveState(next)
        return {
          ok: true,
          event: 'todo-changed',
          detectedAt: new Date().toISOString(),
          changes,
          ...(failedPolls ? { failedPolls } : {}),
        }
      }
    }
    // Return the outcome rather than calling process.exit(): exiting from
    // inside a libuv timer callback aborts the process on Windows instead of
    // ending it cleanly, which would make every watch job look like a crash.
    //
    // Never report a clean "no-change" when the network never let us look:
    // that reads as "you did nothing" when the truth is "we could not see".
    if (okPolls === 0) {
      return { ok: false, event: 'watch-degraded', watchedMs: Date.now() - started, failedPolls, lastError }
    }
    return {
      ok: true,
      event: 'no-change',
      watchedMs: Date.now() - started,
      ...(failedPolls ? { failedPolls } : {}),
    }
  })()
}

async function cmdRaw(args) {
  const [method, url, body] = args
  if (!method || !url) fail('USAGE: raw <METHOD> <path> [jsonBody]')
  const m = method.toUpperCase()
  const data = body ? JSON.parse(body) : undefined
  const res =
    m === 'GET'
      ? await graphGet(url)
      : m === 'POST'
        ? await graphPost(url, data)
        : m === 'PATCH'
          ? await graphPatch(url, data)
          : m === 'DELETE'
            ? await graphDelete(url)
            : fail('unsupported method')
  out({ ok: true, result: res })
}

// ---------- main ----------

export async function main(argv) {
  const [command, ...args] = argv
  if (!isLoggedIn()) fail('NOT_LOGGED_IN: run `node login.mjs` once to authorize')
  try {
    switch (command) {
      case 'lists':
        await cmdLists()
        break
      case 'tasks':
        await cmdTasks(args[0])
        break
      case 'apply':
        await cmdApply(args[0])
        break
      case 'status': {
        const result = await cmdStatus()
        out(result.payload)
        if (result.exitCode) process.exitCode = result.exitCode
        break
      }
      case 'snapshot':
        await cmdSnapshot()
        break
      case 'watch': {
        const result = await cmdWatch(args)
        out(result)
        // A watch that could never reach the service must not look like a
        // successful "nothing happened". Safe here: we are outside the timer
        // callback, so this sets a code instead of aborting the process.
        if (result.ok === false) process.exitCode = 1
        break
      }
      case 'raw':
        await cmdRaw(args)
        break
      default:
        fail('UNKNOWN_COMMAND: ' + String(command))
    }
  } catch (e) {
    fail(String((e && e.message) || e), e && e.body ? { detail: e.body } : undefined)
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) await main(process.argv.slice(2))
