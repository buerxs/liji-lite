/*
 * 理记 · 从 Node 里启动 Electron 的公共辅助
 * ============================================================================
 * 两个坑（都是环境变量造成的，不处理的话 Electron 会「当自己是 Node」跑起来）：
 *   1) ELECTRON_RUN_AS_NODE=1 —— 某些 IDE / 终端会注入它，作用是把 electron.exe
 *      变成普通的 node.exe。症状是主进程里 require('electron') 报
 *      「Cannot find module 'electron'」，因为它压根不是 Electron。
 *   2) NODE_OPTIONS=--require=... —— 宿主工具链注入的预加载脚本，会污染子进程。
 * 所以每次 spawn Electron 都要用 cleanEnv() 拿一份干净的环境。
 * ============================================================================
 */
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** electron.exe 的真实路径（electron 包在 Node 下导出的就是可执行文件路径） */
function electronPath() {
  try {
    return require(path.join(ROOT, 'electron', 'node_modules', 'electron'));
  } catch (e) {
    return null;
  }
}

/** 去掉会让 Electron 行为错乱的宿主环境变量 */
function cleanEnv(extra) {
  const env = Object.assign({}, process.env, extra || {});
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

module.exports = { ROOT, electronPath, cleanEnv };
