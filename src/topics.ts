/**
 * 全网热点抓取 —— 移植自 hot-topics skill 的 fetch_60s.py / fetch_sectors.py：
 *  - 主链路：60s API 实例池故障转移（记住最近成功实例，后续平台优先复用）
 *  - 兜底：tophub.today HTML 表格解析（微博/知乎/百度/B站/腾讯新闻/微信公众号）
 *  - 补充：IT之家 / 36氪 / 爱范儿 RSS
 * 逐平台容错，失败如实记录，绝不伪造数据。
 */
import { SIXTY_INSTANCES, PLATFORMS, RSS_SOURCES, HOT_API_IDS, BROWSER_UA } from './config'
import { tagSector, PLATFORM_CATEGORIES } from './sectors'
import type { Env, HotItem } from './types'

const FETCH_TIMEOUT_MS = 12_000

/** 归一化后的单平台榜单 */
export interface PlatformResult {
  platform: string
  platformName: string
  category: string
  items: HotItem[]
  error?: string
}

// ===== 基础工具 =====

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS, extraHeaders: Record<string, string> = {}): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', ...extraHeaders },
      signal: ctrl.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    } as any)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return await resp.text()
  } finally {
    clearTimeout(timer)
  }
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function cleanText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

// ===== 60s API =====

/** 各平台原始字段 → 统一 (title, hot, url)，与 fetch_60s.py 的 _norm 一致 */
function normItem(item: any, platform: string): HotItem | null {
  const title = String(item.title ?? item.word ?? '').trim()
  if (!title) return null
  let url = String(item.link ?? item.url ?? '')
  if (!url && platform === 'weibo') url = `https://s.weibo.com/weibo?q=${encodeURIComponent(title)}`
  return { title, hot: item.hot_value ?? item.score ?? '', url }
}

class InstancePool {
  lastGood: string | null = null
  bases(): string[] {
    if (!this.lastGood) return SIXTY_INSTANCES
    return [this.lastGood, ...SIXTY_INSTANCES.filter((b) => b !== this.lastGood)]
  }
}

/** 单平台：依序尝试实例池，成功后记住实例；全失败抛错 */
async function fetchVia60s(pool: InstancePool, platform: string): Promise<HotItem[]> {
  const endpoint = PLATFORMS[platform]?.endpoint
  if (!endpoint) throw new Error('无 60s endpoint')
  let lastErr: unknown = null
  for (const base of pool.bases()) {
    try {
      const raw = await fetchText(`${base}/v2/${endpoint}`)
      const data = JSON.parse(raw)
      if (data.code !== 200) throw new Error(data.message || `bad code ${data.code}`)
      const items = (Array.isArray(data.data) ? data.data : [])
        .map((it: any) => normItem(it, platform))
        .filter(Boolean) as HotItem[]
      if (!items.length) throw new Error('空列表')
      pool.lastGood = base
      return items.slice(0, 50)
    } catch (e: any) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

// ===== tophub HTML 兜底（移植 fetch_60s.py 的 fetch_tophub） =====

const JS_REMNANT_RE = /['`]\s*[+&]|item\.title|v\.title|&#[x0-9a-f]/i

function isJsRemnant(title: string): boolean {
  return JS_REMNANT_RE.test(title)
}

function parseTophub(html: string, sourceName: string): HotItem[] {
  const out: HotItem[] = []
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/)
  if (!tableMatch) return out
  const rows = tableMatch[0].match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) || []
  for (const row of rows) {
    const linkMatch = row.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!linkMatch) continue
    const url = decodeEntities(linkMatch[1])
    const title = cleanText(linkMatch[2])
    if (!title || title === 'API 开放平台' || isJsRemnant(title)) continue
    // 热度：只认纯数字(+万/亿/K/W)且非行号；须含万/亿/K/W 或数字 ≥3 位
    const cellTexts = (row.match(/>([^<>]+)</g) || []).map((m) => cleanText(m.slice(1, -1)))
    let hot: string = ''
    for (const cand of cellTexts) {
      if (/^[\d.,]+\s*[万亿KkWw]?$/.test(cand) && !/^\d{1,3}\.$/.test(cand)) {
        if (/[万亿KkWw]/.test(cand) || cand.replace(/\D/g, '').length >= 3) {
          hot = cand
          break
        }
      }
    }
    out.push({ title, hot, url })
  }
  void sourceName
  return out.slice(0, 50)
}

async function fetchViaTophub(platform: string): Promise<HotItem[]> {
  const boardId = PLATFORMS[platform]?.tophub
  if (!boardId) throw new Error('无 tophub 兜底')
  const html = await fetchText(`https://tophub.today/n/${boardId}`, 15_000)
  const items = parseTophub(html, PLATFORMS[platform]?.name || platform)
  if (!items.length) throw new Error('tophub 解析为空')
  return items
}

// ===== RSS（移植 fetch_sectors.py 的极简解析） =====

