/**
 * scripts/gen-sample.mjs —— 生成 mock 样例结果图（Sprint 5 用）
 * 纯 Node（zlib 内置）+ 手写 PNG 编码（RGB8 + 无滤波 scanline），无第三方依赖。
 * 产出：public/assets/sample-result.png（640×480 星夜渐变 + 星点 + 一轮月）
 * 用途：mock 模式下结果页 <img src> 展示与下载 blob 的数据源。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 640;
const H = 480;

// ---- 像素生成：星夜渐变（顶部深蓝 → 底部紫） + 星点 + 月亮 ----
const px = Buffer.alloc(W * H * 3);
function put(x, y, r, g, b) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
}

// 确定性伪随机（固定种子 → 每次生成相同图）
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

for (let y = 0; y < H; y++) {
  const t = y / H;
  // 渐变：顶部 #171b34 → 底部 #4a3a8a（深海蓝 → 极光紫）
  const r = Math.round(23 + (90 - 23) * t);
  const g = Math.round(27 + (58 - 27) * t);
  const b = Math.round(52 + (138 - 52) * t);
  for (let x = 0; x < W; x++) put(x, y, r, g, b);
}

// 星点（低亮度星白）
for (let i = 0; i < 260; i++) {
  const x = Math.floor(rand() * W);
  const y = Math.floor(rand() * H * 0.72); // 星区偏上
  const a = 120 + Math.floor(rand() * 100);
  put(x, y, a, a, a + 20);
}

// 月亮（暖白圆盘 + 微光晕）
const mx = 480, my = 120, mr = 46;
for (let y = my - mr - 18; y <= my + mr + 18; y++) {
  for (let x = mx - mr - 18; x <= mx + mr + 18; x++) {
    const d = Math.hypot(x - mx, y - my);
    if (d <= mr) put(x, y, 255, 236, 200);
    else if (d <= mr + 14) { // 光晕
      const glow = Math.round(120 * (1 - (d - mr) / 14));
      const base = px[(y * W + x) * 3];
      put(x, y, Math.min(255, base + glow), Math.min(255, base + glow), Math.min(255, base + glow));
    }
  }
}

// ---- PNG 编码 ----
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// scanline：每行前置滤波类型 0
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0;
  px.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // color type RGB
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'sample-result.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`sample-result.png written: ${png.length} bytes, ${W}x${H}`);
