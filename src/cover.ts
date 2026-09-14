/**
 * 渐变封面保底 —— 当网搜与 Agnes 都拿不到封面时，纯 TS 生成 900×383（微信 2.35:1）
 * 的渐变 PNG（复刻 wewrite examples/make_cover.py 的配色思路：深蓝→蓝，右上高光）。
 * PNG 编码：手动构建 IHDR/IDAT/IEND，IDAT 用 CompressionStream deflate（zlib 格式），
 * 无 CompressionStream 环境回落 stored blocks。无第三方依赖。
 */

const W = 900
const H = 383

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  out.set(u32be(data.length), 0)
  const typeBytes = new TextEncoder().encode(type)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcInput = new Uint8Array(4 + data.length)
  crcInput.set(typeBytes)
  crcInput.set(data, 4)
  out.set(u32be(crc32(crcInput)), 8 + data.length)
  return out
}

/** 字符串哈希 → 0-360 色相（同主题封面颜色稳定） */
function hueFromString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const seg = Math.floor(h / 60) % 6
  const table: Array<[number, number, number]> = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ]
  const [r, g, b] = table[seg]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

async function deflateZlib(raw: Uint8Array): Promise<Uint8Array> {
  // Workers/Node 18+ 均有 CompressionStream('deflate')（RFC1950 zlib 包裹，即 PNG IDAT 要求的格式）
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate')
    const body = new Response(raw.slice().buffer as ArrayBuffer).body
    if (!body) throw new Error('无法创建压缩流')
    const buf = await new Response(body.pipeThrough(cs)).arrayBuffer()
    return new Uint8Array(buf)
  }
  // 兜底：stored blocks（无压缩但合法）
  const maxBlock = 65535
  const blocks = Math.ceil(raw.length / maxBlock) + 1
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  let p = 0
  out[p++] = 0x78; out[p++] = 0x01
  let off = 0
  while (off < raw.length || (raw.length === 0 && off === 0)) {
    const len = Math.min(maxBlock, raw.length - off)
    const final = off + len >= raw.length ? 1 : 0
    out[p++] = final
    out[p++] = len & 0xff
    out[p++] = (len >> 8) & 0xff
    out[p++] = (~len) & 0xff
    out[p++] = ((~len) >> 8) & 0xff
    if (len > 0) out.set(raw.subarray(off, off + len), p)
    p += len
    off += len
    if (raw.length === 0) break
  }
  const adler = adler32(raw)
  out[p++] = (adler >>> 24) & 0xff
  out[p++] = (adler >>> 16) & 0xff
  out[p++] = (adler >>> 8) & 0xff
  out[p++] = adler & 0xff
  return out.subarray(0, p)
}

function adler32(buf: Uint8Array): number {
  let a = 1, b = 0
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** 生成渐变封面 PNG，返回原始字节 */
export async function gradientCoverPng(seedTitle: string): Promise<Uint8Array> {
  const hue = hueFromString(seedTitle || 'hotpress')
  const top = hslToRgb(hue, 0.55, 0.18)   // 深色
  const bottom = hslToRgb((hue + 30) % 360, 0.6, 0.5) // 亮色
  const glow = hslToRgb((hue + 60) % 360, 0.5, 0.75)

  // 像素数据（每行前置 filter byte 0）
  const stride = W * 3 + 1
  const raw = new Uint8Array(stride * H)
  const cx = W * 0.78
  const cy = H * 0.2
  const radius = W * 0.35
  for (let y = 0; y < H; y++) {
    const ty = y / (H - 1)
    const rowStart = y * stride
    raw[rowStart] = 0 // filter: None
    for (let x = 0; x < W; x++) {
      const tx = x / (W - 1)
      let r = top[0] + (bottom[0] - top[0]) * ty
      let g = top[1] + (bottom[1] - top[1]) * ty
      let b = top[2] + (bottom[2] - top[2]) * ty
      // 右上柔和高光（复刻 make_cover.py 的半透明椭圆）
      const dx = (x - cx) / radius
      const dy = (y - cy) / (radius * 0.6)
      const d = dx * dx + dy * dy
      if (d < 1) {
        const alpha = 0.35 * (1 - d)
        r = r + (glow[0] - r) * alpha
        g = g + (glow[1] - g) * alpha
        b = b + (glow[2] - b) * alpha
      }
      const px = rowStart + 1 + x * 3
      raw[px] = Math.round(r)
      raw[px + 1] = Math.round(g)
      raw[px + 2] = Math.round(b)
    }
  }

  const ihdr = new Uint8Array(13)
  ihdr.set(u32be(W), 0)
  ihdr.set(u32be(H), 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 2  // color type: truecolor RGB
  // 10-12: compression/filter/interlace 全 0

  const idat = await deflateZlib(raw)
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrChunk = chunk('IHDR', ihdr)
  const idatChunk = chunk('IDAT', idat)
  const iendChunk = chunk('IEND', new Uint8Array(0))
  const total = signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  const png = new Uint8Array(total)
  let p = 0
  png.set(signature, p); p += signature.length
  png.set(ihdrChunk, p); p += ihdrChunk.length
  png.set(idatChunk, p); p += idatChunk.length
  png.set(iendChunk, p)
  return png
}

/** 生成封面并转为 data URI（wx-draft-worker 的 cover 字段直接接受） */
export async function gradientCoverDataUri(seedTitle: string): Promise<string> {
  const png = await gradientCoverPng(seedTitle)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < png.length; i += CHUNK) {
    binary += String.fromCharCode(...png.subarray(i, i + CHUNK))
  }
  return `data:image/png;base64,${btoa(binary)}`
}
