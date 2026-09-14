/**
 * 冒烟测试：对目标实例（默认本地 wrangler dev）跑一遍核心链路。
 *   node scripts/smoke.mjs [baseUrl] [adminPassword]
 * 检查：健康检查 / 首页 / 登录 / 设置读写 / 热点接口 / 文章接口 / 图源与网关测试。
 */
import process from 'node:process'

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const ADMIN_PW = process.argv[3] || 'admin'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

let cookie = ''
let pass = 0
let failCount = 0

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    failCount++
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

async function req(path, opts = {}) {
  const resp = await fetch(BASE + path, {
    ...opts,
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  })
  const setCookie = resp.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await resp.text()
  let json = null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') json = parsed
  } catch { /* 页面响应无 JSON */ }
  return { status: resp.status, json, text }
}

console.log(`\n🧪 HotPress 冒烟测试 → ${BASE}\n`)

// 1. 健康检查
{
  const { status, json } = await req('/api/health')
  check('GET /api/health', status === 200 && json?.ok === true, `db_connected=${json?.data?.db_connected}`)
}

// 2. 首页
{
  const { status, text } = await req('/')
  check('GET /（首页渲染）', status === 200 && text.includes('HotPress'))
}

// 3. 登录
{
  const { json } = await req('/admin/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) })
  check('POST /admin/login', json?.success === true, json?.message)
}

// 4. 状态
{
  const { json } = await req('/admin/api/status')
  check('GET /admin/api/status', json?.success === true && !!json?.data?.stats, `今日热点 ${json?.data?.stats?.topicsToday ?? '?'}`)
}

// 5. 设置读写
{
  const get = await req('/admin/api/settings')
  check('GET /admin/api/settings', get.json?.success === true && !!get.json?.data?.settings?.wx_gateway_url)
  const put = await req('/admin/api/settings', { method: 'PUT', body: JSON.stringify({ llm_temperature: '0.7' }) })
  check('PUT /admin/api/settings', put.json?.success === true)
}

// 6. 热点列表
{
  const { json } = await req('/admin/api/topics?limit=50')
  check('GET /admin/api/topics', json?.success === true, `候选 ${json?.data?.selection?.length ?? 0} 组`)
}

// 7. 文章列表
{
  const { json } = await req('/admin/api/articles?limit=10')
  check('GET /admin/api/articles', json?.success === true, `共 ${json?.data?.articles?.length ?? 0} 篇`)
}

// 8. 后台页面
{
  const { status, text } = await req('/admin')
  check('GET /admin（后台 SPA）', status === 200 && text.includes('admin-nav'))
}

// 9. 图源连通（真实外网，允许个别源失败，至少一个可用）
{
  const { json } = await req('/admin/api/test/images', { method: 'POST', body: '{}' })
  check('POST /admin/api/test/images', json?.data?.ok === true, json?.data?.message?.slice(0, 80))
}

// 10. 微信网关健康
{
  const { json } = await req('/admin/api/test/wx', { method: 'POST', body: '{}' })
  check('POST /admin/api/test/wx', json?.success === true, json?.data?.message?.slice(0, 80))
}

console.log(`\n结果：${pass} 通过 / ${failCount} 失败\n`)
process.exit(failCount > 0 ? 1 : 0)
