/**
 * 构建产物：
 *   dist/worker.js        —— Cloudflare Workers 单文件（wrangler deploy 用）
 *   dist/pages/_worker.js —— Cloudflare Pages 高级模式（Pages 项目输出目录设为 dist/pages）
 *
 * 同一份 Hono 应用，双形态部署；D1 绑定分别由 wrangler.toml / wrangler.pages.toml 提供。
 */
import { build } from 'esbuild'
import { mkdirSync, copyFileSync } from 'node:fs'

mkdirSync('dist/pages', { recursive: true })

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  logLevel: 'info',
}

await build({ entryPoints: ['src/index.ts'], outfile: 'dist/worker.js', ...common })
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/pages/_worker.js', ...common })

// 空占位：Pages 项目根目录至少有一个静态文件，保证部署不报错
copyFileSync('scripts/.placeholder', 'dist/pages/.placeholder')

console.log('\n✅ 构建完成：dist/worker.js + dist/pages/_worker.js')
