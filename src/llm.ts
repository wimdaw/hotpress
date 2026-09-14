/**
 * OpenAI 兼容 LLM 客户端（/chat/completions）。
 * 可指向任意 OpenAI 兼容端点：官方 API、OpenCode Zen、或用户自建的 ai-gateway
 * （baseUrl 填 https://你的网关/v1，apiKey 填转发令牌 sk_cf_*）。
 */
import type { AppSettings } from './types'
import { BROWSER_UA } from './config'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class LlmError extends Error {
  status: number
  constructor(message: string, status = 0) {
    super(message)
    this.status = status
  }
}

function modelList(settings: AppSettings): string[] {
  return (settings.llm_model || '').split(',').map((s) => s.trim()).filter(Boolean)
}

/** 调用 chat/completions；多模型依次回退；content 为空（推理耗尽 token）自动加倍 max_tokens 重试 */
async function chatRaw(settings: AppSettings, messages: ChatMessage[], maxTokens = 8192, temperature?: number): Promise<string> {
  const models = modelList(settings)
  if (!models.length) throw new LlmError('未配置 LLM 模型')
  const base = (settings.llm_base_url || '').replace(/\/+$/, '')
  if (!base) throw new LlmError('未配置 LLM Base URL（后台「设置」中填写）')

  let lastErr: LlmError = new LlmError('LLM 请求失败')
  for (const model of models) {
    let attemptMax = maxTokens
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 150_000)
      try {
        const resp = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': BROWSER_UA,
            ...(settings.llm_api_key ? { Authorization: `Bearer ${settings.llm_api_key}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: temperature ?? (parseFloat(settings.llm_temperature) || 0.7),
            max_tokens: attemptMax,
          }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          const text = await resp.text().catch(() => '')
          throw new LlmError(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`, resp.status)
        }
        const data: any = await resp.json()
        const content = data?.choices?.[0]?.message?.content
        if (typeof content === 'string' && content.trim()) return content
        // content 为空：推理型模型可能耗尽了 token，加倍后重试一次
        attemptMax = Math.min(attemptMax * 2, 16384)
        lastErr = new LlmError('LLM 返回为空（已尝试加倍 max_tokens）')
      } catch (e: any) {
        if (e instanceof LlmError) {
          // HTTP 4xx/网络错误：换下一个模型
          lastErr = e
          break
        }
        if (e?.name === 'AbortError') lastErr = new LlmError('LLM 请求超时（150s）')
        else lastErr = new LlmError(`LLM 请求失败: ${e?.message || e}`)
        break
      } finally {
        clearTimeout(timer)
      }
    }
  }
  throw lastErr
}

/** 从回复中稳健地提取 JSON（剥 ```json 围栏、找第一个平衡的 {}） */
export function extractJson(text: string): any {
  let s = text.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = s.indexOf('{')
  if (start === -1) throw new Error('回复中未找到 JSON')
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return JSON.parse(s.slice(start, i + 1))
    }
  }
  throw new Error('JSON 不完整')
}

/** 请求 LLM 并解析 JSON；解析失败带原始回复重试一次 */
export async function chatJson(
  settings: AppSettings,
  messages: ChatMessage[],
  maxTokens?: number,
  temperature?: number
): Promise<any> {
  const first = await chatRaw(settings, messages, maxTokens, temperature)
  try {
    return extractJson(first)
  } catch {
    const retry = await chatRaw(
      settings,
      [...messages, { role: 'assistant', content: first.slice(0, 2000) }, { role: 'user', content: '上面的输出不是合法 JSON。请只输出一个合法的 JSON 对象，不要任何解释、注释或代码围栏。' }],
      maxTokens,
      temperature
    )
    return extractJson(retry)
  }
}

/** 连通性测试 */
export async function testLlm(settings: AppSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const out = await chatRaw(
      settings,
      [{ role: 'user', content: '请只回复两个字：正常' }],
      2048
    )
    return { ok: true, message: `连通正常，模型回复：${out.trim().slice(0, 40)}` }
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) }
  }
}
