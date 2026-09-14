/**
 * 配图搜索 —— 优先网搜，硬性保证无水印：
 *  1. 来源只选无水印图库：Openverse（CC 授权，免 key）/ Pexels / Pixabay（需 key）/ Wikimedia Commons
 *  2. WATERMARK_DOMAINS 黑名单二次过滤（URL 级），图库站预览图一律拒绝
 *  3. 选中前用浏览器 UA 探活 + 校验 content-type/体积，避免死链进正文
 * 全部失败由调用方回落 Agnes AI 文生图。
 */
import { WATERMARK_DOMAINS, BROWSER_UA } from './config'
import { decodeEntities } from './topics'
import type { AppSettings, ArticleImage } from './types'

const SEARCH_TIMEOUT_MS = 20_000
const VALIDATE_TIMEOUT_MS = 8_000
const MIN_BYTES = 12_000      // 小于 12KB 大概率是缩略图/占位图
const MAX_BYTES = 8 * 1024 * 1024

interface Candidate {
  url: string
  width: number
  height: number
  source: string
}

function isWatermarked(url: string): boolean {
  const lower = url.toLowerCase()
  return WATERMARK_DOMAINS.some((d) => lower.includes(d))
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS)
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, ...headers }, signal: ctrl.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return await resp.json()
  } finally {
    clearTimeout(timer)
  }
}

// ===== 各图源 =====

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS)
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, ...headers }, signal: ctrl.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return await resp.text()
  } finally {
    clearTimeout(timer)
  }
}

/** DuckDuckGo 图片搜索（免 key）：先取 vqd token，再调 i.js */
async function searchDuckduckgo(query: string): Promise<Candidate[]> {
  const html = await fetchText(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`)
  const m = html.match(/vqd=["']?([\d-]+)["']?/)
  if (!m) throw new Error('无法获取 vqd token')
  const api = `https://duckduckgo.com/i.js?l=zh-cn&o=json&q=${encodeURIComponent(query)}&vqd=${m[1]}&f=,,,&p=1`
  const data = await fetchJson(api, { Referer: 'https://duckduckgo.com/' })
  return (data.results || [])
    .filter((r: any) => r.image && (r.width || 0) >= 640 && !isWatermarked(r.image))
    .map((r: any) => ({ url: r.image, width: r.width || 0, height: r.height || 0, source: 'duckduckgo' }))
}

/** 百度图片（免 key，中文相关性最好）：flip 页内嵌 JSON，hoverURL 为大图 */
async function searchBaidu(query: string): Promise<Candidate[]> {
  const html = await fetchText(
    `https://image.baidu.com/search/flip?tn=baiduimage&ie=utf-8&word=${encodeURIComponent(query)}`,
    { Referer: 'https://image.baidu.com/' }
  )
  const out: Candidate[] = []
  for (const m of html.matchAll(/\{"thumbURL":"[^"]+"[^{}]*\}/g)) {
    try {
      const j = JSON.parse(m[0])
      const url = j.hoverURL || j.middleURL || j.thumbURL
      if (url && (j.width || 0) >= 480 && !isWatermarked(url)) {
        out.push({ url, width: j.width || 0, height: j.height || 0, source: 'baidu' })
      }
    } catch { /* 单条解析失败忽略 */ }
  }
  return out
}

/** 头条新闻搜索（免 key，中文新闻图）：so.toutiao.com 结果内嵌 image_url（签名直链） */
async function searchToutiao(query: string): Promise<Candidate[]> {
  // 头条对数据中心 IP 有反爬：补齐浏览器式请求头 + 随机 tt_webid Cookie 提高通过率
  const webid = String(Math.floor(Math.random() * 6e18))
  const html = await fetchText(
    `https://so.toutiao.com/search?dvpf=pc&keyword=${encodeURIComponent(query)}`,
    {
      Referer: 'https://so.toutiao.com/',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Cookie: `tt_webid=${webid}; tt_webid_v2=${webid}`,
    }
  )
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/"image_url":"(https:[^"]*toutiaoimg\.com[^"]+)"/g)) {
    try {
      const url = JSON.parse('"' + m[1] + '"')
      if (seen.has(url) || !url || isWatermarked(url)) continue
      seen.add(url)
      const dim = url.match(/:(\d+):(\d+)\./)
      out.push({ url, width: dim ? parseInt(dim[1], 10) : 450, height: dim ? parseInt(dim[2], 10) : 300, source: 'toutiao' })
      if (out.length >= 20) break
    } catch { /* 单条解析失败忽略 */ }
  }
  return out
}

