/**
 * 去 AI 化核验（Humanize & Verify）—— 创作完成后、推送前的强制质检。
 *
 * 双信号评分（0-100，越高 AI 痕迹越重）：
 *   1. 本地统计检测（确定性，可复现）：句长突发度 burstiness（检测器经典信号）、
 *      AI 套话密度、段落等长度、高频连接词
 *   2. LLM 检测官（语义级）：模拟 AIGC 检测器判定逻辑，逐条给出痕迹信号与例句
 *   最终分 = 0.55 × LLM 分 + 0.45 × 本地分（LLM 失败时退化为纯本地分）
 *
 * 核验闭环：超标 → 带检测信号定向改写 → 复检，最多 maxRounds 轮，取最低分版本。
 * 改写只动表达不动事实（数据、引语、小标题结构、字数预算保持不变）。
 *
 * 方法论来源：GPTZero 困惑度/突发度原理、AIGC 检测综述（句长分布/词频特征）、
 * 去 AI 化实操指南（长短句交错/去套话/允许不完美）。
 */
import { chatJson } from './llm'
import { countChineseChars } from './writer'
import type { AppSettings } from './types'

/** AI 高频套话黑名单（命中即扣分） */
const CLICHE_PATTERNS: string[] = [
  '首先', '其次', '再次', '最后', '总而言之', '综上所述', '值得注意的是', '值得一提',
  '不得不说', '众所周知', '毋庸置疑', '在这个', '的时代', '不禁让人', '引发广泛',
  '广泛讨论', '广泛关注', '深度赋能', '闭环', '抓手', '颗粒度', '淋漓尽致',
  '由此可见', '与此同时', '毫无疑问', '可以说', '某种程度上', '划重点', '总结一下',
  '归根结底', '一言以蔽之', '不可否认', '众所周知', '赋能', '护城河',
]

/** 检测官提示词（语义级 AIGC 检测） */
const SCAN_SYSTEM = `你是一名 AIGC 检测专家，负责判定文章的 AI 生成痕迹。你熟悉主流检测器（知网 AIGC、GPTZero、维普等）的判定逻辑，从以下维度审查：
1. 句长节奏：句子长度是否异常均匀（像节拍器），缺少长短句交错
2. 模板化结构：小节是否都是等长的"观点+例子+总结"三件套，排比是否过度工整
3. AI 套话：首先/其次/总而言之/值得注意的是/综上所述/引发广泛关注/在这个…的时代 等高频连接词与空话
4. 空洞总结：节尾是否有"这说明…""可见…"式的机械总结句
5. 词汇分布：是否堆叠四字大词、书面语过密、缺少口语颗粒
6. 情感温度：是否全程旁观者口吻、没有立场波动和真实情绪
7. 细节具体度：是否缺少具体的场景、数字、感官细节（泛泛而谈是重信号）

评分标准（ai_score 0-100，越高 AI 痕迹越重）：
- 0-35：自然，有人的呼吸感，检测器大概率判人写
- 36-60：有可感知的 AI 痕迹，混合状态
- 61-100：明显 AI 腔，检测器大概率标红
评分要严格：宁可错杀，不可放过；但对事实密度高、节奏自然的文章不要误伤。
只输出 JSON：{"ai_score": 数字, "signals": [{"type": "uniform_rhythm|cliche|template|empty_summary|wordiness|no_emotion|vague", "quote": "原文例句（≤40字）", "reason": "判定理由（≤30字）"}], "note": "一句话总评"}`

