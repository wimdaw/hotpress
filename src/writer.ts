/**
 * 内容创作 —— 公众号爆款写作体系（整合全网方法论）：
 *  - 爆款 = 打开率 × 完读率 × 分享率：标题定打开、结构定完读、情绪+增量定分享
 *  - 标题五公式（数字/悬念/对立冲突/身份痛点/热点借势），15-25 字，前 7 字放核心词
 *  - 黄金骨架：开头钩子(150字) → 3 个金句感小标题(各约500字) → 金句升华+互动结尾(200字)
 *  - 标准字数 1800 字左右（1650-1800 含标点），不足自动扩写一轮
 *  - 排版节奏：每段 1-3 句、金句单独成段加粗、## 小标题分块
 *  - 结合 wewrite 契约：标题 ≤64、摘要 ≤120、作者 ≤8；不编造、微信合规
 */
import { chatJson } from './llm'
import { GENRES } from './config'
import type { AppSettings, TopicGroup, ArticleDraft } from './types'

const SYSTEM_BASE = `你是一位资深微信公众号爆款主编，多年 10万+ 爆款操盘经验，精通公众号内容生态与推荐逻辑。
你写稿始终围绕爆款公式：**爆款 = 打开率 × 完读率 × 分享率**——标题决定打开，结构决定完读，"信息增量 + 情绪价值"决定分享。

你必须遵守的红线：
1. 只依据用户提供的素材写作，绝不编造事实、数据、引语；素材没有的细节用"据报道""截至目前"等表述保持严谨。
2. 遵守微信公众号内容规范：不涉政敏感、不低俗、不夸大渲染灾害与悲剧、不做绝对化医疗/投资建议。
3. 标题不做欺骗式标题党（"震惊""惊呆""删前速看"等会被平台限流），用技巧而不是欺诈换取点击。
4. 输出为严格的 JSON 对象（UTF-8），不输出任何 JSON 以外的文字。`

const TITLE_RULES = `【标题规范 —— 决定打开率】
- 长度 15-25 字最佳（硬上限 64 字），核心信息放在前 7 个字。
- 必须包含"吸睛关键词"：热点词 / 身份词 / 数字 / 利益点，让读者一眼判断"与我有关"。
- 从以下五种爆款公式中选择最合适的一种：
  1. 数字型：数字制造具体感与获得感（如「3 个信号，读懂 XXX」）
  2. 悬念型：话说一半藏一半，让人忍不住点开（如「XXX 背后，没人注意到这个细节」）
  3. 对立冲突型：制造反差与观点碰撞（如「月薪 3 千和月薪 3 万的，差的不只是钱」）
  4. 身份痛点型：让目标人群对号入座（如「打工人最担心的事，还是发生了」）
  5. 热点借势型：热点事件 + 独特切入角度（如「XXX 爆火：狂欢之后，谁在买单」）`

const BODY_RULES = `【正文规范 —— 决定完读率与分享率，总字数 1650-1800 字（含标点）】
结构用「黄金骨架」，各部分字数预算严格执行：
1. 开头钩子（约 150 字）：前三行决定读者去留。三选一——
   ▸ 热点场景切入：用具体时间/地点/动作把读者拽进现场
   ▸ 悬念提问：抛出一个读者忍不住想找答案的问题
   ▸ 数据反差：用一组扎心数字制造认知冲击
2. 主体（3 个 ## 小标题，每个约 500 字）：
   ▸ 小标题要有"金句感"或悬念感，能独立激发好奇或共鸣（如「真正值钱的不是技术，是这一点」），不用干巴巴的"背景介绍"式标题
   ▸ 每节 = 观点亮出 + 素材事实 + 延伸分析；节内安排矛盾冲突或转折点——这是完读率的发动机
   ▸ 三节之间要有递进：是什么 → 为什么 → 对我意味着什么
3. 结尾（约 200 字）：
   ▸ 金句升华：一句可以直接被截图转发的金句，**单独成段并加粗**
   ▸ 观点收束：一两句话收住全文
   ▸ 互动引导：提一个开放性问题邀请读者评论（如「你怎么看？评论区聊聊」）

排版节奏（手机阅读体验）：
- 每段 1-3 句，段与段之间空行，拒绝大段文字墙
- 全文 2-4 处关键句用 **加粗** 强调
- 全文 3 个 ## 小标题（不要一级标题 #）
- 语言口语化但有质感，像和聪明的朋友聊天；不用"小编"腔，感叹号全文不超过 3 个

内容内核：每一节都要给读者一个"转发的理由"——要么有用（信息增量），要么有共鸣（情绪价值），要么有态度（观点鲜明）。`

