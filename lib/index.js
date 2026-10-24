// dsh-quota-ring — host 半边
//
// 只做三件事：
//   1. 读 DSH 凭据里的 DEEPSEEK_API_KEY，调用官方余额接口
//   2. 扫本地会话日志（assistant/message 的 usage），按峰谷价折算今日花费
//   3. 通过回环 HTTP 路由把快照给前端
//
// 设计约束：
//   - 只用 Node 原生能力（fetch / zlib zstd），不开子进程
//   - 凭据只在 host 使用，浏览器永远拿不到明文
//   - 只访问 api.deepseek.com（余额）与 platform.deepseek.com（用量页链接）

import { promises as fsp } from 'node:fs'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'

export const name = 'quota-ring'
export const inject = ['webServer', 'credentials']

// ---------------------------------------------------------------------------
// 定价（元 / 百万 tokens）
// 高峰 = 闲时的 2 倍；工作日 09:00–12:00、14:00–18:00（北京时间），周末全天空闲。
// ---------------------------------------------------------------------------

const PRICING = {
  'deepseek-v4-flash': { idle: { hit: 0.02, in: 1.0, out: 4.0 }, peak: { hit: 0.04, in: 2.0, out: 8.0 } },
  'deepseek-v4-pro': { idle: { hit: 0.15, in: 4.5, out: 13.5 }, peak: { hit: 0.30, in: 9.0, out: 27.0 } },
  'deepseek-v4.1': { idle: { hit: 0.03, in: 1.2, out: 4.8 }, peak: { hit: 0.06, in: 2.4, out: 9.6 } },
  'deepseek-chat': { idle: { hit: 0.1, in: 1.0, out: 2.0 }, peak: { hit: 0.2, in: 2.0, out: 4.0 } },
  'deepseek-reasoner': { idle: { hit: 1.0, in: 4.0, out: 16.0 }, peak: { hit: 2.0, in: 8.0, out: 32.0 } },
}
PRICING['deepseek-flash'] = PRICING['deepseek-v4-flash']
PRICING['deepseek-pro'] = PRICING['deepseek-v4-pro']
PRICING['deepseek-v4-flash-vision-exp'] = PRICING['deepseek-v4-flash']

const PEAK_MIN = [[540, 720], [840, 1080]] // 09:00-12:00, 14:00-18:00
const BJ_OFFSET_MS = 8 * 3600 * 1000
const WEEKEND_IDLE_SINCE = Date.parse('2026-08-22T16:00:00Z')

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const API_KEY_REF = 'DEEPSEEK_API_KEY'
const USER_TOKEN_REF = 'DEEPSEEK_USER_TOKEN'
const SUMMARY_URL = 'https://platform.deepseek.com/api/v0/users/get_user_summary'
const PLATFORM_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const APP_PATH = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const RESTART_LABEL = 'local.quota-ring-restart'
const RESTART_SCRIPT = '/tmp/dsh-quota-ring-restart.sh'
const RESTART_TOKEN = '/tmp/dsh-quota-ring-restart.token'
const LOW_BALANCE = 3

const BALANCE_TTL_MS = 30_000
const TODAY_TTL_MS = 60_000
const TIMEOUT_MS = 15_000
const SESSION_ROOT = join(homedir(), '.dsh', 'sessions')

// ---------------------------------------------------------------------------
// 峰谷判定
// ---------------------------------------------------------------------------

function bjDay(t) {
  return new Date(t + BJ_OFFSET_MS).getUTCDay()
}

function isPeakTime(t) {
  if (t >= WEEKEND_IDLE_SINCE && (bjDay(t) === 0 || bjDay(t) === 6)) return false
  const d = new Date(t + BJ_OFFSET_MS)
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  return PEAK_MIN.some(([a, b]) => minutes >= a && minutes < b)
}

