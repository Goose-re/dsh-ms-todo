// Validate the skill's YAML frontmatter.
//
//   node check-skill.mjs
//
// This exists because a malformed frontmatter fails SILENTLY: the harness drops
// the skill from the catalog with no error anywhere. It happened once — a colon
// followed by a space inside the unquoted `description` value ("scheduling: they
// report") turned the value into a nested mapping and the whole skill vanished.
// Nothing else in the toolchain catches this, so run it after editing SKILL.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Path is overridable so the guard itself can be negative-tested.
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SKILL =
  process.argv[2] || path.join(DSH_HOME, 'skills', 'microsoft-todo', 'SKILL.md')

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

if (!fs.existsSync(SKILL)) {
  console.log('SKILL.md not found at ' + SKILL)
  process.exit(1)
}
const raw = fs.readFileSync(SKILL, 'utf8')

check('file has no BOM', !(raw.charCodeAt(0) === 0xfeff), 'a BOM can break frontmatter parsing')
check('file uses LF only', !raw.includes('\r'), 'found CR')

const lines = raw.split('\n')
check('frontmatter opens on line 1', lines[0] === '---', JSON.stringify(lines[0]))
const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
check('frontmatter has a closing ---', close > 0, 'no closing delimiter found')

const fm = close > 0 ? lines.slice(1, close) : []
const parsed = {}
const suspicious = []

for (const line of fm) {
  if (!line.trim()) continue
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s?(.*)$/)
  if (!m) {
    suspicious.push(line)
    continue
  }
  const [, key, value] = m
  parsed[key] = value
  // A plain (unquoted) YAML scalar may not contain ": " — it reads as a nested
  // mapping and the parse fails, silently retiring the skill.
  const quoted = /^["'].*["']$/.test(value.trim())
  if (!quoted && /:\s/.test(value)) {
    check(`"${key}" contains no bare colon-space`, false, `offending text: ...${value.slice(Math.max(0, value.search(/:\s/) - 30), value.search(/:\s/) + 20)}...`)
  } else {
    check(`"${key}" is a safe plain scalar`, true)
  }
}

check('every frontmatter line is key: value', suspicious.length === 0, suspicious.join(' | '))
check('name is present', Boolean(parsed.name), 'the harness needs name to register the skill')
check('name matches the directory', parsed.name === 'microsoft-todo', `got "${parsed.name}"`)
check('description is present', Boolean(parsed.description && parsed.description.trim()))
check(
  'description is long enough to trigger on the right requests',
  (parsed.description || '').length > 200,
  `only ${(parsed.description || '').length} chars`,
)
check(
  'description mentions the daily routine words',
  ['上线', '休息', '外出'].every((w) => (parsed.description || '').includes(w)),
)
check('body has a cold-start section', raw.includes('## 新会话冷启动'))

console.log('')
if (failures.length) {
  console.log(`FAIL ${failures.length} / ${passed + failures.length}`)
  for (const f of failures) console.log('  x ' + f)
  console.log('\nA skill with broken frontmatter is dropped from the catalog SILENTLY.')
  process.exit(1)
}
console.log(`PASS all ${passed} skill assertions`)
