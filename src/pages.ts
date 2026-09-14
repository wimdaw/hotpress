/**
 * 前端页面（SSR + 后台 SPA），样式完全复用 ai-gateway 的「Cloud Workbench」设计系统。
 * 页面：/（首页）/article/:id（预览）/admin/login /admin（后台）
 */
import { Context } from 'hono'
import { CSS_CONTENT } from './pages.css'
import { SHARED_JS, renderSiteFooter } from './shared.js'
import { SITE_CONFIG } from './config'
import { getSettings, getStats, listTopics, listArticles, getArticle, latestRun, listRuns, getLatestBatchId } from './storage'
import { selectTopicGroups } from './selector'
import { GENRES } from './config'
import type { Env, TopicRow, ArticleRow, RunRow } from './types'

const esc = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const PLATFORM_SHORT: Record<string, string> = {
  weibo: '微博', zhihu: '知乎', baidu: '百度', douyin: '抖音', toutiao: '头条',
  rednote: '小红书', bili: 'B站', tencent_news: '腾讯', wechat_gzh: '微信',
  ithome: 'IT之家', '36kr': '36氪', ifanr: '爱范儿',
}

function head(title: string): string {
  return `<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="oklch(98.5% 0.004 250)">
  <title>${esc(title)} — ${SITE_CONFIG.title}</title>
  <link rel="icon" href="${SITE_CONFIG.favicon}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500;600&amp;family=Space+Grotesk:wght@500;600&amp;display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${SITE_CONFIG.faCdn}">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/turndown/7.2.0/turndown.min.js"></script>
  <script>if(/^[0-9a-f]{8}\.hotpress\.pages\.dev$/.test(location.hostname)){location.hostname='hotpress.pages.dev'}</script>
  <style>${CSS_CONTENT}</style>
</head>`
}

function topbar(isLoggedIn: boolean, active = ''): string {
  return `<header class="topbar">
  <div class="shell topbar__inner">
    <a class="brand" href="/" aria-label="${SITE_CONFIG.title} 首页">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-fire"></i></span>
      <span class="brand__name">${SITE_CONFIG.title}</span>
      <span class="brand__descriptor">${SITE_CONFIG.descriptor}</span>
    </a>
    <nav class="topbar__actions" aria-label="主导航">
      ${active !== 'admin' ? `<a href="/#topics" class="btn btn-gh"><i class="fas fa-list" aria-hidden="true"></i>热点榜</a><a href="/#articles" class="btn btn-gh"><i class="fas fa-newspaper" aria-hidden="true"></i>文章</a>` : ''}
      ${isLoggedIn
        ? `<a href="/admin" class="btn btn-p"><i class="fas fa-sliders-h" aria-hidden="true"></i>管理控制台</a><a href="/admin/logout" class="btn btn-gh"><i class="fas fa-sign-out-alt" aria-hidden="true"></i>退出</a>`
        : `<a href="/admin/login" class="btn btn-p"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>管理员登录</a>`}
    </nav>
  </div>
</header>`
}

function genreChip(genre: string): string {
  return `<span class="chip chip--gray">${esc(GENRES[genre]?.name || genre)}</span>`
}

// ===== 首页 =====

export async function renderHomePage(c: Context<{ Bindings: Env }>, isLoggedIn: boolean) {
  const [stats, batchId, articles, run] = await Promise.all([
    getStats(c.env),
    getLatestBatchId(c.env),
    listArticles(c.env, { limit: 9 }),
    latestRun(c.env),
  ])
  let topics: TopicRow[] = []
  if (batchId) topics = await listTopics(c.env, { batchId, limit: 300 })
  const settings = await getSettings(c.env)
  const groups = selectTopicGroups(topics, settings, 12)
  const batchTime = topics.length ? topics[0].fetched_at : ''
  const successRate = stats.articlesTotal > 0
    ? Math.round((stats.pushedTotal / stats.articlesTotal) * 100) + '%'
    : '—'

  const runState = run
    ? `<span class="status-badge ${run.status === 'running' ? 'bd-info' : run.status === 'success' ? 'status-badge--on' : 'bd-off'}"><i aria-hidden="true"></i>${run.status === 'running' ? '运行中' : run.status === 'success' ? '上次运行成功' : run.status === 'partial' ? '上次部分成功' : '上次运行失败'} · ${esc(run.started_at.slice(0, 16).replace('T', ' '))}</span>`
    : `<span class="bd bd-off">尚未运行</span>`

  const topicRows = groups.length
    ? groups.map((g, i) => {
        const url = g.urls[0] || '#'
        const chips = g.platforms.map((p) => `<span class="chip">${esc(PLATFORM_SHORT[p] || p)}</span>`).join('')
        return `<a class="topic-row" href="${esc(url)}" ${url === '#' ? '' : 'target="_blank" rel="noreferrer"'}>
          <span class="topic-row__rank ${i < 3 ? 'topic-row__rank--top' : ''}">${i + 1}</span>
          <span class="topic-row__main">
            <span class="topic-row__title">${esc(g.title)}</span>
            <span class="topic-row__meta">${chips}${g.platforms.length > 1 ? `<span class="topic-merge-note">多平台热议</span>` : ''}</span>
          </span>
          ${g.hotValue ? `<span class="topic-row__hot">🔥 ${esc(g.hotValue)}</span>` : ''}
        </a>`
      }).join('')
    : `<div class="empty-state"><i class="fas fa-inbox" aria-hidden="true"></i><h3>还没有热点数据</h3><p>管理员登录后点击「抓取热点」或「运行流水线」，热点榜将在这里出现。</p></div>`

  const articleCards = articles.length
    ? articles.map((a) => articleCard(a)).join('')
    : `<div class="empty-state"><i class="fas fa-feather" aria-hidden="true"></i><h3>还没有创作文章</h3><p>流水线会自动为热点选题写稿、配图，生成的文章会展示在这里。</p></div>`

  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${head('首页')}
<body class="site-page home-page">
${topbar(isLoggedIn)}

<main>
  <section class="shell home-hero" aria-labelledby="home-title">
    <div class="home-hero__copy">
      <p class="eyebrow"><span aria-hidden="true"></span>HOT TOPICS → WECHAT DRAFT</p>
      <h1 id="home-title">热点选题，AI 成稿，一键进草稿箱。</h1>
      <p class="home-hero__lede">${SITE_CONFIG.description}。热点源：自托管网关直连 26 源（微博 / 知乎 / 抖音 / 头条 / 澎湃 / GitHub / BBC …）；配图新闻源无水印优先，Agnes AI 兜底；发布前全部通过去AI化核验。</p>
      <div class="endpoint-box" aria-label="流水线状态">
        <span class="endpoint-box__label">PIPELINE · 流水线</span>
        <code>抓取热点 → 自动选题 → AI 创作 → 去AI化核验 → 智能配图 → 推送草稿箱</code>
        <button class="icon-btn" type="button" onclick="location.href='#topics'" aria-label="查看热点"><span>看榜单</span></button>
      </div>
      <div style="margin-top: var(--space-md);">${runState}</div>
    </div>

    <figure class="request-panel" aria-labelledby="flow-caption">
      <figcaption id="flow-caption">
        <span>POST /api/draft → wx-draft-worker</span>
        <span class="protocol-state"><i aria-hidden="true"></i>WECHAT DRAFT API</span>
      </figcaption>
      <pre><code><span class="syntax-command">pipeline</span> 每次运行（可定时 / 手动）
  <span class="syntax-key">1.</span> 抓取 <span class="syntax-string">26 源全网热榜</span>（自托管网关直连官方接口）
  <span class="syntax-key">2.</span> 选题 <span class="syntax-string">跨平台去重合并 · 热度打分 TOP N</span>
  <span class="syntax-key">3.</span> 创作 <span class="syntax-string">爆款模板 · 约 1800 字（解读/盘点/观点/快评）</span>
  <span class="syntax-key">4.</span> 去AI化 <span class="syntax-string">双信号评分 · 超标自动改写 · 不达标不推送</span>
  <span class="syntax-key">5.</span> 配图 <span class="syntax-string">新闻源CC无水印 → 头条/百度 → Agnes 兜底</span>
  <span class="syntax-key">6.</span> 推送 <span class="syntax-string">微信草稿箱（标题·摘要·封面·正文）</span></code></pre>
      <div class="request-panel__foot">
        <span>发布标准</span>
        <code>AI痕达标 · 标题≤64字 · 摘要≤120字 · 作者≤8字</code>
      </div>
    </figure>
  </section>

  <section class="shell metrics-strip" aria-label="数据概览">
    <div class="metric"><span class="metric__value">${stats.topicsToday}</span><span class="metric__label">今日热点条目</span></div>
    <div class="metric"><span class="metric__value">${stats.articlesToday}</span><span class="metric__label">今日成稿</span></div>
    <div class="metric"><span class="metric__value">${stats.pushedTotal}</span><span class="metric__label">累计推送草稿</span></div>
    <div class="metric"><span class="metric__value">${successRate}</span><span class="metric__label">推送成功率</span></div>
  </section>

  <section class="shell directory" id="topics" aria-labelledby="topics-title">
    <div class="section-heading">
      <div>
        <h2 id="topics-title">全网热点榜</h2>
        <p>跨平台去重合并后的高热话题${batchTime ? `，抓取于 ${esc(batchTime.slice(0, 16).replace('T', ' '))}` : ''}。</p>
      </div>
      <label class="search-field" for="topic-search">
        <i class="fas fa-search" aria-hidden="true"></i>
        <span class="sr-only">过滤热点话题</span>
        <input id="topic-search" type="search" placeholder="输入关键词过滤本页话题" autocomplete="off">
      </label>
    </div>
    <div class="topic-list" id="topic-list">${topicRows}</div>
  </section>

  <section class="shell directory" id="articles" aria-labelledby="articles-title">
    <div class="section-heading">
      <div>
        <h2 id="articles-title">最新成稿</h2>
        <p>点击卡片查看排版预览；正式发布请到公众号后台或管理控制台。</p>
      </div>
    </div>
    <div class="article-grid">${articleCards}</div>
  </section>
</main>

${renderSiteFooter(SITE_CONFIG.title)}

<script>
${SHARED_JS}
// 首页话题过滤
var topicSearch = document.getElementById('topic-search')
if (topicSearch) {
  topicSearch.addEventListener('input', function () {
    var kw = this.value.trim().toLowerCase()
    document.querySelectorAll('#topic-list .topic-row').forEach(function (row) {
      row.style.display = !kw || row.textContent.toLowerCase().indexOf(kw) !== -1 ? '' : 'none'
    })
  })
}
</script>
</body></html>`, 200, { 'Cache-Control': 'no-store' })
}

function articleCard(a: ArticleRow): string {
  const cover = a.cover_url
  const coverHtml = cover
    ? `<img class="article-card__cover" src="${esc(cover)}" alt="${esc(a.title)} 封面" loading="lazy" onerror="this.outerHTML='<div class=&quot;article-card__cover article-card__cover--empty&quot;>HotPress</div>'">`
    : `<div class="article-card__cover article-card__cover--empty">HotPress</div>`
  const statusBadgeHtml = a.status === 'pushed'
    ? '<span class="bd bd-on">已推送</span>'
    : a.status === 'failed'
      ? '<span class="bd bd-del">推送失败</span>'
      : '<span class="bd bd-info">待推送</span>'
  const imgCount = (() => { try { return (JSON.parse(a.images || '[]') as any[]).length } catch { return 0 } })()
  return `<a class="article-card" href="/article/${esc(a.id)}">
    ${coverHtml}
    <div class="article-card__body">
      <h3>${esc(a.title)}</h3>
      <p>${esc(a.digest)}</p>
      <div class="article-card__foot">
        ${statusBadgeHtml}
        ${genreChip(a.genre)}
        <span><i class="fas fa-image" aria-hidden="true"></i> ${imgCount} 图</span>
        <span style="margin-left:auto;">${esc(a.created_at.slice(5, 16).replace('T', ' '))}</span>
      </div>
    </div>
  </a>`
}

// ===== 文章预览页 =====

export async function renderArticlePage(c: Context<{ Bindings: Env }>, id: string) {
  const a = await getArticle(c.env, id)
  if (!a) return c.notFound()
  const settings = await getSettings(c.env)
  const themeLabel = ({ clean: '简洁专业', sspai: '活力橙', navy: '沉稳深蓝' } as any)[a.theme || settings.theme] || a.theme
  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${head(a.title)}
<body class="site-page home-page">
${topbar(false)}
<main class="shell" style="padding-block: var(--space-lg) var(--space-2xl);">
  <div class="section-heading">
    <div>
      <h2 style="font-size: var(--text-xl);">${esc(a.title)}</h2>
      <p>${esc(a.digest)}</p>
    </div>
    <div class="admin-heading__actions">
      <a class="btn btn-s" href="/"><i class="fas fa-arrow-left" aria-hidden="true"></i>返回首页</a>
    </div>
  </div>
  <dl class="detail-kv" style="margin-block-end: var(--space-md);">
    <dt>状态</dt><dd>${a.status === 'pushed' ? '已推送草稿箱（media_id: ' + esc(a.push_media_id) + '）' : a.status === 'failed' ? '推送失败：' + esc(a.push_error) : '待推送'}</dd>
    <dt>体裁 / 排版</dt><dd>${esc(GENRES[a.genre]?.name || a.genre)} · ${esc(themeLabel || '')}主题</dd>
    <dt>作者</dt><dd>${esc(a.author || '（默认）')}</dd>
    <dt>创建时间</dt><dd>${esc(a.created_at.replace('T', ' ').slice(0, 19))}</dd>
  </dl>
  <div class="wx-preview">${a.html || '<p>（正文为空）</p>'}</div>
</main>
${renderSiteFooter(SITE_CONFIG.title)}
</body></html>`, 200, { 'Cache-Control': 'no-store' })
}

// ===== 登录页 =====