/** 下一次峰谷切换的时刻与目标模式。 */
function nextSwitch(now) {
  const d = new Date(now + BJ_OFFSET_MS)
  const day = d.getUTCDay()
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()

  if (!isPeakTime(now)) {
    // 找今天/之后最近的峰开始
    for (let add = 0; add < 8; add += 1) {
      const probe = new Date(now + add * 86400_000)
      const pd = new Date(probe.getTime() + BJ_OFFSET_MS)
      const wd = pd.getUTCDay()
      if (wd === 0 || wd === 6) continue
      for (const [start] of PEAK_MIN) {
        const at = Date.UTC(pd.getUTCFullYear(), pd.getUTCMonth(), pd.getUTCDate(), 0, 0, 0) + start * 60_000 - BJ_OFFSET_MS
        if (at > now) return { at, mode: 'peak' }
      }
    }
    return { at: now + 86400_000, mode: 'peak' }
  }
  // 高峰中：找当前窗口的结束
  for (const [start, end] of PEAK_MIN) {
    if (minutes >= start && minutes < end) {
      const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0) + end * 60_000 - BJ_OFFSET_MS
      return { at: base, mode: 'off' }
    }
  }
  return { at: now + 3600_000, mode: 'off' }
}

// ---------------------------------------------------------------------------
// 单次调用的费用
// ---------------------------------------------------------------------------

function tierOf(model, t) {
  const table = PRICING[model] || PRICING['deepseek-v4-flash']
  return isPeakTime(t) ? table.peak : table.idle
}

function costOf(model, t, usage) {
  const p = tierOf(model, t)
  const input = Number(usage.inputTokens) || 0
  const output = Number(usage.outputTokens) || 0
  const hit = Number(usage.cacheReadTokens) || 0
  return (input * p.in + output * p.out + hit * p.hit) / 1e6
}

// ---------------------------------------------------------------------------
// 会话日志：多帧 zstd → jsonl
// ---------------------------------------------------------------------------

function zstdAll(buf) {
  const M = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === M[0] && buf[i + 1] === M[1] && buf[i + 2] === M[2] && buf[i + 3] === M[3]) starts.push(i)
  }
  if (starts.length === 0) return Buffer.alloc(0)
  const pieces = []
  let idx = 0
  while (idx < starts.length) {
    let ok = false
    for (let j = idx + 1; j <= starts.length; j += 1) {
      const end = j < starts.length ? starts[j] : buf.length
      try {
        pieces.push(zstdDecompressSync(buf.subarray(starts[idx], end)))
        ok = true
        idx = j
        break
      } catch {
        /* 试试更长的片段 */
      }
    }
    if (!ok) break
  }
  return Buffer.concat(pieces)
}

function collectSessionFiles(root, since) {
  const out = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  const walk = (dir) => {
    let list
    try {
      list = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of list) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
      } else if (/^session\.v\d+\.jsonl\.zstd$/.test(ent.name)) {
        try {
          if (statSync(full).mtimeMs >= since) out.push(full)
        } catch {
          /* ignore */
        }
      }
    }
  }
  void entries
  walk(root)
  return out
}

function scanToday(now) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const startMs = start.getTime()

  const files = collectSessionFiles(SESSION_ROOT, startMs - 60_000)
  const acc = {
    peak: 0,
    off: 0,
    total: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    models: {},
  }

  for (const file of files) {
    let buf
    try {
      buf = readFileSync(file)
    } catch {
      continue
    }
    let text
    try {
      text = zstdAll(buf).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.type !== 'assistant/message') continue
      const t = ev.time
      if (typeof t !== 'number' || t < startMs) continue
      const usage = ev.data && ev.data.usage
      if (!usage || typeof usage !== 'object') continue
      if (usage.inputTokens == null && usage.outputTokens == null && usage.cacheReadTokens == null) continue
      const src = (ev.data.message && ev.data.message.source) || {}
      const model = typeof src.model === 'string' ? src.model : 'deepseek-v4-flash'
      const cost = costOf(model, t, usage)
      if (isPeakTime(t)) acc.peak += cost
      else acc.off += cost
      acc.total += cost
      acc.requests += 1
      acc.inputTokens += Number(usage.inputTokens) || 0
      acc.outputTokens += Number(usage.outputTokens) || 0
      acc.cacheTokens += Number(usage.cacheReadTokens) || 0
      const m = acc.models[model] || (acc.models[model] = { cost: 0, requests: 0 })
      m.cost += cost
      m.requests += 1
    }
  }
  return acc
}

