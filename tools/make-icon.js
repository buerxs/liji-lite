/*
 * 理记 · 生成 Windows 应用图标
 * ============================================================================
 * 输入：tools/icon-render/app_icon.svg
 *   —— 与鸿蒙版同一个徽标（源文件在 D:\礼记\AppScope\resources\base\media\app_icon.svg，
 *      改动徽标时把它重新拷过来，两端图标就一致了）。
 * 输出：electron/build/icon.png（512×512，带透明通道）
 *   —— electron-builder 会用它生成 .ico（含多档尺寸）打进 exe。
 *
 * 为什么绕 Electron 一圈：Node 里没有矢量渲染能力，而 Electron 自带 Chromium/Skia，
 * 能 100% 还原 SVG 的圆角与抗锯齿，且不需要装任何第三方图形库。
 *
 * 用法： node tools/make-icon.js
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const electronEnv = require('./electron-env');

const gbk = require('./gbk');
if (gbk.patchWindowsStdout) gbk.patchWindowsStdout();

const ROOT = electronEnv.ROOT;
const SVG = path.join(__dirname, 'icon-render', 'app_icon.svg');
const APP_DIR = path.join(__dirname, 'icon-render');       // 必须作为「应用目录」启动：
                                                          // 直接传单个 js 文件时 Electron 不走应用引导流程，
                                                          // 主进程里 require('electron') 会解析失败
const OUT = path.join(ROOT, 'electron', 'build', 'icon.png');
const SIZE = 512;

let failed = 0;
function check(name, ok, extra) {
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (extra ? '  ' + extra : ''));
  if (!ok) failed++;
}

function findElectron() {
  return electronEnv.electronPath();
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504E47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colorType: buf[25] };
}

/* 手写 PNG 解码（zlib inflate + 逐行反滤波）。
 * 为什么要解到像素：Chromium 渲染 SVG 里的 <text> 时，如果系统没有可用中文字体，
 * 它**不会报错**，只会画出一个纯色空方块 —— 只校验「是合法 PNG / 尺寸对」根本发现不了。
 * 所以这里直接数像素：背景该是品牌绿，中间该有一块白。 */
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') { idat.push(data); }
    else if (type === 'IEND') { break; }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) return null;
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!ch) return null;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 0xFF;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = ch === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { w, h, px: out };
}

/* 统计某个矩形区域里「接近白」与「接近背景绿 #276749」的像素占比 */
function ratio(dec, x0, y0, x1, y1, test) {
  let hit = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * dec.w + x) * 4;
      total++;
      if (test(dec.px[i], dec.px[i + 1], dec.px[i + 2], dec.px[i + 3])) hit++;
    }
  }
  return total ? hit / total : 0;
}

const isWhite = (r, g, b, a) => a > 200 && r > 225 && g > 225 && b > 225;
const isMoss = (r, g, b, a) => a > 200 && Math.abs(r - 0x27) < 14 && Math.abs(g - 0x67) < 14 && Math.abs(b - 0x49) < 14;

console.log('');
console.log('  理记 · 生成应用图标');
console.log('  ─────────────────────────────────────────');

if (!fs.existsSync(SVG)) {
  console.log('  [错误] 找不到徽标源文件：' + SVG);
  process.exit(1);
}

const electron = findElectron();
if (!electron) {
  console.log('  [错误] 没有找到 electron（应在 electron/node_modules 下）。');
  console.log('         先执行： cd electron && npm install');
  process.exit(1);
}

const r = spawnSync(electron, [APP_DIR, SVG, OUT, String(SIZE)], {
  cwd: ROOT,
  timeout: 120000,
  encoding: 'utf8',
  env: electronEnv.cleanEnv()
});
const out = (r.stdout || '') + (r.stderr || '');

if (!fs.existsSync(OUT)) {
  console.log('  [FAIL] 渲染没有产出文件');
  console.log('  electron 输出：' + out.trim().slice(0, 800));
  process.exit(1);
}

const buf = fs.readFileSync(OUT);
const dim = pngSize(buf);

console.log('  徽标源文件  ' + path.relative(ROOT, SVG));
console.log('  输出图标    ' + path.relative(ROOT, OUT));
console.log('');
check('渲染进程正常退出', r.status === 0, 'exit=' + r.status);
check('输出是合法 PNG', !!dim);
check('尺寸为 ' + SIZE + '×' + SIZE, !!dim && dim.w === SIZE && dim.h === SIZE, dim ? dim.w + '×' + dim.h : '');
check('带透明通道（RGBA）', !!dim && dim.colorType === 6, dim ? 'colorType=' + dim.colorType : '');
check('文件大小合理', buf.length > 2048, (buf.length / 1024).toFixed(1) + ' KB');

/* ---- 像素级取证：证明「字真的画出来了」，而不是字体缺失导致的空方块 ---- */
const dec = decodePng(buf);
check('像素可解码', !!dec, dec ? dec.w + '×' + dec.h : '');
if (dec) {
  const q = Math.round(SIZE * 0.05), c0 = Math.round(SIZE * 0.2), c1 = Math.round(SIZE * 0.8);
  const bg = ratio(dec, q, q, SIZE - q, SIZE - q, isMoss);
  const glyph = ratio(dec, c0, c0, c1, c1, isWhite);
  /* 中间 60%×60% 约占整图 36%，方框内绿底会被白字盖掉一部分 */
  check('底色是品牌绿（#276749）', bg > 0.6, (bg * 100).toFixed(1) + '%');
  check('字心有白色笔画（字形渲染成功）', glyph > 0.05, (glyph * 100).toFixed(1) + '%');
  check('白色没有糊满整块（不是纯白块）', glyph < 0.5, (glyph * 100).toFixed(1) + '%');
  if (glyph <= 0.05) {
    console.log('');
    console.log('  [提示] 中间几乎没有白色 —— 多半是这台机器没有中文字体，');
    console.log('         渲染 SVG <text> 时静默画成了空绿块。');
    console.log('         解决办法：把「理」字转成 <path>（或换台有 Microsoft YaHei 的机器再生成）。');
  }
}

console.log('');
console.log(failed === 0 ? '>>> 图标已就绪' : '>>> 图标生成有 ' + failed + ' 项异常');
process.exit(failed === 0 ? 0 : 1);
