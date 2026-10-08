/*
 * 理记 · 产物取证：证明「跑过自检的那份源码」就是「打进 exe 的那一份」
 * ============================================================================
 * 为什么需要它（2026-09-22 加的）：
 *   打包日志里那句「暂存 9 个源码文件」只能说明「它复制了」，
 *   说明不了「复制的是**这一版**」。中间任何一环出问题都会让结论跑偏：
 *     - 暂存目录里残留着上一轮的旧文件；
 *     - electron-builder 复用了旧的 app.asar 缓存；
 *     - 改完源码忘了重新打包，然后对着旧 exe 说「验过了」。
 *   而「测试全绿」与「用户双击的那个 exe」本来就不是同一件事 ——
 *   本地自检跑的是 `D:\LiJi-Cloud\app.js`，用户跑的是 asar 里那份。
 *   所以交付前最后一步必须是：**从 asar 里把文件抠出来，与本地源码逐字节比 sha1**。
 *   比符号命中强得多 —— 命中只能说明「包里提到了这个名字」。
 *
 * 顺带钉住两件容易静默漏掉的事：
 *   - 包内 `index.html` 的 `<title>` 是否正好是「理记-轻享版」（轻享版专属标题，精确值）；
 *   - 旧品牌残留（「（云端版）」这类后缀）是否为 0。
 *
 * 用法：
 *   node tools/verify-asar.js                         # 默认 dist/win-unpacked/resources/app.asar
 *   node tools/verify-asar.js <asar 路径>
 *   node tools/verify-asar.js --quiet                 # 只在失败时出声（给打包脚本调用）
 *
 * 退出码：0 = 全部一致；1 = 有任一不一致（逐条打印差在哪）
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const ASAR = arg
  ? path.resolve(arg)
  : path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');

/* asar 内部路径用反斜杠；不写死字符，免得被 shell 吃掉 */
const S = String.fromCharCode(92);
const inAsar = (name) => ['web', name].join(S);

/* 必须与本地源码逐字节一致的那几个（就是 tools/build-exe.js 第 2 步暂存的那批）。
 * ★ main.js 也要算进来：它在 asar 里是根目录下的 `\main.js`，不归第 2 步暂存管，
 *   但它同样是「跑在用户机器上的代码」—— 改了它忘重打，包内还是旧的。
 *   2026-09-22 加关于框断言时就差点漏掉这一份。 */
const MUST_MATCH = ['index.html', 'styles.css', 'app.js', 'oss.js', 'icon.svg', 'server.js'];
/* 不在 web/ 下、或埋在子目录里的，单独给出它在 asar 内的真实路径 */
const SUBDIR = {
  'tools/gbk.js': ['web', 'tools', 'gbk.js'].join(S),
  'electron/main.js': 'main.js'
};

let bad = 0;
const say = (s) => { if (!QUIET) console.log(s); };
function check(name, ok, extra) {
  if (ok) { say('  [PASS] ' + name + (extra ? '  ' + extra : '')); }
  else { bad++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
}

if (!fs.existsSync(ASAR)) {
  console.log('  [FAIL] 找不到 app.asar：' + ASAR);
  console.log('         先跑一次 node tools/build-exe.js（或 dist 目录还没打出来）。');
  process.exit(1);
}

let asar;
try {
  asar = require(path.join(ROOT, 'electron', 'node_modules', '@electron', 'asar'));
} catch (e) {
  console.log('  [FAIL] 加载不了 @electron/asar（打包依赖没装？）：' + e.message);
  process.exit(1);
}

say('  产物取证：' + path.relative(ROOT, ASAR) + '（' + fs.statSync(ASAR).size + ' B）');
say('');

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const short = (b) => b.toString('hex').slice(0, 16);

const all = asar.listPackage(ASAR);
say('  包内 ' + all.length + ' 个条目');

const entries = MUST_MATCH.map((n) => [n, inAsar(n)])
  .concat(Object.keys(SUBDIR).map((k) => [k, SUBDIR[k]]));

entries.forEach((e) => {
  const [name, inner] = e;
  const localPath = path.join(ROOT, name);
  if (!fs.existsSync(localPath)) { check(name + ' 本地源码存在', false, localPath); return; }
  const local = fs.readFileSync(localPath);
  let packed = null;
  try { packed = asar.extractFile(ASAR, inner); }
  catch (err) { check(name + ' 在包里', false, err.message); return; }
  const same = packed.length === local.length && sha1(packed) === sha1(local);
  check(name + ' 与本地源码逐字节一致', same,
    same ? (packed.length + ' B  sha1 ' + short(sha1(packed)))
      : ('包内 ' + packed.length + ' B / 本地 ' + local.length + ' B'));
});

/* 标题必须是精确值 —— 「含理记」拦不住写错的那一版（网页端曾经写成「Windows 客户端」）。
 * ★ 轻享版网页端标题是「理记-轻享版」，与正式版「理记-网页端」不同 —— 别照抄正式版那个值。 */
try {
  const html = asar.extractFile(ASAR, inAsar('index.html')).toString('utf8');
  const m = /<title>([^<]*)<\/title>/.exec(html);
  check('包内 index.html 标题正好是「理记-轻享版」', !!m && m[1] === '理记-轻享版',
    m ? m[1] : '(没有 <title>)');
} catch (e) { check('包内 index.html 可读', false, e.message); }

/* 旧品牌残留：改了名字却漏掉某一处，用户就会看到「一半新一半旧」 */
try {
  const app = asar.extractFile(ASAR, inAsar('app.js')).toString('utf8');
  const n = (app.match(/（云端版）/g) || []).length;
  check('包内 app.js 没有「（云端版）」残留', n === 0, n + ' 次');
} catch (e) { check('包内 app.js 可读', false, e.message); }

say('');
console.log('  取证结果：' + (bad === 0 ? '包内文件与本地源码完全一致，可以交付' : (bad + ' 项不一致，不要交付')));
process.exit(bad === 0 ? 0 : 1);