async function fetchViaRss(key: string): Promise<HotItem[]> {
  const src = RSS_SOURCES[key]
  const xml = await fetchText(src.url, 15_000)
  const titles = xml.match(/<title>([\s\S]*?)<\/title>/g) || []
  const items: HotItem[] = []
  for (let i = 1; i < titles.length; i++) {
    // 跳过第一个（频道标题）
    const raw = titles[i].replace(/<\/?title>/g, '')
    const title = decodeEntities(raw.replace(/<[^>]*>/g, '')).trim()
    if (!title) continue
    const linkMatch = xml.slice(xml.indexOf(titles[i])).match(/<link>(https?:\/\/[^<]+)<\/link>/)
    items.push({ title, hot: '', url: linkMatch ? linkMatch[1] : '' })
    if (items.length >= 50) break
  }
  if (!items.length) throw new Error('RSS 解析为空')
  return items
}

// ===== 自托管热点网关（首选源） =====

/**
 * 自托管热点聚合网关：GET {base}/api/{apiId}
 * 响应 { code: 200, data: { platform, name, update_time, total, items: [{ title, hot, url }] } }
 * items 结构与本模块 HotItem 完全同构（title/hot/url），直连各平台官方接口。
 */
async function fetchViaHotApi(base: string, platform: string, apiKey?: string): Promise<{ items: HotItem[]; category: string }> {
  const apiId = HOT_API_IDS[platform]
  if (!apiId) throw new Error('热点网关不支持该平台')
  const raw = await fetchText(`${base.replace(/\/+$/, '')}/api/${apiId}`, FETCH_TIMEOUT_MS, apiKey ? { 'X-API-Key': apiKey } : {})
  const d = JSON.parse(raw)
  if (d.code !== 200) throw new Error(d.error || `code ${d.code}`)
  const items = (d.data?.items || [])
    .map((it: any) => ({ title: String(it.title ?? '').trim(), hot: it.hot ?? '', url: String(it.url ?? '') }))
    .filter((it: HotItem) => it.title)
  if (!items.length) throw new Error('空列表')
  return { items: items.slice(0, 50), category: String(d.data?.category || '') }
}

// ===== 抓取入口 =====

/**
 * 全平台抓取：优先走自托管热点网关（直连官方接口），单平台失败自动回落
 * 60s API 实例池 / tophub / RSS 老链路；逐平台隔离容错，绝不伪造数据。
 */
export async function fetchAllPlatforms(platformKeys?: string[], hotApiBase?: string, hotApiKey?: string): Promise<{ results: PlatformResult[]; okCount: number; failCount: number; viaHotApi: number }> {
  const pool = new InstancePool()
  const keys = (platformKeys && platformKeys.length ? platformKeys : Object.keys(PLATFORMS)).filter((k) => PLATFORMS[k])
  const base = (hotApiBase || '').replace(/\/+$/, '')
  const rssKeys = Object.keys(RSS_SOURCES).filter((k) => !keys.length || keys.includes(k))

  const viaHot = new Set<string>()
  const tasks: Array<Promise<PlatformResult>> = keys.map(async (platform) => {
    const meta = PLATFORMS[platform]
    const fallbackCategory = PLATFORM_CATEGORIES[platform] || '综合'
    // 1) 自托管热点网关（首选）
    if (base && HOT_API_IDS[platform]) {
      try {
        const { items, category } = await fetchViaHotApi(base, platform, hotApiKey)
        viaHot.add(platform)
        return { platform, platformName: meta.name, category: category || fallbackCategory, items }
      } catch { /* 网关失败 → 回落老链路 */ }
    }
    // 2) 老链路：60s API 实例池 → tophub 兜底
    try {
      let items: HotItem[]
      try {
        items = meta.endpoint ? await fetchVia60s(pool, platform) : await fetchViaTophub(platform)
      } catch {
        items = await fetchViaTophub(platform)
      }
      return { platform, platformName: meta.name, category: fallbackCategory, items }
    } catch (e: any) {
      return { platform, platformName: meta.name, category: fallbackCategory, items: [], error: e?.message || String(e) }
    }
  })

  const rssTasks: Array<Promise<PlatformResult>> = rssKeys
    .filter((k) => !(base && HOT_API_IDS[k]))
    .map(async (key) => {
      try {
        return { platform: key, platformName: RSS_SOURCES[key].name, category: PLATFORM_CATEGORIES[key] || '科技', items: await fetchViaRss(key) }
      } catch (e: any) {
        return { platform: key, platformName: RSS_SOURCES[key].name, category: PLATFORM_CATEGORIES[key] || '科技', items: [], error: e?.message || String(e) }
      }
    })

  const settled = await Promise.allSettled([...tasks, ...rssTasks])
  const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : { platform: '?', platformName: '?', category: '综合', items: [], error: String(s.reason) }))
  const okCount = results.filter((r) => !r.error && r.items.length).length
  const failCount = results.length - okCount
  return { results, okCount, failCount, viaHotApi: viaHot.size }
}
