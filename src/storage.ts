import type { Env, SettingsMap, AppSettings, TopicRow, ArticleRow, ArticleImage, RunRow, CustomTaskRow } from './types'
import { DEFAULT_SETTINGS } from './config'

// ===== 建表（首次请求自动执行） =====

let schemaReady = false
export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      platform_name TEXT NOT NULL,
      title TEXT NOT NULL,
      hot_value TEXT DEFAULT '',
      hot_score REAL DEFAULT 0,
      url TEXT DEFAULT '',
      norm_key TEXT NOT NULL,
      selected INTEGER DEFAULT 0,
      used INTEGER DEFAULT 0,
      fetched_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_topics_batch ON topics (batch_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_topics_norm ON topics (norm_key)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_topics_fetched_at ON topics (fetched_at)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      topic_key TEXT NOT NULL,
      title TEXT NOT NULL,
      digest TEXT DEFAULT '',
      author TEXT DEFAULT '',
      genre TEXT DEFAULT 'brief',
      theme TEXT DEFAULT 'clean',
      markdown TEXT NOT NULL,
      html TEXT DEFAULT '',
      cover_url TEXT DEFAULT '',
      cover_source TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      status TEXT DEFAULT 'draft',
      push_media_id TEXT,
      push_error TEXT,
      pushed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_articles_status ON articles (status)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      topics_fetched INTEGER DEFAULT 0,
      topics_selected INTEGER DEFAULT 0,
      articles_created INTEGER DEFAULT 0,
      pushed INTEGER DEFAULT 0,
      log TEXT DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT
    )`),
  ])
  // 自定义自动任务表（无schema冲突，直接建）
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS custom_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      times TEXT NOT NULL,
      action TEXT NOT NULL,
      params TEXT DEFAULT '{}',
      next_run_at INTEGER DEFAULT 0,
      running_at INTEGER DEFAULT 0,
      last_run TEXT,
      last_result TEXT,
      created_at TEXT NOT NULL
    )`).run()
  // 增量迁移：老库补列（已存在时忽略报错）
  for (const stmt of [
    `ALTER TABLE articles ADD COLUMN ai_score REAL`,
    `ALTER TABLE articles ADD COLUMN ai_signals TEXT`,
    `ALTER TABLE articles ADD COLUMN humanize_rounds INTEGER DEFAULT 0`,
    `ALTER TABLE topics ADD COLUMN category TEXT DEFAULT ''`,
    `ALTER TABLE topics ADD COLUMN sector TEXT DEFAULT ''`,
    `ALTER TABLE articles ADD COLUMN origin TEXT DEFAULT ''`,
  ]) {
    try { await env.DB.prepare(stmt).run() } catch { /* 列已存在 */ }
  }
  schemaReady = true
}

// ===== 管理员凭据（D1 持久化，env 覆盖） =====

export interface AdminCredentials {
  username: string
  passwordHash: string
}

export async function getAdminCredentials(env: Env): Promise<AdminCredentials | null> {
  const row = await env.DB.prepare(
    `SELECT value FROM settings WHERE key = 'admin_credentials'`
  ).first<{ value: string }>()
  if (!row) return null
  try {
    return JSON.parse(row.value) as AdminCredentials
  } catch {
    return null
  }
}

export async function setAdminCredentials(env: Env, username: string, passwordHash: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('admin_credentials', ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(JSON.stringify({ username, passwordHash }), new Date().toISOString()).run()
}

// ===== Sessions =====

export async function createSession(env: Env, username: string, ttl: number): Promise<string> {
  const id = crypto.randomUUID()
  const expiresAt = Math.floor(Date.now() / 1000) + ttl
  await env.DB.prepare(`INSERT INTO sessions (id, username, expires_at) VALUES (?, ?, ?)`)
    .bind(id, username, expiresAt).run()
  return id
}

export async function getSession(env: Env, sessionId: string): Promise<{ username: string } | null> {
  const row = await env.DB.prepare(
    `SELECT username, expires_at FROM sessions WHERE id = ?`
  ).bind(sessionId).first<{ username: string; expires_at: number }>()
  if (!row) return null
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    await deleteSession(env, sessionId)
    return null
  }
  return { username: row.username }
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run()
}

