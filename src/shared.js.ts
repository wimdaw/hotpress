// 公共页脚 + 共享 JS 工具 —— 首页与 /admin 复用，保证设计语言一致
export const SITE_REPO = 'https://github.com/wimdaw/wx-draft-worker'

export function renderSiteFooter(title: string, platform?: string): string {
  return `<footer class="site-footer">
  <div class="shell site-footer__inner">
    <span>© ${new Date().getFullYear()} ${title} · 热点 → 选题 → 创作 → 去AI化 → 配图 → 公众号草稿箱</span>
    <span>${platform || 'Cloudflare Pages · D1'}</span>
  </div>
</footer>`
}

// 注入到页面的共享脚本（前后台通用）
export const SHARED_JS = `
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function fmtTime(iso) {
  if (!iso || iso === '0') return '—'
  try {
    const d = new Date(iso)
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  } catch (e) { return iso }
}
function hotLabel(v) {
  if (v === '' || v == null) return ''
  return String(v)
}
const STATUS_BADGE = {
  ready: '<span class="bd bd-info">待推送</span>',
  pushed: '<span class="bd bd-on">已推送</span>',
  failed: '<span class="bd bd-del">推送失败</span>',
  draft: '<span class="bd bd-off">草稿</span>',
}
function statusBadge(s) { return STATUS_BADGE[s] || '<span class="bd bd-off">' + escapeHtml(s) + '</span>' }
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  let d = null
  try { d = await r.json() } catch (e) { d = { success: false, message: '响应解析失败' } }
  if (!r.ok && d && !d.message) d.message = 'HTTP ' + r.status
  return d
}
function toast(msg, type) {
  let host = document.querySelector('.toast-host')
  if (!host) {
    host = document.createElement('div')
    host.className = 'toast-host'
    host.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:9998;display:grid;gap:.5rem;width:min(24rem,calc(100% - 2rem));'
    document.body.appendChild(host)
  }
  const el = document.createElement('div')
  el.className = 'al ' + (type === 'error' ? 'al-e' : type === 'info' ? 'al-i' : 'al-s')
  el.style.boxShadow = 'var(--shadow-float)'
  el.innerHTML = escapeHtml(msg)
  host.appendChild(el)
  setTimeout(() => el.remove(), 4200)
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true }
  catch (e) {
    const ta = document.createElement('textarea')
    ta.value = text; document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy'); return true } finally { ta.remove() }
  }
}
`
