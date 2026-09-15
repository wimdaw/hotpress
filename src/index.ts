import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env } from './types'
import { adminAuthMiddleware, handleLogin, handleLogout } from './auth'
import { ensureSchema, getSettings, getStats, listTopics, listArticles, getLatestBatchId, latestRun } from './storage'
import { selectTopicGroups } from './selector'
import {
  handleStatus, handleFetchTopics, handleListTopics, handleReselect,
  handleListArticles, handleGetArticle, handleDeleteArticle, handleUpdateArticle,
  handlePushArticle, handleWriteArticle, handleRewriteArticle, handleRegenerateCover, handleHumanizeArticle,
  handleBatchArticles, handleTrend, handleRenderPreview,
  handleCustomExtract, handleCustomWrite, handleCustomStyles,
  handleListCustomTasks, handleSaveCustomTask, handleDeleteCustomTask, handleKeywordWrite,
  handlePipelineRun, handleLatestRun, handleListRuns,
  handleGetSettings, handleSaveSettings, handleChangePassword,
  handleGetSchedule, handleSaveSchedule,
  handleTestLlm, handleTestAgnes, handleTestImages, handleTestWx,
} from './admin'
import { renderHomePage, renderLoginPage, renderAdminPage, renderArticlePage } from './pages'
import { runPipeline } from './pipeline'
import { maybeRunCustomTasks, tickSchedules, runCustomAction } from './scheduler'

const app = new Hono<{ Bindings: Env }>()

// ===== 全局中间件 =====
app.use('*', cors())
app.use('*', logger())

let seeded = false
let lastSchedCheck = 0
app.use('*', async (c, next) => {
  if (!seeded) {
    await ensureSchema(c.env)
    seeded = true
  }
  // 定时任务看门狗：每个 isolate 每 60 秒最多检查一次，到点后台执行、绝不阻塞请求
  const now = Date.now()
  if (now - lastSchedCheck > 60_000) {
    lastSchedCheck = now
    try { c.executionCtx.waitUntil(tickSchedules(c.env).then(() => maybeRunCustomTasks(c.env)).catch(() => {})) } catch { /* 忽略 */ }
  }
  return next()
})

// ===== 公开接口 =====

app.get('/', async (c) => {
  const { getCookie } = await import('hono/cookie')
  const sessionId = getCookie(c, 'session_id')
  let isLoggedIn = false
  if (sessionId) isLoggedIn = (await (await import('./storage')).getSession(c.env, sessionId)) !== null
  return renderHomePage(c, isLoggedIn)
})

app.get('/article/:id', (c) => renderArticlePage(c, c.req.param('id')))

app.get('/api/health', async (c) => {
  try {
    await c.env.DB.prepare(`SELECT 1`).first()
    return c.json({ ok: true, data: { service: 'hotpress', version: '1.0.0', db_connected: true, time: new Date().toISOString() } })
  } catch {
    return c.json({ ok: true, data: { service: 'hotpress', version: '1.0.0', db_connected: false, time: new Date().toISOString() } })
  }
})

/** 公开只读 API：热点榜（合并后） */
app.get('/api/topics', async (c) => {
  const batchId = c.req.query('batch') || (await getLatestBatchId(c.env))
  const rows = await listTopics(c.env, { batchId, limit: 400 })
  const settings = await getSettings(c.env)
  const groups = selectTopicGroups(rows, settings, parseInt(c.req.query('limit') || '20', 10))
  return c.json({
    ok: true,
    data: {
      batchId,
      topics: groups.map((g) => ({ title: g.title, hot: g.hotValue, platforms: g.platforms, urls: g.urls })),
    },
  })
})

/** 公开只读 API：已就绪文章列表 */
app.get('/api/articles', async (c) => {
  const articles = await listArticles(c.env, { limit: parseInt(c.req.query('limit') || '20', 10) })
  return c.json({
    ok: true,
    data: articles.map((a) => ({ id: a.id, title: a.title, digest: a.digest, status: a.status, created_at: a.created_at })),
  })
})

/** 静态发布 Windows 剪辑工具安装包 */
app.get('/douyin-auto-clip-windows.zip', (c) => {
  return (c.env as any).ASSETS ? (c.env as any).ASSETS.fetch(c.req.raw) : c.notFound()
})

/**
 * 外部定时器入口（Pages 部署用）：POST /api/cron/run，请求头 X-CRON-Secret 与设置中的
 * cron_secret（或环境变量 CRON_SECRET）一致。
 */