// ===== Settings =====

export async function getSettings(env: Env): Promise<AppSettings> {
  const merged: AppSettings = { ...DEFAULT_SETTINGS }
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key != 'admin_credentials'`).all<{ key: string; value: string }>()
  for (const row of results || []) {
    if (row.key in merged) (merged as any)[row.key] = row.value
  }
  return merged
}

export async function saveSettings(env: Env, patch: SettingsMap): Promise<void> {
  const now = new Date().toISOString()
  const entries = Object.entries(patch).filter(([k]) => k in DEFAULT_SETTINGS)
  if (!entries.length) return
  const stmts = entries.map(([k, v]) =>
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(k, String(v ?? ''), now)
  )
  await env.DB.batch(stmts)
}

// ===== Topics =====

export async function insertTopics(
  env: Env,
  batchId: string,
  items: Array<{ platform: string; platformName: string; title: string; hot: string | number; url: string; normKey: string; score: number; category?: string; sector?: string }>
): Promise<number> {
  const now = new Date().toISOString()
  const stmts = items.map((it) =>
    env.DB.prepare(
      `INSERT INTO topics (batch_id, platform, platform_name, title, hot_value, hot_score, url, norm_key, fetched_at, category, sector)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(batchId, it.platform, it.platformName, it.title, String(it.hot ?? ''), it.score, it.url, it.normKey, now, it.category || '', it.sector || '')
  )
  // 分批执行，避免单次 batch 过大
  for (let i = 0; i < stmts.length; i += 40) {
    await env.DB.batch(stmts.slice(i, i + 40))
  }
  // 自动清理 3 天前的过期热点，防止表无限膨胀导致全表扫描
  cleanOldTopics(env, 3).catch(() => {})
  return items.length
}

export async function cleanOldTopics(env: Env, keepDays = 3): Promise<void> {
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString()
  await env.DB.prepare(`DELETE FROM topics WHERE fetched_at < ?`).bind(cutoff).run()
}

export async function getLatestBatchId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT batch_id FROM topics ORDER BY id DESC LIMIT 1`).first<{ batch_id: string }>()
  return row?.batch_id ?? null
}

export async function listTopics(
  env: Env,
  opts: { batchId?: string | null; platform?: string; q?: string; category?: string; sector?: string; limit?: number; offset?: number } = {}
): Promise<TopicRow[]> {
  const limit = Math.min(opts.limit ?? 200, 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const conds: string[] = []
  const binds: any[] = []
  if (opts.batchId) { conds.push(`batch_id = ?`); binds.push(opts.batchId) }
  if (opts.platform) { conds.push(`platform = ?`); binds.push(opts.platform) }
  if (opts.category) { conds.push(`category = ?`); binds.push(opts.category) }
  if (opts.sector) { conds.push(`sector = ?`); binds.push(opts.sector) }
  if (opts.q) { conds.push(`title LIKE ?`); binds.push(`%${opts.q}%`) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const { results } = await env.DB.prepare(
    `SELECT * FROM topics ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`
  ).bind(...binds).all<TopicRow>()
  return results || []
}

/** 热点筛选计数（与 listTopics 同条件） */
export async function countTopics(
  env: Env,
  opts: { batchId?: string | null; platform?: string; q?: string; category?: string; sector?: string } = {}
): Promise<number> {
  const conds: string[] = []
  const binds: any[] = []
  if (opts.batchId) { conds.push(`batch_id = ?`); binds.push(opts.batchId) }
  if (opts.platform) { conds.push(`platform = ?`); binds.push(opts.platform) }
  if (opts.category) { conds.push(`category = ?`); binds.push(opts.category) }
  if (opts.sector) { conds.push(`sector = ?`); binds.push(opts.sector) }
  if (opts.q) { conds.push(`title LIKE ?`); binds.push(`%${opts.q}%`) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM topics ${where}`).bind(...binds).first<{ n: number }>()
  return row?.n ?? 0
}

