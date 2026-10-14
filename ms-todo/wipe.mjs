// Delete every Microsoft To Do list and task.
//
// Confirmed by the user after being shown the full scope and the fact that this
// is irreversible. Run with --dry-run to see the plan without touching anything.
//
// Strategy: delete whole lists first (that removes their tasks with them), then
// fall back to deleting tasks one by one for lists the service refuses to
// delete — the default list and the system "Flagged Emails" list cannot be
// removed, only emptied.
import { graphGet, graphDelete } from './graph.mjs'

const DRY = process.argv.includes('--dry-run')
const CONFIRMED = process.argv.includes('--yes')
if (!DRY && !CONFIRMED) {
  console.log('This permanently deletes EVERY list and task, with no undo.')
  console.log('  preview : node wipe.mjs --dry-run')
  console.log('  execute : node wipe.mjs --yes')
  process.exit(2)
}
const GRAPH_PREFIX = 'https://graph.microsoft.com/v1.0'

async function withRetry(fn, label) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (e.status === 429 || e.status === 503 || e.status === 504) {
        const wait = 2000 * (attempt + 1)
        console.log(`      throttled (${e.status}) on ${label}, waiting ${wait}ms`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw e
    }
  }
  throw new Error('retries exhausted: ' + label)
}

async function allTasks(listId) {
  let url = `/me/todo/lists/${listId}/tasks?$top=100`
  const out = []
  let guard = 0
  while (url && guard++ < 60) {
    const res = await withRetry(() => graphGet(url), 'list tasks')
    out.push(...(res.value || []))
    url = res['@odata.nextLink'] ? res['@odata.nextLink'].replace(GRAPH_PREFIX, '') : null
  }
  return out
}

const lists = (await graphGet('/me/todo/lists?$top=100')).value || []
console.log(`${DRY ? '[DRY RUN] ' : ''}found ${lists.length} lists\n`)

let deletedLists = 0
let deletedTasks = 0
const refused = []

// Pass 1: lists the service will let us remove outright.
for (const l of lists) {
  const isDefault = l.wellknownListName === 'defaultList'
  const isSystem = l.wellknownListName && l.wellknownListName !== 'none'
  if (isDefault || isSystem) continue

  const tasks = await allTasks(l.id)
  if (DRY) {
    console.log(`would delete list "${l.displayName}" (${tasks.length} tasks)`)
    deletedLists++
    deletedTasks += tasks.length
    continue
  }
  try {
    await withRetry(() => graphDelete(`/me/todo/lists/${l.id}`), `delete list ${l.displayName}`)
    deletedLists++
    deletedTasks += tasks.length
    console.log(`deleted list "${l.displayName}"  (${tasks.length} tasks went with it)`)
  } catch (e) {
    refused.push({ list: l.displayName, error: String((e && e.message) || e) })
    console.log(`could NOT delete list "${l.displayName}": ${String((e && e.message) || e).slice(0, 120)}`)
  }
}

// Pass 2: lists that survive must be emptied task by task.
for (const l of lists) {
  const isDefault = l.wellknownListName === 'defaultList'
  const isSystem = l.wellknownListName && l.wellknownListName !== 'none'
  if (!isDefault && !isSystem) continue

  const tasks = await allTasks(l.id)
  console.log(`\nlist "${l.displayName}" (${l.wellknownListName}) — ${tasks.length} tasks to remove`)
  let n = 0
  let failed = 0
  for (const t of tasks) {
    if (DRY) {
      n++
      continue
    }
    try {
      await withRetry(() => graphDelete(`/me/todo/lists/${l.id}/tasks/${t.id}`), `delete task ${t.id}`)
      n++
      if (n % 20 === 0) console.log(`    ...${n}/${tasks.length}`)
    } catch (e) {
      failed++
      console.log(`    failed: ${t.title.slice(0, 40)} — ${String((e && e.message) || e).slice(0, 90)}`)
    }
  }
  deletedTasks += n
  console.log(`  removed ${n}${failed ? `, ${failed} failed` : ''}`)

  if (!DRY) {
    try {
      await withRetry(() => graphDelete(`/me/todo/lists/${l.id}`), `delete list ${l.displayName}`)
      deletedLists++
      console.log(`  and the list itself was removable after all`)
    } catch (e) {
      console.log(`  list itself is not deletable (expected for this kind): ${String((e && e.message) || e).slice(0, 80)}`)
    }
  }
}

console.log('\n===== summary =====')
console.log(`lists deleted : ${deletedLists}`)
console.log(`tasks deleted : ${deletedTasks}`)
if (refused.length) {
  console.log('refused:')
  for (const r of refused) console.log(`  ${r.list}: ${r.error.slice(0, 100)}`)
}
