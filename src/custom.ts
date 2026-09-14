/**
 * 自定义写作 —— 文章仿写 / 二次创作 / 文章润色。
 *
 * 方法论（整合全网写作风格 skills）：
 *  - 仿写 ≠ 洗稿：先拆解原文的「文风档案」（结构/句式/节奏/词汇/修辞），再以同风格写全新内容
 *  - 二次创作：换角度、换立场、重构结构，观点不趋同、表述不重复、补充增量信息
 *  - 润色：语言风格转换专家——去 AI 味、句式节奏、细节具体化，内容与结构不动
 * 产出走与热点流水线相同的「去AI化核验」闭环，达标后才入库。
 */
import { chatJson } from './llm'
import { humanizeAndVerify, aiScan } from './humanize'
import { truncateTitle, truncateDigest, countChineseChars } from './writer'
import type { AppSettings } from './types'

export type WriteMode = 'imitate' | 'rewrite' | 'polish'

/** 文风预设（可叠加在模式之上；custom 时用用户自定义描述） */
export const STYLE_PRESETS: Record<string, { label: string; directive: string }> = {
  auto: { label: '跟随原文（仿写/二创）· 默认爆款风（润色）', directive: '' },
  sharp: {
    label: '锐评说书体',
    directive: '语言像说书人：短句砸重点、口语化转场（"你猜怎么着""说白了"）、观点泼辣但讲逻辑，敢下判断。',
  },
  depth: {
    label: '深度调查体',
    directive: '冷静克制、信息密度高：时间线+数据+多方信源交叉，句子偏长但节奏分明，判断留有余地（"至少目前看"）。',
  },
  portrait: {
    label: '人物特写体',
    directive: '以场景与细节带人：动作、神态、直接引语开头，由小切口进入大话题，情绪克制而共情。',
  },
  scholar: {
    label: '理性学者体',
    directive: '概念清晰、论证分层，爱用"第一性""机制"类框架，引用与数据严谨，语气客观不煽情。',
  },
  humor: {
    label: '轻松段子体',
    directive: '谐音梗、反差、自嘲混着来，段子密度高但不脱离主线，结尾收一个会心一笑的洞察。',
  },
  xhs: {
    label: '小红书体',
    directive: '短段+emoji 适度、口语亲切（"姐妹们""真的绝了"）、分点清晰、结尾带互动话题标签。',
  },
}

const FACT_RULES = `【铁律】原文中的事实、数据、人名、时间、因果关系是唯一事实源：可以重新选择角度与结构，但不得编造、歪曲或遗漏关键事实。`

/** 仿写：拆原文文风档案 → 同风格写新内容 */
function imitatePrompt(originalText: string, newTopic: string, styleDirective: string): string {
  return `请完成一次「文章仿写」任务。

第一步：通读原文，输出前先在心里建立它的【文风档案】——
· 结构布局（开头方式、小节如何推进、结尾如何收束）
· 句式节奏（长短句比例、常用句型、段落长度）
· 词汇偏好（高频词、语气词、修辞手法：比喻/排比/设问…）
· 叙述视角与情绪温度

第二步：以**完全相同的文风**写一篇全新文章。
· ${newTopic ? `新主题：${newTopic}（原文仅提供风格参考，内容必须围绕新主题展开，不得搬运原文的事实与表述）` : `主题：允许在原文话题域内换一个全新角度（角度不得与原文相同）`}
· 仿写的是"风格与结构"，不是内容——逐句对照原文是不可接受的

第三步：写完自查一遍：把你的成稿与原文逐段对比，句式节奏与语气是否像同一个作者写的？内容是否零重复？

${styleDirective ? `【文风要求】\n${styleDirective}\n` : ''}
【原文】
${originalText.slice(0, 12000)}

输出 JSON：{"title": "标题（爆款风格，15-25字）", "digest": "摘要40-120字", "markdown": "全文（不要一级标题，## 分节，1700字左右）"}`
}

/** 二次创作：换角度重构，避免同质化 */
function rewritePrompt(originalText: string, angle: string, styleDirective: string): string {
  return `请对以下文章做「二次创作」——同一事实域，全新的一篇文章。

【二创规则】
1. 角度必须换：原文如果从 A 视角讲，你从 B 视角讲（当事人→行业观察、事件→机制分析、叙事→观点…）
2. 结构必须换：重排信息顺序，换一种骨架（时间线→专题式、总分→递进…）
3. 表述必须换：连续 8 字与原文相同即为失败；所有句子重写
4. 增量必须有：在原文事实基础上，补充原文没展开的影响分析、背景脉络或反向观点（不得编造新事实）
5. 立场可以更鲜明：给出原文没有给出的判断
${angle ? `6. 指定切入角度：${angle}` : ''}
${styleDirective ? `【文风要求】\n${styleDirective}\n` : ''}
${FACT_RULES}

【原文】
${originalText.slice(0, 12000)}

输出 JSON：{"title": "新标题（与原文标题显著不同，15-25字）", "digest": "摘要40-120字", "markdown": "全文（## 分节，1700字左右）"}`
}