export async function markTopicsSelected(env: Env, ids: number[], selected: 0 | 1): Promise<void> {
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(',')
  await env.DB.prepare(`UPDATE topics SET selected = ? WHERE id IN (${placeholders})`).bind(selected, ...ids).run()
}

export async function markTopicsUsed(env: Env, ids: number[]): Promise<void> {
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(',')
  await env.DB.prepare(`UPDATE topics SET used = 1 WHERE id IN (${placeholders})`).bind(...ids).run()
}

export async function countTopicsSince(env: Env, sinceIso: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM topics WHERE fetched_at >= ?`).bind(sinceIso).first<{ n: number }>()
  return row?.n ?? 0
}

// ===== Articles =====

export interface ArticleInput {
  id: string
  topicKey: string
  title: string
  digest: string
  author: string
  genre: string
  theme: string
  markdown: string
  html: string
  coverUrl: string
  coverSource: string
  images: ArticleImage[]
  status: string
  origin?: string
}

export async function createArticle(env: Env, a: ArticleInput): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO articles (id, topic_key, title, digest, author, genre, theme, markdown, html, cover_url, cover_source, images, status, created_at, updated_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(a.id, a.topicKey, a.title, a.digest, a.author, a.genre, a.theme, a.markdown, a.html, a.coverUrl, a.coverSource, JSON.stringify(a.images), a.status, now, now, a.origin || '').run()
}

export async function updateArticle(env: Env, id: string, patch: Partial<ArticleRow>): Promise<void> {
  const allowed = ['title', 'digest', 'author', 'genre', 'theme', 'markdown', 'html', 'cover_url', 'cover_source', 'images', 'status', 'push_media_id', 'push_error', 'pushed_at', 'ai_score', 'ai_signals', 'humanize_rounds', 'origin']
  const sets: string[] = []
  const binds: any[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k) || v === undefined) continue
    sets.push(`${k} = ?`)
    binds.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v)
  }
  if (!sets.length) return
  sets.push(`updated_at = ?`)
  binds.push(new Date().toISOString(), id)
  await env.DB.prepare(`UPDATE articles SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
}

export async function getArticle(env: Env, id: string): Promise<ArticleRow | null> {
  return await env.DB.prepare(`SELECT * FROM articles WHERE id = ?`).bind(id).first<ArticleRow>()
}

/** CMS 表格分页查询：状态/体裁/关键词筛选 + offset + 总数 */
export async function listArticlesPaged(
  env: Env,
  opts: { status?: string; genre?: string; q?: string; category?: string; limit?: number; offset?: number }
): Promise<{ rows: ArticleRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 100)
  const offset = Math.max(opts.offset ?? 0, 0)
  const conds: string[] = []
  const binds: any[] = []
  if (opts.status) { conds.push(`status = ?`); binds.push(opts.status) }
  if (opts.genre) { conds.push(`genre = ?`); binds.push(opts.genre) }
  if (opts.category) { conds.push(`topic_key IN (SELECT norm_key FROM topics WHERE category = ?)`); binds.push(opts.category) }
  if (opts.q) { conds.push(`(title LIKE ? OR digest LIKE ?)`); binds.push(`%${opts.q}%`, `%${opts.q}%`) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM articles ${where}`).bind(...binds).first<{ n: number }>())?.n ?? 0
  const { results } = await env.DB.prepare(
    `SELECT * FROM articles ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
  ).bind(...binds).all<ArticleRow>()
  return { rows: results || [], total }
}

