/**
 * 流水线编排 —— 抓取热点 → 自动选题 → LLM 创作 → 配图 → 渲染 → 推送。
 * 触发方式：Workers cron（scheduled）/ POST /api/cron/run（外部定时） / 后台手动「立即运行」。
 * 每次运行全程记录到 runs 表；单篇文章失败不阻塞其他文章。
 */
import {
  getSettings, saveSettings, insertTopics, listTopics, listArticles, markTopicsUsed,
  createArticle, updateArticle, getArticle, hasArticleForTopicToday,
  createRun, finishRun, type ArticleInput,
} from './storage'
import { fetchAllPlatforms } from './topics'
import { selectTopicGroups, autoGenre, normTitleKey, titleSimilarity } from './selector'
import { writeArticle, truncateDigest } from './writer'
import { mdToWechatHtml } from './markdown'
import { searchImages } from './images'
import { agnesGenerate, agnesNewsPrompt } from './agnes'
import { gradientCoverDataUri } from './cover'
import { pushDraft } from './wxclient'
import { PLATFORM_CATEGORIES, tagSector } from './sectors'
import { humanizeAndVerify, aiScan } from './humanize'
import type { AiSignal } from './humanize'
import type { Env, TopicGroup, AppSettings, ArticleImage } from './types'

const FETCH_MIN_INTERVAL_MS = 5 * 60 * 1000 // 60s API 上游缓存 5-15 分钟

// ===== 抓取热点入库 =====

export async function fetchAndStoreTopics(env: Env, settings: AppSettings, force = false): Promise<{ batchId: string; ok: number; fail: number; total: number; viaHotApi?: number; skipped?: boolean }> {
  const lastFetch = parseInt(settings.last_fetch_at || '0', 10)
  if (!force && lastFetch && Date.now() - lastFetch < FETCH_MIN_INTERVAL_MS) {
    return { batchId: '', ok: 0, fail: 0, total: 0, skipped: true }
  }
  const batchId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const platforms = settings.platforms.split(',').map((s) => s.trim()).filter(Boolean)
  const { results, okCount, failCount, viaHotApi } = await fetchAllPlatforms(platforms, settings.topics_api_url, settings.topics_api_key)

  const rows: Array<any> = []
  for (const r of results) {
    if (r.error || !r.items.length) continue
    r.items.forEach((item: any, idx: number) => {
      rows.push({
        platform: r.platform,
        platformName: r.platformName,
        title: item.title,
        hot: item.hot,
        url: item.url,
        normKey: normTitleKey(item.title),
        category: (r as any).category || PLATFORM_CATEGORIES[r.platform] || '综合',
        sector: tagSector(item.title),
        rank: idx, // 平台内位次（榜单顺序即榜单位次）
      })
    })
  }
  // 热度归一化：数值直取；字符串带单位换算；无热度（RSS/tophub 位次型）按榜单位次给衰减分，
  // 保证不同来源之间仍有可比的次序（hot-topics 规则：无数值按榜单位次）
  for (const row of rows) {
    row.score = 0
    const raw = row.hot
    if (typeof raw === 'number' && isFinite(raw)) row.score = raw
    else if (typeof raw === 'string') {
      const m = raw.trim().match(/^([\d.,]+)\s*([万亿KkWw]?)$/)
      if (m) {
        const num = parseFloat(m[1].replace(/,/g, ''))
        if (isFinite(num)) row.score = m[2] === '亿' ? num * 1e8 : (m[2] === '万' || /[wW]/.test(m[2])) ? num * 1e4 : /[kK]/.test(m[2]) ? num * 1e3 : num
      }
    }
    if (!row.score) row.score = Math.max(1000 - row.rank * 8, 10) // 位次分：第 1 名 1000，逐名衰减
  }
  const total = rows.length ? await insertTopics(env, batchId, rows) : 0
  await saveSettings(env, { last_fetch_at: String(Date.now()) })
  return { batchId, ok: okCount, fail: failCount, total, viaHotApi }
}

// ===== 配图注入 =====

/** 把配图按位置插入 Markdown：第 1 段后、约 55% 处、约 80% 处 */
export function insertImagesIntoMarkdown(md: string, images: ArticleImage[]): string {
  if (!images.length) return md
  const blocks = md.split(/\n{2,}/)
  const positions = [1, Math.max(2, Math.floor(blocks.length * 0.55)), Math.max(3, Math.floor(blocks.length * 0.8))]
  const out: string[] = []
  let imgIdx = 0
  for (let i = 0; i < blocks.length; i++) {
    out.push(blocks[i])
    if (imgIdx < images.length && positions[imgIdx] === i) {
      const img = images[imgIdx]
      out.push(`![${img.query}｜配图来源：${img.source}](${img.url})`)
      imgIdx++
    }
  }
  while (imgIdx < images.length) {
    const img = images[imgIdx]
    out.push(`![${img.query}｜配图来源：${img.source}](${img.url})`)
    imgIdx++
  }
  return out.join('\n\n')
}