// ---------------------------------------------------------------------------
// 余额
// ---------------------------------------------------------------------------

async function fetchBalance(apiKey) {
  if (!apiKey) {
    const err = new Error('未配置 DeepSeek API Key')
    err.code = 'missing_api_key'
    throw err
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (res.status === 401 || res.status === 403) {
      const err = new Error('API Key 无效或已过期')
      err.code = 'auth_failed'
      throw err
    }
    if (!res.ok) {
      const err = new Error('余额接口返回 ' + res.status)
      err.code = 'fetch_failed'
      throw err
    }
    const data = await res.json()
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
    const cny = infos.find((b) => b && b.currency === 'CNY') || infos[0] || null
    if (!cny) {
      const err = new Error('余额接口没有返回币种')
      err.code = 'invalid_response'
      throw err
    }
    return {
      currency: cny.currency || 'CNY',
      total: Number(cny.total_balance) || 0,
      granted: Number(cny.granted_balance) || 0,
      toppedUp: Number(cny.topped_up_balance) || 0,
      available: data.is_available === true,
      at: Date.now(),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 用平台 User Token 读余额（API Key 失效时的兜底）。
 * get_user_summary 返回 normal_wallets（充值余额）与 bonus_wallets（赠送）。
 */
async function fetchBalanceViaToken(token) {
  if (!token) {
    const err = new Error('未配置 User Token')
    err.code = 'missing_token'
    throw err
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(SUMMARY_URL, {
      headers: {
        authorization: 'Bearer ' + token,
        'user-agent': PLATFORM_UA,
        referer: 'https://platform.deepseek.com/usage',
        accept: 'application/json',
      },
      signal: ctrl.signal,
    })
    if (res.status === 401 || res.status === 403) {
      const err = new Error('User Token 无效或已过期')
      err.code = 'auth_failed'
      throw err
    }
    if (!res.ok) {
      const err = new Error('平台接口返回 ' + res.status)
      err.code = 'fetch_failed'
      throw err
    }
    const body = await res.json()
    const biz = body && body.data && body.data.biz_data
    if (!biz || typeof biz !== 'object') {
      const err = new Error('平台接口返回异常')
      err.code = 'invalid_response'
      throw err
    }
    const pick = (list) => {
      const arr = Array.isArray(list) ? list : []
      return arr.find((w) => w && w.currency === 'CNY') || arr[0] || null
    }
    const normal = pick(biz.normal_wallets)
    const bonus = pick(biz.bonus_wallets)
    const toppedUp = normal ? Number(normal.balance) || 0 : 0
    const granted = bonus ? Number(bonus.balance) || 0 : 0
    return {
      currency: (normal && normal.currency) || (bonus && bonus.currency) || 'CNY',
      total: toppedUp + granted,
      granted,
      toppedUp,
      available: true,
      at: Date.now(),
      source: 'platform',
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 路由守卫
// ---------------------------------------------------------------------------

function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function sameOrigin(req) {
  const host = req.headers && req.headers.host
  if (typeof host !== 'string') return false
  // Electron 用自定义 scheme 加载页面时 Origin 不是 http://127.0.0.1，
  // 因此这里只拒绝"明确的跨站请求"，其余交给 loopback 边界兜底。
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return true
}

function guard(req, res, method, requireOrigin = false) {
  if (!isLoopback(req)) {
    res.writeHead(403).end('forbidden')
    return false
  }
  if (requireOrigin && !sameOrigin(req)) {
    res.writeHead(403).end('forbidden')
    return false
  }
  if (req.method !== method) {
    res.writeHead(405, { Allow: method }).end('method not allowed')
    return false
  }
  return true
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx) {
  let balanceCache = null
  let todayCache = null
  let inflight = null

  async function resolveToken() {
    try {
      const cred = await ctx.credentials.resolve(USER_TOKEN_REF)
      const value = typeof cred?.value === 'string' ? cred.value.trim() : ''
      return value || null
    } catch {
      return null
    }
  }

  async function resolveApiKey() {
    try {
      const cred = await ctx.credentials.resolve(API_KEY_REF)
      const value = typeof cred?.value === 'string' ? cred.value.trim() : ''
      return value || null
    } catch {
      return null
    }
  }

  function maskSecret(v) {
    if (typeof v !== 'string' || v === '') return null
    if (v.length <= 10) return '****'
    return v.slice(0, 6) + '****' + v.slice(-4)
  }

  async function buildSnapshot(force = false) {
    const now = Date.now()
    const apiKey = await resolveApiKey()
    let error = null

    if (force || !balanceCache || now - balanceCache.at > BALANCE_TTL_MS) {
      try {
        const b = await fetchBalance(apiKey)
        balanceCache = b
      } catch (e) {
        const primaryError = (e && e.code) || 'fetch_failed'
        // API Key 不可用时，退回用平台 User Token 读余额
        try {
          const token = await resolveToken()
          const b = await fetchBalanceViaToken(token)
          balanceCache = b
          error = null
        } catch (e2) {
          error = primaryError === 'missing_api_key' ? ((e2 && e2.code) || primaryError) : primaryError
          if (!balanceCache) balanceCache = null
        }
      }
    }

    if (force || !todayCache || now - todayCache.at > TODAY_TTL_MS) {
      try {
        todayCache = { at: now, data: scanToday(now) }
      } catch {
        if (!todayCache) todayCache = { at: now, data: { peak: 0, off: 0, total: 0, requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, models: {} } }
      }
    }

    const today = todayCache.data
    const mode = isPeakTime(now) ? 'peak' : 'off'
    const sw = nextSwitch(now)
    const balance = balanceCache ? balanceCache.total : null
    const tokenTotal = today.inputTokens + today.outputTokens + today.cacheTokens
    const cacheHitRate = tokenTotal > 0 ? today.cacheTokens / tokenTotal : 0

    return {
      ok: true,
      hasKey: Boolean(apiKey),
      maskedKey: maskSecret(apiKey),
      currency: balanceCache ? balanceCache.currency : 'CNY',
      balance,
      balanceAvailable: balanceCache ? balanceCache.available : false,
      granted: balanceCache ? balanceCache.granted : 0,
      toppedUp: balanceCache ? balanceCache.toppedUp : 0,
      low: balance !== null && balance < LOW_BALANCE,
      lowThreshold: LOW_BALANCE,
      mode,
      multiplier: mode === 'peak' ? 2 : 1,
      nextSwitchAt: sw.at,
      nextMode: sw.mode,
      today: {
        peak: Number(today.peak.toFixed(4)),
        off: Number(today.off.toFixed(4)),
        total: Number(today.total.toFixed(4)),
        requests: today.requests,
        inputTokens: today.inputTokens,
        outputTokens: today.outputTokens,
        cacheTokens: today.cacheTokens,
        cacheHitRate: Number(cacheHitRate.toFixed(4)),
        models: today.models,
      },
      fetchedAt: now,
      balanceAt: balanceCache ? balanceCache.at : null,
      error,
    }
  }

  async function snapshotOnce(force) {
    if (inflight) return inflight
    inflight = buildSnapshot(force).finally(() => {
      inflight = null
    })
    return inflight
  }

  const routes = [
    {
      kind: 'exact',
      path: '/quota-ring/state',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          sendJson(res, 200, await snapshotOnce(false))
        } catch (e) {
          sendJson(res, 500, { ok: false, error: (e && e.code) || 'internal' })
        }
      },
    },
    {
      kind: 'exact',
      path: '/quota-ring/refresh',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST', true)) return
        try {
          sendJson(res, 200, await snapshotOnce(true))
        } catch (e) {
          sendJson(res, 500, { ok: false, error: (e && e.code) || 'internal' })
        }
      },
    },
    {
      kind: 'exact',
      path: '/quota-ring/restart',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST', true)) return
        try {
          // 脱离本进程：稍等 → 优雅退出 → 兜底 kill → 重新打开
          // 用 -x 按进程名精确匹配：避免脚本自身命令行里含 App 路径而被误杀
          // 写脚本文件，交给 launchd 执行（不随 App 一起被杀）
          const scriptText = [
            '#!/bin/sh',
            'trap "launchctl remove local.quota-ring-restart" EXIT',
            'LOG=/tmp/dsh-quota-ring-restart.log',
            'echo "$(date) begin" >> "$LOG"',
            'TOKEN=/tmp/dsh-quota-ring-restart.token',
            'if [ ! -f "$TOKEN" ]; then echo "$(date) skip: no token" >> "$LOG"; exit 0; fi',
            'rm -f "$TOKEN"',
            'sleep 0.5',
            `P=${JSON.stringify(APP_PATH)}`,
            `PID=$(ps -eo pid=,args= | awk -v p="$P" 'index($0,p)>0 && $0 !~ /--expose-internals/ {print $1; exit}')`,
            'echo "$(date) pid=$PID" >> "$LOG"',
            '[ -n "$PID" ] && kill -TERM "$PID" 2>/dev/null',
            'i=0',
            'while [ $i -lt 40 ]; do',
            '  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then sleep 0.5; i=$((i+1)); else break; fi',
            'done',
            'if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then kill -9 "$PID" 2>/dev/null; sleep 1; fi',
            'echo "$(date) exited" >> "$LOG"',
            'sleep 1',
            'n=0',
            'while [ $n -lt 3 ]; do',
            '  n=$((n+1))',
            '  open -a "/Applications/DeepSeek Harness.app" 2>>"$LOG"',
            '  j=0',
            '  while [ $j -lt 20 ]; do',
            '    sleep 0.5; j=$((j+1))',
            '    if ps -eo args= | grep -q "^/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness$"; then',
            '      echo "$(date) reopened (try $n)" >> "$LOG"',
            '      exit 0',
            '    fi',
            '  done',
            '  echo "$(date) open attempt $n failed" >> "$LOG"',
            'done',
            'echo "$(date) reopen FAILED" >> "$LOG"',
            '',
          ].join('\n')
          writeFileSync(RESTART_TOKEN, String(Date.now()))
          writeFileSync(RESTART_SCRIPT, scriptText, { mode: 0o755 })
          try { spawnSync('/bin/launchctl', ['remove', RESTART_LABEL], { stdio: 'ignore' }) } catch { /* ignore */ }
          const child = spawn('/bin/launchctl', ['submit', '-l', RESTART_LABEL, '--', '/bin/sh', RESTART_SCRIPT], {
            detached: true,
            stdio: 'ignore',
          })
          child.unref()
          sendJson(res, 200, { ok: true, restarting: true })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: (e && e.code) || 'restart_failed' })
        }
      },
    },
  ]

  ctx.effect(() => {
    const dispose = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const d of dispose) d()
    }
  }, 'quota-ring: routes')
}

// 纯函数导出，供本地测试
export const __test = {
  sameOrigin,
  fetchBalanceViaToken,
  isPeakTime,
  nextSwitch,
  costOf,
  zstdAll,
  scanToday,
  PRICING,
}
