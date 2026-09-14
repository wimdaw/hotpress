/**
 * 关键字创作 —— 输入关键词，自动搜索全网相关热门素材，
 * 生成爆款标题与约 1800 字内容，智能配图，过去AI化核验后入库。
 *
 * 素材来源（两路合一）：
 *  1. Google News RSS 关键词新闻搜索（免 key，全球可达，时效性强）
 *  2. 本地热点池（当日已抓取的 26 源热榜，按关键词命中 + 热度排序）
 */
import { BROWSER_UA } from './config'
import { chatJson } from './llm'
import { humanizeAndVerify, aiScan } from './humanize'
import { autoGenre } from './selector'
import { truncateDigest } from './writer'
import type { Env, AppSettings, TopicGroup, TopicRow } from './types'

const NEWS_TIMEOUT_MS = 15_000

export interface KeywordMaterial {
  title: string
  source: string
  url: string
  date: string
}

/** Google News RSS 关键词搜索（中文，时效排序） */
async function googleNews(keyword: string): Promise<KeywordMaterial[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), NEWS_TIMEOUT_MS)
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml' }, signal: ctrl.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const xml = await resp.text()
    const items: KeywordMaterial[] = []
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || []
    for (const b of blocks.slice(0, 12)) {
      const t = b.match(/<title>([\s\S]*?)<\/title>/)
      const d = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)
      const src = b.match(/<source[^>]*>([\s\S]*?)<\/source>/)
      if (!t) continue
      // Google News 标题格式多为「标题 - 媒体名」
      const raw = t[1].trim()
      const splitAt = raw.lastIndexOf(' - ')
      items.push({
        title: splitAt > 8 ? raw.slice(0, splitAt) : raw,
        source: src ? src[1].trim() : splitAt > 8 ? raw.slice(splitAt + 3) : '',
        url: '',
        date: d ? d[1].trim() : '',
      })
    }
    return items
  } catch {
    return [] // 静默降级：新闻源失败不影响本地热池
  } finally {
    clearTimeout(timer)
  }
}

/** 本地热点池：当日已抓取热榜中按关键词命中 */
async function d1Hot(env: Env, keyword: string): Promise<KeywordMaterial[]> {
  try {
    const latest = await env.DB.prepare(`SELECT batch_id FROM topics ORDER BY id DESC LIMIT 1`).first<{ batch_id: string }>()
    if (!latest) return []
    const { results } = await env.DB.prepare(
      `SELECT title, platform_name, hot_value, url FROM topics
       WHERE batch_id = ? AND (title LIKE ? OR title LIKE ?)
       ORDER BY hot_score DESC LIMIT 10`
    ).bind(latest.batch_id, `%${keyword}%`, `%${keyword.slice(0, Math.max(2, keyword.length - 1))}%`).all<{ title: string; platform_name: string; hot_value: string; url: string }>()
    return (results || []).map((r) => ({
      title: r.title,
      source: r.platform_name + (r.hot_value ? `（热度 ${r.hot_value}）` : ''),
      url: r.url || '',
      date: '',
    }))
  } catch {
    return []
  }
}

/** 组装素材清单文本 */
function materialsText(news: KeywordMaterial[], hot: KeywordMaterial[]): string {
  const lines: string[] = []
  if (news.length) {
    lines.push('【相关新闻（最新报道）】')
    news.forEach((n, i) => lines.push(`${i + 1}. ${n.title}${n.source ? `（${n.source}）` : ''}`))
  }
  if (hot.length) {
    lines.push('')
    lines.push('【全网热榜相关条目（含热度）】')
    hot.forEach((n, i) => lines.push(`${i + 1}. ${n.title}${n.source ? `（${n.source}）` : ''}`))
  }
  return lines.join('\n')
}

/** 关键词 → 素材搜索 */
export async function searchKeywordHot(env: Env, keyword: string): Promise<{ news: KeywordMaterial[]; hot: KeywordMaterial[] }> {
  const [news, hot] = await Promise.all([googleNews(keyword), d1Hot(env, keyword)])
  return { news, hot }
}