/** Bing 图片搜索（免 key）：解析 iusc 卡片 m 属性 JSON 中的 murl */
async function searchBing(query: string): Promise<Candidate[]> {
  const html = await fetchText(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&count=35`)
  const out: Candidate[] = []
  for (const blobMatch of html.matchAll(/m="([^"]+)"/g)) {
    try {
      const j = JSON.parse(decodeEntities(blobMatch[1]))
      const url = String(j.murl || '')
      // m JSON 不一定带 w/h 字段：缺省时放行，交给探活与后续筛选
      if (url && (!j.w || j.w >= 640) && !isWatermarked(url)) {
        out.push({ url, width: j.w || 0, height: j.h || 0, source: 'bing' })
      }
    } catch { /* 单卡片解析失败忽略 */ }
  }
  return out
}

async function searchOpenverse(query: string): Promise<Candidate[]> {
  const api = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=20&license_type=commercial&filter_dead=false&mature=false`
  const data = await fetchJson(api)
  return (data.results || [])
    .filter((r: any) => r.url && (r.width || 0) >= 640 && !isWatermarked(r.url))
    .map((r: any) => ({ url: r.url, width: r.width || 0, height: r.height || 0, source: 'openverse' }))
}

async function searchPexels(query: string, settings: AppSettings): Promise<Candidate[]> {
  if (!settings.img_pexels_key) return []
  const api = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`
  const data = await fetchJson(api, { Authorization: settings.img_pexels_key })
  return (data.photos || [])
    .filter((r: any) => r.src?.original && !isWatermarked(r.src.original))
    .map((r: any) => ({ url: r.src.large || r.src.original, width: r.width || 0, height: r.height || 0, source: 'pexels' }))
}

async function searchPixabay(query: string, settings: AppSettings): Promise<Candidate[]> {
  if (!settings.img_pixabay_key) return []
  const api = `https://pixabay.com/api/?key=${encodeURIComponent(settings.img_pixabay_key)}&q=${encodeURIComponent(query)}&image_type=photo&per_page=15&min_width=640&safesearch=true`
  const data = await fetchJson(api)
  return (data.hits || [])
    .filter((r: any) => r.webformatURL && !isWatermarked(r.webformatURL))
    .map((r: any) => ({ url: r.largeImageURL || r.webformatURL, width: r.imageWidth || 0, height: r.imageHeight || 0, source: 'pixabay' }))
}

async function searchWikimedia(query: string): Promise<Candidate[]> {
  const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search'
    + `&gsrnamespace=6&gsrlimit=20&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}`
    + '&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1024'
  const data = await fetchJson(api)
  const pages = data?.query?.pages || {}
  return Object.values<any>(pages)
    .map((p) => p?.imageinfo?.[0])
    .filter((ii: any) => ii && (ii.mime === 'image/jpeg' || ii.mime === 'image/png') && (ii.width || 0) >= 640)
    .map((ii: any) => ({ url: ii.thumburl || ii.url, width: ii.width || 0, height: ii.height || 0, source: 'wikimedia' }))
}

// ===== 探活校验 =====

async function validateImage(url: string): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS)
  try {
    let resp = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': BROWSER_UA }, signal: ctrl.signal })
    // 部分图源不支持 HEAD，降级 Range GET
    if (!resp.ok || !resp.headers.get('content-type')) {
      resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-2047' }, signal: ctrl.signal })
    }
    if (!resp.ok) return false
    const type = (resp.headers.get('content-type') || '').toLowerCase()
    if (!type.startsWith('image/') || type.includes('svg')) return false
    const len = parseInt(resp.headers.get('content-length') || '0', 10)
    if (len && (len < MIN_BYTES || len > MAX_BYTES)) return false
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ===== 对外入口 =====

export interface ImageSearchResult {
  images: ArticleImage[]
  log: string[]
}

/**
 * 按查询词搜索配图（每个查询词按 provider 顺序尝试），返回已探活的去重结果。
 * enQueries 为各查询词的英文版本（wikimedia/openverse 对英文命中率高得多），与 queries 按下标对应。
 * count 为目标张数；探活失败自动取下一个候选。
 */
export async function searchImages(
  settings: AppSettings,
  queries: string[],
  count: number,
  enQueries: string[] = []
): Promise<ImageSearchResult> {
  const log: string[] = []
  const images: ArticleImage[] = []
  const seen = new Set<string>()
  const providers = (settings.img_providers || 'bing')
    .split(',').map((s) => s.trim()).filter(Boolean)
  const target = Math.max(1, Math.min(count, 5))

  let totalValidated = 0
  const GLOBAL_MAX_VALIDATIONS = 8 // 一篇文章最多探活 8 张图，严格保护 Worker 子请求预算
  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi]
    if (images.length >= target || totalValidated >= GLOBAL_MAX_VALIDATIONS) break
    for (const provider of providers) {
      if (images.length >= target || totalValidated >= GLOBAL_MAX_VALIDATIONS) break
      // 英文查询在 wikimedia / openverse / bing 国际版命中率显著更高；百度保留中文
      const effectiveQuery = provider !== 'baidu' && enQueries[qi] ? enQueries[qi] : query
      let candidates: Candidate[] = []
      try {
        if (provider === 'toutiao') candidates = await searchToutiao(effectiveQuery)
        else if (provider === 'baidu') candidates = await searchBaidu(effectiveQuery)
        else if (provider === 'bing') candidates = await searchBing(effectiveQuery)
        else if (provider === 'duckduckgo') candidates = await searchDuckduckgo(effectiveQuery)
        else if (provider === 'openverse') candidates = await searchOpenverse(effectiveQuery)
        else if (provider === 'pexels') candidates = await searchPexels(query, settings)
        else if (provider === 'pixabay') candidates = await searchPixabay(query, settings)
        else if (provider === 'wikimedia') candidates = await searchWikimedia(query)
        else log.push(`未知图源 ${provider}，跳过`)
      } catch (e: any) {
        log.push(`图源 ${provider}（"${query}"）失败: ${e?.message || e}`)
        continue
      }
      if (!candidates.length) {
        log.push(`图源 ${provider}（"${query}"）无结果`)
        continue
      }
      // 横图优先（更适合公众号），宽度降序
      candidates.sort((a, b) => (b.width / Math.max(b.height, 1)) - (a.width / Math.max(a.height, 1)))
      let validatedCount = 0
      const MAX_VALIDATE_PER_PROVIDER = 3 // 每个图源最多探活 3 张候选
      for (const cand of candidates) {
        if (images.length >= target || totalValidated >= GLOBAL_MAX_VALIDATIONS) break
        if (validatedCount >= MAX_VALIDATE_PER_PROVIDER) break
        if (seen.has(cand.url) || isWatermarked(cand.url)) continue
        validatedCount++
        totalValidated++
        if (!(await validateImage(cand.url))) {
          log.push(`候选图探活失败（${cand.source}）: ${cand.url.slice(0, 80)}`)
          continue
        }
        seen.add(cand.url)
        images.push({ url: cand.url, source: cand.source, query })
        log.push(`配图命中（${cand.source}，"${query}"）: ${cand.url.slice(0, 80)}`)
      }
    }
  }
  return { images, log }
}

