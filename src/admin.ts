/**
 * 管理后台 API（全部挂在 /admin/api/*，需管理员会话）。
 * 返回契约与 ai-gateway 一致：{ success: true, data } / { success: false, message }。
 */
import { Context } from 'hono'
import {
  getSettings, saveSettings, getStats, listTopics, listArticles, getArticle,
  deleteArticle, updateArticle, latestRun, listRuns, getLatestBatchId,
  listArticlesPaged, getTrend, countTopics, createArticle,
} from './storage'
import { fetchAndStoreTopics, runPipeline, createArticleForGroup, pushArticleById } from './pipeline'
import { selectTopicGroups, normTitleKey, titleSimilarity, SIM_THRESHOLD } from './selector'
import { mdToWechatHtml, themeOptions } from './markdown'
import { testLlm } from './llm'
import { testAgnes } from './agnes'
import { testImageSearch } from './images'
import { gatewayHealth, testPush } from './wxclient'
import { hashPassword } from './auth'
import { setAdminCredentials } from './storage'
import { GENRES } from './config'
import { extractArticleFromUrl } from './extract'
import { listCustomTasks, upsertCustomTask, deleteCustomTask } from './storage'
import type { CustomTaskRow } from './types'
import { customWrite, STYLE_PRESETS, type WriteMode } from './custom'
import { keywordWrite } from './keyword'
import { CATEGORY_NAMES, SECTOR_NAMES } from './sectors'
import { computeNextRun, computeNextFromTimes, formatNextRun } from './scheduler'
import type { Env, TopicRow, AppSettings, ArticleImage } from './types'

type C = Context<{ Bindings: Env }>

const ok = (c: C, data: any) => c.json({ success: true, data })
type FailStatus = 200 | 400 | 401 | 403 | 404 | 429 | 500
const fail = (c: C, message: string, status: FailStatus = 400) => c.json({ success: false, message }, status)

// ===== 状态总览 =====

export async function handleStatus(c: C) {
  const env = c.env
  const [settings, stats, run] = await Promise.all([getSettings(env), getStats(env), latestRun(env)])
  return ok(c, {
    stats,
    latestRun: run,
    config: {
      llm: settings.llm_base_url ? { model: settings.llm_model, base: settings.llm_base_url } : null,
      agnes: settings.agnes_api_key ? { model: settings.agnes_model } : null,
      wx: settings.wx_gateway_url ? { url: settings.wx_gateway_url, token: !!settings.wx_api_token } : null,
      autoPush: settings.auto_push === '1',
      genre: settings.genre,
      selectCount: settings.select_count,
    },
  })
}

// ===== 热点 =====

export async function handleFetchTopics(c: C) {
  const settings = await getSettings(c.env)
  const force = c.req.method === 'POST'
  const result = await fetchAndStoreTopics(c.env, settings, force)
  if (result.skipped) return fail(c, '距上次抓取不足 5 分钟（60s API 有上游缓存），可稍后再试或用强制抓取', 429)
  return ok(c, result)
}

export async function handleListTopics(c: C) {
  const url = new URL(c.req.url)
  const batchId = url.searchParams.get('batch') || (await getLatestBatchId(c.env))
  const platform = url.searchParams.get('platform') || undefined
  const category = url.searchParams.get('category') || undefined
  const sector = url.searchParams.get('sector') || undefined
  const q = url.searchParams.get('q') || undefined
  const limit = parseInt(url.searchParams.get('limit') || '200', 10)
  const offset = parseInt(url.searchParams.get('offset') || '0', 10)
  const total = await countTopics(c.env, { batchId, platform, category, sector, q })
  const sectorRows = batchId ? await c.env.DB.prepare(
    `SELECT sector, COUNT(*) AS n FROM topics WHERE batch_id = ? AND sector != '' GROUP BY sector ORDER BY n DESC`
  ).bind(batchId).all<{ sector: string; n: number }>() : { results: [] }
  const rows = await listTopics(c.env, { batchId, platform, category, sector, q, limit, offset })
  const settings = await getSettings(c.env)
  const groups = selectTopicGroups(rows, settings, 30)
  return ok(c, {
    batchId,
    total,
    offset,
    limit,
    sectorCounts: (sectorRows as any).results || [],
    categories: CATEGORY_NAMES,
    sectors: SECTOR_NAMES,
    topics: rows.slice(0, 120),
    selection: groups.map((g) => ({
      key: g.key, title: g.title, hot: g.hotValue, score: Math.round(g.score * 100) / 100,
      platforms: g.platforms, category: g.rows[0]?.category || '综合', sector: g.rows[0]?.sector || '综合',
    })),
  })
}