/** 封面链：文章配图第一张 → Agnes 生成 → 渐变 PNG 保底 */
export async function resolveCover(settings: AppSettings, images: ArticleImage[], topicTitle: string): Promise<{ url: string; source: string }> {
  if (images.length) return { url: images[0].url, source: images[0].source }
  try {
    const url = await agnesGenerate(settings, agnesNewsPrompt(topicTitle, '公众号封面配图插画'), '1024x1024')
    return { url, source: 'agnes' }
  } catch { /* 落到保底 */ }
  const uri = await gradientCoverDataUri(topicTitle)
  return { url: uri, source: 'gradient' }
}

// ===== 单篇创作 =====

export async function createArticleForGroup(
  env: Env,
  settings: AppSettings,
  group: TopicGroup,
  topicRowIds: number[]
): Promise<{ id: string; title: string; log: string[] }> {
  const log: string[] = []
  const genre = settings.genre === 'auto' ? autoGenre(group.title) : settings.genre
  const theme = settings.theme || 'clean'

  let draft = await writeArticle(settings, group, genre)
  log.push(`✍️ 创作[${genre}]《${draft.title}》`)

  // 去 AI 化核验闭环（推送前强制质检）
  let aiScore: number | null = null
  let aiSignals: AiSignal[] = []
  let humanizeRounds = 0
  const threshold = Math.max(10, Math.min(parseInt(settings.humanize_threshold || '40', 10), 90))

  if (settings.humanize_enabled === '1') {
    const hm = await humanizeAndVerify(settings, draft.markdown, genre)
    draft = { ...draft, markdown: hm.markdown }
    aiScore = hm.aiScore
    aiSignals = hm.signals
    humanizeRounds = hm.rounds
    log.push(...hm.log)
    if (hm.aiScore > threshold) {
      log.push(`🚫 去AI化核验未达标（${hm.aiScore} 分 > 阈值 ${threshold}），按规则舍弃该篇，不存入文章管理`)
      throw new Error(`去AI化未达标（最终 ${hm.aiScore} 分，发布门槛 ≤${threshold} 分），已自动丢弃未达标草稿`)
    }
    log.push(`🛡️ 去AI化核验通过（${hm.aiScore} 分 ≤ 阈值 ${threshold}）`)
  } else {
    try {
      const scan = await aiScan(settings, draft.markdown)
      aiScore = scan.aiScore
      aiSignals = scan.signals
      log.push(`🤖 AI 痕迹检测 ${scan.aiScore} 分（核验未启用，仅记录）`)
    } catch { /* 检测失败不阻塞创作 */ }
  }

  // 配图：网搜（无水印过滤）→ 不足则 Agnes 补
  let images: ArticleImage[] = []
  const imgTarget = Math.max(0, parseInt(settings.img_count || '3', 10))
  if (imgTarget > 0) {
    // 确保搜图词紧贴核心实体：若首个搜图词未包含核心词，前置补入文章标题实体
    const cleanTopic = group.title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ').trim()
    const coreWords = cleanTopic.split(/\s+/).filter((w) => w.length >= 2).slice(0, 3).join(' ')
    const finalQueries = [...(draft.image_queries || [])]
    if (coreWords && (!finalQueries.length || !finalQueries[0].includes(coreWords.slice(0, 4)))) {
      finalQueries.unshift(coreWords)
    }
    const finalEnQueries = [...(draft.image_queries_en || [])]

    try {
      const result = await searchImages(settings, finalQueries, imgTarget, finalEnQueries)
      images = result.images
      log.push(...result.log.map((l) => '🖼 ' + l))
    } catch (e: any) {
      log.push(`🖼 网搜异常: ${e?.message || e}`)
    }
    if (!images.length && settings.agnes_api_key) {
      try {
        const url = await agnesGenerate(settings, agnesNewsPrompt(draft.image_queries[0] || group.title))
        images.push({ url, source: 'agnes', query: draft.image_queries[0] || group.title })
        log.push('🖼 网搜无结果，Agnes AI 生成配图 1 张')
      } catch (e: any) {
        log.push(`🖼 Agnes 生成失败: ${e?.message || e}`)
      }
    }
  }

  const markdown = insertImagesIntoMarkdown(draft.markdown, images)
  const html = mdToWechatHtml(markdown, theme)
  const cover = await resolveCover(settings, images, group.title)
  log.push(`🎨 封面来源: ${cover.source}`)

  const id = crypto.randomUUID().slice(0, 8) + Date.now().toString(36)
  const input: ArticleInput = {
    id,
    topicKey: group.key,
    title: draft.title,
    digest: draft.digest || truncateDigest(group.title),
    author: draft.author || settings.wx_author || '',
    genre,
    theme,
    markdown,
    html,
    coverUrl: cover.url,
    coverSource: cover.source,
    images,
    status: 'ready',
  }
  await createArticle(env, input)
  await updateArticle(env, id, { ai_score: aiScore, ai_signals: JSON.stringify(aiSignals), humanize_rounds: humanizeRounds })
  if (topicRowIds.length) await markTopicsUsed(env, topicRowIds)
  return { id, title: draft.title, log }
}

