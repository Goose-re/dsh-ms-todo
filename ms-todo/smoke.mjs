// Live verification against the REAL Microsoft To Do.
//
//   node smoke.mjs            create a clearly-labelled test project and verify
//                             that every field actually round-trips through To Do
//   node smoke.mjs --cleanup  remove everything this test created
//
// This exists because the fake-Graph suite cannot prove that the real service
// accepts our payload shape (dateTimeTimeZone, reminder, checklist items) or
// that it stores back what we sent.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadState, saveState, isLoggedIn } from './graph.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = 'DSH 接入自检'
const PLAN = path.join(HERE, 'smoke-plan.json')

let passed = 0
const failures = []

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}\n       actual:   ${a}\n       expected: ${e}`)
    console.log(`  FAIL ${name}\n       actual:   ${a}\n       expected: ${e}`)
  }
}
function ok(name, condition, detail) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail ? '\n       ' + detail : ''}`)
    console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`)
  }
}

function runCli(command, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'todo.mjs'), command, ...args], {
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => {
      let json = null
      try {
        json = JSON.parse(stdout)
      } catch {
        json = { __unparsed: stdout }
      }
      resolve({ code, json, stderr })
    })
  })
}

function dayOffset(days) {
  const d = new Date(Date.now() + days * 86400000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

if (!isLoggedIn()) {
  console.log('NOT_LOGGED_IN — 先完成设备码授权（node login.mjs）再跑自检。')
  process.exit(1)
}

// ---------- cleanup mode ----------

if (process.argv.includes('--cleanup')) {
  fs.writeFileSync(
    PLAN,
    JSON.stringify({ project: PROJECT, purgeCompleted: true, tasks: [] }, null, 2),
  )
  const res = await runCli('apply', PLAN)
  const state = loadState()
  const entry = state.projects && state.projects[PROJECT]
  const count = entry ? Object.keys(entry.tasks).length : 0
  if (state.projects) delete state.projects[PROJECT]
  saveState(state)
  fs.rmSync(PLAN, { force: true })
  console.log(
    res.code === 0
      ? `已清理自检项目「${PROJECT}」：删除 ${res.json.removed ? res.json.removed.length : 0} 条待办。`
      : `清理失败：${JSON.stringify(res.json)}`,
  )
  process.exit(res.code === 0 ? 0 : 1)
}

// ---------- verification mode ----------

console.log('== 1. 凭据与清单 ==')
const listsRun = await runCli('lists')
ok('能读到清单列表', listsRun.code === 0, JSON.stringify(listsRun.json))
if (listsRun.code !== 0) process.exit(1)
const defaultList = (listsRun.json.lists || []).find((l) => l.isDefault)
ok('存在默认清单', Boolean(defaultList), JSON.stringify(listsRun.json.lists))
console.log(`     默认清单 = ${defaultList ? defaultList.name : '(无)'}`)

console.log('== 2. 建立自检待办 ==')
const plan = {
  project: PROJECT,
  stepsFromUser: true,
  tasks: [
    {
      title: '确认这条待办显示正常',
      due: dayOffset(3),
      dueBasis: 'stated',
      source: '自检夹具：由 smoke.mjs 指定 3 天后到期。',
      importance: 'high',
      note: '由 DSH 自检创建，可直接勾选或删除。',
      steps: ['检查标题', '检查截止日期', '检查提醒时间'],
    },
    {
      title: '把这条勾选完成，DSH 应能感知到',
      due: dayOffset(5),
      dueBasis: 'stated',
      source: '自检夹具：由 smoke.mjs 指定 5 天后到期。',
      reminder: null,
    },
  ],
}
fs.writeFileSync(PLAN, JSON.stringify(plan, null, 2))
const applyRun = await runCli('apply', PLAN)
ok('apply 成功', applyRun.code === 0, JSON.stringify(applyRun.json))
if (applyRun.code !== 0) process.exit(1)
check('创建了 2 条待办', applyRun.json.created.length, 2)
check('进了默认清单', applyRun.json.list, defaultList.name)

console.log('== 3. 回读校验（真实 Graph 是否原样存下）==')
const tasksRun = await runCli('tasks')
ok('能读回默认清单的任务', tasksRun.code === 0, JSON.stringify(tasksRun.json))
const created = applyRun.json.created
const mine = (tasksRun.json.tasks || []).filter((t) => created.some((c) => c.id === t.id))
check('两条都在清单里', mine.length, 2)

const first = mine.find((t) => t.id === created[0].id)
if (first) {
  check('标题带项目前缀', first.title, `[${PROJECT}] 确认这条待办显示正常`)
  check('截止日期按计划写入', first.due, plan.tasks[0].due)
  const expectedReminder = dayOffset(2) + 'T09:00'
  check('提醒时间落在截止前一天 09:00', first.reminder, expectedReminder)
  check('完成状态为未完成', first.status, 'notStarted')
}

const second = mine.find((t) => t.id === created[1].id)
if (second) {
  check('第二条提醒自动算出', second.reminder, dayOffset(4) + 'T09:00')
}

console.log('== 4. 变更检测基线 ==')
const snapRun = await runCli('snapshot')
ok('snapshot 建立基线', snapRun.code === 0, JSON.stringify(snapRun.json))
const statusRun = await runCli('status')
ok('status 能跑通', statusRun.code === 0, JSON.stringify(statusRun.json))
check('刚建完应无变化', statusRun.json.hasChanges, false)

console.log('')
if (failures.length) {
  console.log(`结果：FAIL ${failures.length} / ${passed + failures.length}`)
  for (const f of failures) console.log('  x ' + f)
  process.exit(1)
}
console.log(`结果：PASS 全部 ${passed} 项`)
console.log('')
console.log('接下来请你在 Microsoft To Do 里手动做一件事：')
console.log(`  把「[${PROJECT}] 把这条勾选完成，DSH 应能感知到」勾选完成。`)
console.log('然后告诉我，我会跑 status 确认感知到了。')
console.log(`（自检完成后用 node smoke.mjs --cleanup 清掉这些测试待办。）`)