// ===== 自定义写作 =====

export async function handleCustomExtract(c: C) {
  const { url } = await c.req.json().catch(() => ({ url: '' }))
  if (!url) return fail(c, '缺少 url')
  try {
    const art = await extractArticleFromUrl(String(url))
    return ok(c, art)
  } catch (e: any) {
    return fail(c, e?.message || '提取失败', 500)
  }
}

export async function handleCustomStyles(c: C) {
  const presets = Object.entries(STYLE_PRESETS).map(([value, v]) => ({ value, label: v.label }))
  return ok(c, { presets })
}

export async function handleCustomWrite(c: C) {
  const body = await c.req.json().catch(() => ({}))
  const mode = String(body.mode || '') as WriteMode
  if (!['imitate', 'rewrite', 'polish'].includes(mode)) return fail(c, 'mode 须为 imitate / rewrite / polish')
  let text = String(body.text || '')
  let sourceInfo: { source?: string; author?: string } | undefined
  if (body.url && text.trim().length < 120) {
    try {
      const art = await extractArticleFromUrl(String(body.url))
      text = `标题：${art.title}\n\n${art.text}`
      sourceInfo = { source: art.source, author: art.author }
      if (!text || text.length < 120) return fail(c, '该链接未能提取到正文')
    } catch (e: any) {
      return fail(c, e?.message || '链接提取失败', 500)
    }
  }
  if (text.trim().length < 120) return fail(c, '原文太短（至少 120 字），请粘贴正文或提供可抓取的链接')
  const settings = await getSettings(c.env)
  try {
    const result = await customWrite(settings, {
      mode,
      text,
      newTopic: body.newTopic ? String(body.newTopic) : undefined,
      angle: body.angle ? String(body.angle) : undefined,
      style: body.style ? String(body.style) : undefined,
      customStyle: body.customStyle ? String(body.customStyle) : undefined,
      title: body.title ? String(body.title) : undefined,
      sourceInfo,
    })
    // 入库为待推送文章（无配图；可在编辑器补充）
    const settings2 = await getSettings(c.env)
    const { mdToWechatHtml } = await import('./markdown')
    const id = crypto.randomUUID().slice(0, 8) + Date.now().toString(36)
    await createArticle(c.env, {
      id,
      topicKey: 'custom-' + mode,
      title: result.title,
      digest: result.digest,
      author: settings2.wx_author || '',
      genre: 'deep',
      theme: settings2.theme || 'professional-clean',
      markdown: result.markdown,
      html: mdToWechatHtml(result.markdown, settings2.theme || 'professional-clean'),
      coverUrl: '',
      coverSource: '',
      images: [],
      status: 'ready',
      origin: 'custom-' + mode,
    })
    await updateArticle(c.env, id, { ai_score: result.aiScore, humanize_rounds: result.rounds })
    return ok(c, { id, title: result.title, aiScore: result.aiScore, rounds: result.rounds, log: result.log })
  } catch (e: any) {
    return fail(c, `生成失败: ${e?.message || e}`, 500)
  }
}