const OUTPUT_SCHEMA = `{
  "title": "爆款标题，15-25 字，前 7 字含核心热点词，套用五公式之一",
  "digest": "摘要 40-120 字，像朋友圈分享语：给利益点或制造悬念，引导点开",
  "markdown": "正文 Markdown，1650-1800 字（含标点）。不要一级标题（#）；用 3 个 ## 小标题分块；每段 1-3 句；金句单独成段加粗；正文中不要出现任何图片占位或配图说明，配图由系统自动插入",
  "image_queries": ["中文配图搜索词1", "搜索词2", "搜索词3"],
  "image_queries_en": ["english query 1", "query 2", "query 3"],
  "tags": ["话题标签1", "标签2"]
}`
const OUTPUT_SCHEMA_NOTE = `image_queries / image_queries_en 要求：严格输出 3 个，两数组一一对应，必须高度贴合文章核心实体与段落内容：
1. 第 1 个词必须是文章最核心的【具体产品/品牌/人物/事件实体词】（如 "iPhone 18 Pro 真机"、"苹果手机 iPhone"、"蔚来 萤火虫 汽车"、"宇树科技 机器人"），用于封面大图；
2. 第 2 个词为文章主体涉及的关键场景或核心人物（如 "库克 苹果发布会"、"手机 专卖店 体验"、"人形机器人 现场演示"）；
3. 第 3 个词为行情、走势、现场细节或相关概念（如 "智能手机 降价 促销"、"科技展会 展台"）。
绝不要输出宽泛无关的"城市夜景"、"办公楼玻璃幕墙"、"生产流水线"等空洞词汇！`

/** 体裁角度（爆款长度下的三种切入方式；字数均按 1800 标准走） */
const GENRE_ANGLES: Record<string, string> = {
  deep: `本文按「深度解读」角度切入：是什么 → 为什么 → 对我意味着什么，重在把事件讲透、给出独到分析，让读者看完有"原来如此"的获得感。`,
  list: `本文按「盘点清单」角度切入：用 3 个 ## 小节做递进式盘点（不是平行罗列），每节聚焦一个点并给足信息量，节奏轻快、条理分明。`,
  opinion: `本文按「观点评论」角度切入：开篇即亮明鲜明立场，主体用事实与逻辑论证，承认对立面合理之处但不和稀泥，读完让认同者想转发、不认同者想反驳。`,
  brief: `本文按「热点快评」角度切入：快速讲清事件 + 一个独到观察 + 一个延伸思考，字数 1100-1400 字，快而不浅。`,
}

function buildUserPrompt(genre: string, group: TopicGroup): string {
  const angle = GENRE_ANGLES[genre] || GENRE_ANGLES.deep
  const lines = group.rows
    .slice(0, 6)
    .map((r, i) => `${i + 1}. [${r.platform_name}] ${r.title}${r.hot_value ? `（热度 ${r.hot_value}）` : ''}`)
    .join('\n')
  const urls = group.urls.slice(0, 3).filter(Boolean)
  return `请基于以下全网热点素材，创作一篇 1800 字左右的微信公众号爆款文章。

【热点话题】${group.title}
【上榜平台】${group.platforms.join('、')}
【各平台相关条目】
${lines}
${urls.length ? `【参考链接】\n${urls.join('\n')}` : ''}

${TITLE_RULES}

${BODY_RULES}

${angle}

输出 JSON 格式：
${OUTPUT_SCHEMA}
${OUTPUT_SCHEMA_NOTE}`
}

