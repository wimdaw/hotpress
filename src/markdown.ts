/**
 * Markdown → 微信公众号兼容 HTML（内联样式，输出 body 片段）。
 *
 * 主题系统（21 套）：
 *  - 内置原版 3 套：clean（简洁专业·默认）/ sspai（活力橙）/ navy（沉稳深蓝）
 *    —— 与项目最初的手写渲染一致，是文章的默认观感
 *  - wewrite 移植 18 套：src/themes.generated.ts（由 scripts/gen-themes.mjs 生成）
 * 渲染时按元素（h2-h4/p/blockquote/pre/code/li/a/strong/em/img/hr）套用主题
 * CSS 规则的内联样式，缺失规则回落到主题 colors 或内置默认。
 */
import { WEWRITE_THEMES, type ThemeRules } from './themes.generated'

export interface WechatTheme {
  name: string
  label: string
}

/** 内置原版主题的色板 */
const BUILTIN_TOKENS: Record<string, { text: string; heading: string; accent: string; textLight: string; quoteBg: string; codeBg: string; codeText: string; hr: string; link: string }> = {
  clean: { text: '#3f3f3f', heading: '#1a1a1a', accent: '#3b6cf5', textLight: '#888888', quoteBg: '#f7f8fa', codeBg: '#f2f3f7', codeText: '#c7254e', hr: '#e5e6eb', link: '#3b6cf5' },
  sspai: { text: '#404040', heading: '#222222', accent: '#d9534f', textLight: '#999999', quoteBg: '#fdf3f2', codeBg: '#f7f3f2', codeText: '#c0392b', hr: '#eee2e0', link: '#d9534f' },
  navy: { text: '#3c4858', heading: '#1f2d3d', accent: '#1f6fb2', textLight: '#8492a6', quoteBg: '#f0f5fa', codeBg: '#eef2f7', codeText: '#b03a5b', hr: '#dde4ee', link: '#1f6fb2' },
}

/** 由色板构建内置主题规则（与最初手写渲染一致） */
function builtinRules(key: string): ThemeRules {
  const c = BUILTIN_TOKENS[key] || BUILTIN_TOKENS.clean
  return {
    name: key,
    description: '',
    colors: { text: c.text, primary: c.accent },
    rules: {
      p: `margin:0 0 18px;font-size:15px;line-height:1.85;letter-spacing:0.5px;color:${c.text};text-align:justify;`,
      h2: `margin:30px 0 16px;padding-left:10px;border-left:4px solid ${c.accent};font-size:18px;font-weight:700;line-height:1.4;color:${c.heading};`,
      h3: `margin:24px 0 12px;font-size:16px;font-weight:700;color:${c.heading};`,
      h4: `margin:18px 0 10px;font-size:15px;font-weight:700;color:${c.accent};`,
      blockquote: `margin:0 0 18px;padding:10px 14px;border-left:4px solid ${c.accent};background:${c.quoteBg};font-size:14px;line-height:1.8;color:${c.textLight};`,
      ul: `margin:0 0 18px;font-size:15px;line-height:1.8;color:${c.text};`,
      li: 'margin:0 0 8px;line-height:1.8;',
      pre: `margin:0 0 18px;padding:12px 14px;border-radius:6px;background:${c.codeBg};`,
      'pre code': `color:${c.text};`,
      code: `margin:0 2px;padding:2px 5px;border-radius:3px;background:${c.codeBg};color:${c.codeText};`,
      strong: `color:${c.heading};font-weight:700;`,
      a: `color:${c.link || c.accent};border-bottom:1px solid ${c.accent}40;text-decoration:none;`,
      hr: `margin:24px 0;border:none;border-top:1px solid ${c.hr};`,
      img: 'border-radius:6px;',
    },
  }
}

const BUILTIN_THEMES: Record<string, ThemeRules> = {
  clean: builtinRules('clean'),
  sspai: builtinRules('sspai'),
  navy: builtinRules('navy'),
}

const DEFAULT_THEME = 'clean'

