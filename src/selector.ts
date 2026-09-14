/**
 * 自动选题 —— 跨平台去重合并 + 热度归一化打分 + 关键词偏好。
 * hot-topics 中跨平台合并由人工语义判断完成；这里用标题 bigram 相似度（Dice 系数）
 * 自动合并，热度数值按平台内位次归一，多平台同时上榜加权。
 */
import type { TopicRow, TopicGroup, AppSettings } from './types'

// ===== 标题归一化与相似度 =====

const STRIP_RE = /[^\u4e00-\u9fa5a-zA-Z0-9]+/g

export function normTitleKey(title: string): string {
  return title.toLowerCase().replace(STRIP_RE, '')
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

/** 预归一化条目：归一化键与 bigram 只算一次（CPU 关键——合并是 O(n²)，禁止在比较循环里跑正则） */
interface Prepped {
  key: string
  grams: Set<string>
  len: number
}

function prep(title: string): Prepped {
  const key = normTitleKey(title)
  return { key, grams: bigrams(key), len: key.length }
}

function dice(pre: Prepped, other: Prepped): number {
  if (!pre.grams.size || !other.grams.size) return 0
  const [small, big] = pre.grams.size <= other.grams.size ? [pre.grams, other.grams] : [other.grams, pre.grams]
  let inter = 0
  for (const g of small) if (big.has(g)) inter++
  return (2 * inter) / (pre.grams.size + other.grams.size)
}

/** Dice 系数：2|A∩B| / (|A|+|B|)，中文短标题去重常用（单次比较；批量合并走 mergeTopics 预处理） */
export function titleSimilarity(a: string, b: string): number {
  return dice(prep(a), prep(b))
}

// ===== 热度归一化 =====

/** "920.8w" / "10.0万" / 1206561 / "1.2亿" / 位次 → 统一热度分 */
export function parseHotScore(hot: string | number, rank = 0): number {
  if (typeof hot === 'number' && isFinite(hot)) return hot > 0 ? hot : 0
  const s = String(hot ?? '').trim()
  if (!s) return 0
  const m = s.match(/^([\d.,]+)\s*([万亿KkWw]?)$/)
  if (m) {
    const num = parseFloat(m[1].replace(/,/g, ''))
    if (isFinite(num)) {
      const unit = m[2]
      if (unit === '亿') return num * 1e8
      if (unit === '万' || unit === 'w' || unit === 'W') return num * 1e4
      if (unit === 'K' || unit === 'k') return num * 1e3
      return num
    }
  }
  return 0
}

export const SIM_THRESHOLD = 0.55
/** 每条标题最多与多少个已建组做相似度比较（组按热度降序生成，限制了最坏情况 CPU 上限） */
export const MAX_GROUP_SCANS = 120

/**
 * 合并跨平台重复话题 → 选题组。
 * 输入须已按 hot_score 降序（同组保留热度最高的一条为组标题）。
 */
export function mergeTopics(rows: TopicRow[]): TopicGroup[] {
  const sorted = [...rows].sort((a, b) => b.hot_score - a.hot_score)
  const prepped = sorted.map((row) => ({ row, ...prep(row.title) }))
  const reps: Array<Prepped & { row: TopicRow }> = []
  const groups: TopicGroup[] = []
  for (const p of prepped) {
    let bestIdx = -1
    let bestSim = 0
    for (let i = 0; i < Math.min(reps.length, MAX_GROUP_SCANS); i++) {
      const r = reps[i]
      // 快路径：归一化后完全一致；长度差 >1/3 直接剪枝（跳过 bigram 交集）
      if (p.key === r.key) { bestSim = 1; bestIdx = i; break }
      if (Math.abs(p.len - r.len) > Math.max(p.len, r.len) / 3) continue
      const sim = dice(p, r)
      if (sim > bestSim) { bestSim = sim; bestIdx = i }
    }
    if (bestIdx !== -1 && bestSim >= SIM_THRESHOLD) {
      const g = groups[bestIdx]
      const row = p.row
      g.rows.push(row)
      if (!g.platforms.includes(row.platform)) g.platforms.push(row.platform)
      g.score = Math.max(g.score, row.hot_score) + row.hot_score * 0.15
    } else {
      reps.push(p)
      groups.push({
        key: p.row.norm_key || p.key,
        title: p.row.title,
        hotValue: p.row.hot_value,
        score: p.row.hot_score,
        platforms: [p.row.platform],
        urls: p.row.url ? [p.row.url] : [],
        rows: [p.row],
      })
    }
  }
  return groups
}

/** 关键词过滤：include 优先（命中才保留），exclude 剔除 */
function keywordFilter(groups: TopicGroup[], settings: AppSettings): TopicGroup[] {
  const include = settings.include_keywords.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
  const exclude = settings.exclude_keywords.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
  return groups.filter((g) => {
    const hay = g.title
    if (exclude.some((k) => hay.includes(k))) return false
    if (include.length && !include.some((k) => hay.includes(k))) return false
    return true
  })
}

/**
 * 从最新一批热点中选出 TOP N 选题组。
 * 打分：log10(热度 + 1) + 平台数加成（每多一个平台 +0.8）。
 */
export function selectTopicGroups(rows: TopicRow[], settings: AppSettings, topN: number): TopicGroup[] {
  const groups = mergeTopics(rows)
  const scored = groups.map((g) => ({
    ...g,
    score: Math.log10(g.score + 1) + (g.platforms.length - 1) * 0.8,
  }))
  const filtered = keywordFilter(scored, settings)
  filtered.sort((a, b) => b.score - a.score)
  return filtered.slice(0, topN)
}

/** 自动选择体裁：榜单/排名 → list；为什么/如何/影响 → deep；超短突发 → brief；默认 opinion 偏弱、回落 deep */
export function autoGenre(title: string): string {
  if (/(榜|排名|TOP|top\s?\d+|盘点|名单|排行)/i.test(title)) return 'list'
  if (/(为什么|为何|如何|影响|意味着|解读|背后|分析)/.test(title)) return 'deep'
  if (/(发布|上线|开源|获得|融资|成立|逝世|夺冠|break|launch)/i.test(title) && title.length <= 18) return 'brief'
  return 'deep'
}
