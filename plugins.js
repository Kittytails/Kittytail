/* Direct Link 插件文件：所有插件都写在这里，和 直链.html 放同一目录。
 *
 * 加一个插件 = 在下面追加一段 DL.register({...})。写法：
 *
 *   DL.register({
 *     id: 'my-plugin',            // 唯一，不要改（开关状态按它记）
 *     name: '插件名',             // 显示在「插件」页
 *     desc: '一句话说明',
 *     default: false,             // 第一次是否默认开启
 *
 *     // 上传前：返回新的 File 就替换原文件；不返回或原样返回就不改。可以是 async。
 *     // 想在结果行显示一句提示：out._saveNote = '文字'
 *     async beforeUpload(file, DL) { return file; },
 *
 *     // 上传成功后（不等它跑完）。info: { name, url, size, isImage, deduped, owner, repo, branch, path }
 *     afterUpload(info, DL) { },
 *
 *     // 外观类插件用：页面加载完插件后、以及在「设置」里开关时调用。on = 现在是否开启。
 *     // 需要页面 v1.11 及以上（DL.apiVersion >= 3）。
 *     onToggle(on, DL) { },
 *   });
 *
 * 注意：
 *  - 某个插件运行时出错，只会在控制台警告，不影响上传和其他插件。
 *  - 但整个文件有语法错误（少个括号之类）会导致全部插件失效，改完先在电脑上用 node --check plugins.js 检查。
 *  - 插件能读到 Token，只放自己写的或信得过的代码。
 */

/* ========== 插件 1：去除照片隐私信息 ========== */
(function () {
  'use strict';
  const MAX_SIZE = 40 * 1024 * 1024;       // 超过 40MB 的不处理，避免撑爆内存

  const ascii = (u, o, s) => { for (let i = 0; i < s.length; i++) if (u[o + i] !== s.charCodeAt(i)) return false; return true; };
  const concat = parts => {
    let n = 0; parts.forEach(p => n += p.length);
    const out = new Uint8Array(n); let o = 0;
    parts.forEach(p => { out.set(p, o); o += p.length; });
    return out;
  };

  /* ---------- JPEG ---------- */
  function readOrientation(body) {            // body: APP1 内容，以 "Exif\0\0" 开头
    if (body.length < 20 || !ascii(body, 0, 'Exif')) return 1;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const t = 6, le = body[t] === 0x49 && body[t + 1] === 0x49;
    if (!le && !(body[t] === 0x4D && body[t + 1] === 0x4D)) return 1;
    if (dv.getUint16(t + 2, le) !== 42) return 1;
    const ifd = t + dv.getUint32(t + 4, le);
    if (ifd + 2 > body.length) return 1;
    const n = dv.getUint16(ifd, le);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > body.length) break;
      if (dv.getUint16(e, le) === 0x0112) { const v = dv.getUint16(e + 8, le); return v >= 1 && v <= 8 ? v : 1; }
    }
    return 1;
  }
  function minimalExif(orient) {              // 只含旋转信息的最小 EXIF 段
    return new Uint8Array([
      0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,        // 段头 + "Exif\0\0"
      0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,                    // TIFF 头（大端）
      0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,        // 1 个条目：Orientation, SHORT
      0x00, orient, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00                   // 值 + 没有下一个 IFD
    ]);
  }
  function stripJpeg(u) {
    const out = [u.subarray(0, 2)];
    let p = 2, dropped = false, orient = 1, insertAt = 1;
    while (p + 2 <= u.length) {
      if (u[p] !== 0xFF) return null;                        // 结构异常，放弃处理
      const m = u[p + 1];
      if (m === 0xFF) { p++; continue; }                     // 填充字节
      if (m === 0xDA || m === 0xD9) { out.push(u.subarray(p)); p = u.length; break; }   // 图像数据开始，其余原样
      if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { out.push(u.subarray(p, p + 2)); p += 2; continue; }
      if (p + 4 > u.length) return null;
      const len = (u[p + 2] << 8) | u[p + 3];
      if (len < 2 || p + 2 + len > u.length) return null;
      const seg = u.subarray(p, p + 2 + len), body = u.subarray(p + 4, p + 2 + len);
      let drop = false;
      if (m === 0xE1) { const o = readOrientation(body); if (o > 1) orient = o; drop = true; }   // EXIF / XMP
      else if (m === 0xED || m === 0xFE) drop = true;                                    // Photoshop/IPTC、注释
      else if (m === 0xE2 && ascii(body, 0, 'MPF\0')) drop = true;                       // 多图索引，偏移会失效
      if (drop) dropped = true;
      else { out.push(seg); if (m === 0xE0 && out.length === 2) insertAt = 2; }
      p += 2 + len;
    }
    if (!dropped) return null;
    if (orient > 1) out.splice(insertAt, 0, minimalExif(orient));
    return concat(out);
  }

  /* ---------- PNG ---------- */
  function stripPng(u) {
    const DROP = ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME'];
    const out = [u.subarray(0, 8)];
    let p = 8, dropped = false;
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    while (p + 12 <= u.length) {
      const len = dv.getUint32(p), end = p + 12 + len;
      if (end > u.length) return null;
      const type = String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
      if (DROP.indexOf(type) >= 0) dropped = true; else out.push(u.subarray(p, end));
      p = end;
      if (type === 'IEND') break;
    }
    return dropped ? concat(out) : null;
  }

  /* ---------- WebP ---------- */
  function stripWebp(u) {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const out = [u.slice(0, 12)];
    let p = 12, dropped = false;
    while (p + 8 <= u.length) {
      const id = String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]);
      const size = dv.getUint32(p + 4, true), end = p + 8 + size + (size & 1);
      if (p + 8 + size > u.length) return null;
      const chunk = u.subarray(p, Math.min(end, u.length));
      if (id === 'EXIF' || id === 'XMP ') dropped = true;
      else if (id === 'VP8X' && size >= 1) { const c = chunk.slice(); c[8] &= ~0x0C; if (c[8] !== chunk[8]) dropped = true; out.push(c); }   // 清掉 EXIF / XMP 标志位
      else out.push(chunk);
      p = end;
    }
    if (!dropped) return null;
    const res = concat(out);
    new DataView(res.buffer).setUint32(4, res.length - 8, true);          // 重写 RIFF 总长度
    return res;
  }

  DL.register({
    id: 'strip-exif',
    name: '去除照片隐私信息',
    desc: '上传前删掉 GPS 位置、拍摄时间、相机型号等。JPEG / PNG / WebP 无损处理，不重新压缩，照片方向会保留。',
    default: true,
    async beforeUpload(file) {
      if (!file || file.size < 64 || file.size > MAX_SIZE) return file;
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const jpeg = head[0] === 0xFF && head[1] === 0xD8;
      const png = ascii(head, 1, 'PNG') && head[0] === 0x89;
      const webp = ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP');
      if (!jpeg && !png && !webp) return file;
      const u = new Uint8Array(await file.arrayBuffer());
      const res = jpeg ? stripJpeg(u) : png ? stripPng(u) : stripWebp(u);
      if (!res) return file;                                  // 本来就没有隐私信息，或结构看不懂：保持原样
      const out = new File([res], file.name, { type: file.type, lastModified: file.lastModified });
      out._saveNote = (file._saveNote ? file._saveNote + ' · ' : '') + '已去隐私信息';
      return out;
    }
  });
})();