/** 关键字创作：自动搜全网热门素材 → 爆款成稿 → 配图 → 去AI化核验 → 入库 */
export async function handleKeywordWrite(c: C) {
  const body = await c.req.json().catch(() => ({}))
  const keyword = String(body.keyword || '').trim()
  if (keyword.length < 2) return fail(c, '请输入关键词（至少 2 个字）')
  const settings = await getSettings(c.env)
  try {
    const r = await keywordWrite(c.env, settings, {
      keyword,
      style: body.style ? String(body.style) : undefined,
      customStyle: body.customStyle ? String(body.customStyle) : undefined,
      angle: body.angle ? String(body.angle) : undefined,
    })
    const id = crypto.randomUUID().slice(0, 8) + Date.now().toString(36)
    await createArticle(c.env, {
      id,
      topicKey: 'custom-keyword',
      title: r.title,
      digest: r.digest,
      author: settings.wx_author || '',
      genre: 'deep',
      theme: settings.theme || 'professional-clean',
      markdown: r.markdown,
      html: r.html,
      coverUrl: r.coverUrl,
      coverSource: r.coverSource,
      images: r.images,
      status: 'ready',
      origin: 'custom-keyword',
    })
    await updateArticle(c.env, id, { ai_score: r.aiScore, humanize_rounds: r.rounds })
    return ok(c, { id, title: r.title, aiScore: r.aiScore, rounds: r.rounds, log: r.log, images: r.images.length })
  } catch (e: any) {
    return fail(c, e?.message || '关键字创作失败', 500)
  }
}

// ===== 自定义自动任务 =====

const TASK_ACTIONS = ['pipeline', 'fetch', 'push', 'keyword']

function taskView(t: CustomTaskRow) {
  let params: any = {}
  try { params = JSON.parse(t.params || '{}') } catch { params = {} }
  return {
    id: t.id, name: t.name, enabled: t.enabled === 1, times: t.times,
    action: t.action, params, nextRunText: t.next_run_at ? formatNextRun(t.next_run_at) : '—',
    lastRun: t.last_run || '', lastResult: t.last_result || '',
  }
}

export async function handleListCustomTasks(c: C) {
  const tasks = await listCustomTasks(c.env)
  return ok(c, { tasks: tasks.map(taskView), actions: TASK_ACTIONS })
}

export async function handleSaveCustomTask(c: C) {
  const body = await c.req.json().catch(() => ({}))
  const name = String(body.name || '').trim().slice(0, 30)
  if (!name) return fail(c, '请填写任务名称')
  const action = String(body.action || '')
  if (!TASK_ACTIONS.includes(action)) return fail(c, '未知动作类型')
  const times = String(body.times || '').split(',').map((x) => x.trim()).filter(Boolean)
  if (times.some((t) => !SCHEDULE_TIME_RE.test(t))) return fail(c, '执行时间格式须为 HH:mm，多个用英文逗号分隔')
  if (!times.length || times.length > 12) return fail(c, '至少 1 个、最多 12 个执行时间点')

  const params: any = {}
  if (action === 'pipeline') {
    if (body.maxArticles !== undefined) params.maxArticles = Math.max(1, Math.min(parseInt(body.maxArticles, 10) || 3, 8))
    params.push = !!body.push
  }
  if (action === 'keyword') {
    params.keyword = String(body.keyword || '').trim().slice(0, 30)
    if (!params.keyword) return fail(c, '关键字创作任务必须填写关键词')
    if (body.style) params.style = String(body.style)
    if (body.customStyle) params.customStyle = String(body.customStyle).slice(0, 200)
  }

  const id = body.id ? String(body.id) : crypto.randomUUID().slice(0, 8) + Date.now().toString(36)
  const existing = body.id ? undefined : undefined
  await upsertCustomTask(c.env, {
    id, name, enabled: body.enabled !== false, times: times.join(','), action,
    params: JSON.stringify(params),
    next_run_at: body.enabled !== false ? computeNextFromTimes(Date.now(), times.join(',')) : 0,
  })
  return ok(c, { id, name, action, times: times.join(','), enabled: body.enabled !== false })
}

export async function handleDeleteCustomTask(c: C) {
  const id = c.req.param('id') as string
  await deleteCustomTask(c.env, id)
  return ok(c, { deleted: id })
}

// ===== 定时任务 =====

