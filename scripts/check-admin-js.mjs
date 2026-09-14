/**
 * 校验 ADMIN_JS（TS 模板字符串）经转义展开后的真实 JS 是否语法合法。
 * 用法：node scripts/check-admin-js.mjs
 * 原理：从 src/pages.ts 提取 const ADMIN_JS = `...` 的模板内容，
 *      模拟 TS 模板字面量的转义展开（\n \t \\ \` \$），写临时文件跑 node --check。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const src = readFileSync('src/pages.ts', 'utf8')
const start = src.indexOf('const ADMIN_JS = `')
if (start === -1) { console.error('未找到 ADMIN_JS'); process.exit(1) }
const contentStart = start + 'const ADMIN_JS = `'.length
const end = src.indexOf('\n`', contentStart)
if (end === -1) { console.error('未找到模板结束'); process.exit(1) }
let tpl = src.slice(contentStart, end)

// 模拟模板字面量转义展开
tpl = tpl
  .replace(/\\`/g, '\u0001')
  .replace(/\\\$/g, '\u0002')
  .replace(/\\\\/g, '\u0003')
  .replace(/\\n/g, '\n')
  .replace(/\\t/g, '\t')
  .replace(/\u0001/g, '`')
  .replace(/\u0002/g, '$')
  .replace(/\u0003/g, '\\')

writeFileSync('/tmp/admin_js_emitted.js', tpl)
try {
  execSync('node --check /tmp/admin_js_emitted.js', { stdio: 'pipe' })
  console.log('✅ ADMIN_JS 转义展开后语法合法')
} catch (e) {
  const out = (e.stderr || e.stdout || '').toString()
  console.error('❌ 语法错误：')
  console.error(out.split('\n').slice(0, 5).join('\n'))
  // 打印出错行内容
  const m = out.match(/:(\d+)(?:\d+)?/)
  if (m) {
    const lineNo = parseInt(m[1], 10)
    const lines = tpl.split('\n')
    console.error(`>>> L${lineNo}: ${lines[lineNo - 1]}`)
  }
  process.exit(1)
}
