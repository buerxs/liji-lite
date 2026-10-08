/*
 * 理记 · 预置 electron-builder 的 winCodeSign 缓存
 * ============================================================================
 * 要解决的问题：
 *   Windows 上打 exe 时，electron-builder 会下载 winCodeSign-2.6.0.7z（内含 rcedit，
 *   用来把图标与版本信息写进 exe）。这个包里有 darwin/ 目录下的两个 .dylib 是
 *   「符号链接」条目，而普通权限的 Windows 创建符号链接会失败，7-Zip 于是返回
 *   退出码 2 —— electron-builder 判定解压失败，换临时目录重试 4 次后终止，
 *   报错长得像：
 *     Cannot create symbolic link : 客户端没有所需的特权。
 *     : ...\Cache\winCodeSign\<随机数>\darwin\10.12\lib\libcrypto.dylib
 *   开「开发者模式」或用管理员运行能绕开，但这两条都要改系统设置，不该让用户去弄。
 *
 * 做法：
 *   自己下载同一个包，解压时排除 darwin/（Windows 上根本用不到 macOS 签名工具），
 *   解到 electron-builder 期望的目录名，让它直接命中缓存、跳过下载解压。
 *
 * 用法： node tools/prepare-build-cache.js
 *       版本号可用 LIJI_WINCODESIGN_VERSION 覆盖（默认 2.6.0）
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const electronEnv = require('./electron-env');

const gbk = require('./gbk');
if (gbk.patchWindowsStdout) gbk.patchWindowsStdout();

const ROOT = electronEnv.ROOT;
const CACHE_ROOT = process.env.ELECTRON_BUILDER_CACHE
  || path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
const PKG = 'winCodeSign';
const VERSION = process.env.LIJI_WINCODESIGN_VERSION || '2.6.0';
const TARGET = path.join(CACHE_ROOT, PKG, PKG + '-' + VERSION);
const MIRROR = process.env.ELECTRON_BUILDER_BINARIES_MIRROR
  || 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';
const SEVEN_ZIP = path.join(ROOT, 'electron', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

let failed = 0;
function check(name, ok, extra) {
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (extra ? '  ' + extra : ''));
  if (!ok) failed++;
}
function fmtSize(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch (e) { }
        return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('timeout', () => { req.destroy(new Error('下载超时')); });
    req.on('error', (e) => { try { file.close(); fs.unlinkSync(dest); } catch (err) { } reject(e); });
  });
}

/* 失败重试留下的 <随机数> 目录和 .7z 都是垃圾，顺手清掉（best-effort，删不掉不影响结果） */
function cleanStray() {
  const dir = path.join(CACHE_ROOT, PKG);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name === PKG + '-' + VERSION) continue;
    if (!/^\d+(\.7z)?$/.test(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      n++;
    } catch (e) { /* 被占用就算了 */ }
  }
  return n;
}

async function main() {
  console.log('');
  console.log('  理记 · 预置打包缓存（winCodeSign）');
  console.log('  ─────────────────────────────────────────');
  console.log('  缓存目录    ' + CACHE_ROOT);
  console.log('  目标目录    ' + TARGET);

  /* 已经就绪就直接跳过 —— 以后的每次打包都不会再走这里 */
  if (fs.existsSync(path.join(TARGET, 'rcedit-x64.exe'))) {
    console.log('');
    console.log('  缓存已就绪，跳过。');
    return 0;
  }

  if (!fs.existsSync(SEVEN_ZIP)) {
    console.log('');
    console.log('  [错误] 找不到 7za.exe：' + SEVEN_ZIP);
    console.log('         先执行： cd electron && npm install');
    return 1;
  }

  fs.mkdirSync(TARGET, { recursive: true });

  /* 优先复用之前失败重试下载下来的包，省一次下载 */
  const existing = fs.existsSync(path.join(CACHE_ROOT, PKG))
    ? fs.readdirSync(path.join(CACHE_ROOT, PKG)).filter((n) => n.endsWith('.7z') && n !== PKG + '-' + VERSION + '.7z')
    : [];
  let archive;
  if (existing.length) {
    archive = path.join(CACHE_ROOT, PKG, existing[0]);
    console.log('');
    console.log('  复用已下载的包 ' + existing[0] + '  ' + fmtSize(fs.statSync(archive).size));
  } else {
    archive = path.join(CACHE_ROOT, PKG, PKG + '-' + VERSION + '.7z');
    const url = MIRROR + PKG + '-' + VERSION + '/' + PKG + '-' + VERSION + '.7z';
    console.log('');
    console.log('  下载 ' + url);
    try {
      await download(url, archive);
    } catch (e) {
      console.log('  [错误] 下载失败：' + e.message);
      return 1;
    }
    console.log('  下载完成 ' + fmtSize(fs.statSync(archive).size));
  }
  check('压缩包可用', fs.existsSync(archive) && fs.statSync(archive).size > 1024 * 1024);

  /* 关键： -xr!darwin 排除 macOS 目录，符号链接问题就从根上没有了 */
  const r = spawnSync(SEVEN_ZIP, ['x', '-bd', '-y', archive, '-o' + TARGET, '-xr!darwin'], { encoding: 'utf8' });
  check('解压成功（已排除 darwin/）', r.status === 0, 'exit=' + r.status);
  check('rcedit-x64.exe 就位', fs.existsSync(path.join(TARGET, 'rcedit-x64.exe')));
  check('windows-10 签名工具就位', fs.existsSync(path.join(TARGET, 'windows-10')));

  const cleaned = cleanStray();
  if (cleaned) {
    console.log('');
    console.log('  已清理 ' + cleaned + ' 个失败重试残留（目录/压缩包）');
  }

  console.log('');
  if (failed === 0) {
    console.log('  缓存预置完成，接下来的打包不会再卡在符号链接上。');
  } else {
    console.log('  缓存预置有 ' + failed + ' 项失败。');
  }
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => {
  console.error('  [错误] ' + (e && e.message));
  process.exit(1);
});