export async function handleGetSchedule(c: C) {
  const s = await getSettings(c.env)
  const now = Date.now()
  const next = Number(s.next_run_at || 0)
  const fNext = Number(s.fetch_next_run_at || 0)

  // 在途锁超时自愈：超过 30 分钟未解除的流水线锁自动清理
  const schedRunningAt = Number(s.schedule_running_at || 0)
  const isSchedRunning = schedRunningAt > 0 && (now - schedRunningAt < 30 * 60 * 1000)
  if (schedRunningAt > 0 && !isSchedRunning) {
    saveSettings(c.env, { schedule_running_at: '0' }).catch(() => {})
  }

  // 抓取锁超时自愈：超过 10 分钟未解除的抓取锁自动清理
  const fetchRunningAt = Number(s.fetch_running_at || 0)
  const isFetchRunning = fetchRunningAt > 0 && (now - fetchRunningAt < 10 * 60 * 1000)
  if (fetchRunningAt > 0 && !isFetchRunning) {
    saveSettings(c.env, { fetch_running_at: '0' }).catch(() => {})
  }

  return ok(c, {
    enabled: s.schedule_enabled === '1',
    time: s.schedule_time,
    push: s.schedule_push === '1',
    nextRunAt: next,
    nextRunText: next ? formatNextRun(next) : '—',
    lastScheduledRun: s.last_scheduled_run && s.last_scheduled_run !== '0' ? s.last_scheduled_run : '',
    running: isSchedRunning,
    fetchEnabled: s.fetch_enabled === '1',
    fetchTimes: s.fetch_times || '08:00,13:00,19:00',
    fetchNextRunAt: fNext,
    fetchNextRunText: fNext ? formatNextRun(fNext) : '—',
    lastAutoFetch: s.last_auto_fetch && s.last_auto_fetch !== '0' ? s.last_auto_fetch : '',
    fetchRunning: isFetchRunning,
  })
}

const SCHEDULE_TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

export async function handleSaveSchedule(c: C) {
  const body = await c.req.json().catch(() => ({}))
  const now = Date.now()
  const patch: Record<string, string> = {}
  const resp: Record<string, unknown> = {}

  // 每日流水线
  if (body.time !== undefined) {
    const time = String(body.time || '08:30')
    if (!SCHEDULE_TIME_RE.test(time)) return fail(c, '流水线时间格式须为 HH:mm（北京时间）')
    const enabled = !!body.enabled
    patch.schedule_enabled = enabled ? '1' : '0'
    patch.schedule_time = time
    patch.schedule_push = body.push ? '1' : '0'
    patch.next_run_at = enabled ? String(computeNextRun(now, time)) : '0'
    resp.enabled = enabled
    resp.nextRunText = enabled ? formatNextRun(Number(patch.next_run_at)) : '—'
  }

  // 每日自动抓取热点（多时间点）
  if (body.fetchTimes !== undefined) {
    const times = String(body.fetchTimes || '').split(',').map((x) => x.trim()).filter(Boolean)
    if (times.some((t) => !SCHEDULE_TIME_RE.test(t))) return fail(c, '抓取时间格式须为 HH:mm，多个用英文逗号分隔（如 08:00,13:00,19:00）')
    if (times.length > 12) return fail(c, '抓取时间点最多 12 个')
    const fetchEnabled = !!body.fetchEnabled
    patch.fetch_enabled = fetchEnabled ? '1' : '0'
    patch.fetch_times = times.join(',')
    patch.fetch_next_run_at = fetchEnabled && times.length ? String(computeNextFromTimes(now, times.join(','))) : '0'
    resp.fetchEnabled = fetchEnabled
    resp.fetchNextRunText = fetchEnabled && times.length ? formatNextRun(Number(patch.fetch_next_run_at)) : '—'
  }

  if (!Object.keys(patch).length) return fail(c, '没有可保存的定时配置')
  await saveSettings(c.env, patch)
  return ok(c, resp)
}

export async function handleReselect(c: C) {
  // 手动把某条话题标记选中/取消（覆盖自动选题）
  const { ids, selected } = await c.req.json().catch(() => ({ ids: [], selected: 1 }))
  if (!Array.isArray(ids) || !ids.length) return fail(c, '缺少 ids')
  const { markTopicsSelected } = await import('./storage')
  await markTopicsSelected(c.env, ids.map(Number), selected ? 1 : 0)
  return ok(c, { updated: ids.length })
}

// ===== 文章 =====