app.post('/api/cron/run', async (c) => {
  const settings = await getSettings(c.env)
  const secret = c.req.header('X-CRON-Secret') || c.req.query('secret') || ''
  const expected = c.env.CRON_SECRET || settings.cron_secret
  if (!expected) return c.json({ ok: false, error: '未配置 cron_secret（后台「设置」或环境变量 CRON_SECRET）' }, 403)
  if (secret !== expected) return c.json({ ok: false, error: 'X-CRON-Secret 校验失败' }, 401)
  const result = await runPipeline(c.env, 'cron', { push: c.req.query('push') === '1' })
  return c.json({ ok: true, data: result })
})

// ===== 登录 =====
app.get('/admin/login', (c) => renderLoginPage(c))
app.post('/admin/login', handleLogin)
app.get('/admin/logout', handleLogout)

// ===== 后台（需会话） =====
app.use('/admin/*', adminAuthMiddleware)
app.get('/admin', async (c) => {
  const res = await renderAdminPage(c)
  res.headers.set('Cache-Control', 'no-store, must-revalidate')
  return res
})

app.get('/admin/api/status', handleStatus)

// 热点
app.get('/admin/api/topics', handleListTopics)
app.post('/admin/api/fetch-topics', handleFetchTopics)
app.post('/admin/api/topics/reselect', handleReselect)

// 文章
app.get('/admin/api/articles', handleListArticles)
app.post('/admin/api/articles/batch', handleBatchArticles)
app.get('/admin/api/stats/trend', handleTrend)
app.post('/admin/api/render', handleRenderPreview)
app.post('/admin/api/custom/extract', handleCustomExtract)
app.post('/admin/api/custom/write', handleCustomWrite)
app.get('/admin/api/custom/styles', handleCustomStyles)
app.post('/admin/api/custom/keyword', handleKeywordWrite)
app.get('/admin/api/custom-tasks', handleListCustomTasks)
app.post('/admin/api/custom-tasks', handleSaveCustomTask)
app.put('/admin/api/custom-tasks/:id', handleSaveCustomTask)
app.delete('/admin/api/custom-tasks/:id', handleDeleteCustomTask)
app.post('/admin/api/custom-tasks/:id/run', async (c) => {
  const id = c.req.param('id')
  const { listCustomTasks } = await import('./storage')
  const tasks = await listCustomTasks(c.env)
  const task = tasks.find((t) => t.id === id)
  if (!task) return c.json({ success: false, message: '任务不存在' }, 404)
  const result = await runCustomAction(c.env, task)
  return c.json({ success: true, data: { result } })
})
app.get('/admin/api/articles/:id', handleGetArticle)
app.put('/admin/api/articles/:id', handleUpdateArticle)
app.delete('/admin/api/articles/:id', handleDeleteArticle)
app.post('/admin/api/articles/:id/push', handlePushArticle)
app.post('/admin/api/articles/:id/rewrite', handleRewriteArticle)
app.post('/admin/api/articles/:id/recover-cover', handleRegenerateCover)
app.post('/admin/api/articles/:id/humanize', handleHumanizeArticle)
app.post('/admin/api/write-article', handleWriteArticle)

// 流水线
app.post('/admin/api/pipeline/run', handlePipelineRun)
app.get('/admin/api/runs/latest', handleLatestRun)
app.get('/admin/api/schedule', handleGetSchedule)
app.put('/admin/api/schedule', handleSaveSchedule)
app.get('/admin/api/runs', handleListRuns)

// 设置
app.get('/admin/api/settings', handleGetSettings)
app.put('/admin/api/settings', handleSaveSettings)
app.put('/admin/api/password', handleChangePassword)

// 连通性测试
app.post('/admin/api/test/llm', handleTestLlm)
app.post('/admin/api/test/agnes', handleTestAgnes)
app.post('/admin/api/test/images', handleTestImages)
app.post('/admin/api/test/wx', handleTestWx)

// ===== 404 / 错误 =====
app.notFound((c) => {
  const url = new URL(c.req.url)
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/admin/api')) {
    return c.json({ ok: false, error: '接口不存在' }, 404)
  }
  return c.html(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>404</title></head><body style="font-family:sans-serif;display:grid;place-items:center;min-height:100dvh;"><div style="text-align:center;"><h1>404</h1><p>页面不存在</p><p><a href="/">返回首页</a></p></div></body></html>`, 404)
})

app.onError((err, c) => {
  console.error('未捕获的错误:', err)
  return c.json({ ok: false, error: '服务器内部错误' }, 500)
})

// Workers 部署：cron 触发自动运行流水线（Pages 部署不支持 scheduled，用 /api/cron/run 替代）
export default {
  fetch: app.fetch,
  scheduled: async (_event: unknown, env: Env, ctx: { waitUntil: (p: Promise<any>) => void }) => {
    ctx.waitUntil(runPipeline(env, 'cron').catch((e) => console.error('cron pipeline failed:', e)))
  },
}