export function renderLoginPage(c: Context<{ Bindings: Env }>) {
  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${head('管理员登录')}
<body class="site-page auth-page">
${topbar(false)}
<main class="auth-shell">
  <div class="auth-context">
    <p class="eyebrow"><span aria-hidden="true"></span>ADMIN CONSOLE</p>
    <h1>登录管理控制台。</h1>
    <p>管理热点抓取、自动选题、文章创作与微信草稿推送。默认账号 admin / admin，首次登录后请立即修改密码。</p>
    <dl class="auth-facts">
      <div><dt>流水线</dt><dd>抓取 → 选题 → 创作 → 配图 → 推送</dd></div>
      <div><dt>微信网关</dt><dd>wx-draft-worker（X-API-Key 鉴权）</dd></div>
      <div><dt>数据存储</dt><dd>Cloudflare D1</dd></div>
    </dl>
  </div>
  <div class="auth-form-wrap">
    <form class="auth-form" id="login-form">
      <div class="auth-form__heading">
        <span class="auth-form__icon" aria-hidden="true"><i class="fas fa-key"></i></span>
        <div>
          <h2>管理员登录</h2>
          <p>使用管理员账号密码登录</p>
        </div>
      </div>
      <div class="fg">
        <label for="username">用户名</label>
        <input id="username" name="username" autocomplete="username" required>
      </div>
      <div class="fg">
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </div>
      <div id="login-alert"></div>
      <button class="btn btn-p btn-submit" type="submit"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>登录</button>
    </form>
  </div>
</main>
<script>
document.getElementById('login-form').addEventListener('submit', async function (e) {
  e.preventDefault()
  var alertEl = document.getElementById('login-alert')
  alertEl.innerHTML = ''
  var btn = this.querySelector('button[type=submit]')
  btn.disabled = true
  try {
    var r = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('username').value.trim(), password: document.getElementById('password').value })
    })
    var text = await r.text()
    var d = null
    try { d = JSON.parse(text) } catch (e) { d = null }
    if (d && d.success) { location.href = '/admin'; return }
    if (!d) {
      alertEl.innerHTML = '<div class="al al-e"><i class="fas fa-times-circle"></i> 服务返回异常（HTTP ' + r.status + '），请稍后刷新重试</div>'
    } else {
      alertEl.innerHTML = '<div class="al al-e"><i class="fas fa-times-circle"></i> ' + escapeHtml(d.message || '登录失败') + '</div>'
    }
  } catch (err) {
    alertEl.innerHTML = '<div class="al al-e"><i class="fas fa-times-circle"></i> 网络无法访问本站 —— 当前网络对 pages.dev 域名不稳定，请换网络/代理重试，或使用自定义域名访问</div>'
  } finally { btn.disabled = false }
})
</script>
</body></html>`, 200, { 'Cache-Control': 'no-store' })
}

// ===== 管理后台（SPA） =====

const ADMIN_NAV = [
  { id: 'overview', icon: 'fa-gauge-high', label: '总览' },
  { id: 'topics', icon: 'fa-fire', label: '热点池' },
  { id: 'articles', icon: 'fa-newspaper', label: '文章' },
  { id: 'writing', icon: 'fa-pen-nib', label: '自定义写作' },
  { id: 'pipeline', icon: 'fa-diagram-project', label: '流水线' },
  { id: 'schedule', icon: 'fa-clock', label: '定时任务' },
  { id: 'settings', icon: 'fa-gear', label: '设置' },
]

export async function renderAdminPage(c: Context<{ Bindings: Env }>) {
  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${head('管理控制台')}
<body class="site-page admin-page">
<div class="admin-shell">
  <aside class="admin-rail">
    <div class="admin-rail__head">
      <a class="brand admin-rail__brand" href="/" aria-label="${SITE_CONFIG.title} 首页">
        <span class="brand__mark" aria-hidden="true"><i class="fas fa-fire"></i></span>
        <span class="admin-rail__brand-text"><strong>${SITE_CONFIG.title}</strong><small>${SITE_CONFIG.descriptor}</small></span>
      </a>
    </div>
    <nav class="admin-nav" id="admin-nav" aria-label="后台导航">
      ${ADMIN_NAV.map((n) => `<a href="#${n.id}" class="admin-nav__link" data-tab="${n.id}"><i class="fas ${n.icon}" aria-hidden="true"></i><span>${n.label}</span><b id="nav-badge-${n.id}" hidden></b></a>`).join('')}
    </nav>
    <div class="admin-rail__foot">
      <button class="admin-nav__link rail-toggle" type="button" onclick="toggleRail()" title="收缩侧边栏" aria-label="收缩/展开侧边栏"><i class="fas fa-angles-left" aria-hidden="true"></i><span>收缩侧边栏</span></button>
      <a class="admin-nav__link" href="/"><i class="fas fa-house" aria-hidden="true"></i><span>返回首页</span></a>
      <a class="admin-nav__link" href="/admin/logout"><i class="fas fa-sign-out-alt" aria-hidden="true"></i><span>退出登录</span></a>
    </div>
  </aside>
  <div class="admin-main">
    <div class="admin-topbar">
      <span class="brand"><span class="brand__name">${SITE_CONFIG.title}</span></span>
      <nav aria-label="后台移动端导航">
        ${ADMIN_NAV.map((n) => `<a href="#${n.id}" data-tab="${n.id}">${n.label}</a>`).join('')}
      </nav>
    </div>
    <div class="admin-content" id="admin-content"></div>
  </div>
</div>
<script>
${SHARED_JS}
${ADMIN_JS}
</script>
</body></html>`, 200, { 'Cache-Control': 'no-store' })
}