export async function handleListArticles(c: C) {
  const url = new URL(c.req.url)
  const status = url.searchParams.get('status') || undefined
  const genre = url.searchParams.get('genre') || undefined
  const category = url.searchParams.get('category') || undefined
  const q = url.searchParams.get('q') || undefined
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '15', 10), 100)
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0)
  const { rows, total } = await listArticlesPaged(c.env, { status, genre, category, q, limit, offset })
  // 状态统计 chips（不受状态筛选影响，受关键词/体裁影响）
  const conds: string[] = []
  const binds: any[] = []
  if (genre) { conds.push(`genre = ?`); binds.push(genre) }
  if (category) { conds.push(`topic_key IN (SELECT norm_key FROM topics WHERE category = ?)`); binds.push(category) }
  if (q) { conds.push(`(title LIKE ? OR digest LIKE ?)`); binds.push(`%${q}%`, `%${q}%`) }
  const cw = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const cnt = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS all_n, SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_n,
            SUM(CASE WHEN status = 'pushed' THEN 1 ELSE 0 END) AS pushed_n,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_n
     FROM articles ${cw}`
  ).bind(...binds).first<{ all_n: number; ready_n: number; pushed_n: number; failed_n: number }>())!
  return ok(c, {
    counts: { all: cnt.all_n ?? 0, ready: cnt.ready_n ?? 0, pushed: cnt.pushed_n ?? 0, failed: cnt.failed_n ?? 0 },
    total, offset, limit,
    articles: rows.map((a) => ({
      id: a.id, title: a.title, digest: a.digest, author: a.author, genre: a.genre,
      theme: a.theme, status: a.status, cover_url: a.cover_url.startsWith('data:') ? '' : a.cover_url,
      cover_source: a.cover_source, images: JSON.parse(a.images || '[]'), topic_key: a.topic_key,
      push_media_id: a.push_media_id, push_error: a.push_error, pushed_at: a.pushed_at,
      ai_score: a.ai_score, humanize_rounds: a.humanize_rounds,
      created_at: a.created_at,
    })),
  })
}

/** 批量操作：推送 / 删除 */
export async function handleBatchArticles(c: C) {
  const { ids, action } = await c.req.json().catch(() => ({ ids: [], action: '' }))
  if (!Array.isArray(ids) || !ids.length || !ids.length) return fail(c, '缺少 ids')
  if (action !== 'push' && action !== 'delete') return fail(c, 'action 须为 push 或 delete')
  const settings = await getSettings(c.env)
  const results: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const id of ids.slice(0, 20)) {
    if (action === 'delete') {
      await deleteArticle(c.env, String(id))
      results.push({ id: String(id), ok: true })
    } else {
      const r = await pushArticleById(c.env, settings, String(id))
      results.push({ id: String(id), ok: r.ok, error: r.error })
    }
  }
  const okCount = results.filter((r) => r.ok).length
  return ok(c, { action, total: results.length, ok: okCount, failed: results.length - okCount, results })
}

/** 近 7 天趋势 + 平台分布 */
export async function handleTrend(c: C) {
  const batchId = await getLatestBatchId(c.env)
  const trend = await getTrend(c.env, 7, batchId)
  return ok(c, trend)
}

export async function handleGetArticle(c: C) {
  const article = await getArticle(c.env, c.req.param('id') as string)
  if (!article) return fail(c, '文章不存在', 404)
  return ok(c, { article: { ...article, images: JSON.parse(article.images || '[]') } })
}

export async function handleDeleteArticle(c: C) {
  await deleteArticle(c.env, c.req.param('id') as string)
  return ok(c, { deleted: c.req.param('id') as string })
}

export async function handleUpdateArticle(c: C) {
  const id = c.req.param('id') as string
  const article = await getArticle(env0(c), id)
  if (!article) return fail(c, '文章不存在', 404)
  const body = await c.req.json().catch(() => ({}))
  const patch: any = {}
  if (typeof body.title === 'string') patch.title = body.title.slice(0, 64)
  if (typeof body.digest === 'string') patch.digest = body.digest.slice(0, 120)
  if (typeof body.author === 'string') patch.author = body.author.slice(0, 8)
  if (typeof body.markdown === 'string') {
    patch.markdown = body.markdown
    const settings = await getSettings(c.env)
    patch.html = mdToWechatHtml(body.markdown, body.theme || article.theme || settings.theme)
  } else if (typeof body.html === 'string' && body.html.trim()) {
    // 富文本模式：直接以编辑后的 HTML 为准（Markdown 源码保持不变）
    patch.html = body.html
  }
  if (typeof body.theme === 'string') {
    patch.theme = body.theme
    patch.html = mdToWechatHtml(patch.markdown || article.markdown, body.theme)
  }
  if (Object.keys(patch).length) await updateArticle(c.env, id, patch)
  // 人工编辑后自动重检 AI 痕迹（后台执行，不阻塞保存）
  const finalArticle = await getArticle(c.env, id)
  if (finalArticle) {
    c.executionCtx.waitUntil((async () => {
      try {
        const { aiScan } = await import('./humanize')
        const scan = await aiScan(await getSettings(c.env), finalArticle.markdown)
        await updateArticle(c.env, id, { ai_score: scan.aiScore, ai_signals: JSON.stringify(scan.signals) })
      } catch { /* 检测失败保留原分 */ }
    })())
  }
  return ok(c, { updated: id })
}

/** 编辑器实时预览：Markdown + 主题 → 微信 HTML */
export async function handleRenderPreview(c: C) {
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.markdown !== 'string') return fail(c, '缺少 markdown')
  const html = mdToWechatHtml(body.markdown, String(body.theme || 'clean'))
  return ok(c, { html })
}

// 小工具：某些路由里重复使用
function env0(c: C): Env {
  return c.env
}

export async function handlePushArticle(c: C) {
  const settings = await getSettings(c.env)
  const result = await pushArticleById(c.env, settings, c.req.param('id') as string)
  if (result.ok) return ok(c, { media_id: result.media_id })
  return fail(c, result.error || '推送失败', 500)
}

/** 手动为一组选题创作：按 norm_key 直查该话题的全部条目（不依赖两次合并结果一致） */
export async function handleWriteArticle(c: C) {
  const { key } = await c.req.json().catch(() => ({ key: '' }))
  if (!key) return fail(c, '缺少选题 key')
  const settings = await getSettings(c.env)
  const batchId = await getLatestBatchId(c.env)
  if (!batchId) return fail(c, '暂无热点批次，请先抓取热点')

  // 1) 该选题在各平台的全部条目（精确）
  const { results: keyRows } = await c.env.DB.prepare(
    `SELECT * FROM topics WHERE batch_id = ? AND norm_key = ? ORDER BY hot_score DESC`
  ).bind(batchId, key).all<TopicRow>()
  if (!keyRows || !keyRows.length) return fail(c, '该选题不在当前批次中（批次可能已更新，请刷新热点池）', 404)

  // 2) 补充同批次的近似条目（同话题变体，让 LLM 素材更全）
  const all = await listTopics(c.env, { batchId, limit: 400 })
  const rows = [...keyRows]
  for (const r of all) {
    if (rows.some((x) => x.id === r.id)) continue
    if (titleSimilarity(r.title, rows[0].title) >= SIM_THRESHOLD) rows.push(r)
  }

  const group = {
    key,
    title: rows[0].title,
    hotValue: rows[0].hot_value,
    score: rows[0].hot_score,
    platforms: [...new Set(rows.map((r) => r.platform))],
    urls: rows.map((r) => r.url).filter(Boolean).slice(0, 3),
    rows,
  }
  const rowIds = rows.map((r) => r.id)
  try {
    const created = await createArticleForGroup(c.env, settings, group, rowIds)
    return ok(c, created)
  } catch (e: any) {
    return fail(c, `创作失败: ${e?.message || e}`, 500)
  }
}

export async function handleRegenerateCover(c: C) {
  const id = c.req.param('id') as string
  const article = await getArticle(c.env, id)
  if (!article) return fail(c, '文章不存在', 404)
  const settings = await getSettings(c.env)
  const oldCoverUrl = (article.cover_url || '').split('?')[0]

  let resolved: { url: string; source: string } | null = null

  // 1) 换封面加入随机视觉修饰词，保证搜出完全不同维度的全新配图
  const modifiers = ['纪实摄影', '现场特写', '概念视觉', '商务科技', '全景大图', '深度解读']
  const randomMod = modifiers[Math.floor(Math.random() * modifiers.length)]
  const cleanTitle = article.title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ').trim()
  const searchQueries = [
    cleanTitle.slice(0, 16) + ' ' + randomMod,
    cleanTitle.slice(0, 14) + ' 高清'
  ]

  try {
    const { searchImages } = await import('./images')
    const result = await searchImages(settings, searchQueries, 4)
    // 优先选择与原封面不同的一张
    const newImage = result.images.find((im) => im.url && !im.url.includes(oldCoverUrl.slice(0, 45)))
    if (newImage) {
      resolved = { url: newImage.url, source: newImage.source }
    } else if (result.images.length && !result.images[0].url.includes(oldCoverUrl.slice(0, 45))) {
      resolved = { url: result.images[0].url, source: result.images[0].source }
    }
  } catch { /* 忽略网搜异常 */ }

  // 2) 若网搜无新图，尝试用 Agnes AI 重新绘制一张高契合度封面
  if ((!resolved || resolved.url.includes(oldCoverUrl.slice(0, 45))) && settings.agnes_api_key) {
    try {
      const { agnesGenerate, agnesNewsPrompt } = await import('./agnes')
      const url = await agnesGenerate(settings, agnesNewsPrompt(article.title, '公众号封面插画，' + randomMod), '1024x1024')
      resolved = { url, source: 'agnes' }
    } catch { /* 忽略 Agnes 异常 */ }
  }

  // 3) 兜底：渐变封面
  if (!resolved) {
    const { resolveCover } = await import('./pipeline')
    resolved = await resolveCover(settings, [], article.title)
  }

  await updateArticle(c.env, id, { cover_url: resolved.url, cover_source: resolved.source })
  return ok(c, { cover_url: resolved.url, cover_source: resolved.source, is_data_uri: resolved.url.startsWith('data:') })
}

/** 重新去AI化：对现有文章再跑一轮核验闭环（改写+复检），并重渲染排版 */
export async function handleHumanizeArticle(c: C) {
  const id = c.req.param('id') as string
  const article = await getArticle(c.env, id)
  if (!article) return fail(c, '文章不存在', 404)
  const settings = await getSettings(c.env)
  const { humanizeAndVerify } = await import('./humanize')
  try {
    const hm = await humanizeAndVerify(settings, article.markdown, article.genre || 'deep')
    const html = mdToWechatHtml(hm.markdown, article.theme || settings.theme)
    await updateArticle(c.env, id, {
      markdown: hm.markdown,
      html,
      ai_score: hm.aiScore,
      ai_signals: JSON.stringify(hm.signals),
      humanize_rounds: (article.humanize_rounds || 0) + hm.rounds,
    })
    return ok(c, { ai_score: hm.aiScore, initial_score: hm.initialScore, rounds: hm.rounds, signals: hm.signals })
  } catch (e: any) {
    return fail(c, `核验失败: ${e?.message || e}`, 500)
  }
}

/** 重写文章：用原选题的素材重新走一遍创作 + 配图 + 排版 */
export async function handleRewriteArticle(c: C) {
  const id = c.req.param('id') as string
  const article = await getArticle(c.env, id)
  if (!article) return fail(c, '文章不存在', 404)
  const settings = await getSettings(c.env)
  // 在全部批次中找回原选题的素材行（按归一化标题匹配）
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM topics WHERE norm_key = ? ORDER BY id DESC LIMIT 30`
  ).bind(article.topic_key).all<TopicRow>()
  if (!results || !results.length) return fail(c, '找不到原选题的热点素材（批次可能已过旧），建议删除后重新选题创作', 404)
  const platforms = [...new Set(results.map((r) => r.platform))]
  const group = {
    key: article.topic_key,
    title: results[0].title,
    hotValue: results[0].hot_value,
    score: results[0].hot_score,
    platforms,
    urls: results.map((r) => r.url).filter(Boolean).slice(0, 3),
    rows: results,
  }
  const { createArticleForGroup } = await import('./pipeline')
  try {
    const created = await createArticleForGroup(c.env, settings, group, [])
    await deleteArticle(c.env, id) // 新稿已入库，移除旧稿
    return ok(c, { new_id: created.id, title: created.title, log: created.log })
  } catch (e: any) {
    return fail(c, `重写失败: ${e?.message || e}`, 500)
  }
}

