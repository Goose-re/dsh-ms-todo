// End-to-end test against a local fake Microsoft Graph.
//
// Verifies the behaviours that actually matter to the user, without touching
// the real service: the replace semantics for a new project goal, the payload
// shape sent to To Do (title / due / reminder), and change detection when the
// user edits tasks in the app.
//
// Run: node e2e.mjs
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let passed = 0
const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed++
  else failures.push(`${name}\n     actual:   ${a}\n     expected: ${e}`)
}
function ok(name, condition, detail) {
  if (condition) passed++
  else failures.push(`${name}${detail ? '\n     ' + detail : ''}`)
}

// ---------- fake Graph ----------

const db = {
  lists: [{ id: 'L-default', displayName: 'Tasks', wellknownListName: 'defaultList' }],
  tasks: {},
  createdPayloads: [],
  // Initial (non-paginated) fetches of a task collection, so a test can prove
  // that projects sharing one list do not each re-read it.
  listFetches: [],
  seq: 0,
}

// Mirror the real service: it stores the instant and hands it back
// UTC-normalized (verified live). Omitting this is what let a naive .slice()
// read every date back 8 hours — and often a whole day — early.
function normalize(dt) {
  if (!dt || !dt.dateTime) return null
  const name = String(dt.timeZone || '').toUpperCase()
  const ms = name === 'UTC' ? Date.parse(dt.dateTime + 'Z') : Date.parse(dt.dateTime)
  if (Number.isNaN(ms)) return dt
  return { dateTime: new Date(ms).toISOString().slice(0, 19) + '.0000000', timeZone: 'UTC' }
}

function newTask(listId, body) {
  const id = 'T' + ++db.seq
  const task = {
    id,
    listId,
    title: body.title,
    status: 'notStarted',
    importance: body.importance || 'normal',
    dueDateTime: normalize(body.dueDateTime),
    reminderDateTime: normalize(body.reminderDateTime),
    isReminderOn: body.isReminderOn === true,
    completedDateTime: null,
    lastModifiedDateTime: new Date().toISOString(),
    body: body.body || null,
    checklist: [],
  }
  db.tasks[id] = task
  db.createdPayloads.push(body)
  return task
}

function send(res, status, payload) {
  const text = payload === undefined ? '' : JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(text)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined

    if (p === '/me/todo/lists' && req.method === 'GET') {
      return send(res, 200, { value: db.lists })
    }
    if (p === '/me/todo/lists' && req.method === 'POST') {
      const list = { id: 'L' + ++db.seq, displayName: body.displayName, wellknownListName: 'none' }
      db.lists.push(list)
      return send(res, 201, list)
    }

    let m = p.match(/^\/me\/todo\/lists\/([^/]+)\/tasks$/)
    if (m && req.method === 'GET') {
      // The real Graph rejects $select on this collection with
      // "RequestBroker--ParseUri"; encode that so the regression cannot return.
      if (url.searchParams.has('$select')) {
        return send(res, 400, {
          error: {
            code: 'invalidRequest',
            message: 'Invalid request',
            innerError: { code: 'RequestBroker--ParseUri' },
          },
        })
      }
      const listId = m[1]
      // Only the first page counts as a fetch; the rest are pagination.
      if (!url.searchParams.has('$skip')) db.listFetches.push(listId)
      const all = Object.values(db.tasks).filter((t) => t.listId === listId)
      // Page size 2 so pagination is genuinely exercised.
      const skip = Number(url.searchParams.get('$skip') || 0)
      const page = all.slice(skip, skip + 2)
      const payload = { value: page.map(withOdata) }
      if (skip + 2 < all.length) {
        payload['@odata.nextLink'] =
          `${base}/me/todo/lists/${listId}/tasks?$skip=${skip + 2}`
      }
      return send(res, 200, payload)
    }
    if (m && req.method === 'POST') {
      return send(res, 201, withOdata(newTask(m[1], body)))
    }

    m = p.match(/^\/me\/todo\/lists\/([^/]+)\/tasks\/([^/]+)\/checklistItems$/)
    if (m && req.method === 'POST') {
      const task = db.tasks[m[2]]
      task.checklist.push(body.displayName)
      return send(res, 201, { id: 'C' + ++db.seq, displayName: body.displayName })
    }

    m = p.match(/^\/me\/todo\/lists\/([^/]+)\/tasks\/([^/]+)$/)
    if (m && req.method === 'DELETE') {
      if (!db.tasks[m[2]]) return send(res, 404, { error: { message: 'not found' } })
      delete db.tasks[m[2]]
      return send(res, 204)
    }
    if (m && (req.method === 'PATCH' || req.method === 'GET')) {
      const task = db.tasks[m[2]]
      if (!task) return send(res, 404, { error: { message: 'not found' } })
      if (req.method === 'PATCH') Object.assign(task, body)
      return send(res, 200, withOdata(task))
    }

    send(res, 404, { error: { message: 'unhandled ' + req.method + ' ' + p } })
  })
})

