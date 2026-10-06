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
  // 白名单：只保留显示图像必需的段（JFIF、ICC 色彩配置、Adobe 色彩变换），其余应用段全部丢掉。
  // 图像数据之后（EOI 之后）的尾部数据也丢掉：手机的预览图 / HDR 增益图 / 动态照片视频都接在那里，自带 EXIF。
  function stripJpeg(u) {
    const out = [u.subarray(0, 2)];
    let p = 2, dropped = false, orient = 1, insertAt = 1;
    while (p + 2 <= u.length) {
      if (u[p] !== 0xFF) return null;                        // 结构异常，放弃处理
      const m = u[p + 1];
      if (m === 0xFF) { p++; continue; }                     // 填充字节
      if (m === 0xD9) {                                      // EOI：之后的内容不要
        out.push(u.subarray(p, p + 2));
        if (p + 2 < u.length) dropped = true;
        p = u.length; break;
      }
      if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { out.push(u.subarray(p, p + 2)); p += 2; continue; }
      if (p + 4 > u.length) return null;
      const len = (u[p + 2] << 8) | u[p + 3];
      if (len < 2 || p + 2 + len > u.length) return null;
      if (m === 0xDA) {                                      // SOS：带头部 + 熵编码数据，扫到下一个真正的标记为止
        let q = p + 2 + len;
        while (q + 1 < u.length) {
          if (u[q] === 0xFF && u[q + 1] !== 0x00 && u[q + 1] !== 0xFF && !(u[q + 1] >= 0xD0 && u[q + 1] <= 0xD7)) break;
          q++;
        }
        if (q + 1 >= u.length) q = u.length;
        out.push(u.subarray(p, q)); p = q; continue;
      }
      const seg = u.subarray(p, p + 2 + len), body = u.subarray(p + 4, p + 2 + len);
      let drop = false;
      if (m === 0xE1) { const o = readOrientation(body); if (o > 1) orient = o; drop = true; }   // EXIF / XMP
      else if (m === 0xE0) drop = ascii(body, 0, 'JFXX');                                // JFIF 扩展缩略图
      else if (m === 0xE2) drop = !ascii(body, 0, 'ICC_PROFILE');                        // 只留 ICC；MPF 等丢掉
      else if (m === 0xEE) drop = !ascii(body, 0, 'Adobe');
      else if ((m >= 0xE3 && m <= 0xEF) || m === 0xFE) drop = true;                      // 厂商私有段、Photoshop/IPTC、注释
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
    let p = 8, dropped = false, sawEnd = false;
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    while (p + 12 <= u.length) {
      const len = dv.getUint32(p), end = p + 12 + len;
      if (end > u.length) return null;
      const type = String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
      if (DROP.indexOf(type) >= 0) dropped = true; else out.push(u.subarray(p, end));
      p = end;
      if (type === 'IEND') { sawEnd = true; break; }
    }
    if (sawEnd && p < u.length) dropped = true;               // IEND 之后的尾部数据不要
    return dropped ? concat(out) : null;
  }

  /* ---------- WebP ---------- */
  function stripWebp(u) {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const limit = Math.min(u.length, dv.getUint32(4, true) + 8);      // 只处理 RIFF 声明的范围
    if (limit < 20) return null;
    const out = [u.slice(0, 12)];
    let p = 12, dropped = limit < u.length;                            // 声明范围之外的尾部数据不要
    while (p + 8 <= limit) {
      const id = String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]);
      const size = dv.getUint32(p + 4, true), end = p + 8 + size + (size & 1);
      if (p + 8 + size > limit) return null;
      const chunk = u.subarray(p, Math.min(end, limit));
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

  /* HEIC / AVIF：暂时不处理，但要让人知道，别以为已经去掉了 */
  function isHeifLike(head) {
    if (!ascii(head, 4, 'ftyp')) return false;
    return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis'].some(b => ascii(head, 8, b));
  }

  DL.register({
    id: 'strip-exif',
    name: '去除照片隐私信息',
    desc: '上传前删掉 GPS 位置、拍摄时间、相机型号、预览图等。JPEG / PNG / WebP 无损处理，不重新压缩，照片方向会保留。HEIC / AVIF 暂不支持，会在结果里提示。',
    default: true,
    async beforeUpload(file) {
      if (!file || file.size < 64 || file.size > MAX_SIZE) return file;
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const jpeg = head[0] === 0xFF && head[1] === 0xD8;
      const png = ascii(head, 1, 'PNG') && head[0] === 0x89;
      const webp = ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP');
      if (!jpeg && !png && !webp) {
        if (isHeifLike(head)) file._saveNote = (file._saveNote ? file._saveNote + ' · ' : '') + '未去隐私信息（暂不支持 HEIC / AVIF）';
        return file;
      }
      const u = new Uint8Array(await file.arrayBuffer());
      let res = null;
      try { res = jpeg ? stripJpeg(u) : png ? stripPng(u) : stripWebp(u); } catch (_) { res = null; }
      if (!res) return file;                                  // 本来就没有隐私信息，或结构看不懂：保持原样
      const out = new File([res], file.name, { type: file.type, lastModified: file.lastModified });
      out._saveNote = (file._saveNote ? file._saveNote + ' · ' : '') + '已去隐私信息';
      return out;
    }
  });
})();