/** 近 N 天趋势：每日成稿数 / 推送数 / 热点入库数 */
export async function getTrend(env: Env, days = 7, batchId?: string | null): Promise<{ days: Array<{ date: string; articles: number; pushed: number; topics: number }>; platforms: Array<{ platform: string; n: number }> }> {
  const since = new Date(Date.now() - (days - 1) * 86400_000)
  since.setHours(0, 0, 0, 0)
  const sinceIso = since.toISOString()
  const [artRows, topicRows, platRows] = await Promise.all([
    env.DB.prepare(
      `SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n, SUM(CASE WHEN status = 'pushed' THEN 1 ELSE 0 END) AS p
       FROM articles WHERE created_at >= ? GROUP BY d ORDER BY d`
    ).bind(sinceIso).all<{ d: string; n: number; p: number }>(),
    env.DB.prepare(
      `SELECT substr(fetched_at, 1, 10) AS d, COUNT(*) AS n FROM topics WHERE fetched_at >= ? GROUP BY d ORDER BY d`
    ).bind(sinceIso).all<{ d: string; n: number }>(),
    batchId
      ? env.DB.prepare(`SELECT platform, COUNT(*) AS n FROM topics WHERE batch_id = ? GROUP BY platform ORDER BY n DESC LIMIT 8`).bind(batchId).all<{ platform: string; n: number }>()
      : Promise.resolve({ results: [] as Array<{ platform: string; n: number }> }),
  ])
  const artMap = new Map((artRows.results || []).map((r) => [r.d, r]))
  const topicMap = new Map((topicRows.results || []).map((r) => [r.d, r.n]))
  const out: Array<{ date: string; articles: number; pushed: number; topics: number }> = []
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - (days - 1 - i) * 86400_000).toISOString().slice(0, 10)
    const a = artMap.get(d)
    out.push({ date: d.slice(5), articles: a?.n ?? 0, pushed: a?.p ?? 0, topics: topicMap.get(d) ?? 0 })
  }
  return { days: out, platforms: (platRows as any).results || [] }
}

export async function listArticles(env: Env, opts: { status?: string; limit?: number } = {}): Promise<ArticleRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200)
  const where = opts.status ? `WHERE status = '${opts.status.replace(/'/g, '')}'` : ''
  const { results } = await env.DB.prepare(
    `SELECT * FROM articles ${where} ORDER BY created_at DESC LIMIT ${limit}`
  ).all<ArticleRow>()
  return results || []
}

export async function deleteArticle(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM articles WHERE id = ?`).bind(id).run()
}

/** 当天是否已为同一选题组创作过（防重复创作） */
export async function hasArticleForTopicToday(env: Env, topicKey: string): Promise<boolean> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const row = await env.DB.prepare(
    `SELECT id FROM articles WHERE topic_key = ? AND created_at >= ? LIMIT 1`
  ).bind(topicKey, today.toISOString()).first<{ id: string }>()
  return !!row
}

// ===== Runs =====

const STALE_RUN_TIMEOUT_MS = 15 * 60 * 1000 // 运行超过 15 分钟未结束视为超时异常中断

function repairStaleRun(env: Env, run: RunRow): RunRow {
  if (run.status === 'running') {
    const started = new Date(run.started_at).getTime()
    if (!started || Date.now() - started > STALE_RUN_TIMEOUT_MS) {
      const finishedAt = run.finished_at || new Date().toISOString()
      const log = run.log ? `${run.log}\n⚠️ 任务超时中断或异常中断（系统已自动回收）` : '任务超时中断或异常中断（系统已自动回收）'
      // 异步写回数据库，修正僵死状态
      env.DB.prepare(
        `UPDATE runs SET status = 'failed', finished_at = ?, log = ? WHERE id = ? AND status = 'running'`
      ).bind(finishedAt, log, run.id).run().catch(() => {})
      return { ...run, status: 'failed', finished_at: finishedAt, log }
    }
  }
  return run
}

export async function createRun(env: Env, id: string, trigger: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, trigger, status, started_at) VALUES (?, ?, 'running', ?)`
  ).bind(id, trigger, new Date().toISOString()).run()
}

