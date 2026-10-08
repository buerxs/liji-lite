/* 图标渲染器（由 tools/make-icon.js 用 Electron 拉起）
 * 参数： <源徽标 svg> <输出 png> <尺寸>
 * 窗口是隐藏 + 透明的，不闪屏也不占任务栏。 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

/* 参数顺序： <源徽标 svg> <输出 png> <尺寸>
 * 注意过滤 '--'：electron 会把它原样传给应用，占掉第一个位置参数。 */
const args = process.argv.slice(2).filter((a) => a !== '--');
const [svgPath, outPath, sizeArg] = args;
const SIZE = parseInt(sizeArg || '512', 10);

app.disableHardwareAcceleration();          // 软件渲染就够，且无显卡驱动异常时更稳
/* 这是个构建期小工具，不是发布给用户的应用：直接把沙箱关掉。
 * 受限环境（容器/CI/被安全软件接管的会话）里 Chromium 的沙箱子进程会被杀，
 * 表现为渲染进程直接 0x80000003 退出、图标渲染不出来。 */
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('in-process-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  try {
    await win.loadFile(path.join(__dirname, 'render.html'));
    const svgText = fs.readFileSync(svgPath, 'utf8');
    const dataUrl = await win.webContents.executeJavaScript(
      'window.__renderSvg(' + JSON.stringify(svgText) + ',' + SIZE + ')'
    );
    if (!dataUrl || dataUrl.indexOf('data:image/png') !== 0) {
      throw new Error('渲染失败：' + dataUrl);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('ICON_OK ' + outPath + ' ' + SIZE + 'x' + SIZE);
    app.exit(0);
  } catch (e) {
    console.error('ICON_FAIL ' + (e && e.message));
    app.exit(1);
  }
});

/* 没有任何窗口时也要能正常退出，避免脚本挂住 */
app.on('window-all-closed', () => app.quit());
