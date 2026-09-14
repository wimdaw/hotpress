/**
 * URL 文章提取 —— 抓取网页正文（支持公众号、新闻站、博客等常见文章页）。
 * 策略：浏览器 UA 拉取 → 去除 script/style/nav 等噪声 → 优先 <article>/<main> →
 * 兜底取文本最长的容器 → 标签剥离留段落换行。
 */
import { BROWSER_UA } from './config'

const FETCH_TIMEOUT_MS = 20_000

function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|iframe|svg|form|nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '')
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x[0-9a-f]+;/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 1)
    .join('\n')
    .trim()
}

function cleanText(s: string): string {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

function extractTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
  if (og) return og[1].trim()
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (t) return t[1].trim()
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  if (h1) return h1[1].replace(/<[^>]+>/g, '').trim()
  return ''
}

/** 提取正文主区块：优先 article/main，其次取文本量最大的 div */
function extractBody(html: string): string {
  const cleaned = stripNoise(html)
  const art = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
  if (art && art[1].replace(/<[^>]+>/g, '').trim().length > 300) return htmlToText(art[1])
  const main = cleaned.match(/<(main|div[^>]+id=["']js_(content|article)|div[^>]+class=["'][^"']*article-content[^"']*")[^>]*>([\s\S]*?)<\/\1>/i)
  if (main && main[3] && main[3].replace(/<[^>]+>/g, '').trim().length > 300) return htmlToText(main[3])
  // 兜底：所有 div 中文本量最大者
  let best = ''
  const divs = cleaned.match(/<div[^>]*>[\s\S]*?<\/div>/g) || []
  for (const d of divs) {
    const text = htmlToText(d)
    if (text.length > best.length) best = text
  }
  if (best.length > 300) return best
  return htmlToText(cleaned)
}

export interface ExtractedArticle {
  title: string
  text: string
  url: string
  source: string
  author?: string
  images?: string[]
}

/** 微信公众号专属解析：正文在 #js_content（服务端直出，图片用 data-src 懒加载） */
function extractWechat(html: string): ExtractedArticle {
  const titleM = html.match(/<h1[^>]+id=["']activity-name["'][^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
  const authorM = html.match(/id=["']js_name["'][^>]*>([\s\S]*?)<\/a>/i)
    || html.match(/property=["']og:article:author["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/var\s+nickname\s*=\s*["']([^"']+)["']/)
  const contentM = html.match(/id=["']js_content["'][^>]*>([\s\S]*?)<div[^>]+id=["']js_tags["']/i)
    || html.match(/id=["']js_content["'][^>]*>([\s\S]*?)<script/i)
    || html.match(/id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<script/i)
    || html.match(/id=["']js_content["'][^>]*>([\s\S]*)/)
  if (!contentM) throw new Error('未找到微信正文节点（文章可能已被删除或需登录）')

  let content = contentM[1]
  // 去掉二维码/广告/留言引导等噪声区块
  content = content.replace(/<[^>]*(?:qr|reward|choose)[^>]*>[\s\S]*?<\/(?:div|section)>/gi, '')
  // 图片：data-src 懒加载地址 → 记录为配图（正文中以占位标注，便于 LLM 理解版式）
  const images: string[] = []
  for (const m of content.matchAll(/data-src=["']([^"']+)["']/gi)) {
    const src = m[1]
    if (/mmbiz/.test(src) && !images.includes(src)) images.push(src)
  }
  const text = htmlToText(content)
  if (text.replace(/\s/g, '').length < 120) throw new Error('微信正文提取为空（文章可能已被删除）')
  return {
    title: cleanText(titleM ? titleM[1] : '') || '未命名公众号文章',
    text: text.slice(0, 20000),
    url: '',
    source: 'wechat',
    author: authorM ? cleanText(authorM[1]) : undefined,
    images,
  }
}

/** 从 URL 提取文章标题与正文：微信公众号自动识别专属解析，其余走通用提取 */
export async function extractArticleFromUrl(url: string): Promise<ExtractedArticle> {
  if (!/^https?:\/\//i.test(url)) throw new Error('链接须以 http(s):// 开头')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  let html: string
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    html = await resp.text()
  } catch (e: any) {
    throw new Error(`网页抓取失败: ${e?.message || e}`)
  } finally {
    clearTimeout(timer)
  }
  const isWechat = /mp\.weixin\.qq\.com/.test(url) || /js_content/.test(html)
  if (isWechat) {
    const wechat = extractWechat(html)
    return { ...wechat, url }
  }
  const title = extractTitle(html)
  const text = extractBody(html)
  if (text.length < 120) throw new Error('未能提取到有效正文（页面可能是纯 JS 渲染或反爬）')
  return { title, text: text.slice(0, 20000), url, source: 'web' }
}