/** 润色：语言风格转换，内容结构不动 */
function polishPrompt(originalText: string, styleDirective: string): string {
  return `你是语言风格转换专家。请润色以下文章——只改表达质量，不改内容。

【润色规则】
1. 内容零增删：所有事实、观点、数据、段落顺序保持不变（错别字与语病可修）
2. 去 AI 味：清除"首先其次总而言之值得注意的是"式套话；句式太正的改活；排比过密打散
3. 节奏改造：长短句交错，段落 1-3 句；连续等长句拆开或合并
4. 细节具体化：把"很多""非常""一定程度上"等虚词替换为可感知的表达（不得虚构数据）
5. 词汇降维：书面大词换日常词；删除冗余形容词
6. 保持原有分节结构与篇幅（±10%以内）
${styleDirective ? `【额外风格要求】\n${styleDirective}\n` : ''}

【原文】
${originalText.slice(0, 12000)}

输出 JSON：{"markdown": "润色后全文（保持原有小标题结构）", "note": "一段话说明主要改了什么"}`
}

/** 单次生成（不带核验闭环） */
async function generateOnce(
  settings: AppSettings,
  prompt: string,
  system: string,
  maxTokens: number
): Promise<{ title: string; digest: string; markdown: string; note: string }> {
  const raw = await chatJson(settings, [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ], maxTokens, 0.8)
  const markdown = String(raw.markdown || '').trim()
  if (!markdown) throw new Error('LLM 未返回正文')
  return {
    title: truncateTitle(raw.title || ''),
    digest: truncateDigest(raw.digest || ''),
    markdown,
    note: String(raw.note || '').slice(0, 120),
  }
}

/** 来源信息（微信文章解析等） */
interface SourceInfo {
  source?: string
  author?: string
}

/** 来源前缀：让 LLM 知道原文的平台与作者（公众号文章二创时风格匹配更准） */
function sourcePreamble(info?: SourceInfo): string {
  if (!info?.source) return ''
  if (info.source === 'wechat') {
    return `【原文来源】微信公众号${info.author ? `《${info.author}》` : ''}——注意感知公众号爆文的排版节奏与传播写法。\n`
  }
  return `【原文来源】网页文章。\n`
}

export interface CustomWriteResult {
  id: string
  title: string
  digest: string
  markdown: string
  mode: WriteMode
  aiScore: number | null
  initialScore: number | null
  rounds: number
  log: string[]
}

/** 自定义写作主入口：生成 →（仿写/二创）去AI化核验 → 返回草稿数据 */
export async function customWrite(
  settings: AppSettings,
  opts: { mode: WriteMode; text: string; newTopic?: string; angle?: string; style?: string; customStyle?: string; title?: string; sourceInfo?: SourceInfo }
): Promise<CustomWriteResult> {
  const log: string[] = []
  const preset = STYLE_PRESETS[opts.style || 'auto']
  let styleDirective = opts.customStyle?.trim() || preset?.directive || ''
  const system = '你是一位资深微信公众号主编，文字老练、有呼吸感。只输出 JSON。遵守微信公众号内容规范，不编造事实。'

  const preamble = sourcePreamble(opts.sourceInfo)
  let gen: { title: string; digest: string; markdown: string; note: string }
  if (opts.mode === 'polish') {
    gen = await generateOnce(settings, preamble + polishPrompt(opts.text, styleDirective), system, 8192)
    log.push('🪄 润色完成')
  } else if (opts.mode === 'imitate') {
    gen = await generateOnce(settings, preamble + imitatePrompt(opts.text, opts.newTopic || '', styleDirective), system, 8192)
    log.push('🪄 仿写完成（文风取自原文，内容为新主题）')
  } else {
    gen = await generateOnce(settings, preamble + rewritePrompt(opts.text, opts.angle || '', styleDirective), system, 8192)
    log.push('🪄 二次创作完成（换角度重构，表述去重）')
  }
  if (gen.note) log.push(`   LLM: ${gen.note}`)

  let markdown = gen.markdown
  let aiScore: number | null = null
  let initialScore: number | null = null
  let rounds = 0

  // 仿写/二创：走完整去AI化核验闭环；润色：只检测评分（润色本身就是去AI味处理）
  if (opts.mode === 'polish') {
    const scan = await aiScan(settings, markdown)
    aiScore = scan.aiScore
    log.push(`🛡️ AI 痕迹检测 ${scan.aiScore} 分（突发度 ${scan.local.burstiness}）`)
  } else if (settings.humanize_enabled === '1') {
    const hm = await humanizeAndVerify(settings, markdown, 'deep')
    markdown = hm.markdown
    aiScore = hm.aiScore
    initialScore = hm.initialScore
    rounds = hm.rounds
    log.push(...hm.log)
  } else {
    const scan = await aiScan(settings, markdown)
    aiScore = scan.aiScore
  }

  // 润色模式 LLM 不产标题：优先取原文标题（「标题：xxx」行或首行），再回落
  let fallbackTitle = opts.title || ''
  if (!fallbackTitle) {
    if (opts.mode === 'polish') {
      const m = opts.text.match(/^标题[:：]\s*(.+)$/m)
      fallbackTitle = m ? m[1].trim() : (opts.text.split('\n')[0] || '').slice(0, 30)
      if (fallbackTitle && !/^[\u4e00-\u9fa5A-Za-z0-9]/.test(fallbackTitle) === false) fallbackTitle = fallbackTitle
    } else {
      fallbackTitle = opts.mode === 'imitate' ? '仿写稿' : '二创稿'
    }
  }
  return {
    id: '',
    title: gen.title || fallbackTitle,
    digest: gen.digest,
    markdown,
    mode: opts.mode,
    aiScore,
    initialScore,
    rounds,
    log,
  }
}

export { countChineseChars }