/** 连通性测试（后台用）：对每个 provider 用指定关键词搜一次 */
export async function testImageSearch(settings: AppSettings, query = 'technology news'): Promise<{ ok: boolean; message: string }> {
  const providers = (settings.img_providers || 'baidu').split(',').map((s) => s.trim()).filter(Boolean)
  const report: string[] = []
  let anyOk = false
  for (const provider of providers) {
    try {
      let n = 0
      if (provider === 'toutiao') n = (await searchToutiao(query)).length
      else if (provider === 'baidu') n = (await searchBaidu(query)).length
      else if (provider === 'bing') n = (await searchBing(query)).length
      else if (provider === 'duckduckgo') n = (await searchDuckduckgo(query)).length
      else if (provider === 'openverse') n = (await searchOpenverse(query)).length
      else if (provider === 'pexels') n = (await searchPexels(query, settings)).length
      else if (provider === 'pixabay') n = (await searchPixabay(query, settings)).length
      else if (provider === 'wikimedia') n = (await searchWikimedia(query)).length
      report.push(`${provider}:${n ? `✅ ${n} 条` : '⚠️ 0 条'}`)
      if (n) anyOk = true
    } catch (e: any) {
      report.push(`${provider}:❌ ${e?.message || e}`)
    }
  }
  return { ok: anyOk, message: report.join('　') || '未配置任何图源' }
}
