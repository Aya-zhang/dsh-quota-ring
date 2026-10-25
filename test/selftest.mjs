// quota-ring 自测：只测纯函数，不启动 DSH、不联网。
//
// 运行（用 DSH 自带的 Node，无需单独安装）：
//   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/selftest.mjs
//
// 或者（本机已装 Node）：
//   node test/selftest.mjs

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { __test } = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const { sameOrigin, isPeakTime, costOf, createSnapshotRunner, normalizeLowBalance } = __test

let pass = 0
let fail = 0

function ok(name, got, want) {
  const good = got === want
  good ? pass++ : fail++
  console.log(`  ${good ? '✓' : '✗'} ${name}${good ? '' : `   → 得到 ${got}，期望 ${want}`}`)
}

function near(name, got, want, eps = 1e-9) {
  const good = typeof got === 'number' && Math.abs(got - want) < eps
  good ? pass++ : fail++
  console.log(`  ${good ? '✓' : '✗'} ${name}${good ? '' : `   → 得到 ${got}，期望 ${want}`}`)
}

// ---------------------------------------------------------------------------
// 构造假的请求对象
// ---------------------------------------------------------------------------
const req = (host, origin, site) => ({
  headers: {
    ...(host === undefined ? {} : { host }),
    ...(origin === undefined ? {} : { origin }),
    ...(site === undefined ? {} : { 'sec-fetch-site': site }),
  },
})

// 北京时间 → 时间戳
const BJ = (s) => Date.parse(s + '+08:00')

console.log('\n[1] 请求来源校验 sameOrigin()')

// —— 必须拒绝的伪造请求 ——
ok('伪造 Host + 伪造 Origin', sameOrigin(req('attacker.example', 'https://attacker.example')), false)
ok('正常 Host + 恶意 Origin', sameOrigin(req('127.0.0.1:1234', 'https://attacker.example')), false)
ok('伪造 Host + 无 Origin', sameOrigin(req('attacker.example')), false)
ok('正常 Host + cross-site', sameOrigin(req('127.0.0.1:1234', 'http://127.0.0.1:1234', 'cross-site')), false)
ok('端口不一致', sameOrigin(req('127.0.0.1:1234', 'http://127.0.0.1:9999')), false)
ok('无 Host 头', sameOrigin(req(undefined)), false)

// —— 必须放行的正常请求 ——
ok('正常 Host + 无 Origin', sameOrigin(req('127.0.0.1:1234')), true)
ok('正常 Host + 同源 Origin', sameOrigin(req('127.0.0.1:1234', 'http://127.0.0.1:1234')), true)
ok('localhost + 无 Origin', sameOrigin(req('localhost:1234')), true)
ok('应用自身 dsh-app://app 来源', sameOrigin(req('127.0.0.1:1234', 'dsh-app://app')), true)
ok('伪造 dsh-app://evil 来源', sameOrigin(req('127.0.0.1:1234', 'dsh-app://evil')), false)

console.log('\n[2] 峰谷判断 isPeakTime()')
ok('周一 08:59 闲时', isPeakTime(BJ('2026-10-26T08:59:00')), false)
ok('周一 09:00 高峰（起始）', isPeakTime(BJ('2026-10-26T09:00:00')), true)
ok('周一 12:00 闲时（结束边界）', isPeakTime(BJ('2026-10-26T12:00:00')), false)
ok('周一 15:00 高峰', isPeakTime(BJ('2026-10-26T15:00:00')), true)
ok('周六 10:00 全天闲时', isPeakTime(BJ('2026-10-24T10:00:00')), false)

console.log('\n[3] 费用计算 costOf()　deepseek-v4-flash')
const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }
near('闲时 1M+1M+1M = 1 + 4 + 0.02', costOf('deepseek-v4-flash', BJ('2026-10-26T13:00:00'), usage), 5.02)
near('高峰 1M+1M+1M = 2 + 8 + 0.04', costOf('deepseek-v4-flash', BJ('2026-10-26T10:00:00'), usage), 10.04)

console.log('\n[4] 低余额阈值配置 normalizeLowBalance()')
ok('默认无配置 → 3', normalizeLowBalance(undefined), 3)
ok('配置 5 → 5', normalizeLowBalance(5), 5)
ok('配置字符串 "8" → 8', normalizeLowBalance('8'), 8)
ok('配置 0 合法 → 0', normalizeLowBalance(0), 0)
ok('配置负数回落到 3', normalizeLowBalance(-1), 3)
ok('配置非数字回落到 3', normalizeLowBalance('abc'), 3)
ok('配置 null 回落到 3', normalizeLowBalance(null), 3)

console.log('\n[5] 快照调度（并发行为）')
{
  const calls = { n: 0 }
  const makeBuild = (delay, tag) => () => {
    calls.n += 1
    return new Promise((r) => setTimeout(() => r({ tag }), delay))
  }

  // 4 个并发的强制刷新 → 只应调用 1 次
  calls.n = 0
  let run = createSnapshotRunner(makeBuild(25, 'force'))
  const rs = await Promise.all([run(true), run(true), run(true), run(true)])
  ok('4 个并发强制刷新只调用 1 次', calls.n, 1)
  ok('4 个调用拿到同一份结果', new Set(rs.map((r) => r.tag)).size, 1)

  // 2 个并发普通读取 → 只应调用 1 次
  calls.n = 0
  run = createSnapshotRunner(makeBuild(25, 'get'))
  await Promise.all([run(false), run(false)])
  ok('2 个并发普通读取只调用 1 次', calls.n, 1)

  // 普通读取进行中来了强制刷新 → 等它结束再取一次（共 2 次）
  calls.n = 0
  run = createSnapshotRunner(makeBuild(25, 'mix'))
  const p1 = run(false)
  await new Promise((r) => setTimeout(r, 5))
  const p2 = run(true)
  await Promise.all([p1, p2])
  ok('GET 进行中来了 force → 共调用 2 次', calls.n, 2)

  // 强刷排队期间来的普通读取 → 共享，不额外调用
  calls.n = 0
  run = createSnapshotRunner(makeBuild(25, 'share'))
  const f = run(true)
  await new Promise((r) => setTimeout(r, 5))
  const g = run(false)
  await Promise.all([f, g])
  ok('强刷排队期间的普通读取不额外调用', calls.n, 1)
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