export function truncateTitle(t: string): string {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
  return s.length > 64 ? s.slice(0, 63) + '…' : s
}

export function truncateDigest(d: string): string {
  const s = String(d || '').replace(/\s+/g, ' ').trim()
  return s.length > 120 ? s.slice(0, 119) + '…' : s
}

export function truncateAuthor(a: string): string {
  return String(a || '').trim().slice(0, 8)
}

/** 中文字数统计（去 Markdown 符号与空白） */
export function countChineseChars(markdown: string): number {
  const text = String(markdown || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*`\[\]!\-|]/g, '')
    .replace(/\s/g, '')
  return text.length
}

/** 为一个选题组创作文章草稿（爆款标准，含字数不达标自动扩写） */
export async function writeArticle(settings: AppSettings, group: TopicGroup, genre: string): Promise<ArticleDraft & { image_queries_en: string[] }> {
  const messages = [
    { role: 'system' as const, content: SYSTEM_BASE },
    { role: 'user' as const, content: buildUserPrompt(genre, group) },
  ]
  const raw = await chatJson(settings, messages, 8192)

  let markdown = String(raw.markdown || raw.content || '').trim()
  if (!markdown) throw new Error('LLM 未返回正文')
  // 清理 LLM 可能违规输出的一级标题（标题单独存）
  markdown = markdown.replace(/^#\s+.+$/m, (m) => m.replace(/^#\s+/, '## ')).trim()

  // 字数闭环：爆款标准 1700-1900；明显不足（<1500）时带原文扩写重试一次
  let charCount = countChineseChars(markdown)
  const minChars = genre === 'brief' ? 900 : 1500
  if (charCount < minChars) {
    const expand = await chatJson(
      settings,
      [
        ...messages,
        { role: 'assistant', content: JSON.stringify({ title: raw.title, digest: raw.digest, markdown, image_queries: raw.image_queries, image_queries_en: raw.image_queries_en, tags: raw.tags }).slice(0, 6000) },
        {
          role: 'user' as const,
          content: `这篇正文目前只有 ${charCount} 字，未达到公众号爆款标准。请在不改变标题、结构和观点的前提下扩写正文至 ${genre === 'brief' ? '1100-1400' : '1650-1800'} 字：给每个小标题下的分析补充事实细节、数据引用（仅限素材内）、场景化描写或延伸思考，保持每段 1-3 句的节奏。只输出完整 JSON（字段与之前完全一致，markdown 为扩写后的全文）。`,
        },
      ],
      16384
    )
    const expanded = String(expand.markdown || '').trim()
    if (expanded && countChineseChars(expanded) > charCount) {
      markdown = expanded.replace(/^#\s+.+$/m, (m) => m.replace(/^#\s+/, '## ')).trim()
      charCount = countChineseChars(markdown)
    }
  }

  const queries: string[] = Array.isArray(raw.image_queries)
    ? raw.image_queries.map((q: any) => String(q).trim()).filter(Boolean).slice(0, 4)
    : []
  if (!queries.length) queries.push(group.title.slice(0, 24))
  const queriesEn: string[] = Array.isArray(raw.image_queries_en)
    ? raw.image_queries_en.map((q: any) => String(q).trim()).filter(Boolean).slice(0, 4)
    : []

  return {
    title: truncateTitle(raw.title || group.title),
    digest: truncateDigest(raw.digest || ''),
    markdown,
    image_queries: queries,
    image_queries_en: queriesEn,
    author: truncateAuthor(raw.author || ''),
  }
}

export function genreLabel(genre: string): string {
  return GENRES[genre]?.name || genre
}
