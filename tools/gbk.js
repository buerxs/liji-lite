/*
 * 理记 · GBK 编解码（零依赖，只用 Node 内置能力）
 * ============================================================================
 * 为什么需要：中文 Windows 的 cmd.exe 代码页是 936(GBK)。含中文的 .bat 必须
 * 以 GBK + CRLF 落盘，否则 cmd 会按字节错位解析，报「不是内部或外部命令」。
 * Node 只能解码 GBK（TextDecoder('gbk')），不能编码，所以这里用解码表反查出
 * 一张 GBK 编码表来实现 encode。
 *
 * 生成 .bat 请统一走 tools/make-bat.js；本模块只提供编解码原语。
 * ============================================================================
 */
'use strict';

const gbkDecoder = new TextDecoder('gbk');

/* 反查表：一次性枚举 GBK 双字节区间，建立 unicode 字符 -> [lead, trail] */
const reverse = new Map();
for (let lead = 0x81; lead <= 0xFE; lead++) {
  for (let trail = 0x40; trail <= 0xFE; trail++) {
    if (trail === 0x7F) continue;
    const ch = gbkDecoder.decode(Uint8Array.from([lead, trail]));
    if (ch.length === 1 && ch !== '\uFFFD' && !reverse.has(ch)) reverse.set(ch, [lead, trail]);
  }
}
reverse.set('\u20AC', [0x80]);          // CP936 单字节 0x80 = €

/** UTF-8 字符串 -> GBK 字节。返回 { buf, unmappable }，unmappable 是不在 GBK 内的字符 */
function encode(str) {
  const out = [], unmappable = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out.push(cp); continue; }
    const pair = reverse.get(ch);
    if (pair) out.push(pair[0], pair[1]);
    else { unmappable.push(ch); out.push(0x3F); }     // 无法映射时落成 '?'
  }
  return { buf: Buffer.from(out), unmappable };
}

/** GBK 字节 -> 字符串 */
function decode(buf) { return new TextDecoder('gbk').decode(buf); }

/** 统一成 CRLF 换行（批处理必须 CRLF）；顺便去掉开头的空行 */
function toCrlf(s) { return s.replace(/^\r?\n/, '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'); }

/* ---------------------------------------------------------------------------
 * Windows 控制台输出适配
 * ---------------------------------------------------------------------------
 * 中文 Windows 的控制台代码页是 936(GBK)，而 Node 写 stdout 用的是 UTF-8 字节，
 * 于是 console.log('中文') 在 cmd 窗口里会显示成「绀艰 路 ...」这样的乱码。
 * .bat 里的 echo 是 GBK 字节（显示正常），两者混在一起更乱。
 * 这里把 Node 的字符串输出统一转成 GBK 字节，和 echo 保持一致。
 *   设 LIJI_UTF8=1 可关闭该适配（例如想把输出按 UTF-8 收集时）。
 * ------------------------------------------------------------------------- */
let patched = false;
function patchWindowsStdout() {
  if (patched) return false;
  if (process.platform !== 'win32') return false;
  if (process.env.LIJI_UTF8 === '1') return false;
  patched = true;
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream || typeof stream.write !== 'function') continue;
    const write = stream.write.bind(stream);
    stream.write = function (chunk, enc, cb) {
      if (typeof chunk === 'string') {
        const callback = (typeof enc === 'function') ? enc : cb;
        try { return write(encode(chunk).buf, callback); } catch (e) { }
      }
      return write(chunk, enc, cb);
    };
  }
  return true;
}

module.exports = { encode, decode, toCrlf, patchWindowsStdout };
