/*
 * 理记 · 服务端连通性自检（零依赖）
 * ============================================================================
 * 用途：确认本地服务端是否真的起来了，并区分「服务端没起」和「浏览器侧被拦」。
 *   由于它是 Node 直连（不走浏览器、不走系统代理），所以：
 *     本工具 通 + 浏览器打不开  →  问题在浏览器侧（代理 / VPN / 扩展 / IPv6），与服务无关
 *     本工具 不通                →  服务端确实没起来或端口不对
 *
 * 用法：
 *   node tools/healthcheck.js                  立即探测一次
 *   node tools/healthcheck.js --wait 12000     最多等 12 秒（每 400ms 重试一次）
 *   node tools/healthcheck.js --port 5174      指定端口
 * 退出码：0 = 服务可达，1 = 不可达（方便 .bat 里用 errorlevel 判断）
 * ============================================================================
 */
'use strict';
const http = require('http');
require('./gbk').patchWindowsStdout();      // 中文输出在 GBK 控制台下才不会乱码

function argOf(name, def) {
  const i = process.argv.indexOf(name);
  return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : def;
}
const PORT = parseInt(argOf('--port', process.env.PORT || '5173'), 10);
const WAIT = parseInt(argOf('--wait', '0'), 10);

function probe(host, port, p) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = http.get({ host: host, port: port, path: p, timeout: 2500 }, (res) => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => finish({ status: res.statusCode, body: b }));
      });
    } catch (e) { return finish({ error: e.code || e.message }); }
    req.on('error', (e) => finish({ error: e.code || e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } finish({ error: 'TIMEOUT' }); });
  });
}

const TARGETS = [
  { host: '127.0.0.1', label: '127.0.0.1' },
  { host: 'localhost', label: 'localhost' },
  { host: '::1', label: '[::1]' }
];

async function sweep() {
  const out = [];
  for (const t of TARGETS) {
    /* 轻享版没有 /api：探测首页本体，返回 200 且是轻享版的页面就算通 */
    const r = await probe(t.host, PORT, '/');
    let ok = r.status === 200 && String(r.body || '').indexOf('理记-轻享版') >= 0;
    out.push({ label: t.label, ok: ok, detail: r.error || ('HTTP ' + r.status) });
  }
  return out;
}

(async () => {
  const deadline = Date.now() + (WAIT > 0 ? WAIT : 0);
  let res = await sweep();
  while (!res[0].ok && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400));
    res = await sweep();
  }

  const ok = res[0].ok;                       // 以 127.0.0.1 为判定基准
  const pad = (s) => s + ' '.repeat(Math.max(1, 14 - s.length));
  const mark = (o) => (o ? '[OK] ' : '[--] ');

  console.log('');
  if (ok) {
    console.log('  [静态服务自检] 可达   HEALTHCHECK_OK');
    res.forEach(r => console.log('    ' + mark(r.ok) + pad(r.label + ':') + r.detail));
    if (!res[2].ok) {
      console.log('    (提示：IPv6 回环未监听。浏览器用 localhost 访问时若连不上，请改用 127.0.0.1；');
      console.log('     重启一次服务端即可让 IPv6 也生效。)');
    }
  } else {
    console.log('  [静态服务自检] 不可达 —— 端口 ' + PORT + ' 上没有响应   HEALTHCHECK_FAIL');
    res.forEach(r => console.log('    [x] ' + pad(r.label + ':') + r.detail));
    console.log('');
    console.log('  常见原因：');
    console.log('    1) 服务窗口已关闭，或启动时就报错 —— 请看标题为「理记服务端」的窗口里写了什么');
    console.log('    2) 端口 ' + PORT + ' 被其它程序占用 —— 可换端口启动：set PORT=5174 && node server.js');
    console.log('    3) 端口被上次没退干净的服务占着 —— 关掉重复的服务窗口后重试');
  }
  console.log('');
  process.exit(ok ? 0 : 1);
})();
