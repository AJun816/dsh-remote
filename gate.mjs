#!/usr/bin/env node
/** dsh-remote gate: fixed-key cookie gate in front of dsh web.
 *  /?key=<secret>  -> 303 + 10y gate cookie (dshgate)
 *  no/invalid gate cookie -> 401 ; everything else proxied to upstream
 *  dsh web with an auto-refreshed browser-session cookie (official
 *  token->cookie exchange, token read from the dsh web launchd log).
 */
import { createServer, request } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

const PORT = Number(process.env.GATE_PORT || 17777)
const UP_HOST = process.env.UPSTREAM_HOST || '127.0.0.1'
const UP_PORT = Number(process.env.UPSTREAM_PORT || 17877)
const AUTHORITY = process.env.PUBLIC_AUTHORITY || 'dsh.htgjai.com'
const SECRET_FILE = process.env.GATE_SECRET_FILE || '/Users/ajun/dsh-remote/gate-secret.txt'
const DSH_LOG = process.env.DSH_LOG_FILE || '/Users/ajun/dsh-remote/dsh-web.log'
const COOKIE = 'dshgate'
const MAX_AGE = 315360000 // 10 years
const RENEW_AFTER_MS = 28 * 24 * 3600 * 1000

const gateSecret = readFileSync(SECRET_FILE, 'utf8').trim()
const gateValue = createHash('sha256').update('gate:' + gateSecret).digest('hex')
const log = (...a) => console.log(new Date().toISOString(), ...a)

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
function gateCookie(req) {
  const raw = req.headers.cookie
  if (!raw) return undefined
  for (const seg of raw.split(';')) {
    const i = seg.indexOf('=')
    if (seg.slice(0, i).trim() === COOKIE) return seg.slice(i + 1).trim()
  }
  return undefined
}
function gateOk(req) { const v = gateCookie(req); return v !== undefined && safeEq(v, gateValue) }

function readToken() {
  try {
    const text = readFileSync(DSH_LOG, 'utf8')
    const all = [...text.matchAll(/token=([A-Za-z0-9_-]{43})/g)]
    return all.length ? all[all.length - 1][1] : undefined
  } catch { return undefined }
}

let upCookie = null, upCookieAt = 0, inflight = null
function adopt(ur) {
  const sc = ur.headers['set-cookie']
  if (!sc) return
  for (const line of Array.isArray(sc) ? sc : [sc]) {
    if (line.startsWith('dsh-auth-')) { upCookie = line.split(';')[0]; upCookieAt = Date.now(); log('session cookie adopted') }
  }
}
function exchange() {
  if (inflight) return inflight
  inflight = new Promise((resolve, reject) => {
    const token = readToken()
    if (!token) { reject(new Error('no launch token in dsh log yet')); return }
    const r = request({ host: UP_HOST, port: UP_PORT, method: 'GET', path: '/?token=' + token, headers: { host: AUTHORITY } }, (res) => {
      adopt(res); res.resume(); res.on('end', () => upCookie ? resolve(upCookie) : reject(new Error('exchange gave no cookie, status ' + res.statusCode)))
    })
    r.on('error', reject); r.end()
  }).finally(() => { inflight = null })
  return inflight
}
async function ensureCookie() {
  if (upCookie && Date.now() - upCookieAt < RENEW_AFTER_MS) return
  await exchange()
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'set-cookie', 'expect'])
function fwdHeaders(req, url) {
  const h = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v
  delete h.cookie
  h.host = AUTHORITY
  if (upCookie) h.cookie = upCookie
  return h
}
function resHeaders(ur) {
  const h = {}
  for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) h[k] = v
  return h
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://g')
    if (u.pathname === '/gate/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, sessionCookie: !!upCookie }))
      return
    }
    const key = u.searchParams.get('key')
    if (key !== null) u.searchParams.delete('key')
    if (key !== null && safeEq(key, gateSecret)) {
      res.writeHead(303, { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'set-cookie': COOKIE + '=' + gateValue + '; Max-Age=' + MAX_AGE + '; Path=/; HttpOnly; SameSite=Strict' })
      res.end(); log('gate key accepted, cookie issued'); return
    }
    if (!gateOk(req)) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('dsh-remote gate: unauthorized\n'); return }
    await ensureCookie()
    const up = request({ host: UP_HOST, port: UP_PORT, method: req.method, path: u.pathname + (u.search || ''), headers: fwdHeaders(req, u) }, (ur) => {
      adopt(ur)
      if (ur.statusCode === 401) { upCookie = null; log('upstream 401, session dropped; refresh to re-exchange') }
      res.writeHead(ur.statusCode, resHeaders(ur))
      ur.pipe(res)
    })
    up.on('error', (e) => { log('upstream error', e.message); try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('gate: upstream unavailable\n') } catch {} })
    req.pipe(up)
  } catch (e) {
    log('request failure', e.message)
    try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('gate: ' + e.message + '\n') } catch {}
  }
})

server.on('upgrade', (req, socket, head) => {
  (async () => {
    if (!gateOk(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    await ensureCookie()
    const headers = fwdHeaders(req, new URL(req.url, 'http://g'))
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade || 'websocket'
    const up = request({ host: UP_HOST, port: UP_PORT, method: req.method, path: req.url, headers })
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

server.listen(PORT, '127.0.0.1', () => log('gate listening on 127.0.0.1:' + PORT + ' -> ' + UP_HOST + ':' + UP_PORT + ' as ' + AUTHORITY))