export async function finishRun(env: Env, id: string, patch: { status: string; topics_fetched?: number; topics_selected?: number; articles_created?: number; pushed?: number; log?: string }): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs SET status = ?, topics_fetched = ?, topics_selected = ?, articles_created = ?, pushed = ?, log = ?, finished_at = ? WHERE id = ?`
  ).bind(
    patch.status,
    patch.topics_fetched ?? 0,
    patch.topics_selected ?? 0,
    patch.articles_created ?? 0,
    patch.pushed ?? 0,
    patch.log ?? '',
    new Date().toISOString(),
    id
  ).run()
}

export async function listRuns(env: Env, limit = 20): Promise<RunRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).bind(Math.min(limit, 100)).all<RunRow>()
  return (results || []).map((r) => repairStaleRun(env, r))
}

export async function latestRun(env: Env): Promise<RunRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT 1`).first<RunRow>()
  return row ? repairStaleRun(env, row) : null
}

// ===== 自定义自动任务 =====

export async function listCustomTasks(env: Env): Promise<CustomTaskRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM custom_tasks ORDER BY created_at DESC`).all<CustomTaskRow>()
  return results || []
}

export async function getEnabledCustomTasks(env: Env): Promise<CustomTaskRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM custom_tasks WHERE enabled = 1`).all<CustomTaskRow>()
  return results || []
}

export async function upsertCustomTask(env: Env, t: {
  id: string; name: string; enabled: boolean; times: string; action: string;
  params: string; next_run_at: number; created_at?: string
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO custom_tasks (id, name, enabled, times, action, params, next_run_at, running_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, enabled = excluded.enabled, times = excluded.times,
       action = excluded.action, params = excluded.params, next_run_at = excluded.next_run_at,
       running_at = 0`
  ).bind(t.id, t.name, t.enabled ? 1 : 0, t.times, t.action, t.params, t.next_run_at, t.created_at || new Date().toISOString()).run()
}

/** 更新自定义任务（部分字段：运行状态/结果回写用） */
export async function updateCustomTask(env: Env, t: {
  id: string; name: string; enabled: boolean; times: string; action: string;
  params: string; running_at?: number; created_at?: string;
  next_run_at?: number; last_run?: string; last_result?: string
}): Promise<void> {
  const sets: string[] = []
  const binds: any[] = []
  const put = (col: string, val: unknown) => { sets.push(`${col} = ?`); binds.push(val) }
  put('name', t.name); put('times', t.times); put('action', t.action); put('params', t.params)
  put('enabled', t.enabled ? 1 : 0)
  if (t.next_run_at !== undefined) put('next_run_at', t.next_run_at)
  if (t.running_at !== undefined) put('running_at', t.running_at)
  if (t.last_run !== undefined) put('last_run', t.last_run)
  if (t.last_result !== undefined) put('last_result', t.last_result)
  await env.DB.prepare(`UPDATE custom_tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, t.id).run()
}

export async function deleteCustomTask(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM custom_tasks WHERE id = ?`).bind(id).run()
}

// ===== 统计 =====

export interface SiteStats {
  topicsToday: number
  articlesTotal: number
  articlesToday: number
  pushedTotal: number
  failedTotal: number
  lastFetchAt: string
}

export async function getStats(env: Env): Promise<SiteStats> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayIso = today.toISOString()
  const [topicsToday, articlesTotal, articlesToday, pushed, failed, lastFetch] = await Promise.all([
    countTopicsSince(env, todayIso),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM articles`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM articles WHERE created_at >= ?`).bind(todayIso).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM articles WHERE status = 'pushed'`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM articles WHERE status = 'failed'`).first<{ n: number }>(),
    env.DB.prepare(`SELECT value FROM settings WHERE key = 'last_fetch_at'`).first<{ value: string }>(),
  ])
  return {
    topicsToday: topicsToday,
    articlesTotal: articlesTotal?.n ?? 0,
    articlesToday: articlesToday?.n ?? 0,
    pushedTotal: pushed?.n ?? 0,
    failedTotal: failed?.n ?? 0,
    lastFetchAt: lastFetch?.value ?? '0',
  }
}