// 后台 SPA 脚本（避免模板字符串嵌套，全部用字符串拼接）
const ADMIN_JS = `
var currentTab = 'overview'
var SETTINGS_CACHE = null
var THEMES = []
var GENRES = {}

// ── 导航 ──
function switchTab(tab) {
  currentTab = tab
  document.querySelectorAll('#admin-nav .admin-nav__link').forEach(function (a) {
    a.classList.toggle('is-active', a.dataset.tab === tab)
  })
  var el = document.getElementById('admin-content')
  el.innerHTML = '<p class="empty-inline"><i class="fas fa-spinner fa-spin"></i> 加载中…</p>'
  if (tab === 'overview') loadOverview()
  else if (tab === 'topics') loadTopics()
  else if (tab === 'articles') loadArticles()
  else if (tab === 'writing') loadWriting()
  else if (tab === 'pipeline') loadPipeline()
  else if (tab === 'schedule') loadScheduleTab()
  else if (tab === 'settings') loadSettings()
}
document.addEventListener('click', function (e) {
  var a = e.target.closest('[data-tab]')
  if (a) { e.preventDefault(); location.hash = a.dataset.tab }
})
// ── 侧边栏收缩/展开（PC 端，记忆状态）──
function toggleRail() {
  var shell = document.querySelector('.admin-shell')
  var collapsed = shell.classList.toggle('is-collapsed')
  try { localStorage.setItem('admin-rail-collapsed', collapsed ? '1' : '0') } catch (e) {}
  var btn = document.querySelector('.rail-toggle')
  if (btn) btn.title = collapsed ? '展开侧边栏' : '收缩侧边栏'
}
window.addEventListener('hashchange', function () { switchTab(location.hash.slice(1) || 'overview') })

// ── 总览 ──
async function loadOverview() {
  var d = await api('/admin/api/status')
  var el = document.getElementById('admin-content')
  if (!d.success) { el.innerHTML = '<div class="al al-e">' + escapeHtml(d.message || '加载失败') + '</div>'; return }
  var s = d.data.stats, cfg = d.data.config, run = d.data.latestRun
  el.innerHTML =
    '<div class="admin-overview"><div class="admin-heading"><div>' +
      '<p class="eyebrow"><span aria-hidden="true"></span>OVERVIEW</p>' +
      '<h1>总览</h1></div>' +
      '<div class="admin-heading__actions">' +
        '<button class="btn btn-s" id="btn-fetch"><i class="fas fa-cloud-arrow-down"></i>抓取热点</button>' +
        '<button class="btn btn-p" id="btn-run"><i class="fas fa-play"></i>运行流水线</button>' +
        '<button class="btn btn-d" id="btn-run-push"><i class="fas fa-rocket"></i>运行并推送</button>' +
      '</div></div>' +
    '<div class="admin-metrics">' +
      metric(String(s.topicsToday), '今日热点条目') +
      metric(String(s.articlesToday), '今日成稿') +
      metric(String(s.pushedTotal), '已推送') +
      metric(String(s.failedTotal), '推送失败') +
    '</div></div>' +
    '<div class="workspace-section" style="margin-block-start:var(--space-md);"><div class="section-heading section-heading--admin"><div><h2>近 7 天趋势</h2><p><span class="legend-dot" style="background:var(--color-accent);"></span>成稿　<span class="legend-dot" style="background:var(--color-success);"></span>推送成功　<span class="legend-dot" style="background:var(--color-paper-3);border:1px solid var(--color-rule-2);"></span>热点入库</p></div></div>' +
    '<div class="trend-grid"><div class="trend-card"><div class="trend-bars" id="trend-bars"><p class="empty-inline"><i class="fas fa-spinner fa-spin"></i></p></div></div>' +
    '<div class="trend-card"><h3>当前批次平台分布</h3><div id="platform-dist"><p class="empty-inline"><i class="fas fa-spinner fa-spin"></i></p></div></div></div>' +
    '</div>' +
    '<div class="setting-grid">' +
      '<div class="trend-card"><h3><i class="fas fa-file-lines" aria-hidden="true"></i> 最近成稿</h3><div id="ov-recent"><p class="empty-inline"><i class="fas fa-spinner fa-spin"></i></p></div></div>' +
      '<div class="trend-card"><h3><i class="fas fa-fire" aria-hidden="true"></i> 今日选题 TOP</h3><div id="ov-topics"><p class="empty-inline"><i class="fas fa-spinner fa-spin"></i></p></div></div>' +
    '</div>' +
    '<div class="workspace-section"><div class="section-heading section-heading--admin"><div><h2>链路配置</h2><p>在「设置」页修改各项凭据与参数。</p></div></div>' +
    '<div class="setting-grid">' +
      panel('LLM 创作', (cfg.llm ? escapeHtml(cfg.llm.model) + '<br><span class="mu">' + escapeHtml(cfg.llm.base) + '</span>' : '未配置') + '<div style="margin-top:6px;"><button class="btn btn-s" data-t="llm"><i class="fas fa-vial"></i>测试</button></div>', cfg.llm ? 'fa-robot' : 'fa-triangle-exclamation') +
      panel('Agnes AI 配图', (cfg.agnes ? escapeHtml(cfg.agnes.model) + '<br><span class="mu">已配置 API Key</span>' : '未配置（网搜无结果时无兜底）') + '<div style="margin-top:6px;"><button class="btn btn-s" data-t="agnes"><i class="fas fa-vial"></i>测试</button></div>', cfg.agnes ? 'fa-wand-magic-sparkles' : 'fa-triangle-exclamation') +
      panel('微信网关', (cfg.wx ? escapeHtml(cfg.wx.url) + '<br><span class="mu">' + (cfg.wx.token ? '令牌已配置' : '⚠️ 未配置令牌') + (cfg.autoPush ? ' · 自动推送开' : ' · 自动推送关') + '</span>' : '未配置') + '<div style="margin-top:6px;"><button class="btn btn-s" data-t="wx"><i class="fas fa-vial"></i>健康</button></div>', 'fa-paper-plane') +
      panel('热点网关', (cfg.wx ? '<span class="mu">热点 API：26 源直连官方接口</span>' : '') + '<div style="margin-top:6px;"><button class="btn btn-s" data-t="images"><i class="fas fa-vial"></i>测图源</button></div>', 'fa-rss') +
    '</div></div>' +
    '<div class="workspace-section"><div class="section-heading section-heading--admin"><div><h2>运行日志</h2><p>最近一次流水线的完整执行日志。</p></div></div>' +
    '<pre class="log-box">' + (run && run.log ? escapeHtml(run.log) : '（暂无日志）') + '</pre></div>'
  document.getElementById('btn-fetch').onclick = function () { doAction('/admin/api/fetch-topics', 'POST', '抓取完成') }
  document.getElementById('btn-run').onclick = function () { runPipelineStreaming(false, this) }
  var rp = document.getElementById('btn-run-push')
  if (rp) rp.onclick = function () {
    if (!confirm('运行完整流水线并将成稿推送微信草稿箱，继续？')) return
    runPipelineStreaming(true, rp)
  }
  document.querySelectorAll('[data-t]').forEach(function (b) {
    b.onclick = async function () {
      b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'
      var url = b.dataset.t === 'llm' ? '/admin/api/test/llm' : b.dataset.t === 'agnes' ? '/admin/api/test/agnes' : b.dataset.t === 'images' ? '/admin/api/test/images' : '/admin/api/test/wx'
      var d = await api(url, { method: 'POST', body: '{}' })
      b.disabled = false; b.innerHTML = '<i class="fas fa-vial"></i>测试'
      var ok2 = d.success && d.data && d.data.ok
      toast((ok2 ? '✅ ' : '❌ ') + ((d.data && d.data.message) || d.message || ''), ok2 ? 'ok' : 'error')
    }
  })
  loadTrend()
  loadRecent()
  setNavBadge('articles', s.articlesTotal)
  setNavBadge('topics', s.topicsToday)
}
async function loadRecent() {
  var dA = await api('/admin/api/articles?limit=5')
  var elA = document.getElementById('ov-recent')
  if (elA) elA.innerHTML = dA.success && dA.data.articles.length
    ? dA.data.articles.map(function (a) {
      return '<div class="dist-row" style="grid-template-columns:minmax(0,1fr) auto;"><span class="pname" title="' + escapeHtml(a.title) + '">' + statusBadge(a.status) + ' ' + escapeHtml(a.title.slice(0, 22)) + '</span><span class="pval">' + fmtTime(a.created_at).slice(5) + '</span></div>'
    }).join('') : '<p class="empty-inline">还没有文章</p>'
  var dT = await api('/admin/api/topics?limit=100')
  var elT = document.getElementById('ov-topics')
  if (elT) elT.innerHTML = dT.success && dT.data.selection.length
    ? dT.data.selection.slice(0, 6).map(function (g) {
      return '<div class="dist-row" style="grid-template-columns:minmax(0,1fr) auto;"><span class="pname" title="' + escapeHtml(g.title) + '">' + escapeHtml(g.title.slice(0, 20)) + ' <span class="chip chip--gray">' + escapeHtml(g.sector || '') + '</span></span><span class="pval">🔥 ' + escapeHtml(g.hot || '—') + '</span></div>'
    }).join('') : '<p class="empty-inline">暂无热点，先抓取</p>'
}
async function loadTrend() {
  var d = await api('/admin/api/stats/trend')
  if (!d.success) return
  var days = d.data.days || []
  var max = Math.max(1, Math.max.apply(null, days.map(function (x) { return x.articles })))
  var maxT = Math.max(1, Math.max.apply(null, days.map(function (x) { return x.topics })))
  var bars = days.map(function (x) {
    return '<div class="trend-col"><div class="v">' + (x.articles || '') + '</div>' +
      '<div class="bars" title="' + x.date + ' 成稿 ' + x.articles + ' · 推送 ' + x.pushed + ' · 热点入库 ' + x.topics + '">' +
        '<div class="bar" style="height:' + Math.max(3, Math.round(x.articles / max * 100)) + '%"></div>' +
        '<div class="bar bar-g" style="height:' + Math.max(3, Math.round(x.pushed / max * 100)) + '%"></div>' +
        '<div class="bar bar-t" style="height:' + Math.max(2, Math.round(x.topics / maxT * 100)) + '%"></div>' +
      '</div><div class="x">' + x.date + '</div></div>'
  }).join('')
  var barsEl = document.getElementById('trend-bars')
  if (barsEl) barsEl.innerHTML = bars
  var dist = d.data.platforms || []
  var maxP = Math.max(1, Math.max.apply(null, dist.map(function (x) { return x.n })))
  var distEl = document.getElementById('platform-dist')
  if (distEl) distEl.innerHTML = dist.length ? dist.map(function (x) {
    return '<div class="dist-row"><span class="pname">' + escapeHtml(PLATFORM_SHORTS[x.platform] || x.platform) + '</span>' +
      '<div class="track"><div class="fill" style="width:' + Math.round(x.n / maxP * 100) + '%"></div></div>' +
      '<span class="pval">' + x.n + '</span></div>'
  }).join('') : '<p class="empty-inline">暂无数据</p>'
}
var PLATFORM_SHORTS = { weibo: '微博', zhihu: '知乎', baidu: '百度', douyin: '抖音', toutiao: '头条', kuaishou: '快手', rednote: '小红书', bili: 'B站', bilibili_video: 'B站视频', tieba: '贴吧', tencent_news: '腾讯', netease: '网易', thepaper: '澎湃', wechat_gzh: '微信', ithome: 'IT之家', ifanr: '爱范儿', '36kr': '36氪', sspai: '少数派', github: 'GitHub', hackernews: 'HN', x: 'X', voa: 'VOA', bbc: 'BBC', dw: 'DW', rfi: 'RFI', zaobao: '早报', xianbao: '线报' }
// 流水线流式运行：等待完整结果（服务端心跳保活），完成后再刷新
async function runPipelineStreaming(push, btn) {
  var disabled = []
  document.querySelectorAll('.admin-heading__actions .btn, #btn-p-fetch, #btn-p-run, #btn-p-runpush').forEach(function (b) {
    if (!b.disabled) { disabled.push(b); b.disabled = true }
  })
  if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>运行中…'
  toast('流水线已启动' + (push ? '（含推送）' : '') + '，抓取素材与创作约需几分钟…', 'info')
  try {
    var r = await fetch('/admin/api/pipeline/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(push ? { push: true } : {}),
    })
    var text = await r.text()
    var d = null
    try { d = JSON.parse(text.trim()) } catch (e) { d = { success: false, message: 'HTTP ' + r.status } }
    if (d.success) {
      var s = d.data && d.data.summary ? d.data.summary : {}
      toast('✅ 流水线完成：选题 ' + (s.topicsSelected || 0) + ' · 成稿 ' + (s.articlesCreated || 0) + ' · 推送 ' + (s.pushed || 0))
    } else {
      toast('流水线异常结束：' + (d.message || '未知错误'), 'error')
    }
  } catch (e) {
    toast('流水线请求失败：' + e.message, 'error')
  } finally {
    disabled.forEach(function (b) { b.disabled = false })
    if (btn) btn.innerHTML = btn.id === 'btn-run-push' ? '<i class="fas fa-rocket"></i>运行并推送' : '<i class="fas fa-play"></i>运行流水线'
  }
  if (typeof currentTab !== 'undefined') switchTab(currentTab)
}
function setNavBadge(tab, n) {
  var b = document.getElementById('nav-badge-' + tab)
  if (b && n > 0) { b.hidden = false; b.textContent = n > 99 ? '99+' : n }
}
function metric(v, label) { return '<div><span>' + escapeHtml(v) + '</span><p>' + escapeHtml(label) + '</p></div>' }
function panel(title, body, icon) {
  return '<div class="add-form-panel"><div class="panel-heading"><div><span class="key-icon"><i class="fas ' + icon + '"></i></span><div><h3>' + title + '</h3></div></div></div><p class="fs-sm" style="overflow-wrap:anywhere;">' + body + '</p></div>'
}
function statusText(s) {
  return s === 'success' ? '<span class="bd bd-on">成功</span>' : s === 'running' ? '<span class="bd bd-info">运行中</span>' : s === 'partial' ? '<span class="bd bd-del">部分成功</span>' : '<span class="bd bd-del">失败</span>'
}
async function doAction(url, method, okMsg) {
  var d = await api(url, { method: method })
  if (d.success) { toast(d.data && d.data.message ? d.data.message : okMsg); setTimeout(function () { switchTab(currentTab) }, 600) }
  else toast(d.message || '操作失败', 'error')
}

// ── 热点池 ──
// 板块下拉宽度贴合选中项文字（width:auto 会按最长选项计算，需用隐藏量尺实测选中项）
function fitSectorSelect(sel) {
  if (!sel) return
  var probe = document.getElementById('sel-probe')
  if (!probe) {
    probe = document.createElement('span')
    probe.id = 'sel-probe'
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font-size:0.75rem;'
    document.body.appendChild(probe)
  }
  var opt = sel.options[sel.selectedIndex]
  probe.textContent = opt ? opt.textContent : ''
  var w = Math.ceil(probe.getBoundingClientRect().width) + 44 // 左箭头区 + 右内边距 + 边框
  sel.style.width = Math.max(64, Math.min(w, 150)) + 'px'
}
var topicFilter = { category: '', sector: '' }
var topicPage = { offset: 0, limit: 100 }
async function loadTopics() {
  var el = document.getElementById('admin-content')
  el.innerHTML = '<p class="empty-inline"><i class="fas fa-spinner fa-spin"></i> 加载中…</p>'
  var qs = '/admin/api/topics?limit=' + topicPage.limit + '&offset=' + topicPage.offset + '&category=' + encodeURIComponent(topicFilter.category) + '&sector=' + encodeURIComponent(topicFilter.sector)
  var d = await api(qs)
  if (!d.success) { el.innerHTML = '<div class="al al-e">' + escapeHtml(d.message) + '</div>'; return }
  var data = d.data
  var catTabs = ['全部'].concat(data.categories || [])
  var sectorOpts = ['全部'].concat(data.sectors || [])
  var chip = function (label, val, cur, kind) {
    var active = cur === val || (cur === '' && val === '全部')
    return '<button class="chip ' + (active ? '' : 'chip--gray') + '" data-catfilter="' + escapeHtml(val) + '" data-kind="' + kind + '" style="cursor:pointer;border:none;">' + escapeHtml(label) + '</button>'
  }
  var sectorSelect = '<select id="sector-filter" title="按板块筛选">' +
    sectorOpts.map(function (v) { return '<option value="' + escapeHtml(v) + '"' + (topicFilter.sector === v || (topicFilter.sector === '' && v === '全部') ? ' selected' : '') + '>' + escapeHtml(v) + '</option>' }).join('') + '</select>'
  el.innerHTML =
    '<div class="admin-heading"><div><p class="eyebrow"><span aria-hidden="true"></span>TOPICS</p><h1>热点池</h1>' +
      '<p>批次 ' + escapeHtml(data.batchId || '—') + ' · 共 ' + data.total + ' 条（当前筛选）。下方为自动选题 TOP 候选。</p></div>' +
      '<div class="admin-heading__actions">' +
        '<button class="btn btn-s" id="btn-fetch2"><i class="fas fa-cloud-arrow-down"></i>抓取热点</button>' +
        '<button class="btn btn-p" id="btn-run2"><i class="fas fa-pen-nib"></i>为选中选题写稿</button>' +
      '</div></div>' +
    '<div class="filter-bar">' +
      '<span class="mu">分类</span>' + catTabs.map(function (v) { return chip(v, v === '全部' ? '' : v, topicFilter.category, 'category') }).join('') +
      '<span class="mu" style="margin-inline-start:var(--space-xs);">板块</span>' + sectorSelect +
    '</div>' +
    '<div class="workspace-section"><div class="section-heading section-heading--admin"><div><h2>自动选题候选</h2><p>跨平台去重合并后按热度排序；勾选后可手动写稿。</p></div></div>' +
    '<div class="topic-list" id="selection-list">' +
    (data.selection.length ? data.selection.map(function (g, i) {
      return '<div class="topic-row"><input type="checkbox" class="sel-check" data-key="' + escapeHtml(g.key) + '"' + (i < 3 ? ' checked' : '') + '>' +
        '<span class="topic-row__main"><span class="topic-row__title">' + escapeHtml(g.title) + '</span>' +
        '<span class="topic-row__meta">' + g.platforms.map(function (p) { return '<span class="chip">' + escapeHtml(p) + '</span>' }).join('') +
        '<span class="chip chip--gray">' + escapeHtml(g.category || '综合') + '</span>' +
        '<span class="chip chip--gray">' + escapeHtml(g.sector || '综合') + '</span>' +
        '<span>得分 ' + g.score + '</span></span></span>' +
        (g.hot ? '<span class="topic-row__hot">🔥 ' + escapeHtml(g.hot) + '</span>' : '') +
        '<button class="btn btn-s" data-write="' + escapeHtml(g.key) + '" data-title="' + escapeHtml(g.title) + '" style="flex:0 0 auto;"><i class="fas fa-pen"></i>写稿</button></div>'
    }).join('') : '<div class="empty-state"><i class="fas fa-inbox"></i><h3>暂无热点</h3><p>点击「抓取热点」开始。</p></div>') +
    '</div></div>' +
    '<div class="workspace-section"><div class="section-heading section-heading--admin"><div><h2>原始条目</h2><p>受分类 / 板块筛选影响，每页 100 条。</p></div></div></div>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>热度</th><th>标题</th><th>来源</th><th>分类</th><th>板块</th><th>状态</th></tr></thead><tbody>' +
    data.topics.map(function (t) {
      return '<tr><td style="white-space:nowrap;color:var(--color-accent);font-family:var(--font-mono);font-size:.6875rem;">' + (t.hot_value ? '🔥 ' + escapeHtml(t.hot_value) : '—') + '</td>' +
        '<td class="t-title" style="max-width:26rem;" title="' + escapeHtml(t.title) + (t.hot_value ? '\\n热度：' + escapeHtml(t.hot_value) + ' · 来源：' + escapeHtml(t.platform_name) : '来源：' + escapeHtml(t.platform_name)) + '"><span class="tt">' + escapeHtml(t.title) + '</span></td>' +
        '<td style="white-space:nowrap;"><span class="chip chip--gray">' + escapeHtml(t.platform_name) + '</span></td>' +
        '<td><span class="chip chip--gray">' + escapeHtml(t.category || '综合') + '</span></td>' +
        '<td><span class="chip chip--gray">' + escapeHtml(t.sector || '综合') + '</span></td>' +
        '<td>' + (t.used ? '<span class="chip chip--green">已用</span>' : (t.selected ? '<span class="chip">候选</span>' : '<span class="mu">—</span>')) + '</td></tr>'
    }).join('') + '</tbody></table></div>' +
    '<div class="table-footer"><span>本页 ' + data.topics.length + ' 条</span><div class="pager">' +
      '<button class="btn btn-s"' + (topicPage.offset <= 0 ? ' disabled' : '') + ' id="tp-prev"><i class="fas fa-chevron-left"></i>上一页</button>' +
      '<button class="btn btn-s"' + (topicPage.offset + topicPage.limit >= data.total ? ' disabled' : '') + ' id="tp-next">下一页<i class="fas fa-chevron-right"></i></button>' +
    '</div></div>'
  document.getElementById('btn-fetch2').onclick = function () { doAction('/admin/api/fetch-topics', 'POST', '抓取完成') }
  document.getElementById('btn-run2').onclick = runSelectedWrites
  document.querySelectorAll('[data-catfilter]').forEach(function (b) {
    b.onclick = function () {
      var kind = b.dataset.kind
      if (kind === 'category') topicFilter.category = b.dataset.catfilter
      topicPage.offset = 0
      loadTopics()
    }
  })
  var sf = document.getElementById('sector-filter')
  if (sf) {
    fitSectorSelect(sf)
    sf.onchange = function () { topicFilter.sector = sf.value === '全部' ? '' : sf.value; topicPage.offset = 0; fitSectorSelect(sf); loadTopics() }
  }
  document.querySelectorAll('[data-write]').forEach(function (b) {
    b.onclick = function () { writeByKey(b.dataset.write, b.dataset.title || '', b) }
  })
  var tp = document.getElementById('tp-prev')
  var tn = document.getElementById('tp-next')
  if (tp) tp.onclick = function () { topicPage.offset = Math.max(0, topicPage.offset - topicPage.limit); loadTopics() }
  if (tn) tn.onclick = function () { topicPage.offset += topicPage.limit; loadTopics() }
}
function showWriteModal(title) {
  var old = document.getElementById('write-modal-overlay')
  if (old) old.remove()
  var ov = document.createElement('div')
  ov.className = 'modal-o'
  ov.id = 'write-modal-overlay'
  ov.innerHTML =
    '<div class="modal" style="max-width:38rem;width:92%;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-xs);">' +
        '<h3 style="margin:0;font-size:1.125rem;display:flex;align-items:center;gap:.5rem;"><i class="fas fa-pen-nib" style="color:var(--color-accent);"></i>AI 创作与核验过程</h3>' +
        '<span id="wm-timer" class="chip chip--gray" style="font-family:var(--font-mono);font-size:.75rem;">0s</span>' +
      '</div>' +
      '<p class="mu" style="margin-bottom:var(--space-md);line-height:1.4;word-break:break-all;"><strong>选题：</strong>' + escapeHtml(title || '当前选中话题') + '</p>' +
      '<div style="display:grid;gap:.5rem;margin-bottom:var(--space-md);background:var(--color-bg-subtle, #f9fafb);padding:.875rem 1rem;border-radius:var(--radius-md);border:1px solid var(--color-border);">' +
        '<div id="wstep-1" style="display:flex;align-items:center;gap:.625rem;font-size:.875rem;"><i class="fas fa-spinner fa-spin" style="color:var(--color-accent);width:1.2rem;"></i><span>[1/4] 检索整理各平台事实素材与背景...</span></div>' +
        '<div id="wstep-2" style="display:flex;align-items:center;gap:.625rem;font-size:.875rem;color:var(--color-muted);"><i class="far fa-circle" style="width:1.2rem;"></i><span>[2/4] 资深主编撰写 1800 字爆款正文（黄金骨架）...</span></div>' +
        '<div id="wstep-3" style="display:flex;align-items:center;gap:.625rem;font-size:.875rem;color:var(--color-muted);"><i class="far fa-circle" style="width:1.2rem;"></i><span>[3/4] AIGC 检测官审查 & 智能去AI化多轮改写（≤40分门禁）...</span></div>' +
        '<div id="wstep-4" style="display:flex;align-items:center;gap:.625rem;font-size:.875rem;color:var(--color-muted);"><i class="far fa-circle" style="width:1.2rem;"></i><span>[4/4] 检索无水印配图并完成公众号排版渲染...</span></div>' +
      '</div>' +
      '<div style="margin-bottom:var(--space-md);">' +
        '<label style="display:block;font-size:.75rem;color:var(--color-muted);margin-bottom:.25rem;">详细执行日志</label>' +
        '<pre id="wm-log" style="margin:0;padding:.75rem;background:#1e1e2e;color:#cdd6f4;border-radius:var(--radius-md);font-family:var(--font-mono);font-size:.75rem;line-height:1.6;max-height:14rem;overflow-y:auto;white-space:pre-wrap;word-break:break-all;">🚀 开始组织选题素材...\\n</pre>' +
      '</div>' +
      '<div id="wm-actions" style="display:flex;justify-content:flex-end;gap:.5rem;">' +
        '<button class="btn btn-s" id="wm-close" disabled><i class="fas fa-spinner fa-spin"></i> 正在创作，请稍候…</button>' +
      '</div>' +
    '</div>'
  document.body.appendChild(ov)
  var timerEl = document.getElementById('wm-timer')
  var logEl = document.getElementById('wm-log')
  var closeBtn = document.getElementById('wm-close')
  var seconds = 0
  var timer = setInterval(function () {
    seconds++
    if (timerEl) timerEl.textContent = seconds + 's'
    if (seconds === 3) {
      setStep(2, 'active')
      appendLog('✍️ 选题素材准备完毕，大模型正在撰写 1800 字正文...')
    } else if (seconds === 13) {
      setStep(2, 'done')
      setStep(3, 'active')
      appendLog('🤖 正文初稿完成，正在进行 AIGC 痕迹审查与多轮去AI化改写...')
    } else if (seconds === 23) {
      appendLog('✏️ 正在定向消除模板套话、注入长短句呼吸感...')
    }
  }, 1000)
  function appendLog(text) {
    if (!logEl) return
    logEl.textContent += text + '\\n'
    logEl.scrollTop = logEl.scrollHeight
  }
  function setStep(idx, state) {
    var el = document.getElementById('wstep-' + idx)
    if (!el) return
    var icon = el.querySelector('i')
    if (state === 'active') {
      el.style.color = 'var(--color-text)'
      if (icon) { icon.className = 'fas fa-spinner fa-spin'; icon.style.color = 'var(--color-accent)' }
    } else if (state === 'done') {
      el.style.color = 'var(--color-success, #10b981)'
      if (icon) { icon.className = 'fas fa-check-circle'; icon.style.color = 'var(--color-success, #10b981)' }
    } else if (state === 'fail') {
      el.style.color = 'var(--color-danger, #ef4444)'
      if (icon) { icon.className = 'fas fa-times-circle'; icon.style.color = 'var(--color-danger, #ef4444)' }
    }
  }
  return {
    appendLog: appendLog,
    finish: function (res) {
      clearInterval(timer)
      setStep(1, 'done')
      setStep(2, 'done')
      setStep(3, 'done')
      setStep(4, 'done')
      appendLog('--------------------------------------------------')
      if (res && res.log && res.log.length) {
        appendLog(res.log.join('\\n'))
      }
      appendLog('🎉 创作完成！成稿：《' + (res.title || '') + '》')
      if (closeBtn) {
        closeBtn.disabled = false
        closeBtn.innerHTML = '<i class="fas fa-arrow-right"></i> 前往文章管理'
        closeBtn.className = 'btn btn-p'
        closeBtn.onclick = function () {
          ov.remove()
          switchTab('articles')
        }
      }
      if (res && res.id) {
        var prevBtn = document.createElement('a')
        prevBtn.className = 'btn btn-s'
        prevBtn.href = '/article/' + res.id
        prevBtn.target = '_blank'
        prevBtn.innerHTML = '<i class="fas fa-eye"></i> 预览'
        document.getElementById('wm-actions').insertBefore(prevBtn, closeBtn)
      }
    },
    error: function (errMsg) {
      clearInterval(timer)
      setStep(3, 'fail')
      appendLog('❌ 创作中断: ' + errMsg)
      if (closeBtn) {
        closeBtn.disabled = false
        closeBtn.textContent = '关闭'
        closeBtn.className = 'btn btn-d'
        closeBtn.onclick = function () { ov.remove() }
      }
    }
  }
}
async function runSelectedWrites() {
  var btn = document.getElementById('btn-run2')
  var checkedBoxes = Array.prototype.slice.call(document.querySelectorAll('.sel-check:checked'))
  if (!checkedBoxes.length) { toast('请先勾选选题', 'error'); return }
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 批量写作中…' }
  var modal = showWriteModal('批量创作（共 ' + checkedBoxes.length + ' 篇）')
  try {
    for (var i = 0; i < checkedBoxes.length; i++) {
      var key = checkedBoxes[i].dataset.key
      modal.appendLog('\\n[' + (i + 1) + '/' + checkedBoxes.length + '] 正在创作成稿...')
      var d = await api('/admin/api/write-article', { method: 'POST', body: { key: key } })
      if (d.success) {
        modal.appendLog('✅ 第 ' + (i + 1) + ' 篇成稿：《' + d.data.title + '》')
      } else {
        modal.appendLog('❌ 第 ' + (i + 1) + ' 篇失败: ' + (d.message || '未知错误'))
      }
    }
    modal.finish({ title: '批量成稿完成' })
  } catch (err) {
    modal.error(err.message || String(err))
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-pen-nib"></i>为选中选题写稿' }
  }
}
async function writeByKey(key, title, btnEl) {
  if (btnEl) {
    btnEl.disabled = true
    btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 创作中…'
  }
  var modal = showWriteModal(title || key)
  try {
    var d = await api('/admin/api/write-article', { method: 'POST', body: { key: key } })
    if (d.success) {
      modal.finish(d.data)
    } else {
      modal.error(d.message || '创作失败')
    }
  } catch (err) {
    modal.error('请求网络异常: ' + (err.message || err))
  } finally {
    if (btnEl) {
      btnEl.disabled = false
      btnEl.innerHTML = '<i class="fas fa-pen"></i>写稿'
    }
  }
}

// ── 文章 ──
var GENRE_LABELS = { brief: '热点快评', deep: '深度解读', list: '盘点清单', opinion: '观点评论' }
var artState = { offset: 0, limit: 15, status: '', genre: '', category: '', q: '' }
async function loadArticles() {
  var el = document.getElementById('admin-content')
  el.innerHTML =
    '<div class="admin-heading"><div><p class="eyebrow"><span aria-hidden="true"></span>ARTICLES</p><h1>文章管理</h1>' +
    '<p>创作完成后自动通过去AI化核验，超标文章禁止推送。</p></div></div>' +
    '<div class="filter-bar">' +
      '<select id="af-status"><option value="">全部状态</option><option value="ready">待推送</option><option value="pushed">已推送</option><option value="failed">推送失败</option></select>' +
      '<select id="af-genre"><option value="">全部体裁</option>' + Object.keys(GENRE_LABELS).map(function (k) { return '<option value="' + k + '">' + GENRE_LABELS[k] + '</option>' }).join('') + '</select>' +
      '<select id="af-category"><option value="">全部分类</option>' + ['综合','社区','新闻','科技','国际'].map(function (v) { return '<option value="' + v + '">' + v + '</option>' }).join('') + '</select>' +
      '<input type="search" id="af-q" class="search-box" placeholder="搜索标题 / 摘要…">' +
      '<button class="btn btn-s" id="af-search"><i class="fas fa-search"></i>搜索</button>' +
      '<button class="btn btn-s" id="af-refresh" title="刷新列表"><i class="fas fa-arrows-rotate"></i>刷新</button>' +
    '</div>' +
    '<div class="fc" style="flex-wrap:wrap;gap:.35rem;margin-block-end:var(--space-sm);" id="af-counts"><span class="mu">加载中…</span></div>' +
    '<div class="batch-bar" id="art-batch"><span id="art-batch-n"></span>' +
      '<button class="btn btn-p" id="art-batch-push"><i class="fas fa-paper-plane"></i>批量推送</button>' +
      '<button class="btn btn-d" id="art-batch-del"><i class="fas fa-trash"></i>批量删除</button>' +
      '<button class="btn btn-gh" id="art-batch-cancel">取消选择</button>' +
    '</div>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th style="width:2rem;"><input type="checkbox" id="art-chk-all" style="width:1rem;height:1rem;accent-color:var(--color-accent);"></th>' +
      '<th style="width:4.5rem;">封面</th><th>标题 / 摘要</th><th>体裁</th><th>状态</th><th>AI痕</th><th>创建时间</th><th style="text-align:end;">操作</th>' +
    '</tr></thead><tbody id="art-tbody"><tr><td colspan="8" class="empty-inline" style="padding:1rem;"><i class="fas fa-spinner fa-spin"></i> 加载中…</td></tr></tbody></table></div>' +
    '<div class="table-footer"><span id="art-page-info"></span><div class="pager" id="art-pager"></div></div>'

  document.getElementById('af-status').value = artState.status
  document.getElementById('af-genre').value = artState.genre
  document.getElementById('af-category').value = artState.category
  document.getElementById('af-q').value = artState.q
  document.getElementById('af-status').onchange = function () { artState.status = this.value; artState.offset = 0; loadArticleList() }
  document.getElementById('af-genre').onchange = function () { artState.genre = this.value; artState.offset = 0; loadArticleList() }
  document.getElementById('af-category').onchange = function () { artState.category = this.value; artState.offset = 0; loadArticleList() }
  document.getElementById('af-search').onclick = function () { artState.q = document.getElementById('af-q').value.trim(); artState.offset = 0; loadArticleList() }
  document.getElementById('af-q').onkeydown = function (e) { if (e.key === 'Enter') { artState.q = this.value.trim(); artState.offset = 0; loadArticleList() } }
  document.getElementById('af-refresh').onclick = function () { loadArticleList(); toast('已刷新', 'info') }
  document.getElementById('art-chk-all').onchange = function () {
    document.querySelectorAll('.art-chk').forEach(function (c) { c.checked = document.getElementById('art-chk-all').checked })
    updateBatchBar()
  }
  document.getElementById('art-batch-cancel').onclick = function () {
    document.querySelectorAll('.art-chk').forEach(function (c) { c.checked = false })
    document.getElementById('art-chk-all').checked = false
    updateBatchBar()
  }
  document.getElementById('art-batch-push').onclick = function () {
    var st = {}
    document.querySelectorAll('.art-chk').forEach(function (c) { st[c.dataset.id] = c.dataset.status })
    var ids = checkedIds().filter(function (id) { return st[id] !== 'pushed' })
    var skipped = checkedIds().length - ids.length
    if (!ids.length) { toast('所选文章均已推送，无需重复推送', 'error'); return }
    if (!confirm('批量推送 ' + ids.length + ' 篇到微信草稿箱？未通过去AI化核验的会被拒绝。' + (skipped ? '（已跳过 ' + skipped + ' 篇已推送）' : ''))) return
    batchAction('push', ids)
  }
  document.getElementById('art-batch-del').onclick = function () {
    var ids = checkedIds()
    if (!ids.length) return
    if (!confirm('确定批量删除 ' + ids.length + ' 篇？不可恢复。')) return
    batchAction('delete', ids)
  }
  await loadArticleList()
}
function checkedIds() {
  return Array.prototype.map.call(document.querySelectorAll('.art-chk:checked'), function (c) { return c.dataset.id })
}
function updateBatchBar() {
  var n = checkedIds().length
  var bar = document.getElementById('art-batch')
  if (!bar) return
  bar.classList.toggle('show', n > 0)
  document.getElementById('art-batch-n').textContent = '已选 ' + n + ' 篇'
}
async function batchAction(action, ids) {
  toast('正在批量' + (action === 'push' ? '推送' : '删除') + ' ' + ids.length + ' 篇…', 'info')
  var d = await api('/admin/api/articles/batch', { method: 'POST', body: { ids: ids, action: action } })
  if (d.success) {
    toast((action === 'push' ? '批量推送完成：成功 ' : '批量删除完成：') + d.data.ok + ' / ' + d.data.total + (d.data.failed ? '（失败 ' + d.data.failed + '，可在列表看原因）' : ''))
    loadArticleList()
  } else toast(d.message || '批量操作失败', 'error')
}
async function loadArticleList() {
  var qs = '/admin/api/articles?limit=' + artState.limit + '&offset=' + artState.offset +
    (artState.status ? '&status=' + artState.status : '') + (artState.genre ? '&genre=' + artState.genre : '') +
    (artState.category ? '&category=' + encodeURIComponent(artState.category) : '') + (artState.q ? '&q=' + encodeURIComponent(artState.q) : '')
  var d = await api(qs)
  var tbody = document.getElementById('art-tbody')
  if (!tbody) return
  if (!d.success) { tbody.innerHTML = '<tr><td colspan="8"><div class="al al-e">' + escapeHtml(d.message) + '</div></td></tr>'; return }
  // 状态统计 chips（点击筛选）
  var cnt = d.data.counts
  if (cnt) {
    var cur = artState.status
    var mk = function (label, val, n) {
      var active = (cur === val) || (cur === '' && val === '')
      return '<button class="chip ' + (active ? '' : 'chip--gray') + '" data-cnt="' + val + '" style="cursor:pointer;border:none;">' + label + ' ' + n + '</button>'
    }
    var el = document.getElementById('af-counts')
    if (el) el.innerHTML = mk('全部', '', cnt.all) + mk('待推送', 'ready', cnt.ready) + mk('已推送', 'pushed', cnt.pushed) + mk('推送失败', 'failed', cnt.failed)
    el.querySelectorAll('[data-cnt]').forEach(function (b) {
      b.onclick = function () {
        artState.status = b.dataset.cnt; artState.offset = 0
        document.getElementById('af-status').value = artState.status
        loadArticleList()
      }
    })
  }
  var list = d.data.articles
  tbody.innerHTML = list.length ? list.map(function (a) {
    var imgs = a.images || []
    var cover = a.cover_url || (imgs[0] && imgs[0].url) || ''
    return '<tr data-id="' + escapeHtml(a.id) + '">' +
      '<td><input type="checkbox" class="art-chk" data-id="' + escapeHtml(a.id) + '" data-status="' + escapeHtml(a.status) + '" style="width:1rem;height:1rem;accent-color:var(--color-accent);"></td>' +
      '<td>' + (cover ? '<img class="img-thumb" style="width:3.6rem;height:2.4rem;object-fit:cover;border-radius:var(--radius-xs);" src="' + escapeHtml(cover) + (cover.startsWith('data:') ? '' : (cover.includes('?') ? '&' : '?') + '_t=' + Date.now()) + '" alt="" loading="lazy">' : '<span class="key-icon" style="width:2.4rem;height:1.7rem;"><i class="fas fa-image"></i></span>') + '</td>' +
      '<td class="t-title" title="' + escapeHtml(a.title) + (a.digest ? '\\n\\n摘要：' + escapeHtml(a.digest) : '') + '"><a class="tt" href="/article/' + escapeHtml(a.id) + '" target="_blank" style="color:inherit;text-decoration:none;">' + escapeHtml(a.title) + '</a>' +
        '<span class="td-digest">' + escapeHtml(a.digest || '') + '</span></td>' +
      '<td>' + genreChipHtml(a.genre) + '</td>' +
      '<td>' + statusBadge(a.status) + '</td>' +
      '<td>' + aiBadge(a) + '</td>' +
      '<td style="white-space:nowrap;color:var(--color-muted);">' + fmtTime(a.created_at) + '</td>' +
      '<td class="t-actions">' +
        (a.status !== 'pushed'
          ? '<button class="btn btn-p" data-push="' + a.id + '" title="推送"><i class="fas fa-paper-plane"></i></button>'
          : '<button class="btn btn-s" data-repush="' + a.id + '" title="重新推送（生成一条新草稿，旧草稿请到公众号后台删除）"><i class="fas fa-rotate-right"></i>重推</button>') +
        '<button class="btn btn-s" data-edit="' + a.id + '" title="编辑"><i class="fas fa-pen-to-square"></i></button>' +
        '<button class="btn btn-s" data-humanize="' + a.id + '" title="重新去AI化"><i class="fas fa-shield-halved"></i></button>' +
        '<button class="btn btn-s" data-rewrite="' + a.id + '" title="重写"><i class="fas fa-rotate"></i></button>' +
        '<button class="btn btn-s" data-recover="' + a.id + '" title="换封面"><i class="fas fa-wand-magic-sparkles"></i></button>' +
        '<a class="btn btn-s" href="/article/' + escapeHtml(a.id) + '" target="_blank" title="预览"><i class="fas fa-eye"></i></a>' +
        '<button class="btn btn-d" data-del="' + a.id + '" title="删除"><i class="fas fa-trash"></i></button>' +
      '</td></tr>'
  }).join('') : '<tr><td colspan="8"><div class="empty-state" style="margin:1rem;"><i class="fas fa-inbox"></i><h3>没有匹配的文章</h3><p>调整筛选条件或运行流水线。</p></div></td></tr>'
  // 分页器
  var total = d.data.total, offset = d.data.offset, limit = d.data.limit
  var page = Math.floor(offset / limit) + 1
  var pages = Math.max(1, Math.ceil(total / limit))
  document.getElementById('art-page-info').textContent = '共 ' + total + ' 篇 · 第 ' + page + ' / ' + pages + ' 页'
  var pager = document.getElementById('art-pager')
  pager.innerHTML =
    '<button class="btn btn-s"' + (offset <= 0 ? ' disabled' : '') + ' id="art-prev"><i class="fas fa-chevron-left"></i>上一页</button>' +
    '<button class="btn btn-s"' + (offset + limit >= total ? ' disabled' : '') + ' id="art-next">下一页<i class="fas fa-chevron-right"></i></button>'
  document.getElementById('art-prev').onclick = function () { artState.offset = Math.max(0, offset - limit); loadArticleList() }
  document.getElementById('art-next').onclick = function () { artState.offset = offset + limit; loadArticleList() }
  bindArticleActions()
  // 勾选联动
  document.querySelectorAll('.art-chk').forEach(function (c) { c.onchange = updateBatchBar })
  updateBatchBar()
}
function genreChipHtml(g) { return '<span class="chip chip--gray">' + escapeHtml(GENRE_LABELS[g] || g) + '</span>' }
function aiBadge(a) {
  if (a.ai_score == null) return '<span class="mu">—</span>'
  var ok = Number(a.ai_score) <= 40
  return '<span class="chip ' + (ok ? 'chip--green' : 'chip--red') + '" title="AI 痕迹分（越低越像人写）">' + Math.round(a.ai_score) + '</span>'
}
function bindArticleActions() {
  document.querySelectorAll('[data-repush]').forEach(function (b) {
    b.onclick = async function () {
      if (!confirm('重新推送会在草稿箱生成一条新草稿（旧草稿请到公众号后台删除），继续？')) return
      b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'
      var d = await api('/admin/api/articles/' + b.dataset.repush + '/push', { method: 'POST' })
      if (d.success) { toast('已重新推送：' + (d.data.media_id || '')); loadArticleList() }
      else { toast(d.message || '重推失败', 'error'); b.disabled = false; b.innerHTML = '<i class="fas fa-rotate-right"></i>重推' }
    }
  })
  document.querySelectorAll('[data-push]').forEach(function (b) {
    b.onclick = async function () {
      b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'
      var d = await api('/admin/api/articles/' + b.dataset.push + '/push', { method: 'POST' })
      if (d.success) { toast('已推送草稿箱：' + (d.data.media_id || '')); loadArticleList() }
      else { toast(d.message || '推送失败', 'error'); b.disabled = false; b.innerHTML = '<i class="fas fa-paper-plane"></i>' }
    }
  })
  document.querySelectorAll('[data-del]').forEach(function (b) {
    b.onclick = async function () {
      if (!confirm('确定删除该文章？')) return
      var d = await api('/admin/api/articles/' + b.dataset.del, { method: 'DELETE' })
      if (d.success) { toast('已删除'); loadArticleList() } else toast(d.message || '删除失败', 'error')
    }
  })
  document.querySelectorAll('[data-rewrite]').forEach(function (b) {
    b.onclick = async function () {
      if (!confirm('重新创作会调用 LLM 生成新版本并替换当前稿，继续？')) return
      b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'
      var d = await api('/admin/api/articles/' + b.dataset.rewrite + '/rewrite', { method: 'POST' })
      if (d.success) { toast('已重写'); loadArticleList() } else { toast(d.message || '重写失败', 'error'); b.disabled = false; b.innerHTML = '<i class="fas fa-rotate"></i>' }
    }
  })
  document.querySelectorAll('[data-edit]').forEach(function (b) {
    b.onclick = function () { openEditor(b.dataset.edit) }
  })
  document.querySelectorAll('[data-humanize]').forEach(function (b) {
    b.onclick = async function () {
      b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'
      var d = await api('/admin/api/articles/' + b.dataset.humanize + '/humanize', { method: 'POST' })
      if (d.success) { toast('去AI化完成：' + (d.data.initial_score ?? '?') + ' → ' + d.data.ai_score + ' 分（' + d.data.rounds + ' 轮）'); loadArticleList() }
      else { toast(d.message || '核验失败', 'error'); b.disabled = false; b.innerHTML = '<i class="fas fa-shield-halved"></i>' }
    }
  })
  document.querySelectorAll('[data-recover]').forEach(function (b) {
    b.onclick = async function () {
      b.disabled = true
      b.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'
      toast('正在重新检索并生成新封面，请稍候…', 'info')
      var d = await api('/admin/api/articles/' + b.dataset.recover + '/recover-cover', { method: 'POST' })
      if (d.success) {
        toast('封面已成功更新（来源：' + d.data.cover_source + '）', 'success')
        loadArticleList()
      } else {
        toast(d.message || '更换封面失败', 'error')
        b.disabled = false
        b.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i>'
      }
    }
  })
}

// ── 定时任务（独立栏目）──
async function loadScheduleTab() {
  var el = document.getElementById('admin-content')
  el.innerHTML =
    '<div class="admin-heading"><div><p class="eyebrow"><span aria-hidden="true"></span>SCHEDULE</p><h1>定时任务</h1>' +
    '<p>每天到达设定时间自动执行（北京时间）。两种定时相互独立：自动抓取只刷新热点池，自动运行跑完整流水线。</p></div></div>' +
    '<div id="schedule-card"><p class="empty-inline"><i class="fas fa-spinner fa-spin"></i> 加载中…</p></div>' +
    '<div class="workspace-section"><div class="section-heading section-heading--admin"><div><h2>自定义自动任务</h2><p>自由组合动作与时间点，系统按计划自动执行。</p></div>' +
    '<div class="admin-heading__actions"><button class="btn btn-p" id="ct-new"><i class="fas fa-plus"></i>新建任务</button></div></div>' +
    '<div id="custom-tasks"><p class="empty-inline"><i class="fas fa-spinner fa-spin"></i> 加载中…</p></div></div>' +
    '<div class="workspace-section"><div class="section-heading section-heading--admin"><div><h2>触发机制说明</h2></div></div>' +
    '<div class="add-form-panel"><p class="fs-sm" style="line-height:2;">' +
    '⏰ 定时由<b>站点请求触发</b>（看门狗模式）：到点时段若站点无任何访问，任务会顺延到下一次有访问时执行。' +
    '建议配合免费监控（如 UptimeRobot）每 5-10 分钟拨针一次首页，保证准点触发。<br>' +
    '🔗 外部定时器可直接调：<span class="cd">POST /api/cron/run</span>（请求头 <span class="cd">X-CRON-Secret</span>，值见设置页；追加 <span class="cd">?push=1</span> 让流水线跑完直接推送）。<br>' +
    '💡 提示：到点时若距上次抓取不足 5 分钟会自动去重；流水线运行时也会顺带刷新热点，无需重复安排。</p>' +
    '</div></div>'
  await loadScheduleCard()
  await loadCustomTasks()
}

// ── 自定义自动任务 ──
var TASK_ACTIONS = { pipeline: '完整流水线', fetch: '抓取热点', push: '推送待推送', keyword: '关键字创作' }
async function loadCustomTasks() {
  var el = document.getElementById('custom-tasks')
  if (!el) return
  var d = await api('/admin/api/custom-tasks')
  if (!d.success) { el.innerHTML = '<div class="al al-e">' + escapeHtml(d.message) + '</div>'; return }
  var tasks = d.data.tasks || []
  el.innerHTML =
    (tasks.length ? '<div class="gp">' + tasks.map(function (t) {
      var p2 = t.params || {}
      var paramText = t.action === 'pipeline' ? '篇数 ' + (p2.maxArticles || 3) + ' · 推送' + (p2.push ? '开' : '关')
        : t.action === 'keyword' ? '关键词「' + escapeHtml(p2.keyword || '') + '」'
        : t.action === 'push' ? '推送全部待推送文章' : '只刷新热点池'
      return '<div class="ki"><div class="key-main"><span class="key-icon"><i class="fas fa-' + (t.action === 'keyword' ? 'magnifying-glass' : t.action === 'push' ? 'paper-plane' : t.action === 'fetch' ? 'cloud-arrow-down' : 'diagram-project') + '"></i></span>' +
        '<div style="min-width:0;flex:1;"><div class="key-meta"><h3>' + escapeHtml(t.name) + '</h3><span class="key-meta__sep">·</span><p>' + escapeHtml(t.times) + '</p></div>' +
        '<p class="mu" style="margin:4px 0 0;">' + (t.enabled ? '<span class="chip">已启用</span>' : '<span class="chip chip--gray">停用</span>') + ' <span class="chip chip--gray">' + (TASK_ACTIONS[t.action] || t.action) + '</span> <span class="mu">' + escapeHtml(paramText) + '</span></p>' +
        '<p class="mu" style="margin:4px 0 0;">下次 ' + escapeHtml(t.nextRunText || '—') + (t.lastRun ? ' · 上次 ' + fmtTime(t.lastRun) + '：' + escapeHtml((t.lastResult || '').slice(0, 40)) : '') + '</p></div></div>' +
        '<div class="key-actions">' +
          '<button class="btn btn-s" data-ct-run="' + escapeHtml(t.id) + '" title="立即执行"><i class="fas fa-play"></i></button>' +
          '<button class="btn btn-s" data-ct-edit="' + escapeHtml(t.id) + '" title="编辑"><i class="fas fa-pen-to-square"></i></button>' +
          '<button class="btn btn-d" data-ct-del="' + escapeHtml(t.id) + '" title="删除"><i class="fas fa-trash"></i></button>' +
        '</div></div>'
    }).join('') + '</div>' : '<div class="empty-state"><i class="fas fa-robot"></i><h3>还没有自定义任务</h3><p>点「新建任务」创建，如：每天 20:00 推送待推送文章、每天 19:00 对关键词做一次创作。</p></div>')
  document.getElementById('ct-new').onclick = function () { openTaskModal(null, d.data.actions) }
  el.querySelectorAll('[data-ct-edit]').forEach(function (b) {
    b.onclick = function () {
      var t = tasks.find(function (x) { return x.id === b.dataset.ctEdit })
      if (t) openTaskModal(t, d.data.actions)
    }
  })
  el.querySelectorAll('[data-ct-del]').forEach(function (b) {
    b.onclick = async function () {
      if (!confirm('确定删除该任务？')) return
      var d2 = await api('/admin/api/custom-tasks/' + b.dataset.ctDel, { method: 'DELETE' })
      if (d2.success) { toast('已删除'); loadCustomTasks() } else toast(d2.message || '删除失败', 'error')
    }
  })
  el.querySelectorAll('[data-ct-run]').forEach(function (b) {
    b.onclick = async function () {
      b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'
      var d2 = await api('/admin/api/custom-tasks/' + b.dataset.ctRun + '/run', { method: 'POST' })
      b.disabled = false; b.innerHTML = '<i class="fas fa-play"></i>'
      if (d2.success) toast('已执行：' + (d2.data.result || '完成'))
      else toast(d2.message || '执行失败', 'error')
      loadCustomTasks()
    }
  })
}
function openTaskModal(task, actions) {
  var t = task || { name: '', action: 'pipeline', times: '08:30', enabled: true, params: {} }
  var p2 = t.params || {}
  var ov = document.createElement('div')
  ov.className = 'modal-o'
  ov.innerHTML =
    '<div class="modal">' +
      '<h3>' + (task ? '编辑任务' : '新建自定义任务') + '</h3>' +
      '<div class="fg"><label for="ct-name">任务名称</label><input id="ct-name" value="' + escapeHtml(t.name) + '" placeholder="例：晚间推送待推送文章"></div>' +
      '<div class="fg"><label for="ct-action">动作</label><select id="ct-action">' +
        actions.map(function (a) { return '<option value="' + a + '"' + (t.action === a ? ' selected' : '') + '>' + (TASK_ACTIONS[a] || a) + '</option>' }).join('') + '</select></div>' +
      '<div class="fg"><label for="ct-times">执行时间（北京时间，多个用逗号分隔）</label><input id="ct-times" value="' + escapeHtml(t.times) + '" placeholder="08:00,20:00"></div>' +
      '<div class="fg" id="ct-kw-wrap" style="display:none;"><label for="ct-keyword">创作关键词</label><input id="ct-keyword" value="' + escapeHtml(p2.keyword || '') + '" placeholder="例：AI 手机"></div>' +
      '<div class="fg" id="ct-max-wrap" style="display:none;"><label for="ct-max">每次成稿篇数（1-8）</label><input id="ct-max" value="' + escapeHtml(String(p2.maxArticles || 3)) + '"></div>' +
      '<div class="fg"><label class="fc" style="gap:.4rem;cursor:pointer;"><input type="checkbox" id="ct-enabled" style="width:1rem;height:1rem;accent-color:var(--color-accent);"' + (t.enabled ? ' checked' : '') + '>启用</label></div>' +
      '<div class="fc" style="justify-content:flex-end;gap:var(--space-2xs);">' +
        '<button class="btn btn-s" id="ct-cancel">取消</button>' +
        '<button class="btn btn-p" id="ct-ok"><i class="fas fa-floppy-disk"></i>保存</button>' +
      '</div>' +
    '</div>'
  document.body.appendChild(ov)
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove() })
  document.getElementById('ct-cancel').onclick = function () { ov.remove() }
  var refreshParams = function () {
    var a = document.getElementById('ct-action').value
    document.getElementById('ct-kw-wrap').style.display = a === 'keyword' ? 'block' : 'none'
    document.getElementById('ct-max-wrap').style.display = a === 'pipeline' ? 'block' : 'none'
  }
  document.getElementById('ct-action').onchange = refreshParams
  refreshParams()
  document.getElementById('ct-ok').onclick = async function () {
    var btn = this
    btn.disabled = true
    var body = {
      id: t.id || undefined, name: document.getElementById('ct-name').value.trim(),
      action: document.getElementById('ct-action').value,
      times: document.getElementById('ct-times').value,
      enabled: document.getElementById('ct-enabled').checked,
      maxArticles: parseInt(document.getElementById('ct-max').value, 10) || undefined,
      keyword: document.getElementById('ct-keyword') ? document.getElementById('ct-keyword').value.trim() : undefined,
    }
    var d = await api('/admin/api/custom-tasks' + (t.id ? '/' + t.id : ''), { method: t.id ? 'PUT' : 'POST', body: body })
    if (d.success) { ov.remove(); toast('任务已保存'); loadCustomTasks() }
    else { btn.disabled = false; toast(d.message || '保存失败', 'error') }
  }
}

// ── 自定义写作 ──

// ── 自定义写作 ──
var writeState = { mode: 'imitate', presets: [] }
async function loadWriting() {
  var el = document.getElementById('admin-content')
  var dp = await api('/admin/api/custom/styles')
  writeState.presets = dp.success ? dp.data.presets : []
  var modeMeta = {
    keyword: { label: '关键字创作', desc: '输入关键词，自动搜索全网相关热门素材（新闻 + 26 源热榜），生成爆款标题与约 1800 字内容，并智能配图、去AI化核验。' },
    imitate: { label: '文章仿写', desc: '拆解原文的文风档案（结构/句式/节奏/词汇），以同样风格写全新内容。仿的是风格，不是内容。' },
    rewrite: { label: '二次创作', desc: '同一事实域换角度重构：换视角、换骨架、表述去重，补充原文没展开的影响分析。' },
    polish: { label: '文章润色', desc: '语言风格转换：去 AI 味、调节奏、细节具体化。内容与结构保持不变。' },
  }
  var modeBtns = Object.keys(modeMeta).map(function (m) {
    var active = writeState.mode === m
    return '<button class="btn ' + (active ? 'btn-p' : 'btn-s') + '" data-wmode="' + m + '">' + modeMeta[m].label + '</button>'
  }).join('')
  el.innerHTML =
    '<div class="admin-heading"><div><p class="eyebrow"><span aria-hidden="true"></span>CUSTOM WRITING</p><h1>自定义写作</h1>' +
    '<p id="w-mode-desc">' + escapeHtml(modeMeta[writeState.mode].desc) + '</p></div></div>' +
    '<div class="fc" style="gap:.35rem;margin-block-end:var(--space-sm);">' + modeBtns + '</div>' +
    '<div class="setting-grid">' +
      '<div class="add-form-panel" id="w-source-panel">' +
        '<div class="panel-heading"><div><span class="key-icon"><i class="fas fa-file-import"></i></span><div><h3>原文</h3></div></div>' +
          '<button class="btn btn-s" id="w-fetch-url"><i class="fas fa-cloud-arrow-down"></i>从链接抓取</button></div>' +
        '<div class="fg"><label for="w-url">文章链接（公众号 / 新闻站 / 博客）</label>' +
          '<input id="w-url" type="url" placeholder="https://…" style="margin-bottom:6px;">' +
          '<p class="form-helper">点「从链接抓取」自动填入标题与正文；抓不到的页面可直接粘贴文本</p></div>' +
        '<div class="fg"><label for="w-text">原文正文（≥120 字，保留段落）</label>' +
          '<textarea id="w-text" rows="10" style="font-size:.8125rem;"></textarea></div>' +
      '</div>' +
      '<div class="add-form-panel" id="w-keyword-panel" style="display:none;">' +
        '<div class="panel-heading"><div><span class="key-icon"><i class="fas fa-magnifying-glass-chart"></i></span><div><h3>关键词</h3></div></div></div>' +
        '<div class="fg"><label for="w-keyword">创作关键词（2-10 字为宜）</label>' +
          '<input id="w-keyword" placeholder="例：新能源车 / AI 手机 / 秋季护肤 / 以旧换新">' +
          '<p class="form-helper">系统自动搜索相关新闻与全网热榜素材，从素材中提炼爆款角度成稿并配图</p></div>' +
      '</div>' +
      '<div class="add-form-panel">' +
        '<div class="panel-heading"><div><span class="key-icon"><i class="fas fa-sliders"></i></span><div><h3>创作参数</h3></div></div></div>' +
        '<div class="fg" id="w-topic-wrap"><label for="w-newtopic" id="w-topic-label">新主题 / 切入角度（可选）</label>' +
          '<input id="w-newtopic" placeholder="留空则自动选择最佳角度">' +
          '<p class="form-helper" id="w-topic-help">仿写：填新主题（原文只提供文风）；二创：填切入角度</p></div>' +
        '<div class="fg"><label for="w-style">文风</label>' +
          '<select id="w-style">' + writeState.presets.map(function (p) { return '<option value="' + escapeHtml(p.value) + '"' + (p.value === 'auto' ? ' selected' : '') + '>' + escapeHtml(p.label) + '</option>' }).join('') + '</select></div>' +
        '<div class="fg"><label for="w-custom-style">自定义文风描述（可选，优先于预设）</label>' +
          '<input id="w-custom-style" placeholder="例：像和老友聊天，爱用比喻，句子短"></div>' +
        '<button class="btn btn-p btn-submit" id="w-generate"><i class="fas fa-wand-magic-sparkles"></i>开始创作</button>' +
        '<p class="form-helper" style="margin-top:8px;">创作完成后自动通过去AI化核验（AI 痕迹评分），结果进入「文章管理」，可直接编辑 / 推送</p>' +
      '</div>' +
    '</div>' +
    '<div id="w-result"></div>'

  document.querySelectorAll('[data-wmode]').forEach(function (b) {
    b.onclick = function () {
      writeState.mode = b.dataset.wmode
      document.getElementById('w-mode-desc').textContent = modeMeta[writeState.mode].desc
      document.querySelectorAll('[data-wmode]').forEach(function (x) {
        x.className = x === b ? 'btn btn-p' : 'btn btn-s'
      })
      document.getElementById('w-topic-wrap').style.display = (writeState.mode === 'polish' || writeState.mode === 'keyword') ? 'none' : 'block'
      document.getElementById('w-source-panel').style.display = writeState.mode === 'keyword' ? 'none' : 'block'
      document.getElementById('w-keyword-panel').style.display = writeState.mode === 'keyword' ? 'block' : 'none'
    }
  })
  document.getElementById('w-topic-wrap').style.display = (writeState.mode === 'polish' || writeState.mode === 'keyword') ? 'none' : 'block'
  document.getElementById('w-source-panel').style.display = writeState.mode === 'keyword' ? 'none' : 'block'
  document.getElementById('w-keyword-panel').style.display = writeState.mode === 'keyword' ? 'block' : 'none'
  document.getElementById('w-fetch-url').onclick = async function () {
    var url = document.getElementById('w-url').value.trim()
    if (!url) { toast('请先填入文章链接', 'error'); return }
    var btn = this
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>抓取中'
    var d = await api('/admin/api/custom/extract', { method: 'POST', body: { url: url } })
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-cloud-arrow-down"></i>从链接抓取'
    if (d.success) {
      document.getElementById('w-text').value = '标题：' + d.data.title + '\\n\\n' + d.data.text
      var src = d.data.source === 'wechat' ? '微信公众号' + (d.data.author ? '《' + d.data.author + '》' : '') + ' · 识别 ' + (d.data.images || []).length + ' 张配图' : '网页文章'
      var line = document.createElement('p')
      line.className = 'form-helper'
      line.innerHTML = '<i class="fas fa-circle-check" style="color:var(--color-success)"></i> 已识别：' + escapeHtml(src) + ' · 正文 ' + d.data.text.length + ' 字'
      document.getElementById('w-url').closest('.fg').appendChild(line)
      toast('抓取成功：' + (d.data.title || d.data.text.length + ' 字'))
    } else toast(d.message || '抓取失败', 'error')
  }
  document.getElementById('w-generate').onclick = async function () {
    var btn = this
    var isKw = writeState.mode === 'keyword'
    var kw = isKw ? document.getElementById('w-keyword').value.trim() : ''
    var text = document.getElementById('w-text').value.trim()
    if (isKw && kw.length < 2) { toast('请输入创作关键词（至少 2 个字）', 'error'); return }
    if (!isKw && text.length < 120) { toast('原文至少 120 字（粘贴正文或从链接抓取）', 'error'); return }
    btn.disabled = true
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>' + (isKw ? '搜素材 · 创作 · 配图 · 核验中…' : '创作中…（含去AI化核验，约 1-2 分钟）')
    document.getElementById('w-result').innerHTML = ''
    var d
    if (isKw) {
      d = await api('/admin/api/custom/keyword', { method: 'POST', body: {
        keyword: kw,
        style: document.getElementById('w-style').value,
        customStyle: document.getElementById('w-custom-style').value.trim(),
      } })
    } else {
      d = await api('/admin/api/custom/write', { method: 'POST', body: {
        mode: writeState.mode,
        text: text,
        newTopic: document.getElementById('w-newtopic').value.trim(),
        style: document.getElementById('w-style').value,
        customStyle: document.getElementById('w-custom-style').value.trim(),
      } })
    }
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i>开始创作'
    if (!d.success) { toast(d.message || '生成失败', 'error'); return }
    setNavBadge('articles', undefined)
    var r = d.data
    document.getElementById('w-result').innerHTML =
      '<div class="add-form-panel" style="margin-block-start:var(--space-sm);">' +
        '<div class="panel-heading"><div><span class="key-icon"><i class="fas fa-check"></i></span><div><h3>' + escapeHtml(r.title) + '</h3>' +
        '<p>AI 痕迹 ' + (r.aiScore != null ? r.aiScore + ' 分' : '—') + (r.rounds ? ' · 改写 ' + r.rounds + ' 轮' : '') + '</p></div></div></div>' +
        '<pre class="log-box">' + escapeHtml((r.log || []).join('\\n')) + '</pre>' +
        '<div class="fc" style="margin-top:8px;">' +
          '<a class="btn btn-p" href="/article/' + escapeHtml(r.id) + '" target="_blank"><i class="fas fa-eye"></i>预览排版</a>' +
          '<button class="btn btn-s" onclick="switchTab(\\'articles\\')"><i class="fas fa-newspaper"></i>去文章管理推送</button>' +
        '</div></div>'
    toast('创作完成：《' + r.title + '》')
  }
}

// ── 流水线 ──
var pipelinePolling = null
async function loadPipeline() {
  var el = document.getElementById('admin-content')
  el.innerHTML =
    '<div class="admin-heading"><div><p class="eyebrow"><span aria-hidden="true"></span>PIPELINE</p><h1>流水线</h1>' +
    '<p>抓取 → 选题（聚焦 AI / 科技 / 手机 / 数码 / 汽车 / 机器人 板块）→ 创作 → 去AI化核验 → 配图 → 推送。定时抓取与自动运行请到「定时任务」栏目配置。</p></div>' +
    '<div class="admin-heading__actions">' +
      '<button class="btn btn-s" id="btn-p-fetch"><i class="fas fa-cloud-arrow-down"></i>仅抓热点</button>' +
      '<button class="btn btn-p" id="btn-p-run"><i class="fas fa-play"></i>完整运行</button>' +
      '<button class="btn btn-d" id="btn-p-runpush"><i class="fas fa-rocket"></i>运行并推送</button>' +
    '</div></div>' +
    '<div class="workspace-section"><div class="section-heading section-heading--admin">' +
      '<div><h2>运行状态</h2><p>「运行流水线」是否推送由此开关决定（「运行并推送」按钮则只对本轮生效）。</p></div>' +
      '<div class="fc"><label class="fc" style="gap:.4rem;cursor:pointer;font-size:var(--text-xs);font-weight:600;color:var(--color-ink-2);">' +
        '<input type="checkbox" id="auto-push-toggle" style="width:1rem;height:1rem;accent-color:var(--color-accent);">自动推送新文章' +
      '</label></div>' +
    '</div><div id="pipeline-latest"><p class="empty-inline">加载中…</p></div></div>' +
    '<div class="workspace-section"><div class="section-heading section-heading--admin"><div><h2>历史运行</h2></div></div><div id="pipeline-runs" class="gp"><p class="empty-inline">加载中…</p></div></div>'
  document.getElementById('btn-p-fetch').onclick = function () { doAction('/admin/api/fetch-topics', 'POST', '抓取完成') }
  document.getElementById('btn-p-run').onclick = function () { runPipelineStreaming(false, this) }
  document.getElementById('btn-p-runpush').onclick = function () { if (confirm('将创作新文章并推送到微信草稿箱，继续？')) runPipelineStreaming(true, this) }
  // 自动推送快捷开关（读写全局设置 auto_push）
  var dSt = await api('/admin/api/status')
  var apToggle = document.getElementById('auto-push-toggle')
  if (apToggle && dSt.success) {
    apToggle.checked = !!dSt.data.config.autoPush
    apToggle.onchange = async function () {
      var d = await api('/admin/api/settings', { method: 'PUT', body: { auto_push: apToggle.checked ? '1' : '0' } })
      if (d.success) toast('自动推送已' + (apToggle.checked ? '开启：运行流水线成稿后将直接推送草稿箱' : '关闭'))
      else { toast(d.message || '保存失败', 'error'); apToggle.checked = !apToggle.checked }
    }
  }
  await refreshRuns()
  if (pipelinePolling) clearInterval(pipelinePolling)
  pipelinePolling = setInterval(function () {
    if (currentTab !== 'pipeline') { clearInterval(pipelinePolling); return }
    refreshRuns()
  }, 5000)
}
async function startPipeline(push) {
  var d = await api('/admin/api/pipeline/run', { method: 'POST', body: push ? { push: true } : {} })
  if (d.success) { toast(push ? '流水线已启动（含推送）' : '流水线已启动，稍后自动刷新', 'info') }
  else toast(d.message || '启动失败', 'error')
  setTimeout(refreshRuns, 1000)
}
async function loadScheduleCard() {
  var d = await api('/admin/api/schedule')
  var el = document.getElementById('schedule-card')
  if (!d.success) { el.innerHTML = '<div class="al al-e">' + escapeHtml(d.message) + '</div>'; return }
  var s = d.data
  var stateChip = function (on) { return on ? '<span class="chip">已启用</span>' : '<span class="chip chip--gray">未启用</span>' }
  el.innerHTML =
    '<div class="gp">' +
      '<div class="ki"><div class="key-main"><span class="key-icon"><i class="fas fa-clock"></i></span>' +
        '<div style="min-width:0;flex:1;"><div class="key-meta"><h3>每日自动运行（流水线全流程）</h3></div>' +
        '<p class="mu" style="margin:4px 0 0;">' + stateChip(s.enabled) + ' 执行时间 <b>' + escapeHtml(s.time || '—') + '</b> · 自动推送 ' + (s.push ? '<b>开</b>' : '关') + '<br>下次执行 ' + escapeHtml(s.nextRunText || '—') + (s.lastScheduledRun ? ' · 上次 ' + fmtTime(s.lastScheduledRun) : '') + '</p></div></div>' +
        '<div class="key-actions"><button class="btn btn-s" data-sched-edit="pipeline"><i class="fas fa-pen-to-square"></i>编辑</button></div></div>' +
      '<div class="ki"><div class="key-main"><span class="key-icon"><i class="fas fa-cloud-arrow-down"></i></span>' +
        '<div style="min-width:0;flex:1;"><div class="key-meta"><h3>每日自动抓取热点</h3><span class="key-meta__sep">·</span><p>' + fmtTime(s.lastAutoFetch || '') + '</p></div>' +
        '<p class="mu" style="margin:4px 0 0;">' + stateChip(s.fetchEnabled) + ' 时间点 <b>' + escapeHtml(s.fetchTimes || '—') + '</b><br>下次执行 ' + escapeHtml(s.fetchNextRunText || '—') + (s.lastAutoFetch ? ' · 上次 ' + fmtTime(s.lastAutoFetch) : '') + '</p></div></div>' +
        '<div class="key-actions"><button class="btn btn-s" data-sched-edit="fetch"><i class="fas fa-pen-to-square"></i>编辑</button></div></div>' +
    '</div>'
  el.querySelectorAll('[data-sched-edit]').forEach(function (b) {
    b.onclick = function () { openScheduleModal(b.dataset.schedEdit, s) }
  })
}

function openScheduleModal(focus, s) {
  var isPipeline = focus === 'pipeline'
  var ov = document.createElement('div')
  ov.className = 'modal-o'
  ov.id = 'sched-overlay'
  var inner = ''
  if (isPipeline) {
    inner =
      '<div class="fg"><label class="fc" style="gap:.4rem;cursor:pointer;"><input type="checkbox" id="sch-enabled" style="width:1rem;height:1rem;accent-color:var(--color-accent);"' + (s.enabled ? ' checked' : '') + '>启用每日自动运行（流水线全流程）</label></div>' +
      '<div class="fg"><label for="sch-time">执行时间（北京时间）</label><input type="time" id="sch-time" value="' + escapeHtml(s.time || '08:30') + '"></div>' +
      '<div class="fg"><label class="fc" style="gap:.4rem;cursor:pointer;"><input type="checkbox" id="sch-push" style="width:1rem;height:1rem;accent-color:var(--color-accent);"' + (s.push ? ' checked' : '') + '>流水线成稿后自动推送</label></div>'
  } else {
    inner =
      '<div class="fg"><label class="fc" style="gap:.4rem;cursor:pointer;"><input type="checkbox" id="fetch-enabled" style="width:1rem;height:1rem;accent-color:var(--color-accent);"' + (s.fetchEnabled ? ' checked' : '') + '>启用每日自动抓取热点</label></div>' +
      '<div class="fg"><label for="fetch-times">抓取时间点（北京时间，多个用英文逗号分隔，如 08:00,13:00,19:00）</label><input id="fetch-times" value="' + escapeHtml(s.fetchTimes || '08:00,13:00,19:00') + '"></div>'
  }
  ov.innerHTML =
    '<div class="modal">' +
      '<h3>' + (isPipeline ? '编辑 · 每日自动运行' : '编辑 · 每日自动抓取热点') + '</h3>' +
      '<p class="mu">' + (isPipeline ? '到点执行完整流水线（抓取 → 选题 → 创作 → 核验 → 配图）。' : '到点只刷新热点池素材，不写文章。') + '</p>' +
      inner +
      '<p class="mu" style="margin-top:8px;">⚠️ 定时由站点请求触发（看门狗模式）：到点时段无访问会顺延，建议配合监控拨针。</p>' +
      '<div class="fc" style="justify-content:flex-end;gap:var(--space-2xs);margin-top:var(--space-sm);">' +
        '<button class="btn btn-s" id="sched-cancel">取消</button>' +
        '<button class="btn btn-p" id="sched-ok"><i class="fas fa-floppy-disk"></i>保存</button>' +
      '</div>' +
    '</div>'
  document.body.appendChild(ov)
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove() })
  document.getElementById('sched-cancel').onclick = function () { ov.remove() }
  document.getElementById('sched-ok').onclick = async function () {
    var btn = this
    btn.disabled = true
    var body = {}
    if (isPipeline) {
      body = {
        enabled: document.getElementById('sch-enabled').checked,
        time: document.getElementById('sch-time').value,
        push: document.getElementById('sch-push').checked,
      }
    } else {
      body = {
        fetchEnabled: document.getElementById('fetch-enabled').checked,
        fetchTimes: document.getElementById('fetch-times').value,
      }
    }
    var d = await api('/admin/api/schedule', { method: 'PUT', body: body })
    if (d.success) { ov.remove(); toast('定时任务已保存'); loadScheduleCard() }
    else { btn.disabled = false; toast(d.message || '保存失败', 'error') }
  }
}


async function refreshRuns() {
  var dLatest = await api('/admin/api/runs/latest')
  var latest = dLatest.success ? dLatest.data.run : null
  var elL = document.getElementById('pipeline-latest')
  if (elL) elL.innerHTML = latest ? latestRunHtml(latest) : '<p class="empty-inline">尚未运行过</p>'
  var dRuns = await api('/admin/api/runs?limit=15')
  var elR = document.getElementById('pipeline-runs')
  if (elR && dRuns.success) {
    elR.innerHTML = dRuns.data.runs.length ? dRuns.data.runs.map(function (r) {
      return '<div class="ki"><div class="key-main"><span class="key-icon"><i class="fas fa-circle-nodes"></i></span>' +
        '<div style="min-width:0;flex:1;"><div class="key-meta"><h3>' + escapeHtml(r.trigger) + '</h3><span class="key-meta__sep">·</span><p>' + fmtTime(r.started_at) + '</p></div>' +
        '<p class="mu">' + statusText(r.status) + ' <span class="mu">选题 ' + (r.topics_selected || 0) + ' · 成稿 ' + (r.articles_created || 0) + ' · 推送 ' + (r.pushed || 0) + '</span></p></div></div>' +
        '<div class="key-actions"><button class="btn btn-gh" data-log="' + escapeHtml(r.id) + '"><i class="fas fa-terminal"></i>日志</button></div></div>'
    }).join('') : '<p class="empty-inline">暂无记录</p>'
    elR.querySelectorAll('[data-log]').forEach(function (b) {
      b.onclick = function () {
        var r = dRuns.data.runs.find(function (x) { return x.id === b.dataset.log })
        alert(r && r.log ? r.log : '（无日志）')
      }
    })
  }
}
function latestRunHtml(r) {
  var running = r.status === 'running'
  return '<div class="ki"><div class="key-main"><span class="key-icon"><i class="fas ' + (running ? 'fa-spinner fa-spin' : 'fa-diagram-project') + '"></i></span>' +
    '<div style="min-width:0;flex:1;"><div class="key-meta"><h3>最新运行（' + escapeHtml(r.trigger) + '）</h3><span class="key-meta__sep">·</span><p>' + fmtTime(r.started_at) + '</p></div>' +
    '<p class="mu">' + statusText(r.status) + ' <span class="mu">抓取 ' + (r.topics_fetched || 0) + ' · 选题 ' + (r.topics_selected || 0) + ' · 成稿 ' + (r.articles_created || 0) + ' · 推送 ' + (r.pushed || 0) + '</span></p>' +
    (r.log ? '<pre class="log-box" style="max-height:14rem;">' + escapeHtml(r.log) + '</pre>' : '') +
    '</div></div></div>'
}

// ── 设置 ──
async function loadSettings() {
  var d = await api('/admin/api/settings')
  var el = document.getElementById('admin-content')
  if (!d.success) { el.innerHTML = '<div class="al al-e">' + escapeHtml(d.message) + '</div>'; return }
  SETTINGS_CACHE = d.data.settings
  THEMES = d.data.themes || []
  GENRES = d.data.genres || {}
  GENRE_LABELS = {}
  Object.keys(GENRES).forEach(function (k) { GENRE_LABELS[k] = GENRES[k].name })
  var s = SETTINGS_CACHE
  var field = function (key, label, opts) {
    opts = opts || {}
    var v = escapeHtml(s[key] || '')
    return '<div class="fg"><label for="set-' + key + '">' + label + '</label>' +
      (opts.textarea
        ? '<textarea id="set-' + key + '" rows="2">' + v + '</textarea>'
        : '<input id="set-' + key + '" value="' + v + '"' + (opts.placeholder ? ' placeholder="' + opts.placeholder + '"' : '') + '>') +
      (opts.help ? '<p class="form-helper">' + opts.help + '</p>' : '') + '</div>'
  }
  el.innerHTML =
    '<div class="admin-heading"><div><p class="eyebrow"><span aria-hidden="true"></span>SETTINGS</p><h1>设置</h1>' +
    '<p>密钥类字段显示为掩码；留空或保持掩码表示不修改。</p></div>' +
    '<div class="admin-heading__actions"><button class="btn btn-p" id="btn-save"><i class="fas fa-floppy-disk"></i>保存设置</button></div></div>' +
    '<div class="setting-grid">' +
      panelInputs('LLM 创作（OpenAI 兼容）', [
        field('llm_base_url', 'Base URL', { help: '如 https://api.kilo.ai/api/gateway 或自建 ai-gateway 的 /v1' }) +
        field('llm_api_key', 'API Key', { placeholder: 'sk-…（免鉴权端点可留空）' }) +
        field('llm_model', '模型（逗号分隔填备用）', { help: '如 stepfun/step-3.7-flash:free（Kilo 免 key）' }) +
        field('llm_temperature', '温度（0-1）', {}),
      ], '<button class="btn btn-s" id="btn-test-llm"><i class="fas fa-vial"></i>测试 LLM</button>') +
      panelInputs('Agnes AI 文生图（配图兜底）', [
        field('agnes_base_url', 'Base URL', { help: '默认 https://apihub.agnes-ai.com/v1' }) +
        field('agnes_api_key', 'API Key', {}) +
        field('agnes_model', '模型', { help: '默认 agnes-image-2.1-flash' }),
      ], '<button class="btn btn-s" id="btn-test-agnes"><i class="fas fa-vial"></i>测试 Agnes</button>') +
      panelInputs('配图搜索（无水印优先）', [
        field('img_providers', '图源顺序（先搜后生成）', { help: '推荐 wikimedia,openverse,toutiao,baidu,bing：新闻源(CC无水印)优先，再头条/百度新闻图，Bing 备用' }) +
        field('img_pexels_key', 'Pexels API Key（可选）', {}) +
        field('img_pixabay_key', 'Pixabay API Key（可选）', {}) +
        field('img_count', '每篇配图数（0-5）', {}),
      ], '<button class="btn btn-s" id="btn-test-img"><i class="fas fa-vial"></i>测试图源</button>') +
      panelInputs('微信网关（wx-draft-worker）', [
        field('wx_gateway_url', '网关地址', { help: '默认 https://wx.seurl.eu.org' }) +
        field('wx_api_token', 'API 令牌（wxk_…）', { help: '在 wx-draft-worker 后台「令牌管理」创建' }) +
        field('wx_account_id', '公众号 accountId（多号矩阵时填）', {}) +
        field('wx_author', '默认作者（≤8 字）', {}),
      ], '<button class="btn btn-s" id="btn-test-wx"><i class="fas fa-vial"></i>网关健康</button> <button class="btn btn-d" id="btn-test-wx-real"><i class="fas fa-paper-plane"></i>真实推送测试</button>') +
      panelInputs('流水线与选题', [
        field('topics_api_url', '热点网关地址', { help: '自托管热点聚合站 /api/{platform}，失败自动回落 60s API 链路' }) +
        field('sector_scope', '选题板块范围（逗号分隔，空=不限）', { help: '默认 AI,科技,手机,数码硬件,汽车,机器人' }) +
        field('topics_api_key', '热点网关 API Key', { help: '网关开启鉴权后必填（X-API-Key 头携带）' }) +
        field('select_count', '每次成稿篇数（1-8）', {}) +
        field('platforms', '抓取平台', { help: '逗号分隔平台 key。全部 26 源：综合=weibo,baidu,douyin,toutiao,kuaishou,rednote,xianbao；社区=zhihu,bili,bilibili_video,tieba；新闻=tencent_news,netease,thepaper,wechat_gzh；科技=ithome,ifanr,sspai,github,hackernews；国际=x,voa,bbc,dw,rfi,zaobao' }) +
        field('include_keywords', '选题关键词偏好（逗号分隔，命中才选）', {}) +
        field('exclude_keywords', '排除关键词（逗号分隔）', {}) +
        field('genre', '创作体裁', { help: 'auto=按话题自动选择；brief/deep/list/opinion' }) +
        field('theme', '排版主题（18 套）', { help: 'wewrite 主题 key，如 professional-clean / sspai / bold-navy / midnight / newspaper…；编辑器里可下拉选择' }) +
        field('auto_push', '自动推送（1=开，0=关）', { help: '开启后流水线成稿自动推草稿箱' }) +
        field('cron_secret', '外部定时密钥', { help: '调用 POST /api/cron/run 时带 X-CRON-Secret 头' }),
      ], '') +
      panelInputs('去AI化核验（推送前强制质检）', [
        field('humanize_enabled', '是否启用（1=开）', { help: '开启后创作完成自动改写+复检，超标禁止推送' }) +
        field('humanize_threshold', 'AI 痕迹分阈值（0-90）', { help: '低于阈值才允许推送；默认 40，越低越严格' }) +
        field('humanize_max_rounds', '最大改写轮数（1-4）', { help: '每轮 = 定向改写 + 复检，取最低分版本' }),
      ], '') +
    '</div>' +
    '<div class="workspace-section"><div class="section-heading section-heading--admin"><div><h2>修改密码</h2></div></div>' +
    '<div class="add-form-panel" style="max-width:30rem;"><div class="fr">' +
      '<div class="fg"><label for="old-password">旧密码</label><input id="old-password" type="password"></div>' +
      '<div class="fg"><label for="new-password">新密码（≥6 位）</label><input id="new-password" type="password"></div>' +
    '</div><button class="btn btn-p" id="btn-password"><i class="fas fa-key"></i>修改密码</button></div></div>'

  document.getElementById('btn-save').onclick = saveSettings
  document.getElementById('btn-test-llm').onclick = function () { runTest('/admin/api/test/llm', 'btn-test-llm') }
  document.getElementById('btn-test-agnes').onclick = function () { runTest('/admin/api/test/agnes', 'btn-test-agnes') }
  document.getElementById('btn-test-img').onclick = function () { runTest('/admin/api/test/images', 'btn-test-img') }
  document.getElementById('btn-test-wx').onclick = function () { runTest('/admin/api/test/wx', 'btn-test-wx') }
  document.getElementById('btn-test-wx-real').onclick = function () {
    if (confirm('将真实推送一条测试草稿到公众号（可删除），继续？')) runTest('/admin/api/test/wx', 'btn-test-wx-real', { real: true })
  }
  document.getElementById('btn-password').onclick = async function () {
    var oldP = document.getElementById('old-password').value
    var newP = document.getElementById('new-password').value
    if (!oldP || !newP) { toast('请填写新旧密码', 'error'); return }
    var d = await api('/admin/api/password', { method: 'PUT', body: { old_password: oldP, new_password: newP } })
    if (d.success) { toast('密码已修改'); document.getElementById('old-password').value = ''; document.getElementById('new-password').value = '' }
    else toast(d.message || '修改失败', 'error')
  }
}
function panelInputs(title, body, extraBtn) {
  return '<div class="add-form-panel"><div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-sliders-h"></i></span><div><h3>' + title + '</h3></div></div>' +
    (extraBtn ? '<div>' + extraBtn + '</div>' : '') + '</div>' + body + '</div>'
}
async function saveSettings() {
  var keys = ['topics_api_url','topics_api_key','sector_scope','humanize_enabled','humanize_threshold','humanize_max_rounds','llm_base_url','llm_api_key','llm_model','llm_temperature','agnes_base_url','agnes_api_key','agnes_model','img_providers','img_pexels_key','img_pixabay_key','img_count','wx_gateway_url','wx_api_token','wx_account_id','wx_author','select_count','platforms','include_keywords','exclude_keywords','genre','theme','auto_push','cron_secret']
  var body = {}
  keys.forEach(function (k) {
    var el = document.getElementById('set-' + k)
    if (el) body[k] = el.value
  })
  var d = await api('/admin/api/settings', { method: 'PUT', body: body })
  if (d.success) toast('设置已保存')
  else toast(d.message || '保存失败', 'error')
}
async function runTest(url, btnId, body) {
  var btn = document.getElementById(btnId)
  var old = btn.innerHTML
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>测试中'
  var d = await api(url, { method: 'POST', body: body || {} })
  btn.disabled = false; btn.innerHTML = old
  var data = d.success ? d.data : { ok: false, message: d.message || '请求失败' }
  toast((data.ok ? '✅ ' : '❌ ') + (data.message || ''), data.ok ? 'ok' : 'error')
}

// ── 文章编辑器 ──
function getEditorThemes() {
  return (THEMES && THEMES.length) ? THEMES.map(function (t) { return { value: t.value, label: t.label } }) : [{ value: 'professional-clean', label: 'professional-clean' }]
}
var previewTimer = null
function zhChars(t) { return String(t || '').replace(/[\s]/g, '').length }
async function openEditor(id) {
  if (!(THEMES && THEMES.length)) {
    var ds = await api('/admin/api/settings')
    if (ds.success) { THEMES = ds.data.themes || [] }
  }
  var d = await api('/admin/api/articles/' + id)
  if (!d.success) { toast(d.message || '加载失败', 'error'); return }
  var a = d.data.article
  var LEGACY = { clean: 'professional-clean', sspai: 'sspai', navy: 'bold-navy' }
  a.theme = LEGACY[a.theme] || a.theme || 'professional-clean'
  var editorThemes = getEditorThemes()
  var ov = document.createElement('div')
  ov.className = 'modal-o'
  ov.id = 'editor-overlay'
  ov.innerHTML =
    '<div class="modal modal-lg">' +
      '<h3>编辑文章</h3>' +
      '<p class="mu">保存后服务端重排版，并自动重新检测 AI 痕迹分' + (a.status === 'pushed' ? '；注意：该篇已推送，编辑不会改动微信里已有的草稿，需删除重推' : '') + '。</p>' +
      '<div class="fg"><label for="ed-title">标题（≤64 字）</label><input id="ed-title" value="' + escapeHtml(a.title) + '"></div>' +
      '<div class="fr3">' +
        '<div class="fg"><label for="ed-author">作者（≤8 字）</label><input id="ed-author" value="' + escapeHtml(a.author || '') + '"></div>' +
        '<div class="fg"><label for="ed-theme">排版主题（18 套 wewrite 主题）</label><select id="ed-theme">' + editorThemes.map(function (t) { return '<option value="' + escapeHtml(t.value) + '"' + (a.theme === t.value ? ' selected' : '') + '>' + escapeHtml(t.label) + '</option>' }).join('') + '</select></div>' +
        '<div class="fg"><label for="ed-count">正文字数</label><input id="ed-count" disabled value="' + zhChars(a.markdown) + ' 字"></div>' +
      '</div>' +
      '<div class="fg"><label for="ed-digest">摘要（≤120 字）</label><textarea id="ed-digest" rows="2">' + escapeHtml(a.digest || '') + '</textarea></div>' +
      '<div class="editor-grid" id="ed-grid">' +
        '<div class="fg">' +
          '<div class="ed-label-row"><label for="ed-markdown" style="flex:1;">正文 Markdown（支持 ## 小标题 / **加粗** / ![图](URL)）</label>' +
            '<button type="button" class="ed-mode-btn" id="ed-mode" title="切换到富文本编辑"><i class="fas fa-pen-fancy"></i> 富文本</button></div>' +
          '<div class="ed-toolbar" id="ed-toolbar">' +
            '<button type="button" class="btn btn-s" data-cmd="bold" title="加粗 (Ctrl+B)"><b>B</b></button>' +
            '<button type="button" class="btn btn-s" data-cmd="italic" title="斜体 (Ctrl+I)"><i>I</i></button>' +
            '<button type="button" class="btn btn-s" data-cmd="underline" title="下划线"><u>U</u></button>' +
            '<button type="button" class="btn btn-s" data-cmd="strikeThrough" title="删除线"><s>S</s></button>' +
            '<button type="button" class="btn btn-s" data-cmd="formatBlock:h2" title="小标题">H2</button>' +
            '<button type="button" class="btn btn-s" data-cmd="formatBlock:h3" title="小标题3">H3</button>' +
            '<button type="button" class="btn btn-s" data-cmd="formatBlock:p" title="正文段落">正文</button>' +
            '<button type="button" class="btn btn-s" data-cmd="insertUnorderedList" title="无序列表"><i class="fas fa-list-ul"></i></button>' +
            '<button type="button" class="btn btn-s" data-cmd="formatBlock:blockquote" title="引用"><i class="fas fa-quote-left"></i></button>' +
            '<button type="button" class="btn btn-s" data-cmd="insertImage" title="插入图片 URL"><i class="fas fa-image"></i></button>' +
            '<button type="button" class="btn btn-s" data-cmd="createLink" title="插入链接"><i class="fas fa-link"></i></button>' +
            '<button type="button" class="btn btn-s" data-cmd="undo" title="撤销"><i class="fas fa-rotate-left"></i></button>' +
            '<button type="button" class="btn btn-s" data-cmd="redo" title="重做"><i class="fas fa-rotate-right"></i></button>' +
            '<button type="button" class="btn btn-s" data-cmd="removeFormat" title="清除格式"><i class="fas fa-eraser"></i></button>' +
          '</div>' +
          '<textarea id="ed-markdown" class="editor-md">' + escapeHtml(a.markdown) + '</textarea>' +
          '<div id="ed-rt-wrap" style="display:none;">' +
            '<div id="ed-rt" class="editor-rt" contenteditable="true">' + (a.html || '') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="fg"><label>微信排版预览</label><div id="ed-preview" class="editor-preview">' + (a.html || '') + '</div></div>' +
      '</div>' +
      '<div class="editor-foot">' +
        '<span class="editor-meta" id="ed-msg"><i class="fas fa-circle-info"></i> 修改正文或主题后自动刷新预览</span>' +
        '<div class="fc"><button class="btn btn-s" id="ed-cancel">取消</button>' +
        '<button class="btn btn-p" id="ed-save"><i class="fas fa-floppy-disk"></i>保存</button></div>' +
      '</div>' +
    '</div>'
  document.body.appendChild(ov)
  var close = function () { ov.remove() }
  ov.addEventListener('click', function (e) { if (e.target === ov) close() })
  document.getElementById('ed-cancel').onclick = close
  var schedulePreview = function () {
    document.getElementById('ed-count').value = zhChars(document.getElementById('ed-markdown').value) + ' 字'
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = setTimeout(async function () {
      var r = await api('/admin/api/render', { method: 'POST', body: { markdown: document.getElementById('ed-markdown').value, theme: document.getElementById('ed-theme').value } })
      if (r.success) document.getElementById('ed-preview').innerHTML = r.data.html
    }, 600)
  }
  document.getElementById('ed-markdown').oninput = schedulePreview
  document.getElementById('ed-theme').onchange = schedulePreview

  // ── 源码 ⇄ 富文本模式切换（双向，turndown 负责 HTML→Markdown）──
  var editMode = 'md'
  var modeBtn = document.getElementById('ed-mode')
  var previewTimer2 = null
  function showMdMode() {
    // 富文本 → 源码：把编辑结果转回 Markdown（源码保持唯一事实源）
    var tds = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    var mdOut = tds.turndown(document.getElementById('ed-rt').innerHTML)
    document.getElementById('ed-markdown').value = mdOut
    document.getElementById('ed-markdown').style.display = 'block'
    document.getElementById('ed-toolbar').style.display = 'none'
    document.getElementById('ed-rt-wrap').style.display = 'none'
    document.getElementById('ed-preview').parentElement.style.display = ''
    document.getElementById('ed-theme').disabled = false
    document.getElementById('ed-theme').title = ''
    modeBtn.innerHTML = '<i class="fas fa-pen-fancy"></i> 富文本'
    modeBtn.title = '切换到富文本编辑'
    editMode = 'md'
    schedulePreview()
  }
  function showRtMode() {
    var rt = document.getElementById('ed-rt')
    rt.innerHTML = document.getElementById('ed-preview').innerHTML || '<p></p>'
    document.getElementById('ed-markdown').style.display = 'none'
    document.getElementById('ed-toolbar').style.display = 'flex'
    document.getElementById('ed-rt-wrap').style.display = 'block'
    document.getElementById('ed-theme').disabled = true
    document.getElementById('ed-theme').title = '富文本模式下不可切换主题'
    modeBtn.innerHTML = '<i class="fas fa-code"></i> 源码模式'
    modeBtn.title = '切回 Markdown 源码（编辑结果自动转换，不会丢失）'
    editMode = 'rt'
  }
  modeBtn.onclick = function () {
    if (editMode === 'md') { showRtMode() } else { showMdMode() }
  }
  // 富文本实时预览（与源码模式一致：右侧同步）
  document.getElementById('ed-rt').addEventListener('input', function () {
    if (previewTimer2) clearTimeout(previewTimer2)
    previewTimer2 = setTimeout(function () {
      document.getElementById('ed-preview').innerHTML = document.getElementById('ed-rt').innerHTML
    }, 500)
  })
  // 富文本工具条
  document.querySelectorAll('#ed-toolbar [data-cmd]').forEach(function (b) {
    b.onclick = function () {
      var cmd = b.dataset.cmd
      if (cmd.indexOf('formatBlock:') === 0) document.execCommand('formatBlock', false, cmd.split(':')[1])
      else if (cmd === 'insertImage') {
        var url = prompt('图片 URL：')
        if (url) document.execCommand('insertImage', false, url)
      } else if (cmd === 'createLink') {
        var url2 = prompt('链接 URL：')
        if (url2) document.execCommand('createLink', false, url2)
      } else document.execCommand(cmd, false, null)
      document.getElementById('ed-rt').focus()
    }
  })
  document.getElementById('ed-save').onclick = async function () {
    var btn = this
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>保存中'
    var body = {
      title: document.getElementById('ed-title').value.trim(),
      digest: document.getElementById('ed-digest').value.trim(),
      author: document.getElementById('ed-author').value.trim(),
      theme: document.getElementById('ed-theme').value,
    }
    if (editMode === 'rt') {
      var tds = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      document.getElementById('ed-markdown').value = tds.turndown(document.getElementById('ed-rt').innerHTML)
    }
    body.markdown = document.getElementById('ed-markdown').value
    var r = await api('/admin/api/articles/' + id, { method: 'PUT', body: body })
    if (r.success) { toast('已保存，AI 痕迹分将在后台重新检测'); close(); loadArticleList() }
    else { toast(r.message || '保存失败', 'error'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i>保存' }
  }
}

// 启动：恢复侧边栏收缩状态
;(function () {
  try {
    if (localStorage.getItem('admin-rail-collapsed') === '1') {
      document.querySelector('.admin-shell').classList.add('is-collapsed')
      var btn = document.querySelector('.rail-toggle')
      if (btn) btn.title = '展开侧边栏'
    }
  } catch (e) {}
})()
;(function () {
  var t = location.hash.slice(1) || 'overview'
  switchTab(['overview','topics','articles','writing','pipeline','schedule','settings'].indexOf(t) !== -1 ? t : 'overview')
})()
`