function withOdata(t) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    importance: t.importance,
    dueDateTime: t.dueDateTime,
    reminderDateTime: t.reminderDateTime,
    isReminderOn: t.isReminderOn,
    completedDateTime: t.completedDateTime,
    lastModifiedDateTime: t.lastModifiedDateTime,
    body: t.body,
  }
}

let base = ''

// ---------- driver ----------

function runCli(...args) {
  return runCliEnv({}, ...args)
}

// The fake Graph listens in THIS process, so the CLI must run asynchronously:
// a synchronous spawn would block the event loop and deadlock the request.
function runCliEnv(envOverride, command, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'todo.mjs'), command, ...args], {
      env: {
        ...process.env,
        MSTODO_DIR: process.env.E2E_DIR,
        MSTODO_GRAPH_BASE: base,
        MSTODO_ACCESS_TOKEN: 'fake-token',
        ...envOverride,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => {
      let json = null
      try {
        json = JSON.parse(stdout)
      } catch {
        json = { __unparsed: stdout }
      }
      resolve({ code: status, json, stderr })
    })
  })
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
base = `http://127.0.0.1:${server.address().port}`
process.env.E2E_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mstodo-e2e-'))
const stateDir = process.env.E2E_DIR

try {
  // --- 1. first generation -------------------------------------------------
  const plan1 = {
    project: '官网改版',
    stepsFromUser: true,
    tasks: [
      {
        title: '完成首页视觉稿',
        due: '2099-03-20',
        dueBasis: 'stated',
        source: '用户说：3月20日前完成首页视觉稿，分两步——先收集竞品再出两版方案。',
        importance: 'high',
        steps: ['收集竞品', '出两版方案'],
      },
      {
        title: '定稿文案',
        due: '2099-03-25',
        dueBasis: 'stated',
        source: '用户说：3月25日定稿文案。',
      },
      {
        title: '前端联调上线',
        due: '2099-04-02',
        dueBasis: 'stated',
        source: '用户说：4月2日前端联调上线。',
      },
    ],
  }
  fs.writeFileSync(path.join(stateDir, 'plan1.json'), JSON.stringify(plan1))

  const apply1 = await runCli('apply', path.join(stateDir, 'plan1.json'))
  ok('apply succeeds', apply1.code === 0, JSON.stringify(apply1.json))
  if (apply1.code !== 0) throw new Error('first apply failed')
  check('first apply creates every task', apply1.json.created.length, 3)
  check('first apply removes nothing', apply1.json.removed, [])
  check(
    'tasks go into the default list',
    apply1.json.list,
    'Tasks',
  )
  check(
    'default mode prefixes the project name',
    apply1.json.created.map((t) => t.title),
    ['[官网改版] 完成首页视觉稿', '[官网改版] 定稿文案', '[官网改版] 前端联调上线'],
  )
  check(
    'due dates reach To Do as the task deadline',
    apply1.json.created.map((t) => t.due),
    ['2099-03-20', '2099-03-25', '2099-04-02'],
  )
  check(
    'reminder lands the morning before each deadline',
    apply1.json.created.map((t) => t.reminder),
    ['2099-03-19T09:00', '2099-03-24T09:00', '2099-04-01T09:00'],
  )
  // An explicit reminder must win over the default policy. Run it as a scratch
  // project, then remove it again so later counts stay simple.
  const planX = {
    project: 'X',
    tasks: [
      {
        title: 'x',
        due: '2099-05-10',
        dueBasis: 'stated',
        source: '测试夹具：用户说 5月10日。',
        reminder: '2099-05-09T20:00:00',
      },
    ],
  }
  fs.writeFileSync(path.join(stateDir, 'planX.json'), JSON.stringify(planX))
  const applyX = await runCli('apply', path.join(stateDir, 'planX.json'))
  ok('scratch apply succeeds', applyX.code === 0, JSON.stringify(applyX.json))
  check('an explicit reminder overrides the default policy', applyX.json.created[0].reminder, '2099-05-09T20:00')
  for (const t of applyX.json.created) delete db.tasks[t.id]
  const scratchState = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
  delete scratchState.projects.X
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(scratchState, null, 2))

  check(
    'checklist steps become To Do subtasks',
    db.tasks[apply1.json.created[0].id].checklist,
    ['收集竞品', '出两版方案'],
  )
  check(
    'a task with a deadline arms its reminder (isReminderOn)',
    db.createdPayloads[0].isReminderOn,
    true,
  )

  // --- 2. the user works in the app ---------------------------------------
  const firstId = apply1.json.created[0].id
  const secondId = apply1.json.created[1].id
  db.tasks[firstId].status = 'completed'
  db.tasks[firstId].completedDateTime = { dateTime: '2099-03-11T14:00:00', timeZone: 'China Standard Time' }
  // The real service clears the reminder switch when a task is finished; mirror
  // that so the "don't double-report" behaviour is genuinely covered.
  db.tasks[firstId].isReminderOn = false

  const statusRun = await runCli('status')
  ok('status succeeds', statusRun.code === 0, JSON.stringify(statusRun.json))
  if (statusRun.code !== 0) throw new Error('status failed')
  check('status notices the completion', statusRun.json.hasChanges, true)
  const completion = statusRun.json.projects[0].changes.find((c) => c.id === firstId)
  check('the completion is reported with its timestamp', completion, {
    id: firstId,
    title: '[官网改版] 完成首页视觉稿',
    change: 'status',
    from: 'notStarted',
    to: 'completed',
    completedAt: '2099-03-11T14:00',
  })

  // The user's own unrelated tasks share the default list; they are not changes.
  const userTaskId = newTask('L-default', { title: '用户自己建的待办' }).id
  const noiseRun = await runCli('status')
  check(
    'an unrelated task the user made is not reported as a change',
    noiseRun.json.projects[0].changes.some((c) => c.id === userTaskId),
    false,
  )
  check(
    'no untracked task is reported at all',
    noiseRun.json.projects[0].changes.filter((c) => c.change === 'added-in-todo').length,
    0,
  )
  check(
    'the only pending change is the real completion',
    noiseRun.json.projects[0].changes.map((c) => c.id + ':' + c.change),
    [firstId + ':status'],
  )
  delete db.tasks[userTaskId]

  // --- 3. watch detects further edits -------------------------------------
  const snapshotRun = await runCli('snapshot')
  check('snapshot records a baseline', snapshotRun.json.tracked, 3)
  // Absorbing is what keeps `status` from replaying the same edit for ever.
  check('snapshot absorbs the edit it just saw', snapshotRun.json.absorbed, 1)
  const settledRun = await runCli('status')
  check('an absorbed change is not reported again', settledRun.json.hasChanges, false)

  db.tasks[secondId].title = '[官网改版] 定稿文案（第二轮）'
  const thirdId = apply1.json.created[2].id
  db.tasks[thirdId].dueDateTime = { dateTime: '2099-04-10T00:00:00', timeZone: 'China Standard Time' }

  const watchRun = await runCli('watch', '--interval', '1', '--timeout', '25')
  ok(
    'watch exits 0 on a detected change',
    watchRun.code === 0,
    'code=' + watchRun.code + ' stderr=' + watchRun.stderr + ' ' + JSON.stringify(watchRun.json),
  )
  if (watchRun.code !== 0) throw new Error('watch did not detect a change')
  check('watch reports the event', watchRun.json.event, 'todo-changed')
  check(
    'watch reports the rename and the reschedule',
    watchRun.json.changes.map((c) => `${c.id}:${c.change}`).sort(),
    [`${secondId}:renamed`, `${thirdId}:due-changed`],
  )
  const settledAfterWatch = await runCli('status')
  check('watch absorbs what it reported too', settledAfterWatch.json.hasChanges, false)

  // A watch that could never see the service must not claim "no change".
  const blindRun = await runCliEnv(
    { MSTODO_GRAPH_BASE: 'http://127.0.0.1:1' },
    'watch',
    '--interval',
    '1',
    '--timeout',
    '6',
  )
  check('a blind watch reports degraded, not a clean no-change', blindRun.json.event, 'watch-degraded')
  check('a blind watch is not reported as ok', blindRun.json.ok, false)
  check('a blind watch exits non-zero', blindRun.code, 1)

  const blindSnapshot = await runCliEnv({ MSTODO_GRAPH_BASE: 'http://127.0.0.1:1' }, 'snapshot')
  check('a blind snapshot fails loudly', blindSnapshot.code, 1)
  const baselineAfter = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'),
  ).watch.baseline
  check(
    'a failed snapshot leaves the previous baseline intact',
    Object.keys(baselineAfter).length,
    3,
  )

  // --- 4. a new goal for the same project ---------------------------------
  const plan2 = {
    project: '官网改版',
    tasks: [
      {
        title: '重做信息架构',
        due: '2099-06-01',
        dueBasis: 'stated',
        source: '用户说：6月1日前重做信息架构。',
      },
      {
        title: '新版视觉走查',
        due: '2099-06-15',
        dueBasis: 'stated',
        source: '用户说：6月15日前做新版视觉走查。',
      },
    ],
  }
  fs.writeFileSync(path.join(stateDir, 'plan2.json'), JSON.stringify(plan2))
  const apply2 = await runCli('apply', path.join(stateDir, 'plan2.json'))
  ok('second apply succeeds', apply2.code === 0, JSON.stringify(apply2.json))
  if (apply2.code !== 0) throw new Error('second apply failed')

  check(
    'the new goal removes the unfinished previous tasks',
    apply2.json.removed.map((r) => r.id).sort(),
    [secondId, thirdId].sort(),
  )
  check(
    'the already-completed task is kept as history',
    apply2.json.keptCompleted.map((k) => k.id),
    [firstId],
  )
  check(
    'the new goal creates exactly its own tasks',
    apply2.json.created.map((t) => t.title),
    ['[官网改版] 重做信息架构', '[官网改版] 新版视觉走查'],
  )
  ok('the completed task still exists in To Do', Boolean(db.tasks[firstId]))
  ok('an unfinished old task is really gone', !db.tasks[secondId] && !db.tasks[thirdId])
  check(
    'only the new goal is left open',
    Object.values(db.tasks).filter((t) => t.status !== 'completed').length,
    2,
  )

  const trackedAfter = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')).projects['官网改版']
  check('both generations are tracked', Object.keys(trackedAfter.tasks).length, 3)
  ok(
    'the carried-over task is recorded as completed',
    trackedAfter.tasks[firstId].status === 'completed',
  )

  // --- 5. purgeCompleted ---------------------------------------------------
  const plan3 = {
    project: '官网改版',
    purgeCompleted: true,
    tasks: [
      {
        title: '终版验收',
        due: '2099-07-01',
        dueBasis: 'stated',
        source: '用户说：7月1日终版验收。',
      },
    ],
  }
  fs.writeFileSync(path.join(stateDir, 'plan3.json'), JSON.stringify(plan3))
  const apply3 = await runCli('apply', path.join(stateDir, 'plan3.json'))
  ok('purge apply succeeds', apply3.code === 0, JSON.stringify(apply3.json))
  if (apply3.code !== 0) throw new Error('purge apply failed')
  check(
    'purgeCompleted also removes the finished task',
    apply3.json.removed.map((r) => r.id).sort(),
    Object.keys(trackedAfter.tasks).filter((id) => id !== apply3.json.created[0].id).sort(),
  )
  ok('the finished task is gone from To Do', !db.tasks[firstId])

  // --- 6. milestone mode ---------------------------------------------------
  const plan4 = {
    project: '出海项目',
    mode: 'milestone',
    tasks: [
      {
        title: 'M1 立项',
        due: '2099-08-01',
        dueBasis: 'stated',
        source: '用户说：8月1日 M1 立项。',
      },
    ],
  }
  fs.writeFileSync(path.join(stateDir, 'plan4.json'), JSON.stringify(plan4))
  const apply4 = await runCli('apply', path.join(stateDir, 'plan4.json'))
  ok('milestone apply succeeds', apply4.code === 0, JSON.stringify(apply4.json))
  if (apply4.code !== 0) throw new Error('milestone apply failed')
  check('milestone mode does not prefix the title', apply4.json.created[0].title, 'M1 立项')
  check('milestone mode uses its own list', apply4.json.list, '出海项目')

  // --- 7. the anti-invention gate ------------------------------------------
  //
  // These guard the rule the user asked for on 2026-10-01: a plan may only
  // record what the user said. Without them, "apply" happily accepts a plan
  // that invents decomposition and deadlines.
  let badSeq = 0
  const writePlan = (obj) => {
    const p = path.join(stateDir, `bad-${badSeq++}.json`)
    fs.writeFileSync(p, JSON.stringify(obj, null, 2))
    return p
  }
  const badApply = (obj) => runCli('apply', writePlan(obj))

  const noSource = await badApply({
    project: '编造',
    tasks: [{ title: '凭空想出来的步骤', due: '2099-09-01', dueBasis: 'stated' }],
  })
  ok('a task with no source is rejected', noSource.code === 1, JSON.stringify(noSource.json))
  ok(
    'the rejection names the task and the missing field',
    /source/.test(noSource.json.error) && /凭空想出来的步骤/.test(noSource.json.error),
    noSource.json.error,
  )

  const inventedSteps = await badApply({
    project: '编造',
    tasks: [{ title: '出方案', source: '用户说：出个方案。', steps: ['第一步', '第二步'] }],
  })
  ok('steps without the opt-in are rejected', inventedSteps.code === 1, JSON.stringify(inventedSteps.json))
  ok('the rejection points at stepsFromUser', /stepsFromUser/.test(inventedSteps.json.error), inventedSteps.json.error)

  const unbasedDue = await badApply({
    project: '编造',
    tasks: [{ title: '出方案', source: '用户说：出个方案。', due: '2099-09-09' }],
  })
  ok('a deadline with no dueBasis is rejected', unbasedDue.code === 1, JSON.stringify(unbasedDue.json))
  ok('the rejection points at dueBasis', /dueBasis/.test(unbasedDue.json.error), unbasedDue.json.error)

  const derivedNoMath = await badApply({
    project: '编造',
    tasks: [
      { title: '定方案', source: '用户说：提前一个月定方案。', due: '2099-09-09', dueBasis: 'derived' },
    ],
  })
  ok('derived without dueFrom is rejected', derivedNoMath.code === 1, JSON.stringify(derivedNoMath.json))

  ok(
    'nothing invented ever reached To Do',
    !Object.values(db.tasks).some((t) => /凭空想出来的步骤|出方案/.test(t.title)),
  )

  // The gate must run before the previous generation is retired, otherwise a
  // rejected plan would delete real tasks and then abort.
  const survivor = await badApply({
    project: '出海项目',
    tasks: [{ title: '这条没有 source' }],
  })
  ok('a rejected plan fails', survivor.code === 1, JSON.stringify(survivor.json))
  ok(
    'a rejected plan leaves the previous generation untouched',
    Object.values(db.tasks).some((t) => t.title === 'M1 立项'),
  )

  const fullySourced = await badApply({
    project: '编造',
    tasks: [
      {
        title: '定方案',
        source: '用户说：最终 DDL 11/15，提前一个月定方案。',
        due: '2099-09-09',
        dueBasis: 'derived',
        dueFrom: '用户给的 DDL 10/09 提前一个月 -> 09/09',
      },
    ],
  })
  ok('a fully sourced plan still passes', fullySourced.code === 0, JSON.stringify(fullySourced.json))

  // --- 8. one read per list, not one per project ---------------------------
  //
  // Projects share the default list, so a per-project fetch re-read the same
  // collection once per project on every poll.
  const stateNow = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
  const projectLists = Object.values(stateNow.projects).map((p) => p.listId)
  const distinctLists = new Set(projectLists)
  ok(
    'the fixture really does share one list between projects',
    projectLists.length > distinctLists.size,
    `projects=${projectLists.length} distinctLists=${distinctLists.size}`,
  )

  db.listFetches = []
  const dedupSnap = await runCli('snapshot')
  ok('snapshot still succeeds after dedupe', dedupSnap.code === 0, JSON.stringify(dedupSnap.json))
  check('each list is fetched exactly once per snapshot', db.listFetches.length, distinctLists.size)

  db.listFetches = []
  const dedupStatus = await runCli('status')
  ok('status still succeeds after dedupe', dedupStatus.code === 0, JSON.stringify(dedupStatus.json))
  check('each list is fetched exactly once per status', db.listFetches.length, distinctLists.size)
} catch (e) {
  failures.push('run aborted: ' + String((e && e.stack) || e))
} finally {
  server.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

if (failures.length) {
  console.log(`FAIL ${failures.length} of ${passed + failures.length}`)
  for (const f of failures) console.log('  x ' + f)
  process.exit(1)
}
console.log(`PASS all ${passed} end-to-end assertions`)
