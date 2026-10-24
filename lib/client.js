// dsh-quota-ring — client 半边（手写 bundle，无需构建）
//
// 徽章挂在侧边栏底部（sidebar.footer.action）：
//   [圆环] 余额 [小圈] ¥20.99            今日：¥3.34
// 圆环 = 今日花费的峰/闲占比；环心 = 当前倍率（2× 黄 / 1× 绿）
window.__ModuleLoader__.load({
  id: 'dsh-quota-ring',
  factory: function (require) {
    const React = require('react')
    const h = React.createElement

    const STATE_URL = '/quota-ring/state'
    const REFRESH_URL = '/quota-ring/refresh'
    const TOPUP_URL = 'https://platform.deepseek.com/top_up'
    const USAGE_URL = 'https://platform.deepseek.com/usage'
    const REFRESH_MS = 60_000
    const AMOUNT_TTL = 1700
    const POP_W = 232 // 弹层宽度，需与 .qr-pop 的 width 一致

    // ---------------------------------------------------------------------
    // 样式（注入一次）
    // ---------------------------------------------------------------------
    const CSS = `
.qr-badge{display:flex;align-items:center;gap:3px;height:44px;padding:0 2px;border-radius:12px;width:auto;box-sizing:border-box;
  background:transparent;border:none;position:relative;user-select:none;min-width:0;cursor:pointer;letter-spacing:-0.35px;
  transition:background-color .12s ease}
.qr-badge:hover{background:rgba(255,255,255,0.17)}
.qr-badge.qr-low::after{content:"";position:absolute;inset:-1px;border-radius:10px;pointer-events:none;
  animation:qr-breathe 2s ease-out infinite}
@keyframes qr-breathe{0%{box-shadow:0 0 0 0 rgba(255,92,122,.38)}70%{box-shadow:0 0 0 8px rgba(255,92,122,0)}100%{box-shadow:0 0 0 0 rgba(255,92,122,0)}}
.qr-ring{position:relative;flex:none;width:20px;height:20px;cursor:pointer;margin:0}
.qr-ring.qr-spin>svg{animation:qr-rot .8s linear infinite}
.qr-ring>svg{position:absolute;inset:0;display:block;width:100%;height:100%;transform:rotate(-90deg)}
.qr-ico svg{width:8px;height:8px}
.qr-ico{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.qr-lbl{font-size:12px;color:#a9b5c9;flex:none;white-space:nowrap}
@keyframes qr-rot{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}
.qr-amt{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;
  color:#f1f4fa;cursor:pointer;flex:none;display:inline-flex;white-space:nowrap}
.q{display:inline-block;animation:qr-roll .45s ease both}
.qr-up .q{color:#96C6A9}
.qr-down .q{color:#ff8fa3}
.qr-spend-up .q{color:#ffb020}
@keyframes qr-roll{from{transform:translateY(7px);opacity:.25}to{transform:none;opacity:1}}
.qr-num.qr-up{color:#96C6A9}
.qr-num.qr-down{color:#ff8fa3}
.qr-today{font-size:12px;color:#8b98ad;margin-left:5px;white-space:nowrap;flex:none}
.qr-today b{color:#b9c6da;font-weight:600;font-variant-numeric:tabular-nums}
.qr-pop{position:fixed;z-index:9999;width:232px;box-sizing:border-box;background:#26282D;border:1px solid #26344d;border-radius:12px;
  padding:12px 13px;box-shadow:0 18px 44px rgba(0,0,0,.55);font-size:11px;color:#8b98ad;line-height:1.5}
.qr-pop .qr-hd{font-size:10px;letter-spacing:.5px;color:#5f6d85;text-transform:uppercase;margin-bottom:6px}
.qr-pop .qr-r{display:flex;justify-content:space-between;align-items:center;padding:3px 0}
.qr-pop .qr-r b{color:#dde5f2;font-weight:600;font-variant-numeric:tabular-nums}
.qr-pop .qr-hr{height:1px;background:#212b40;margin:8px 0}
.qr-pop .qr-cd{display:flex;align-items:center;gap:6px;font-size:11px;color:#ffd58a;
  background:rgba(255,176,32,.09);border:1px solid rgba(255,176,32,.22);border-radius:7px;padding:5px 8px;margin-top:8px}
.qr-pop .qr-cd b{color:#ffe0a3}
.qr-pop .qr-link{margin-top:9px;font-size:11px;color:#9fb1ff;text-align:right;cursor:pointer}
.qr-pop .qr-link:hover{text-decoration:underline}
.qr-pop .qr-err{color:#ff8fa3}
.qr-compact{justify-content:center;padding:0}
/* 把余额徽章叠到账户行右侧：以底部区域为定位基准 */
[class*="footArea"]{position:relative}
[class*="footerActions"]{position:absolute;right:0;bottom:4px;width:auto;min-width:0;display:flex;justify-content:flex-end;z-index:5;pointer-events:none}
[class*="footerActions"] > *{pointer-events:auto}
/* 侧边栏收起时保持原样，不要浮到别处 */
[class*="collapsed"] [class*="footerActions"]{position:static;width:100%;justify-content:center}
.qr-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:grid;place-items:center}
.qr-modal{width:300px;background:#111827;border:1px solid #2a3550;border-radius:14px;padding:20px 18px 16px;
  position:relative;box-shadow:0 24px 60px rgba(0,0,0,.6);font-family:inherit}
.qr-modal h3{margin:0 0 8px;font-size:14px;color:#e7ecf6;font-weight:600}
.qr-modal p{margin:0 0 16px;font-size:12px;color:#8b98ad;line-height:1.6}
.qr-yes{width:100%;padding:9px;border-radius:9px;border:none;background:#4d6bfe;color:#fff;font-size:13px;cursor:pointer}
.qr-yes:hover{filter:brightness(1.08)}
.qr-yes:disabled{opacity:.6;cursor:default}
.qr-close{position:absolute;top:10px;right:10px;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;
  color:#8b98ad;cursor:pointer;background:transparent;border:none;font-size:15px;line-height:1;padding:0}
.qr-close:hover{background:rgba(255,255,255,.08);color:#fff}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-quota-ring-style')) return
      const el = document.createElement('style')
      el.id = 'dsh-quota-ring-style'
      el.textContent = CSS
      document.head.appendChild(el)
    }

    // ---------------------------------------------------------------------
    // 工具
    // ---------------------------------------------------------------------
    const money = (v) => (typeof v === 'number' && Number.isFinite(v)
      ? '¥' + v.toFixed(2)
      : '—')
    // 徽章里的金额（带 ¥）
    const amount = (v) => (typeof v === 'number' && Number.isFinite(v)
      ? '¥' + v.toFixed(2)
      : '—')

    const ERR_TEXT = {
      auth_failed: 'API Key 无效或已过期',
      missing_api_key: '未配置 API Key',
      fetch_failed: '网络请求失败',
      invalid_response: '接口返回异常',
      timeout: '请求超时',
    }

    const fmtCountdown = (ms) => {
      if (!Number.isFinite(ms) || ms <= 0) return '即将切换'
      const totalMin = Math.floor(ms / 60_000)
      const d = Math.floor(totalMin / 1440)
      const hh = Math.floor((totalMin % 1440) / 60)
      const mm = totalMin % 60
      if (d > 0) return d + 'd ' + hh + 'h'
      if (hh > 0) return hh + 'h ' + mm + 'm'
      return mm + 'm'
    }

    const fmtTokens = (n) => {
      if (!Number.isFinite(n)) return '—'
      if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + ' K'
      return String(n)
    }

    async function fetchState(force) {
      const res = await fetch(force ? REFRESH_URL : STATE_URL, force
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
        : { method: 'GET' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    function openInApp(ctx, url) {
      try {
        const sr = ctx && (ctx.sidebarRight || (typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined))
        if (sr && typeof sr.openTab === 'function') {
          sr.openTab('browser', { params: { url } })
          return true
        }
      } catch { /* 降级 */ }
      try {
        window.open(url, '_blank', 'noopener')
        return true
      } catch {
        return false
      }
    }

    // ---------------------------------------------------------------------
    // 圆环
    // ---------------------------------------------------------------------
    const R = 14
    const C = 2 * Math.PI * R

    function Ring({ peakPct, mode, low, spinning, onClick }) {
      const peakLen = Math.max(0, Math.min(1, peakPct)) * C
      const offLen = C - peakLen
      const peakColor = low ? '#ff5c7a' : '#ffb020'
      const offColor = '#6FAE86'
      const centerColor = low ? '#ff5c7a' : (mode === 'peak' ? '#ffb020' : '#6FAE86')
      return h('div', { className: 'qr-ring' + (spinning ? ' qr-spin' : ''), onClick, title: '点击重启 DeepSeek Harness' },
        h('svg', { width: 28, height: 28, viewBox: '0 0 36 36' },
          h('circle', { cx: 18, cy: 18, r: R, fill: 'none', stroke: '#1a2233', strokeWidth: 4.2 }),
          peakLen > 0 && h('circle', {
            cx: 18, cy: 18, r: R, fill: 'none', stroke: peakColor, strokeWidth: 4.2,
            strokeDasharray: peakLen + ' ' + C, strokeDashoffset: 0,
          }),
          offLen > 0 && h('circle', {
            cx: 18, cy: 18, r: R, fill: 'none', stroke: offColor, strokeWidth: 4.2,
            strokeDasharray: offLen + ' ' + C, strokeDashoffset: -peakLen,
          }),
          // 刷新时叠一段高亮弧：整个圆环在转，但纯色满圆看不出旋转，
          // 这段弧跟着 svg 一起转，旋转就可见了。
          spinning && h('circle', {
            cx: 18, cy: 18, r: R, fill: 'none', stroke: '#484A4F', strokeWidth: 4.2,
            strokeLinecap: 'round',
            strokeDasharray: (C * 0.16) + ' ' + C, strokeDashoffset: 0,
          }),
        ),
        h('div', { className: 'qr-ico' },
          h('svg', {
            width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none',
            stroke: centerColor, strokeWidth: 2.4, strokeLinecap: 'round',
          },
            h('path', { d: 'M12 3.5v8.5' }),
            h('path', { d: 'M6.7 6.6a7.6 7.6 0 1 0 10.6 0' }),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 数字滚动
    // ---------------------------------------------------------------------
    function useRoll(value) {
      const [dir, setDir] = React.useState(null)
      const prev = React.useRef(value)
      React.useEffect(() => {
        if (typeof value !== 'number' || typeof prev.current !== 'number') { prev.current = value; return undefined }
        if (value === prev.current) return undefined
        const up = value > prev.current
        prev.current = value
        setDir(up ? 'up' : 'down')
        const t = setTimeout(() => setDir(null), AMOUNT_TTL)
        return () => clearTimeout(t)
      }, [value])
      return dir
    }

    function rollChars(text, dir) {
      return text.split('').map((ch, i) => h('span', {
        key: i + ':' + ch + ':' + text,
        className: dir ? 'q' : undefined,
        style: dir ? { animationDelay: (i * 18) + 'ms' } : undefined,
      }, ch))
    }

    function Amount({ value, dir }) {
      return h('span', { className: 'qr-amt' + (dir ? ' qr-' + dir : '') },
        rollChars(amount(value), dir),
      )
    }

    // ---------------------------------------------------------------------
    // 重启确认弹窗
    // ---------------------------------------------------------------------
    function RestartModal({ onClose }) {
      const [busy, setBusy] = React.useState(false)
      const confirm = async () => {
        setBusy(true)
        try {
          await fetch('/quota-ring/restart', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        } catch { /* 应用即将退出 */ }
      }
      return h('div', { className: 'qr-mask', onClick: onClose },
        h('div', { className: 'qr-modal', onClick: (e) => e.stopPropagation() },
          h('button', { className: 'qr-close', onClick: onClose, title: '不重启' }, '×'),
          h('h3', null, '重启 DeepSeek Harness？'),
          h('p', null, '重启会中断当前会话，随后自动重新打开。'),
          h('button', { className: 'qr-yes', onClick: confirm, disabled: busy },
            busy ? '正在重启…' : '是'),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 徽章
    // ---------------------------------------------------------------------
    function Badge({ ctx }) {
      const [snap, setSnap] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState(null)
      const [hover, setHover] = React.useState(false)
      const [now, setNow] = React.useState(Date.now())
      const [pos, setPos] = React.useState(null)
      const [confirmRestart, setConfirmRestart] = React.useState(false)
      const ref = React.useRef(null)
      const dir = useRoll(snap && typeof snap.balance === 'number' ? snap.balance : null)
      const dirToday = useRoll(snap && snap.today && typeof snap.today.total === 'number' ? snap.today.total : null)

      const load = React.useCallback(async (force) => {
        const started = Date.now()
        setBusy(true)
        try {
          const data = await fetchState(force)
          setSnap(data)
          setErr(data && data.error ? data.error : null)
        } catch (e) {
          setErr(e && e.message ? e.message : 'load_failed')
        } finally {
          // 至少转 600ms，保证手动刷新有可见反馈
          const rest = 600 - (Date.now() - started)
          if (rest > 0) await new Promise((r) => setTimeout(r, rest))
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        load(false)
        const id = setInterval(() => {
          if (typeof document === 'undefined' || !document.hidden) load(false)
        }, REFRESH_MS)
        const onVis = () => { if (typeof document !== 'undefined' && !document.hidden) load(false) }
        document.addEventListener('visibilitychange', onVis)
        return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
      }, [load])

      React.useEffect(() => {
        if (!hover) return undefined
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
      }, [hover])

      const hideTimer = React.useRef(null)
      const showPop = (e) => {
        if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
        const el = (e && e.currentTarget) || ref.current
        if (el && el.getBoundingClientRect) {
          const r = el.getBoundingClientRect()
          // 弹层在侧边栏内水平居中：以底部区域（footer）的水平中点为准
          const host = (el.closest && el.closest('[class*="footArea"]')) || el.parentElement || el
          const box = host && host.getBoundingClientRect ? host.getBoundingClientRect() : r
          const left = Math.max(0, box.left + (box.width - POP_W) / 2)
          setPos({ left, bottom: window.innerHeight - r.top + 8 })
        }
        setHover(true)
      }
      const hidePop = () => {
        if (hideTimer.current) clearTimeout(hideTimer.current)
        hideTimer.current = setTimeout(() => setHover(false), 180)
      }

      const onUsage = (e) => { e.stopPropagation(); openInApp(ctx, USAGE_URL) }
      const onAmount = (e) => { e.stopPropagation(); load(true) }

      const today = snap && snap.today ? snap.today : null
      const total = today ? today.total : 0
      const peakPct = total > 0 ? today.peak / total : 0
      const mode = snap ? snap.mode : 'off'
      const low = Boolean(snap && snap.low)

      return h('div', {
        ref,
        style: { position: 'relative', minWidth: 0 },
        onMouseEnter: showPop,
        onMouseLeave: hidePop,
      },
        h('div', {
          className: 'qr-badge' + (low ? ' qr-low' : ''),
          onClick: () => load(true),
          'aria-label': '刷新余额',
        },
          h(Ring, { peakPct, mode, low, spinning: busy, onClick: (e) => { e.stopPropagation(); setConfirmRestart(true) } }),
          h('span', { className: 'qr-lbl' }, '余:'),
          h(Amount, { value: snap ? snap.balance : null, dir }),
          h('span', { className: 'qr-today' },
            '今:', h('b', { className: dirToday ? (dirToday === 'up' ? 'qr-spend-up' : 'qr-down') : undefined }, rollChars(amount(total), dirToday))),
        ),
        hover && snap && h(Popover, { snap, now, pos, err, onUsage }),
        confirmRestart && h(RestartModal, { onClose: () => setConfirmRestart(false) }),
      )
    }

    function Popover({ snap, now, pos, err, onUsage }) {
      const t = snap.today || {}
      const remain = snap.nextSwitchAt - now
      return h('div', {
        className: 'qr-pop',
        style: pos ? { left: pos.left + 'px', bottom: pos.bottom + 'px' } : undefined,
        onMouseEnter: () => {},
      },
        h('div', { className: 'qr-hd' }, '今日'),
        h('div', { className: 'qr-r' }, h('span', null, '高峰花费'), h('b', null, money(t.peak))),
        h('div', { className: 'qr-r' }, h('span', null, '闲时花费'), h('b', null, money(t.off))),
        h('div', { className: 'qr-r' }, h('span', null, '合计'), h('b', null, money(t.total))),
        h('div', { className: 'qr-hr' }),
        h('div', { className: 'qr-r' }, h('span', null, 'Tokens'), h('b', null,
          fmtTokens((t.inputTokens || 0) + (t.outputTokens || 0) + (t.cacheTokens || 0)))),
        h('div', { className: 'qr-r' }, h('span', null, '缓存命中'), h('b', null,
          t.cacheHitRate ? (t.cacheHitRate * 100).toFixed(0) + '%' : '—')),
        h('div', { className: 'qr-r' }, h('span', null, '请求数'), h('b', null, String(t.requests || 0))),
        snap.nextSwitchAt ? h('div', { className: 'qr-cd' },
          snap.nextMode === 'off' ? '☾' : '⚡',
          ' 距' + (snap.nextMode === 'off' ? '闲时' : '高峰') + '还有 ',
          h('b', null, fmtCountdown(remain))) : null,
        err ? h('div', { className: 'qr-r qr-err' }, h('span', null, '状态'), h('b', null, ERR_TEXT[err] || String(err))) : null,
        h('div', { className: 'qr-link', onClick: onUsage }, '用量/充值'),
      )
    }

    // ---------------------------------------------------------------------
    // 插件入口
    // ---------------------------------------------------------------------
    function apply(ctx) {
      ensureStyle()
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'quota-ring', order: -1 },
        () => h(Badge, { ctx }),
      ))
    }

    const module = { exports: {} }
    module.exports.inject = ['slots', 'timer']
    module.exports.apply = apply
    return module.exports
  },
})
