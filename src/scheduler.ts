/**
 * 定时任务调度（Pages 部署的轻量实现）。
 *
 * 原理：Pages Functions 不支持原生 Cron Triggers，采用「请求看门狗」模式——
 * 站点收到任意请求时（节流为每 isolate 每 60 秒最多检查一次），比对
 * settings.next_run_at 与当前时间；到点即以 waitUntil 后台执行流水线，
 * 并把 next_run_at 推进到下一个调度点（Asia/Shanghai 固定 UTC+8）。
 * 用 schedule_running_at 做 30 分钟在途锁，防止并发双跑。
 *
 * 提示：若纯靠自然流量拨针，准点性取决于访问频率；建议配合免费监控
 * （如 UptimeRobot）每 5-10 分钟 ping 一次首页。Workers 部署则可用原生
 * cron triggers；外部定时器也可直接调 POST /api/cron/run（X-CRON-Secret）。
 */
import { getSettings, saveSettings, getEnabledCustomTasks, updateCustomTask } from './storage'
import { fetchAndStoreTopics, runPipeline, pushAllReady } from './pipeline'
import type { Env, CustomTaskRow } from './types'

/** 把 "HH:mm"（北京时间）换算成自 fromMs 之后的下一个执行时刻（UTC ms） */
export function computeNextRun(fromMs: number, hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '08:30')
  const h = m ? Math.min(23, parseInt(m[1], 10)) : 8
  const minute = m ? Math.min(59, parseInt(m[2], 10)) : 30
  const CN_OFFSET = 8 * 3600 * 1000
  const cnNow = new Date(fromMs + CN_OFFSET)
  const cnMidnight = Date.UTC(cnNow.getUTCFullYear(), cnNow.getUTCMonth(), cnNow.getUTCDate())
  let target = cnMidnight + (h * 60 + minute) * 60 * 1000 - CN_OFFSET
  if (target <= fromMs) target += 24 * 3600 * 1000
  return target
}