/* ========== 插件 2：液态玻璃 ========== */
(function () {
  'use strict';
  const STYLE_ID = 'dl-liquid-glass';
  const G = 'html.dl-glass:root';
  const D = 'html.dl-glass:root[data-theme="dark"]';

  // 大块内容面：卡片、分组、结果条
  const SURFACE = ['.card', '.result-item', '.home .group', '.pref-group', '.acct-card', '.acct-group', '.st-group', '.about-box'];
  // 悬浮层：底部搜索栏、多选坞、菜单、剪贴板提示条
  const FLOAT = ['.search-bar', '.sel-dock', '.more-menu', '.clip-banner'];
  // 底部弹层
  const SHEET = ['.delete-sheet', '.upload-error-panel', '.save-sheet'];
  // 小按钮
  const BTN = ['.small-btn', '.ghost-btn', '.delete-cancel', '.cloud-delete-option'];
  const BTN_PRIMARY = ['.ghost-btn.primary', '.small-btn.black', '.delete-confirm'];
  const FIELD = ['input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file])', 'textarea', 'select', '.url-input', '.dropzone'];

  const sel = (list, pre) => list.map(x => (pre || G) + ' ' + x).join(',\n');

  const CSS = `
${G} {
  --lg-blur: blur(22px) saturate(180%);
  --lg-blur-strong: blur(34px) saturate(190%);
  --lg-fill: linear-gradient(160deg, rgba(255,255,255,.62), rgba(255,255,255,.28));
  --lg-spec: radial-gradient(130% 100% at 0% 0%, rgba(255,255,255,.7), rgba(255,255,255,0) 55%);
  --lg-edge: rgba(255,255,255,.8);
  --lg-inset: inset 0 1.5px 0 rgba(255,255,255,.95), inset 0 -1px 0 rgba(255,255,255,.35), inset 1px 0 0 rgba(255,255,255,.5), inset -1px 0 0 rgba(255,255,255,.25);
  --lg-hair: 0 0 0 .5px rgba(60,60,67,.10);
  --lg-shadow: 0 12px 36px rgba(20,24,60,.10), 0 2px 6px rgba(20,24,60,.05);
  --lg-chip: linear-gradient(160deg, rgba(255,255,255,.85), rgba(255,255,255,.38));
  --lg-trough: rgba(120,120,128,.14);
  --lg-field: rgba(255,255,255,.45);
}
${D} {
  --lg-fill: linear-gradient(160deg, rgba(255,255,255,.14), rgba(255,255,255,.05));
  --lg-spec: radial-gradient(130% 100% at 0% 0%, rgba(255,255,255,.18), rgba(255,255,255,0) 55%);
  --lg-edge: rgba(255,255,255,.18);
  --lg-inset: inset 0 1px 0 rgba(255,255,255,.28), inset 0 -1px 0 rgba(255,255,255,.04), inset 1px 0 0 rgba(255,255,255,.10), inset -1px 0 0 rgba(255,255,255,.05);
  --lg-hair: 0 0 0 .5px rgba(255,255,255,.10);
  --lg-shadow: 0 14px 40px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.25);
  --lg-chip: linear-gradient(160deg, rgba(255,255,255,.20), rgba(255,255,255,.07));
  --lg-trough: rgba(255,255,255,.08);
  --lg-field: rgba(255,255,255,.07);
}

/* 卡片 / 分组 */
${sel(SURFACE)} {
  background: var(--lg-spec), var(--lg-fill) !important;
  -webkit-backdrop-filter: var(--lg-blur); backdrop-filter: var(--lg-blur);
  border-color: var(--lg-edge) !important;
  box-shadow: var(--lg-inset), var(--lg-hair), var(--lg-shadow) !important;
}
/* 资源库 / 仓库页的卡片本来就是透明的（网格直接铺在背景上），保持原样 */
${G} #page-gallery > .card {
  background: transparent !important; border: 0 !important; box-shadow: none !important;
  -webkit-backdrop-filter: none; backdrop-filter: none;
}

/* 悬浮层 */
${sel(FLOAT)} {
  background: var(--lg-spec), var(--lg-fill) !important;
  -webkit-backdrop-filter: var(--lg-blur-strong); backdrop-filter: var(--lg-blur-strong);
  border-color: var(--lg-edge) !important;
  box-shadow: var(--lg-inset), var(--lg-hair), var(--lg-shadow) !important;
}

/* 底部弹层 */
${sel(SHEET)} {
  background: var(--lg-spec), linear-gradient(180deg, rgba(252,252,254,.70), rgba(244,244,248,.56)) !important;
  -webkit-backdrop-filter: var(--lg-blur-strong); backdrop-filter: var(--lg-blur-strong);
  border-color: var(--lg-edge) !important;
  box-shadow: var(--lg-inset), 0 -18px 55px rgba(20,24,60,.14) !important;
}
${sel(SHEET, D)} {
  background: var(--lg-spec), linear-gradient(180deg, rgba(60,60,66,.62), rgba(36,36,40,.52)) !important;
  box-shadow: var(--lg-inset), 0 -18px 55px rgba(0,0,0,.5) !important;
}

/* 按钮：玻璃小胶囊 */
${sel(BTN)} {
  background: var(--lg-chip) !important;
  border-color: var(--lg-edge) !important;
  box-shadow: var(--lg-inset), var(--lg-hair), 0 4px 12px rgba(20,24,60,.06) !important;
}
${sel(BTN_PRIMARY)} {
  box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 6px 16px rgba(0,0,0,.18) !important;
}
${sel(BTN_PRIMARY, D)} {
  box-shadow: inset 0 1px 0 rgba(255,255,255,.9), 0 6px 16px rgba(0,0,0,.35) !important;
}

/* 输入框 / 拖放区：凹进去的玻璃 */
${sel(FIELD)} {
  background: var(--lg-field) !important;
  border-color: var(--lg-edge) !important;
  box-shadow: inset 0 1px 3px rgba(20,24,60,.10), inset 0 -1px 0 rgba(255,255,255,.5) !important;
}
${sel(FIELD, D)} {
  box-shadow: inset 0 1px 3px rgba(0,0,0,.45), inset 0 -1px 0 rgba(255,255,255,.06) !important;
}

/* 分段选择器：凹槽 + 玻璃滑块 */
${sel(['.filter-group', '.gallery-select-bar'])} {
  background: var(--lg-trough) !important;
  border-color: var(--lg-edge) !important;
  box-shadow: inset 0 1px 3px rgba(20,24,60,.10) !important;
}
${G} .filter-btn.active {
  background: var(--lg-chip) !important;
  box-shadow: var(--lg-inset), 0 3px 10px rgba(20,24,60,.12) !important;
}
${D} .filter-btn.active { box-shadow: var(--lg-inset), 0 3px 10px rgba(0,0,0,.4) !important; }

/* 首页每一行的小图标：玻璃方块 */
${G} .home .row-icon {
  background: var(--lg-chip);
  box-shadow: var(--lg-inset), var(--lg-hair);
}

/* 系统要求「降低透明度」时，去掉模糊、加大不透明度 */
@media (prefers-reduced-transparency: reduce) {
  ${sel([].concat(SURFACE, FLOAT, SHEET))} {
    -webkit-backdrop-filter: none !important; backdrop-filter: none !important;
    background: var(--card-bg) !important;
  }
}
`;

  DL.register({
    id: 'liquid-glass',
    name: '液态玻璃',
    desc: '卡片、底栏、弹窗、按钮改成苹果液态玻璃质感：半透明、高光边缘、柔和投影。不改背景，背景透出多少取决于页面的背景。',
    default: false,
    onToggle(on) {
      const root = document.documentElement;
      let el = document.getElementById(STYLE_ID);
      if (on) {
        if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el); }
        el.textContent = CSS;
        root.classList.add('dl-glass');
      } else {
        root.classList.remove('dl-glass');
        if (el) el.remove();
      }
    }
  });
})();