// ===== 流水线 =====

export async function handlePipelineRun(c: C) {
  const body = await c.req.json().catch(() => ({}))
  const { runPipeline } = await import('./pipeline')

  // 流式心跳执行：流水线耗时数分钟，期间周期性发送心跳字节
  // （防止 Cloudflare 100s 空闲断连与浏览器超时），跑完输出最终 JSON
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const beat = setInterval(() => {
        try { if (!closed) controller.enqueue(encoder.encode(' ')) } catch { closed = true }
      }, 15_000)
      try {
        const result = await runPipeline(c.env, 'manual', {
          push: typeof body.push === 'boolean' ? body.push : undefined,
          maxArticles: typeof body.maxArticles === 'number' ? body.maxArticles : undefined,
        })
        clearInterval(beat)
        controller.enqueue(encoder.encode('\n' + JSON.stringify({ success: true, data: result })))
      } catch (e: any) {
        clearInterval(beat)
        controller.enqueue(encoder.encode('\n' + JSON.stringify({ success: false, message: String(e?.message || e) })))
      } finally {
        if (!closed) { closed = true; controller.close() }
      }
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export async function handleLatestRun(c: C) {
  const run = await latestRun(c.env)
  return ok(c, { run })
}

export async function handleListRuns(c: C) {
  const url = new URL(c.req.url)
  const limit = parseInt(url.searchParams.get('limit') || '20', 10)
  return ok(c, { runs: await listRuns(c.env, limit) })
}

// ===== 设置 =====

const SECRET_KEYS = ['llm_api_key', 'agnes_api_key', 'img_pexels_key', 'img_pixabay_key', 'wx_api_token', 'cron_secret', 'topics_api_key']

export async function handleGetSettings(c: C) {
  const settings = await getSettings(c.env)
  const masked: any = {}
  for (const [k, v] of Object.entries(settings)) {
    if (SECRET_KEYS.includes(k) && v) {
      (masked as any)[k] = String(v).length > 8 ? String(v).slice(0, 4) + '****' + String(v).slice(-4) : '****'
    } else {
      (masked as any)[k] = v
    }
  }
  return ok(c, { settings: masked, themes: themeOptions(), genres: GENRES })
}

export async function handleSaveSettings(c: C) {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail(c, '请求体须为 JSON 对象')
  const patch: any = {}
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue
    // 掩码值不覆盖
    if (SECRET_KEYS.includes(k) && /(\*{4}|^$)/.test(String(v)) && !String(v).trim()) continue
    if (SECRET_KEYS.includes(k) && String(v).includes('****')) continue
    patch[k] = String(v)
  }
  await saveSettings(c.env, patch)
  return ok(c, { saved: Object.keys(patch).length })
}

