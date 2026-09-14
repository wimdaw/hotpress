/**
 * Agnes AI 文生图（OpenAI 兼容 images/generations 接口）。
 * 文档：https://wiki.agnes-ai.com — POST {base}/images/generations
 * 默认端点 https://apihub.agnes-ai.com/v1，模型 agnes-image-2.1-flash，Bearer 鉴权。
 * 返回 data[0].url 或 data[0].b64_json。
 */
import type { AppSettings } from './types'
import { BROWSER_UA } from './config'

const GEN_TIMEOUT_MS = 90_000

export class AgnesError extends Error {}

/** 生成图片，返回可用的图片 URL 或 data URI；失败抛 AgnesError */
export async function agnesGenerate(settings: AppSettings, prompt: string, size = '1024x1024'): Promise<string> {
  const base = (settings.agnes_base_url || '').replace(/\/+$/, '')
  if (!base) throw new AgnesError('未配置 Agnes Base URL')
  if (!settings.agnes_api_key) throw new AgnesError('未配置 Agnes API Key（后台「设置」中填写）')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), GEN_TIMEOUT_MS)
  try {
    const resp = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
        Authorization: `Bearer ${settings.agnes_api_key}`,
      },
      body: JSON.stringify({
        model: settings.agnes_model || 'agnes-image-2.1-flash',
        prompt,
        n: 1,
        size,
      }),
      signal: ctrl.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new AgnesError(`Agnes HTTP ${resp.status}: ${text.slice(0, 300)}`)
    }
    const data: any = await resp.json()
    const first = data?.data?.[0]
    if (first?.url) return String(first.url)
    if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`
    throw new AgnesError('Agnes 返回中无图片数据')
  } catch (e: any) {
    if (e instanceof AgnesError) throw e
    if (e?.name === 'AbortError') throw new AgnesError('Agnes 生成超时（90s）')
    throw new AgnesError(`Agnes 请求失败: ${e?.message || e}`)
  } finally {
    clearTimeout(timer)
  }
}

/** 新闻配图统一风格提示词：明确要求无文字无水印 */
export function agnesNewsPrompt(topic: string, style = '新闻纪实插画'): string {
  return `${style}，主题：${topic}。现代简约的新闻配图，构图干净、色调专业，画面中不出现任何文字、字母、数字、水印、logo，不出现真实人物面部特写，高清细节。`
}

/** 连通性测试 */
export async function testAgnes(settings: AppSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const url = await agnesGenerate(settings, agnesNewsPrompt('城市清晨 光线 明亮 简约', '扁平插画'), '512x512')
    return { ok: true, message: `生成成功：${url.slice(0, 80)}` }
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) }
  }
}
