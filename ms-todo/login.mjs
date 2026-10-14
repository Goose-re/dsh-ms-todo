// One-time device-code login.
//
//   node login.mjs            request a fresh code, print it, then poll
//   node login.mjs --reuse    poll the code already stored in devicecode.json
//
// On success the tokens are written to auth.json and LOGIN_OK is printed.
import fs from 'node:fs'
import path from 'node:path'
import { DIR, saveAuth, httpJson, parse } from './graph.mjs'

const CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
const TENANT = 'common'
// Re-authorizing with a NARROWER scope than was granted would hand back a
// refresh token with the narrower scope, silently losing access. Keep this in
// sync with what the device code was requested for.
const SCOPE = 'offline_access Tasks.ReadWrite Calendars.ReadWrite MailboxSettings.Read User.Read'
const deviceFile = path.join(DIR, 'devicecode.json')

async function requestCode() {
  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString()
  const res = await httpJson(
    'POST',
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`,
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  )
  const json = parse(res.text)
  if (res.status !== 200) throw new Error('DEVICECODE_FAILED ' + JSON.stringify(json))
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(deviceFile, JSON.stringify(json, null, 2), 'utf8')
  return json
}

const reuse = process.argv.includes('--reuse')
const device = reuse
  ? JSON.parse(fs.readFileSync(deviceFile, 'utf8').replace(/^\uFEFF/, ''))
  : await requestCode()

console.log('CODE=' + device.user_code)
console.log('URL=' + device.verification_uri)
console.log(device.message)

let interval = (device.interval || 5) * 1000
const deadline = Date.now() + (device.expires_in || 900) * 1000 - 8000
const body = new URLSearchParams({
  client_id: CLIENT_ID,
  grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  device_code: device.device_code,
}).toString()

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, interval))
  let status = 0
  let json = null
  try {
    const res = await httpJson(
      'POST',
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    )
    status = res.status
    json = parse(res.text)
  } catch (e) {
    console.log('net-retry: ' + String(e.message))
    continue
  }
  if (status === 200 && json && json.access_token) {
    saveAuth({
      client_id: CLIENT_ID,
      tenant: TENANT,
      scope: SCOPE,
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + json.expires_in * 1000,
      signed_in_at: new Date().toISOString(),
    })
    console.log('LOGIN_OK')
    process.exit(0)
  }
  const err = json && json.error
  if (err === 'authorization_pending') continue
  if (err === 'slow_down') {
    interval += 5000
    continue
  }
  console.log('LOGIN_ERROR ' + JSON.stringify(json))
  process.exit(1)
}
console.log('LOGIN_TIMEOUT')
process.exit(1)
