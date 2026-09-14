import { Context, Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createSession, getSession, deleteSession, getAdminCredentials, setAdminCredentials } from './storage'
import { SESSION_TTL } from './config'
import type { Env } from './types'

/** SHA-256 哈希 */
export async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 管理后台 Session 验证中间件 */
export async function adminAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, 'session_id')
  const url = new URL(c.req.url)

  if (!sessionId) {
    if (url.pathname.startsWith('/admin/api/')) return c.json({ success: false, message: '未登录' }, 401)
    return c.redirect('/admin/login')
  }
  const session = await getSession(c.env, sessionId)
  if (!session) {
    deleteCookie(c, 'session_id')
    if (url.pathname.startsWith('/admin/api/')) return c.json({ success: false, message: 'Session 已过期' }, 401)
    return c.redirect('/admin/login')
  }
  ;(c as any).set('username', session.username)
  return next()
}

/**
 * 管理员登录。凭据优先级：环境变量 ADMIN_USERNAME/ADMIN_PASSWORD > D1 持久化凭据。
 * 首次使用（都没有）时初始化默认 admin/admin 并持久化，请登录后立即在「设置」修改密码。
 */
export async function handleLogin(c: Context<{ Bindings: Env }>) {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, message: '请求体须为 JSON' }, 400)
  }
  const { username, password } = body || {}
  if (!username || !password) return c.json({ success: false, message: '请输入用户名和密码' }, 400)

  let cred = await getAdminCredentials(c.env)
  if (c.env.ADMIN_PASSWORD) {
    // 环境变量优先（用户名缺省 admin），并把当前值同步到 D1（保证改密码后可持久化）
    const envCred = { username: c.env.ADMIN_USERNAME || 'admin', passwordHash: await hashPassword(c.env.ADMIN_PASSWORD) }
    if (!cred || cred.passwordHash !== envCred.passwordHash) {
      cred = envCred
      await setAdminCredentials(c.env, envCred.username, envCred.passwordHash)
    }
  }
  if (!cred) {
    const initial = { username: 'admin', passwordHash: await hashPassword('admin') }
    await setAdminCredentials(c.env, initial.username, initial.passwordHash)
    cred = initial
  }

  const passwordHash = await hashPassword(password)
  if (username !== cred.username || passwordHash !== cred.passwordHash) {
    return c.json({ success: false, message: '用户名或密码错误' }, 401)
  }

  const sessionId = await createSession(c.env, cred.username, SESSION_TTL)
  setCookie(c, 'session_id', sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL,
  })
  return c.json({ success: true, message: '登录成功' })
}

export async function handleLogout(c: Context<{ Bindings: Env }>) {
  const sessionId = getCookie(c, 'session_id')
  if (sessionId) await deleteSession(c.env, sessionId)
  deleteCookie(c, 'session_id')
  return c.redirect('/')
}