/** 格式化下一次执行时间（北京时间显示） */
export function formatNextRun(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms + 8 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}（北京）`
}

const IN_FLIGHT_LOCK_MS = 30 * 60 * 1000
const FETCH_LOCK_MS = 10 * 60 * 1000

/** 从多个 "HH:mm"（北京时间）里取自 fromMs 之后的下一个时刻 */
export function computeNextFromTimes(fromMs: number, timesCsv: string): number {
  const times = (timesCsv || '').split(',').map((x) => x.trim()).filter((x) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(x))
  if (!times.length) return 0
  return Math.min(...times.map((t) => computeNextRun(fromMs, t)))
}

/** 抓取看门狗：到点则后台抓取热点（只更新热点池，不写文章） */
async function maybeRunFetch(env: Env): Promise<void> {
  const settings = await getSettings(env)
  if (settings.fetch_enabled !== '1') return
  const next = Number(settings.fetch_next_run_at || 0)
  const now = Date.now()
  if (!next || now < next) return

  const runningSince = Number(settings.fetch_running_at || 0)
  if (runningSince && now - runningSince < FETCH_LOCK_MS) return

  const nextAt = computeNextFromTimes(now, settings.fetch_times)
  await saveSettings(env, { fetch_next_run_at: String(nextAt), fetch_running_at: String(now) })
  try {
    await fetchAndStoreTopics(env, settings, true)
    await saveSettings(env, { last_auto_fetch: new Date().toISOString() })
  } finally {
    await saveSettings(env, { fetch_running_at: '0' })
  }
}

/** 流水线看门狗：到点则后台执行完整流水线 */
async function maybeRunSchedule(env: Env): Promise<void> {
  const settings = await getSettings(env)
  if (settings.schedule_enabled !== '1') return
  const next = Number(settings.next_run_at || 0)
  const now = Date.now()
  if (!next || now < next) return

  // 在途锁：30 分钟内已有调度任务在跑则跳过本轮
  const runningSince = Number((settings as any).schedule_running_at || 0)
  if (runningSince && now - runningSince < IN_FLIGHT_LOCK_MS) return

  // 先推进到下一个调度点（领取任务），再执行
  const nextAt = computeNextRun(now, settings.schedule_time || '08:30')
  await saveSettings(env, { next_run_at: String(nextAt), schedule_running_at: String(now) })
  try {
    await runPipeline(env, 'schedule', { push: settings.schedule_push === '1' })
  } finally {
    await saveSettings(env, { schedule_running_at: '0', last_scheduled_run: new Date().toISOString() })
  }
}

/** 自定义任务：执行单个任务动作 */
export async function runCustomAction(env: Env, task: CustomTaskRow): Promise<string> {
  const settings = await getSettings(env)
  let params: any = {}
  try { params = JSON.parse(task.params || '{}') } catch { params = {} }
  const { createArticle, updateArticle } = await import('./storage')
  const { mdToWechatHtml } = await import('./markdown')

  if (task.action === 'fetch') {
    const r = await fetchAndStoreTopics(env, settings, true)
    return `抓取 ${r.ok} 源 / 入库 ${r.total} 条`
  }
  if (task.action === 'push') {
    const r = await pushAllReady(env, settings, 10)
    return `推送 ${r.ok}/${r.total} 篇` + (r.blocked ? `（${r.blocked} 篇被AI门禁拦截）` : '')
  }
  if (task.action === 'pipeline') {
    const r = await runPipeline(env, 'custom:' + task.name, {
      push: params.push === true,
      maxArticles: typeof params.maxArticles === 'number' ? params.maxArticles : undefined,
    })
    return `选题 ${r.summary.topicsSelected} · 成稿 ${r.summary.articlesCreated} · 推送 ${r.summary.pushed}`
  }
  if (task.action === 'keyword') {
    const kw = String(params.keyword || '').trim()
    if (!kw) return '未配置关键词，跳过'
    const { keywordWrite } = await import('./keyword')
    const r = await keywordWrite(env, settings, {
      keyword: kw,
      style: params.style || undefined,
      customStyle: params.customStyle || undefined,
    })
    const id = crypto.randomUUID().slice(0, 8) + Date.now().toString(36)
    const cover = r.images.length ? r.images[0].url : r.coverUrl
    const coverSource = r.images.length ? r.images[0].source : r.coverSource
    await createArticle(env, {
      id, topicKey: 'custom-keyword', title: r.title, digest: r.digest,
      author: settings.wx_author || '', genre: 'deep', theme: settings.theme || 'professional-clean',
      markdown: r.markdown, html: r.html, coverUrl: cover, coverSource: coverSource,
      images: r.images, status: 'ready', origin: 'custom-keyword',
    })
    await updateArticle(env, id, { ai_score: r.aiScore, humanize_rounds: r.rounds })
    return `成稿《${r.title.slice(0, 20)}》AI痕 ${r.aiScore ?? '—'} 分`
  }
  return `未知动作 ${task.action}`
}

/** 自定义任务看门狗：扫描启用的任务，到点执行 */
export async function maybeRunCustomTasks(env: Env): Promise<void> {
  const { getEnabledCustomTasks } = await import('./storage')
  const tasks = await getEnabledCustomTasks(env)
  const now = Date.now()
  for (const task of tasks) {
    const next = Number(task.next_run_at || 0)
    // next=0（刚启用）视为到点，立即进入执行循环
    if (next && now < next) continue
    if (task.running_at && now - task.running_at < 15 * 60 * 1000) continue

    const { computeNextFromTimes } = await import('./scheduler')
    const nextAt = computeNextFromTimes(now, task.times)
    await updateCustomTask(env, {
      id: task.id, name: task.name, enabled: true, times: task.times,
      action: task.action, params: task.params, next_run_at: nextAt,
      created_at: task.created_at, running_at: now,
    })
    try {
      const result = await runCustomAction(env, task)
      await updateCustomTask(env, {
        id: task.id, name: task.name, enabled: true, times: task.times,
        action: task.action, params: task.params, running_at: 0,
        created_at: task.created_at, last_run: new Date().toISOString(), last_result: result,
      })
    } catch (e: any) {
      await updateCustomTask(env, {
        id: task.id, name: task.name, enabled: true, times: task.times,
        action: task.action, params: task.params, running_at: 0,
        created_at: task.created_at, last_run: new Date().toISOString(),
        last_result: '失败: ' + String(e?.message || e).slice(0, 120),
      })
    }
  }
}

/** 统一看门狗入口：流水线定时 + 抓取定时 + 自定义任务（中间件每 isolate 每 60 秒调用一次） */
export async function tickSchedules(env: Env): Promise<void> {
  await maybeRunSchedule(env)
  await maybeRunFetch(env)
  try { await maybeRunCustomTasks(env) } catch (e) { console.error('custom tasks:', e) }
}