/** 去 AI 化改写提示词 */
function rewritePrompt(markdown: string, signals: string[], targetRange: string): string {
  return `请对以下公众号文章做「去 AI 化」改写——只改表达，不改事实。

【铁律】
1. 事实零改动：所有事件、数据、人名、引语、因果关系保持原样，绝不新增或删除事实
2. 结构保留：## 小标题数量与顺序不变（小标题文字可改得更像人话）；金句加粗保留 2-4 处
3. 字数保持：改写后 ${targetRange} 字（含标点），与原文相当
4. 全程中文标点，每段 1-3 句

【改写手法（按检测信号针对性处理）】
1. 打破节拍器：主动制造长短句交错——把连续等长的句子拆成一个短句（三五字也行）或合并成复句；允许独词句、破折号、括号补语
2. 清除套话：删除/替换所有"首先其次最后、总而言之、值得注意的是、与此同时、引发广泛关注、在这个…的时代"式连接词，改用语义自然过渡
3. 拆掉模板：小节之间长短错落，不要每节都是"观点+例子+总结"三件套；删掉节尾机械总结句，让事实自己说话
4. 词汇降维：四字大词换日常口语词（"显著提升"→"肉眼可见地涨了"；"亟需解决"→"等不起"）
5. 注入人味：加入少量口语插入语（"说白了""讲真""有意思的是"，全文不超过 3 处）、一两处自问自答；观点句带立场波动
6. 金句重写：加粗金句要像人脱口而出的话，不要对仗工整的标语

${signals.length ? `【上一轮检测出的痕迹（必须逐条消除）】\n${signals.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : ''}

【原文】
${markdown}

只输出 JSON：{"markdown": "改写后全文", "note": "一句话说明主要改了什么"}`
}

// ===== 本地统计检测（确定性） =====

export interface LocalStats {
  sentences: number
  burstiness: number
  clicheHits: number
  clicheDensity: number
  paraCv: number
  score: number
  reasons: string[]
}

function stdev(nums: number[]): number {
  if (nums.length < 2) return 0
  const m = nums.reduce((a, b) => a + b, 0) / nums.length
  return Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length)
}

export function localAiStats(markdown: string): LocalStats {
  const plain = markdown.replace(/```[\s\S]*?```/g, '').replace(/\s/g, '')
  const text = plain.replace(/[#>*`[\]!|]/g, '')
  const charCount = text.length

  // 句长突发度（burstiness）：人写通常 0.4-0.9，AI 偏低
  const lens = text.split(/[。！？!?…；;]+/).map((s) => s.replace(/["」』"』]/g, '').length).filter((n) => n >= 2)
  const meanLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0
  const burstiness = meanLen > 0 ? stdev(lens) / meanLen : 0

  // 套话密度（次/千字）
  let clicheHits = 0
  for (const p of CLICHE_PATTERNS) {
    let idx = text.indexOf(p)
    while (idx !== -1) {
      clicheHits++
      idx = text.indexOf(p, idx + p.length)
    }
  }
  const clicheDensity = charCount > 0 ? (clicheHits * 1000) / charCount : 0

  // 段落长度变异系数（AI 段落等长）
  const paras = markdown.split(/\n{2,}/).map((p) => p.replace(/[#>*`[\]\s]|!\[[^\]]*\]\([^)]*\)/g, '').length).filter((n) => n >= 20)
  const paraMean = paras.length ? paras.reduce((a, b) => a + b, 0) / paras.length : 0
  const paraCv = paraMean > 0 ? stdev(paras) / paraMean : 0

  // 评分
  let score = 8
  const reasons: string[] = []
  if (lens.length >= 8) {
    if (burstiness < 0.25) { score += 32; reasons.push(`句长突发度仅 ${burstiness.toFixed(2)}（<0.25，节拍器式均匀）`) }
    else if (burstiness < 0.35) { score += 22; reasons.push(`句长突发度 ${burstiness.toFixed(2)} 偏低`) }
    else if (burstiness < 0.45) { score += 10; reasons.push(`句长突发度 ${burstiness.toFixed(2)} 略低`) }
    else reasons.push(`句长突发度 ${burstiness.toFixed(2)}（自然区间）`)
  }
  if (clicheDensity > 3) { score += 26; reasons.push(`套话密度 ${clicheDensity.toFixed(1)}/千字（>3）`) }
  else if (clicheDensity > 1.5) { score += 15; reasons.push(`套话密度 ${clicheDensity.toFixed(1)}/千字 偏高`) }
  else if (clicheDensity > 0.5) { score += 7; reasons.push(`套话密度 ${clicheDensity.toFixed(1)}/千字 略高`) }
  if (paras.length >= 6) {
    if (paraCv < 0.3) { score += 16; reasons.push(`段落长度过于均匀（CV ${paraCv.toFixed(2)}）`) }
    else if (paraCv < 0.45) { score += 8; reasons.push(`段落长度均匀度偏高（CV ${paraCv.toFixed(2)}）`) }
  }
  return {
    sentences: lens.length,
    burstiness: Math.round(burstiness * 100) / 100,
    clicheHits,
    clicheDensity: Math.round(clicheDensity * 10) / 10,
    paraCv: Math.round(paraCv * 100) / 100,
    score: Math.min(100, score),
    reasons,
  }
}

// ===== LLM 检测官 =====

export interface AiSignal {
  type: string
  quote: string
  reason: string
}

export interface ScanResult {
  llmScore: number | null
  localScore: number
  aiScore: number
  signals: AiSignal[]
  local: LocalStats
  note: string
}

/** 综合评分：0.55 × LLM + 0.45 × 本地（LLM 失败退化为纯本地） */
export async function aiScan(settings: AppSettings, markdown: string): Promise<ScanResult> {
  const local = localAiStats(markdown)
  let llmScore: number | null = null
  let signals: AiSignal[] = []
  let note = ''
  try {
    const raw = await chatJson(
      settings,
      [
        { role: 'system', content: SCAN_SYSTEM },
        { role: 'user', content: `请检测以下文章的 AI 生成痕迹（全文约 ${countChineseChars(markdown)} 字）：\n\n${markdown.slice(0, 9000)}` },
      ],
      4096,
      0.2
    )
    const s = Number(raw.ai_score)
    if (isFinite(s)) llmScore = Math.max(0, Math.min(100, s))
    if (Array.isArray(raw.signals)) {
      signals = raw.signals.slice(0, 8).map((x: any) => ({
        type: String(x.type || 'other'),
        quote: String(x.quote || '').slice(0, 60),
        reason: String(x.reason || '').slice(0, 60),
      }))
    }
    note = String(raw.note || '').slice(0, 120)
  } catch {
    note = 'LLM 检测官不可用，采用本地统计分'
  }
  const aiScore = llmScore !== null ? Math.round(llmScore * 0.55 + local.score * 0.45) : local.score
  return { llmScore, localScore: local.score, aiScore, signals, local, note }
}

// ===== 核验闭环 =====

export interface HumanizeResult {
  markdown: string
  aiScore: number
  initialScore: number
  signals: AiSignal[]
  rounds: number
  log: string[]
}

function targetRange(genre: string): string {
  return genre === 'brief' ? '1100-1400' : '1600-1800'
}

/**
 * 去 AI 化核验闭环：扫描 → 超标则定向改写 → 复检，取最低分版本。
 * settings.humanize_enabled 关闭时只扫描一轮（仍给出 ai_score 供参考）。
 */
export async function humanizeAndVerify(settings: AppSettings, markdown: string, genre: string): Promise<HumanizeResult> {
  const log: string[] = []
  const threshold = Math.max(10, Math.min(parseInt(settings.humanize_threshold || '40', 10), 90))
  const maxRounds = Math.max(1, Math.min(parseInt(settings.humanize_max_rounds || '3', 10), 5))

  let current = markdown
  let scan = await aiScan(settings, current)
  const initialScore = scan.aiScore
  log.push(`🤖 AI 痕迹初检 ${scan.aiScore} 分（LLM ${scan.llmScore ?? '—'} / 本地 ${scan.localScore}，突发度 ${scan.local.burstiness}，套话 ${scan.local.clicheHits} 处）`)
  if (scan.signals.length) log.push(`   痕迹：${scan.signals.slice(0, 3).map((s) => `${s.type}「${s.quote.slice(0, 18)}」`).join('；')}`)

  let best = { markdown: current, score: scan.aiScore, signals: scan.signals }
  let rounds = 0
  while (best.score > threshold && rounds < maxRounds) {
    rounds++
    try {
      const raw = await chatJson(
        settings,
        [
          { role: 'system', content: '你是资深人类作家与公众号主编，擅长打破AI腔调，语言有真实呼吸感、长短句错落、情感鲜明。只输出 JSON。' },
          { role: 'user', content: rewritePrompt(best.markdown, best.signals.map((s) => `${s.type}:${s.reason}（例：${s.quote}）`), targetRange(genre)) },
        ],
        8192,
        0.9
      )
      const rewritten = String(raw.markdown || '').trim()
      if (!rewritten || countChineseChars(rewritten) < countChineseChars(current) * 0.7) {
        log.push(`✏️ 第 ${rounds} 轮改写结果异常（字数骤减），跳过本轮`)
        continue
      }
      const rescan = await aiScan(settings, rewritten)
      log.push(`✏️ 第 ${rounds} 轮去AI化改写后复检 ${rescan.aiScore} 分（上轮 ${best.score}）`)
      if (rescan.aiScore < best.score) {
        best = { markdown: rewritten, score: rescan.aiScore, signals: rescan.signals }
      }
      current = rewritten
      if (best.score <= threshold) { log.push(`✅ 已达发布标准（${best.score} 分 ≤ 阈值 ${threshold}）`); break }
    } catch (e: any) {
      log.push(`✏️ 第 ${rounds} 轮改写失败: ${e?.message || e}`)
      break
    }
  }

  return {
    markdown: best.markdown,
    aiScore: best.score,
    initialScore,
    signals: best.signals,
    rounds,
    log,
  }
}
