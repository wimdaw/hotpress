/**
 * wx-draft-worker 推送客户端 —— 对接已上线的微信草稿网关（默认 https://wx.seurl.eu.org）。
 * 契约与 wewrite-draft-gateway 完全一致：
 *  - POST /api/draft，X-API-Key: wxk_*（或 Bearer），响应 {ok, data|error}
 *  - 必须 User-Agent 浏览器 UA，否则 Cloudflare Bot 检测拦截（错误码 1010）
 *  - 微信错误码中文映射；失败最多重试 1 次（wewrite-publish skill 的边界规则）
 */
import { BROWSER_UA } from './config'
import type { AppSettings, WxPushResult } from './types'

const ERROR_HINTS: Record<string, string> = {
  '40164': '公众号 IP 白名单未包含 Cloudflare 出口 IP（到公众平台后台加入）',
  '40001': 'AppSecret 无效或已重置（到网关后台更新账号凭据）',
  '40013': 'AppID 无效',
  '45009': '接口调用次数超限，请稍后再试',
  '53500': '该公众号无草稿接口权限（未认证订阅号不可用 draft/add）',
  '48001': '公众号接口未授权',
  '1010': 'Cloudflare Bot 拦截：请确认客户端使用浏览器 User-Agent',
}

function hintError(errText: string): string {
  const m = errText.match(/\[(\d{5})\]/)
  if (m && ERROR_HINTS[m[1]]) return `${errText} —— ${ERROR_HINTS[m[1]]}`
  if (/尚未添加公众号/.test(errText)) return `${errText}（到网关后台「账号管理」添加公众号）`
  if (/无法生成封面/.test(errText)) return `${errText}（系统会自动保底生成渐变封面，若仍失败请检查图片格式）`
  return errText
}

function normalizeBase(url: string): string {
  return (url || '').replace(/\/+$/, '')
}

async function postJson(url: string, body: any, token: string, timeoutMs = 120_000): Promise<{ status: number; json: any }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
        'X-API-Key': token,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const json = await resp.json().catch(() => ({ ok: false, error: `响应解析失败（HTTP ${resp.status}）` }))
    return { status: resp.status, json }
  } finally {
    clearTimeout(timer)
  }
}

export interface DraftPayload {
  title: string
  content: string
  contentType: 'html' | 'markdown'
  cover?: string
  digest?: string
  author?: string
  accountId?: string
  contentSourceUrl?: string
  needOpenComment?: 0 | 1
  onlyFansCanComment?: 0 | 1
}

/** 推送草稿；5xx / 网络错误自动重试 1 次 */
export async function pushDraft(settings: AppSettings, payload: DraftPayload): Promise<WxPushResult> {
  const base = normalizeBase(settings.wx_gateway_url)
  const token = settings.wx_api_token
  if (!base) return { ok: false, error: '未配置微信网关地址（后台「设置」中填写 wx-draft-worker 地址）' }
  if (!token) return { ok: false, error: '未配置微信网关令牌（wx-draft-worker 后台「令牌管理」创建的 wxk_*）' }

  const url = `${base}/api/draft`
  let last: { status: number; json: any } | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      last = await postJson(url, payload, token)
      if (last.json?.ok) {
        return { ok: true, media_id: last.json.data?.media_id, data: last.json.data }
      }
      // 4xx 参数/鉴权错误不重试
      if (last.status < 500) break
    } catch (e: any) {
      last = { status: 0, json: { ok: false, error: `请求网关失败: ${e?.message || e}` } }
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000))
  }
  const errText = last?.json?.error || `网关返回异常（HTTP ${last?.status}）`
  return { ok: false, error: hintError(errText) }
}

/** 网关健康检查 */
export async function gatewayHealth(settings: AppSettings): Promise<{ ok: boolean; message: string }> {
  const base = normalizeBase(settings.wx_gateway_url)
  if (!base) return { ok: false, message: '未配置网关地址' }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    const resp = await fetch(`${base}/api/health`, { headers: { 'User-Agent': BROWSER_UA } })
    clearTimeout(timer)
    const data: any = await resp.json().catch(() => null)
    if (data?.ok) {
      const d = data.data || {}
      const parts = [
        d.appid_configured ? 'appid ✅' : 'appid ❌',
        d.secret_configured ? 'secret ✅' : 'secret ❌',
        d.auth_enabled ? '鉴权开启' : '鉴权关闭',
        d.db_connected ? 'D1 ✅' : 'D1 ❌',
      ]
      return { ok: true, message: `网关 v${d.version || '?'}：${parts.join(' · ')}` }
    }
    return { ok: false, message: `网关响应异常（HTTP ${resp.status}）` }
  } catch (e: any) {
    return { ok: false, message: `网关不可达: ${e?.message || e}` }
  }
}

/** 真实推送测试（用极小测试文章验证令牌/权限/封面链路） */
export async function testPush(settings: AppSettings): Promise<{ ok: boolean; message: string }> {
  const result = await pushDraft(settings, {
    title: 'HotPress 连通性测试',
    content: '<section style="font-size:15px;color:#3f3f3f;"><p>这是一条 HotPress → wx-draft-worker 链路测试草稿，可直接删除。</p></section>',
    contentType: 'html',
    digest: 'HotPress 推送链路测试，可直接删除。',
    author: truncateTestAuthor(settings.wx_author),
  })
  if (result.ok) return { ok: true, message: `推送成功，media_id: ${result.media_id}（请到公众号后台删除该测试草稿）` }
  return { ok: false, message: result.error || '推送失败' }
}

function truncateTestAuthor(a: string): string {
  return (a || 'HotPress').slice(0, 8)
}