/** 关键字创作主流程：素材 → 爆款成稿 → 配图 → 去AI化核验 → 落库参数 */
export async function keywordWrite(
  env: Env,
  settings: AppSettings,
  opts: { keyword: string; style?: string; customStyle?: string; angle?: string }
): Promise<{
  title: string; digest: string; markdown: string; html: string; coverUrl: string; coverSource: string;
  images: Array<{ url: string; source: string; query: string }>; aiScore: number | null; rounds: number; log: string[]
}> {
  const log: string[] = []
  const { news, hot } = await searchKeywordHot(env, opts.keyword)
  log.push(`🔍 素材搜索：相关新闻 ${news.length} 条 · 热榜命中 ${hot.length} 条`)
  if (!news.length && !hot.length) {
    throw new Error('全网未搜索到与关键词相关的热门素材，换一个更具体的关键词试试')
  }

  // 复用爆款写作管线：把素材包装成「合成热点组」
  const synthRows: TopicRow[] = []
  let rid = 0
  for (const n of [...hot, ...news].slice(0, 12)) {
    synthRows.push({
      id: rid++,
      batch_id: 'kw',
      platform: 'material',
      platform_name: n.source || '素材',
      title: n.title,
      hot_value: n.source.includes('热度') ? n.source.replace(/[^\d.万w]/g, '') : '',
      hot_score: 0,
      url: n.url,
      norm_key: '',
      selected: 0,
      used: 0,
      fetched_at: new Date().toISOString(),
      category: null,
      sector: null,
    })
  }
  const group: TopicGroup = {
    key: 'kw-' + opts.keyword,
    title: opts.keyword,
    hotValue: '',
    score: 0,
    platforms: ['关键字创作'],
    urls: [],
    rows: synthRows,
  }

  // 动态注入素材清单到写作提示词（writeArticle 按 rows 渲染条目，素材已够用；
  // 新闻标题列表通过 rows 已带入）
  const { writeArticle, truncateDigest } = await import('./writer')
  const genre = autoGenre(opts.keyword + (news[0]?.title || ''))
  const draft = await writeArticle(settings, group, genre)
  log.push(`✍️ 创作[${genre}]《${draft.title}》`)

  // 配图：与热点流水线同一链路（新闻源CC无水印 → 头条/百度 → Agnes 兜底）
  const { searchImages } = await import('./images')
  const { agnesGenerate, agnesNewsPrompt } = await import('./agnes')
  const { gradientCoverDataUri } = await import('./cover')
  let images: Array<{ url: string; source: string; query: string }> = []
  const imgTarget = Math.max(0, parseInt(settings.img_count || '3', 10))
  if (imgTarget > 0) {
    try {
      const r = await searchImages(settings, draft.image_queries, imgTarget, draft.image_queries_en || [])
      images = r.images
      log.push(...r.log.map((l) => '🖼 ' + l))
    } catch (e: any) {
      log.push(`🖼 网搜异常: ${e?.message || e}`)
    }
    if (!images.length && settings.agnes_api_key) {
      try {
        const url = await agnesGenerate(settings, agnesNewsPrompt(draft.image_queries[0] || opts.keyword))
        images.push({ url, source: 'agnes', query: draft.image_queries[0] || opts.keyword })
        log.push('🖼 网搜无结果，Agnes AI 生成配图 1 张')
      } catch (e: any) {
        log.push(`🖼 Agnes 生成失败: ${e?.message || e}`)
      }
    }
  }

  // 配图插入正文
  const { insertImagesIntoMarkdown, resolveCover } = await import('./pipeline')
  const markdown = insertImagesIntoMarkdown(draft.markdown, images)
  const cover = await resolveCover(settings, images, opts.keyword)
  log.push(`🎨 封面来源: ${cover.source}`)

  // 去AI化核验闭环
  let finalMd = markdown
  let aiScore: number | null = null
  let rounds = 0
  if (settings.humanize_enabled === '1') {
    const hm = await humanizeAndVerify(settings, finalMd, genre)
    finalMd = hm.markdown
    aiScore = hm.aiScore
    rounds = hm.rounds
    log.push(...hm.log)
    log.push(hm.aiScore <= parseInt(settings.humanize_threshold || '40', 10)
      ? `🛡️ 去AI化核验通过（${hm.aiScore} 分）`
      : `⚠️ 未达阈值（${hm.aiScore} 分），推送前请再润一轮`)
  } else {
    const scan = await aiScan(settings, finalMd)
    aiScore = scan.aiScore
  }

  const { mdToWechatHtml } = await import('./markdown')
  const html = mdToWechatHtml(finalMd, settings.theme || 'professional-clean')

  return {
    title: draft.title,
    digest: draft.digest || truncateDigest(opts.keyword),
    markdown: finalMd,
    html,
    coverUrl: cover.url,
    coverSource: cover.source,
    images,
    aiScore,
    rounds,
    log,
  }
}
