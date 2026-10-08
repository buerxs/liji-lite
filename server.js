/* =====================================================================
 * 理记 · 轻享版 —— 本地静态服务（零依赖，只用 Node 内置模块）
 * ---------------------------------------------------------------------
 * 轻享版**没有服务端**：不存账号、不存数据库、没有 /api。
 * 这个进程只做一件事 —— 把本目录下的静态文件发出去，让浏览器能打开页面。
 *
 * 为什么还要它，而不是让用户直接双击 index.html：
 *   · file:// 下不算安全上下文，Web Crypto（对象存储签名要用）可能被禁；
 *   · localStorage 在 file:// 下的行为各浏览器不一致，文档可能存不住。
 * 起个最小的 http 服务，这两件事就都稳了。
 *
 * 文档存在浏览器自己的 localStorage 里，云端是用户填的对象存储 ——
 * 这个进程不碰任何用户数据，关掉它，文档照样在。
 *
 * 启动：node server.js（或双击「启动.bat」）
 * 端口：5173，被占用则自动顺延到 5174/5175/5176/5180；PORT=xxxx 可覆盖
 * ===================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* Windows 控制台是 GBK 代码页，Node 默认写 UTF-8 字节 —— 不转的话窗口里的中文全是乱码 */
try { require('./tools/gbk').patchWindowsStdout(); } catch (e) { }

const ROOT = __dirname;
const HOST = process.env.HOST || '127.0.0.1';
const START_PORT = parseInt(process.env.PORT || '5173', 10);
const FALLBACK_PORTS = [5174, 5175, 5176, 5180];
const QUIET = process.env.LIJI_QUIET === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    /* 改完文件刷新就该看到新版本 —— 强缓存只会让人以为「改了没生效」 */
    'Cache-Control': 'no-store, must-revalidate'
  }, headers || {}));
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (e) { return send(res, 400, '地址格式不对'); }

  /* 轻享版没有后端：明确告诉调用方，别让它傻等一个永远不存在的接口 */
  if (pathname.indexOf('/api/') === 0) {
    return send(res, 404, '轻享版没有服务端接口（无账号 / 无数据库）。云端用的是你在「同步与存储」里填的对象存储。');
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';
  /* ★ 路径穿越：把 ../ 解析掉之后必须确认还在 ROOT 里，否则整盘文件都能被读走 */
  const filePath = path.join(ROOT, pathname);
  const rel = path.relative(ROOT, filePath);
  if (rel.indexOf('..') === 0 || path.isAbsolute(rel)) return send(res, 403, '不允许访问');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, '找不到：' + pathname);
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-store, must-revalidate'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

/* 桌面端（Electron）会把本文件 require 进去、自己调 start()：
 * 那种场景下不能 process.exit（会连窗口一起关掉），要 emit 出来让主进程决定。 */
const EMBEDDED = process.env.LIJI_EMBEDDED === '1';
function failStart(msg) {
  if (EMBEDDED) { server.emit('liji-start-failed', new Error(msg)); return; }
  console.error(msg);
  process.exit(1);
}

/* 本机的局域网 IPv4（手机连同一 Wi-Fi 时就用这些地址访问） */
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(name => {
    (ifs[name] || []).forEach(a => {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    });
  });
  return out;
}

function listen(ports, i) {
  if (i >= ports.length) {
    return failStart('端口 ' + ports.join(' / ') + ' 都被占用了。请先关掉占用它们的程序，或换个端口：PORT=6000 node server.js');
  }
  const port = ports[i];
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE') { server.removeAllListeners('error'); listen(ports, i + 1); }
    else failStart('启动失败：' + e.message);
  });
  server.listen(port, HOST, () => {
    const url = 'http://' + HOST + ':' + port + '/';
    if (!QUIET) {
      const lanMode = HOST === '0.0.0.0' || HOST === '::';
      const showHost = lanMode ? '127.0.0.1' : HOST;
      console.log('');
      console.log('  理记 · 轻享版  已经启动');
      console.log('  ----------------------------------------');
      console.log('  打开这个地址：http://' + showHost + ':' + port + '/');
      if (lanMode) {
        const ips = lanIPs();
        if (ips.length) {
          console.log('  手机 / 平板（连同一个 Wi-Fi）：');
          ips.forEach(ip => console.log('    http://' + ip + ':' + port + '/'));
        } else {
          console.log('  （没找到局域网 IP —— 手机要访问得先连上网络）');
        }
        console.log('  首次使用若弹 Windows 防火墙提示，勾选「专用网络」并允许，否则手机连不上。');
      }
      console.log('  文档存在本机浏览器里；云端在「同步与存储」里配对象存储');
      console.log('  这个窗口关掉，服务就停了（文档不受影响）');
      console.log('');
    }
  });
}

const PORTS = [START_PORT].concat(FALLBACK_PORTS);

/* 被 require 时不自动起服务（交给调用方调 start）；直接 node server.js 才自动起 */
if (require.main === module) listen(PORTS, 0);

module.exports = {
  server: server,
  start: () => listen(PORTS, 0),
  PORTS: PORTS
};
