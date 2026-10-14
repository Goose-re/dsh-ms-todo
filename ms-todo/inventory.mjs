// Read-only inventory of every list and task before any destructive action.
import { graphGet, loadState } from './graph.mjs'

const lists = await graphGet('/me/todo/lists?$top=100')
const state = loadState()
const mine = new Set()
for (const entry of Object.values(state.projects || {})) {
  for (const id of Object.keys(entry.tasks || {})) mine.add(id)
}

let totalTasks = 0
let totalMine = 0

for (const l of lists.value) {
  let url = `/me/todo/lists/${l.id}/tasks?$top=100`
  const tasks = []
  let guard = 0
  while (url && guard++ < 30) {
    const res = await graphGet(url)
    tasks.push(...(res.value || []))
    url = res['@odata.nextLink']
      ? res['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '')
      : null
  }
  const open = tasks.filter((t) => t.status !== 'completed').length
  const createdByMe = tasks.filter((t) => mine.has(t.id)).length
  totalTasks += tasks.length
  totalMine += createdByMe
  console.log(
    `${l.displayName.padEnd(16)} kind=${String(l.wellknownListName).padEnd(14)} ` +
      `tasks=${String(tasks.length).padStart(3)}  open=${String(open).padStart(3)}  ` +
      `DSH建的=${createdByMe}`,
  )
}
console.log('')
console.log(`lists total: ${lists.value.length}`)
console.log(`tasks total: ${totalTasks}  (DSH 建的只有 ${totalMine} 条)`)