export function resolveTheme(key?: string): ThemeRules {
  const k = key || DEFAULT_THEME
  // 'wewrite-sspai' 别名：与内置 sspai（活力橙）撞名，加前缀区分
  if (k === 'wewrite-sspai') return WEWRITE_THEMES['sspai'] || BUILTIN_THEMES[DEFAULT_THEME]
  return BUILTIN_THEMES[k] || WEWRITE_THEMES[k] || BUILTIN_THEMES[DEFAULT_THEME]
}

/** 取主题规则声明串（缺失时返回 fallback） */
function rule(t: ThemeRules, selector: string, fallback = ''): string {
  return t.rules[selector] || fallback
}

/** body 规则 → 外层 section 样式（内置主题：字号/字色；wewrite 主题去掉微信不生效的属性） */
function bodyStyle(t: ThemeRules): string {
  if (BUILTIN_THEMES[t.name]) return `font-size:15px;color:${t.colors.text};`
  const body = rule(t, 'body')
  return body
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^(background|max-width|margin|padding|word-wrap)\s*:/.test(d))
    .join(';')
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 行内格式：加粗 / 斜体 / 行内代码 / 链接（套用主题的 strong/em/code/a 规则） */
function inline(md: string, t: ThemeRules): string {
  let s = esc(md)
  const codeStyle = rule(t, 'code', `background:${t.colors.code_bg || '#f2f3f7'};color:${t.colors.code_color || '#c7254e'};padding:2px 5px;border-radius:3px;`)
  const strongStyle = rule(t, 'strong', '')
  const emStyle = rule(t, 'em', '')
  const aStyle = rule(t, 'a', `color:${t.colors.primary || '#3b6cf5'};`)
  s = s.replace(/`([^`]+)`/g, `<code style="${codeStyle}font-size:0.85em;font-family:Menlo,Consolas,monospace;">$1</code>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, `<strong style="${strongStyle}">$1</strong>`)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, `$1<em style="${emStyle}">$2</em>`)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, `<a href="$2" style="${aStyle}text-decoration:none;">$1</a>`)
  return s
}

const SECTION = (style: string, inner: string) => `<section style="${style}">${inner}</section>`

