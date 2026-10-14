// Microsoft Graph helper: token persistence + refresh + resilient JSON request.
//
// The network path to login.microsoftonline.com / graph.microsoft.com on this
// machine is intermittently flaky, so every request is retried and then falls
// back to curl.exe when Node's fetch cannot open the connection.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Resolve the harness home the way DSH itself does — an explicit config path
// beats $DSH_HOME, which beats ~/.dsh — so this directory works on any machine
// without editing a literal path. MSTODO_DIR still wins over both, which is how
// e2e.mjs points the whole client at a temp dir.
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const DIR = process.env.MSTODO_DIR || path.join(DSH_HOME, 'ms-todo')
export const AUTH_FILE = path.join(DIR, 'auth.json')
export const STATE_FILE = path.join(DIR, 'state.json')
export const PLANS_DIR = path.join(DIR, 'plans')
// Overridable so the end-to-end test can point the client at a local fake
// Graph instead of the real service.
export const GRAPH_BASE = (process.env.MSTODO_GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '')

export function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

export function saveAuth(auth) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8')
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return { projects: {} }
  }
}

export function saveState(state) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

export function isLoggedIn() {
  if (process.env.MSTODO_ACCESS_TOKEN) return true
  const auth = loadAuth()
  return Boolean(auth && auth.refresh_token)
}

// ---------- transport ----------

function viaCurl(method, url, headers, body) {
  const args = ['-s', '--max-time', '60', '-w', '\n%{http_code}', '-X', method, url]
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`)
  if (body !== undefined) args.push('--data-binary', body)
  let out
  try {
    out = execFileSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    // Never surface the raw argv: it contains the Authorization bearer token,
    // and a thrown error here ends up in session and job logs.
    const code = e.status === undefined || e.status === null ? '?' : e.status
    const reason = String(e.stderr || '')
      .trim()
      .split('\n')[0]
      .slice(0, 160)
    throw new Error(`curl exit ${code}${reason ? ': ' + reason : ''}`)
  }
  const cut = out.lastIndexOf('\n')
  return { status: Number(out.slice(cut + 1).trim()), text: out.slice(0, cut) }
}

export async function httpJson(method, url, headers = {}, body) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(45000) })
      return { status: res.status, text: await res.text() }
    } catch (e) {
      lastError = e
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  try {
    return viaCurl(method, url, headers, body)
  } catch (e) {
    throw new Error(`NETWORK_FAILED ${String(lastError && lastError.message)} / curl ${String(e.message)}`)
  }
}

export function parse(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// ---------- auth ----------

async function refresh(auth) {
  const body = new URLSearchParams({
    client_id: auth.client_id,
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token,
    scope: auth.scope,
  }).toString()
  const res = await httpJson(
    'POST',
    `https://login.microsoftonline.com/${auth.tenant || 'common'}/oauth2/v2.0/token`,
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  )
  const json = parse(res.text)
  if (res.status !== 200) {
    const hint =
      json && json.error === 'invalid_grant'
        ? ' (refresh token 已失效或被撤销 —— 需要重新跑一次 `node login.mjs` 授权)'
        : ''
    const err = new Error('REFRESH_FAILED' + hint + ' ' + JSON.stringify(json))
    err.code = json && json.error
    throw err
  }
  const next = {
    ...auth,
    access_token: json.access_token,
    refresh_token: json.refresh_token || auth.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  }
  saveAuth(next)
  return next.access_token
}

export async function getToken() {
  if (process.env.MSTODO_ACCESS_TOKEN) return process.env.MSTODO_ACCESS_TOKEN
  const auth = loadAuth()
  if (!auth || !auth.refresh_token) throw new Error('NOT_LOGGED_IN')
  if (auth.access_token && auth.expires_at && Date.now() < auth.expires_at - 120000) {
    return auth.access_token
  }
  return refresh(auth)
}

// ---------- graph ----------

export async function graph(method, url, data) {
  const token = await getToken()
  const res = await httpJson(
    method,
    GRAPH_BASE + url,
    {
      Authorization: 'Bearer ' + token,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    data === undefined ? undefined : JSON.stringify(data),
  )
  const json = parse(res.text)
  if (res.status < 200 || res.status >= 300) {
    const msg = (json && json.error && json.error.message) || res.text
    const err = new Error('GRAPH ' + res.status + ': ' + msg)
    err.status = res.status
    err.body = json
    throw err
  }
  return json
}

export const graphGet = (url) => graph('GET', url)
export const graphPost = (url, data) => graph('POST', url, data)
export const graphPatch = (url, data) => graph('PATCH', url, data)
export const graphDelete = (url) => graph('DELETE', url)
