#!/usr/bin/env node
/** dsh-remote gate v2: fixed-key cookie gate with DUAL upstream.
 *  Primary: the live DESKTOP app instance (port auto-discovered, session
 *  cookie minted from the shared browser-session signing secret in
 *  ~/.dsh/.credentials.yaml — the same secret every instance verifies
 *  against, so this is equivalent to the official token->cookie exchange).
 *  Fallback: the always-on 'dsh web' CLI instance on 17877 (official
 *  token->cookie exchange, token read from its launchd log).
 *  Public side: /?key=<secret> once -> 10y gate cookie; otherwise 401.
 */
import { createServer, request } from 'node:http'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'

const PORT = Number(process.env.GATE_PORT || 17777)
const AUTHORITY = process.env.PUBLIC_AUTHORITY || 'dsh.htgjai.com'
const SECRET_FILE = process.env.GATE_SECRET_FILE || '/Users/ajun/dsh-remote/gate-secret.txt'
const CRED_FILE = process.env.CRED_FILE || '/Users/ajun/.dsh/.credentials.yaml'
const DSH_LOG = process.env.DSH_LOG_FILE || '/Users/ajun/dsh-remote/dsh-web.log'
const WEB_PORT = Number(process.env.UPSTREAM_PORT || 17877)
const COOKIE = 'dshgate'
const MAX_AGE = 315360000
const SIGNATURE = 'dsh web authentication required'
const DAY = 24 * 3600 * 1000
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'set-cookie', 'expect']

const gateSecret = readFileSync(SECRET_FILE, 'utf8').trim()
const gateValue = createHash('sha256').update('gate:' + gateSecret).digest('hex')
const log = (...a) => console.log(new Date().toISOString(), ...a)

const b64u = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const un64u = (s) => { const p = '='.repeat((4 - s.length % 4) % 4); return Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/') + p, 'base64') }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y) }
function gateCookie(req) { const raw = req.headers.cookie; if (!raw) return; for (const s of raw.split(';')) { const i = s.indexOf('='); if (s.slice(0, i).trim() === COOKIE) return s.slice(i + 1).trim() } }
function gateOk(req) { const v = gateCookie(req); return v !== undefined && safeEq(v, gateValue) }

/* ---------- shared signing secret (read once at boot) ---------- */
function loadSigningSecret() {
  const text = readFileSync(CRED_FILE, 'utf8')
  const m = text.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{43})/)
  if (!m) throw new Error('browser-session secret not found in credentials')
  const buf = un64u(m[1])
  if (buf.length !== 32) throw new Error('unexpected secret length ' + buf.length)
  return buf
}
let SIGNING = null
try { SIGNING = loadSigningSecret() } catch (e) { log('signing secret unavailable:', e.message) }
function mintCookie(authority) {
  if (!SIGNING) return null
  const now = Date.now(), exp = now + 29 * DAY
  const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: exp }), 'utf8'))
  const sig = createHmac('sha256', SIGNING).update(body).digest()
  return 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest()) + '=v1.' + body + '.' + b64u(sig)
}

/* ---------- desktop instance discovery ---------- */
let desk = { port: 0 }
let discovering = false
function probe(port) {
  return new Promise((resolve) => {
    const r = request({ host: '127.0.0.1', port, method: 'GET', path: '/', timeout: 1500, headers: { host: '127.0.0.1:' + port } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve(body.includes(SIGNATURE) ? port : 0))
    })
    r.on('timeout', () => { r.destroy(); resolve(0) })
    r.on('error', () => resolve(0))
    r.end()
  })
}
function discover() {
  if (discovering) return
  discovering = true
  execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { maxBuffer: 1 << 20 }, async (err, out) => {
    const ports = []
    const seen = new Set()
    if (!err) for (const line of out.split('\n')) {
      if (!/deepseek/i.test(line)) continue
      const m = line.match(/127\.0\.0\.1:(\d+)/)
      if (m) { const p = Number(m[1]); if (p !== PORT && p !== WEB_PORT && !seen.has(p)) { seen.add(p); ports.push(p) } }
    }
    let found = 0
    for (const p of ports.sort((a, b) => a - b)) { const hit = await probe(p); if (hit) { found = hit; break } }
    if (found !== desk.port) log('desktop upstream', found ? 'detected on :' + found : 'gone — falling back to web instance')
    desk.port = found
    discovering = false
  })
}
discover()
setInterval(discover, 15000).unref()