/** 主渲染：块级解析（标题/段落/列表/引用/代码块/图片/分隔线），逐元素套主题内联样式 */
export function mdToWechatHtml(md: string, themeKey = DEFAULT_THEME): string {
  const t = resolveTheme(themeKey)
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  let paraBuf: string[] = []

  const pStyle = rule(t, 'p', `font-size:15px;line-height:1.85;color:${t.colors.text || '#3f3f3f'};margin:0 0 18px;letter-spacing:0.5px;text-align:justify;`)
  const flushPara = () => {
    if (!paraBuf.length) return
    const text = paraBuf.join('<br>').trim()
    if (text) {
      out.push(SECTION(pStyle, inline(text, t)))
    }
    paraBuf = []
  }

  while (i < lines.length) {
    const line = lines[i]

    // 代码块
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      flushPara()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      const preStyle = rule(t, 'pre', `margin:0 0 18px;padding:12px 14px;border-radius:6px;background:${t.colors.code_bg || '#f2f3f7'};`)
      const codeStyle = rule(t, 'pre code', rule(t, 'code', `color:${t.colors.code_color || 'inherit'};`))
      out.push(SECTION(preStyle,
        `<pre style="margin:0;white-space:pre-wrap;word-break:break-all;font-family:Menlo,Consolas,monospace;font-size:12.5px;line-height:1.7;${codeStyle}">${esc(buf.join('\n'))}</pre>`
      ))
      continue
    }

    // 标题：## → h2、### → h3（与原版渲染层级一致）
    const h = line.match(/^(#{2,4})\s+(.+)$/)
    if (h) {
      flushPara()
      const sel = `h${h[1].length}`
      const style = rule(t, sel, `font-size:${21 - h[1].length * 2}px;font-weight:700;color:${t.colors.text || '#333'};margin:24px 0 12px;`)
      out.push(SECTION(style, inline(h[2], t)))
      i++
      continue
    }

    // 图片
    const img = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)/)
    if (img) {
      flushPara()
      const imgStyle = rule(t, 'img', '') + 'max-width:100%;display:block;margin:0 auto;'
      // src 中的 & 保持原样（转成 &amp; 会被下游转存方按字面拉取导致 400）
      const src = esc(img[2]).replace(/&amp;/g, '&')
      out.push(SECTION('margin:0 0 18px;text-align:center;', `<img src="${src}" alt="${esc(img[1])}" style="${imgStyle}">`))
      i++
      continue
    }

    // 引用
    if (/^>\s?/.test(line)) {
      flushPara()
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++ }
      const bqStyle = rule(t, 'blockquote', `margin:0 0 18px;padding:10px 14px;border-left:4px solid ${t.colors.quote_border || '#ccc'};background:${t.colors.quote_bg || '#f7f8fa'};font-size:14px;line-height:1.8;color:${t.colors.text_light || '#888'};`)
      out.push(SECTION(bqStyle, inline(buf.join('<br>'), t)))
      continue
    }

    // 列表（无序列表带 • 符号，与原版一致）
    if (/^[-*]\s+/.test(line) || /^\d+[.、]\s+/.test(line)) {
      flushPara()
      const ordered = /^\d+[.、]\s+/.test(line)
      const listSel = ordered ? 'ol' : 'ul'
      const listStyle = rule(t, listSel, 'padding-left:22px;margin:0 0 18px;')
      const liStyle = rule(t, 'li', `margin:0 0 8px;line-height:1.8;color:${t.colors.text || '#3f3f3f'};`)
      const items: string[] = []
      while (i < lines.length && (/^[-*]\s+/.test(lines[i]) || /^\d+[.、]\s+/.test(lines[i]))) {
        const content = lines[i].replace(/^([-*]|\d+[.、])\s+/, '')
        items.push(`<li style="${liStyle}">${inline(ordered ? content : '•&nbsp;&nbsp;' + content, t)}</li>`)
        i++
      }
      out.push(SECTION(listStyle,
        ordered
          ? `<ol style="margin:0;padding-left:22px;">${items.join('')}</ol>`
          : `<ul style="margin:0;padding-left:0;list-style:none;">${items.join('')}</ul>`
      ))
      continue
    }

    // 分隔线
    if (/^(---+|\*\*\*+)$/.test(line.trim())) {
      flushPara()
      out.push(SECTION(rule(t, 'hr', 'margin:24px 0;border:none;border-top:1px solid #e5e6eb;'), ''))
      i++
      continue
    }

    // 空行 → 段落结束
    if (!line.trim()) {
      flushPara()
      i++
      continue
    }

    paraBuf.push(line.trim())
    i++
  }
  flushPara()

  return `<section style="${bodyStyle(t)}">${out.join('\n')}</section>`
}

/** 主题下拉选项：内置 3 套在前（默认 clean），wewrite 18 套在后 */
export function themeOptions(): Array<{ value: string; label: string; description: string }> {
  const builtin = [
    { value: 'clean', label: 'clean（简洁专业·默认）', description: '项目原版默认主题' },
    { value: 'sspai', label: 'sspai 活力橙（内置）', description: '项目原版主题' },
    { value: 'navy', label: 'navy（沉稳深蓝）', description: '项目原版主题' },
  ]
  const ww = Object.values(WEWRITE_THEMES)
    .filter((t) => t.name !== 'sspai') // 与内置 sspai 撞名，以别名单独暴露
    .map((t) => ({
      value: t.name,
      label: t.name,
      description: t.description,
    }))
  const wewriteSspai = WEWRITE_THEMES['sspai']
    ? [{ value: 'wewrite-sspai', label: 'sspai 少数派（wewrite）', description: WEWRITE_THEMES['sspai'].description }]
    : []
  return [...builtin, ...ww, ...wewriteSspai]
}