export async function handleChangePassword(c: C) {
  const { old_password, new_password } = await c.req.json().catch(() => ({}))
  if (!old_password || !new_password) return fail(c, '缺少参数')
  if (String(new_password).length < 6) return fail(c, '新密码至少 6 位')
  const env = env0(c)
  const { getAdminCredentials } = await import('./storage')
  const cred = await getAdminCredentials(env)
  const oldHash = await hashPassword(old_password)
  if (!cred || cred.passwordHash !== oldHash) return fail(c, '旧密码错误', 403)
  await setAdminCredentials(env, cred.username, await hashPassword(new_password))
  return ok(c, { changed: true })
}

// ===== 连通性测试 =====

export async function handleTestLlm(c: C) {
  const settings = await getSettings(c.env)
  return ok(c, await testLlm(settings as AppSettings))
}

export async function handleTestAgnes(c: C) {
  const settings = await getSettings(c.env)
  return ok(c, await testAgnes(settings as AppSettings))
}

export async function handleTestImages(c: C) {
  const settings = await getSettings(c.env)
  const body = await c.req.json().catch(() => ({}))
  return ok(c, await testImageSearch(settings as AppSettings, body?.query || 'technology news'))
}

export async function handleTestWx(c: C) {
  const settings = await getSettings(c.env)
  const body = await c.req.json().catch(() => ({}))
  if (body.real) return ok(c, await testPush(settings as AppSettings))
  return ok(c, await gatewayHealth(settings as AppSettings))
}