/* ---------- web-instance session cookie (official token exchange) ---------- */
let webCookie = null, webCookieAt = 0, inflight = null
function readToken() {
  try {
    const all = [...readFileSync(DSH_LOG, 'utf8').matchAll(/token=([A-Za-z0-9_-]{43})/g)]
    return all.length ? all[all.length - 1][1] : undefined
  } catch { return undefined }
}
function adopt(ur) {
  const sc = ur.headers['set-cookie']
  if (!sc) return
  for (const line of Array.isArray(sc) ? sc : [sc]) if (line.startsWith('dsh-auth-')) { webCookie = line.split(';')[0]; webCookieAt = Date.now(); log('web session cookie adopted') }
}
function exchange() {
  if (inflight) return inflight
  inflight = new Promise((resolve, reject) => {
    const token = readToken()
    if (!token) { reject(new Error('no launch token in dsh log yet')); return }
    const r = request({ host: '127.0.0.1', port: WEB_PORT, method: 'GET', path: '/?token=' + token, headers: { host: AUTHORITY } }, (res) => { adopt(res); res.resume(); res.on('end', () => webCookie ? resolve(webCookie) : reject(new Error('exchange gave no cookie, status ' + res.statusCode))) })
    r.on('error', reject); r.end()
  }).finally(() => { inflight = null })
  return inflight
}
async function ensureWebCookie() { if (!webCookie || Date.now() - webCookieAt > 28 * DAY) await exchange() }

/* ---------- forwarding ---------- */
function upstreamHeaders(req, url, mode) {
  const h = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.includes(k)) h[k] = v
  delete h.cookie
  if (mode === 'desktop') {
    h.host = '127.0.0.1:' + desk.port
    delete h.origin
    const c = mintCookie(h.host)
    if (c) h.cookie = c
  } else {
    h.host = AUTHORITY
    if (webCookie) h.cookie = webCookie
  }
  return h
}
function resHeaders(ur) { const h = {}; for (const [k, v] of Object.entries(ur.headers)) if (!HOP.includes(k)) h[k] = v; return h }

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://g')
    if (u.pathname === '/gate/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, upstream: desk.port ? 'desktop:' + desk.port : 'web', webCookie: !!webCookie, minting: !!SIGNING }))
      return
    }
    const key = u.searchParams.get('key')
    if (key !== null) u.searchParams.delete('key')
    if (key !== null && safeEq(key, gateSecret)) {
      res.writeHead(303, { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': COOKIE + '=' + gateValue + '; Max-Age=' + MAX_AGE + '; Path=/; HttpOnly; SameSite=Strict' })
      res.end(); log('gate key accepted, cookie issued'); return
    }
    if (!gateOk(req)) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('dsh-remote gate: unauthorized\n'); return }
    const mode = desk.port ? 'desktop' : 'web'
    if (mode === 'web') await ensureWebCookie()
    const up = request({ host: '127.0.0.1', port: mode === 'desktop' ? desk.port : WEB_PORT, method: req.method, path: u.pathname + (u.search || ''), headers: upstreamHeaders(req, u, mode) }, (ur) => {
      adopt(ur)
      if (ur.statusCode === 401 && mode === 'web') { webCookie = null; log('web upstream 401, session dropped') }
      res.writeHead(ur.statusCode, resHeaders(ur))
      ur.pipe(res)
    })
    up.on('error', (e) => {
      log('upstream error', mode, e.message)
      if (mode === 'desktop') discover()
      try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('gate: upstream unavailable (' + mode + ')\n') } catch {}
    })
    req.pipe(up)
  } catch (e) {
    log('request failure', e.message)
    try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('gate: ' + e.message + '\n') } catch {}
  }
})

server.on('upgrade', (req, socket, head) => {
  (async () => {
    if (!gateOk(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    const mode = desk.port ? 'desktop' : 'web'
    if (mode === 'web') await ensureWebCookie()
    const headers = upstreamHeaders(req, new URL(req.url, 'http://g'), mode)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade || 'websocket'
    const up = request({ host: '127.0.0.1', port: mode === 'desktop' ? desk.port : WEB_PORT, method: req.method, path: req.url, headers })
    up.on('upgrade', (ur, usock, uhead) => {
      let out = 'HTTP/1.1 101 Switching Protocols\r\n'
      for (const [k, v] of Object.entries(ur.headers)) out += k + ': ' + (Array.isArray(v) ? v.join(', ') : v) + '\r\n'
      socket.write(out + '\r\n')
      if (uhead && uhead.length) socket.write(uhead)
      usock.pipe(socket); socket.pipe(usock)
      const bye = () => { usock.destroy(); socket.destroy() }
      usock.on('error', bye); socket.on('error', bye); usock.on('close', () => socket.destroy()); socket.on('close', () => usock.destroy())
    })
    up.on('response', (ur) => { socket.write('HTTP/1.1 ' + ur.statusCode + ' Bad Gateway\r\nConnection: close\r\n\r\n'); socket.destroy() })
    up.on('error', () => socket.destroy())
    up.end()
  })().catch(() => { try { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') } catch {}; socket.destroy() })
})

server.listen(PORT, '127.0.0.1', () => log('gate v2 (dual upstream) on 127.0.0.1:' + PORT + ' -> desktop(auto) | web:' + WEB_PORT))
