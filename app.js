/* =====================================================================
 * 理记 · 轻享版
 * ---------------------------------------------------------------------
 * 与正式版的差别只有一处：**没有服务端**。
 *   · 不要账号、不要登录、不要会员、不要公告 —— 打开就能写；
 *   · 文档全部存在本机（localStorage，键名沿用 liji_store，与鸿蒙版互通）；
 *   · 「云端」换成用户自己的对象存储（OSS / COS / S3），在「个人中心」里填一次配置，
 *     之后每次打开自动比对云端、改动自动上传。签名在本地算，不经过任何中转服务器。
 *
 * 文档功能（编辑 / 导图 / 公式 / 图片 / 文件夹 / 导出）与正式版完全一致，
 * 这份文件里除了「同步后端」与「账号入口」被换掉，其余一行未动。
 *
 * 纯前端实现：HTML + CSS + 原生 JS，零第三方依赖。
 * ===================================================================== */
(function () {
  'use strict';

  /* ============================== 常量 ============================== */
  const INK = '#1F2A2A', MUTED = '#77807D', PAPER = '#F7F8F5', MOSS = '#276749', LINE = '#E4E9E3';
  /* 页面来源：只用于界面文案（提示用户「本机地址」是什么），不发任何请求。 */
  const SERVER_URL = (function () {
    try {
      if (typeof location !== 'undefined' && location.protocol !== 'file:'
        && location.origin && location.origin !== 'null') return location.origin;
    } catch (e) { }
    return 'http://127.0.0.1:5173';
  })();
  const SERVER_HOST = SERVER_URL.replace(/^https?:\/\//, '');   // 只用于界面文案
  const APP_VERSION = '1.3.0';        // 轻享版版本号（与 electron/package.json 保持一致）
  const ZWSP = '​';
  const LEVEL_FONT_ROOT = 18, LEVEL_FONT_TOP = 16, LEVEL_FONT_STEP = 1, LEVEL_FONT_MIN = 13;
  /* MAP_ROW 是「向下分类图 / 组织结构图」的**最小**层间距，不是固定层间距 ——
   * 每层实际步长取 max(MAP_ROW, 该层最高框 + MAP_VGAP)，见 orgRowTops()。
   * （原来是写死的 `MAP_PAD + depth * MAP_ROW`，隐含假设「框高不超过 120」；
   *   挂了图片/公式的框能到 179 高，那个假设就不成立了 —— 2026-09-22 实测下一层直接压上来。） */
  const MAP_PAD = 26, MAP_BOX_MAX = 220, MAP_COL = 252, MAP_VGAP = 12, MAP_ROW = 120, MAP_HGAP = 16;
  const MAP_LINE_W = 2;                 // 鱼骨图的骨长/角度见 layoutFishbone 上方的 FISH_* 常量
  const CONN_1 = '#7FA98F', CONN_2 = '#B3CAB9';
  const EXPORT_W = 794, EXPORT_FONT_SCALE = 1.5, EXPORT_SCALE = 2, EXPORT_PAD = 60;
  const PDF_PAGE_W = 595, PDF_PAGE_H = 842, PDF_MARGIN = 40, PDF_TOP = 60, PDF_BOTTOM = 60;
  const FONT = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif';

  const COLOR_OPTIONS = [
    { value: '#1F2A2A', name: '墨黑' }, { value: '#6B7671', name: '石墨' },
    { value: '#C0392B', name: '朱红' }, { value: '#E07B39', name: '橘橙' },
    { value: '#C9A227', name: '秋黄' }, { value: '#276749', name: '松绿' },
    { value: '#1FA37C', name: '青碧' }, { value: '#1E5AA8', name: '湖蓝' },
    { value: '#6C3FB0', name: '紫藤' }, { value: '#C2185B', name: '玫红' }
  ];
  const MAP_STYLES = ['向右逻辑图', '向左逻辑图', '双向思维导图', '鱼骨图', '向下分类图', '组织结构图', '气泡图'];
  const LEVEL_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const EXPORT_OPTIONS = [
    { key: 'doc-pdf', title: '文档 · PDF', desc: '按 A4 分页，右下角带理记标识', icon: '文' },
    { key: 'doc-md', title: '文档 · Markdown', desc: '.md 文件，标题按 # 层级导出，别的软件能直接打开', icon: 'M' },
    { key: 'map-pdf', title: '思维导图 · PDF', desc: '整张导图，按 A4 分页', icon: '图' },
    { key: 'map-image', title: '思维导图 · 长图', desc: 'PNG 长图，一张到底不切页', icon: '长' }
  ];

  /* ============================== 公式与图片：数据层（2026-09-22 新增） ==============================
   * 节点上多一个**可选**字段 media —— 数组，元素形如
   *   { id, kind:'formula'|'img', src:'data:image/png;base64,…', w, h, source?:'\\frac{a}{b}' }
   *
   * 为什么要先在这里（而不是靠近 UI 的地方）定义：nodeSize() 在导图布局里被调用，
   * 它要按「有没有挂图」算框的尺寸。常量声明（const）不提升，放在后面会掉进暂时性死区。
   *
   * 这是**纯增量**：老版本读到不认识的字段会原样透传（云同步就是把整棵树 JSON 往返一次），
   * 不会因为多一个 media 就把文档弄坏；反过来老数据没有 media，下面所有分支都不进，
   * 导图尺寸与布局跟改动前逐字节相同 —— 这是 7 种布局不被撬动的前提。
   * ========================================================================================== */
  const MEDIA_ROW_MAX_W = 200, MEDIA_ROW_MAX_H = 150;   // 编辑页行内缩略图上限
  const MAP_MEDIA_MAX_H = 150;                          // 导图框里图片高度上限
  function nodeMedia(node) { return (node && Array.isArray(node.media)) ? node.media : []; }
  /* 等比缩放到 (maxW, maxH) 框内，且**不放大**（小图保持原尺寸，放大只会更糊） */
  function mediaFit(item, maxW, maxH) {
    const w = Math.max(1, Number(item && item.w) || 1), h = Math.max(1, Number(item && item.h) || 1);
    const s = Math.min(maxW / w, maxH / h, 1);
    return { w: Math.max(8, Math.round(w * s)), h: Math.max(8, Math.round(h * s)) };
  }
  function mediaId() { mediaSeed += 1; return 'm' + Date.now().toString(36) + mediaSeed.toString(36); }
  function addNodeMedia(id, item) {
    const fresh = { id: mediaId(), kind: item.kind === 'formula' ? 'formula' : 'img', src: item.src, w: item.w, h: item.h };
    if (item.source) fresh.source = item.source;
    patchNode(id, n => { n.media = nodeMedia(n).concat([fresh]); });
    return fresh.id;
  }
  function patchNodeMedia(id, mid, patch) {
    patchNode(id, n => { n.media = nodeMedia(n).map(m => (m.id === mid ? Object.assign({}, m, patch) : m)); });
  }
  function removeNodeMedia(id, mid) {
    patchNode(id, n => { n.media = nodeMedia(n).filter(m => m.id !== mid); });
  }
  /* 按 id 找媒体，跨节点 —— 查看器只拿到一个 id，得反查它挂在谁身上 */
  function findMediaAcrossDoc(mid) {
    const nodes = selectedDocument().nodes;
    for (let i = 0; i < nodes.length; i++) {
      const list = nodeMedia(nodes[i]);
      for (let j = 0; j < list.length; j++) {
        if (list[j].id === mid) return { nodeId: nodes[i].id, item: list[j], index: j };
      }
    }
    return null;
  }
  /* 图片解码缓存：canvas 的 drawImage 是同步的，导出时没加载完就只能画个占位框 */
  const IMG_CACHE = Object.create(null);          // src -> HTMLImageElement
  function cachedImage(src) { const im = IMG_CACHE[src]; return (im && im.__ready) ? im : null; }
  function loadImage(src) {
    const hit = IMG_CACHE[src];
    if (hit) return hit.__ready ? Promise.resolve(hit) : hit.__fail ? Promise.reject(new Error('图片解码失败')) : hit.__promise;
    const im = document.createElement('img');
    im.__ready = false; im.__fail = false;
    im.__promise = new Promise((res, rej) => {
      im.onload = () => { im.__ready = true; res(im); };
      im.onerror = () => { im.__fail = true; rej(new Error('图片解码失败')); };
    });
    im.src = src;
    IMG_CACHE[src] = im;
    return im.__promise;
  }
  /* 导出前把当前文档里所有图片解码完 —— 否则 PDF / 长图里会少图 */
  function preloadDocImages() {
    const jobs = [];
    selectedDocument().nodes.forEach(n => nodeMedia(n).forEach(m => { if (!cachedImage(m.src)) jobs.push(loadImage(m.src).catch(() => { })); }));
    return Promise.all(jobs);
  }

  /* ============================== 状态 ============================== */
  const S = {
    tab: '首页',
    showEditor: false,
    showTemplateSheet: false,
    editorView: '编辑',
    collapsedIds: [],
    docTitle: '秋季产品计划',
    activeDocId: 1,
    mapStyle: '向右逻辑图',
    mapZoom: 1,
    selectedNodeId: 0,
    toast: '',
    editNodeId: 0,
    showColorPanel: false,
    showExportPanel: false,
    showLevelMenu: false,
    /* 多选批量（2026-09-25）：批量升降级与单选走同一条校验（见 planLevelShift）。
       只是临时 UI 态，不落盘 —— saveNow 只存 documents/folders/activeDocId。 */
    multiSel: false,
    multiSelIds: [],
    confirmDeleteId: 0,
    exporting: false,
    exportingKey: '',
    /* ---- 对象存储同步（轻享版的「云端」就是用户自己的桶） ---- */
    cloudState: 'idle',         // idle | syncing | synced | error
    cloudMsg: '',
    lastSyncAt: 0,
    ossOn: false,               // 是否已配置并启用
    ossCfg: null,               // 配置对象（单独存 liji_oss_config，不混进文档库）
    ossRemote: null,            // 云端 meta：{ updatedAt, docs, bytes, device }
    ossTesting: false,
    ossMsg: '',                 // 配置面板里的提示
    ossMsgKind: '',             // ok | err
    ossFormOpen: false,         // 配置面板是否展开
    ossDraft: null,             // 配置表单的编辑期草稿（保存前不动生效配置）
    /* 覆盖本机之前先把本机存一份，万一拉错了还能点回来（见 backupLocalSnapshot） */
    ossBackupAt: 0,
    /* ---- 公式与图片 / 导图编辑 / 刷新（2026-09-22 新增） ---- */
    mediaView: null,            // 正在放大查看的图片/公式：{ nodeId, mediaId }
    mediaSel: null,             // 裁剪选区（相对「旋转后外接矩形」的归一化 0~1 坐标）
    mediaRot: 0,                // 查看器里的旋转角度（度）
    mediaBusy: false,
    showFormula: false,         // 公式编辑器浮层
    formulaTab: '结构',
    formulaSrc: '',
    formulaEditId: '',          // 非空 = 在改一条已有的公式（而不是新插一条）
    formulaTargetNode: 0,
    mapNodeId: 0,               // 导图里选中的主题（0 = 没选）。与文档行共用同一份 nodes
    editingRowId: 0,            // 光标最后一次所在的那一行的 id（工具栏的目标行；0 = 还没点过任何行）
    /* Word 逻辑：没选区时样式按钮不改已有文字，只改「接下来要输入的字的样式」。
       记在 caretStyle 上，输入时打在新写的那一段（caretStyleId 标明它属于哪个节点）。 */
    caretStyle: null,           // {b,u,c,fz} | null
    caretStyleId: 0,
    mapEditing: false,          // 导图里正在改这个主题的文字
    mapEditText: '',            // 改文字时的草稿（取消就丢）
    /* 导出 PDF 时内容超出一页：{kind, pages} —— 非空就先弹窗问一句（见 PdfOverflowDialog） */
    exportConfirm: null,
    /* ---- 文档文件夹（2026-09-24 新增）----
       归属记在 `documents[i].folder` 上（数字 id，0/缺省 = 未分类），`folders` 是清单。
       两者都是**纯增量**：没建过文件夹时 folders 为空、folder 字段根本不存在，
       首页就照原来的样子平铺渲染 —— 老数据、鸿蒙端、云上别人的文档都不受影响。 */
    folders: [],                // [{ id, name }]
    folderInput: '',            // 「新建文件夹」输入框里的草稿
    showFolderInput: false,
    folderEditId: 0,            // 正在重命名的文件夹 id（>0 时分组头换成输入框）
    folderCollapsed: [],        // 折叠起来的文件夹 id（0 = 未分类）
    confirmFolderId: 0,         // 待确认删除的文件夹（删文件夹不删文档）
    moveDocId: 0,               // 正在为哪篇文档挑目录（>0 时弹「移动到…」浮层）
    newFolderForMove: '',       // 移动浮层里「新建文件夹」的输入草稿
    customTplOpen: false,       // 模板浮层里「自定义」的展开态
    customTplName: '',          // 自定义模板名的输入草稿
    customTplDesc: '',          // 自定义模板介绍的输入草稿
    documents: [
      {
        id: 1, title: '秋季产品计划', updatedAt: '刚刚更新', template: '计划', nodes: [
          { id: 11, text: '产品目标', level: 1, children: [] },
          { id: 111, text: '提升新用户首周留存', level: 2, children: [] },
          { id: 112, text: '完成平板端体验升级', level: 2, children: [] },
          { id: 12, text: '关键里程碑', level: 1, children: [] },
          { id: 121, text: '九月：用户访谈与方案', level: 2, children: [] },
          { id: 1211, text: '招募 10 位目标用户', level: 3, children: [] },
          { id: 122, text: '十月：灰度发布', level: 2, children: [] },
          { id: 13, text: '待协调事项', level: 1, children: [] },
          { id: 131, text: '设计资源排期', level: 2, children: [] }
        ]
      },
      {
        id: 2, title: '每周工作清单', updatedAt: '昨天', template: '工作清单', nodes: [
          { id: 21, text: '本周重点', level: 1, children: [] },
          { id: 211, text: '完成项目复盘', level: 2, children: [] },
          { id: 2111, text: '整理结论文档', level: 3, children: [] },
          { id: 212, text: '准备周五分享', level: 2, children: [] },
          { id: 22, text: '等待回复', level: 1, children: [] },
          { id: 221, text: '客户邮件', level: 2, children: [] }
        ]
      }
    ],
    posts: [
      { title: '一周高效复盘法', author: '林间写字', description: '一份能真正坚持的复盘大纲，从事件到行动。', template: '复盘模板', likes: 826, color: '#E6F4EA' },
      { title: '旅行行前清单', author: '南方候鸟', description: '把行程、物品、预算放进一个清爽的计划。', template: '计划模板', likes: 415, color: '#FFF0D9' },
      { title: '读书笔记：深度工作', author: 'Nora', description: '章节框架、摘录与可执行的实践清单。', template: '读书笔记', likes: 263, color: '#E8EEFF' }
    ]
  };
  let idSeed = 0;
  let mediaSeed = 0;   // 公式/图片的 id 序号
  let saveTimer = -1;
  let pendingFocus = null; // {id, caret:number|'end'}
  let pendingMapSel = null; // {s,e} 导图「改文字」框里待还原的选区（行内样式作用于选区后要放回去）
  let mapSelSnapshot = null; // {s,e,text} 按工具条按钮那一刻导图改文字框里的选区（点色板会重渲染，活选区会没）
  let rowSelSnapshot = null; // {s,e,id} 同上，大纲编辑行那一份
  let toastTimer = -1, toastEl = null;   // 提示条就地改 DOM，不参与整体重渲染（见 showNotice）
  let cloudTimer = -1;      // 云端推送防抖
  let docsDirty = false;    // 本机有还没推上云端的改动（必须落盘，见 markDocsDirty）
  /* 本机记住的「云端版本」：{ syncedAt, remoteUpdatedAt, rev, base } —— 启动比对就看这几个数。
     它自己也要落盘：不落盘的话，重启后就不知道上次同步到哪，只能盲目拿云端盖本地。
     rev = 云端 meta 的版本号（乐观锁）；base = 上次同步时每篇文档的内容指纹（三方合并的「共同祖先」）。 */
  let ossState = { syncedAt: 0, remoteUpdatedAt: 0, device: '', rev: 0, base: null, mirrorMap: null, mirrorHashes: null, mirrorDead: [] };
  let pollTimer = -1;

  /* ============================== DOM 工具 ============================== */
  function el(tag, cls, attrs, children) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'data') Object.assign(e.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
    if (children != null) (Array.isArray(children) ? children : [children]).forEach(c => {
      if (c == null) return;
      e.appendChild((typeof c === 'string' || typeof c === 'number') ? document.createTextNode(String(c)) : c);
    });
    return e;
  }
  const div = (c, a, ch) => el('div', c, a, ch);
  /* 线性描边小图标（2026-10-08，与云端版同步）：emoji（🗀 / 📁 / ⤓）在不同系统上渲染不可控、风格杂，
     统一换成 currentColor 描边 SVG —— 跟随文字颜色，按钮怎么换色图标就怎么跟。 */
  const SVG_PATHS = {
    folder: 'M3 7.2C3 5.4 4.4 4 6.2 4h2.9c.7 0 1.4.28 1.9.78l1 1c.47.47 1.1.72 1.77.72h4.03c1.8 0 3.2 1.4 3.2 3.2v7.1c0 1.8-1.4 3.2-3.2 3.2H6.2C4.4 20 3 18.6 3 16.8V7.2zM12 10.2v4.6M9.7 12.5h4.6',
    doc: 'M7 3.5h6.2L18.5 8.8v10.7c0 1.1-.9 2-2 2H7c-1.1 0-2-.9-2-2v-14c0-1.1.9-2 2-2zM13 3.8V9h4.7M9 13.5h6M9 16.5h4',
    'folder-plus': 'M3 7.2C3 5.4 4.4 4 6.2 4h2.9c.7 0 1.4.28 1.9.78l1 1c.47.47 1.1.72 1.77.72h4.03c1.8 0 3.2 1.4 3.2 3.2v7.1c0 1.8-1.4 3.2-3.2 3.2H6.2C4.4 20 3 18.6 3 16.8V7.2zM12 10.2v4.6M9.7 12.5h4.6',
    'doc-plus': 'M7 3.5h6.2L18.5 8.8v10.7c0 1.1-.9 2-2 2H7c-1.1 0-2-.9-2-2v-14c0-1.1.9-2 2-2zM13 3.8V9h4.7M12 11.5v5M9.5 14h5',
    'import': 'M12 4v9.2M8.4 9.8l3.6 3.6 3.6-3.6M5 18.5h14'
  };
  function svgIcon(name, size) {
    const s = size || 15;
    return el('span', 'svg-ic', {
      html: '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (SVG_PATHS[name] || '') + '"/></svg>'
    });
  }
  const appEl = document.getElementById('app');
  /* 工具栏 / 色板 / 层级菜单上按下鼠标时不抢走编辑行的焦点与选区 ——
   * 否则点「加粗」的瞬间 textarea 先失焦，selectionStart/End 就拿不到了。
   * preventDefault 只挡焦点转移，click 事件照常派发。
   * 这里顺手做一次**导图改文字框的选区快照**：点「颜色」会打开色板并整体重渲染（选区随之消失），
   * 等用户再点色块时已经读不到活选区了 —— 所以按下的那一刻先把 {s,e,text} 存下来。 */
  appEl.addEventListener('mousedown', e => {
    const t = e.target && typeof e.target.closest === 'function'
      ? e.target.closest('.toolbar,.map-editbar,.color-panel,.level-menu') : null;
    if (!t) return;
    const mt = appEl.querySelector('textarea[data-map-edit]');
    if (mt) {
      const ms = mt.selectionStart, me = mt.selectionEnd;
      /* ⚠ 只有**真有活选区**时才覆盖快照：点色板那一下进来时，活选区已经被上一次重渲染清掉了，
         这里若写成「无条件赋值（含 null）」就会把刚刚存下的选区冲掉，等于白存。 */
      if (typeof ms === 'number' && typeof me === 'number' && me > ms) {
        mapSelSnapshot = { s: ms, e: me, text: String(mt.value === undefined ? '' : mt.value) };
      }
    }
    /* 大纲行同理（现在是 contenteditable）：点「颜色」→ 色板打开时重渲染，行里的选区也没了，
       不存快照的话点色块会退回「整行变色」。同样只在真有活选区时才覆盖。 */
    const rt = activeRowInput();
    if (rt) {
      const sel = selOfEditable(rt);
      if (sel && sel.e > sel.s) {
        rowSelSnapshot = { s: sel.s, e: sel.e, id: Number(rt.getAttribute('data-id')) || S.editingRowId };
      }
      S.editingRowId = Number(rt.getAttribute('data-id')) || S.editingRowId;
    }
    e.preventDefault();
  }, false);

  /* ★ 级别标签跟随光标（2026-09-25）：selectNode 是故意不 render 的 —— 点了行要接着打字，
     重渲染会把刚拿到的焦点抢走。代价是工具栏上的「标题N」/ 色点停留在**上次渲染**的那一行，
     用户看到的就是"级别显示不跟着光标走，要点一下别的按钮才更新"。
     这里监听 selectionchange：把光标所在行映射回节点后，**只改标签文字和色点**，不动任何结构 ——
     既让显示跟手，又不碰焦点。容错全包（selectionchange 在输入法组合期间也会高频触发）。 */
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('selectionchange', () => {
      try {
        if (!S.showEditor || S.editorView !== '编辑') return;
        const sel = (typeof document.getSelection === 'function') ? document.getSelection() : null;
        if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return;
        const anchor = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
        if (!anchor || typeof anchor.closest !== 'function') return;
        const host = anchor.closest('.row-input');
        if (!host || !host.getAttribute) return;
        const id = parseInt(host.getAttribute('data-id'), 10);
        if (!id) return;
        const node = findNode(id);
        if (node === undefined) return;
        /* ⚠ 不能拿「id === activeNodeId()」当短路：真点击时 selectNode（click）跑在
           selectionchange **前面**，到这里 editNodeId 已经是目标行了 —— 一短路，
           标签就永远停在旧行（2026-09-25 用内部探针抓到的，dbg= bail-same）。
           改成：状态照写（幂等），标签只在**文字真的不一样**时才写。 */
        S.editNodeId = id; S.selectedNodeId = id;
        const want = '标题' + node.level;
        const label = appEl.querySelector('.level-label');
        if (label && label.textContent !== want) label.textContent = want;
        const dot = appEl.querySelector('.toolbar .color-dot');
        if (dot) { const c = nodeColor(node); if (dot.style.background !== c) dot.style.background = c; }
      } catch (e) { }
    }, false);
  }

  /* ============================== 持久化 ============================== */
  const STORE = 'liji_store';
  function lsGet(k, def) { try { const v = localStorage.getItem(STORE + ':' + k); return v == null ? def : v; } catch (e) { return def; } }
  /* ★ 写失败（配额满）必须出声。
   * 原来这里是 `catch (e) { }` —— 静默吞掉的后果是「用户以为存上了，重启就没了」，
   * 而图片是 base64 内嵌的，一张 2MB 的图就要占约 2.7MB 的配额，很容易把 localStorage 撑满。
   * 提示只发一次，别让 400ms 的防抖把它变成刷屏；存成功了再把闸门放开。 */
  let quotaWarned = false;
  function lsSet(k, v) {
    try { localStorage.setItem(STORE + ':' + k, v); return true; }
    catch (e) {
      if (!quotaWarned) {
        quotaWarned = true;
        showNotice('本机存储已满，这次改动没能存到本地 —— 请删掉一些图片或文档后重试');
      }
      return false;
    }
  }
  function scheduleSave() {
    if (saveTimer !== -1) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
    scheduleCloudPush();
  }
  /* 低频的**一次性动作**（新建 / 重命名 / 删除文件夹、移动文档）用这个：立即落盘，不等 400ms。
     理由：这类动作之后用户很可能马上刷新或关页面，而防抖那 400ms 正好会吃掉改动
     （真浏览器实测踩到过：点完「移动到文件夹」立刻刷新，文件夹还在、文档归属没了）。
     打字那种高频场景才需要防抖，保持 scheduleSave 不变。
     云推送仍是防抖的（1.2 秒且要发网络请求），两者不冲突。 */
  function saveNowAndPush() {
    if (saveTimer !== -1) { clearTimeout(saveTimer); saveTimer = -1; }
    saveNow();
    scheduleCloudPush();
  }
  function saveNow() {
    try {
      const ok = lsSet('documents', JSON.stringify(S.documents));
      lsSet('activeDocId', String(S.activeDocId));
      lsSet('folders', JSON.stringify(S.folders));
      lsSet('seeded', 'true');
      if (ok) quotaWarned = false;
    } catch (e) { }
  }
  function restoreDocuments() {
    try {
      /* 读回「上次关闭前还有改动没推上去」的标记 —— 它决定启动同步时是本机赢还是云端赢 */
      docsDirty = lsGet('docsDirty', '0') === '1';
      if (lsGet('seeded', 'false') !== 'true') return;
      const rawF = lsGet('folders', '');
      if (rawF) { const f = JSON.parse(rawF); if (Array.isArray(f)) S.folders = f.filter(x => x && x.id); }
      const raw = lsGet('documents', '');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed.length) return;
      S.documents = parsed;
      syncFoldersFromDocs();
      const savedId = parseInt(lsGet('activeDocId', '0'), 10);
      const hit = parsed.find(d => d.id === savedId);
      S.activeDocId = hit === undefined ? parsed[0].id : savedId;
      S.docTitle = selectedDocument().title;
    } catch (e) { }
  }

  /* ============================== 对象存储同步（轻享版的「云端」） ==============================
   * -------------------------------------------------------------------------------------------
   * 与正式版只差「云端是谁」：那边是自建服务端 + 账号，这边是用户自己的桶。
   * 同步的**时机与冲突处理**完全沿用原来那一套（脏标记、防抖、启动比对），
   * 一行都没重写 —— 那些逻辑是踩出来的（见 markDocsDirty 的注释），换后端时照搬最安全。
   *
   * 云端放两个对象：
   *   <prefix>documents.json   文档库本体
   *   <prefix>meta.json        { updatedAt, docs, bytes, device }，只用来判断「云端有没有变」
   * 为什么要多一个 meta：跨域读不到 ETag / Last-Modified（它们不在默认暴露头里，
   * 要用户去桶上配 Expose-Headers），而 meta 是个普通对象，GET 就能拿到，零额外配置。
   * ========================================================================================== */
  const OSS_DOC_KEY = 'documents.json';
  const OSS_META_KEY = 'meta.json';
  /* ★ 密钥**不**进 liji_store：那份键是「文档库」，会被导出 / 导入带着走，
   *   把 AccessKey 混进去等于用户分享文档时顺手把桶的钥匙发出去了。 */
  const OSS_STORE = 'liji_oss_config';
  const OSS_STATE_KEY = 'liji_oss_state';

  function ossClient() { return (typeof window !== 'undefined' && window.LiJiOSS) ? window.LiJiOSS : null; }
  function ossReady() { return !!(S.ossOn && S.ossCfg && ossClient()); }
  function deviceName() {
    try { return String((navigator.platform || '') + ' ' + (navigator.userAgent || '')).slice(0, 60).trim(); }
    catch (e) { return ''; }
  }
  function loadOssConfig() {
    try {
      const raw = localStorage.getItem(OSS_STORE);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && c.bucket) {
          S.ossCfg = ossClient() ? ossClient().normalize(c) : c;
          S.ossOn = c.enabled !== false;
        }
      }
    } catch (e) { }
    try {
      const st = JSON.parse(localStorage.getItem(OSS_STATE_KEY) || '{}');
      ossState.syncedAt = Number(st.syncedAt) || 0;
      ossState.remoteUpdatedAt = Number(st.remoteUpdatedAt) || 0;
      ossState.device = String(st.device || '');
      ossState.rev = Number(st.rev) || 0;
      ossState.base = (st.base && typeof st.base === 'object') ? st.base : null;
      /* .md 镜像的「上次推了什么」也要落盘（docId → 桶里 key / 内容指纹），
         否则刷新后丢基准：改名/删除的旧文件删不掉，内容变没变也判断不出。
         ★ mirrorVer：2026-10-09 之前的版本把「传失败的」也记成了「已传」（签名 bug 期间的坏账），
           靠版本号强制重镜像一次——传过的有内容指纹挡着，只补缺的，不会重复上传。 */
      if (Number(st.mirrorVer) === 2) {
        ossState.mirrorMap = (st.mirrorMap && typeof st.mirrorMap === 'object') ? st.mirrorMap : null;
        ossState.mirrorHashes = (st.mirrorHashes && typeof st.mirrorHashes === 'object') ? st.mirrorHashes : null;
        ossState.mirrorDead = Array.isArray(st.mirrorDead) ? st.mirrorDead : [];
      } else {
        ossState.mirrorMap = null; ossState.mirrorHashes = null; ossState.mirrorDead = [];
      }
    } catch (e) { }
  }
  function saveOssConfig() {
    try {
      if (!S.ossCfg) { localStorage.removeItem(OSS_STORE); return; }
      localStorage.setItem(OSS_STORE, JSON.stringify(Object.assign({}, S.ossCfg, { enabled: S.ossOn })));
    } catch (e) { showNotice('对象存储配置没能存到本机（本机存储可能已满）'); }
  }
  function saveOssState() {
    try { localStorage.setItem(OSS_STATE_KEY, JSON.stringify(Object.assign({}, ossState, { mirrorVer: 2 }))); } catch (e) { }
  }
  function dateText(ts) {
    if (!ts) return '';
    const d = new Date(ts), p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function hhmmText(ts) {
    if (!ts) return '';
    const d = new Date(ts), p = n => (n < 10 ? '0' : '') + n;
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function cloudText() {
    if (!S.ossCfg) return '未启用 · 文档只存在本机';
    if (!S.ossOn) return '已配置但已暂停 · 文档只存在本机';
    if (S.cloudState === 'syncing') return '正在同步…';
    if (S.cloudState === 'error') return '同步失败：' + (S.cloudMsg || '未知错误');
    if (S.lastSyncAt) return '已同步 · ' + hhmmText(S.lastSyncAt) + ' · 共 ' + S.documents.length + ' 篇';
    if (S.cloudMsg) return S.cloudMsg;
    return '已启用对象存储';
  }
  /* 只更新状态文字，不整体重渲染 —— 避免打断正在输入的大纲 */
  function paintCloud() {
    const el = appEl.querySelector('[data-cloud]');
    if (el) el.textContent = cloudText();
  }
  /* 同步流程里安全的渲染：只有「不在编辑器里打字」时才整体重渲染 */
  function renderAllowEditing() { if (!S.showEditor) render(); else paintCloud(); }

  /* ★「本机有还没推上去的改动」这个标记**必须落盘**（2026-09-24 实测踩到）。
     起因：改完 1.2 秒内刷新页面 —— 推送还在防抖窗口里，
     刷新后启动同步一看「云端有文档」就拿旧的那份把本机盖掉，改动当场丢失。
     所以标记不能只放在内存里 —— 刷新后内存归零，等于没记。 */
  function markDocsDirty(v) {
    docsDirty = !!v;
    try { lsSet('docsDirty', v ? '1' : '0'); } catch (e) { }
  }

  /* ---------- 云端 ↔ 本机的两次搬运 ---------- */
  function syncPayload() {
    return JSON.stringify({
      v: 1, app: 'liji-lite', updatedAt: Date.now(), device: deviceName(),
      documents: S.documents, folders: S.folders
    });
  }
  /* ---------- 多设备冲突：乐观锁 + 三方按文档合并 ----------
   * 问题（用户实测会遇到）：两台设备绑同一个桶，A 刚推完，B 停留在旧快照上再推 ——
   * 旧文件把云端的新文件整个盖掉。根因是「盲推」：推之前不看云端有没有自己没见过的更新。
   * 解法（推送前先读 meta）：
   *   ① meta 带 rev（版本号，每次推送 +1）；本机记下「上次同步时的 rev」。
   *   ② 推送时发现云端 rev ≠ 本机记的 rev → 云端有本机没见过的改动 → **不直接盖**，先合并。
   *   ③ 合并 = 三方（共同祖先 base / 本机 / 云端）**按文档**比对：
   *       只有本机改过 → 本机赢；只有云端改过 → 云端赢；两边都改了 → **保双份**（云端那份插为
   *       「云端副本」，谁也不丢，用户自己合）；本机删了云端没动 → 跟着删；本机删了云端又改 → 抢救成副本。
   *   base 用「上次同步后每篇文档的内容指纹」（djb2，剔除展示用的 updatedAt 字符串——
   *   那是「刚刚更新 / 昨天」这种相对文案，两次算出来必然不同，会把没改的文档误判成改过）。
   * 代价：推送前多一次 GET meta（幂等读，几乎不要钱）；换来的性质是「任何一次推送都不会静默丢数据」。 */
  function docHash(d) {
    try {
      const copy = Object.assign({}, d);
      delete copy.updatedAt;      // 展示用相对文案，不参与内容比对
      const s = JSON.stringify(copy);
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      return 'h' + (h >>> 0).toString(36) + '-' + s.length.toString(36);
    } catch (e) { return 'h_err_' + d.id; }
  }
  function docHashes(docs) {
    const m = {};
    (docs || []).forEach(d => { m[d.id] = docHash(d); });
    return m;
  }
  function freshDocId(taken) {
    let id, guard = 0;
    do { id = Math.floor(100000 + Math.random() * 899999); guard++; }
    while (taken.indexOf(id) >= 0 && guard < 50);
    return id;
  }
  /* 三方合并文档库。localDocs / cloudDocs 是两边的当前文档数组，base 是上次同步时的指纹表。 */
  function mergeLibrary(localDocs, cloudDocs, base) {
    const baseMap = base || {};
    const cloudMap = {}, localMap = {}, taken = [];
    (cloudDocs || []).forEach(d => { cloudMap[d.id] = d; taken.push(d.id); });
    (localDocs || []).forEach(d => { localMap[d.id] = d; if (taken.indexOf(d.id) < 0) taken.push(d.id); });
    const cloudHashes = docHashes(cloudDocs);
    const out = [];
    const stats = { fromCloud: 0, keptLocal: 0, dup: 0, dropped: 0 };
    (localDocs || []).forEach(d => {
      const c = cloudMap[d.id];
      if (!c) {
        const bh = baseMap[d.id];
        if (bh !== undefined && bh === docHash(d)) {
          stats.dropped++;        // 本机没动过它、云端却不见了 → 云端删了，跟着删
        } else {
          out.push(d); stats.keptLocal++;   // 本机新增；或本机改过而云端没有 → 以本机为准
        }
        return;
      }
      const lh = docHash(d), ch = cloudHashes[d.id], bh = baseMap[d.id];
      const localChanged = bh === undefined ? true : bh !== lh;
      const cloudChanged = bh === undefined ? true : bh !== ch;
      if (!localChanged) { out.push(c); stats.fromCloud++; }        // 本机没动 → 云端赢
      else if (!cloudChanged || lh === ch) { out.push(d); stats.keptLocal++; } // 只有本机动（或殊途同归）
      else {
        // 两边都改了且不一样 → 保双份：本机保原 id（界面正开着它），云端那份插为副本
        const copy = Object.assign({}, c);
        copy.id = freshDocId(taken); taken.push(copy.id);
        copy.title = (c.title || '无标题') + '（云端副本 ' + hhmmText(Date.now()) + '）';
        out.push(copy); out.push(d); stats.dup++;
      }
    });
    (cloudDocs || []).forEach(c => {
      if (localMap[c.id]) return;
      if (baseMap[c.id] !== undefined) {
        // 本机上次见过它 → 是本机删的。云端后来又改过 → 抢救回来；云端没动 → 尊重删除
        if (cloudHashes[c.id] !== baseMap[c.id]) {
          const copy = Object.assign({}, c);
          copy.id = freshDocId(taken); taken.push(copy.id);
          copy.title = (c.title || '无标题') + '（云端改过 · 本机已删）';
          out.push(copy); stats.dup++;
        }
      } else {
        out.push(c); stats.fromCloud++;   // 云端新增
      }
    });
    return { documents: out, stats: stats };
  }
  /* 文件夹清单合并：按 id 并集，同名冲突以本机为准（重命名冲突极少见，别过度设计） */
  function mergeFolders(localFolders, cloudFolders) {
    const out = [], seen = {};
    (localFolders || []).forEach(f => { if (f && f.id) { out.push(f); seen[f.id] = true; } });
    (cloudFolders || []).forEach(f => { if (f && f.id && !seen[f.id]) out.push(f); });
    return out;
  }
  /* 覆盖本机之前先把本机存一份。判据只有时间戳，万一两边时钟差得离谱，
     还能一键回到覆盖前那一份（见 restoreLocalBackup）。 */
  function backupLocalSnapshot() {
    try {
      localStorage.setItem(STORE + ':ossBackup', JSON.stringify({
        at: Date.now(), documents: S.documents, folders: S.folders, activeDocId: S.activeDocId
      }));
      S.ossBackupAt = Date.now();
    } catch (e) { }
  }
  function restoreLocalBackup() {
    try {
      const raw = localStorage.getItem(STORE + ':ossBackup');
      if (!raw) { showNotice('还没有可恢复的本机备份'); return; }
      const b = JSON.parse(raw);
      if (!b || !Array.isArray(b.documents) || !b.documents.length) { showNotice('备份是空的，没法恢复'); return; }
      S.documents = b.documents;
      S.folders = Array.isArray(b.folders) ? b.folders : [];
      S.activeDocId = b.activeDocId || b.documents[0].id;
      syncFoldersFromDocs();
      S.docTitle = selectedDocument().title;
      saveNow(); render();
      logOp('恢复本机备份', b.documents.length + ' 篇');
      showNotice('已回到云端覆盖前的本机版本（' + b.documents.length + ' 篇）');
    } catch (e) { showNotice('恢复失败：' + (e.message || e)); }
  }
  function applyRemote(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.documents)) throw new Error('云端那个对象不是理记的文档库');
    if (!data.documents.length) throw new Error('云端文档库是空的，已保留本机内容');
    S.documents = data.documents;
    /* 文件夹清单跟着文档一起来；云端没有（老数据）就保留本机的。
       之后 syncFoldersFromDocs 兜底：文档带着本机清单里没有的归属 → 补一条，
       否则那些文档在分组视图里会**无处可去**（看着像丢了）。 */
    if (Array.isArray(data.folders)) S.folders = data.folders.filter(f => f && f.id && f.name);
    syncFoldersFromDocs();
    if (!S.documents.some(d => d.id === S.activeDocId)) S.activeDocId = S.documents[0].id;
    S.docTitle = selectedDocument().title;
    saveNow();
    return { count: data.documents.length, meta: data };
  }
  async function ossReadMeta() {
    const OSS = ossClient();
    try {
      const r = await OSS.get(S.ossCfg, OSS_META_KEY);
      return { meta: JSON.parse(r.text), missing: false };
    } catch (e) {
      if (e.status === 404) return { meta: null, missing: true };
      throw e;
    }
  }
  async function ossPush() {
    const OSS = ossClient();
    /* ★ 乐观锁：推之前先看云端有没有「本机没见过的更新」。
       有 → 拿旧快照直接盖 = 把别的设备刚推的新数据整个抹掉（用户实测踩到的冲突）。
       改成先拉云端做三方按文档合并，再推合并结果 —— 任何一次推送都不会静默丢数据。 */
    const m = await ossReadMeta();
    const cloudRev = m.meta ? (Number(m.meta.rev) || 0) : 0;
    const localRev = Number(ossState.rev) || 0;
    const cloudChanged = !!m.meta && (m.meta.rev !== undefined
      ? cloudRev !== localRev
      : Number(m.meta.updatedAt || 0) > Number(ossState.remoteUpdatedAt || 0));   // 老版 meta 没有 rev → 退化用 updatedAt
    let merged = null;
    if (cloudChanged) {
      let cloudText = null;
      try { cloudText = (await OSS.get(S.ossCfg, OSS_DOC_KEY)).text; }
      catch (e) { if (e.status === 404) cloudText = null; else throw e; }
      if (cloudText) {
        const data = JSON.parse(cloudText);
        if (data && Array.isArray(data.documents)) {
          backupLocalSnapshot();               // 合并会动本机，先把现状留一份后路
          const mr = mergeLibrary(S.documents, data.documents, ossState.base);
          S.documents = mr.documents;
          S.folders = mergeFolders(S.folders, data.folders);
          syncFoldersFromDocs();
          if (!S.documents.some(d => d.id === S.activeDocId)) S.activeDocId = S.documents[0].id;
          S.docTitle = selectedDocument().title;
          saveNow();
          merged = mr.stats;
        }
      }
    }
    const body = syncPayload();
    await OSS.put(S.ossCfg, OSS_DOC_KEY, body);
    const rev = cloudRev + 1;
    const meta = {
      v: 2, rev: rev, updatedAt: Date.now(), docs: S.documents.length,
      bytes: body.length, device: deviceName(), app: 'liji-lite'
    };
    await OSS.put(S.ossCfg, OSS_META_KEY, JSON.stringify(meta));
    S.ossRemote = meta;
    ossState.rev = rev;
    ossState.base = docHashes(S.documents);    // 合并/推送后的本机状态 = 下次三方合并的「共同祖先」
    ossState.syncedAt = Date.now();
    ossState.remoteUpdatedAt = meta.updatedAt;
    ossState.device = meta.device;
    /* .md 源文件镜像 + 操作日志上桶：核心数据已经推成功，这两步**失败不影响正常同步** */
    await syncMirrorQuiet(OSS);
    await uploadOpLogQuiet(OSS);
    saveOssState();
    markDocsDirty(false);          // 推成功了才算真的干净；失败要保持脏，下次优先保本机
    S.cloudState = 'synced'; S.lastSyncAt = Date.now();
    if (merged && (merged.dup > 0 || merged.fromCloud > 0)) {
      const parts = [];
      if (merged.fromCloud > 0) parts.push('收下云端 ' + merged.fromCloud + ' 篇');
      if (merged.dup > 0) parts.push(merged.dup + ' 篇两边都改过、各留了一份');
      S.cloudMsg = '检测到其他设备的改动，已自动合并（' + parts.join('，') + '）';
      logOp('自动合并', S.cloudMsg);
      showNotice(S.cloudMsg);
      if (typeof renderAllowEditing === 'function') renderAllowEditing();
    }
    meta.merged = merged || undefined;
    return meta;
  }
  /* 云端 → 本机。调用前必须确认「本机不脏」，否则会静默丢改动（见 ossStartupSync）。 */
  async function ossPull() {
    const OSS = ossClient();
    const r = await OSS.get(S.ossCfg, OSS_DOC_KEY);
    backupLocalSnapshot();
    const got = applyRemote(r.text);
    const m = await ossReadMeta();
    const meta = m.meta || { updatedAt: Date.now() };
    S.ossRemote = meta;
    ossState.remoteUpdatedAt = Number(meta.updatedAt) || Date.now();
    ossState.rev = Number(meta.rev) || 0;      // 老版 meta 没有 rev → 记 0，推送时靠 updatedAt 兜底判断
    ossState.base = docHashes(S.documents);
    ossState.syncedAt = Date.now();
    saveOssState();
    S.cloudState = 'synced'; S.lastSyncAt = Date.now();
    /* 拉完云端也要对齐镜像：其他设备删掉的文档，本地镜像里的 .md 也要跟着删 */
    await syncMirrorQuiet(OSS);
    return got.count;
  }

  /* ---------- 三种时机：启动 / 改动 / 轮询 ---------- */
  /* 启动：云端空 → 推本机；本机脏 → 推本机；云端新 → 拉云端；否则不动。 */
  async function ossStartupSync() {
    if (!ossReady()) { S.cloudMsg = '未启用对象存储同步 · 文档只存在本机'; return; }
    S.cloudState = 'syncing'; S.cloudMsg = ''; renderAllowEditing();
    try {
      const m = await ossReadMeta();
      if (m.missing || !m.meta) {
        await ossPush();
        S.cloudMsg = '云端还是空的，已把本机 ' + S.documents.length + ' 篇文档上传';
      } else if (docsDirty) {
        const r = await ossPush();
        S.cloudMsg = (r && r.merged)
          ? '云端有其他设备的改动，已自动合并并上传（现 ' + S.documents.length + ' 篇）'
          : '本机有没传上去的改动，已上传到云端（' + S.documents.length + ' 篇）';
      } else if (Number(m.meta.updatedAt || 0) > Number(ossState.remoteUpdatedAt || 0)) {
        const n = await ossPull();
        S.cloudMsg = '已从对象存储载入 ' + n + ' 篇文档（云端更新于 ' + hhmmText(m.meta.updatedAt) + '）';
      } else {
        S.ossRemote = m.meta;
        S.cloudMsg = '已是最新 · 共 ' + S.documents.length + ' 篇';
      }
      S.cloudState = 'synced';
      logOp('启动同步', S.cloudMsg);
    } catch (e) {
      S.cloudState = 'error';
      S.cloudMsg = e.message || ('同步失败（' + (e.status || '') + '）');
      logOp('启动同步失败', S.cloudMsg);
    }
    renderAllowEditing();
  }
  /* 改动后 1.2 秒推一次（防抖）。没启用同步时只记脏标记 —— 那一秒里刷新也不至于丢改动。 */
  function scheduleCloudPush() {
    markDocsDirty(true);
    if (!ossReady()) return;
    if (cloudTimer !== -1) clearTimeout(cloudTimer);
    cloudTimer = setTimeout(ossPushQuiet, 1200);
  }
  async function ossPushQuiet() {
    if (!ossReady()) return;
    S.cloudState = 'syncing'; paintCloud();
    try { await ossPush(); S.cloudMsg = ''; }
    catch (e) { S.cloudState = 'error'; S.cloudMsg = e.message || '同步失败'; }
    paintCloud();
  }
  /* 轮询：每 60 秒看一眼云端 meta（只在「本机不脏」时才可能拉 —— 脏着拉会丢改动）。
     页面在后台时不查，省电也省请求。 */
  function startPolling() {
    if (pollTimer !== -1) return;
    pollTimer = setInterval(() => {
      if (!ossReady() || docsDirty) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      ossCheckRemote();
    }, 60000);
  }
  async function ossCheckRemote() {
    try {
      const m = await ossReadMeta();
      if (m.missing || !m.meta) { await ossPushQuiet(); return; }
      S.ossRemote = m.meta;
      if (Number(m.meta.updatedAt || 0) > Number(ossState.remoteUpdatedAt || 0)) {
        const n = await ossPull();
        renderAllowEditing();
        showNotice('检测到云端有新改动，已同步到本地（' + n + ' 篇文档）');
      }
    } catch (e) { /* 轮询失败不打扰：多半是临时断网，下次轮询再来 */ }
  }

  /* ---------- 手动动作 ---------- */
  async function syncNow() {
    if (!ossReady()) {
      S.tab = '个人中心'; S.ossFormOpen = true; render();
      showNotice('先在「个人中心」里填好对象存储的配置');
      return;
    }
    const wasError = S.cloudState === 'error';
    await ossPushQuiet();
    logOp('手动同步', S.cloudState === 'error' ? '失败：' + (S.cloudMsg || '') : '完成');
    showNotice(S.cloudState === 'error'
      ? ('同步失败：' + (S.cloudMsg || ''))
      : (wasError ? '已恢复同步' : '已同步到对象存储'));
  }
  /* 明确的两向覆盖：时间戳判据在「两边都改过」时只能二选一，把选择权交还给用户 */
  async function ossForcePull() {
    if (!ossReady()) { showNotice('还没启用对象存储同步'); return; }
    S.cloudState = 'syncing'; renderAllowEditing();
    try {
      const n = await ossPull();
      logOp('用云端覆盖本机', n + ' 篇');
      renderAllowEditing();
      showNotice('已用云端覆盖本机（' + n + ' 篇）—— 覆盖前的本机版本可在下面一键找回');
    } catch (e) {
      S.cloudState = 'error'; S.cloudMsg = e.message || '同步失败';
      renderAllowEditing(); showNotice('同步失败：' + S.cloudMsg);
    }
  }
  async function ossForcePush() {
    if (!ossReady()) { showNotice('还没启用对象存储同步'); return; }
    S.cloudState = 'syncing'; renderAllowEditing();
    try {
      await ossPush();
      logOp('用本机覆盖云端', S.documents.length + ' 篇');
      renderAllowEditing();
      showNotice('已用本机覆盖云端（' + S.documents.length + ' 篇）');
    } catch (e) {
      S.cloudState = 'error'; S.cloudMsg = e.message || '同步失败';
      renderAllowEditing(); showNotice('同步失败：' + S.cloudMsg);
    }
  }
  /* 「测试连接」：写入探针再删掉 —— 只 GET 验不出「能写」 */
  async function ossTestConnection() {
    if (S.ossTesting) return;
    const OSS = ossClient();
    if (!OSS) { S.ossMsg = '对象存储模块没加载（oss.js 没引到？）'; S.ossMsgKind = 'err'; render(); return; }
    /* ★ 取值判据：表单展示期间（S.ossDraft 非空）一律用草稿。
     *   旧写法 `(S.ossFormOpen && S.ossDraft) ? S.ossDraft : S.ossCfg` 有个死角：
     *   从没保存过配置时，表单是 `!S.ossCfg` 直接展开的，S.ossFormOpen 仍是 false ——
     *   用户填了一整屏，点「测试连接」却拿 S.ossCfg（null）去校验 → 报「请填写 Bucket 名称」。
     *   （2026-10-06 用户实测踩中；真浏览器复现：报错时 draft.bucket 明明有值。） */
    const cfg = S.ossDraft ? S.ossDraft : (S.ossCfg || {});
    const v = OSS.validate(cfg || {});
    if (!v.ok) { S.ossMsg = v.msg; S.ossMsgKind = 'err'; render(); return; }
    S.ossTesting = true; S.ossMsg = '正在连接…'; S.ossMsgKind = ''; render();
    const r = await OSS.test(cfg);
    S.ossTesting = false;
    S.ossMsg = r.ok ? r.msg : ('连接失败：' + r.msg);
    S.ossMsgKind = r.ok ? 'ok' : 'err';
    render();
  }
  /* 保存配置：先本地校验，再让用户自己决定要不要顺手测一次。
     保存即启用 —— 用户填完这一屏，下一步自然是「开始同步」。 */
  function ossSaveConfig(next) {
    const OSS = ossClient();
    const cfg = OSS ? OSS.normalize(next) : next;
    const v = OSS ? OSS.validate(cfg) : { ok: !!(cfg.bucket && cfg.ak && cfg.sk), msg: '请填全 Bucket 与密钥' };
    if (!v.ok) { S.ossMsg = v.msg; S.ossMsgKind = 'err'; render(); return; }
    S.ossCfg = cfg; S.ossOn = true; S.ossFormOpen = false;
    S.ossMsg = '配置已保存到本机，正在同步…'; S.ossMsgKind = 'ok';
    /* 换了个桶 = 换了个云端：本机记住的「云端版本」必须清零，
       否则新桶里那份会被当成旧的、不拉也不推。 */
    ossState.remoteUpdatedAt = 0; ossState.syncedAt = 0;
    saveOssConfig(); saveOssState();
    render();
    ossStartupSync();
  }
  function ossClearConfig() {
    S.ossCfg = null; S.ossOn = false; S.ossRemote = null;
    S.cloudState = 'idle'; S.cloudMsg = ''; S.lastSyncAt = 0;
    ossState.remoteUpdatedAt = 0; ossState.syncedAt = 0;
    try { localStorage.removeItem(OSS_STORE); } catch (e) { }
    saveOssState();
    render();
    showNotice('已断开对象存储，文档仍然存在本机');
    logOp('断开对象存储', '文档只存在本机');
  }

  /* ============================== 操作日志（2026-10-09） ==============================
   * 记录用户的每次具体操作（文件/文件夹级 + 同步事件），方便用户事后检查。
   * 存两层：① 本机 localStorage 环形缓冲（500 条，超出丢最旧的）；
   *         ② 每台设备一个 logs/<设备名>.jsonl 上传到桶 —— 按设备分文件就**永远没有
   *            合并冲突**（谁也不写别人的文件），整文件覆盖写即可。 */
  const OP_LOG_LS = 'liji_op_log';
  const OP_LOG_MAX = 500;
  let opLogCache = null;
  function opLog() {
    if (opLogCache) return opLogCache;
    try { opLogCache = JSON.parse(localStorage.getItem(OP_LOG_LS) || '[]'); } catch (e) { opLogCache = []; }
    if (!Array.isArray(opLogCache)) opLogCache = [];
    return opLogCache;
  }
  function logOp(event, detail) {
    try {
      const arr = opLog();
      arr.push({ t: Date.now(), e: String(event || ''), d: String(detail || '') });
      if (arr.length > OP_LOG_MAX) arr.splice(0, arr.length - OP_LOG_MAX);
      localStorage.setItem(OP_LOG_LS, JSON.stringify(arr));
    } catch (e) { /* 存储满了也别影响正常操作 */ }
  }

  /* ============================== .md 源文件镜像（2026-10-09） ==============================
   * 需求：桶里要有「和前端一样」的文件夹分类 + 可读的 .md 源文件。
   * 为什么是「镜像」而不是把同步数据源换成 .md：文档里的图片 / 公式 / 加粗颜色是
   * 结构化数据（data: URL 内嵌在 JSON 里），md 表达不了 —— 拿 .md 当同步源会丢内容。
   * 所以同步引擎（documents.json + meta.json 乐观锁三方合并）原样保留，
   * 每次推送**顺带**把每篇文档写成 docs/<文件夹>/<文档名>.md：
   *   · 未分类的文档直接放 docs/ 根；
   *   · 名字做对象存储安全清洗（/:*?"<>| 等换成 -），同名文档加 -id 后缀防互覆盖；
   *   · ossState.mirrorMap 记住「上次每篇推到了哪个 key」→ 改名/移动 = 删旧 key 传新 key，
   *     删除文档 = 删 key；内容指纹没变的跳过，不做无谓的上传。
   * 桶里的「文件夹」就是 key 的 / 前缀 —— 控制台会显示成目录。 */
  const MIRROR_DIR = 'docs/';
  function sanitizePathSeg(s, fallback) {
    let t = String(s || '').trim().replace(/\s+/g, ' ');
    ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '#', '%', '&', '{', '}', '$', '!', "'", ';', '+', '=', '@', '`', '^', '~']
      .forEach(c => { t = t.split(c).join('-'); });
    t = t.replace(/[\u0000-\u001f]/g, '').replace(/[. ]+$/g, '');
    t = t.slice(0, 60).trim();
    return t || fallback;
  }
  function mirrorKeyForDoc(d, usedKeys) {
    const fid = docFolderId(d);
    const dir = fid ? (sanitizePathSeg(folderName(fid), '未命名文件夹') + '/') : '';
    const base = sanitizePathSeg(d.title, '无标题');
    let key = MIRROR_DIR + dir + base + '.md';
    if (usedKeys[key] !== undefined && usedKeys[key] !== String(d.id)) {
      key = MIRROR_DIR + dir + base + '-' + d.id + '.md';     // 同文件夹同名文档：加 id 后缀，别让后写的把先写的盖了
      if (usedKeys[key] !== undefined && usedKeys[key] !== String(d.id)) {
        key = MIRROR_DIR + dir + base + '-' + d.id + '-' + Date.now() + '.md';
      }
    }
    usedKeys[key] = String(d.id);
    return key;
  }
  function docToMarkdown(d) {
    return '# ' + String(d.title || '无标题') + '\n\n' + serializeNodesToMd(d.nodes) + '\n';
  }
  async function syncMirror(OSS) {
    const used = {};
    const desired = {}, hashes = {};
    S.documents.forEach(d => {
      const k = mirrorKeyForDoc(d, used);
      desired[String(d.id)] = k;
      hashes[String(d.id)] = docHash(d);
    });
    const prevMap = ossState.mirrorMap || {};
    const prevHashes = ossState.mirrorHashes || {};
    const stillDead = (ossState.mirrorDead || []).slice();
    let ups = 0, dels = 0, errs = 0;
    const newMap = {}, newHashes = {};
    /* 没变的直接继承（成功过的才会在 prevMap 里） */
    for (const id in desired) {
      if (prevMap[id] === desired[id] && prevHashes[id] === hashes[id]) {
        newMap[id] = desired[id]; newHashes[id] = hashes[id];
      }
    }
    /* 上次没删掉的旧 key：重试；404 = 已经没了，也算成功 */
    const retried = {};
    for (const key of stillDead) {
      retried[key] = true;
      try { await OSS.del(S.ossCfg, key); dels++; }
      catch (e) { if (e.status !== 404) errs++; else dels++; }
    }
    /* 改名 / 移动：删旧 key（失败记入 dead 名单下次再删，**不能**当删成功记账） */
    for (const id in prevMap) {
      if (newMap[id] !== undefined) continue;
      if (desired[id] === prevMap[id]) continue;        // key 没变（内容变了）→ 走下面的 put
      if (retried[prevMap[id]]) continue;
      try { await OSS.del(S.ossCfg, prevMap[id]); dels++; }
      catch (e) {
        if (e.status !== 404) { errs++; stillDead.push(prevMap[id]); }
      }
    }
    /* 上传：失败**不记账**（不进 newMap）→ 下次同步自动重试 */
    for (const id in desired) {
      if (newMap[id] !== undefined) continue;
      const d = S.documents.filter(x => String(x.id) === String(id))[0];
      if (!d) continue;
      try { await OSS.put(S.ossCfg, desired[id], docToMarkdown(d)); ups++; newMap[id] = desired[id]; newHashes[id] = hashes[id]; }
      catch (e) { errs++; }
    }
    ossState.mirrorMap = newMap;
    ossState.mirrorHashes = newHashes;
    ossState.mirrorDead = stillDead;
    if (ups || dels || errs) saveOssState();
    return { ups: ups, dels: dels, errs: errs };
  }
  /* 推送收尾的镜像 + 日志上传：失败**不影响**正常同步（数据已经上去了），只记日志下次重试 */
  async function syncMirrorQuiet(OSS) {
    try {
      const r = await syncMirror(OSS);
      if (r && r.errs) logOp('同步', '源文件镜像有 ' + r.errs + ' 个文件没传上，下次同步重试');
      return r;
    } catch (e) {
      logOp('同步', '源文件镜像更新失败：' + (e.message || e));
      return null;
    }
  }
  async function uploadOpLogQuiet(OSS) {
    try { await OSS.put(S.ossCfg, opLogUploadKey(), JSON.stringify(opLog())); }
    catch (e) { /* 日志上传失败不打扰用户，下次同步再传 */ }
  }
  function opLogUploadKey() {
    return 'logs/' + sanitizePathSeg(deviceName(), 'device') + '.jsonl';
  }

  /* ============================== 回收站（2026-10-09） ==============================
   * 前提：桶开了「版本控制」—— 开着的时候 DELETE 只是打删除标记，旧版本都在，
   * 找回 = 把删除标记之前的最后一个版本读出来。
   * 规矩（按需求）：① 回收站功能默认关，用户在设置里手动打开；
   *                ② 每次使用前先**行为探测**桶有没有真的开版本控制（管理 API 要管理员
   *                  权限且 CORS 不放行，探测法只需要普通读写权限）；
   *                ③ 恢复 = 读旧版本的 .md → 解析成大纲 → 作为**副本**导入文档库（保双份
   *                  的老口径：谁也不覆盖谁）→ 走正常推送同步。
   * 注意：镜像的 .md 是纯文本，恢复回来的副本不含图片/公式原数据（镜像里没有的，找不回来）。 */
  function recycleEnabled() {
    try { return lsGet('recycleOn', '0') === '1'; } catch (e) { return false; }
  }
  function setRecycleEnabled(v) {
    try { lsSet('recycleOn', v ? '1' : '0'); } catch (e) { }
    S.recycleOn = !!v;
  }
  /* 探测桶的版本控制开关。返回 true / false / null（探测本身失败）。 */
  async function recycleCheck() {
    const OSS = ossClient();
    if (!ossReady() || !OSS || !OSS.probeVersioning) { showNotice('先配置并启用对象存储同步'); return null; }
    S.recycleMsg = '正在检测桶的版本控制…'; S.recycleBusy = true; render();
    try {
      const on = await OSS.probeVersioning(S.ossCfg);
      S.recycleMsg = on
        ? '✓ 检测通过：桶已开启版本控制，可以正常使用回收站'
        : '✗ 检测不到版本控制 —— 请先到对象存储控制台给这个桶开启「版本控制」，再回来点检测';
      return on;
    } catch (e) {
      S.recycleMsg = '检测失败：' + (e.message || e);
      return null;
    } finally {
      S.recycleBusy = false; render();
    }
  }
  /* 打开回收站列表：先检测版本控制，再列举 docs/ 下的删除标记 */
  async function recycleOpen() {
    if (!recycleEnabled()) { showNotice('回收站功能还没打开'); return; }
    if (!ossReady()) { showNotice('先配置并启用对象存储同步'); return; }
    const on = await recycleCheck();
    if (!on) { render(); return; }
    const OSS = ossClient();
    S.recycleMsg = '正在列出被删除的文件…'; S.recycleBusy = true; render();
    try {
      const items = await OSS.listVersions(S.ossCfg, MIRROR_DIR);
      /* 列举返回的 key 带配置前缀；getVersion 内部会再补一次 —— 先剥成相对 key 存下来 */
      const pre = (S.ossCfg && S.ossCfg.prefix) || '';
      const strip = k => (k.indexOf(pre) === 0 ? k.slice(pre.length) : k);
      const byKey = {};
      items.forEach(v => { (byKey[v.key] = byKey[v.key] || []).push(v); });
      const deleted = [];
      Object.keys(byKey).forEach(key => {
        const latest = byKey[key].filter(v => v.isLatest)[0];
        if (!latest || !latest.marker) return;            // 最新态不是删除标记 = 文件还在，不算被删
        const vers = byKey[key].filter(v => !v.marker).sort((a, b) => b.lastModified - a.lastModified);
        if (!vers[0]) return;                              // 只有标记没有旧版本（开版本控制之前就删了）→ 找不回
        deleted.push({ key: strip(key), deletedAt: latest.lastModified, versionId: vers[0].versionId });
      });
      deleted.sort((a, b) => b.deletedAt - a.deletedAt);
      S.recycleItems = deleted;
      S.recycleSheet = true;
      logOp('回收站', '查看了回收站（' + deleted.length + ' 个可恢复文件）');
    } catch (e) {
      showNotice('读取回收站失败：' + (e.message || e));
    }
    S.recycleBusy = false; render();
  }
  async function recycleRestore(item) {
    const OSS = ossClient();
    if (!OSS || S.recycleBusy) return;
    S.recycleBusy = true; render();
    try {
      const r = await OSS.getVersion(S.ossCfg, item.key, item.versionId);
      const nodes = parseMarkdownToNodes(r.text);
      if (!nodes.length) throw new Error('这个 .md 没解析出内容');
      const base = item.key.split('/').pop().replace(/\.md$/i, '') || '恢复的文档';
      const id = Date.now();
      const title = base + '（恢复 ' + hhmmText(Date.now()) + '）';
      /* 与 md 导入同一口径：展开式建文档对象（别白名单丢字段） */
      S.documents = [{ id: id, title: title, updatedAt: '刚刚恢复', template: '回收站恢复', nodes: nodes, children: [] }, ...S.documents];
      S.activeDocId = id; S.docTitle = title; S.editNodeId = nodes[0].id; S.selectedNodeId = nodes[0].id;
      saveNow();
      S.recycleSheet = false;
      logOp('回收站恢复', base + ' → ' + title);
      try { await ossPush(); } catch (e) { showNotice('文档已恢复到本机，但同步没成功：' + (e.message || e)); }
      render();
      showNotice('已恢复「' + base + '」为新文档' + (S.recycleMsg || ''));
      S.recycleMsg = '';
    } catch (e) {
      showNotice('恢复失败：' + (e.message || e));
    }
    S.recycleBusy = false; render();
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => showNotice('已复制：' + text),
          () => fallbackCopy(text));
        return;
      }
    } catch (e) { }
    fallbackCopy(text);
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showNotice('已复制：' + text);
    } catch (e) { showNotice('复制失败，请手动选择：' + text); }
  }

  /* ============================== 数据层 ============================== */
  function selectedDocument() {
    return S.documents.find(d => d.id === S.activeDocId) || S.documents[0];
  }
  function commitNodes(next) {
    const targetId = selectedDocument().id;
    /* ★ 用展开而不是字段白名单（2026-09-25）：文档对象的重建点漏一个字段就丢一个字段 ——
       先是 runs（buildTree），再是 desc（手补的），这次是 folder：白名单里没它，
       每次编辑完文档就掉回「未分类」。展开后以后新增文档级字段不用再想起这里。 */
    S.documents = S.documents.map(d => {
      if (d.id !== targetId) return d;
      return { ...d, nodes: next };
    });
    scheduleSave();
  }
  function patchNode(id, fn) {
    const nodes = selectedDocument().nodes;
    let hit = false;
    const next = nodes.map(n => {
      if (n.id !== id) return n;
      hit = true;
      const copy = { id: n.id, text: n.text, level: n.level, children: n.children, bold: n.bold, underline: n.underline, color: n.color, fontSize: n.fontSize, media: n.media, runs: n.runs };
      fn(copy);
      return copy;
    });
    if (hit) commitNodes(next);
  }
  function findNode(id) { return selectedDocument().nodes.find(n => n.id === id); }
  function nextId() { idSeed += 1; return Date.now() * 100 + (idSeed % 100); }
  function nodeCount(nodes) { return nodes.length; }

  function buildTree(nodes) {
    const root = [], stack = [];
    nodes.forEach(src => {
      const node = { id: src.id, text: src.text, level: src.level, children: [], bold: src.bold, underline: src.underline, color: src.color, fontSize: src.fontSize, media: src.media, runs: src.runs };
      while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop();
      if (stack.length === 0) root.push(node); else stack[stack.length - 1].children.push(node);
      stack.push(node);
    });
    return root;
  }

  /* ---- 样式解析（与导图共用） ---- */
  function levelFont(level) { return level <= 0 ? LEVEL_FONT_ROOT : Math.max(LEVEL_FONT_MIN, LEVEL_FONT_TOP - (level - 1) * LEVEL_FONT_STEP); }
  function nodeBold(n) { return n.bold === undefined ? n.level === 1 : n.bold; }
  function nodeUnderline(n) { return n.underline === undefined ? false : n.underline; }
  function nodeColor(n) { return n.color === undefined ? INK : n.color; }
  function nodeFontSize(n) { return n.fontSize === undefined ? levelFont(n.level) : n.fontSize; }
  function mapFont(node) { return nodeFontSize(node); }

  /* ---------- 行内样式 runs（2026-09-23：主题内的文字可选中单独设置样式） ----------
   * 数据：node.runs = [{s,e,b?,u?,c?,fz?}] —— 相对 node.text 的 [s,e) 区间（e 不含），
   * b/u 覆盖行级加粗/下划线，c 覆盖颜色，fz 是绝对字号。**可选增量字段**：
   * 鸿蒙端 / 旧数据没有它就当不存在，行为与从前完全一致；有它则忽略即不显示（不报错）。
   * 规范形：按 s 排序、互不重叠、相邻同样式合并、与行级样式相同的段落不留。 */
  function nodeRuns(n) { return Array.isArray(n.runs) ? n.runs : []; }
  function sameEffStyle(a, b) {
    return a.b === b.b && a.u === b.u && (a.c || null) === (b.c || null) && a.fz === b.fz;
  }
  function effStyle(node, off) {
    const st = { b: nodeBold(node), u: nodeUnderline(node), c: node.color || null, fz: nodeFontSize(node) };
    for (const r of nodeRuns(node)) {
      if (off >= r.s && off < r.e) {
        if (r.b !== undefined) st.b = r.b;
        if (r.u !== undefined) st.u = r.u;
        if (r.c) st.c = r.c;
        if (r.fz) st.fz = r.fz;
      }
    }
    return st;
  }
  /* 把整段文字按生效样式重新分组，产出规范 runs（只留与行级不同的段落） */
  function rebuildRuns(node) {
    const text = String(node.text || '');
    const runs = []; let cur = null;
    for (let i = 0; i < text.length; i++) {
      const st = effStyle(node, i);
      if (cur && sameEffStyle(cur.st, st)) { cur.e = i + 1; }
      else { cur = { s: i, e: i + 1, st: st }; runs.push(cur); }
    }
    const base = { b: nodeBold(node), u: nodeUnderline(node), c: node.color || null, fz: nodeFontSize(node) };
    const out = [];
    runs.forEach(g => {
      const st = g.st, item = { s: g.s, e: g.e };
      if (st.b !== base.b) item.b = st.b;
      if (st.u !== base.u) item.u = st.u;
      if ((st.c || null) !== (base.c || null)) item.c = st.c;
      if (st.fz !== base.fz) item.fz = st.fz;
      if (Object.keys(item).length > 2) out.push(item);
    });
    return out;
  }
  /* 对 [s,e) 应用一个样式补丁。patch: {toggleB} {toggleU} {c} {fzDelta}。
     区间内样式混合时的约定：加粗/下划线 = 「全有则取消，否则全有」；颜色 = 「相同则清除」；
     字号 = 以区间第一个字符的当前字号为基准整体 ±。 */
  function applyRunPatch(node, s, e, patch) {
    const text = String(node.text || ''); const len = text.length;
    s = Math.max(0, Math.min(len, Math.round(s)));
    e = Math.max(s, Math.min(len, Math.round(e)));
    if (e <= s) return false;
    // 先算区间内当前的统一目标值
    const first = effStyle(node, s);
    let target = null;
    /* abs：直接给定一套样式（「之后输入的字」用的就是这种），不做 toggle、不看区间内原来的样子 */
    if (patch.abs) { target = { b: !!patch.b, u: !!patch.u, c: patch.c || null, fz: patch.fz || first.fz }; }
    else if (patch.toggleB) { let all = true; for (let i = s; i < e; i++) if (!effStyle(node, i).b) { all = false; break; } target = { b: !all }; }
    else if (patch.toggleU) { let all = true; for (let i = s; i < e; i++) if (!effStyle(node, i).u) { all = false; break; } target = { u: !all }; }
    else if (patch.c !== undefined) { let same = true; for (let i = s; i < e; i++) if ((effStyle(node, i).c || null) !== (patch.c || null)) { same = false; break; } target = { c: same ? (node.color || null) : patch.c }; }
    else if (patch.fzDelta) { target = { fz: Math.min(40, Math.max(12, first.fz + patch.fzDelta)) }; }
    if (!target) return false;
    // 逐下标生成新样式再整体重组（effStyle 读旧的 node.runs，目标值单独叠加）
    const newRuns = [];
    const old = nodeRuns(node);
    for (let i = 0; i < len; i++) {
      const st = effStyle(node, i);
      if (i >= s && i < e) {
        if (target.b !== undefined) st.b = target.b;
        if (target.u !== undefined) st.u = target.u;
        if (target.c !== undefined) st.c = target.c;
        if (target.fz !== undefined) st.fz = target.fz;
      }
      const prev = newRuns[newRuns.length - 1];
      if (prev && prev._st && sameEffStyle(prev._st, st)) { prev.e = i + 1; }
      else newRuns.push({ s: i, e: i + 1, _st: st });
    }
    // 重组为规范 runs：与行级样式相同的段不留
    const base = { b: nodeBold(node), u: nodeUnderline(node), c: node.color || null, fz: nodeFontSize(node) };
    const out = [];
    newRuns.forEach(g => {
      const st = g._st, item = { s: g.s, e: g.e };
      if (st.b !== base.b) item.b = st.b;
      if (st.u !== base.u) item.u = st.u;
      if ((st.c || null) !== (base.c || null)) item.c = st.c;
      if (st.fz !== base.fz) item.fz = st.fz;
      if (Object.keys(item).length > 2) out.push(item);
    });
    node.runs = out;
    return true;
  }
  function mergeRunList(list) {
    const out = [];
    list.slice().sort((a, b) => a.s - b.s).forEach(r => {
      const l = out[out.length - 1];
      if (l && l.e === r.s && l.b === r.b && l.u === r.u && (l.c || null) === (r.c || null) && (l.fz || null) === (r.fz || null)) l.e = r.e;
      else out.push(r);
    });
    return out;
  }
  /* 行内文字被编辑后平移 runs：公共前缀/后缀不动，被替换的区间截断/平移 */
  function shiftRuns(oldText, newText, runs) {
    const ol = oldText.length, nl = newText.length;
    let p = 0; while (p < ol && p < nl && oldText[p] === newText[p]) p++;
    let sx = 0; while (sx < ol - p && sx < nl - p && oldText[ol - 1 - sx] === newText[nl - 1 - sx]) sx++;
    const delta = nl - ol, cutEnd = ol - sx;
    const out = [];
    (runs || []).forEach(r => {
      if (r.e <= p) { out.push(clampRunProps(r)); return; }
      if (r.s >= cutEnd) { out.push(clampRunProps({ s: r.s + delta, e: r.e + delta, b: r.b, u: r.u, c: r.c, fz: r.fz })); return; }
      if (r.s < p) out.push(clampRunProps({ s: r.s, e: Math.min(r.e, p), b: r.b, u: r.u, c: r.c, fz: r.fz }));
      if (r.e > cutEnd) out.push(clampRunProps({ s: Math.max(r.s, cutEnd) + delta, e: r.e + delta, b: r.b, u: r.u, c: r.c, fz: r.fz }));
    });
    return mergeRunList(out.filter(r => r.e > r.s));
  }
  function clampRunProps(r) {
    const item = { s: r.s, e: r.e };
    if (r.b !== undefined) item.b = !!r.b;
    if (r.u !== undefined) item.u = !!r.u;
    if (r.c !== undefined && r.c !== null) item.c = r.c;
    if (r.fz !== undefined && r.fz !== null) item.fz = Math.min(40, Math.max(12, Math.round(r.fz)));
    return item;
  }
  function linkColor(level) { return level <= 1 ? CONN_1 : CONN_2; }
  function mapRootNode() { return { id: -1, text: S.docTitle, level: 0, children: buildTree(selectedDocument().nodes) }; }

  /* ============================== 思维导图布局引擎 ============================== */
  // 文本按内容自动分行（CJK 逐字、拉丁按词），保证完整展示
  // 量宽优先用 canvas 真实字体度量（与 CSS 字体完全一致）；估算仅作兜底。
  // 若用估算（CJK=fs）会偏窄 → 浏览器按真实字体二次换行 → 多出孤字、文本溢出边框。
  function charW(ch, fs) { return ch.charCodeAt(0) < 128 ? fs * 0.6 : fs; }
  let _mctx = null, _fontFamily = null;
  function measureFont() {
    if (_fontFamily === null) {
      try { _fontFamily = getComputedStyle(document.body).fontFamily || FONT; } catch (e) { _fontFamily = FONT; }
    }
    return _fontFamily;
  }
  function strW(s, fs, bold) {
    if (_mctx === null) {
      try { _mctx = document.createElement('canvas').getContext('2d'); } catch (e) { _mctx = false; }
    }
    if (_mctx) { _mctx.font = (bold ? 'bold ' : '') + fs + 'px ' + measureFont(); return _mctx.measureText(s).width; }
    let w = 0; for (let i = 0; i < s.length; i++) w += charW(s[i], fs); return w;
  }
  function tokenizeEx(text) {
    const toks = []; let buf = '', bufS = 0, i = 0;
    for (const ch of text) {
      if (/\s/.test(ch)) { if (buf) { toks.push({ t: buf, s: bufS }); buf = ''; } toks.push({ t: ' ', s: i }); }
      else if (ch.charCodeAt(0) > 127) { if (buf) { toks.push({ t: buf, s: bufS }); buf = ''; } toks.push({ t: ch, s: i }); }
      else { if (!buf) bufS = i; buf += ch; }
      i += ch.length;
    }
    if (buf) toks.push({ t: buf, s: bufS });
    return toks;
  }
  function tokenize(text) { return tokenizeEx(text).map(x => x.t); }
  function wrapLines(text, maxW, fs, bold) { return wrapLinesEx(text, maxW, fs, bold, null).map(l => l.t); }
  /* 带偏移版本：styleAt(offset) 给出该字的 {fs,bold}（行内 runs 用）。
   * 返回 [{t, s, e}] —— t 是折行后的行文本，[s,e) 是它在**原文字**里的区间（供按 run 渲染）。 */
  function wrapLinesEx(text, maxW, fs, bold, styleAt) {
    if (!text) return [{ t: '', s: 0, e: 0 }];
    if (text.indexOf('\n') >= 0) {
      const out = []; let base = 0;
      text.split('\n').forEach(seg => {
        const ls = wrapLinesEx(seg, maxW, fs, bold, styleAt ? (off => styleAt(base + off)) : null);
        ls.forEach(l => out.push({ t: l.t, s: base + l.s, e: base + l.e }));
        base += seg.length + 1;
      });
      return out.length ? out : [{ t: '', s: 0, e: 0 }];
    }
    const toks = tokenizeEx(text);
    const tokW = (tk, off) => {
      if (!styleAt) return strW(tk, fs, bold);
      let w = 0, o = off;
      for (const ch of tk) { const st = styleAt(o); w += strW(ch, st.fs, st.bold); o += ch.length; }
      return w;
    };
    const lines = []; let line = '', lineS = 0, lineE = 0, lineW = 0;
    for (const tk of toks) {
      if (line === '' && tk.t === ' ') continue; // 行首不保留空格
      const w = tokW(tk.t, tk.s);
      if (lineW + w <= maxW || line === '') {
        if (line === '') lineS = tk.s;
        line += tk.t; lineW += w;
        if (tk.t !== ' ') lineE = tk.s + tk.t.length;
      } else {
        if (line) lines.push({ t: line.replace(/\s+$/, ''), s: lineS, e: lineE });
        line = ''; lineW = 0;
        let part = '', pw = 0, partS = tk.s, partE = tk.s;
        for (const ch of tk.t) {
          const st = styleAt ? styleAt(partE) : null;
          const cw = styleAt ? strW(ch, st.fs, st.bold) : strW(ch, fs, bold);
          if (pw + cw > maxW && part !== '') { lines.push({ t: part.replace(/\s+$/, ''), s: partS, e: partE }); part = ''; pw = 0; partS = partE; }
          part += ch; partE += ch.length; pw += cw;
        }
        line = part; lineS = partS; lineE = partE; lineW = pw;
      }
    }
    if (line) lines.push({ t: line.replace(/\s+$/, ''), s: lineS, e: lineE });
    return lines.length ? lines : [{ t: '', s: 0, e: 0 }];
  }
  const MAP_BPADX = 16, MAP_BPADY = 12, MAP_BORD = 2, MAP_LH = 1.4;
  function nodeSize(node) {
    const fs = mapFont(node);
    const bold = node.level <= 0 ? true : nodeBold(node);
    const maxW = MAP_BOX_MAX - 2 * MAP_BPADX - 2 * MAP_BORD;
    /* 行内 runs：折行与测宽都要按每个字自己的字号/粗细来（styleAt）。
       没有 runs 时走原路径，7 种布局输出与从前逐字节一致。 */
    const runs = nodeRuns(node);
    if (runs.length > 0) {
      const styleAt = off => { const st = effStyle(node, off); return { fs: st.fz, bold: st.b }; };
      const lex = wrapLinesEx(node.text, maxW, fs, bold, styleAt);
      const lines = lex.map(l => l.t);
      const lineOffs = lex.map(l => ({ s: l.s, e: l.e }));
      const segW = l => {
        let w = 0, i = l.s;
        while (i < l.e) {
          const st = effStyle(node, i);
          let j = i + 1;
          while (j < l.e && sameEffStyle(effStyle(node, j), st)) j++;
          w += strW(node.text.slice(i, j), st.fz, st.b);
          i = j;
        }
        return w;
      };
      const lw = lex.length ? Math.max.apply(null, lex.map(segW)) : 0;
      const med = nodeMedia(node);
      let contentW = Math.ceil(lw), extraH = 0;
      if (med.length > 0) {
        const d = mediaFit(med[0], maxW, MAP_MEDIA_MAX_H);
        contentW = Math.max(contentW, d.w);
        extraH = Math.round(d.h + 6);
      }
      const w = Math.min(MAP_BOX_MAX, contentW + 2 * MAP_BPADX + 2 * MAP_BORD + 4);
      /* 行内可能有比行级更大的字号：行高按最大字号算，避免 DOM 里被裁掉 */
      const maxFz = Math.max.apply(null, [fs].concat(runs.map(r => r.fz || fs)));
      const h = Math.round(lines.length * maxFz * MAP_LH + extraH + 2 * MAP_BPADY + 2 * MAP_BORD);
      return { w: Math.max(64, w), h: Math.max(34, h), lines, lineOffs };
    }
    const lines = wrapLines(node.text, maxW, fs, bold);
    const lw = Math.max.apply(null, lines.map(l => strW(l, fs, bold)));
    /* 挂了公式/图片的节点：框里只画第一张（其余在编辑页里看），宽度取「文字宽 / 图宽」的较大者。
       没有 media 时 extraH 恒为 0、contentW 不变 —— 表达式形态与改动前完全一致，
       连舍入都不变，所以 7 种导图布局的输出不受任何影响。 */
    const med = nodeMedia(node);
    let contentW = Math.ceil(lw), extraH = 0;
    if (med.length > 0) {
      const d = mediaFit(med[0], maxW, MAP_MEDIA_MAX_H);
      contentW = Math.max(contentW, d.w);
      extraH = Math.round(d.h + 6);
    }
    // +4px 余量：吸收真实字体的亚像素误差，确保浏览器不会自行二次换行
    const w = Math.min(MAP_BOX_MAX, contentW + 2 * MAP_BPADX + 2 * MAP_BORD + 4);
    const h = Math.round(lines.length * fs * MAP_LH + extraH + 2 * MAP_BPADY + 2 * MAP_BORD);
    return { w: Math.max(64, w), h: Math.max(34, h), lines };
  }

  /* 取 [s,e) 内按生效样式分好段的片段（导图框 / 导出画布按段绘制用） */
  function spansForRange(node, s, e) {
    const text = String(node.text || '');
    const out = []; let i = s;
    while (i < e) {
      const st = effStyle(node, i);
      let j = i + 1;
      while (j < e && sameEffStyle(effStyle(node, j), st)) j++;
      out.push({ t: text.slice(i, j), fs: st.fz, b: st.b, u: st.u, c: st.c });
      i = j;
    }
    return out;
  }
  function pushBox(boxes, pads, node, x, y) {
    const center = node.level <= 0;
    const fs = mapFont(node);
    const sz = nodeSize(node);
    /* mediaBox 只在「框里有地方放图」的布局里给（pushBox 走的分支图/组织图/鱼骨图）。
       气泡图的圆是按文字直径定死的，塞图会被 overflow:hidden 裁掉，所以那边不给 —— 见 layoutBubble。 */
    const med = nodeMedia(node);
    const mediaBox = med.length > 0 ? mediaFit(med[0], MAP_BOX_MAX - 2 * MAP_BPADX - 2 * MAP_BORD, MAP_MEDIA_MAX_H) : null;
    boxes.push({
      key: '', x, y, w: sz.w, h: sz.h, text: node.text, sub: '',
      lines: sz.lines,
      lineOffs: sz.lineOffs || null,
      lineSpans: sz.lineOffs ? sz.lineOffs.map(l => spansForRange(node, l.s, l.e)) : null,
      font: fs, subFont: 10,
      bold: center ? true : nodeBold(node),
      underline: center ? false : nodeUnderline(node),
      fg: center ? '#FFFFFF' : nodeColor(node),
      subFg: MUTED,
      bg: center ? MOSS : (node.level === 1 ? '#FFFFFF' : '#F5FAF6'),
      border: center ? MOSS : (node.level === 1 ? '#3F6B4F' : '#5E8C6E'),
      borderW: center ? 0 : 2,
      radius: node.level <= 0 ? 14 : (node.level === 1 ? 12 : 9),
      nodeId: node.id,
      media: mediaBox ? med[0] : null,
      mediaBox: mediaBox
    });
    pads.push({ id: node.id, x, y, w: sz.w, h: sz.h });
  }
  function addSeg(segs, tag, x, y, w, h, angle, color) { segs.push({ key: tag, x, y, w, h, angle, color }); }
  function addH(segs, tag, x1, x2, y, color) { const len = Math.abs(x2 - x1); if (len <= 0.5) return; addSeg(segs, tag, Math.min(x1, x2), y - MAP_LINE_W / 2, len, MAP_LINE_W, 0, color); }
  function addV(segs, tag, x, y1, y2, color) { const len = Math.abs(y2 - y1); if (len <= 0.5) return; addSeg(segs, tag, x - MAP_LINE_W / 2, Math.min(y1, y2), MAP_LINE_W, len, 0, color); }
  function addLine(segs, tag, x1, y1, x2, y2, color) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy);
    if (len <= 0.5) return;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    addSeg(segs, tag, (x1 + x2) / 2 - len / 2, (y1 + y2) / 2 - MAP_LINE_W / 2, len, MAP_LINE_W, angle, color);
  }
  function normalizeLayout(layout) {
    if (layout.boxes.length === 0) return layout;
    let minX = 1e9, minY = 1e9, maxX = 0, maxY = 0;
    layout.boxes.forEach(b => { if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y; if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h; });
    const dx = minX < MAP_PAD ? MAP_PAD - minX : 0, dy = minY < MAP_PAD ? MAP_PAD - minY : 0;
    if (dx > 0 || dy > 0) {
      layout.boxes.forEach(b => { b.x += dx; b.y += dy; });
      layout.segs.forEach(s => { s.x += dx; s.y += dy; });
      maxX += dx; maxY += dy;
    }
    layout.width = Math.round(maxX + MAP_PAD);
    layout.height = Math.round(maxY + MAP_PAD);
    return layout;
  }
  function finalizeLayout(layout, style) {
    const fixed = normalizeLayout(layout);
    fixed.boxes.forEach(b => {
      b.key = style + '#b' + Math.round(b.x) + ',' + Math.round(b.y) + ',' + b.w + ',' + b.h + ',' + b.text + ',' + b.sub + ',' + b.font + ',' + b.fg + (b.bold ? 'b' : '-') + (b.underline ? 'u' : '-');
    });
    fixed.segs.forEach(s => {
      s.key = style + '#s' + Math.round(s.x) + ',' + Math.round(s.y) + ',' + Math.round(s.w) + ',' + Math.round(s.h) + ',' + Math.round(s.angle);
    });
    return fixed;
  }
  function branchMeasure(node, depth, top, boxes, pads, dir, baseX) {
    if (dir === undefined) dir = 1;
    if (baseX === undefined) baseX = MAP_PAD;
    const fs = mapFont(node);
    const { w, h } = nodeSize(node);
    const x = dir > 0 ? baseX + depth * MAP_COL : baseX - depth * MAP_COL - w;
    if (node.children.length === 0) { pushBox(boxes, pads, node, x, top); return h; }
    const start = boxes.length; let cursor = top; const kids = [];
    node.children.forEach(child => {
      cursor += branchMeasure(child, depth + 1, cursor, boxes, pads, dir, baseX) + MAP_VGAP;
      const kp = pads.find(it => it.id === child.id); if (kp !== undefined) kids.push(kp);
    });
    const childrenH = cursor - top - MAP_VGAP;
    const bandH = Math.max(h, childrenH);
    const shift = (bandH - childrenH) / 2;
    if (shift > 0.5) { for (let i = start; i < boxes.length; i++) { boxes[i].y += shift; pads[i].y += shift; } }
    let y = top + (bandH - h) / 2;
    if (kids.length > 0) { const fY = kids[0].y + kids[0].h / 2, lY = kids[kids.length - 1].y + kids[kids.length - 1].h / 2; const mid = (fY + lY) / 2; y = Math.min(Math.max(mid - h / 2, top), top + bandH - h); }
    pushBox(boxes, pads, node, x, y);
    return bandH;
  }
  function branchLinks(node, pads, segs, dir) {
    if (dir === undefined) dir = 1;
    const p = pads.find(it => it.id === node.id); if (p === undefined) return;
    const py = p.y + p.h / 2;
    node.children.forEach(child => {
      const c = pads.find(it => it.id === child.id); if (c === undefined) return;
      const cy = c.y + c.h / 2, color = linkColor(child.level);
      // 端点各向框内伸入 2px，避免亚像素渲染在接缝处留白（框在连线之上，多出部分被遮住）
      const pEdge = dir > 0 ? p.x + p.w - 2 : p.x + 2;
      const cEdge = dir > 0 ? c.x + 2 : c.x + c.w - 2;
      const midX = (pEdge + cEdge) / 2;
      addH(segs, 'bh1_' + child.id, pEdge, midX, py, color);
      addV(segs, 'bv_' + child.id, midX, py, cy, color);
      addH(segs, 'bh2_' + child.id, midX, cEdge, cy, color);
      branchLinks(child, pads, segs, dir);
    });
  }
  function layoutBranch() {
    const root = mapRootNode(); const boxes = [], pads = [];
    branchMeasure(root, 0, MAP_PAD, boxes, pads);
    let maxRight = 0, maxBottom = 0;
    pads.forEach(p => { if (p.x + p.w > maxRight) maxRight = p.x + p.w; if (p.y + p.h > maxBottom) maxBottom = p.y + p.h; });
    const width = Math.round(maxRight + MAP_PAD);
    if (S.mapStyle === '向左逻辑图') { boxes.forEach(b => b.x = width - b.x - b.w); pads.forEach(p => p.x = width - p.x - p.w); }
    /* 连线方向必须跟着镜像走：向左图里父框在右、子框在左，端点要取父框**左**缘 / 子框**右**缘。
     * 这里曾按默认 dir=1 画 —— 线从框背面的边出发，绕出乱麻（2026-09-23 用户截图报障）。 */
    const segs = []; branchLinks(root, pads, segs, S.mapStyle === '向左逻辑图' ? -1 : 1);
    return finalizeLayout({ width, height: Math.round(maxBottom + MAP_PAD), boxes, segs }, S.mapStyle);
  }
  function layoutBidirectional() {
    const root = mapRootNode();
    const rootFs = mapFont(root), rs = nodeSize(root), rootW = rs.w + 16, rootH = rs.h;
    // 一级分支偶数项向右、奇数项向左，根居中形成双向结构
    const rightBranches = root.children.filter((_, i) => i % 2 === 0);
    const leftBranches = root.children.filter((_, i) => i % 2 === 1);
    const GAP = MAP_COL;
    function sideExtent(branches, dir) {
      const mb = [], mp = [];
      let cursor = 0;
      branches.forEach(b => { const h = branchMeasure(b, 0, cursor, mb, mp, dir, 0); cursor += h + MAP_VGAP; });
      if (mb.length === 0) return { h: 0, w: 0 };
      let minX = 1e9, maxX = -1e9, maxY = -1e9;
      mb.forEach(b => { if (b.x < minX) minX = b.x; if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h; });
      return { h: maxY, w: dir > 0 ? maxX : -minX };
    }
    const re = sideExtent(rightBranches, 1), le = sideExtent(leftBranches, -1);
    const sideMaxH = Math.max(re.h, le.h, rootH);
    const boxes = [], pads = [], segs = [];
    const rootLeft = MAP_PAD + le.w + GAP;
    const rootX = rootLeft, rootY = MAP_PAD + (sideMaxH - rootH) / 2;
    pushBox(boxes, pads, root, rootX, rootY);
    const rightBaseX = rootX + rootW + GAP;
    const leftBaseX = rootX - GAP;
    function renderSide(branches, dir, baseX, top) {
      let cursor = top;
      branches.forEach(b => { const h = branchMeasure(b, 0, cursor, boxes, pads, dir, baseX); branchLinks(b, pads, segs, dir); cursor += h + MAP_VGAP; });
    }
    renderSide(rightBranches, 1, rightBaseX, MAP_PAD + (sideMaxH - re.h) / 2);
    renderSide(leftBranches, -1, leftBaseX, MAP_PAD + (sideMaxH - le.h) / 2);
    const rp = pads.find(p => p.id === root.id);
    const rMidY = rp.y + rp.h / 2;
    rightBranches.forEach(b => {
      const cp = pads.find(p => p.id === b.id); if (cp === undefined) return;
      const cMidY = cp.y + cp.h / 2, color = linkColor(b.level);
      const pEdge = rp.x + rp.w - 2, cEdge = cp.x + 2, midX = (pEdge + cEdge) / 2;
      addH(segs, 'rbh1_' + b.id, pEdge, midX, rMidY, color);
      addV(segs, 'rbv_' + b.id, midX, rMidY, cMidY, color);
      addH(segs, 'rbh2_' + b.id, midX, cEdge, cMidY, color);
    });
    leftBranches.forEach(b => {
      const cp = pads.find(p => p.id === b.id); if (cp === undefined) return;
      const cMidY = cp.y + cp.h / 2, color = linkColor(b.level);
      const pEdge = rp.x + 2, cEdge = cp.x + cp.w - 2, midX = (pEdge + cEdge) / 2;
      addH(segs, 'lbh1_' + b.id, pEdge, midX, rMidY, color);
      addV(segs, 'lbv_' + b.id, midX, rMidY, cMidY, color);
      addH(segs, 'lbh2_' + b.id, midX, cEdge, cMidY, color);
    });
    let minX = 1e9, maxX = -1e9, maxY = -1e9;
    boxes.forEach(b => { if (b.x < minX) minX = b.x; if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h; });
    const width = Math.round(Math.max(maxX, rootX + rootW, minX + 2 * MAP_PAD) + MAP_PAD);
    const height = Math.round(Math.max(maxY, rootY + rootH) + MAP_PAD);
    return finalizeLayout({ width, height, boxes, segs }, S.mapStyle);
  }
  /* 按层算出每层的 y 起点：该层最高的那个框决定这一层要多高。
   * 步长取 max(MAP_ROW, 层内最高框 + MAP_VGAP) —— 纯文字文档的步长仍是 MAP_ROW，
   * 观感与改动前完全一致；只有当某个框真的高过 MAP_ROW 时才会给它让路。 */
  function orgRowTops(root) {
    const maxH = [];
    (function walk(node, depth) {
      const h = nodeSize(node).h;
      if (maxH[depth] === undefined || h > maxH[depth]) maxH[depth] = h;
      (node.children || []).forEach(c => walk(c, depth + 1));
    })(root, 0);
    const tops = []; let y = MAP_PAD;
    for (let d = 0; d < maxH.length; d++) { tops[d] = y; y += Math.max(MAP_ROW, (maxH[d] || 0) + MAP_VGAP); }
    return tops;
  }
  function orgMeasure(node, depth, left, boxes, pads, tops) {
    const fs = mapFont(node);
    const { w, h } = nodeSize(node), y = tops[depth];
    if (node.children.length === 0) { pushBox(boxes, pads, node, left, y); return w; }
    const start = boxes.length; let cursor = left; const kids = [];
    node.children.forEach(child => { cursor += orgMeasure(child, depth + 1, cursor, boxes, pads, tops) + MAP_HGAP; const kp = pads.find(it => it.id === child.id); if (kp !== undefined) kids.push(kp); });
    const childrenW = cursor - left - MAP_HGAP, bandW = Math.max(w, childrenW), shift = (bandW - childrenW) / 2;
    if (shift > 0.5) { for (let i = start; i < boxes.length; i++) { boxes[i].x += shift; pads[i].x += shift; } }
    let x = left + (bandW - w) / 2;
    if (kids.length > 0) { const fX = kids[0].x + kids[0].w / 2, lX = kids[kids.length - 1].x + kids[kids.length - 1].w / 2; const mid = (fX + lX) / 2; x = Math.min(Math.max(mid - w / 2, left), left + bandW - w); }
    pushBox(boxes, pads, node, x, y);
    return bandW;
  }
  function orgLinks(node, pads, segs) {
    const p = pads.find(it => it.id === node.id); if (p === undefined) return;
    const px = p.x + p.w / 2, pBottom = p.y + p.h;
    node.children.forEach(child => {
      const c = pads.find(it => it.id === child.id); if (c === undefined) return;
      const cx = c.x + c.w / 2, cTop = c.y, midY = (pBottom + cTop) / 2, color = linkColor(child.level);
      addV(segs, 'ov1_' + child.id, px, pBottom - 2, midY, color);
      addH(segs, 'oh_' + child.id, px, cx, midY, color);
      addV(segs, 'ov2_' + child.id, cx, midY, cTop + 2, color);
      orgLinks(child, pads, segs);
    });
  }
  function layoutOrg() {
    const root = mapRootNode(); const boxes = [], pads = [];
    orgMeasure(root, 0, MAP_PAD, boxes, pads, orgRowTops(root));
    let maxRight = 0, maxBottom = 0;
    pads.forEach(p => { if (p.x + p.w > maxRight) maxRight = p.x + p.w; if (p.y + p.h > maxBottom) maxBottom = p.y + p.h; });
    const segs = []; orgLinks(root, pads, segs);
    return finalizeLayout({ width: Math.round(maxRight + MAP_PAD), height: Math.round(maxBottom + MAP_PAD), boxes, segs }, S.mapStyle);
  }
  // 行内可能含换行；摘要类文案把它压成空格，避免串行/错位
  function flatText(t) { return String(t === undefined || t === null ? '' : t).replace(/\s*\n\s*/g, ' ').trim(); }
  function flattenText(node) { let out = []; node.children.forEach(c => { out.push(flatText(c.text)); out = out.concat(flattenText(c)); }); return out; }
  function countDesc(node) { let c = node.children.length; node.children.forEach(ch => c += countDesc(ch)); return c; }
  /* ---------- 鱼骨图（严格按石川图 / 特性要因图的分级逻辑） ----------
   * 教科书（QC 七大手法）的画法，本文档逐条照做：
   *   鱼头 = 文档标题（待解决的结果），画在最右端，主骨箭头指向它；
   *   主骨 = 贯穿画面的水平脊骨；
   *   大骨 = 一级主题，从主骨斜出，与主骨成 60°~80°，且**向后倾斜**
   *          （骨端朝鱼尾方向，即背向鱼头），上下交替；
   *   中骨 = 二级主题，**与主骨平行**（水平短骨），带箭头指向大骨；
   *   小骨 = 三级主题，与中骨成 60° —— 于是**与大骨平行**；四级再与主骨平行……
   *          逐级交替，越深越朝外，永远不会折回主骨上。
   * 所以角度规则是「深浅交替」，不是逐级衰减：
   *   奇数级 = 向后斜 FISH_MAIN（背向鱼头）；偶数级 = 与主骨平行（指向鱼尾）。
   * 每一级都画出真实骨线，并在骨端挂本方框 —— 不把后代压成一段摘要文字。
   * 同级骨按「沿父骨方向的投影区间」依次排开；投影区间不相交 ⇒
   * 轴对齐包围盒不相交，因此同级骨在任何骨长 / 字数下都不会重叠。 */
  const FISH_MAIN = 62 * Math.PI / 180;    // 大骨与主骨的夹角（规范 60°~80°）
  const FISH_GAP = 10;                     // 相邻子骨间距
  const FISH_JOINT = 30;                   // 骨根到第一个分叉点的距离
  const FISH_TAIL = 16;                    // 主骨尾端留白
  /* 骨的方向：同级相同（互相平行）。
     「向后倾斜」= 方向的 x 分量为负（朝鱼尾），所以角度落在 ±(90°~180°)；
     偶数级回到 ±180° 即与主骨平行。x 分量恒为负 ⇒ 骨族始终朝鱼头外侧张开，
     既不会与主骨交叉，也不会与祖先骨回头重叠。 */
  function fishAngle(depth, side) {
    const back = FISH_MAIN;
    return side * (depth % 2 === 1 ? Math.PI - back : Math.PI);
  }
  function fishMinLen(depth) { return Math.max(26, Math.round(84 * Math.pow(0.78, depth - 1))); }
  function projRange(b, ux, uy) {
    let mn = Infinity, mx = -Infinity;
    [b.x0, b.x1].forEach(px => [b.y0, b.y1].forEach(py => {
      const p = px * ux + py * uy; if (p < mn) mn = p; if (p > mx) mx = p;
    }));
    return { mn: mn, mx: mx };
  }
  function shiftRange(arr, from, dx, dy) { for (let i = from; i < arr.length; i++) { arr[i].x += dx; arr[i].y += dy; } }
  /* 以 (0,0) 为骨根，在局部坐标里长出一棵「骨树」，返回其轴对齐包围盒（同一坐标系） */
  function fishGrow(node, depth, side, boxes, pads, segs) {
    const th = fishAngle(depth, side), ux = Math.cos(th), uy = Math.sin(th);
    const b0 = boxes.length, p0 = pads.length, s0 = segs.length;
    let x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    const acc = (ax, ay, bx, by) => { if (ax < x0) x0 = ax; if (ay < y0) y0 = ay; if (bx > x1) x1 = bx; if (by > y1) y1 = by; };
    // 子骨：递归长好之后整体平移到位（沿本骨方向按投影区间排队）
    let cursor = FISH_JOINT;
    (node.children || []).forEach(child => {
      const cb = boxes.length, cp = pads.length, cs = segs.length;
      const sub = fishGrow(child, depth + 1, side, boxes, pads, segs);
      const pr = projRange(sub, ux, uy);
      const t = cursor - pr.mn, dx = t * ux, dy = t * uy;
      shiftRange(boxes, cb, dx, dy); shiftRange(pads, cp, dx, dy); shiftRange(segs, cs, dx, dy);
      acc(sub.x0 + dx, sub.y0 + dy, sub.x1 + dx, sub.y1 + dy);
      cursor = t + pr.mx + FISH_GAP;
    });
    // 骨长：至少托住所有分叉点，且随层级递减
    let len = fishMinLen(depth);
    if (cursor - FISH_GAP > len) len = cursor - FISH_GAP;
    const tx = ux * len, ty = uy * len;
    addLine(segs, 'fish' + depth + '_' + node.id, 0, 0, tx, ty, linkColor(node.level));
    // 本级方框挂在骨末端之外（沿骨方向再让出半个框）
    const sz = nodeSize(node);
    const half = (sz.w * Math.abs(ux) + sz.h * Math.abs(uy)) / 2;
    const cx = tx + ux * (half + 10), cy = ty + uy * (half + 10);
    pushBox(boxes, pads, node, cx - sz.w / 2, cy - sz.h / 2);
    acc(0, 0, tx, ty);
    acc(cx - sz.w / 2, cy - sz.h / 2, cx + sz.w / 2, cy + sz.h / 2);
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  function layoutFishbone() {
    const root = mapRootNode(), bones = root.children;
    const boxes = [], pads = [], segs = [];
    // 注意：必须「长一根、立刻摆一根」。若先把所有骨树都长进同一个数组再平移，
    // shiftRange(b0→数组末尾) 会连带把后面那几根骨的盒子一起推走（这个坑真踩过）。
    let cursor = FISH_TAIL;
    bones.forEach((bone, i) => {
      const side = i % 2 === 0 ? -1 : 1;                 // 第 1 根向上，其余上下交替
      const b0 = boxes.length, p0 = pads.length, s0 = segs.length;
      const bb = fishGrow(bone, 1, side, boxes, pads, segs);
      const dx = cursor - bb.x0;
      shiftRange(boxes, b0, dx, 0); shiftRange(pads, p0, dx, 0); shiftRange(segs, s0, dx, 0);
      cursor = bb.x1 + dx + FISH_GAP * 2;
    });
    const headX = cursor + 6;
    const hs = nodeSize(root), headH = hs.h;
    addH(segs, 'spine', FISH_TAIL - 16, headX, 0, MOSS);   // 主骨（脊线）
    pushBox(boxes, pads, root, headX, -headH / 2);         // 鱼头
    return finalizeLayout({ width: 0, height: 0, boxes, segs }, S.mapStyle);
  }
  function bubbleFit(text, fs, bold, contentW) {
    const lines = wrapLines(text, Math.max(40, contentW), fs, bold);
    const L = Math.max.apply(null, lines.map(l => strW(l, fs, bold)));
    const H = lines.length * fs * MAP_LH;
    // 文本外接矩形须完全落在圆内：(L/2)²+(H/2)² ≤ (d/2)²
    const d = Math.ceil(Math.sqrt(L * L + H * H) + 2 * MAP_BPADX + 2 * MAP_BORD + 4);
    return { lines: lines, d: d };
  }
  function layoutBubble() {
    const root = mapRootNode(); const branches = root.children, n = branches.length > 0 ? branches.length : 1;
    const rootFs = mapFont(root);
    const innerW = MAP_BOX_MAX - 2 * MAP_BPADX - 2 * MAP_BORD;
    const rm = bubbleFit(root.text, rootFs, true, innerW);
    const d0 = Math.max(124, rm.d);
    let branchFs = 0; branches.forEach(b => { const f = mapFont(b); if (f > branchFs) branchFs = f; });
    if (branchFs === 0) branchFs = rootFs;
    // 分支圆统一直径：迭代收敛，确保每段文字都落在圆内
    let d1 = Math.max(108, Math.round(branchFs * 2 + 76));
    for (let pass = 0; pass < 3; pass++) {
      let need = 0;
      branches.forEach(b => { const m = bubbleFit(b.text, mapFont(b), nodeBold(b), Math.max(50, d1 - 2 * MAP_BPADX - 2 * MAP_BORD)); if (m.d > need) need = m.d; });
      if (need <= d1) break;
      d1 = need;
    }
    const r = Math.max(180, n * 58);
    const cx = MAP_PAD + r + d1 / 2, cy = MAP_PAD + r + d1 / 2;
    const boxes = [], pads = [], segs = [];
    boxes.push({ key: '', x: cx - d0 / 2, y: cy - d0 / 2, w: d0, h: d0, text: root.text, sub: n + ' 个主题', lines: rm.lines, font: rootFs, subFont: 11, bold: true, underline: false, fg: '#FFFFFF', subFg: '#D9EEDF', bg: MOSS, border: MOSS, borderW: 0, radius: d0 / 2, nodeId: root.id, media: null, mediaBox: null });
    pads.push({ id: root.id, x: cx - d0 / 2, y: cy - d0 / 2, w: d0, h: d0 });
    branches.forEach((node, i) => {
      const angle = -Math.PI / 2 + i * 2 * Math.PI / n, bx = cx + r * Math.cos(angle) - d1 / 2, by = cy + r * Math.sin(angle) - d1 / 2;
      addLine(segs, 'bub_' + node.id, cx, cy, bx + d1 / 2, by + d1 / 2, CONN_1);
      const kids = flattenText(node);
      const sub = kids.length > 0 ? (kids.slice(0, 3).join(' · ') + (kids.length > 3 ? ' +' + (kids.length - 3) : '')) : countDesc(node) + ' 项';
      const bm = bubbleFit(node.text, mapFont(node), nodeBold(node), Math.max(50, d1 - 2 * MAP_BPADX - 2 * MAP_BORD));
      boxes.push({ key: '', x: bx, y: by, w: d1, h: d1, text: node.text, sub, lines: bm.lines, font: mapFont(node), subFont: 10, bold: nodeBold(node), underline: nodeUnderline(node), fg: nodeColor(node), subFg: '#5C6B63', bg: '#FFFFFF', border: '#5E8C6E', borderW: 2, radius: d1 / 2, nodeId: node.id, media: null, mediaBox: null });
      pads.push({ id: node.id, x: bx, y: by, w: d1, h: d1 });
    });
    const size = Math.round(2 * (r + d1 / 2) + MAP_PAD * 2);
    return finalizeLayout({ width: size, height: size, boxes, segs }, S.mapStyle);
  }
  function currentLayout() {
    if (S.mapStyle === '鱼骨图') return layoutFishbone();
    if (S.mapStyle === '气泡图') return layoutBubble();
    if (S.mapStyle === '双向思维导图') return layoutBidirectional();
    if (S.mapStyle === '向下分类图' || S.mapStyle === '组织结构图') return layoutOrg();
    return layoutBranch();
  }

  /* ============================== 大纲行（拍平） ============================== */
  function isCollapsed(id) { return S.collapsedIds.indexOf(id) >= 0; }
  function toggleCollapse(id) { S.collapsedIds = isCollapsed(id) ? S.collapsedIds.filter(x => x !== id) : [...S.collapsedIds, id]; }
  function outlineRows() {
    const rows = [];
    function collect(nodes, depth) {
      nodes.forEach(node => {
        const collapsed = isCollapsed(node.id), bold = nodeBold(node), underline = nodeUnderline(node), color = nodeColor(node), fontSize = nodeFontSize(node), media = nodeMedia(node);
        rows.push({
          key: node.id + '|' + node.level + '|' + depth + '|' + node.children.length + '|' + (collapsed ? 'c' : 'o') + '|' + (bold ? 'b' : '-') + (underline ? 'u' : '-') + '|' + color + '|' + fontSize + '|m' + media.length,
          id: node.id, text: node.text, level: node.level, depth, hasChildren: node.children.length > 0, collapsed, bold, underline, color, fontSize, media,
          runs: nodeRuns(node)
        });
        if (!collapsed) collect(node.children, depth + 1);
      });
    }
    collect(buildTree(selectedDocument().nodes), 0);
    return rows;
  }
  /* 有内容的行 = 有文字 **或** 挂了公式/图片（只挂图没写字的行也是内容，导图里要出框） */
  function contentRows() { return outlineRows().filter(r => r.text.trim().length > 0 || r.media.length > 0); }

  /* ============================== 编辑操作 ============================== */
  function activeNodeId() {
    const nodes = selectedDocument().nodes; if (nodes.length === 0) return 0;
    if (nodes.findIndex(n => n.id === S.editNodeId) >= 0) return S.editNodeId;
    if (nodes.findIndex(n => n.id === S.selectedNodeId) >= 0) return S.selectedNodeId;
    return nodes[0].id;
  }
  function editingNode() { return findNode(activeNodeId()); }
  function currentLevelLabel() { const n = editingNode(); return n === undefined ? '未选中' : '标题' + n.level; }
  function currentColor() { const n = editingNode(); return n === undefined ? MOSS : nodeColor(n); }
  function colorRow(r) { return COLOR_OPTIONS.slice(r * 5, r * 5 + 5); }

  /* 焦点漏斗：谁要被聚焦，谁就同时进入编辑态（双态行只有在编辑态才有 textarea） */
  function setFocus(id, caret) {
    S.editingRowId = id;
    rowSelSnapshot = null;   // 换了行，上一行的选区快照作废
    pendingFocus = { id, caret: caret === undefined ? 'end' : caret };
  }
  /* 当前真正被编辑的那个富文本框：焦点在哪它就是哪个（contenteditable 聚焦时 activeElement 就是它）。
     取不到就退回「光标最后一次所在的行」—— 点工具栏按钮那一下不转移焦点，所以通常前一条就命中。 */
  function activeRowInput() {
    /* ① 先看选区落在哪一行 —— 用户划选完再点按钮时，焦点可能不在行上（重渲染/别处点击都会挪走），
       但 selection 一定还指着用户刚划的那一段。这是最贴近「用户正在改哪一行」的信号。 */
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.rangeCount) {
        const n = sel.getRangeAt(0).startContainer;
        let host = n && n.nodeType === 3 ? n.parentNode : n;
        while (host && typeof host.closest !== 'function') host = host.parentNode;
        const hit = host && host.closest ? host.closest('.row-input[data-id]') : null;
        if (hit) return hit;
      }
    } catch (e) { }
    /* ② 焦点在行上时，焦点说了算 */
    try {
      const ae = document.activeElement;
      if (ae && typeof ae.closest === 'function') {
        const hit = ae.closest('.row-input[data-id]');
        if (hit) return hit;
      }
    } catch (e) { }
    /* ③ 都没有：退回「光标最后一次所在的行」 */
    return S.editingRowId ? appEl.querySelector('.row-input[data-id="' + S.editingRowId + '"]') : null;
  }
  /* 样式按钮的作用上下文 —— 两个入口共用一套：
       ① 大纲编辑页那一行（contenteditable 的 .row-input）；
       ② 导图「改文字」框（仍是 textarea[data-map-edit]，装的是**还没落盘**的手输内容，
          所以把 text 一起带回去，落 patch 前先写进 node.text，否则偏移对不上）。
     返回 { node, host, sel(有选区才非空), caret, mapEdit }。 */
  function styleContext() {
    const mt = appEl.querySelector('textarea[data-map-edit]');
    if (mt) {
      const node = S.mapNodeId ? findNode(S.mapNodeId) : undefined;
      if (node === undefined) return null;
      const text = String(mt.value === undefined ? (S.mapEditText || '') : mt.value);
      const sel = selOfEditable(mt);
      const live = (sel && sel.e > sel.s) ? sel
        : ((mapSelSnapshot && mapSelSnapshot.e > mapSelSnapshot.s && mapSelSnapshot.e <= text.length) ? mapSelSnapshot : null);
      return {
        node: node, host: mt, mapEdit: true,
        sel: live ? { s: live.s, e: live.e, mapEdit: true, text: text } : null,
        caret: sel ? sel.e : text.length
      };
    }
    const host = activeRowInput();
    /* 取不到编辑框（比如人在导图视图里，DOM 上根本没有大纲行）就退回 activeNodeId()：
       它就是「当前选中的那个主题」。用 S.editingRowId 会在导图里指错目标。 */
    const id = host ? Number(host.getAttribute('data-id')) : activeNodeId();
    const node = id ? findNode(id) : undefined;
    if (node === undefined) return null;
    const sel = host ? selOfEditable(host) : null;
    const live = (sel && sel.e > sel.s) ? sel
      : ((rowSelSnapshot && rowSelSnapshot.id === id && rowSelSnapshot.e <= String(node.text || '').length) ? rowSelSnapshot : null);
    return {
      node: node, host: host, mapEdit: false, id: id,
      sel: live ? { s: live.s, e: live.e } : null,
      caret: sel ? sel.e : String(node.text || '').length
    };
  }
  function editingSelRange() { const c = styleContext(); return c ? c.sel : null; }
  /* ★ Word 逻辑（2026-09-23 改）：**没有选区就一个字都不改**。
     只把「接下来要输入的字的样式」记在 S.caretStyle 上 —— 之后再打字时打在新写的那一段上。
     光标落在谁后面就继承谁的样式，这和 Word 一致（也是用户预期的）。 */
  function caretStyleFor(node, caret) {
    const cs = S.caretStyle;
    if (cs && S.caretStyleId === node.id) return cs;
    const text = String(node.text || '');
    const off = Math.max(0, Math.min(text.length, typeof caret === 'number' ? caret : text.length));
    const st = effStyle(node, Math.max(0, off - 1));
    S.caretStyle = { b: !!st.b, u: !!st.u, c: st.c || null, fz: st.fz };
    S.caretStyleId = node.id;
    return S.caretStyle;
  }
  /* 无选区时点样式按钮：只改待输入样式，然后把光标放回原处（已有文字一个字节都不动） */
  function applyCaretStyle(ctx, patch, msg) {
    const cs = caretStyleFor(ctx.node, ctx.caret);
    if (patch.toggleB) cs.b = !cs.b;
    else if (patch.toggleU) cs.u = !cs.u;
    else if (patch.c !== undefined) cs.c = (cs.c || null) === (patch.c || null) ? null : patch.c;
    else if (patch.fzDelta) cs.fz = Math.min(40, Math.max(12, cs.fz + patch.fzDelta));
    S.caretStyle = cs; S.caretStyleId = ctx.node.id;
    if (ctx.mapEdit) { S.mapEditing = true; pendingMapSel = { s: ctx.caret, e: ctx.caret }; }
    else refocusSel(ctx.node.id, ctx.caret, ctx.caret);
    render();
    showNotice(msg(cs));
  }
  /* 选区样式的目标节点：导图改文字时是导图上选中的那个主题，否则是编辑中的那一行 */
  function styleTargetNode(sel) {
    if (sel && sel.mapEdit) return S.mapNodeId ? findNode(S.mapNodeId) : undefined;
    return editingNode();
  }
  /* 把「作用于选区」的样式改动落地，并把光标 / 选区放回原位（两个入口各有一套还原机制）。 */
  function applyRunFromSel(n, sel, patch) {
    if (sel.mapEdit) {
      const val = sel.text;
      patchNode(n.id, x => {
        if (val !== String(x.text || '')) x.runs = shiftRuns(String(x.text || ''), val, x.runs);
        x.text = val;
        return applyRunPatch(x, sel.s, sel.e, patch);
      });
      S.mapEditText = val; S.mapEditing = true;   // 样式改完仍在改文字状态，用户能接着改
      mapSelSnapshot = null;                      // 快照已被消费，清掉免得下次误用旧偏移
      pendingMapSel = { s: sel.s, e: sel.e };
      render();
      return;
    }
    patchNode(n.id, x => applyRunPatch(x, sel.s, sel.e, patch));
    refocusSel(n.id, sel.s, sel.e);
    rowSelSnapshot = null;
    render();
  }
  /* 行内样式应用后的重渲染：把光标与选区放回原位 */
  function refocusSel(id, s, e) { pendingFocus = { id: id, caret: s, selEnd: e }; }
  /* ---- 行内多行输入（回车换行）辅助 ---- */
  // 高度随内容自动增长：先把高度归零再读 scrollHeight，否则只能读到旧高度
  function autoGrowRow(t) {
    if (!t || t.tagName !== 'TEXTAREA') return;
    const fs = parseFloat(t.style.fontSize) || 16;
    const min = Math.max(40, Math.round(fs * 1.4) + 16);
    const sh = typeof t.scrollHeight === 'number' && t.scrollHeight > 0 ? t.scrollHeight : 0;
    if (!sh) { t.style.height = min + 'px'; return; }
    t.style.height = 'auto';
    t.style.height = Math.max(min, sh) + 'px';
  }
  function syncRowHeights() {
    /* 行高现在是 contenteditable 自己撑的（autoGrowRow 遇到非 textarea 会直接返回），
       这里只为还存在的 textarea（导图改文字框）服务。 */
    const list = appEl.querySelectorAll('.row-input');
    for (let i = 0; i < list.length; i++) autoGrowRow(list[i]);
  }
  // 光标是否在本框的首行(dir=-1)/末行(dir=1)：只有到边界才把上下键让给「换行焦点」
  function caretAtEdge(t, dir) {
    if (t.selectionStart !== t.selectionEnd) return false;
    const v = t.value, p = dir < 0 ? t.selectionStart : t.selectionEnd;
    const seg = dir < 0 ? v.slice(0, p) : v.slice(p);
    return seg.indexOf('\n') < 0;
  }
  function openDocument(id) {
    S.activeDocId = id; S.docTitle = selectedDocument().title; S.confirmDeleteId = 0;
    const nodes = selectedDocument().nodes, firstId = nodes.length > 0 ? nodes[0].id : 0;
    S.selectedNodeId = firstId; S.editNodeId = firstId; loadNode(firstId);
    /* 工具栏的兜底目标行：还没点过任何行时，按钮也知道该对哪一行下手（不主动抢焦点） */
    S.editingRowId = firstId; S.caretStyle = null; S.caretStyleId = 0;
    /* 多选是文档内的临时状态，换一篇文档就退出（别把上一篇的勾选带过来） */
    S.multiSel = false; S.multiSelIds = [];
    S.showEditor = true; scheduleSave(); render();
  }
  function appendTopNode() {
    const nodes = selectedDocument().nodes;
    const fresh = { id: nextId(), text: '', level: 1, children: [] };
    commitNodes(nodes.concat([fresh]));
    S.editNodeId = fresh.id; S.selectedNodeId = fresh.id; setFocus(fresh.id, 0); render();
  }
  function addChildNode(parentId) {
    const nodes = selectedDocument().nodes;
    const index = nodes.findIndex(n => n.id === parentId); if (index < 0) return;
    /* 级别规则（2026-09-25）：子主题必须恰好是上级+1 —— 上级已在标题9就没有「下一级」了。
       原来这里 Math.min(9, level+1) 会静默造出一个 9 级「伪子主题」（实际是同级）。 */
    if (nodes[index].level >= MAX_LEVEL) { showNotice('上级已是标题9，加不了更深的子主题'); return; }
    const fresh = { id: nextId(), text: '', level: nodes[index].level + 1, children: [] };
    commitNodes(nodes.slice(0, index + 1).concat([fresh]).concat(nodes.slice(index + 1)));
    S.editNodeId = fresh.id; S.selectedNodeId = fresh.id; setFocus(fresh.id, 0); render();
  }
  /* 兼容保留的裸设级原语：只钳 1–9，不走校验、不级联。生产入口一律别用它，
     仅供旧自检脚本当「摆数据」的工具（真正的升降级入口在下面 planLevelShift 一套）。 */
  function setLevel(id, level) {
    const clamped = Math.min(9, Math.max(1, level));
    patchNode(id, n => { n.level = clamped; });
    S.editNodeId = id; S.selectedNodeId = id;
    const t = findNode(id); setFocus(id, t ? t.text.length : 0); render();
  }

  /* ============================== 级别规则（2026-09-25） ==============================
   * 规则：在派生树里，**每个主题的级别必须恰好是上级 +1** —— 上级为 N 级，本级最深 N+1 级
   * （上级 5 级 → 本级最多降到 6 级，禁止 7 级或更深）。实现成「层级差不扩大」：
   * 合法文档（级差恒 1）上任何操作都不允许把某行与上级的级差变大，也不允许越出 1–9；
   * 旧数据里已存在的层级缺口允许保留，但同样不许再扩大。
   * 悬浮行（前面没有比它更浅的行，即没有上级）不受 N+1 约束，只受 1–9 约束。
   * 级联：降/升一级时其下整棵子树跟随平移一级，相对层级关系不变。
   * 策略（统一）：「标题N」菜单的跳降自动钳制到可行的最深级别；降级按钮打到上限时
   * 停在原地并说明允许的最低级别；级联 / 批量中任何一行不满足 → **整体回滚**并提示。
   * 统一入口：大纲「升级/降级」按钮、Tab/Shift+Tab、「标题N」菜单、导图「升级/降级」、
   * 多选批量 —— 全部走 planLevelShift → applyLevelShift，没有第二条路。 */
  const MAX_LEVEL = 9;
  /* 第 i 行的上级 = 前面最近的级别更小的行；没有上级返回 0（级别最小是 1，不会撞） */
  function parentLevelAt(nodes, i) {
    const lv = nodes[i].level;
    for (let j = i - 1; j >= 0; j--) { if (nodes[j].level < lv) return nodes[j].level; }
    return 0;
  }
  function gapToParent(nodes, i) { const p = parentLevelAt(nodes, i); return p > 0 ? nodes[i].level - p : 0; }
  function nodeDisplayName(n) {
    const t = String(n.text || '').trim();
    return t ? '「' + flatText(t).slice(0, 12) + '」' : '空主题';
  }
  /* 计划器：把 ids 各自连同整棵子树按 delta 平移（降级 +1 / 升级 -1 / 菜单跳多级）。
   * 目标行落在另一目标行子树里的会被级联覆盖，自动去重。整体验证：
   *   ① 所有被平移的行仍在 [1, 9]；
   *   ② 被平移的行与上级的层级差不得大于操作前（合法文档即「本级 ≤ 上级+1」）。
   * 返回 { ok, next, changedCount, blocks, fail }；ok=false 时调用方必须整体放弃，
   * 绝不允许「动了一半」—— 批量与级联的回滚语义就靠这一点保证。 */
  function planLevelShift(ids, delta) {
    const nodes = selectedDocument().nodes;
    const starts = [];
    (Array.isArray(ids) ? ids : [ids]).forEach(id => {
      const i = nodes.findIndex(n => n.id === id); if (i >= 0) starts.push(i);
    });
    if (starts.length === 0) return { ok: false, fail: { kind: 'empty' } };
    starts.sort((a, b) => a - b);
    const blocks = []; let covered = -1;
    starts.forEach(i => {
      if (i <= covered) return;                 // 在前面某个目标的子树里：级联已顺带覆盖
      let end = i + 1;
      while (end < nodes.length && nodes[end].level > nodes[i].level) end++;
      blocks.push([i, end]); covered = end - 1;
    });
    const next = nodes.map(n => Object.assign({}, n));
    let changedCount = 0;
    blocks.forEach(be => { for (let k = be[0]; k < be[1]; k++) { next[k].level = nodes[k].level + delta; changedCount++; } });
    for (let k = 0; k < next.length; k++) {
      if (next[k].level === nodes[k].level) continue;   // 没动的行，与（同样没动的）上级的级差不变
      const lv = next[k].level;
      if (lv < 1) return { ok: false, next, changedCount, blocks, fail: { kind: 'bound-top', idx: k } };
      if (lv > MAX_LEVEL) return { ok: false, next, changedCount, blocks, fail: { kind: 'bound-bottom', idx: k } };
      /* 悬浮行（原本没有上级，gOld=0）第一次获得上级且级差恰为 1，是**合法的新父子关系**，
         不算「级差扩大」；除此之外级差一律不得大于操作前（合法文档即本级 ≤ 上级+1）。 */
      if (gapToParent(next, k) > Math.max(gapToParent(nodes, k), 1)) {
        return { ok: false, next, changedCount, blocks, fail: { kind: 'gap', idx: k, parentLevel: parentLevelAt(next, k) } };
      }
    }
    return { ok: true, next, changedCount, blocks };
  }
  /* fail → 人话。multi=true（批量/多选）时一律明确「整体取消、所有行都没动」，
     不能让用户以为只有违规那一行动了。 */
  function shiftFailNotice(fail, delta, nodes, multi) {
    if (!fail || fail.kind === 'empty') return '请先选中要操作的主题';
    const n = nodes[fail.idx];
    const rollback = multi ? '；本次已整体取消，所有行都没动' : '，本次已整体取消';
    if (fail.kind === 'bound-top') return nodeDisplayName(n) + '已经是最高级（标题1），不能再升级';
    if (fail.kind === 'bound-bottom') return nodeDisplayName(n) + '已在标题9，再降会超出 9 级限制' + rollback;
    const p = fail.parentLevel, allow = p + 1;
    const base = nodeDisplayName(n) + '的上级是标题' + p + '，最低只能降到标题' + allow;
    if (multi) return base + rollback;
    if (nodes[fail.idx].level >= allow) return base + '，已保持在标题' + allow;
    return base + rollback;
  }
  /* 统一执行入口：要么整体成功（一次 commitNodes + 提示），要么整体不动（只提示）。 */
  function applyLevelShift(ids, delta, opts) {
    const o = opts || {};
    const before = selectedDocument().nodes;
    const plan = planLevelShift(ids, delta);
    const multi = (Array.isArray(ids) ? ids.length : 1) > 1;
    if (!plan.ok) { showNotice(shiftFailNotice(plan.fail, delta, before, multi)); return false; }
    const firstId = (Array.isArray(ids) ? ids : [ids])[0];
    commitNodes(plan.next);
    const node = findNode(firstId);
    const newLevel = node ? node.level : 0;
    if (o.focus !== false && firstId) {
      S.editNodeId = firstId; S.selectedNodeId = firstId;
      setFocus(firstId, node ? node.text.length : 0);
    }
    render();
    if (o.batch) showNotice('已批量' + (delta > 0 ? '降级' : '升级') + ' ' + plan.blocks.length + ' 个主题（含下级共 ' + plan.changedCount + ' 行）');
    else if (delta > 0) showNotice('已降级为 标题' + newLevel + (plan.changedCount > 1 ? '，' + (plan.changedCount - 1) + ' 条下级已跟随降级' : ''));
    else showNotice('已升级为 标题' + newLevel + (plan.changedCount > 1 ? '，' + (plan.changedCount - 1) + ' 条下级已跟随上移' : ''));
    return true;
  }
  function promote(id) {
    const node = findNode(id); if (node === undefined) return;
    S.editNodeId = id; S.selectedNodeId = id;
    if (node.level <= 1) { showNotice('已经是最高级（标题1），不能再升级'); return; }
    applyLevelShift([id], -1);
  }
  function demote(id) {
    const node = findNode(id); if (node === undefined) return;
    S.editNodeId = id; S.selectedNodeId = id;
    if (node.level >= MAX_LEVEL) { showNotice('已经是最低级（标题9），不能再降级'); return; }
    applyLevelShift([id], 1);
  }

  /* ---- 多选批量（2026-09-25）：批量升降级与单选走同一条校验，要么全动、要么全部不动 ---- */
  function toggleMultiSel() {
    S.multiSel = !S.multiSel; S.multiSelIds = [];
    render();
  }
  function exitMultiSel() { S.multiSel = false; S.multiSelIds = []; render(); }
  function toggleMultiPick(id) {
    const i = S.multiSelIds.indexOf(id);
    if (i >= 0) S.multiSelIds.splice(i, 1); else S.multiSelIds.push(id);
    render();
  }
  function multiPickAll() { S.multiSelIds = selectedDocument().nodes.map(n => n.id); render(); }
  function multiLevel(delta) {
    if (!S.multiSelIds.length) { showNotice('请先点选要批量操作的主题'); return; }
    applyLevelShift(S.multiSelIds.slice(), delta, { batch: true, focus: false });
  }
  /* 旧的 deleteNode（整棵子树删除）已删除（2026-10-08，与云端版同步）：它从未被调用，且语义与
     「删除母主题 → 子主题归到前一个母主题」相悖，留着迟早被误用。删除统一走 deleteRow。 */
  function makeTemplateNodes(template, id) {
    if (template === '空白文档') return [{ id: id + 1, text: '中心主题', level: 1, children: [] }, { id: id + 2, text: '要点一', level: 2, children: [] }];
    if (template === '计划') return [
      { id: id + 1, text: '目标', level: 1, children: [] }, { id: id + 2, text: '关键结果', level: 2, children: [] }, { id: id + 3, text: '衡量指标', level: 3, children: [] },
      { id: id + 4, text: '里程碑', level: 1, children: [] }, { id: id + 5, text: '九月：准备', level: 2, children: [] }, { id: id + 6, text: '十月：发布', level: 2, children: [] }
    ];
    if (template === '工作清单') return [
      { id: id + 1, text: '今日待办', level: 1, children: [] }, { id: id + 2, text: '高优先级', level: 2, children: [] }, { id: id + 3, text: '低优先级', level: 2, children: [] }
    ];
    return [
      { id: id + 1, text: '章节框架', level: 1, children: [] }, { id: id + 2, text: '核心观点', level: 2, children: [] }, { id: id + 3, text: '摘录', level: 3, children: [] }, { id: id + 4, text: '我的思考', level: 2, children: [] }
    ];
  }
  function createDocument(template, desc) {
    /* desc 只在「自定义模板」时传：名字不命中任何内置结构，节点从空白文档那套起，
       并把介绍作为 doc.desc 存下（卡片标题下展示）；不传则完全走老路径，老数据零影响。 */
    const custom = typeof desc === 'string';
    const id = Date.now(); const nodes = makeTemplateNodes(custom ? '空白文档' : template, id);
    /* 模板名「空白文档」本身就带「文档」两个字，再拼一次会变成「空白文档文档」 */
    const title = (template === '空白文档') ? template : (template + '文档');
    S.documents = [{ id, title, updatedAt: '刚刚创建', template, nodes, ...(custom && desc ? { desc } : {}) }, ...S.documents];
    S.activeDocId = id; S.docTitle = title; S.editNodeId = nodes.length > 0 ? nodes[0].id : 0;
    S.selectedNodeId = S.editNodeId; loadNode(S.editNodeId);
    S.showTemplateSheet = false; S.customTplOpen = false; S.customTplName = ''; S.customTplDesc = '';
    S.showEditor = true;
    scheduleSave(); render();
    logOp('新建文档', title);
  }
  function deleteDocument(id) {
    const target = S.documents.find(d => d.id === id);
    if (target === undefined) { S.confirmDeleteId = 0; render(); return; }
    if (S.documents.length <= 1) { S.confirmDeleteId = 0; render(); showNotice('至少要保留一篇文档，无法删除'); return; }
    S.documents = S.documents.filter(d => d.id !== id);
    if (S.activeDocId === id) {
      S.activeDocId = S.documents[0].id;
      S.docTitle = S.documents[0].title;
      S.editNodeId = 0; S.selectedNodeId = 0;
    }
    S.confirmDeleteId = 0;
    /* ★ 删除是一次性动作，走 saveNowAndPush：只 scheduleSave 的话云端永远不知道这篇没了，
     *   documents.json 和 .md 镜像都会残留（2026-10-09 加镜像时真浏览器自检抓到）。 */
    saveNowAndPush();
    render();
    logOp('删除文档', target.title);
    showNotice('已删除「' + target.title + '」');
  }
  function loadNode(id) { S.editNodeId = id; }

  /* ============================== Markdown 导入 / 导出（2026-10-07，自 LiJi-Cloud 同步） ==============================
   * 「按 md 原有主题等级导入」：ATX 标题（#~######）决定 level，正文行并入它上面最近的标题；
   * 第一个标题之前出现的正文，包成一个 标题1 节点兜底（否则这些字会凭空消失）。
   * md 允许跳级（# 直接 ###）——导入的数据保留原等级：级别规则只钳**编辑动作**，
   * 静态数据允许历史缺口（与「跨级降级旧数据」同一口径），后续在该文档上做的升降级照常校验。
   * ```/~~~ 围栏里的 # 是代码注释不是标题，用围栏状态机跳过。 */
  /* 首主题必须是一级（2026-10-08 需求，与云端版同步）：
     · 第一行钳成 1 级（md 以 ### 开头、删除首行后残留的深层行等，都收回来）；
     · 其后每行不超过「前一行 + 1」—— 首行被钳掉之后，紧跟的跳级会被拉平，
       否则文档里出现编辑器自己造不出来的级差（上级 N 级本级最深 N+1 的模型外数据）。
     · 首行本来就是 1 级 → 原数组原样返回，老数据零影响。 */
  function normalizeFirstLevel(nodes) {
    if (!nodes || nodes.length === 0 || nodes[0].level === 1) return nodes;
    const next = nodes.map(n => ({ ...n, level: n.level }));
    next[0].level = 1;
    for (let k = 1; k < next.length; k++) {
      if (next[k].level > next[k - 1].level + 1) next[k].level = next[k - 1].level + 1;
      if (next[k].level < 1) next[k].level = 1;
    }
    return next;
  }
  function parseMarkdownToNodes(raw) {
    const lines = String(raw || '').split(/\r\n|\r|\n/);
    const nodes = []; let fence = ''; let last = null; let seq = 0;
    const freshId = () => Date.now() + (++seq);
    const pushNode = (level, text) => { last = { id: freshId(), text: text, level: level, children: [] }; nodes.push(last); };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const f = line.match(/^\s*(```+|~~~+)/);
      if (f) {                                   // 开/关围栏：内容原样并入正文，里面的 # 不当标题
        if (!fence) fence = f[1][0];
        else if (line.trim().indexOf(fence) === 0) fence = '';
        if (last) last.text += (last.text ? '\n' : '') + line;
        continue;
      }
      const h = fence ? null : line.match(/^(#{1,9})\s+(.*\S)?\s*$/);
      if (h) {
        pushNode(Math.min(9, Math.max(1, h[1].length)), h[2] || '');
      } else if (/\S/.test(line)) {
        if (last) last.text += (last.text ? '\n' : '') + line;
        else pushNode(1, line.trim());           // 开头没标题的正文：标题1 兜底
      }
      /* 纯空行不生成节点也不并入（md 里空行只是段落分隔） */
    }
    /* 导入同样守「首主题必须是一级」：### 开头的 md 收成标题1，紧随的跳级一并拉平 */
    return normalizeFirstLevel(nodes);
  }
  /* 导出：每个主题一行 `#{level} text`；标题行前补空行（CommonMark 要求标题前有空行才稳定渲染）；
   * 正文里的换行原样保留。理记的 runs 富文本（颜色 / 字号 / 加粗选段）md 承载不了，导纯文本。 */
  function serializeNodesToMd(nodes) {
    const out = [];
    (nodes || []).forEach(n => {
      const t = String(n.text || '');
      out.push('#'.repeat(Math.min(9, Math.max(1, n.level))) + (t ? ' ' + t.replace(/\r/g, '') : ''));
      out.push('');
    });
    /* 收尾空行去掉一个：最后一行不该是双空行 */
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }
  function importMarkdownFile() {
    const inp = el('input', null, { type: 'file', accept: '.md,.markdown,.mdown,.txt,text/markdown,text/plain', style: { display: 'none' } });
    const cleanup = () => { try { if (inp.parentNode) inp.parentNode.removeChild(inp); } catch (e) { } };
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      cleanup();
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { showNotice('文件太大了（上限 2 MB）：导入的内容会变成大纲主题，先拆小再导'); return; }
      const fr = new FileReader();
      fr.onerror = () => showNotice('读取文件失败，请重试');
      fr.onload = () => {
        const nodes = parseMarkdownToNodes(String(fr.result));
        if (nodes.length === 0) { showNotice('没有解析出任何主题：请确认这是带标题（#）或正文的 Markdown 文件'); return; }
        const base = f.name.replace(/\.(md|markdown|mdown|txt)$/i, '').trim() || '导入的文档';
        const bad = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
        let title = base; bad.forEach(c => title = title.split(c).join('-'));
        const id = Date.now();
        /* 展开式建文档对象：保持与 createDocument / commitNodes 同一口径（别白名单丢字段） */
        S.documents = [{ id, title: title, updatedAt: '刚刚导入', template: '导入 Markdown', nodes: nodes, children: [] }, ...S.documents];
        S.activeDocId = id; S.docTitle = title;
        S.editNodeId = nodes[0].id; S.selectedNodeId = nodes[0].id;
        S.showEditor = true;
        scheduleSave(); render();
        logOp('导入 Markdown', title + '（' + nodes.length + ' 个主题）');
        showNotice('已导入「' + title + '」：' + nodes.length + ' 个主题（按 Markdown 标题分级）');
      };
      fr.readAsText(f, 'utf-8');
    });
    document.body.appendChild(inp);
    inp.click();
  }
  function updateDocTitle(value) {
    S.docTitle = value; const targetId = selectedDocument().id;
    /* 同 commitNodes：展开保留全部文档级字段（folder / desc / …），别再白名单逐个补 */
    S.documents = S.documents.map(d => { if (d.id !== targetId) return d; return { ...d, title: value }; });
    scheduleSave();
  }
  /* 「标题N」菜单：显式设级（可能一次跳多级）。向下跳时按钳制策略逐级下探，
   * 落到可行的最深级别（上级 N 级 → 本级最深 N+1），到不了就停在原地并说明原因；
   * 向上跳直接走统一校验（升级只会缩小层级差，极少被拦）。 */
  function applyLevel(level) {
    const id = activeNodeId(); if (id === 0) { showNotice('请先点选一行内容'); return; }
    const node = findNode(id); if (node === undefined) return;
    const cur = node.level;
    const want = Math.min(MAX_LEVEL, Math.max(1, level));
    if (want === cur) { showNotice('已经是 标题' + cur); return; }
    if (want < cur) {
      applyLevelShift([id], want - cur, { focus: true });   // 成功/失败的提示都由统一入口给
      return;
    }
    for (let x = want; x > cur; x--) {
      const plan = planLevelShift([id], x - cur);
      if (!plan.ok) continue;
      commitNodes(plan.next);
      S.editNodeId = id; S.selectedNodeId = id; setFocus(id, node.text.length); render();
      const idx = plan.next.findIndex(n => n.id === id);
      const p = parentLevelAt(plan.next, idx);
      showNotice(x < want && p > 0 ? ('上级为标题' + p + '，最多降到标题' + (p + 1) + '，已设为 标题' + x) : ('已设为 标题' + x));
      return;
    }
    const idx0 = selectedDocument().nodes.findIndex(n => n.id === id);
    const pNow = parentLevelAt(selectedDocument().nodes, idx0);
    showNotice(pNow > 0 ? ('上级为标题' + pNow + '，最低只能降到标题' + (pNow + 1) + '，已保持在标题' + cur) : ('向下没有可用的级别，已保持在标题' + cur));
  }
  function updateNodeText(id, value) {
    patchNode(id, n => {
      const oldT = String(n.text || '');
      const next = String(value === undefined || value === null ? '' : value);
      if (next === oldT) return;
      rowSelSnapshot = null;                                   // 文字变了，旧选区快照的偏移作废
      if (nodeRuns(n).length) n.runs = shiftRuns(oldT, next, n.runs);
      n.text = next;
      /* 「之后输入的字用这个样式」（Word 逻辑）：新写进去的那一段按 S.caretStyle 上色。
         diff 出插入区间再打 patch —— 整段上色会把已经写好的字也改掉，那就不是 Word 了。 */
      const cs = (S.caretStyle && S.caretStyleId === id) ? S.caretStyle : null;
      if (cs) {
        const d = insertRange(oldT, next);
        if (d.e > d.s) applyRunPatch(n, d.s, d.e, { abs: true, b: cs.b, u: cs.u, c: cs.c, fz: cs.fz });
      }
    });
  }
  /* 样式按钮的统一入口（Word 逻辑，2026-09-23 起）：
     · 有选区   → 只改选中的那几个字（runs）
     · 没有选区 → **一个字都不改**，只把样式记成「之后输入的字的样式」
     ★ 以前那条「没选区就改整行 / 整个主题」的分支已经删掉 —— 用户要的是 Word 的行为。
     两个入口共用：大纲行（contenteditable）与导图「改文字」框（都是同一份 nodes，改完两边同步）。 */
  function toggleBold() {
    const ctx = styleContext();
    if (!ctx) { showNotice('请先把光标放到主题文字里，或选中要改的那几个字'); return; }
    if (ctx.sel) return applyRunFromSel(ctx.node, ctx.sel, { toggleB: true });
    applyCaretStyle(ctx, { toggleB: true }, cs => cs.b ? '之后输入的字会加粗' : '之后输入的字不加粗');
  }
  function toggleUnderline() {
    const ctx = styleContext();
    if (!ctx) { showNotice('请先把光标放到主题文字里，或选中要改的那几个字'); return; }
    if (ctx.sel) return applyRunFromSel(ctx.node, ctx.sel, { toggleU: true });
    applyCaretStyle(ctx, { toggleU: true }, cs => cs.u ? '之后输入的字会带下划线' : '之后输入的字不带下划线');
  }
  function changeColor(color) {
    const ctx = styleContext();
    if (!ctx) { showNotice('请先把光标放到主题文字里，或选中要改的那几个字'); return; }
    if (ctx.sel) return applyRunFromSel(ctx.node, ctx.sel, { c: color });
    applyCaretStyle(ctx, { c: color }, cs => cs.c ? '之后输入的字用新颜色' : '之后输入的字跟随主题颜色');
  }
  function zoomFont(delta) {
    const ctx = styleContext();
    if (!ctx) { showNotice('请先把光标放到主题文字里，或选中要改的那几个字'); return; }
    if (ctx.sel) return applyRunFromSel(ctx.node, ctx.sel, { fzDelta: delta });
    applyCaretStyle(ctx, { fzDelta: delta }, cs => '之后输入的字字号 ' + cs.fz + 'px');
  }
  function promoteEditing() { const id = activeNodeId(); if (id === 0) { showNotice('请先点选一行内容'); return; } promote(id); }
  function demoteEditing() { const id = activeNodeId(); if (id === 0) { showNotice('请先点选一行内容'); return; } demote(id); }
  function addNodeInEditor() { appendTopNode(); }
  function visibleActiveId() { const rows = outlineRows(); if (rows.length === 0) return 0; const want = activeNodeId(); if (rows.find(r => r.id === want)) return want; return rows[rows.length - 1].id; }
  function removeActiveRow() {
    const nodes = selectedDocument().nodes; if (nodes.length === 0) { showNotice('文档里还没有内容'); return; }
    const id = visibleActiveId(); if (id === 0) return;
    const node = findNode(id); const label = (node === undefined || node.text.trim().length === 0) ? '空行' : '「' + flatText(node.text) + '」';
    const r = deleteRow(id); if (!r) return;
    showNotice(deletedRowNotice(label, r));
  }
  /* 删除提示按语义分流：归到前一个母主题 / 上提一级 / 无子级（2026-10-08，与云端版同步） */
  function deletedRowNotice(label, r) {
    if (!r || r.kids === 0) return '已删除 ' + label;
    if (r.mode === 'sibling') return '已删除 ' + label + '，它的 ' + r.kids + ' 个子主题已归到前一个母主题名下';
    return '已删除 ' + label + '，它的 ' + r.kids + ' 个子主题前面没有同级母主题，已上提一级保留';
  }
  function selectNode(id) { S.editNodeId = id; }

  function insertAfter(id) {
    const nodes = selectedDocument().nodes, index = nodes.findIndex(n => n.id === id); if (index < 0) return;
    const baseLevel = nodes[index].level;
    const fresh = { id: nextId(), text: '', level: baseLevel, children: [] };
    /* 强制插在当前主题紧后面（不跳到子主题之后）：紧随其后的子主题行因此挂到新同级名下 */
    commitNodes(nodes.slice(0, index + 1).concat([fresh]).concat(nodes.slice(index + 1)));
    S.editNodeId = fresh.id; S.selectedNodeId = fresh.id; setFocus(fresh.id, 0); render();
  }
  function addSiblingInEditor() {
    const nodes = selectedDocument().nodes, id = visibleActiveId();
    if (nodes.length === 0 || id === 0) { appendTopNode(); showNotice('已新增第一条内容（标题1）'); return; }
    const node = findNode(id);
    const level = node === undefined ? 1 : node.level; insertAfter(id); showNotice('已在选中行之后新增一条内容（标题' + level + '）');
  }
  function onRowInput(id, value) {
    if (value === ZWSP) return;
    const node = findNode(id); if (node === undefined) return;
    const clean = value.split(ZWSP).join('');
    if (clean.length === 0) { if (node.text.length === 0) deleteRow(id); else updateNodeText(id, ''); return; }
    if (clean !== node.text) updateNodeText(id, clean);
  }
  /* 删除一行（2026-10-08 语义更新，与云端版同步）：
     · 有子主题 → **归到前一个母主题名下**（向前找最近一条同级行）：子主题原地不动、级别不变，
       因为新母主题与被删主题同级，级差天然合法；
     · 没有前一个同级（被删的是头一个孩子）→ 退回旧口径：子级整体上提一级，挂到被删主题的上一级；
     · 无论哪种，删完都守「首主题必须是一级」（normalizeFirstLevel 兜底）。
     返回 { kids, mode }：kids=被删主题的子主题数，mode='sibling'（归前一个母主题）| 'promote'（上提一级）| ''（无子级），
     调用方拿去拼提示语；找不到该行返回 null。
     ★ 展开式重建（{ ...n, level }），禁止字段白名单 —— runs/media/folder 这类字段白名单已经丢过三次。 */
  function deleteRow(id) {
    const nodes = selectedDocument().nodes, index = nodes.findIndex(n => n.id === id); if (index < 0) return null;
    const dropLevel = nodes[index].level; let end = index + 1;
    while (end < nodes.length && nodes[end].level > dropLevel) end++;
    const kids = end - index - 1;
    let prevSibling = -1;
    for (let k = index - 1; k >= 0; k--) {
      if (nodes[k].level === dropLevel) { prevSibling = k; break; }
      if (nodes[k].level < dropLevel) break;      // 撞到更浅的层级：被删的是头一个孩子，前面不会再有同级
    }
    let next, mode = '';
    if (kids === 0) {
      next = nodes.slice(0, index).concat(nodes.slice(index + 1));
    } else if (prevSibling >= 0) {
      /* 子主题原地保留（级别不动），自然挂到前一个母主题名下 —— 只抽掉被删的那一行 */
      next = nodes.slice(0, index).concat(nodes.slice(index + 1));
      mode = 'sibling';
    } else {
      const promoted = nodes.slice(index + 1, end).map(n => ({ ...n, level: Math.max(1, n.level - 1) }));
      next = nodes.slice(0, index).concat(promoted).concat(nodes.slice(end));
      mode = 'promote';
    }
    next = normalizeFirstLevel(next);
    commitNodes(next);
    if (S.editNodeId === id) S.editNodeId = 0; if (S.selectedNodeId === id) S.selectedNodeId = 0;
    const prev = index > 0 ? nodes[index - 1] : undefined, target = prev !== undefined ? prev : nodes[index + 1];
    if (target === undefined || next.length === 0) return { kids, mode };
    S.editNodeId = target.id; S.selectedNodeId = target.id;
    const caret = target.text.length === 0 ? 0 : target.text.length; setFocus(target.id, caret); render();
    return { kids, mode };
  }
  function moveFocus(id, dir) {
    const rows = outlineRows(); const idx = rows.findIndex(r => r.id === id); if (idx < 0) return;
    const ni = idx + dir; if (ni < 0 || ni >= rows.length) return;
    setFocus(rows[ni].id, 'end'); render();
  }

  /* ============================== Toast ============================== */
  /* 提示条只就地改 DOM，**绝不整页重渲染**。
     原因（2026-09-20 用真实浏览器复现）：主题升降级 / 删除 / 加粗这些操作自己已经 render() 过一次，
     提示条再 render() 一次就会把编辑区整个重建 —— 于是正在编辑的输入框失焦
     （activeElement 从 textarea 掉到 BODY），滚动位置归零（实测 260 → 0），
     用户被弹回文档顶部、还得多点一下才能继续打字。 */
  function mountToast() {
    if (toastEl && toastEl.parentNode === appEl) return toastEl;
    toastEl = el('div', 'toast', { text: S.toast || '' });
    appEl.appendChild(toastEl);
    return toastEl;
  }
  function showNotice(msg) {
    S.toast = msg;
    const node = mountToast();
    node.textContent = msg;
    node.style.display = '';
    if (toastTimer !== -1) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      S.toast = '';
      if (toastEl) toastEl.style.display = 'none';
    }, 2200);
  }

  /* ============================== 视图：通用 ============================== */
  function brand() {
    return div('brand', null, [
      div('brand-badge', null, '理'),
      div(null, null, [div('brand-title', null, '理记'), div('brand-sub', null, '理清每一件重要的事')])
    ]);
  }
  function header(title, action) {
    return div('header', null, [
      el('h1', null, null, title),
      /* 轻享版没有服务端可刷，页头这个按钮就是「立刻同步一次」：
         把本机没传上去的推上去，再把云端新的拉回来。 */
      div('refresh-btn' + (S.cloudState === 'syncing' ? ' busy' : ''), {
        title: '立即与对象存储同步一次',
        onclick: () => { syncNow(); }
      }, [div('ic', null, S.cloudState === 'syncing' ? '◌' : '⟳'),
        div('lb', null, S.cloudState === 'syncing' ? '同步中' : '同步')]),
      div('spacer'),
      action ? div('new-btn', { onclick: () => { S.showTemplateSheet = true; render(); } }, action) : null
    ]);
  }

  /* ============================== 视图：首页 ============================== */
  function HomePage() {
    const wrap = div('screen');
    wrap.appendChild(header('我的文档', '＋ 新建'));
    const bar = div('count-line', null, [
      document.createTextNode('共 ' + S.documents.length + ' 篇'),
      div('spacer'),
      div('folder-new', { title: '建一个文件夹，把文档分门别类', onclick: () => startNewFolder() }, [svgIcon('folder-plus', 14), '新建文件夹']),
      div('folder-new', { title: '导入一个 .md 文件变成大纲文档', onclick: () => importMarkdownFile() }, [svgIcon('import', 14), '导入'])
    ]);
    wrap.appendChild(bar);
    /* 一份文件夹都没建过 → 照原来的样子平铺，一个分组头都不出现（老用户零变化）。
       建过之后才进分组视图；「未分类」只在真有散文档时才出现，否则空着一个头很难看。 */
    if (S.folders.length === 0) {
      const list = div('list');
      S.documents.forEach(item => list.appendChild(DocumentCard(item)));
      wrap.appendChild(list);
    } else {
      /* 分组后由这个容器统一滚动（多个 .folder-group 要一起滚，不能各自滚） */
      const box = div('folder-scroll');
      S.folders.forEach(f => box.appendChild(folderGroup(f)));
      const loose = S.documents.filter(d => !docFolderId(d));
      if (loose.length > 0) box.appendChild(folderGroup(null, loose));
      wrap.appendChild(box);
    }
    /* 两个浮层**互斥**：同一时刻只可能有一个。
       踩过：点过「新建文件夹」但没提交（被同名校验拦下时不会重渲染），再去点某张卡的 🗀，
       两层 sheet 会叠在一起 —— 界面上两个「文件夹名称」输入框，用户根本分不清在填哪个。
       渲染层强制互斥，打开入口再各自清一次对方的状态（双保险，任一处漏了都不会叠）。 */
    if (S.moveDocId) wrap.appendChild(MoveSheet());
    else if (S.showFolderInput || S.folderEditId) wrap.appendChild(folderNameSheet());
    return wrap;
  }

  /* ---------- 文件夹：数据层 ---------- */
  let folderSeq = 0;
  function nextFolderId() { folderSeq++; return Date.now() * 100 + folderSeq; }
  function docFolderId(d) { return Number((d && d.folder) || 0); }
  function folderById(id) { return S.folders.filter(f => f.id === Number(id))[0]; }
  function folderName(id) { const f = folderById(id); return f ? f.name : ''; }
  /* 兜底：文档身上带着一个 folders 里不存在的归属（换设备、云上别人建的）→ 补一条同 id 的文件夹，
     否则那些文档会**凭空消失**（分组视图里既不在文件夹、也不算「未分类」之外的东西）。
     名字取不到就叫「未命名文件夹」，用户可自己改。 */
  function syncFoldersFromDocs() {
    const known = {};
    S.folders.forEach(f => { known[f.id] = true; });
    let added = false;
    S.documents.forEach(d => {
      const fid = docFolderId(d);
      if (fid && !known[fid]) { known[fid] = true; S.folders = S.folders.concat([{ id: fid, name: '未命名文件夹' }]); added = true; }
    });
    return added;
  }
  function startNewFolder() { S.showFolderInput = true; S.folderEditId = 0; S.moveDocId = 0; S.folderInput = ''; render(); }
  function submitFolderName() {
    const nm = String(S.folderInput || '').trim();
    if (!nm) { showNotice('请先填一个文件夹名称'); return; }
    if (nm.length > 20) { showNotice('文件夹名称最多 20 个字'); return; }
    const dup = S.folders.filter(f => f.name === nm && f.id !== S.folderEditId)[0];
    if (dup) { showNotice('已经有同名的文件夹了'); return; }
    if (S.folderEditId) {
      const f = folderById(S.folderEditId);
      if (f) f.name = nm;
      S.folderEditId = 0; S.folderInput = '';
      saveNowAndPush(); render(); showNotice('文件夹已重命名为「' + nm + '」');
      logOp('重命名文件夹', '改为「' + nm + '」');
      return;
    }
    const f = { id: nextFolderId(), name: nm };
    S.folders = S.folders.concat([f]);
    S.showFolderInput = false; S.folderInput = '';
    saveNowAndPush(); render();
    logOp('新建文件夹', nm);
    showNotice('已创建文件夹「' + nm + '」—— 在文档卡片上点文件夹图标就能移进去');
  }
  /* 删除文件夹**只解散分组**，里面的文档一篇都不删（回到未分类）—— 这一点要在提示里说清楚 */
  function removeFolder(id) {
    const f = folderById(id);
    if (!f) return;
    const n = S.documents.filter(d => docFolderId(d) === f.id).length;
    S.folders = S.folders.filter(x => x.id !== f.id);
    S.documents.forEach(d => { if (docFolderId(d) === f.id) delete d.folder; });
    S.confirmFolderId = 0;
    saveNowAndPush(); render();
    logOp('删除文件夹', f.name + (n > 0 ? '（' + n + ' 篇回到未分类）' : ''));
    showNotice('已删除文件夹「' + f.name + '」' + (n > 0 ? '，里面的 ' + n + ' 篇文档回到「未分类」（文档没删）' : ''));
  }
  function moveDocTo(docId, folderId) {
    const d = S.documents.filter(x => x.id === docId)[0];
    if (!d) return;
    const fid = Number(folderId || 0);
    if (fid) d.folder = fid; else delete d.folder;
    S.moveDocId = 0; S.newFolderForMove = '';
    saveNowAndPush(); render();
    logOp('移动文档', String(d.title || '') + ' → ' + (fid ? (folderName(fid) || '未分类') : '未分类'));
    showNotice(fid ? ('已移动到「' + (folderName(fid) || '未分类') + '」') : '已移到「未分类」');
  }
  /* 移动浮层里现建一个文件夹并立刻移进去 —— 「分着分着发现要新建一个」是最常见的路径 */
  function createFolderAndMove(docId) {
    const nm = String(S.newFolderForMove || '').trim();
    if (!nm) { showNotice('请先填一个文件夹名称'); return; }
    if (nm.length > 20) { showNotice('文件夹名称最多 20 个字'); return; }
    if (S.folders.filter(f => f.name === nm)[0]) { showNotice('已经有同名的文件夹了'); return; }
    const f = { id: nextFolderId(), name: nm };
    S.folders = S.folders.concat([f]);
    moveDocTo(docId, f.id);
  }
  function toggleFolder(id) {
    const key = Number(id) || 0;
    S.folderCollapsed = S.folderCollapsed.indexOf(key) >= 0
      ? S.folderCollapsed.filter(x => x !== key)
      : S.folderCollapsed.concat([key]);
    render();
  }
  function folderGroup(folder, items) {
    const id = folder ? folder.id : 0;
    const list = items || S.documents.filter(d => docFolderId(d) === id);
    const collapsed = S.folderCollapsed.indexOf(id) >= 0;
    const confirming = S.confirmFolderId === id && !!folder;
    const g = div('folder-group');
    g.appendChild(div('folder-head', null, [
      div('folder-caret', { onclick: () => toggleFolder(id) }, collapsed ? '▸' : '▾'),
      div('folder-icon', null, folder ? svgIcon('folder', 16) : svgIcon('doc', 15)),
      div('folder-name', { onclick: () => toggleFolder(id) }, folder ? folder.name : '未分类'),
      div('folder-count', null, list.length + ' 篇'),
      div('spacer'),
      folder ? (confirming
        ? div('del-confirm', null, [
          div('del-yes', { onclick: ev => { ev.stopPropagation(); removeFolder(id); } }, '删除文件夹'),
          div('del-no', { onclick: ev => { ev.stopPropagation(); S.confirmFolderId = 0; render(); } }, '取消')
        ])
        : div('folder-acts', null, [
          div('folder-act', { title: '重命名文件夹', onclick: () => { S.moveDocId = 0; S.folderEditId = id; S.folderInput = folder.name; render(); } }, '✎'),
          el('button', 'folder-act danger', { title: '删除文件夹（里面的文档会回到「未分类」，不会删文档）', onclick: () => { S.confirmFolderId = id; render(); } }, '✕')
        ]))
        : null
    ]));
    if (!collapsed) {
      const l = div('list');
      if (list.length === 0) l.appendChild(div('folder-empty', null, '这个文件夹还是空的 —— 在别的文档上点文件夹图标移进来'));
      list.forEach(item => l.appendChild(DocumentCard(item)));
      g.appendChild(l);
    }
    return g;
  }
  function folderNameSheet() {
    const renaming = !!S.folderEditId;
    const overlay = div('overlay', {
      style: { background: 'rgba(18,0,0,.28)', zIndex: '40' },
      onclick: () => { S.showFolderInput = false; S.folderEditId = 0; render(); }
    });
    /* ★ tall：矮窗口下给浮层加高度上限并让它自己能滚（见 styles.css 的 .sheet.tall）。
     * 不加的话浮层是贴底向上生长的，超高时**顶部**被裁到视口上方，连标题和关闭 × 都够不着。 */
    const sheet = div('sheet tall', { onclick: ev => ev.stopPropagation() }, [
      el('h2', null, null, renaming ? '重命名文件夹' : '新建文件夹'),
      div('sub', null, renaming ? '换个好记的名字（文档不受影响）' : '建好之后，在文档卡片上点文件夹图标就能移进去')
    ]);
    const input = el('input', 'folder-input', {
      placeholder: '文件夹名称（最多 20 字）', value: S.folderInput || '', maxlength: '20'
    });
    input.setAttribute('data-f', renaming ? 'folder-rename' : 'folder-new');
    input.addEventListener('input', () => { S.folderInput = input.value; });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submitFolderName(); }
      else if (e.key === 'Escape') { e.preventDefault(); S.showFolderInput = false; S.folderEditId = 0; render(); }
    });
    sheet.appendChild(input);
    sheet.appendChild(div('sheet-actions', null, [
      el('button', 'up-btn ghost', { onclick: () => { S.showFolderInput = false; S.folderEditId = 0; render(); } }, '取消'),
      el('button', 'up-btn primary', { onclick: () => submitFolderName() }, renaming ? '保存' : '创建')
    ]));
    overlay.appendChild(sheet);
    return overlay;
  }
  /* 「移动到…」浮层：列出未分类 + 所有文件夹，选中即移动；底部还能现建一个 */
  function MoveSheet() {
    const item = S.documents.filter(d => d.id === S.moveDocId)[0];
    if (!item) { S.moveDocId = 0; return div('col'); }
    const cur = docFolderId(item);
    const overlay = div('overlay', {
      style: { background: 'rgba(18,0,0,.28)', zIndex: '41' },
      onclick: () => { S.moveDocId = 0; S.newFolderForMove = ''; render(); }
    });
    const sheet = div('sheet tall', { onclick: ev => ev.stopPropagation() }, [
      el('h2', null, null, '移动到…'),
      div('sub', null, item.title)
    ]);
    const opts = [{ id: 0, name: '未分类' }].concat(S.folders);
    const box = div('move-opts');
    opts.forEach(o => {
      const on = cur === o.id;
      box.appendChild(div('move-opt' + (on ? ' on' : ''), { onclick: () => moveDocTo(item.id, o.id) }, [
        div('ic', null, o.id ? svgIcon('folder', 15) : '—'),
        div('nm', null, o.name),
        on ? div('tick', null, '✓') : null
      ]));
    });
    sheet.appendChild(box);
    const input = el('input', 'folder-input', { placeholder: '新建一个文件夹并移进去', value: S.newFolderForMove || '', maxlength: '20' });
    input.setAttribute('data-f', 'folder-move-new');
    input.addEventListener('input', () => { S.newFolderForMove = input.value; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createFolderAndMove(item.id); } });
    sheet.appendChild(div('sheet-actions', null, [
      input,
      el('button', 'up-btn primary', { onclick: () => createFolderAndMove(item.id) }, '新建并移入')
    ]));
    overlay.appendChild(sheet);
    return overlay;
  }
  /* 卡片上的模板小标签：「空白文档」对外就叫「文档」（2026-09-25 用户反馈）。
     只改**展示**——存储里的 template 键仍是「空白文档」，鸿蒙端 / 老数据零影响。 */
  function tplLabel(t) { return t === '空白文档' ? '文档' : (t || ''); }
  function DocumentCard(item) {
    const confirming = S.confirmDeleteId === item.id;
    const topRight = confirming
      ? div('del-confirm', null, [
        div('del-yes', { onclick: ev => { ev.stopPropagation(); deleteDocument(item.id); } }, '删除'),
        div('del-no', { onclick: ev => { ev.stopPropagation(); S.confirmDeleteId = 0; render(); } }, '取消')
      ])
      : div('doc-right', null, [
        div('muted', { style: { fontSize: '12px' } }, item.updatedAt),
        el('button', 'move-btn', {
          title: '移动到文件夹',
          onclick: ev => { ev.stopPropagation(); S.showFolderInput = false; S.folderEditId = 0; S.moveDocId = item.id; S.newFolderForMove = ''; render(); }
        }, svgIcon('folder', 14)),
        el('button', 'del-btn', {
          title: '删除这篇文档',
          onclick: ev => { ev.stopPropagation(); S.confirmDeleteId = item.id; render(); }
        }, '✕')
      ]);
    const fn = folderName(docFolderId(item));
    return div('doc-card', { onclick: () => openDocument(item.id) }, [
      div('top', null, [
        div('tag', null, tplLabel(item.template)),
        fn ? div('doc-folder-tag', null, [svgIcon('folder', 12), fn]) : null,
        div('spacer'),
        topRight
      ]),
      div('title', null, item.title),
      item.desc ? div('doc-desc', null, item.desc) : null,
      div('meta', null, [div(null, { style: { fontSize: '16px', color: '#8B9891' } }, '☷'), div(null, null, nodeCount(item.nodes) + ' 个节点')])
    ]);
  }

  /* ============================== 视图：社区 ============================== */
  function CommunityPage() {
    const wrap = div('screen');
    wrap.appendChild(header('社区', ''));
    wrap.appendChild(div('muted', { style: { fontSize: '14px', padding: '0 24px 18px' } }, '从他人的结构中，获得新的思路'));
    const list = div('list');
    S.posts.forEach(post => {
      const row = div('post', null, [
        div('post-icon', { style: { background: post.color } }, '☷'),
        div('post-body', null, [
          div('post-title', null, [document.createTextNode(post.title), div('muted', { style: { marginLeft: 'auto', fontSize: '12px' } }, '♡ ' + post.likes)]),
          div('post-desc', null, post.description),
          div('post-foot', null, [div(null, null, post.author), div('tpl', null, post.template)])
        ])
      ]);
      list.appendChild(row);
    });
    wrap.appendChild(list);
    return wrap;
  }

  /* ============================== 视图：个人中心（同步与存储） ==============================
   * 轻享版没有账号，这一屏讲的就是「文档存在哪、怎么同步」：
   *   ① 同步状态（云端是谁、上次同步时间、立即同步）
   *   ② 对象存储配置（S3 / OSS / COS 三家，填一次即可）
   *   ③ 本机存储（文档数量、云端覆盖前的备份找回）
   * ======================================================================================= */
  function ProfilePage() {
    const wrap = div('screen');
    wrap.appendChild(header('同步与存储', ''));
    /* ★ 内容必须装进 .profile-scroll：.main 是 overflow:hidden，
     * 直接把卡片堆在 .screen 上，超出视口的部分会被裁掉而且滚不动
     * （顶栏留在外面不滚，跟首页一个做法）。 */
    const scroll = div('profile-scroll');
    scroll.appendChild(div('profile-hero', null, [
      div('avatar', null, '理'),
      div(null, null, [
        div(null, { style: { fontSize: '18px', fontWeight: '500' } }, '理记 · 轻享版'),
        div('muted', { style: { fontSize: '13px' } }, '文档存本机 · 无需账号 · 可同步到对象存储')
      ]),
      div('spacer'),
      div('vip-badge' + (S.ossOn ? ' on' : ''), null, S.ossOn ? '已启用同步' : '仅本机')
    ]));
    const info = div('info-group');
    info.appendChild(syncRow());
    scroll.appendChild(info);
    scroll.appendChild(ossCard());
    scroll.appendChild(localCard());
    scroll.appendChild(recycleCard());
    scroll.appendChild(opLogCard());
    wrap.appendChild(scroll);
    return wrap;
  }
  function syncRow() {
    const row = div('info-row');
    row.appendChild(div('ic', null, '☁'));
    row.appendChild(div(null, null, [div('t', null, '云端同步'), div('d', { 'data-cloud': '1' }, cloudText())]));
    row.appendChild(div('sync-now', { onclick: syncNow }, '立即同步'));
    return row;
  }
  function profileRow(icon, title, detail, onClick) {
    return div('info-row' + (onClick ? ' tap' : ''), onClick ? { onclick: onClick } : null, [
      div('ic', null, icon),
      div(null, null, [div('t', null, title), div('d', null, detail)]),
      div('chev', null, '›')
    ]);
  }

  /* ---------- 对象存储：配置卡 ---------- */
  function ossSummary() {
    const c = S.ossCfg || {};
    const p = ({ s3: 'S3 兼容', oss: '阿里云 OSS', cos: '腾讯云 COS' })[c.provider] || '对象存储';
    return p + ' · ' + (c.bucket || '') + (c.prefix ? '（' + c.prefix + '）' : '');
  }
  function defaultDraft() {
    return Object.assign(
      { provider: 's3', endpoint: '', region: '', bucket: '', ak: '', sk: '', prefix: 'liji/', pathStyle: false, ossSign: 'v1' },
      S.ossCfg || {});
  }
  function ossCard() {
    const card = div('vip-card');
    const editing = S.ossFormOpen || !S.ossCfg;
    card.appendChild(div('col', null, [
      el('h3', null, null, editing ? (S.ossCfg ? '修改对象存储配置' : '连接我的对象存储') : '对象存储'),
      div('p', null, editing
        ? '填一次，之后每次打开自动比对云端、有改动自动上传。密钥只存在本机，不会随文档导出。'
        : '文档会自动同步到 ' + ossSummary() + '。改动后约 1 秒上传，打开时自动比对。')
    ]));
    if (editing) {
      card.appendChild(ossForm());
    } else {
      card.appendChild(div('redeem-row', null, [
        el('button', 'redeem-btn', {
          onclick: () => { S.ossFormOpen = true; S.ossDraft = Object.assign(defaultDraft(), S.ossCfg || {}); S.ossMsg = ''; render(); }
        }, '修改配置'),
        el('button', 'redeem-btn', { onclick: ossTestConnection }, S.ossTesting ? '测试中…' : '测试连接'),
        el('button', 'redeem-btn', {
          onclick: () => { S.ossOn = !S.ossOn; saveOssConfig(); render(); showNotice(S.ossOn ? '已恢复同步' : '已暂停同步（文档仍然在本机）'); }
        }, S.ossOn ? '暂停同步' : '启用同步'),
        el('button', 'redeem-btn', { onclick: ossClearConfig }, '断开')
      ]));
      /* 自动合并已是默认行为（乐观锁 + 三方按文档合并）；这两个按钮是「明确二选一」的兜底，
         给用户在合并结果不满意时强制拉一边的权利 */
      card.appendChild(div('redeem-row', null, [
        el('button', 'redeem-btn', { onclick: ossForcePull }, '用云端覆盖本机'),
        el('button', 'redeem-btn', { onclick: ossForcePush }, '用本机覆盖云端')
      ]));
      card.appendChild(div('muted', { style: { fontSize: '12px' } },
        S.ossRemote
          ? ('云端版本：' + (S.ossRemote.updatedAt ? (dateText(S.ossRemote.updatedAt) + ' ' + hhmmText(S.ossRemote.updatedAt)) : '未知')
            + ' · ' + (S.ossRemote.docs || 0) + ' 篇 · ' + Math.round((S.ossRemote.bytes || 0) / 1024) + ' KB')
          : '还没读到云端信息，点「立即同步」试一次'));
    }
    if (S.ossMsg) card.appendChild(div('redeem-msg ' + (S.ossMsgKind || ''), null, S.ossMsg));
    return card;
  }
  function ossForm() {
    const d = S.ossDraft || (S.ossDraft = defaultDraft());
    const box = div('col');
    const field = (label, node, hint) => {
      const r = div('col', null, [
        div('muted', { style: { fontSize: '12px', margin: '6px 0 4px' } }, label), node
      ]);
      if (hint) r.appendChild(div('muted', { style: { fontSize: '12px', marginTop: '4px', lineHeight: '1.5' } }, hint));
      box.appendChild(r);
    };
    /* 输入直接写进草稿、不重渲染 —— 重渲染会把光标弹走，打字打不成 */
    const input = (k, placeholder, type) => el('input', 'folder-input', {
      value: d[k] === undefined || d[k] === null ? '' : String(d[k]),
      placeholder: placeholder, type: type || 'text',
      autocomplete: 'off', spellcheck: 'false',
      oninput: e => { d[k] = e.target.value; }
    });
    const sel = el('select', 'folder-input', { onchange: e => { d.provider = e.target.value; render(); } });
    [['s3', 'S3 兼容（AWS / MinIO / R2）'], ['oss', '阿里云 OSS'], ['cos', '腾讯云 COS']]
      .forEach(o => sel.appendChild(el('option', null, { value: o[0] }, o[1])));
    try { sel.value = d.provider || 's3'; } catch (e) { }
    field('服务商', sel);

    field('Bucket 名称', input('bucket', '例如 liji-docs'),
      d.provider === 'cos' ? '腾讯云的桶名带 APPID 后缀，形如 xxx-1250000000' : '');
    if (d.provider !== 'cos') {
      field('Endpoint', input('endpoint', 'https://oss-cn-hangzhou.aliyuncs.com'),
        'MinIO / 自建填 http://IP:9000；留空则按地域自动拼');
    }
    field('地域 Region', input('region', d.provider === 'cos' ? 'ap-guangzhou' : 'cn-hangzhou'),
      d.provider === 'cos' ? '腾讯云必填' : '阿里云 V4 签名与默认 Endpoint 会用到');
    field('AccessKey ID', input('ak', 'AccessKeyId / SecretId'));
    field('AccessKey Secret', input('sk', 'AccessKeySecret / SecretKey', 'password'));
    field('云端路径前缀', input('prefix', 'liji/'), '一个桶给多个应用共用时用它隔开；留空就放在桶根目录');

    if (d.provider === 's3') {
      const cb = el('input', null, { type: 'checkbox', onchange: e => { d.pathStyle = !!e.target.checked; } });
      try { cb.checked = !!d.pathStyle; } catch (e) { }
      box.appendChild(div('row', { style: { alignItems: 'center', marginTop: '8px' } }, [
        cb, div('muted', { style: { fontSize: '12px', marginLeft: '6px' } }, '路径风格（MinIO / 自建 Ceph 通常要勾）')
      ]));
    }
    if (d.provider === 'oss') {
      const s2 = el('select', 'folder-input', { onchange: e => { d.ossSign = e.target.value; } });
      s2.appendChild(el('option', null, { value: 'v1' }, 'V1（大多数桶）'));
      s2.appendChild(el('option', null, { value: 'v4' }, 'V4（新地域的桶）'));
      try { s2.value = d.ossSign || 'v1'; } catch (e) { }
      field('OSS 签名版本', s2, '连接时报 SignatureVersionNotSupported 就换成 V4');
    }

    box.appendChild(div('sheet-actions', null, [
      el('button', 'up-btn ghost', {
        onclick: () => { S.ossFormOpen = false; S.ossDraft = null; S.ossMsg = ''; render(); }
      }, S.ossCfg ? '取消' : '以后再说'),
      el('button', 'up-btn ghost', { onclick: ossTestConnection }, S.ossTesting ? '测试中…' : '测试连接'),
      el('button', 'up-btn primary', { onclick: () => ossSaveConfig(S.ossDraft || {}) }, '保存并启用')
    ]));
    box.appendChild(div('muted', { style: { fontSize: '12px', lineHeight: '1.6', marginTop: '8px' } },
      '连不上多半是跨域（CORS）：在桶的跨域设置里放行本页来源，允许 GET / PUT / HEAD / DELETE，'
      + '并放行这几个请求头：authorization、content-type、x-amz-date、x-amz-content-sha256（阿里云是 x-oss-date）。'));
    return box;
  }

  /* ---------- 本机存储 ---------- */
  function localCard() {
    let nodes = 0;
    S.documents.forEach(d => { nodes += nodeCount(d.nodes); });
    const card = div('vip-card');
    card.appendChild(div('col', null, [
      el('h3', null, null, '本机存储'),
      div('p', null, S.documents.length + ' 篇文档 · ' + nodes + ' 个节点 · 存放在本机浏览器存储里'
        + (S.lastSyncAt ? (' · 上次同步 ' + hhmmText(S.lastSyncAt)) : ''))
    ]));
    card.appendChild(div('redeem-row', null, [
      el('button', 'redeem-btn', { onclick: restoreLocalBackup },
        S.ossBackupAt ? ('找回云端覆盖前的版本（' + hhmmText(S.ossBackupAt) + '）') : '找回本机备份'),
      el('button', 'redeem-btn', { onclick: () => { saveNow(); showNotice('已保存到本机（' + S.documents.length + ' 篇）'); } }, '立即保存到本机')
    ]));
    card.appendChild(div('muted', { style: { fontSize: '12px', marginTop: '8px', lineHeight: '1.6' } },
      '密钥以明文存在本机：建议单独建一个只授权这个桶的子账号来用。'));
    return card;
  }

  /* ---------- 回收站卡（2026-10-09） ----------
   * 前提链路：① 用户在这里打开回收站功能（默认关）→ ② 使用前自动探测桶的版本控制 →
   * ③ 列出被删的 .md 源文件 → ④ 恢复成新文档。探测失败会给出去控制台开版本的指引。 */
  function recycleCard() {
    const card = div('vip-card');
    const on = recycleEnabled();
    card.appendChild(div('col', null, [
      el('h3', null, null, '回收站'),
      div('p', null, '删除文档时，桶里的 .md 源文件可以找回来恢复成新文档。'
        + '前提是桶开启了「版本控制」—— 打开此功能后点「检测」确认；没开就去对象存储控制台开启（开启后删除的文件才找得回）。')
    ]));
    const row = div('redeem-row');
    row.appendChild(el('button', 'redeem-btn', {
      onclick: () => {
        const next = !on;
        setRecycleEnabled(next);
        logOp('回收站', next ? '打开回收站功能' : '关闭回收站功能');
        if (next && ossReady()) recycleCheck();
        render();
      }
    }, on ? '关闭回收站功能' : '打开回收站功能'));
    if (on) {
      row.appendChild(el('button', 'redeem-btn', { onclick: recycleCheck }, S.recycleBusy ? '检测中…' : '检测版本控制'));
      row.appendChild(el('button', 'redeem-btn', { onclick: recycleOpen }, S.recycleBusy ? '读取中…' : '查看回收站'));
    }
    card.appendChild(row);
    if (S.recycleMsg) card.appendChild(div('redeem-msg', null, S.recycleMsg));
    return card;
  }
  function recycleSheet() {
    const overlay = div('overlay', {
      style: { background: 'rgba(18,0,0,.28)', zIndex: '40' },
      onclick: () => { S.recycleSheet = false; render(); }
    });
    const sheet = div('sheet tall', { onclick: ev => ev.stopPropagation() });
    sheet.appendChild(el('h2', null, null, '回收站'));
    sheet.appendChild(div('sub', null, '这些 .md 源文件在桶里被删除过。恢复会把内容导入为**新文档**（副本），不影响现有文档。'
      + '镜像里只有纯文本，恢复的副本不含图片/公式的原始数据。'));
    const box = div('oplog-list');
    const items = S.recycleItems || [];
    if (!items.length) box.appendChild(div('folder-empty', null, '回收站是空的 —— 开启桶的版本控制之后删除的文件才会出现在这里'));
    items.forEach(it => {
      const name = it.key.split('/').pop().replace(/\.md$/i, '') || it.key;
      const row = div('oplog-row');
      row.appendChild(div(null, null, [
        div('oplog-ev', null, name),
        div('oplog-time', null, '删除于 ' + dateText(it.deletedAt) + ' ' + hhmmText(it.deletedAt) + ' · ' + it.key)
      ]));
      row.appendChild(el('button', 'redeem-btn', { onclick: () => recycleRestore(it) }, S.recycleBusy ? '…' : '恢复'));
      box.appendChild(row);
    });
    sheet.appendChild(box);
    overlay.appendChild(sheet);
    return overlay;
  }

  /* ---------- 操作日志卡 + 日志浮层（2026-10-09） ---------- */
  function opLogCard() {
    const card = div('vip-card');
    card.appendChild(div('col', null, [
      el('h3', null, null, '操作日志'),
      div('p', null, '记录新建/删除文档与文件夹、移动、导入导出、同步与恢复等操作（本机最近 ' + OP_LOG_MAX + ' 条）。'
        + '同步开启时，每台设备的日志会上传一份到桶里 logs/ 目录，方便多设备之间互相检查。')
    ]));
    card.appendChild(div('redeem-row', null, [
      el('button', 'redeem-btn', { onclick: () => { S.showOpLog = true; render(); } }, '查看日志（' + opLog().length + ' 条）')
    ]));
    return card;
  }
  function opLogSheet() {
    const overlay = div('overlay', {
      style: { background: 'rgba(18,0,0,.28)', zIndex: '40' },
      onclick: () => { S.showOpLog = false; render(); }
    });
    const sheet = div('sheet tall', { onclick: ev => ev.stopPropagation() });
    sheet.appendChild(el('h2', null, null, '操作日志'));
    sheet.appendChild(div('sub', null, '最新在前 · 只记录本机这台设备的操作'));
    const box = div('oplog-list');
    const arr = opLog().slice().reverse();
    if (!arr.length) box.appendChild(div('folder-empty', null, '还没有操作记录'));
    arr.forEach(x => {
      const row = div('oplog-row');
      row.appendChild(div(null, null, [
        div('oplog-ev', null, x.e + (x.d ? ' · ' + x.d : '')),
        div('oplog-time', null, dateText(x.t) + ' ' + hhmmText(x.t))
      ]));
      box.appendChild(row);
    });
    sheet.appendChild(box);
    sheet.appendChild(div('redeem-row', null, [
      el('button', 'redeem-btn', {
        onclick: () => {
          try { localStorage.removeItem(OP_LOG_LS); } catch (e) { }
          opLogCache = null;
          logOp('清空日志', '用户手动清空');
          render();
          showNotice('操作日志已清空');
        }
      }, '清空日志'),
      el('button', 'redeem-btn', { onclick: () => { S.showOpLog = false; render(); } }, '关闭')
    ]));
    overlay.appendChild(sheet);
    return overlay;
  }

  /* ============================== 视图：侧边导航（桌面） ============================== */
  function Sidebar() {
    const side = div('sidebar');
    side.appendChild(div('side-head', null, [
      div('brand-badge', null, '理'),
      div(null, null, [div('brand-title', null, '理记'), div('brand-sub', null, '理清每一件重要的事')])
    ]));
    const nav = div('side-nav');
    const item = (ic, label, target) => div('side-item' + (S.tab === target ? ' active' : ''), { onclick: () => { S.tab = target; render(); } }, [
      div('ic', null, ic),
      div('lb', null, label)
    ]);
    nav.appendChild(item('⌂', '我的文档', '首页'));
    nav.appendChild(item('◈', '社区', '社区'));
    nav.appendChild(item('◉', '同步与存储', '个人中心'));
    side.appendChild(nav);
    /* 左下角的「＋ 新建文档」已移除（2026-10-08，与云端版同步）：顶部 Header 本来就有「＋ 新建」，
       两个入口指向同一个模板浮层，留一个就够。 */
    return side;
  }

  /* ============================== 视图：模板选择浮层 ============================== */
  /* 关模板浮层的统一出口：自定义表单的展开态和输入草稿一并清掉 ——
     否则填一半点 ✕ 关掉，下次再开「新建」会看到上次的半截表单还挂着（2026-09-25） */
  function closeTemplateSheet() {
    S.showTemplateSheet = false;
    S.customTplOpen = false; S.customTplName = ''; S.customTplDesc = '';
    render();
  }
  function TemplateSheet() {
    const overlay = div('overlay dark');
    overlay.appendChild(div('spacer', { style: { flex: '1' }, onclick: closeTemplateSheet }));
    /* tall：矮窗口（实测 360px 高）下这一屏展开「自定义」后高 404px，
     * 不加高度上限会把标题顶到视口外面去（同样的问题见 folderNameSheet 的注释）。 */
    const sheet = div('sheet tall');
    sheet.appendChild(div('row', { style: { alignItems: 'center' } }, [
      el('h2', null, null, '选择模板'),
      div('sheet-close', { onclick: closeTemplateSheet }, '×')
    ]));
    sheet.appendChild(div('sub', null, '从一张白纸开始，或借助结构快速开始。'));
    const tpls = [['空白文档', '自由记录你的想法', '#EDF0EC'], ['计划', '目标、里程碑与待办', '#E6F4EA'], ['工作清单', '按优先级整理今天的任务', '#FFF0D9'], ['读书笔记', '框架、摘录与思考', '#E8EEFF']];
    tpls.forEach(([title, desc, color]) => {
      sheet.appendChild(div('tpl-row', { onclick: () => createDocument(title) }, [
        div('ic', { style: { background: color } }, '☷'),
        div(null, null, [div('t', null, title), div('d', null, desc)]),
        div('chev', null, '›')
      ]));
    });
    /* 自定义模板（2026-09-25）：名字会成为文档卡片上的模板标签，介绍会显示在卡片标题下 */
    sheet.appendChild(div('tpl-row' + (S.customTplOpen ? ' on' : ''), { onclick: () => { S.customTplOpen = !S.customTplOpen; render(); } }, [
      div('ic', { style: { background: '#F1EAFB' } }, '✎'),
      div(null, null, [div('t', null, '自定义'), div('d', null, '自己命名模板，再写一句介绍')]),
      div('chev', null, S.customTplOpen ? '⌄' : '›')
    ]));
    if (S.customTplOpen) sheet.appendChild(customTplForm());
    overlay.appendChild(sheet);
    return overlay;
  }
  /* 「自定义模板」的小表单：名称（必填，≤20 字）+ 介绍（选填，≤60 字）。
     输入只写状态不重渲染（保焦点）；提交走 submitCustomTemplate()。 */
  function customTplForm() {
    const box = div('tpl-custom');
    const nameIn = el('input', 'folder-input', { placeholder: '模板名称（最多 20 字）', value: S.customTplName || '', maxlength: '20' });
    nameIn.setAttribute('data-f', 'tpl-custom-name');
    nameIn.addEventListener('input', () => { S.customTplName = nameIn.value; });
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitCustomTemplate(); } });
    const descIn = el('input', 'folder-input', { placeholder: '一句话介绍（选填，最多 60 字）', value: S.customTplDesc || '', maxlength: '60' });
    descIn.setAttribute('data-f', 'tpl-custom-desc');
    descIn.addEventListener('input', () => { S.customTplDesc = descIn.value; });
    descIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitCustomTemplate(); } });
    box.appendChild(nameIn); box.appendChild(descIn);
    box.appendChild(div('sheet-actions', null, [
      el('button', 'up-btn ghost', { onclick: () => { S.customTplOpen = false; S.customTplName = ''; S.customTplDesc = ''; render(); } }, '取消'),
      el('button', 'up-btn primary', { onclick: () => submitCustomTemplate() }, '创建')
    ]));
    return box;
  }
  function submitCustomTemplate() {
    const name = (S.customTplName || '').trim();
    const desc = (S.customTplDesc || '').trim();
    if (!name) { showNotice('先给模板起个名字'); return; }
    createDocument(name, desc);
  }

  /* ===================================================================================
   * 公式引擎（2026-09-22 新增）
   * -----------------------------------------------------------------------------------
   * 语法是 Word 公式那种「线性写法」的一个实用子集（也叫 LaTeX 风格）：
   *   \frac{分子}{分母}   \sqrt{被开方数}   \sqrt[n]{…}   x^{2}   x_{i}   \sum_{i=1}^{n}
   *   \left( … \right)    \alpha \times \le \to …（符号表见 MATH_SYM）
   *
   * **为什么自己排版、画到 canvas、再存成 PNG**：
   * 公式要在四个地方露面 —— 编辑页行内、导图框里、PDF 导出、长图导出。
   * 前两个用 DOM/MathML 没问题，但导出走的是 canvas，MathML 画不进去；
   * 一旦做两套渲染（DOM 一套、canvas 一套）就一定会对不齐，改一处漏一处。
   * 所以只做一套：解析成公式树 → 自己排版 → 画到 canvas（按 3 倍字号）→ 存 PNG data URL。
   * 四处统一用 <img> / drawImage，像素完全一致；代价是放大后会略糊，3 倍渲染已经够用。
   *
   * 排版模型：每个盒子都是**基线相对**的 { w, a, d, draw(ctx, x, y) }
   *   x,y = 基线左端点；a = 基线上方高度；d = 基线下方深度；总高 = a + d。
   * =================================================================================== */
  const MATH_SYM = {
    /* 小写希腊 */
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ϵ',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ',
    mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
    phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
    /* 大写希腊 */
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    /* 运算符 */
    times: '×', div: '÷', pm: '±', mp: '∓', cdot: '⋅', ast: '∗', circ: '∘', bullet: '∙',
    oplus: '⊕', otimes: '⊗', bigcirc: '◯',
    /* 关系符 */
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡',
    sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫', cong: '≅', asymp: '≍',
    /* 集合与逻辑 */
    in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
    cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
    forall: '∀', exists: '∃', nexists: '∄', neg: '¬', land: '∧', lor: '∨',
    /* 其他符号 */
    nabla: '∇', partial: '∂', infty: '∞', angle: '∠', perp: '⊥', parallel: '∥',
    therefore: '∴', because: '∵', degree: '°', prime: '′', ldots: '…', dots: '…',
    cdots: '⋯', vdots: '⋮', ddots: '⋱', aleph: 'ℵ', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ',
    /* 箭头 */
    to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒',
    Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓',
    implies: '⟹', iff: '⟺', hookrightarrow: '↪', longrightarrow: '⟶',
    /* 大型运算符 / 函数名 / 定界符 */
    sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
    bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂', bigvee: '⋁', bigwedge: '⋀',
    sqrt: '√', lbrace: '{', rbrace: '}', langle: '⟨', rangle: '⟩', lvert: '|', rvert: '|',
    lVert: '‖', rVert: '‖', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
    backslash: '\\', mid: '|', colon: ':', percentage: '%', dollar: '$', amp: '&', hash: '#'
  };
  /* 这些名字是「函数名」，要正体排，并且后面跟一个细空格 */
  const MATH_FUNCS = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'det', 'dim', 'ker', 'deg', 'gcd', 'mod', 'bmod', 'pmod'];
  /* 这些是「大型运算符」：默认极限堆在上下；∫ ∮ 类放右侧（与 Word 默认一致） */
  const MATH_BIGOPS = ['sum', 'prod', 'coprod', 'bigcup', 'bigcap', 'bigoplus', 'bigotimes',
    'bigvee', 'bigwedge', 'int', 'iint', 'iiint', 'oint', 'lim', 'max', 'min', 'sup', 'inf', 'limsup', 'liminf'];
  const MATH_BIGOP_SIDE = ['int', 'iint', 'iiint', 'oint'];
  const MATH_GREEK_LOWER = 'αβγδεζηθικλμνξπρστυφχψωϑϕ';
  function mathItalic(ch) {
    if (typeof ch !== 'string' || ch.length !== 1) return false;
    return /^[A-Za-z]$/.test(ch) || MATH_GREEK_LOWER.indexOf(ch) >= 0;
  }
  /* 二目运算符 / 关系符：两侧要有空格（Word 也是这样）；一元正负号不加 */
  const MATH_BIN_OPS = '=≠≈≤≥<>×÷±∓⋅∗∘⊕⊗∈∉∋⊂⊆⊃⊇∪∩∖∝≡∼≃≅→←↔⇒⇐⇔↦⟹⟺+−+/∧∨';

  let _mmctx = null;
  const MATH_FONT_STACK = '"Cambria Math","Latin Modern Math","Times New Roman",Georgia,"PingFang SC","Microsoft YaHei",serif';
  function mathCtx() {
    if (_mmctx === null) { try { _mmctx = document.createElement('canvas').getContext('2d'); } catch (e) { _mmctx = false; } }
    return _mmctx;
  }
  function mathFont(fs, italic, bold) { return (italic ? 'italic ' : '') + (bold ? 'bold ' : '') + fs + 'px ' + MATH_FONT_STACK; }
  function mathMeasure(str, fs, italic, bold) {
    const ctx = mathCtx();
    if (ctx) { ctx.font = mathFont(fs, italic, bold); return ctx.measureText(str).width; }
    let w = 0; for (let k = 0; k < str.length; k++) w += charW(str[k], fs); return w;
  }

  /* ---------- 盒子构造 ---------- */
  function mkSpace(fs, k) { return { w: fs * (k || 0.16), a: 0, d: 0, draw: function () { } }; }
  function mkText(str, fs, italic, bold) {
    const w = mathMeasure(str, fs, italic, bold);
    return {
      w: w, a: fs * 0.78, d: fs * 0.30, text: str,
      draw: function (ctx, x, y) {
        ctx.font = mathFont(fs, italic, bold); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(str, x, y);
      }
    };
  }
  function mkRow(items) {
    const list = items.filter(Boolean);
    let w = 0, a = 0, d = 0;
    list.forEach(b => { w += b.w; if (b.a > a) a = b.a; if (b.d > d) d = b.d; });
    return {
      w: w, a: a, d: d,
      draw: function (ctx, x, y) { let cx = x; list.forEach(b => { b.draw(ctx, cx, y); cx += b.w; }); }
    };
  }
  /* 分数：基线 = 分数线，所以 a/d 都要把分数线到分子/分母的距离算进去 */
  function mkFrac(num, den, fs) {
    const rule = Math.max(1, fs * 0.055), gapUp = fs * 0.22, gapDn = fs * 0.24, pad = fs * 0.34;
    const inner = Math.max(num.w, den.w);
    const w = inner + pad;
    const a = rule / 2 + gapUp + num.a + num.d;
    const d = rule / 2 + gapDn + den.a + den.d;
    return {
      w: w, a: a, d: d,
      draw: function (ctx, x, y) {
        ctx.fillRect(x + (w - inner) / 2, y - rule / 2, inner, rule);
        num.draw(ctx, x + (w - num.w) / 2, y - rule / 2 - gapUp - num.d);
        den.draw(ctx, x + (w - den.w) / 2, y + rule / 2 + gapDn + den.a);
      }
    };
  }
  /* 根号：左钩用折线描出来，被开方数上方压一条横线 */
  function mkSqrt(body, deg, fs) {
    const rule = Math.max(1, fs * 0.055), hook = fs * 0.60, top = fs * 0.08;
    const degW = deg ? deg.w + fs * 0.04 : 0;
    const w = degW + hook + body.w + fs * 0.10;
    const a = body.a + top + rule;
    const d = body.d;
    return {
      w: w, a: a, d: d,
      draw: function (ctx, x, y) {
        const barY = y - body.a - top;
        const x0 = x + degW, x1 = x0 + hook;
        ctx.save();
        ctx.lineWidth = rule; ctx.strokeStyle = ctx.fillStyle; ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.moveTo(x0, barY + fs * 0.26);
        ctx.lineTo(x0 + hook * 0.32, barY + fs * 0.20);
        ctx.lineTo(x1, y + fs * 0.10);
        ctx.lineTo(x1 + fs * 0.10, barY);
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1 + fs * 0.10, barY); ctx.lineTo(x + w, barY); ctx.stroke();
        ctx.restore();
        if (deg) deg.draw(ctx, x + degW * 0.10, barY + fs * 0.12);
        body.draw(ctx, x1 + fs * 0.12, y);
      }
    };
  }
  /* 上下标（普通原子）：上标抬到基线上方，下标压在基线下方 */
  function mkScript(base, sup, sub, fs) {
    const gapX = fs * 0.06, up = fs * 0.14, dn = fs * 0.02;
    const sw = Math.max(sup ? sup.w : 0, sub ? sub.w : 0);
    const a = base.a + (sup ? up : 0);
    const d = Math.max(base.d, sub ? dn + sub.a + sub.d : 0);
    return {
      w: base.w + gapX + sw, a: a, d: d,
      draw: function (ctx, x, y) {
        base.draw(ctx, x, y);
        const sx = x + base.w + gapX;
        if (sup) sup.draw(ctx, sx, y - base.a - up + sup.a);
        if (sub) sub.draw(ctx, sx, y + dn + sub.a);
      }
    };
  }
  /* 大型运算符的极限：上下堆叠（∑/∏/lim）或贴右侧（∫ 类） */
  function mkBigopLimits(op, sup, sub, fs, stacked) {
    if (!stacked) return mkScript(op, sup, sub, fs);
    const gap = fs * 0.10;
    const w = Math.max(op.w, sup ? sup.w : 0, sub ? sub.w : 0);
    const a = (sup ? sup.a + sup.d + gap : 0) + op.a;
    const d = op.d + (sub ? gap + sub.a + sub.d : 0);
    return {
      w: w, a: a, d: d,
      draw: function (ctx, x, y) {
        op.draw(ctx, x + (w - op.w) / 2, y - a + op.a);
        if (sup) sup.draw(ctx, x + (w - sup.w) / 2, y - a + sup.a);
        if (sub) sub.draw(ctx, x + (w - sub.w) / 2, y + op.d + gap + sub.a);
      }
    };
  }

  /* ---------- 解析：线性源码 → 公式树 ---------- */
  /* 树节点：{type:'text'|'space'|'row'|'frac'|'sqrt'|'bigop'|'attached'} */
  function mathParse(src) {
    const s = String(src === undefined || src === null ? '' : src);
    let i = 0;
    function isWs(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }
    function skipWs() { while (i < s.length && isWs(s[i])) i++; }
    function readName() { let n = ''; while (i < s.length && /[A-Za-z]/.test(s[i])) { n += s[i]; i++; } return n; }
    function seq(stops) {
      const out = [];
      for (;;) {
        skipWs();
        if (i >= s.length || stops.indexOf(s[i]) >= 0) break;
        const before = i;
        let a = atom();
        if (a === null) { i = before + 1; continue; }   // 兜底：不认识的字符直接跳过，别死循环
        let sup = null, sub = null;
        for (;;) {
          skipWs();
          if (s[i] !== '^' && s[i] !== '_') break;
          const isSup = s[i] === '^'; i++;
          const g = arg();
          if (isSup) sup = g; else sub = g;
        }
        if (sup || sub) a = { type: 'attached', base: a, sup: sup, sub: sub };
        pushSpaced(out, a, s, i);
      }
      return trimSpaces(out);
    }
    /* 二目运算符两侧留白；行首的 +/− 当一元号处理 */
    function pushSpaced(out, a, src, pos) {
      const isOp = a.type === 'text' && a.text.length === 1 && MATH_BIN_OPS.indexOf(a.text) >= 0;
      if (!isOp) { out.push(a); return; }
      const unary = (a.text === '+' || a.text === '-') &&
        (out.length === 0 || (out[out.length - 1].type === 'text' && MATH_BIN_OPS.indexOf(out[out.length - 1].text) >= 0));
      if (unary) { out.push(a); return; }
      out.push({ type: 'space' }, a, { type: 'space' });
    }
    function trimSpaces(items) {
      const out = [];
      items.forEach(it => {
        if (it.type === 'space' && (out.length === 0 || out[out.length - 1].type === 'space')) return;
        out.push(it);
      });
      while (out.length && out[out.length - 1].type === 'space') out.pop();
      return out;
    }
    /* 一个参数：{...} 或单个原子 */
    function arg() {
      skipWs();
      if (s[i] === '{') { i++; const items = seq(['}']); if (s[i] === '}') i++; return items; }
      const a = atom();
      return a ? [a] : [];
    }
    function atom() {
      skipWs();
      const c = s[i];
      if (c === undefined) return null;
      if (c === '{') { i++; const items = seq(['}']); if (s[i] === '}') i++; return { type: 'row', items: items }; }
      if (c === '}') { i++; return { type: 'text', text: '}', italic: false }; }
      if (c === '\\') {
        i++;
        const name = readName();
        if (!name) {
          const ch = s[i]; i++;
          /* \, \; \! \quad 之类当空白；其余当转义字面量 */
          if (ch === ',' || ch === ';' || ch === ':' || ch === '!' || ch === ' ') return { type: 'space' };
          return { type: 'text', text: ch, italic: false };
        }
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') { const n = arg(), d = arg(); return { type: 'frac', num: n, den: d }; }
        if (name === 'sqrt') {
          skipWs();
          let deg = null;
          if (s[i] === '[') { i++; deg = seq([']']); if (s[i] === ']') i++; }
          const b = arg();
          return { type: 'sqrt', deg: deg, body: b };
        }
        if (MATH_BIGOPS.indexOf(name) >= 0) return { type: 'bigop', op: name };
        if (name === 'left' || name === 'right') {
          skipWs();
          let ch = s[i];
          if (ch === '\\') { i++; const nm = readName(); ch = MATH_SYM[nm] || (s[i] === undefined ? '(' : s[i]); if (!MATH_SYM[nm]) i++; }
          else i++;
          if (ch === undefined) ch = '(';
          return { type: 'text', text: ch, italic: false, big: true };
        }
        if (name === 'begin' || name === 'end' || name === 'text' || name === 'mathrm' || name === 'operatorname') {
          /* 不支持的排版结构：把参数原样排出来，绝不静默吞掉用户写的东西 */
          const inner = name === 'text' || name === 'mathrm' || name === 'operatorname' ? arg() : [];
          return { type: 'row', items: inner };
        }
        if (MATH_FUNCS.indexOf(name) >= 0) return { type: 'text', text: name, italic: false, func: true };
        const ch = Object.prototype.hasOwnProperty.call(MATH_SYM, name) ? MATH_SYM[name] : name;
        return { type: 'text', text: ch, italic: mathItalic(ch) };
      }
      i++;
      return { type: 'text', text: c, italic: mathItalic(c) };
    }
    return seq([]);
  }

  /* ---------- 排版：公式树 → 盒子 ---------- */
  function mathLayout(node, fs, upright) {
    if (!node) return mkText('', fs, false, false);
    switch (node.type) {
      case 'space': return mkSpace(fs, 0.16);
      case 'text': {
        const italic = upright ? false : !!node.italic;
        const t = mkText(node.text, node.big ? fs * 1.5 : fs, italic, false);
        if (node.func) t.w += fs * 0.16;      // 函数名后面补一个细空格
        return t;
      }
      case 'row': {
        const items = node.items || [];
        if (!items.length) return mkText('', fs * 0.5, false, false);
        return mkRow(items.map(it => mathLayout(it, fs, upright)));
      }
      case 'frac': return mkFrac(mathLayout({ type: 'row', items: node.num }, fs, upright), mathLayout({ type: 'row', items: node.den }, fs, upright), fs);
      case 'sqrt': {
        const body = (node.body && node.body.length)
          ? mathLayout({ type: 'row', items: node.body }, fs, upright)
          : mkText('', fs * 0.5, false, false);
        const deg = (node.deg && node.deg.length)
          ? mathLayout({ type: 'row', items: node.deg }, fs * 0.52, upright)
          : null;
        return mkSqrt(body, deg, fs);
      }
      case 'bigop': {
        const nm = node.op;
        const sym = MATH_SYM[nm] || nm;
        const isWord = /^[a-z]{2,}$/.test(sym);
        return { type: 'bigopbox', isWord: isWord, side: MATH_BIGOP_SIDE.indexOf(nm) >= 0, box: mkText(sym, isWord ? fs * 0.96 : fs * 1.6, false, false) };
      }
      case 'attached': {
        const isBig = node.base && node.base.type === 'bigop';
        if (isBig) {
          const op = mathLayout(node.base, fs, upright);
          const sup = node.sup && node.sup.length ? mathLayout({ type: 'row', items: node.sup }, fs * 0.66, upright) : null;
          const sub = node.sub && node.sub.length ? mathLayout({ type: 'row', items: node.sub }, fs * 0.66, upright) : null;
          return mkBigopLimits(op.box, sup, sub, fs, !op.side);
        }
        return mkScript(mathLayout(node.base, fs, upright),
          node.sup && node.sup.length ? mathLayout({ type: 'row', items: node.sup }, fs * 0.70, upright) : null,
          node.sub && node.sub.length ? mathLayout({ type: 'row', items: node.sub }, fs * 0.70, upright) : null,
          fs);
      }
      default: return mkText('', fs, false, false);
    }
  }

  const MATH_SCALE = 3;         // 3 倍字号渲染：显示时缩回去，放大也不糊
  function mathBuild(src, fs) {
    const tree = mathParse(src);
    const box = mathLayout({ type: 'row', items: tree }, fs, false);
    const padX = fs * 0.16, padY = fs * 0.20;
    const w = Math.max(2, box.w + padX * 2), h = Math.max(2, box.a + box.d + padY * 2);
    return { box: box, w: w, h: h, padX: padX, padY: padY };
  }
  /* 画到 canvas 上（调用方给它一个足够大的 canvas）。
     取不到 2D 上下文（自检桩里 getContext 会直接抛）就只返回尺寸，不抛 —— 
     否则一个渲染不出来就会把整页 render() 带崩。 */
  function mathPaint(canvas, src, fs, color) {
    const m = mathBuild(src, fs);
    canvas.width = Math.max(2, Math.ceil(m.w * MATH_SCALE));
    canvas.height = Math.max(2, Math.ceil(m.h * MATH_SCALE));
    let ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
    if (!ctx) return m;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(MATH_SCALE, MATH_SCALE);
    ctx.fillStyle = color || INK;
    ctx.strokeStyle = color || INK;
    m.box.draw(ctx, m.padX, m.padY + m.box.a);
    return m;
  }
  /* 公式 → PNG data URL（存进节点用的就是它，四处渲染都靠它保持一致） */
  function formulaPNG(src, fs) {
    const cv = document.createElement('canvas');
    const m = mathPaint(cv, src, fs || 24, INK);
    return { src: cv.toDataURL('image/png'), w: Math.round(m.w), h: Math.round(m.h) };
  }

  /* ============================== 视图：内容编辑页 ============================== */
  function editorTop() {
    const top = div('editor-top');
    top.appendChild(div('back', { onclick: () => { S.showColorPanel = false; S.showExportPanel = false; S.showEditor = false; render(); } }, '‹'));
    const titleInput = el('input', 'title-input', { value: S.docTitle, placeholder: '未命名文档', oninput: e => updateDocTitle(e.target.value) });
    top.appendChild(titleInput);
    const seg = div('seg');
    seg.appendChild(div('opt' + (S.editorView === '编辑' ? ' on' : ''), { onclick: () => { S.showColorPanel = false; S.showExportPanel = false; S.editorView = '编辑'; render(); } }, '编辑'));
    seg.appendChild(div('opt' + (S.editorView === '导图' ? ' on' : ''), { onclick: () => { S.showColorPanel = false; S.showExportPanel = false; S.editorView = '导图'; render(); } }, '导图'));
    top.appendChild(seg);
    top.appendChild(div('exp-btn', { onclick: () => { S.showColorPanel = false; S.showExportPanel = true; render(); } }, '导出'));
    top.appendChild(div('add-btn', { onclick: () => addSiblingInEditor() }, '＋'));
    return top;
  }
  function outlineRow(row) {
    /* ★ 缩进跟随「标题N」的 N，不跟树深 depth（2026-09-25）：跨级降级时节点在树里的位置
       永远是「上一主题的下一级」，用 depth 画缩进，用户按多少次「降级」都看不到行往右挪 ——
       看起来就像"最低只能降到上一主题的下一级"。层级本身支持 1–9 自由设置（N 级大纲），
       缩进就该如实画到第 N 级。树结构只管折叠/导图，不管缩进。 */
    /* 多选模式下点行 = 勾选/取消勾选（不进编辑）；正常模式维持原行为。
       勾选圈画在层级点前面，选中行整行铺浅底色。 */
    const picked = S.multiSel && S.multiSelIds.indexOf(row.id) >= 0;
    const r = div('outline-row' + (S.multiSel ? ' multi' : '') + (picked ? ' m-sel' : ''), {
      style: { paddingLeft: (10 + Math.max(0, row.level - 1) * 22) + 'px', paddingRight: '6px' },
      onclick: () => { if (S.multiSel) toggleMultiPick(row.id); else selectNode(row.id); }
    });
    const dotcol = div('dotcol');
    if (S.multiSel) {
      /* 多选模式：勾选圈**替换**层级圆点（dotcol 只有 18px，两个都塞会挤坏） */
      dotcol.appendChild(div('mcheck' + (picked ? ' on' : ''), null, picked ? '✓' : ''));
    } else {
      const dot = div('dot', { style: {
        width: (row.level === 1 ? 7 : (row.level === 2 ? 6 : 5)) + 'px',
        height: (row.level === 1 ? 7 : (row.level === 2 ? 6 : 5)) + 'px',
        background: row.level <= 2 ? (row.level === 1 ? '#3F6B4F' : '#93A89A') : 'transparent',
        border: row.level >= 3 ? '1.4px solid #AEBAB3' : 'none', borderRadius: '6px'
      } });
      dotcol.appendChild(dot);
    }
    r.appendChild(dotcol);
    const body = div('row-body');
    /* 单态：这一行本身就是可编辑的富文本（contenteditable），不再是「查看态 div / 编辑态 textarea」来回换。
       换掉 textarea 的原因只有一个：它画不出「一段字一种样式」。要「编辑时就能看见每个字真实的样式」，
       编辑的宿主必须就是画 span 的那个元素（2026-09-23）。 */
    const inp = div('row-input', {
      'data-id': String(row.id),
      /* 多选模式下整行只做勾选，不让它接收文字输入（仍照常画出富文本内容） */
      contenteditable: S.multiSel ? 'false' : 'true',
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      role: 'textbox',
      style: {
        fontSize: row.fontSize + 'px', fontWeight: row.bold ? '700' : '400',
        color: row.color, textDecoration: row.underline ? 'underline' : 'none',
        lineHeight: '1.4', caretColor: MOSS
      },
      /* 打字只同步数据、不重渲染 —— 重渲染会把正在打字的 DOM 换掉，光标和中文输入都会被掐断 */
      oninput: e => { if (e.isComposing) return; onRowInput(row.id, readEditable(e.target)); },
      oncompositionend: e => { onRowInput(row.id, readEditable(e.target)); },
      onfocus: () => { S.editingRowId = row.id; selectNode(row.id); },
      onkeydown: e => {
        /* ★ 2026-09-24 用户要求把两个键的语义换回来：**回车 = 新增同级主题**，
           行内换行交给工具条上的「换行」按钮（见 insertLineBreak）。
           Shift+回车 是 Word 里「软换行」的通用键位，顺手保留；Ctrl/⌘+回车 也照旧可用，
           这样从前习惯 Ctrl+回车的用户不受影响 —— 三条路都通，没有谁被挡掉。 */
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey && !e.ctrlKey && !e.metaKey) editableInsert(row.id, e.target, '\n');
          else insertAfter(row.id);
        }
        else if (e.key === 'Backspace' && readEditable(e.target) === '') { e.preventDefault(); deleteRow(row.id); }
        else if (e.key === 'Tab') { e.preventDefault(); if (e.shiftKey) promote(row.id); else demote(row.id); }
        else if (e.key === 'ArrowUp' && !e.shiftKey && editableCaretAtEdge(e.target, -1)) { e.preventDefault(); moveFocus(row.id, -1); }
        else if (e.key === 'ArrowDown' && !e.shiftKey && editableCaretAtEdge(e.target, 1)) { e.preventDefault(); moveFocus(row.id, 1); }
      },
      /* 粘贴只收纯文本：contenteditable 默认会把外来的 HTML 整段塞进来，行内样式会被外来 span 污染 */
      onpaste: e => {
        e.preventDefault();
        const cd = e.clipboardData || window.clipboardData;
        const txt = cd && typeof cd.getData === 'function' ? String(cd.getData('text') || '') : '';
        if (txt) editableInsert(row.id, e.target, txt.split(/\r\n/g).join('\n'));
      }
    });
    richInto(inp, row);
    body.appendChild(inp);
    /* 文字与「公式/图片缩略图」装在同一列里：图放在文字下方，
       这样行高自适应（syncRowHeights 只量 textarea）不会被图撑坏。 */
    const strip = mediaStrip(row);
    if (strip) body.appendChild(strip);
    r.appendChild(body);
    if (row.hasChildren) r.appendChild(div('arrow ' + (row.collapsed ? 'collapsed' : 'open'), { onclick: ev => { ev.stopPropagation(); toggleCollapse(row.id); render(); } }, row.collapsed ? '▸' : '▾'));
    else r.appendChild(div('arrow', null, ''));
    return r;
  }
  /* 富文本编辑态（contenteditable）：按 effStyle 分组画 span（runs 存在才有视觉差异，没有则整行一个样式）。
     它就是「看到的」也是「编辑的」—— 同一个宿主，所以样式一改立刻看得见（2026-09-23 去掉双态）。 */
  function richInto(target, row) {
    const text = String(row.text || '');
    /* 空行不塞节点：contenteditable 的 textContent 读出来就是 ''，高度交给 CSS（min-height + :empty 提示）。
       塞 \u00a0 的话 readEditable 会多读出一个字符，数据里就凭空多一个空格。 */
    if (text.length === 0) return;
    let i = 0;
    while (i < text.length) {
      const st = effStyle(row, i);
      let j = i + 1;
      while (j < text.length && sameEffStyle(effStyle(row, j), st)) j++;
      const span = document.createElement('span');
      span.textContent = text.slice(i, j);
      span.style.fontSize = st.fz + 'px';
      span.style.fontWeight = st.b ? '700' : '400';
      span.style.color = st.c || '';
      span.style.textDecoration = st.u ? 'underline' : 'none';
      target.appendChild(span);
      i = j;
    }
  }
  /* ---- 富文本编辑框（contenteditable）：「整行第几个字」与 DOM 位置的互译 ----
   * 行里的 span 是按样式切的分段，选区必须跨 span 连续，所以不能用 childIndex，得按文本长度累加。 */
  /* ⚠ 子节点必须看 childNodes，不能看 children —— children 只含**元素**，
     而浏览器里 span 装的是文本节点，用 children 判断「有没有子节点」会把整段文字
     当成「叶子元素自带文本」一次累加，文本节点永远遍历不到，偏移恒为 0（2026-09-23 真浏览器实测）。
     DOM 桩没有 childNodes（它的文本挂在元素上），回落到 children 后自然走叶子分支。 */
  function kidsOf(n) {
    const cn = n.childNodes;
    return (cn && cn.length) ? cn : (n.children || []);
  }
  function textOffsetIn(root, node, off) {
    let acc = 0, found = -1;
    const walk = (n) => {
      if (found >= 0) return;
      if (n.nodeType === 3) {
        if (n === node) { found = acc + (off || 0); return; }
        acc += (n.nodeValue === undefined ? (n.textContent || '') : n.nodeValue).length;
        return;
      }
      if (n.nodeType !== 1) return;
      const ch = kidsOf(n);
      /* 没有子节点却带着文本（DOM 桩的 textContent setter 不建文本节点）——
         这种「叶子元素」要当成一段文本算进去，否则整行的偏移会少算一整段。 */
      if (ch.length === 0) {
        const own = n.textContent || '';
        if (own) {
          if (n === node) { found = acc + Math.min(off || 0, own.length); return; }
          acc += own.length; return;
        }
      }
      for (let i = 0; i < ch.length; i++) {
        if (found >= 0) return;
        if (n === node && i === off) { found = acc; return; }   // 容器节点：offset 是子节点的下标
        walk(ch[i]);
      }
      if (n === node && (off || 0) >= ch.length) found = acc;
    };
    walk(root);
    return found < 0 ? 0 : found;
  }
  /* 反向：把「第 off 个字」翻译成 DOM 里的 (文本节点, 节点内偏移)，用于把光标放回去 */
  function locateOffset(root, off) {
    let acc = 0, res = null;
    const walk = (n) => {
      if (res) return;
      if (n.nodeType === 3) {
        const len = (n.nodeValue === undefined ? (n.textContent || '') : n.nodeValue).length;
        if (off <= acc + len) { res = { node: n, off: off - acc }; return; }
        acc += len; return;
      }
      if (n.nodeType !== 1) return;
      const ch = kidsOf(n);
      /* 同上：叶子元素自带文本时，它自己就是落点（DOM 桩会出现这种情况） */
      if (ch.length === 0) {
        const own = n.textContent || '';
        if (own) { if (off <= acc + own.length) { res = { node: n, off: off - acc }; return; } acc += own.length; return; }
      }
      ch.forEach(walk);
    };
    walk(root);
    return res || { node: root, off: (root.children || []).length };
  }
  /* 读编辑框里的纯文本（空行本来就没子节点，读出来是 ''） */
  function readEditable(e) { return e ? String(e.textContent === undefined ? '' : e.textContent) : ''; }
  /* 编辑框里的选区：contenteditable 走 Selection，textarea 走 selectionStart/End（导图改文字框仍是 textarea） */
  function selOfEditable(e) {
    if (!e) return null;
    if (typeof e.selectionStart === 'number' && typeof e.setSelectionRange === 'function') {
      const s = e.selectionStart, en = e.selectionEnd;
      return { s: Math.min(s, en), e: Math.max(s, en) };
    }
    try {
      const sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      if (typeof e.contains !== 'function') return null;
      if (!e.contains(r.startContainer) || !e.contains(r.endContainer)) return null;
      const s = textOffsetIn(e, r.startContainer, r.startOffset);
      const en = textOffsetIn(e, r.endContainer, r.endOffset);
      return { s: Math.min(s, en), e: Math.max(s, en) };
    } catch (err) { return null; }
  }
  /* 把光标/选区放回编辑框的 [s,e) —— 样式改完要整体重渲染，DOM 是新画的，必须显式还原 */
  function setSelOfEditable(e, s, en) {
    if (!e) return;
    if (typeof e.setSelectionRange === 'function') { try { e.focus(); e.setSelectionRange(s, en); } catch (err) { } return; }
    try {
      const doc = e.ownerDocument || document;
      const sel = (doc.getSelection && doc.getSelection()) || (window.getSelection && window.getSelection());
      if (!sel || !doc.createRange) return;
      const a = locateOffset(e, s), b = locateOffset(e, en);
      const r = doc.createRange();
      r.setStart(a.node, a.off); r.setEnd(b.node, b.off);
      sel.removeAllRanges(); sel.addRange(r);
    } catch (err) { }
  }
  /* 往编辑框的光标处插一段纯文本（换行 / 粘贴都走这里）：
     数据先改，再整体重渲染把光标放到插入点后面 —— 这样 DOM 里的 span 永远是数据画出来的，不会跑偏。 */
  function editableInsert(id, e, text) {
    const el = e && e.target ? e.target : e;
    const host = el || (S.editingRowId ? appEl.querySelector('.row-input[data-id="' + S.editingRowId + '"]') : null);
    if (!host) return;
    const sel = selOfEditable(host) || { s: readEditable(host).length, e: readEditable(host).length };
    const cur = readEditable(host);
    updateNodeText(id, cur.slice(0, sel.s) + String(text) + cur.slice(sel.e));
    refocusSel(id, sel.s + String(text).length, sel.s + String(text).length);
    render();
  }
  /* ★ 「换行」按钮（2026-09-24 用户要求）：在光标处插入一个**行内换行**。
     回车已经改成「新增同级主题」，所以这个按钮成了换行的主要入口（Shift+回车是顺手路径）。
     三个入口各有各的宿主，别只照顾一个：
       ① 导图「改文字」框（textarea）—— 它自己能画换行，在光标/选区处拼一个 '\n' 即可；
       ② 大纲行（contenteditable）—— 交给 editableInsert 插一个真的 '\n'
          （contenteditable 默认插 <br>/<div>，textContent 读不到换行，见坑 10e）；
       ③ 导图视图里选中了主题但还没开「改文字」—— 直接进改文字状态并在末尾补一行，
          否则用户在导图上点「换行」会毫无反应。 */
  function insertLineBreak() {
    const mt = appEl.querySelector('textarea[data-map-edit]');
    if (mt) {
      const v = String(mt.value === undefined ? (S.mapEditText || '') : mt.value);
      let s = v.length, en = v.length;
      try { if (typeof mt.selectionStart === 'number') { s = mt.selectionStart; en = mt.selectionEnd; } } catch (err) { }
      mt.value = v.slice(0, s) + '\n' + v.slice(en);
      S.mapEditText = mt.value;
      try { mt.setSelectionRange(s + 1, s + 1); } catch (err) { }
      if (typeof mt.focus === 'function') mt.focus();
      return;
    }
    const ctx = styleContext();
    if (ctx && ctx.host) { editableInsert(ctx.node.id, ctx.host, '\n'); return; }
    if (S.mapNodeId) {
      const n = findNode(S.mapNodeId);
      if (n !== undefined) {
        S.mapEditText = String(n.text || '').replace(/\n+$/, '') + '\n';
        S.mapEditing = true;
        pendingMapSel = { s: S.mapEditText.length, e: S.mapEditText.length };
        render();
        showNotice('已在主题末尾加一个换行 —— 接着打的字会写在第二行');
        return;
      }
    }
    showNotice('请先把光标放到主题文字里，再点「换行」');
  }
  /* 光标是否在本框的首行(dir=-1)/末行(dir=1)：只有到边界才把上下键让给「换行焦点」 */
  function editableCaretAtEdge(e, dir) {
    const host = e && e.target ? e.target : e;
    const sel = selOfEditable(host); if (!sel || sel.s !== sel.e) return false;
    const t = readEditable(host);
    const seg = dir < 0 ? t.slice(0, sel.s) : t.slice(sel.s);
    return seg.indexOf('\n') < 0;
  }
  /* 文本 diff：新文本里「真正新写进去」的那一段 [s,e) —— 后续输入的字就落在这一段上 */
  function insertRange(oldText, newText) {
    const o = String(oldText || ''), n = String(newText || '');
    const ol = o.length, nl = n.length;
    if (nl <= ol) return { s: 0, e: 0 };
    let p = 0; const maxP = Math.min(ol, nl);
    while (p < maxP && o[p] === n[p]) p++;
    let sx = 0; const maxS = Math.min(ol - p, nl - p);
    while (sx < maxS && o[ol - 1 - sx] === n[nl - 1 - sx]) sx++;
    return { s: p, e: nl - sx };
  }
  /* 一行里挂着的公式/图片：缩略图 + 点开查看器（裁剪/旋转）+ 移除 + 改公式 */
  function mediaStrip(row) {
    const list = row.media;
    if (!list || !list.length) return null;
    const strip = div('media-strip');
    list.forEach(m => {
      const d = mediaFit(m, MEDIA_ROW_MAX_W, MEDIA_ROW_MAX_H);
      const cell = div('media-cell', {
        title: m.kind === 'formula' ? '点开：查看 / 裁剪 / 旋转公式' : '点开：查看 / 裁剪 / 旋转图片',
        onclick: ev => { ev.stopPropagation(); openMediaView(row.id, m.id); }
      });
      cell.appendChild(el('img', 'media-img', {
        src: m.src, alt: m.kind === 'formula' ? '公式' : '图片', draggable: 'false',
        style: { width: d.w + 'px', height: d.h + 'px' }
      }));
      if (m.kind === 'formula') {
        cell.appendChild(div('media-btn', {
          title: '重新编辑这条公式',
          onclick: ev => { ev.stopPropagation(); openFormula(row.id, m.id); }
        }, 'ƒx'));
      }
      cell.appendChild(div('media-btn danger', {
        title: '从这一行移除',
        onclick: ev => { ev.stopPropagation(); removeMediaFromRow(row.id, m.id); }
      }, '✕'));
      strip.appendChild(cell);
    });
    return strip;
  }
  function removeMediaFromRow(nodeId, mid) {
    const found = findMediaAcrossDoc(mid);
    removeNodeMedia(nodeId, mid);
    render();
    showNotice(found && found.item.kind === 'formula' ? '已移除这条公式' : '已移除这张图片');
  }
  function editorScroll() {
    const rows = outlineRows();
    const scroll = div('editor-scroll');
    if (rows.length === 0) {
      const empty = div('empty-state', null, [
        div('big', null, '☷'), div('t', null, '还没有内容'),
        div('s', null, '回车新增一条 · Shift+回车换行 · 最右侧箭头收起子级'),
        div('btn', { onclick: () => addNodeInEditor() }, '＋ 添加第一条')
      ]);
      scroll.appendChild(empty); return scroll;
    }
    const box = div('rows');
    rows.forEach(row => box.appendChild(outlineRow(row)));
    box.appendChild(div('empty-hint', { onclick: () => addNodeInEditor() }, [div('plus', null, '＋'), div('txt', null, '点这里新增一条')]));
    box.appendChild(div('rows-bottom'));
    scroll.appendChild(box);
    return scroll;
  }
  function toolbar() {
    const bar = div('toolbar');
    bar.appendChild(div('level-label', { onclick: () => { S.showLevelMenu = !S.showLevelMenu; render(); } }, currentLevelLabel()));
    const mk = (icon, label, fn) => div('tool-btn', { onclick: fn }, [div('ic', null, icon), div('lb', null, label)]);
    bar.appendChild(mk('A-', '缩小', () => zoomFont(-2)));
    bar.appendChild(mk('A+', '放大', () => zoomFont(2)));
    bar.appendChild(mk('B', '加粗', () => toggleBold()));
    bar.appendChild(mk('U', '下划线', () => toggleUnderline()));
    /* 回车改回「新增同级主题」之后，换行只能从这里走（Shift+回车是顺手路径） */
    bar.appendChild(mk('↵', '换行', () => insertLineBreak()));
    bar.appendChild(div('tool-btn', { onclick: () => { S.showColorPanel = !S.showColorPanel; render(); } }, [div('color-dot', { style: { background: currentColor() } }), div('lb', null, '颜色')]));
    /* 2026-09-22 新增：公式与图片 */
    bar.appendChild(mk('∑', '公式', () => openFormula(activeNodeId(), '')));
    bar.appendChild(mk('▣', '图片', () => pickImage()));   /* 包一层：别把 MouseEvent 当 nodeId 传进去 */
    bar.appendChild(mk('←', '升级', () => promoteEditing()));
    bar.appendChild(mk('→', '降级', () => demoteEditing()));
    bar.appendChild(mk('☑', '多选', () => toggleMultiSel()));
    bar.appendChild(div('tool-btn', { onclick: () => removeActiveRow() }, [div('ic', { style: { color: '#B4574E' } }, '✕'), div('lb', null, '删除')]));
    return bar;
  }
  /* 多选批量条：只提供升降级两个批量动作（与单选同一套校验），加上全选/完成 */
  function multiBar() {
    const bar = div('multi-bar');
    bar.appendChild(div('multi-count', null, '已选 ' + S.multiSelIds.length + ' 个主题'));
    const mk = (label, fn, cls) => div('multi-btn' + (cls ? ' ' + cls : ''), { onclick: fn }, label);
    bar.appendChild(mk('全选', () => multiPickAll()));
    bar.appendChild(mk('升级', () => multiLevel(-1)));
    bar.appendChild(mk('降级', () => multiLevel(1)));
    bar.appendChild(mk('完成', () => exitMultiSel(), 'done'));
    return bar;
  }
  function levelMenu() {
    const overlay = div('overlay', { style: { background: 'transparent', zIndex: '50' }, onclick: () => { S.showLevelMenu = false; render(); } });
    const menu = div('level-menu', { style: { left: '8px', bottom: '70px' } });
    LEVEL_OPTIONS.forEach(lv => menu.appendChild(div('item', { onclick: ev => { ev.stopPropagation(); S.showLevelMenu = false; applyLevel(lv); } }, '标题 ' + lv)));
    overlay.appendChild(menu);
    return overlay;
  }
  function colorPanel() {
    const overlay = div('color-panel');
    overlay.appendChild(div('mask', { style: { flex: '1' }, onclick: () => { S.showColorPanel = false; render(); } }));
    const grid = div('color-grid');
    [0, 1].forEach(r => {
      const row = div('color-row');
      colorRow(r).forEach(item => {
        row.appendChild(div('swatch-wrap' + (currentColor() === item.value ? ' sel' : ''), { onclick: () => { changeColor(item.value); S.showColorPanel = false; render(); } }, [div('swatch', { style: { background: item.value } })]));
      });
      grid.appendChild(row);
    });
    overlay.appendChild(grid);
    return overlay;
  }
  function exportPanel() {
    const overlay = div('export-panel');
    overlay.appendChild(div('mask', { style: { flex: '1' }, onclick: () => { S.showExportPanel = false; render(); } }));
    const sheet = div('export-sheet');
    sheet.appendChild(div('head', null, [
      div('col', null, [el('h3', null, null, '导出'), div('s', null, '保存位置由浏览器下载框指定，无需额外权限')]),
      div('x', { onclick: () => { S.showExportPanel = false; render(); } }, '✕')
    ]));
    EXPORT_OPTIONS.forEach(opt => {
      const busy = S.exporting && S.exportingKey === opt.key;
      sheet.appendChild(div('export-opt', { onclick: () => onExport(opt.key) }, [
        div('ic', null, opt.icon),
        div('col', null, [div('t', null, opt.title), div('d', null, busy ? '正在生成，请稍候…' : opt.desc)]),
        busy ? div('spinner') : div('chev', null, '›')
      ]));
    });
    overlay.appendChild(sheet);
    return overlay;
  }
  function ContentEditor() {
    const wrap = div('col', { style: { width: '100%', height: '100%', background: '#fff', position: 'relative' } });
    wrap.appendChild(editorTop());
    /* ★ 功能栏在**内容上方**（2026-09-24）。原来在底部，手机上一打字软键盘就从下面顶上来，
       把整条功能栏盖住 —— 加粗、换行、颜色全点不到。挪到顶部后键盘再怎么弹都压不着它。
       代价是「功能栏贴着输入区」的那点顺手感没了，换来的是手机上真的能用。 */
    if (S.editorView === '导图') wrap.appendChild(mapView());
    else { wrap.appendChild(toolbar()); if (S.multiSel) wrap.appendChild(multiBar()); wrap.appendChild(editorScroll()); }
    if (S.showLevelMenu) wrap.appendChild(levelMenu());
    if (S.showColorPanel && S.editorView === '编辑') wrap.appendChild(colorPanel());
    if (S.showExportPanel) wrap.appendChild(exportPanel());
    return wrap;
  }

  /* ============================== 视图：思维导图 ============================== */
  function mapView() {
    const wrap = div('map-view');
    const topbar = div('map-topbar');
    const chips = div('style-chips');
    MAP_STYLES.forEach(style => chips.appendChild(div('chip' + (S.mapStyle === style ? ' on' : ''), { onclick: () => { S.mapStyle = style; render(); } }, style)));
    topbar.appendChild(chips);
    /* 改文字面板开着时缩放条要上移（否则它压在面板右端，「确定」点不到 —— 见 styles.css 的注释） */
    const zoom = div('map-zoombar' + (S.mapEditing ? ' editing' : ''));
    zoom.appendChild(div('zoom-btn', { onclick: () => setMapZoom(S.mapZoom / 1.2) }, '−'));
    zoom.appendChild(div('map-zoom-val', null, Math.round(S.mapZoom * 100) + '%'));
    zoom.appendChild(div('zoom-btn', { onclick: () => setMapZoom(S.mapZoom * 1.2) }, '＋'));
    zoom.appendChild(div('zoom-fit', { onclick: () => mapFit() }, '适应'));
    topbar.appendChild(zoom);
    wrap.appendChild(topbar);
    /* 内容编辑与主题增删的工具条：操作的都是同一份 nodes，所以天然与文档大纲互通 */
    wrap.appendChild(mapEditBar());
    /* 改文字时那个多行输入框也放在**上方**（和文档功能栏同一个理由：手机软键盘从底部顶上来，
       底部输入框会被整个盖住，等于没法在导图上打字）。顺带它不再和右下角缩放条抢位置了。 */
    if (S.mapEditing) wrap.appendChild(MapEditPanel());
    const scroll = div('map-scroll');
    if (contentRows().length === 0) {
      scroll.appendChild(div('empty-state', null, [div('big', null, '☷'), div('t', null, '还没有大纲内容'), div('s', null, '在编辑页里写下第一条内容，导图会自动生成')]));
    } else {
      const layout = currentLayout();
      const scaler = div('map-scaler', { style: { width: layout.width + 'px', height: layout.height + 'px' } });
      scaler.dataset.w = String(layout.width); scaler.dataset.h = String(layout.height);
      const board = mapBoard();
      scaler.appendChild(board);
      scroll.appendChild(scaler);
      attachMapInteractions(scroll);
    }
    wrap.appendChild(scroll);
    /* 颜色面板：导图这边也要有（需求「导图的编辑工具栏和文档内容一样，都能改颜色」）。
     * 面板本身是 `position:absolute; bottom:0`，所以 `.map-view` 必须有 position:relative 才锚得对。 */
    if (S.showColorPanel) wrap.appendChild(colorPanel());
    return wrap;
  }
  /* 拖动平移。
   * ★★ 这里有过一个「点了框没反应」的真 bug（用户报「思维导图编辑时无法选中且编辑」）：
   *  原来 pointerdown 里**无条件** `scroll.setPointerCapture(e.pointerId)`。
   *  指针一旦被 .map-scroll 捕获，后续的 pointerup / mouseup 全部**改派到 .map-scroll**，
   *  而 `click` 按规范派发到「按下与抬起目标的最近公共祖先」——于是 click 也落在 .map-scroll 上，
   *  **主题框自己的 onclick 永远不会触发**（双击同理）。真浏览器实测的事件轨迹：
   *    不修：pointerdown→DIV.bt(框内)  pointerup→DIV.map-scroll  click→DIV.map-scroll  ⇒ S.mapNodeId 不变
   *    修后：pointerdown→DIV.bt        pointerup→DIV.bt         click→DIV.bt          ⇒ S.mapNodeId 被选中
   *  为什么自检一直没发现：`test-ui.js` 是 DOM 桩（没有指针捕获这回事），
   *  而 `test-e2e.js` 用的是**程序化 `b.click()`** —— 它直接派发 click、根本不经过 pointerdown，
   *  于是桩里绿、浏览器里红。**用户点击的可达性只能靠「真鼠标事件」验**（CDP Input.dispatchMouseEvent）。
   *  修法：给拖动加一个 4px 阈值，**只有真的开始拖了才捕获指针**；
   *  单纯的点击（没有位移）全程不捕获，click 就还留在框上。 */
  function attachMapInteractions(scroll) {
    scroll.style.cursor = 'grab';
    scroll.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); setMapZoom(S.mapZoom * (e.deltaY < 0 ? 1.1 : 0.9)); }
    }, { passive: false });
    const DRAG_MIN = 4;   // 位移超过这么多像素才算「拖」，否则当点击
    let active = false, dragging = false, pid = 0, px = 0, py = 0, sl = 0, st = 0;
    scroll.addEventListener('pointerdown', e => {
      if (e.button) return;                       // 只处理左键，别把中键/右键的默认行为搅进来
      active = true; dragging = false; pid = e.pointerId;
      px = e.clientX; py = e.clientY; sl = scroll.scrollLeft; st = scroll.scrollTop;
    });
    scroll.addEventListener('pointermove', e => {
      if (!active) return;
      if (!dragging) {
        if (Math.abs(e.clientX - px) < DRAG_MIN && Math.abs(e.clientY - py) < DRAG_MIN) return;
        dragging = true;
        scroll.style.cursor = 'grabbing';
        try { scroll.setPointerCapture(e.pointerId); } catch (_) { }
        /* 把起点挪到「越过阈值的那一刻」，否则一进入拖动会先跳 4px */
        px = e.clientX; py = e.clientY; sl = scroll.scrollLeft; st = scroll.scrollTop;
        return;
      }
      scroll.scrollLeft = sl - (e.clientX - px);
      scroll.scrollTop = st - (e.clientY - py);
    });
    const end = () => {
      active = false; dragging = false; scroll.style.cursor = 'grab';
      try { if (pid && scroll.hasPointerCapture && scroll.hasPointerCapture(pid)) scroll.releasePointerCapture(pid); } catch (_) { }
      pid = 0;
    };
    scroll.addEventListener('pointerup', end);
    scroll.addEventListener('pointercancel', end);
  }
  function setMapZoom(z) { S.mapZoom = Math.max(0.3, Math.min(3, z)); applyMapZoom(); }
  function applyMapZoom() {
    const scaler = appEl.querySelector('.map-scaler');
    const board = appEl.querySelector('.map-board');
    const val = appEl.querySelector('.map-zoom-val');
    if (!scaler || !board) return;
    const w = parseFloat(scaler.dataset.w) || 1, h = parseFloat(scaler.dataset.h) || 1;
    board.style.transformOrigin = '0 0';
    board.style.transform = 'scale(' + S.mapZoom + ')';
    scaler.style.width = (w * S.mapZoom) + 'px';
    scaler.style.height = (h * S.mapZoom) + 'px';
    if (val) val.textContent = Math.round(S.mapZoom * 100) + '%';
  }
  function mapFit() {
    const scroll = appEl.querySelector('.map-scroll');
    const scaler = appEl.querySelector('.map-scaler');
    if (!scroll || !scaler) return;
    const w = parseFloat(scaler.dataset.w) || 1, h = parseFloat(scaler.dataset.h) || 1;
    const availW = scroll.clientWidth - 48, availH = scroll.clientHeight - 48;
    setMapZoom(Math.min(availW / w, availH / h, 1.5));
    requestAnimationFrame(() => {
      scroll.scrollLeft = Math.max(0, (scaler.offsetWidth - scroll.clientWidth) / 2);
      scroll.scrollTop = Math.max(0, (scaler.offsetHeight - scroll.clientHeight) / 2);
    });
  }
  function mapBoard() {
    const layout = currentLayout();
    const board = div('map-board', { style: { width: layout.width + 'px', height: layout.height + 'px' } });
    layout.segs.forEach(seg => board.appendChild(div('map-seg', {
      style: { left: seg.x + 'px', top: seg.y + 'px', width: seg.w + 'px', height: seg.h + 'px', background: seg.color, transform: 'rotate(' + seg.angle + 'deg)', transformOrigin: 'center', borderRadius: '1px' }
    })));
    layout.boxes.forEach(b => {
      /* nodeId <= 0 是「虚拟根」（就是文档标题），它不是一条真实主题，不给点选 */
      const pickable = (b.nodeId !== undefined && b.nodeId > 0);
      const sel = pickable && S.mapNodeId === b.nodeId;
      const attrs = {
        style: { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px', background: b.bg, border: b.borderW + 'px solid ' + (sel ? '#C9A227' : b.border), borderRadius: b.radius + 'px' }
      };
      if (pickable) {
        attrs['data-node-id'] = String(b.nodeId);
        attrs.title = '点一下选中这个主题，双击直接改文字';
        attrs.onclick = ev => { ev.stopPropagation(); mapPick(b.nodeId); };
        attrs.ondblclick = ev => {
          ev.stopPropagation();
          S.mapNodeId = b.nodeId; S.selectedNodeId = b.nodeId; S.editNodeId = b.nodeId;
          startMapEdit();
        };
      }
      const box = div('map-box' + (pickable ? ' tap' : '') + (sel ? ' sel' : ''), attrs);
      const inner = div('inner');
      const lines = (b.lines && b.lines.length) ? b.lines : [b.text];
      /* 挂了图片/公式的主题：框里画第一张（布局已按它把框撑大，见 nodeSize/pushBox） */
      if (b.mediaBox && b.media) {
        const mid = b.media.id, isF = b.media.kind === 'formula';
        inner.appendChild(el('img', 'map-media', {
          src: b.media.src, alt: isF ? '公式' : '图片', draggable: 'false',
          /* 点开 = 查看 / 裁剪 / 旋转（与文档编辑页的缩略图同一套行为）。
           * 先选中再打开：查看器关掉以后回到导图，这个主题还是选中的，
           * 否则「只有一个图片、没有文字」的主题点了图之后就没法选中了。 */
          title: isF ? '点开：查看 / 裁剪 / 旋转公式' : '点开：查看 / 裁剪 / 旋转图片',
          onclick: ev => {
            ev.stopPropagation();
            S.mapNodeId = b.nodeId; S.selectedNodeId = b.nodeId; S.editNodeId = b.nodeId;
            openMediaView(b.nodeId, mid);
          },
          style: { width: b.mediaBox.w + 'px', height: b.mediaBox.h + 'px' }
        }));
      }
      if (lines.join('').length > 0) {
        const bt = div('bt', { style: { fontSize: b.font + 'px', fontWeight: b.bold ? '700' : '500', color: b.fg, textDecoration: b.underline ? 'underline' : 'none' } });
        if (b.lineSpans) {
          /* 行内 runs：逐行逐段画 span（行与行之间补 \n，靠 .bt 的 pre-wrap 换行） */
          b.lineSpans.forEach((spans, li) => {
            if (li > 0) bt.appendChild(document.createTextNode('\n'));
            spans.forEach(sp => {
              const sp2 = document.createElement('span');
              sp2.textContent = sp.t;
              sp2.style.fontSize = sp.fs + 'px';
              sp2.style.fontWeight = sp.b ? '700' : '500';
              sp2.style.color = sp.c || '';
              sp2.style.textDecoration = sp.u ? 'underline' : 'none';
              bt.appendChild(sp2);
            });
          });
        } else {
          bt.appendChild(document.createTextNode(lines.join('\n')));
        }
        inner.appendChild(bt);
      }
      if (b.sub) inner.appendChild(div('bs', { style: { fontSize: b.subFont + 'px', color: b.subFg } }, b.sub));
      box.appendChild(inner);
      board.appendChild(box);
    });
    return board;
  }

  /* ===================================================================================
   * 公式与图片：交互（2026-09-22 新增）
   * =================================================================================== */

  /* ---------- 选图 ---------- */
  /* `nodeIdArg` 是给导图工具条用的：那里要显式指定「插到选中的那个主题」。
   * ⚠ 调用点必须写成 `() => pickImage(id)`，**不能直接把函数当 click 处理器**
   * —— 那样第一个实参是 MouseEvent，会被当成 nodeId 用。 */
  function pickImage(nodeIdArg) {
    const nodeId = nodeIdArg || activeNodeId();
    if (!nodeId) { showNotice('请先点选一行内容，图片会插到那一行'); return; }
    const inp = el('input', null, { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const cleanup = () => { try { if (inp.parentNode) inp.parentNode.removeChild(inp); } catch (e) { } };
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      cleanup();
      if (!f) return;
      /* ★ 单图上限为什么是 2MB 而不是 6MB（2026-09-22 修正）：
       * 图片是**原样**以 base64 存进 `node.media[].src` 的，base64 会把字节放大 4/3，
       * 而整份文档库都挤在 localStorage（多数浏览器每个源只有约 5MB）里。
       * 6MB 的图 → 约 8MB 的字符串，**本地根本存不下、服务端也会 413**，
       * 结果是「插进去看着好好的、一刷新就没了」。2MB 才算「存得下的上限」。
       * 需要更大的图就先用查看器里的裁剪缩小，或先压缩。 */
      if (f.size > 2 * 1024 * 1024) {
        showNotice('图片太大了（上限 2 MB）：图片会内嵌进文档，太大就存不下了。先裁剪或压缩一下再插');
        return;
      }
      if (!/^image\//.test(f.type)) { showNotice('这不是图片文件'); return; }
      const fr = new FileReader();
      fr.onload = () => { insertImageData(nodeId, String(fr.result)); };
      fr.onerror = () => showNotice('读取图片失败，换一张试试');
      fr.readAsDataURL(f);
    });
    document.body.appendChild(inp);
    inp.click();
    /* 用户点了「取消」时 change 不会触发，这里兜个底把隐藏的 input 收掉。
       不能马上删 —— 文件对话框是异步开的，DOM 里没有它就弹不出来。 */
    setTimeout(cleanup, 60000);
  }
  async function insertImageData(nodeId, dataUrl) {
    let im = null;
    try { im = await loadImage(dataUrl); } catch (e) { showNotice('这张图片解不出来，换一张试试'); return; }
    const w = im.naturalWidth || im.width || 0, h = im.naturalHeight || im.height || 0;
    const mid = addNodeMedia(nodeId, { kind: 'img', src: dataUrl, w: w || 200, h: h || 150 });
    /* 选完直接打开查看器 —— 用户要的「选入时就能裁剪和旋转」就是这一步 */
    S.mediaView = { nodeId: nodeId, mediaId: mid };
    S.mediaSel = null; S.mediaRot = 0;
    render();
    showNotice('图片已插入，可以在这里裁剪或旋转');
  }

  /* ---------- 图片/公式查看器：裁剪 + 旋转 ---------- */
  let mediaPaint = null;   // 上一次绘制的几何 {x,y,w,h,iw,ih}（舞台 CSS 坐标），裁剪换算靠它
  function openMediaView(nodeId, mid) {
    const found = findMediaAcrossDoc(mid);
    if (!found) return;
    S.mediaView = { nodeId: found.nodeId, mediaId: mid };
    S.mediaSel = null; S.mediaRot = 0;
    render();
  }
  function closeMediaView() { S.mediaView = null; S.mediaSel = null; S.mediaRot = 0; mediaPaint = null; render(); }
  function removeMediaFromViewer() {
    const mv = S.mediaView; if (!mv) return;
    const found = findMediaAcrossDoc(mv.mediaId);
    const kind = found ? found.item.kind : 'img';
    removeNodeMedia(mv.nodeId, mv.mediaId);
    S.mediaView = null; S.mediaSel = null; S.mediaRot = 0; mediaPaint = null;
    render();
    showNotice(kind === 'formula' ? '已移除这条公式' : '已移除这张图片');
  }
  function setMediaAspect(r) {
    if (!mediaPaint) return;
    const w = mediaPaint.w, h = mediaPaint.h;
    let cw = w, ch = cw / r;
    if (ch > h) { ch = h; cw = ch * r; }
    S.mediaSel = { x: (w - cw) / 2 / w, y: (h - ch) / 2 / h, w: cw / w, h: ch / h };
    render();
  }
  function MediaViewer() {
    const mv = S.mediaView || {};
    const found = findMediaAcrossDoc(mv.mediaId);
    const item = (found && found.item) || { kind: 'img', src: '', w: 1, h: 1 };
    const isFormula = item.kind === 'formula';
    const overlay = div('overlay dark centered media-top');
    const card = div('media-card');
    card.appendChild(div('media-head', null, [
      div(null, null, [
        div('media-title', null, isFormula ? '公式' : '图片'),
        div('media-sub', null, '在图上按住拖动 = 框选裁剪范围；旋转按钮改角度；确认后点「应用」')
      ]),
      div('sheet-close', { onclick: closeMediaView }, '×')
    ]));
    const stage = div('media-stage');
    stage.setAttribute('data-media-stage', '1');
    stage.appendChild(el('canvas', 'media-canvas', { 'data-media-canvas': '1' }));
    const selEl = div('media-sel', { style: { display: 'none' } });
    selEl.setAttribute('data-media-sel', '1');
    stage.appendChild(selEl);
    ['t', 'b', 'l', 'r'].forEach(k => {
      const d = div('media-dim');
      d.setAttribute('data-media-dim', k);
      stage.appendChild(d);
    });
    /* 拖拽框选。指针事件挂在 stage 上，用 getBoundingClientRect 换算成舞台坐标。 */
    let dragging = false, startPt = null;
    const ptOf = e => {
      const r = stage.getBoundingClientRect ? stage.getBoundingClientRect() : { left: 0, top: 0 };
      return { x: (e.clientX || 0) - r.left, y: (e.clientY || 0) - r.top };
    };
    const selFrom = (a, b) => {
      const g = mediaPaint;
      if (!g) return null;
      const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
      const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
      const cx1 = Math.max(g.x, Math.min(g.x + g.w, x1)), cy1 = Math.max(g.y, Math.min(g.y + g.h, y1));
      const cx2 = Math.max(g.x, Math.min(g.x + g.w, x2)), cy2 = Math.max(g.y, Math.min(g.y + g.h, y2));
      if (cx2 - cx1 < 8 || cy2 - cy1 < 8) return null;
      return { x: (cx1 - g.x) / g.w, y: (cy1 - g.y) / g.h, w: (cx2 - cx1) / g.w, h: (cy2 - cy1) / g.h };
    };
    stage.addEventListener('pointerdown', e => {
      dragging = true; startPt = ptOf(e);
      try { stage.setPointerCapture(e.pointerId); } catch (_) { }
    });
    stage.addEventListener('pointermove', e => {
      if (!dragging) return;
      const s = selFrom(startPt, ptOf(e));
      if (s) { S.mediaSel = s; paintMediaSel(); paintMediaNote(); }
    });
    const stop = () => { dragging = false; startPt = null; };
    stage.addEventListener('pointerup', stop);
    stage.addEventListener('pointercancel', stop);
    card.appendChild(stage);
    card.appendChild(div('media-tools', null, [
      div('mt-label', null, '旋转'),
      el('button', 'mt-btn', { onclick: () => { S.mediaRot = ((S.mediaRot - 90) % 360 + 360) % 360; render(); } }, '↺ 90°'),
      el('button', 'mt-btn', { onclick: () => { S.mediaRot = (S.mediaRot + 90) % 360; render(); } }, '↻ 90°'),
      el('button', 'mt-btn', { onclick: () => { S.mediaRot = ((S.mediaRot - 5) % 360 + 360) % 360; render(); } }, '−5°'),
      el('button', 'mt-btn', { onclick: () => { S.mediaRot = (S.mediaRot + 5) % 360; render(); } }, '+5°'),
      el('button', 'mt-btn', { onclick: () => { S.mediaRot = 0; render(); } }, '角度归零')
    ]));
    card.appendChild(div('media-tools', null, [
      div('mt-label', null, '裁剪'),
      el('button', 'mt-btn', { onclick: () => setMediaAspect(1) }, '1:1'),
      el('button', 'mt-btn', { onclick: () => setMediaAspect(4 / 3) }, '4:3'),
      el('button', 'mt-btn', { onclick: () => setMediaAspect(16 / 9) }, '16:9'),
      el('button', 'mt-btn', { onclick: () => { S.mediaSel = null; render(); } }, '重置选区')
    ]));
    const note = div('media-note', null, '');
    note.setAttribute('data-media-note', '1');
    card.appendChild(note);
    card.appendChild(div('media-actions', null, [
      el('button', 'up-btn ghost', { onclick: removeMediaFromViewer }, '删除'),
      el('button', 'up-btn ghost', { onclick: closeMediaView }, '取消'),
      el('button', 'up-btn primary', { onclick: applyMediaEdit }, S.mediaBusy ? '处理中…' : '应用')
    ]));
    overlay.appendChild(card);
    return overlay;
  }
  /* 位置更新单独抽出来：拖动时每帧都要跑，不能连带重画整张画布 */
  function paintMediaSel() {
    const stage = appEl.querySelector('[data-media-stage]');
    const selEl = appEl.querySelector('[data-media-sel]');
    if (!stage || !selEl) return;
    const g = mediaPaint;
    if (!g) { selEl.style.display = 'none'; return; }
    const s = S.mediaSel;
    const dims = {};
    appEl.querySelectorAll('[data-media-dim]').forEach(d => { dims[d.getAttribute('data-media-dim')] = d; });
    const hideAll = () => { Object.keys(dims).forEach(k => { dims[k].style.display = 'none'; }); };
    if (!s) { selEl.style.display = 'none'; hideAll(); return; }
    const x = g.x + s.x * g.w, y = g.y + s.y * g.h, w = Math.max(10, s.w * g.w), h = Math.max(10, s.h * g.h);
    selEl.style.display = '';
    selEl.style.left = x + 'px'; selEl.style.top = y + 'px';
    selEl.style.width = w + 'px'; selEl.style.height = h + 'px';
    const place = (k, px, py, pw, ph) => {
      const d = dims[k]; if (!d) return;
      d.style.display = pw > 0 && ph > 0 ? '' : 'none';
      d.style.left = px + 'px'; d.style.top = py + 'px'; d.style.width = Math.max(0, pw) + 'px'; d.style.height = Math.max(0, ph) + 'px';
    };
    place('t', g.x, g.y, g.w, y - g.y);
    place('b', g.x, y + h, g.w, g.y + g.h - (y + h));
    place('l', g.x, y, x - g.x, h);
    place('r', x + w, y, g.x + g.w - (x + w), h);
  }
  function paintMediaNote() {
    const n = appEl.querySelector('[data-media-note]');
    if (!n) return;
    const s = S.mediaSel;
    if (!s || !mediaPaint || !mediaPaint.iw) { n.textContent = S.mediaRot ? ('当前旋转 ' + S.mediaRot + '°') : ''; return; }
    const g = mediaPaint;
    const rotW = Math.round(g.iw * Math.abs(Math.cos(S.mediaRot * Math.PI / 180)) + g.ih * Math.abs(Math.sin(S.mediaRot * Math.PI / 180)));
    const rotH = Math.round(g.iw * Math.abs(Math.sin(S.mediaRot * Math.PI / 180)) + g.ih * Math.abs(Math.cos(S.mediaRot * Math.PI / 180)));
    n.textContent = '裁剪后约 ' + Math.max(1, Math.round(s.w * rotW)) + ' × ' + Math.max(1, Math.round(s.h * rotH))
      + ' 像素' + (S.mediaRot ? '，旋转 ' + S.mediaRot + '°' : '');
  }
  /* 旋转后的包围盒（图内像素）。
   * 为什么要单独抽出来：0/90/180/270 这些整数角的 cos/sin 带浮点残渣
   * （cos 90° = 6.1e-17），`120*残渣 + 60*1` 会算成 60.000000000000007，
   * 再 Math.ceil 就抬成 61 —— 屏幕上框的方框和裁出来的图会差 1 像素。
   * 先按 1e-6 归整再取整，并且**预览和落盘共用这一个函数**，两边就不会再各算各的。 */
  function rotatedBox(iw, ih, rot) {
    const rad = (Number(rot) || 0) * Math.PI / 180;
    const r6 = v => Math.round(v * 1e6) / 1e6;
    const ca = r6(Math.abs(Math.cos(rad))), sa = r6(Math.abs(Math.sin(rad)));
    return {
      ca: ca, sa: sa,
      bw: Math.max(1, Math.ceil(r6(iw * ca + ih * sa))),
      bh: Math.max(1, Math.ceil(r6(iw * sa + ih * ca)))
    };
  }
  function paintMediaViewer() {
    if (!S.mediaView) { mediaPaint = null; return; }
    const stage = appEl.querySelector('[data-media-stage]');
    const cv = appEl.querySelector('[data-media-canvas]');
    if (!stage || !cv) { mediaPaint = null; return; }
    const found = findMediaAcrossDoc(S.mediaView.mediaId);
    if (!found) { mediaPaint = null; return; }
    const item = found.item;
    const im = cachedImage(item.src);
    if (!im) { loadImage(item.src).then(() => { if (S.mediaView) render(); }, () => { }); }
    const sw = stage.clientWidth || 640, sh = stage.clientHeight || 320;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(2, window.devicePixelRatio) : 1;
    cv.width = Math.max(2, Math.round(sw * dpr));
    cv.height = Math.max(2, Math.round(sh * dpr));
    cv.style.width = sw + 'px'; cv.style.height = sh + 'px';
    let ctx = null;
    try { ctx = cv.getContext('2d'); } catch (e) { ctx = null; }
    if (ctx) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, sw, sh); }
    const iw = im ? (im.naturalWidth || im.width || 1) : Math.max(1, item.w || 1);
    const ih = im ? (im.naturalHeight || im.height || 1) : Math.max(1, item.h || 1);
    const rad = S.mediaRot * Math.PI / 180;
    const box = rotatedBox(iw, ih, S.mediaRot);
    const bw = box.bw, bh = box.bh;
    const pad = 16;
    const scale = Math.min((sw - pad * 2) / bw, (sh - pad * 2) / bh) || 1;
    const dw = bw * scale, dh = bh * scale;
    const dx = (sw - dw) / 2, dy = (sh - dh) / 2;
    mediaPaint = { x: dx, y: dy, w: dw, h: dh, iw: iw, ih: ih };
    if (ctx && im) {
      ctx.save();
      ctx.translate(dx + dw / 2, dy + dh / 2);
      ctx.rotate(rad);
      try { ctx.imageSmoothingQuality = 'high'; } catch (_) { }
      ctx.drawImage(im, -iw * scale / 2, -ih * scale / 2, iw * scale, ih * scale);
      ctx.restore();
    }
    paintMediaSel();
    paintMediaNote();
  }
  async function applyMediaEdit() {
    const mv = S.mediaView; if (!mv || S.mediaBusy) return;
    const found = findMediaAcrossDoc(mv.mediaId);
    if (!found) { closeMediaView(); return; }
    const changed = (S.mediaRot % 360 !== 0) || !!S.mediaSel;
    if (!changed) { closeMediaView(); return; }
    S.mediaBusy = true; render();
    try {
      const im = await loadImage(found.item.src);
      const iw = im.naturalWidth || im.width || 1, ih = im.naturalHeight || im.height || 1;
      const rad = S.mediaRot * Math.PI / 180;
      const box = rotatedBox(iw, ih, S.mediaRot);
      const bw = box.bw, bh = box.bh;
      const rc = document.createElement('canvas');
      rc.width = bw; rc.height = bh;
      const rctx = rc.getContext('2d');
      rctx.fillStyle = '#FFFFFF'; rctx.fillRect(0, 0, bw, bh);   // 旋转后露白处补白底，不要透明
      rctx.translate(bw / 2, bh / 2); rctx.rotate(rad);
      try { rctx.imageSmoothingQuality = 'high'; } catch (_) { }
      rctx.drawImage(im, -iw / 2, -ih / 2, iw, ih);
      let out = rc;
      if (S.mediaSel) {
        const sx = Math.max(0, Math.round(S.mediaSel.x * bw)), sy = Math.max(0, Math.round(S.mediaSel.y * bh));
        const cw = Math.min(bw - sx, Math.max(4, Math.round(S.mediaSel.w * bw)));
        const ch = Math.min(bh - sy, Math.max(4, Math.round(S.mediaSel.h * bh)));
        const cc = document.createElement('canvas');
        cc.width = cw; cc.height = ch;
        cc.getContext('2d').drawImage(rc, sx, sy, cw, ch, 0, 0, cw, ch);
        out = cc;
      }
      const src = out.toDataURL('image/png');
      patchNodeMedia(found.nodeId, mv.mediaId, { src: src, w: out.width, h: out.height });
      const kind = found.item.kind;
      S.mediaBusy = false; S.mediaView = null; S.mediaSel = null; S.mediaRot = 0; mediaPaint = null;
      render();
      showNotice(kind === 'formula' ? '公式已更新' : '图片已更新');
    } catch (e) {
      S.mediaBusy = false; render();
      showNotice('处理失败：' + (e && e.message ? e.message : e));
    }
  }

  /* ---------- 公式编辑器（结构 / 符号 / 常用，样式参考 Word 的公式工具） ---------- */
  const MATH_GREEK_ITEMS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi', 'rho',
    'sigma', 'tau', 'phi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Pi', 'Sigma', 'Phi', 'Psi', 'Omega'];
  const MATH_OP_ITEMS = ['times', 'div', 'pm', 'mp', 'cdot', 'ast', 'circ', 'oplus', 'otimes', 'sum', 'prod', 'int', 'oint', 'infty', 'partial', 'nabla', 'sqrt', 'forall', 'exists', 'neg'];
  const MATH_REL_ITEMS = ['le', 'ge', 'ne', 'approx', 'equiv', 'sim', 'propto', 'll', 'gg', 'in', 'notin', 'subset', 'subseteq', 'supset', 'cup', 'cap', 'emptyset', 'angle', 'perp', 'parallel'];
  const MATH_ARROW_ITEMS = ['to', 'leftarrow', 'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'mapsto', 'uparrow', 'downarrow', 'implies', 'iff'];
  const MATH_OTHER_ITEMS = ['ldots', 'cdots', 'vdots', 'ddots', 'therefore', 'because', 'degree', 'prime', 'aleph', 'hbar', 'ell', 'lbrace', 'rbrace', 'langle', 'rangle', 'lvert', 'lfloor', 'rfloor', 'lceil', 'rceil'];
  const MATH_PALETTE = [
    {
      tab: '结构', groups: [
        { name: '分数', items: [['a/b', '\\frac{}{}'], ['a⁄b（斜）', '{}/{}']] },
        { name: '上下标', items: [['x²', '^{}'], ['x₂', '_{}'], ['x²₂', '^{}_{}'], ['ⁿxᵐ', '{}^{}_{}']] },
        { name: '根号', items: [['√', '\\sqrt{}'], ['ⁿ√', '\\sqrt[]{}']] },
        { name: '大型运算符', items: [['∑', '\\sum_{}^{}'], ['∏', '\\prod_{}^{}'], ['∫', '\\int_{}^{}'], ['∮', '\\oint_{}^{}'], ['⋃', '\\bigcup_{}^{}'], ['⋂', '\\bigcap_{}^{}']] },
        { name: '括号', items: [['( )', '\\left( \\right)'], ['[ ]', '\\left[ \\right]'], ['{ }', '\\left\\{ \\right\\}'], ['| |', '\\left| \\right|'], ['⟨ ⟩', '\\left\\langle \\right\\rangle'], ['⌊ ⌋', '\\left\\lfloor \\right\\rfloor']] },
        { name: '函数与极限', items: [['lim', '\\lim_{}'], ['max', '\\max_{}'], ['sin', '\\sin '], ['cos', '\\cos '], ['tan', '\\tan '], ['log', '\\log '], ['ln', '\\ln ']] }
      ]
    },
    {
      tab: '符号', groups: [
        { name: '希腊字母', items: MATH_GREEK_ITEMS.map(n => [MATH_SYM[n], '\\' + n + ' ']) },
        { name: '运算符', items: MATH_OP_ITEMS.map(n => [MATH_SYM[n], '\\' + n + ' ']) },
        { name: '关系符', items: MATH_REL_ITEMS.map(n => [MATH_SYM[n], '\\' + n + ' ']) },
        { name: '箭头', items: MATH_ARROW_ITEMS.map(n => [MATH_SYM[n], '\\' + n + ' ']) },
        { name: '其他', items: MATH_OTHER_ITEMS.map(n => [MATH_SYM[n] === '\\' ? '\\' : MATH_SYM[n], '\\' + n + ' ']) }
      ]
    },
    {
      tab: '常用', groups: [
        {
          name: '常用公式（点一下直接填进去）', items: [
            ['一元二次求根', 'x=\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}'],
            ['求和公式', '\\sum_{i=1}^{n}i=\\frac{n(n+1)}{2}'],
            ['重要极限', '\\lim_{x\\to 0}\\frac{\\sin x}{x}=1'],
            ['质能方程', 'E=mc^{2}'],
            ['勾股定理', 'a^{2}+b^{2}=c^{2}'],
            ['欧拉公式', 'e^{i\\pi}+1=0'],
            ['牛顿-莱布尼茨', '\\int_{a}^{b}f(x)dx=F(b)-F(a)'],
            ['二项式', '(a+b)^{n}=\\sum_{k=0}^{n}\\frac{n!}{k!(n-k)!}a^{n-k}b^{k}'],
            ['泰勒展开', 'f(x)=\\sum_{n=0}^{\\infty}\\frac{f^{(n)}(a)}{n!}(x-a)^{n}'],
            ['正态分布', 'f(x)=\\frac{1}{\\sigma\\sqrt{2\\pi}}e^{-\\frac{(x-\\mu)^{2}}{2\\sigma^{2}}}']
          ]
        }
      ]
    }
  ];
  function openFormula(nodeId, mediaId) {
    const nid = nodeId || activeNodeId();
    if (!nid) { showNotice('请先点选一行内容，公式会插到那一行'); return; }
    S.formulaTargetNode = nid;
    S.formulaEditId = mediaId || '';
    S.formulaSrc = '';
    if (mediaId) {
      const f = findMediaAcrossDoc(mediaId);
      if (f && f.item.source) S.formulaSrc = f.item.source;
    }
    S.formulaTab = '结构';
    S.showFormula = true;
    render();
  }
  function closeFormula() { S.showFormula = false; S.formulaEditId = ''; S.formulaSrc = ''; render(); }
  function formulaInsert(tpl) {
    const t = appEl.querySelector('[data-formula-input]');
    const cur = S.formulaSrc || '';
    const start = t && typeof t.selectionStart === 'number' ? t.selectionStart : cur.length;
    const end = t && typeof t.selectionEnd === 'number' ? t.selectionEnd : cur.length;
    const next = cur.slice(0, start) + tpl + cur.slice(end);
    S.formulaSrc = next;
    if (t) t.value = next;
    /* 光标落到第一个 {} 里 —— 这是「点一下就能接着写」的关键，不然用户还得自己找位置 */
    let caret = start + tpl.length;
    const hole = tpl.indexOf('{}');
    if (hole >= 0) caret = start + hole + 1;
    if (t) {
      try { t.focus(); t.setSelectionRange(caret, caret); } catch (e) { }
    }
    paintFormulaPreview();
  }
  function FormulaSheet() {
    const overlay = div('overlay dark centered media-top');
    const card = div('formula-card');
    card.appendChild(div('media-head', null, [
      div(null, null, [
        div('media-title', null, S.formulaEditId ? '编辑公式' : '插入公式'),
        div('media-sub', null, '点下面的结构/符号会插到光标处，{} 是占位——填进去就是了')
      ]),
      div('sheet-close', { onclick: closeFormula }, '×')
    ]));
    const tabs = div('fx-tabs');
    MATH_PALETTE.forEach(p => {
      tabs.appendChild(div('fx-tab' + (S.formulaTab === p.tab ? ' on' : ''), {
        onclick: () => { S.formulaTab = p.tab; render(); }
      }, p.tab));
    });
    card.appendChild(tabs);
    const pal = div('fx-palette');
    (MATH_PALETTE.find(p => p.tab === S.formulaTab) || MATH_PALETTE[0]).groups.forEach(g => {
      pal.appendChild(div('fx-group-name', null, g.name));
      const grid = div('fx-grid');
      g.items.forEach(([label, tpl]) => {
        grid.appendChild(div('fx-item', { title: tpl, onclick: () => formulaInsert(tpl) }, label));
      });
      pal.appendChild(grid);
    });
    card.appendChild(pal);
    const pbox = div('fx-preview');
    pbox.setAttribute('data-formula-preview', '1');
    card.appendChild(pbox);
    const ta = el('textarea', 'fx-input', {
      placeholder: '例如：\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}',
      spellcheck: 'false', autocomplete: 'off', rows: '2'
    });
    ta.setAttribute('data-formula-input', '1');
    ta.value = S.formulaSrc || '';
    /* 非受控输入 + 只局部重画预览：整页重渲染会把光标顶掉（同坑 7/8 的道理） */
    ta.addEventListener('input', () => { S.formulaSrc = ta.value; paintFormulaPreview(); });
    card.appendChild(ta);
    card.appendChild(div('fx-hint', null, '可用：\\frac{}{} 分数 · \\sqrt{} 根号 · \\sqrt[n]{} · ^{} 上标 · _{} 下标 · \\sum_{}^{} 大运算符 · \\left( \\right) 括号 · \\alpha 等希腊字母'));
    card.appendChild(div('media-actions', null, [
      el('button', 'up-btn ghost', { onclick: closeFormula }, '取消'),
      el('button', 'up-btn primary', { onclick: commitFormula }, S.formulaEditId ? '保存' : '插入')
    ]));
    overlay.appendChild(card);
    return overlay;
  }
  function paintFormulaPreview() {
    const box = appEl.querySelector('[data-formula-preview]');
    if (!box) return;
    box.innerHTML = '';
    const src = (S.formulaSrc || '').trim();
    if (!src) {
      box.appendChild(div('fp-empty', null, '这里实时预览。左边点个结构，或直接写线性公式。'));
      return;
    }
    const FS = 26, cv = document.createElement('canvas');
    box.appendChild(cv);
    const m = mathBuild(src, FS);
    const avail = (box.clientWidth || 480) - 24;
    const k = m.w > avail && m.w > 0 ? avail / m.w : 1;
    cv.style.width = Math.max(8, Math.round(m.w * k)) + 'px';
    cv.style.height = Math.max(8, Math.round(m.h * k)) + 'px';
    mathPaint(cv, src, FS, INK);
  }
  function commitFormula() {
    const src = (S.formulaSrc || '').trim();
    if (!src) { showNotice('公式还是空的，先写点东西'); return; }
    let png = null;
    try { png = formulaPNG(src, 24); } catch (e) { png = null; }
    if (!png || !png.src) { showNotice('这条公式排不出来，检查一下括号有没有配对'); return; }
    const nid = S.formulaTargetNode || activeNodeId();
    if (!nid) { showNotice('找不到要插入的那一行，请重新点选'); return; }
    if (S.formulaEditId) patchNodeMedia(nid, S.formulaEditId, { src: png.src, w: png.w, h: png.h, source: src });
    else addNodeMedia(nid, { kind: 'formula', src: png.src, w: png.w, h: png.h, source: src });
    const wasEdit = !!S.formulaEditId;
    S.showFormula = false; S.formulaEditId = '';
    render();
    showNotice(wasEdit ? '公式已保存' : '公式已插入到选中的那一行');
  }

  /* ===================================================================================
   * 思维导图里的内容编辑与主题增删（2026-09-22 新增）
   * -----------------------------------------------------------------------------------
   * 关键点：导图里的“主题”与文档大纲里的“行”**本来就是同一份 nodes** ——
   * 这里所有操作都走 commitNodes / patchNode / deleteRow，所以两边天然互通，
   * 不存在“改了一边另一边不同步”的可能。选中的主题只多一个 S.mapNodeId。
   * =================================================================================== */
  function mapPick(id) {
    S.mapNodeId = id;
    S.selectedNodeId = id; S.editNodeId = id;
    S.mapEditing = false;
    render();
  }
  /* 把「当前操作对象」明确指到导图里选中的那个主题上，再执行 fn。
   * 为什么不直接用文档页那套 `editingNode()`：它在「没选中」时会**回落到第一行**
   * （`activeNodeId()` 的最后一句），于是在导图里误点一个灰按钮就会默默改到第一行上去。
   * 这里宁可什么都不做并给一句提示。 */
  function forMapPick(fn) {
    const id = S.mapNodeId;
    if (!id || findNode(id) === undefined) { showNotice('请先在导图上点选一个主题'); return; }
    S.editNodeId = id; S.selectedNodeId = id;
    fn();
  }
  /* 导图上那个主题挂了公式就打开它继续编辑，没挂就新建一条 */
  function mapFormula() {
    const id = S.mapNodeId;
    const node = findNode(id);
    if (node === undefined) return;
    const f = nodeMedia(node).find(m => m.kind === 'formula');
    openFormula(id, f ? f.id : '');
  }
  function mapEditBar() {
    const id = S.mapNodeId;
    const node = id ? findNode(id) : undefined;
    const on = node !== undefined;
    const bar = div('map-editbar');
    bar.appendChild(div('map-picked', null, on
      ? ('已选中：' + (node.text.trim() ? flatText(node.text).slice(0, 16) : '（空主题）') + ' · 标题' + node.level)
      : '点一下导图里的框来选中主题，再用右边这些按钮改它'));
    const sp = div(null, { style: { flex: '1' } });
    bar.appendChild(sp);
    const mk = (icon, label, fn) => div('map-tool' + (on ? '' : ' off'), on ? { onclick: fn } : {}, [div('ic', null, icon), div('lb', null, label)]);
    /* ★ 这一排与文档编辑页的功能栏是**同一套能力**（需求：导图的编辑工具栏要和文档内容一样，
     * 能改颜色、编辑公式等）。每一项都作用在选中的那个主题上 ——
     * 因为导图的“主题”和大纲的“行”本来就是同一份 `nodes`，
     * 所以这里改完切回「编辑」页看到的就是改过的样子，不存在两边不同步。 */
    bar.appendChild(mk('✎', '改文字', startMapEdit));
    /* 换行：改文字框开着就在框里的光标处插一行；没开就给选中的主题末尾补一行并进入改文字 */
    bar.appendChild(mk('↵', '换行', () => insertLineBreak()));
    bar.appendChild(mk('B', '加粗', () => forMapPick(() => toggleBold())));
    bar.appendChild(mk('U', '下划线', () => forMapPick(() => toggleUnderline())));
    bar.appendChild(mk('A-', '缩小', () => forMapPick(() => zoomFont(-2))));
    bar.appendChild(mk('A+', '放大', () => forMapPick(() => zoomFont(2))));
    bar.appendChild(div('map-tool' + (on ? '' : ' off'), on ? {
      onclick: () => forMapPick(() => { S.showColorPanel = !S.showColorPanel; render(); })
    } : {}, [div('color-dot', { style: { background: on ? nodeColor(node) : '#B9C4BE' } }), div('lb', null, '颜色')]));
    bar.appendChild(mk('∑', '公式', mapFormula));
    bar.appendChild(mk('▣', '图片', () => forMapPick(() => pickImage(S.mapNodeId))));
    bar.appendChild(div('map-sep'));
    bar.appendChild(mk('＋', '同级', mapAddSibling));
    bar.appendChild(mk('↳', '子主题', mapAddChild));
    bar.appendChild(mk('←', '升级', () => mapLevel(-1)));
    bar.appendChild(mk('→', '降级', () => mapLevel(1)));
    bar.appendChild(div('map-tool danger' + (on ? '' : ' off'), on ? { onclick: mapDelete } : {}, [div('ic', null, '✕'), div('lb', null, '删除主题')]));
    return bar;
  }
  function mapAddSibling() {
    const id = S.mapNodeId; if (!id) return;
    const nodes = selectedDocument().nodes, index = nodes.findIndex(n => n.id === id);
    if (index < 0) return;
    const baseLevel = nodes[index].level;
    const fresh = { id: nextId(), text: '新主题', level: baseLevel, children: [] };
    /* 与大纲 insertAfter 同规则：强制插在当前主题紧后面，紧随的子主题挂到新同级名下 */
    commitNodes(nodes.slice(0, index + 1).concat([fresh]).concat(nodes.slice(index + 1)));
    S.mapNodeId = fresh.id; S.selectedNodeId = fresh.id; S.editNodeId = fresh.id;
    S.mapEditing = true; S.mapEditText = fresh.text;
    render();
    showNotice('已在它后面加了一个同级主题');
  }
  function mapAddChild() {
    const id = S.mapNodeId; if (!id) return;
    const nodes = selectedDocument().nodes, index = nodes.findIndex(n => n.id === id);
    if (index < 0) return;
    if (nodes[index].level >= 9) { showNotice('已经是最低级（标题9），不能再加子主题'); return; }
    const fresh = { id: nextId(), text: '新子主题', level: nodes[index].level + 1, children: [] };
    commitNodes(nodes.slice(0, index + 1).concat([fresh]).concat(nodes.slice(index + 1)));
    S.mapNodeId = fresh.id; S.selectedNodeId = fresh.id; S.editNodeId = fresh.id;
    S.mapEditing = true; S.mapEditText = fresh.text;
    render();
    showNotice('已加了 1 个子主题（标题' + fresh.level + '）');
  }
  function mapLevel(dir) {
    const id = S.mapNodeId; if (!id) return;
    const node = findNode(id); if (node === undefined) return;
    if (dir < 0 && node.level <= 1) { showNotice('已经是最高级（标题1），不能再升级'); return; }
    if (dir > 0 && node.level >= MAX_LEVEL) { showNotice('已经是最低级（标题9），不能再降级'); return; }
    /* 与大纲同一套校验与级联（2026-09-25）：导图里降级也会带着整棵子树走，
       撞上「上级 N 级本级最深 N+1」或标题9上限时整体不动并提示。 */
    applyLevelShift([id], dir, { focus: false });
  }
  function mapDelete() {
    const id = S.mapNodeId; if (!id) return;
    const nodes = selectedDocument().nodes, index = nodes.findIndex(n => n.id === id);
    if (index < 0) return;
    const node = nodes[index];
    let end = index + 1;
    while (end < nodes.length && nodes[end].level > node.level) end++;
    const kids = end - index - 1;
    const label = node.text.trim() ? '「' + flatText(node.text).slice(0, 14) + '」' : '空主题';
    S.mapNodeId = 0;                 // 选中的主题马上要被删掉，先清掉选中态，免得 render 时高亮一个不存在的 id
    const r = deleteRow(id);         // deleteRow 自己会 render()：子主题归到前一个母主题（没有就上提一级）
    showNotice(deletedRowNotice(label, r || { kids, mode: '' }));
  }
  function startMapEdit() {
    const node = findNode(S.mapNodeId);
    if (node === undefined) return;
    S.mapEditing = true; S.mapEditText = node.text;
    mapSelSnapshot = null;
    render();
    const t = appEl.querySelector('[data-map-edit]');
    if (t) { try { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } catch (e) { } }
  }
  function commitMapEdit(save) {
    const t = appEl.querySelector('[data-map-edit]');
    const id = S.mapNodeId;
    const val = save ? (t ? t.value : S.mapEditText) : null;
    S.mapEditing = false; mapSelSnapshot = null;
    if (save && id) {
      /* 文字改了就要**同步平移行内样式区间**（和 updateNodeText 一个道理）：
         不改的话 runs 的 [s,e) 还指着旧文本的位置，加粗会跑到别的字上。 */
      patchNode(id, n => {
        const oldT = String(n.text || '');
        const next = String(val === undefined || val === null ? '' : val);
        if (next === oldT) return;
        if (nodeRuns(n).length) n.runs = shiftRuns(oldT, next, n.runs);
        n.text = next;
        /* 与大纲行同一个 Word 逻辑：无选区时设的「待输入样式」只打在新写的那一段上 */
        const cs = (S.caretStyle && S.caretStyleId === id) ? S.caretStyle : null;
        if (cs) {
          const d = insertRange(oldT, next);
          if (d.e > d.s) applyRunPatch(n, d.s, d.e, { abs: true, b: cs.b, u: cs.u, c: cs.c, fz: cs.fz });
        }
      });
    }
    render();
    if (save) showNotice('主题文字已更新（文档里那一行同步变了）');
  }
  function MapEditPanel() {
    const panel = div('map-editpanel');
    const ta = el('textarea', 'map-edit-input', { placeholder: '主题内容（回车换行）', spellcheck: 'false', autocomplete: 'off', rows: '2' });
    ta.setAttribute('data-map-edit', '1');
    ta.value = S.mapEditText || '';
    /* 打字就实时落到 S.mapEditText —— 否则点「颜色」等会重渲染的动作时，
       输入框被 `ta.value = S.mapEditText`（旧值）还原，用户**刚敲的字会当场消失**。
       注意：这里只更新草稿，落盘仍在「确定 / Ctrl+回车」（commitMapEdit(true)）。 */
    ta.addEventListener('input', () => { S.mapEditText = ta.value; mapSelSnapshot = null; });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitMapEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commitMapEdit(false); }
    });
    panel.appendChild(ta);
    panel.appendChild(el('button', 'up-btn ghost', { onclick: () => commitMapEdit(false) }, '取消'));
    panel.appendChild(el('button', 'up-btn primary', { onclick: () => commitMapEdit(true) }, '确定'));
    return panel;
  }

  /* ============================== 渲染入口 ============================== */
  function render() {
    // 记住视口：升降级 / 删除 / 加粗这类操作必须重渲染，但不能把用户弹回顶部
    const prevEd = appEl.querySelector('.editor-scroll');
    const prevMap = appEl.querySelector('.map-scroll');
    const keepEd = prevEd ? prevEd.scrollTop : 0;
    const keepMapL = prevMap ? prevMap.scrollLeft : 0, keepMapT = prevMap ? prevMap.scrollTop : 0;
    appEl.innerHTML = '';
    let screen;
    if (S.showEditor) screen = ContentEditor();
    else {
      const main = div('main');
      if (S.tab === '首页') main.appendChild(HomePage());
      else if (S.tab === '社区') main.appendChild(CommunityPage());
      else main.appendChild(ProfilePage());
      screen = div('app-shell');
      screen.appendChild(Sidebar());
      screen.appendChild(main);
    }
    appEl.appendChild(screen);
    if (S.showTemplateSheet) appEl.appendChild(TemplateSheet());    /* 导出 PDF 超页的确认弹窗盖在模板浮层之上 —— 它问的是「这一步要不要继续」，不能被挡住 */
    if (S.exportConfirm) appEl.appendChild(PdfOverflowDialog());
    /* 操作日志 / 回收站浮层：普通底部面板，排在业务浮层之后、查看器之前 */
    if (S.showOpLog) appEl.appendChild(opLogSheet());
    if (S.recycleSheet) appEl.appendChild(recycleSheet());
    /* 图片/公式查看器与公式编辑器排在最后 —— 它们要盖住上面所有浮层 */
    if (S.mediaView) appEl.appendChild(MediaViewer());
    if (S.showFormula) appEl.appendChild(FormulaSheet());
    syncRowHeights();
    applyMapZoom();
    /* 这两件事都要等节点真的进了 DOM 才能量尺寸 / 画布（同 applyMapZoom 的道理） */
    paintMediaViewer();
    paintFormulaPreview();
    const targetId = pendingFocus ? pendingFocus.id : 0;
    applyPendingFocus();
    /* 视口还原：先把原来的 scrollTop 原样还回去，再让「光标所在那一行」按需滚进视野。
       两件事的顺序不能反 —— focus() 自己会滚动，还回去必须在它之后。
       注意别用「光标是否换了行」来决定要不要还原（2026-09-20 真浏览器实测踩过）：
       删除后焦点交给上一行、升/降级后焦点还在原行，这两种情况光标只挪一行，
       若按「换了行就跳过还原」处理，用户会被直接弹回文档顶部（scrollTop 300 → 0）。
       真正需要补救的只有「光标跳到了视野外」（比如在长文档末尾新增一条），
       那种情况交给 scrollIntoView({block:'nearest'})：不可见时只滚最小距离，可见时不动。 */
    const nextEd = appEl.querySelector('.editor-scroll');
    if (nextEd && keepEd > 0) nextEd.scrollTop = keepEd;
    if (nextEd && targetId) {
      const t = nextEd.querySelector('.row-input[data-id="' + targetId + '"]');
      if (t) t.scrollIntoView({ block: 'nearest' });
    }
    const nextMap = appEl.querySelector('.map-scroll');
    if (nextMap && (keepMapL > 0 || keepMapT > 0)) { nextMap.scrollLeft = keepMapL; nextMap.scrollTop = keepMapT; }
    if (S.toast) { toastEl = null; mountToast(); }
    else toastEl = null;
  }
  function applyPendingFocus() {
    if (pendingFocus) {
      const inp = appEl.querySelector('.row-input[data-id="' + pendingFocus.id + '"]');
      if (inp) {
        try { inp.focus(); } catch (e) { }
        const c = pendingFocus.caret === 'end' ? readEditable(inp).length : pendingFocus.caret;
        setSelOfEditable(inp, c, pendingFocus.selEnd !== undefined ? pendingFocus.selEnd : c);
      }
      pendingFocus = null;
    }
    /* 导图「改文字」框里的选区还原（行内样式作用于选区后，用户应能接着改同一段） */
    if (pendingMapSel) {
      const mt = appEl.querySelector('textarea[data-map-edit]');
      const ps = pendingMapSel; pendingMapSel = null;
      if (mt) { try { mt.focus(); mt.setSelectionRange(ps.s, ps.e); } catch (e) { } }
    }
  }

  /* ============================== 导出：Canvas 渲染 ============================== */
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }
  function drawBrandMark(ctx, x, y, R) {
    const s = 18 * R;
    ctx.fillStyle = MOSS; rr(ctx, x, y, s, s, 5 * R); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold ' + (11 * R) + 'px ' + FONT;
    ctx.fillText('理', x + s / 2, y + s / 2 + R);
    ctx.fillStyle = MOSS; ctx.textAlign = 'left'; ctx.font = 'bold ' + (12 * R) + 'px ' + FONT;
    ctx.fillText('理记', x + s + 6 * R, y + s / 2 + R);
  }
  function renderMapCanvas(scale) {
    const layout = currentLayout();
    const c = document.createElement('canvas');
    c.width = Math.round(layout.width * scale); c.height = Math.round(layout.height * scale);
    const ctx = c.getContext('2d'); ctx.scale(scale, scale);
    ctx.fillStyle = '#F3F7F2'; ctx.fillRect(0, 0, layout.width, layout.height);
    layout.segs.forEach(seg => {
      ctx.save(); ctx.translate(seg.x + seg.w / 2, seg.y + seg.h / 2); ctx.rotate(seg.angle * Math.PI / 180);
      ctx.fillStyle = seg.color; ctx.fillRect(-seg.w / 2, -seg.h / 2, seg.w, seg.h); ctx.restore();
    });
    layout.boxes.forEach(b => {
      ctx.fillStyle = b.bg; rr(ctx, b.x, b.y, b.w, b.h, b.radius); ctx.fill();
      if (b.borderW > 0) { ctx.lineWidth = b.borderW; ctx.strokeStyle = b.border; ctx.stroke(); }
      const lines = (b.lines && b.lines.length) ? b.lines : [b.text];
      const lh = b.font * MAP_LH;
      const cx = b.x + b.w / 2;
      const mediaH = (b.mediaBox && b.media) ? b.mediaBox.h + 6 : 0;
      const hay = lines.length * lh + mediaH + (b.sub ? b.subFont + 4 : 0);
      let ty = b.y + (b.h - hay) / 2;
      if (b.mediaBox && b.media) {
        const mim = cachedImage(b.media.src);
        const mx = b.x + (b.w - b.mediaBox.w) / 2;
        if (mim) ctx.drawImage(mim, mx, ty, b.mediaBox.w, b.mediaBox.h);
        else { ctx.strokeStyle = '#D6DED8'; ctx.lineWidth = 1; ctx.strokeRect(mx + 0.5, ty + 0.5, b.mediaBox.w - 1, b.mediaBox.h - 1); }
        ty += mediaH;
      }
      ty += lh / 2;
      ctx.fillStyle = b.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = (b.bold ? 'bold ' : '') + b.font + 'px ' + FONT;
      lines.forEach(line => { ctx.fillText(line, cx, ty); ty += lh; });
      if (b.sub) { ctx.fillStyle = b.subFg; ctx.font = b.subFont + 'px ' + FONT; ctx.fillText(b.sub, cx, ty + b.subFont * 0.35); }
    });
    return c;
  }
  function renderDocCanvas() {
    const W = (PDF_PAGE_W - PDF_MARGIN * 2) * 2; // 1030
    const rows = contentRows();
    // ---- 第一遍：只算高度（先不绘制，避免设置 canvas.height 时清空画面） ----
    let y = 50 + 56 + 36 + 20;
    const geom = rows.map(row => {
      const fs = Math.round(levelFont(row.level) * 1.4);
      const indent = 8 + Math.max(0, row.level - 1) * 16;   /* 与编辑页同口径：跟级别，不跟树深 */
      const maxW = W - indent - 40;
      /* 行内 runs：折行按每字的字号/粗细，绘制时逐段落笔（颜色/下划线跟随每段） */
      const runs = nodeRuns(row);
      let lines, lineSpans = null, hFs = fs;
      if (runs.length > 0) {
        const styleAt = off => { const st = effStyle(row, off); return { fs: st.fz, bold: st.b }; };
        const lex = wrapLinesEx(row.text, maxW, fs, row.bold, styleAt);
        lines = lex.map(l => l.t);
        lineSpans = lex.map(l => spansForRange(row, l.s, l.e));
        hFs = Math.max.apply(null, [fs].concat(runs.map(r => r.fz || fs)));
      } else {
        lines = wrapLines(row.text, maxW, fs, row.bold);
      }
      // 用与导图同一套折行逻辑（含行内硬换行），保证导出换行位置与编辑器一致
      const lh = Math.round(hFs * 1.45);
      /* 挂了公式/图片的行：导出里也要有，否则「编辑页看得见、PDF 里没有」。
         不预加载图片就会画成虚线占位框 —— onExport 已经先 await preloadDocImages()。 */
      const media = (row.media || []).slice(0, 1).map(m => ({ item: m, d: mediaFit(m, 340, 260) }));
      const mediaH = media.reduce((s, x) => s + x.d.h + 8, 0);
      const rowH = Math.max(44, lh * lines.length + 14 + mediaH);
      return { level: row.level, fs, indent, rowH, lh, lines, lineSpans, text: row.text, color: row.color, bold: row.bold, media: media, mediaH: mediaH };
    });
    y += geom.reduce((s, g) => s + g.rowH + 10, 0) + 60;
    // ---- 第二遍：真正绘制 ----
    const c = document.createElement('canvas'); c.width = W; c.height = Math.round(y);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, c.height);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.fillStyle = INK; ctx.font = 'bold 30px ' + FONT;
    ctx.fillText(fitText(ctx, S.docTitle, W - 80), 40, 50 + 26);
    ctx.fillStyle = '#9BA39F'; ctx.font = '12px ' + FONT;
    ctx.fillText(rows.length + ' 条大纲 · 由理记导出', 40, 50 + 56 + 36);
    let yy = 50 + 56 + 36 + 20;
    geom.forEach(g => {
      const d = g.level === 1 ? 9 : (g.level === 2 ? 8 : 7);
      ctx.fillStyle = g.level <= 2 ? (g.level === 1 ? '#3F6B4F' : '#93A89A') : '#fff';
      rr(ctx, g.indent, yy + g.rowH / 2 - d / 2, d, d, 3); ctx.fill();
      if (g.level >= 3) { ctx.lineWidth = 1.6; ctx.strokeStyle = '#AEBAB3'; ctx.stroke(); }
      ctx.fillStyle = g.color; ctx.font = (g.bold ? 'bold ' : '') + g.fs + 'px ' + FONT;
      // 多行文本块整体垂直居中，行内换行逐行绘制
      const blockH = g.lh * g.lines.length + g.mediaH;
      const startY = yy + (g.rowH - blockH) / 2;
      g.lines.forEach((line, i) => {
        const x0 = g.indent + 24, y0 = startY + g.lh * i + Math.round(g.fs * 0.8);
        if (!g.lineSpans) { ctx.fillText(line, x0, y0); return; }
        /* 行内 runs：逐段落笔，颜色 / 粗细 / 字号 / 下划线跟每段走 */
        let x = x0;
        g.lineSpans[i].forEach(sp => {
          ctx.fillStyle = sp.c || g.color;
          ctx.font = (sp.b ? 'bold ' : '') + sp.fs + 'px ' + FONT;
          ctx.fillText(sp.t, x, y0);
          if (sp.u) {
            const uw = strW(sp.t, sp.fs, sp.b);
            ctx.fillRect(x, y0 + Math.round(sp.fs * 0.18), uw, Math.max(1, Math.round(sp.fs / 14)));
          }
          x += strW(sp.t, sp.fs, sp.b);
        });
      });
      let my = startY + g.lh * g.lines.length + 4;
      g.media.forEach(mi => {
        const im = cachedImage(mi.item.src);
        if (im) ctx.drawImage(im, g.indent + 24, my, mi.d.w, mi.d.h);
        else { ctx.strokeStyle = '#D6DED8'; ctx.lineWidth = 1; ctx.strokeRect(g.indent + 24.5, my + 0.5, mi.d.w - 1, mi.d.h - 1); }
        my += mi.d.h + 8;
      });
      yy += g.rowH + 10;
    });
    return c;
  }
  function canvasJpeg(canvas, q) {
    const url = canvas.toDataURL('image/jpeg', q);
    const b64 = url.split(',')[1]; const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  /* 分页切点：尽量落在「整行都是背景色」的那一行上，避免把一个主题框从中间切成两半。
     ⚠ 约束：每页高度必须 ≤ contentHpx，否则两页之间会**漏内容** ——
       所以只允许把切点从理想位置（上一刀 + contentHpx）**往前挪**到最近的一行空白，绝不越过它。
       原实现是硬切 k*contentHpx，严格连续；这里保持连续，只是让切口更整齐。 */
  function pdfCutRows(s, contentHpx) {
    const cuts = [0];
    let bg = null;
    try { const d = s.getContext('2d').getImageData(0, 0, 1, 1).data; bg = [d[0], d[1], d[2]]; } catch (e) { bg = null; }
    let y = 0;
    while (y + contentHpx < s.height) {
      const limit = y + contentHpx;
      let pick = limit;
      if (bg) {
        /* 一次取一整条带（最多向上回看 35% 页高），再从后往前找第一条整行空白的像素行 */
        const span = Math.min(Math.round(contentHpx * 0.35), limit - y - 1);
        let band = null;
        try { band = s.getContext('2d').getImageData(0, limit - span, s.width, span + 1).data; } catch (e) { band = null; }
        if (band && band.length >= (span + 1) * s.width * 4) {
          for (let r = span; r >= 1; r--) {
            const base = r * s.width * 4;
            let blank = true;
            for (let i = base; i < base + s.width * 4; i += 4) {
              if (Math.abs(band[i] - bg[0]) > 10 || Math.abs(band[i + 1] - bg[1]) > 10 || Math.abs(band[i + 2] - bg[2]) > 10) { blank = false; break; }
            }
            if (blank) { pick = limit - r; break; }
          }
        }
      }
      if (pick <= y) pick = limit;     // 兜底：任何情况下都不许出现「零高度页」
      cuts.push(pick); y = pick;
    }
    return cuts;
  }
  function sliceToPages(src) {
    const R = 2, pageW = PDF_PAGE_W, pageH = PDF_PAGE_H, margin = PDF_MARGIN, top = PDF_TOP, bottom = PDF_BOTTOM;
    const contentWpx = (pageW - margin * 2) * R, contentHpx = (pageH - top - bottom) * R;
    let s = src;
    if (src.width !== contentWpx) {
      const cc = document.createElement('canvas'); cc.width = contentWpx; cc.height = Math.round(src.height * contentWpx / src.width);
      cc.getContext('2d').drawImage(src, 0, 0, cc.width, cc.height); s = cc;
    }
    const cuts = pdfCutRows(s, contentHpx), images = [];
    for (let k = 0; k < cuts.length; k++) {
      const y0 = cuts[k], hh = Math.min(contentHpx, s.height - y0);
      if (hh <= 0) break;
      const pc = document.createElement('canvas'); pc.width = pageW * R; pc.height = pageH * R;
      const pctx = pc.getContext('2d'); pctx.fillStyle = '#fff'; pctx.fillRect(0, 0, pc.width, pc.height);
      /* 每页都从自己的 cut 出发、画到下一刀为止 —— 段与段首尾相接，既不漏也不重 */
      pctx.drawImage(s, 0, y0, contentWpx, hh, margin * R, top * R, contentWpx, hh);
      drawBrandMark(pctx, pc.width - margin * R - 150, pc.height - bottom * R + 16, R);
      images.push({ data: canvasJpeg(pc, 0.92), w: pc.width, h: pc.height });
    }
    return images;
  }
  /* 超出一页时先问一句的那份 PDF 页面（只在内存里，刷新就没了，不必落盘） */
  let pendingPdf = null;
  function asciiBytes(s) { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 0xFF; return o; }
  function pad10(n) { let s = '' + n; while (s.length < 10) s = '0' + s; return s; }
  function joinBytes(parts) { let t = 0; parts.forEach(p => t += p.length); const o = new Uint8Array(t); let a = 0; parts.forEach(p => { o.set(p, a); a += p.length; }); return o; }
  function buildPdf(images) {
    const pageW = PDF_PAGE_W, pageH = PDF_PAGE_H, N = images.length;
    const parts = [], offsets = []; let cur = 0;
    const addText = s => { const b = asciiBytes(s); parts.push(b); cur += b.length; };
    const addRaw = b => { parts.push(b); cur += b.length; };
    /* ★ 偏移必须**按对象编号**存（offsets[id]），不能按写入顺序 push：
       xref 表是按编号查的（第 N 条 = 对象 N），而写入顺序是 1,2,图0,流0,页0,图1,流1,页1…
       两者只有在**单页**时才恰好一致 —— 于是「1 页文档正常、≥2 页的 PDF 打不开」
       （阅读器报「无法打开此文件」，靠容错才能勉强打开，实测 2 页就错 4 条、24 页错 70 条）。 */
    const openObj = id => { offsets[id] = cur; addText(id + ' 0 obj\n'); };
    addText('%PDF-1.4\n'); addRaw(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
    openObj(1); addText('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    let kids = ''; for (let k = 0; k < N; k++) kids += (3 + N * 2 + k) + ' 0 R ';
    openObj(2); addText('<< /Type /Pages /Kids [' + kids + '] /Count ' + N + ' >>\nendobj\n');
    for (let k = 0; k < N; k++) {
      const im = images[k], imId = 3 + k, cId = 3 + N + k, pId = 3 + N * 2 + k;
      openObj(imId); addText('<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.data.length + ' >>\nstream\n'); addRaw(im.data); addText('\nendstream\nendobj\n');
      const body = 'q\n' + pageW + ' 0 0 ' + pageH + ' 0 0 cm\n/Im' + k + ' Do\nQ\n';
      openObj(cId); addText('<< /Length ' + body.length + ' >>\nstream\n' + body + 'endstream\nendobj\n');
      openObj(pId); addText('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH + '] /Resources << /XObject << /Im' + k + ' ' + imId + ' 0 R >> >> /Contents ' + cId + ' 0 R >>\nendobj\n');
    }
    const total = 2 + N * 3, xrefAt = cur;
    let xref = 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= total; i++) xref += pad10(offsets[i] || 0) + ' 00000 n \n';
    addText(xref); addText('trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');
    return new Blob([joinBytes(parts)], { type: 'application/pdf' });
  }
  function fileName(suffix) {
    const bad = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let t = S.docTitle; bad.forEach(c => t = t.split(c).join('-'));
    if (!t) t = '未命名文档';
    return '理记-' + t + suffix;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function pdfName(kind) { return kind === 'doc-pdf' ? fileName('.pdf') : fileName('-导图.pdf'); }
  /* ★ 内容比一页纸长时，先把话说清楚再导出（2026-09-24 需求）：
     弹出说明 + 建议改用「导出图片」（长图不会被切断）+ 继续 / 取消两个选择；
     用户点了「继续」才真的按页切分导出（超出部分自动排到下一页，见 sliceToPages）。
     只有一页时不打扰 —— 那时候没有任何需要用户知道的事。 */
  function confirmPdfExport() {
    const p = pendingPdf;
    S.exportConfirm = null; pendingPdf = null;
    S.exporting = false; S.exportingKey = ''; S.showExportPanel = false;
    if (!p) { render(); return; }
    try {
      download(buildPdf(p.images), pdfName(p.kind));
      showNotice('已导出：' + pdfName(p.kind) + '（共 ' + p.images.length + ' 页）');
    } catch (e) { showNotice('导出失败：' + (e && e.message ? e.message : e)); }
    render();
  }
  function cancelPdfExport() {
    pendingPdf = null; S.exportConfirm = null;
    S.exporting = false; S.exportingKey = '';
    showNotice('已取消导出');
    render();
  }
  async function onExport(kind) {
    if (S.exporting) return;
    if (contentRows().length === 0) { showNotice('文档还没有内容，无法导出'); return; }
    S.exporting = true; S.exportingKey = kind; render();
    /* canvas 的 drawImage 是同步的 —— 图没解码完就会画成虚线占位框，
       所以先把文档里所有图片/公式预热一遍再画。 */
    await preloadDocImages();
    await new Promise(r => setTimeout(r, 30));
    try {
      if (kind === 'doc-pdf' || kind === 'map-pdf') {
        const cv = kind === 'doc-pdf' ? renderDocCanvas() : renderMapCanvas(2);
        const imgs = sliceToPages(cv);
        if (imgs.length > 1) {
          pendingPdf = { kind: kind, images: imgs };
          S.exportConfirm = { kind: kind, pages: imgs.length };
          S.exporting = false; S.exportingKey = ''; render();
          return;                       // 等用户在弹窗里选「继续」或「取消」
        }
        download(buildPdf(imgs), pdfName(kind));
        logOp('导出', pdfName(kind) + '（PDF，' + imgs.length + ' 页）');
        showNotice('已导出：' + pdfName(kind));
      } else if (kind === 'doc-md') {
        const name = fileName('.md');
        download(new Blob([serializeNodesToMd(selectedDocument().nodes)], { type: 'text/markdown;charset=utf-8' }), name);
        logOp('导出', name + '（Markdown）');
        showNotice('已导出：' + name);
      } else {
        download(new Blob([canvasPng(renderMapCanvas(2))], { type: 'image/png' }), fileName('-导图.png'));
        showNotice('已导出：' + fileName('-导图.png'));
      }
    } catch (e) {
      pendingPdf = null; S.exportConfirm = null;
      showNotice('导出失败：' + (e && e.message ? e.message : e));
    }
    S.exporting = false; S.exportingKey = ''; S.showExportPanel = false; render();
  }
  function canvasPng(canvas) {
    const url = canvas.toDataURL('image/png'); const b64 = url.split(',')[1]; const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u;
  }

  /* ============================== 启动 ============================== */
  function boot() {
    restoreDocuments();
    loadOssConfig();
    render();
    /* 配好了对象存储就先同步一次：拉回别的设备上的改动，也把本机没传上去的推上去。
       没配也一样能用 —— 文档本来就存本机，同步只是可选项。 */
    ossStartupSync().then(() => startPolling());
  }
  boot();

  // 暴露调试接口（便于自检脚本与人工排错）
  window.__liji = {
    S, render, saveNow, restoreDocuments, currentLayout, openDocument, createDocument,
    nodeSize, wrapLines, mapFont, onExport, setMapZoom, mapFit,
    /* 大纲行的编辑动作（功能栏那些按钮的同一套入口，自检要能直接戳） */
    toggleBold, setLevel, updateNodeText,
    /* 级别规则（2026-09-25）：统一校验 / 级联 / 钳制，以及多选批量 */
    demote, promote, applyLevel, planLevelShift, applyLevelShift,
    parentLevelAt, gapToParent, toggleMultiSel, exitMultiSel, toggleMultiPick, multiPickAll, multiLevel,
    /* 「换行」按钮（2026-09-24：回车改回新增同级之后，换行由它负责） */
    insertLineBreak,
    /* 文档文件夹（2026-09-24）：新建 / 重命名 / 删除 / 文档移动 */
    docFolderId, folderById, folderName, syncFoldersFromDocs,
    startNewFolder, submitFolderName, removeFolder, moveDocTo, createFolderAndMove, toggleFolder,
    /* 自定义模板（2026-09-25）+ 卡片标签的展示名 */
    submitCustomTemplate, tplLabel,
    /* Markdown 导入 / 导出（2026-10-07）+ 首主题一级 / 删除归并（2026-10-08） */
    parseMarkdownToNodes, serializeNodesToMd, importMarkdownFile,
    normalizeFirstLevel, deleteRow, deletedRowNotice,
    deleteDocument, createFolderAndMove,
    /* 行内样式 runs（2026-09-23）：主题内的文字可选中单独设置样式 */
    nodeRuns, effStyle, applyRunPatch, shiftRuns, spansForRange,
    /* 富文本编辑框（contenteditable）的选区读写与「后续输入样式」：自检要能直接戳 */
    styleContext, readEditable, selOfEditable, setSelOfEditable, insertRange, caretStyleFor, toggleUnderline, changeColor, zoomFont,
    /* 对象存储同步（轻享版的云端） */
    syncNow, ossStartupSync, ossPush, ossPull, ossCheckRemote, ossForcePull, ossForcePush,
    saveNowAndPush, scheduleCloudPush, ossPushQuiet, markDocsDirty, isDocsDirty: () => docsDirty,
    ossSaveConfig, ossClearConfig, ossTestConnection, loadOssConfig, saveOssConfig,
    restoreLocalBackup, applyRemote, syncPayload, ossReady,
    mergeLibrary, docHashes, docHash,
    /* 操作日志 / .md 镜像 / 回收站（2026-10-09）：自检要能直接戳 */
    logOp, opLog, opLogUploadKey, syncMirror, mirrorKeyForDoc, docToMarkdown, sanitizePathSeg,
    recycleEnabled, setRecycleEnabled, recycleCheck, recycleOpen, recycleRestore,
    /* 公式与图片 / 导图编辑（2026-09-22） */
    nodeMedia, addNodeMedia, removeNodeMedia, patchNodeMedia, findMediaAcrossDoc,
    openMediaView, closeMediaView, applyMediaEdit, setMediaAspect,
    openFormula, closeFormula, commitFormula, formulaInsert, pickImage,
    mapPick, mapAddSibling, mapAddChild, mapLevel, mapDelete, startMapEdit, commitMapEdit,
    mathParse, mathBuild, formulaPNG, preloadDocImages,
    /* 查看器里那张图当前的绘制几何 {x,y,w,h,iw,ih}（舞台 CSS 坐标）——
       裁剪选区是相对它归一化的，自检要靠它把归一化坐标换算回像素 */
    getMediaPaint: () => mediaPaint,
    APP_VERSION,
    getOssCfg: () => S.ossCfg,
    setOssCfg: (c) => { S.ossCfg = c; },
    /* 导出 PDF 超页确认（2026-09-24）：自检要能真点这两个按钮 */
    confirmPdfExport, cancelPdfExport,
    _build: { renderDocCanvas, renderMapCanvas, buildPdf, sliceToPages, pdfCutRows, canvasJpeg, canvasPng }
  };
})();