// ===== 推送单篇 =====

export async function pushArticleById(env: Env, settings: AppSettings, id: string): Promise<{ ok: boolean; media_id?: string; error?: string }> {
  const article = await getArticle(env, id)
  if (!article) return { ok: false, error: '文章不存在' }

  // 去 AI 化核验门禁：未达标禁止推送
  if (settings.humanize_enabled === '1' && article.ai_score != null) {
    const threshold = Math.max(10, Math.min(parseInt(settings.humanize_threshold || '40', 10), 90))
    if (article.ai_score > threshold) {
      return { ok: false, error: `未通过去AI化核验：AI 痕迹分 ${Math.round(article.ai_score)} 超过阈值 ${threshold}，请先「重新去AI化」或在设置中调整阈值` }
    }
  }

  // 兜底链再走一遍（老数据可能没有封面）
  let cover = article.cover_url
  if (!cover) {
    const images: ArticleImage[] = JSON.parse(article.images || '[]')
    const resolved = await resolveCover(settings, images, article.title)
    cover = resolved.url
    await updateArticle(env, id, { cover_url: cover, cover_source: resolved.source })
  }
  let html = article.html
  if (!html) {
    html = mdToWechatHtml(article.markdown, article.theme || settings.theme)
    await updateArticle(env, id, { html })
  }
  const digest = article.digest || truncateDigest(article.markdown.replace(/[#>*`\[\]!\-]/g, '').slice(0, 120))

  // 图片标签内的 &amp; 实体全部解码（转存方按字面拉取 URL，&amp; 会导致源站 400 → 图全丢）
  html = html.replace(/<img[^>]+>/g, (tag) => tag.replace(/&amp;/g, '&'))
  if (cover) cover = cover.replace(/&amp;/g, '&')

  const result = await pushDraft(settings, {
    title: article.title,
    content: html,
    contentType: 'html',
    cover,
    digest,
    author: article.author || settings.wx_author || undefined,
    accountId: settings.wx_account_id || undefined,
    needOpenComment: 1,
    onlyFansCanComment: 0,
  })

  if (result.ok) {
    await updateArticle(env, id, { status: 'pushed', push_media_id: result.media_id ?? null, push_error: null, pushed_at: new Date().toISOString() })
  } else {
    await updateArticle(env, id, { status: 'failed', push_error: result.error ?? '未知错误' })
  }
  return result
}

/** 模糊去重：候选选题与当天已有文章是否同一事件（标题相似 + 原始选题标题相似 双重比对） */
async function hasSimilarArticleToday(env: Env, group: TopicGroup): Promise<boolean> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const { results } = await env.DB.prepare(
    `SELECT topic_key, title FROM articles WHERE created_at >= ?`
  ).bind(today.toISOString()).all<{ topic_key: string; title: string }>()
  for (const a of results || []) {
    // 比对一：成稿标题与候选标题
    if (titleSimilarity(a.title || '', group.title) >= 0.45) return true
    // 比对二：候选标题与该文原始选题的标题（同事件不同平台标题差异大时仍能命中）
    const t = await env.DB.prepare(`SELECT title FROM topics WHERE norm_key = ? LIMIT 1`).bind(a.topic_key).first<{ title: string }>()
    if (t?.title && titleSimilarity(t.title, group.title) >= 0.45) return true
  }
  return false
}

/** 批量推送：把所有 ready 状态的文章推送到草稿箱（AI 门禁照常生效） */
export async function pushAllReady(env: Env, settings: AppSettings, limit = 10): Promise<{ total: number; ok: number; failed: number; blocked: number; results: Array<{ id: string; title: string; ok: boolean; error?: string }> }> {
  const ready = await listArticles(env, { status: 'ready', limit })
  const results: Array<{ id: string; title: string; ok: boolean; error?: string }> = []
  let ok = 0, blocked = 0
  for (const a of ready) {
    const r = await pushArticleById(env, settings, a.id)
    if (r.ok) { ok++; results.push({ id: a.id, title: a.title, ok: true }) }
    else {
      if ((r.error || '').indexOf('未通过去AI化核验') !== -1) blocked++
      results.push({ id: a.id, title: a.title, ok: false, error: r.error })
    }
  }
  return { total: ready.length, ok, failed: ready.length - ok, blocked, results }
}

// ===== 完整流水线 =====

export interface PipelineOptions {
  push?: boolean          // 覆盖 auto_push 设置
  fetch?: boolean         // 是否先抓热点（默认 true）
  maxArticles?: number    // 覆盖 select_count
}

export async function runPipeline(env: Env, trigger: string, opts: PipelineOptions = {}): Promise<{ runId: string; status: string; summary: any }> {
  const settings = await getSettings(env)
  const runId = crypto.randomUUID().slice(0, 8)
  await createRun(env, runId, trigger)
  const log: string[] = []
  let topicsFetched = 0
  let topicsSelected = 0
  let articlesCreated = 0
  let pushed = 0
  let status = 'success'

  try {
    // 1) 抓取
    if (opts.fetch !== false) {
      const fetched = await fetchAndStoreTopics(env, settings)
      if (fetched.skipped) log.push('⏭ 距上次抓取不足 5 分钟（60s API 上游缓存），复用已有热点')
      else log.push(`📥 热点抓取：成功 ${fetched.ok} 源 / 失败 ${fetched.fail} 源（网关直连 ${fetched.viaHotApi ?? 0} 源），入库 ${fetched.total} 条`)
      topicsFetched = fetched.total
    }

    // 2) 选题
    const batchId = await (await import('./storage')).getLatestBatchId(env)
    const rows = await listTopics(env, { batchId, limit: 400 })
    if (!rows.length) {
      log.push('⚠️ 没有任何热点数据，请先抓取热点或检查网络')
      status = 'failed'
    } else {
      const topN = opts.maxArticles ?? Math.max(1, Math.min(parseInt(settings.select_count || '3', 10), 8))
      // 板块聚焦：优先从配置的板块取材，不足时才从其他板块补位
      const scope = (settings.sector_scope || '').split(',').map((x) => x.trim()).filter(Boolean)
      const inScope = scope.length ? rows.filter((r) => scope.includes(r.sector || '')) : rows
      const outScope = scope.length ? rows.filter((r) => !scope.includes(r.sector || '')) : []
      if (scope.length) log.push(`🧭 板块聚焦：${scope.join(' / ')}（命中 ${inScope.length} 条）`)

      const usable: TopicGroup[] = []
      const seen = new Set<string>()
      const pick = async (groups: TopicGroup[], tag: string) => {
        for (const g of groups) {
          if (usable.length >= topN) break
          if (seen.has(g.key)) continue
          seen.add(g.key)
          if (await hasSimilarArticleToday(env, g)) {
            log.push(`⏭ 「${g.title.slice(0, 30)}」与今日已发文章同一事件，跳过`)
            continue
          }
          if (tag === '补位') log.push(`➕ 板块内素材不足，从其他板块补位：「${g.title.slice(0, 24)}」`)
          usable.push(g)
        }
      }
      await pick(selectTopicGroups(inScope, settings, topN + 6), '板块内')
      if (usable.length < topN && outScope.length) await pick(selectTopicGroups(outScope, settings, topN + 6), '补位')
      topicsSelected = usable.length
      log.push(`🎯 选题 ${usable.length} 篇（全批 ${rows.length} 条中产生）`)

      // 3) 逐篇创作
      const createdIds: string[] = []
      for (const group of usable) {
        try {
          const created = await createArticleForGroup(env, settings, group, group.rows.map((r) => r.id))
          createdIds.push(created.id)
          articlesCreated++
          log.push(...created.log)
        } catch (e: any) {
          log.push(`❌ 「${group.title.slice(0, 24)}」创作失败: ${e?.message || e}`)
          status = 'partial'
        }
      }

      // 4) 推送
      const shouldPush = opts.push ?? settings.auto_push === '1'
      if (shouldPush && createdIds.length) {
        log.push('🚀 开始推送微信草稿箱…')
        for (const id of createdIds) {
          try {
            const r = await pushArticleById(env, settings, id)
            if (r.ok) {
              pushed++
              log.push(`✅ 《${(await getArticle(env, id))?.title}》已推送草稿箱`)
            } else {
              log.push(`❌ 推送失败: ${r.error}`)
              status = 'partial'
            }
          } catch (e: any) {
            log.push(`❌ 推送异常: ${e?.message || e}`)
            status = 'partial'
          }
        }
      } else if (!shouldPush) {
        log.push('ℹ️ 自动推送未开启，文章已就绪，可到「文章管理」手动推送')
      }
    }
  } catch (e: any) {
    log.push(`💥 流水线异常: ${e?.message || e}`)
    status = 'failed'
  }

  await finishRun(env, runId, {
    status,
    topics_fetched: topicsFetched,
    topics_selected: topicsSelected,
    articles_created: articlesCreated,
    pushed,
    log: log.join('\n'),
  })
  return { runId, status, summary: { topicsFetched, topicsSelected, articlesCreated, pushed } }
}
