// == Gemini 接口探测脚本 v2（只用于诊断，不导出任何内容）==
// 用法：Gemini 页面（展开侧边栏）→ F12 → Console → 粘贴回车 → 等约 40 秒 → 把结果发给作者
// 做的事：
//  A. 直接调用"对话列表"接口，测试翻页能不能拿到下一批
//  B. 用几种参数格式试读一个对话，看哪种能拿到消息正文和时间
//  C. 顺便监听 Gemini 自己打开对话时发的请求（这次能正确记录请求参数）
// 安全：不输出登录令牌（at）和 Cookie；长文字截断；只读取，不修改任何对话。

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = { page: location.pathname.replace(/[\w-]{10,}$/, '<id>'), errors: [] };

  // ---------- 工具 ----------
  const W = window.WIZ_global_data || {};
  const at = W.SNlM0e, bl = W.cfb2h, fsid = W.FdrFJe;
  const prefix = (location.pathname.match(/^\/u\/\d+/) || [''])[0];
  const hl = document.documentElement.lang || 'zh-CN';
  R.tokens = { hasAt: !!at, hasBl: !!bl, hasFsid: !!fsid, prefix, hl };
  let reqid = Math.floor(Math.random() * 90000) + 10000;

  const parseResp = (t) => {
    const out = [];
    for (const line of String(t).split('\n')) {
      const s = line.trim();
      if (!s.startsWith('[')) continue;
      try {
        for (const e of JSON.parse(s)) {
          if (Array.isArray(e) && e[0] === 'wrb.fr') {
            let inner = null;
            try { inner = JSON.parse(e[2]); } catch (_) { /* 空 */ }
            out.push({ rpc: e[1], inner, rawLen: (e[2] || '').length, err: e[5] || null });
          }
        }
      } catch (_) { /* 非完整行 */ }
    }
    return out;
  };
  const skel = (v, d = 0, maxD = 12) => {
    if (d > maxD) return '…';
    if (Array.isArray(v)) {
      const a = v.slice(0, 6).map((x) => skel(x, d + 1, maxD));
      if (v.length > 6) a.push(`+${v.length - 6}项`);
      return a;
    }
    if (typeof v === 'string') return v.length > 12 ? `${v.slice(0, 6)}…(${v.length})` : v;
    if (v && typeof v === 'object') return '{obj}';
    return v;
  };
  const walk = (v, path, fn) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, fn));
    else fn(v, path);
  };
  const summarize = (inner) => {
    const ts = [], ids = [], longs = [];
    walk(inner, '', (x, path) => {
      if (typeof x === 'number' && Number.isInteger(x) && x > 1.4e9 && x < 2.1e9 && ts.length < 20) ts.push(`${path}=${x}`);
      if (typeof x === 'string' && /^(c_|r_|rc_)[0-9a-f]{8,}$/.test(x) && ids.length < 20) ids.push(`${path}=${x.slice(0, 5)}…`);
      if (typeof x === 'string' && x.length > 80 && longs.length < 20) longs.push(`${path}(${x.length}字)`);
    });
    return { timestampPaths: ts, idPaths: ids, longTextPaths: longs };
  };

  async function rpc(rpcid, payload, sourcePath) {
    reqid += 100000;
    const url = `${prefix}/_/BardChatUi/data/batchexecute?rpcids=${rpcid}` +
      `&source-path=${encodeURIComponent(sourcePath)}&bl=${encodeURIComponent(bl || '')}` +
      `&f.sid=${encodeURIComponent(fsid || '')}&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`;
    const body = new URLSearchParams();
    body.set('f.req', JSON.stringify([[[rpcid, JSON.stringify(payload), null, 'generic']]]));
    if (at) body.set('at', at);
    const res = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
      body: body.toString(),
    });
    const t = await res.text();
    return { status: res.status, len: t.length, parsed: parseResp(t) };
  }

  // ---------- C. 先装监听（正确处理各种请求体类型）----------
  const caps = [];
  const OF = window.fetch;
  const bodyToString = async (b) => {
    if (!b) return '';
    if (typeof b === 'string') return b;
    if (b instanceof URLSearchParams) return b.toString();
    if (b instanceof FormData) return new URLSearchParams([...b.entries()].map(([k, v]) => [k, String(v)])).toString();
    if (b instanceof Blob) return await b.text();
    try { return String(b); } catch (_) { return ''; }
  };
  window.fetch = async function (input, init) {
    const url = String((input && input.url) || input);
    let bodyStr = '';
    if (/batchexecute/.test(url)) {
      try { bodyStr = await bodyToString(init && init.body); } catch (_) { /* 忽略 */ }
      if (!bodyStr && input instanceof Request) { try { bodyStr = await input.clone().text(); } catch (_) { /* 忽略 */ } }
    }
    const res = await OF.apply(this, arguments);
    if (/batchexecute/.test(url)) {
      try { caps.push({ url, body: bodyStr, resp: await res.clone().text() }); } catch (_) { /* 忽略 */ }
    }
    return res;
  };
  const restore = () => { window.fetch = OF; };

  try {
    if (!at) R.errors.push('页面上没找到 at 令牌（WIZ_global_data.SNlM0e）');

    // ---------- A. 对话列表 + 翻页 ----------
    const listVariants = [
      [13, null, [0, null, 1]],
      [20, null, [0, null, 1]],
      [13, null, [1, null, 1]],
    ];
    R.list = [];
    let firstIds = [], cursor = null, okVariant = null;
    for (const p of listVariants) {
      try {
        const r = await rpc('MaZiqc', p, `${prefix}/app`);
        const inner = r.parsed[0] && r.parsed[0].inner;
        const items = (inner && Array.isArray(inner[2])) ? inner[2] : [];
        R.list.push({ payload: JSON.stringify(p), status: r.status, count: items.length,
          hasCursor: !!(inner && typeof inner[1] === 'string'), err: r.parsed[0] && r.parsed[0].err });
        if (items.length && !okVariant) {
          okVariant = p;
          firstIds = items.map((x) => x[0]);
          cursor = inner[1];
          R.listItemSkeleton = JSON.stringify(skel(items[0], 0, 4)).slice(0, 1500);
        }
      } catch (e) { R.errors.push('list: ' + e.message); }
      await sleep(400);
    }
    if (okVariant && cursor) {
      const pageVariants = [
        [okVariant[0], cursor, okVariant[2]],
        [okVariant[0], cursor],
      ];
      R.page2 = [];
      for (const p of pageVariants) {
        try {
          const r = await rpc('MaZiqc', p, `${prefix}/app`);
          const inner = r.parsed[0] && r.parsed[0].inner;
          const items = (inner && Array.isArray(inner[2])) ? inner[2] : [];
          const ids = items.map((x) => x[0]);
          R.page2.push({ payload: `[${p[0]}, <cursor>${p.length > 2 ? ', ' + JSON.stringify(p[2]) : ''}]`, status: r.status,
            count: items.length, overlapWithPage1: ids.filter((x) => firstIds.includes(x)).length,
            hasNextCursor: !!(inner && typeof inner[1] === 'string') });
        } catch (e) { R.errors.push('page2: ' + e.message); }
        await sleep(400);
      }
    }

    // ---------- B. 读取单个对话 ----------
    const cid = firstIds[0] || (() => {
      const a = document.querySelector('[data-test-id="conversation"] a[href*="/app/"]');
      const m = a && a.getAttribute('href').match(/\/app\/([\w-]+)/);
      return m ? 'c_' + m[1] : null;
    })();
    R.readTarget = cid ? cid.slice(0, 6) + '…' : null;
    if (cid) {
      const plain = cid.replace(/^c_/, '');
      const readVariants = [
        [cid, 10, null, 1, [1], [4], null, 1],
        [cid, 10, null, 1, [0], [4], null, 1],
        [cid, 1000, null, 1, [1], [4], null, 1],
        [cid, 10, null, 1, [1], null, null, 1],
        [cid, 10],
      ];
      R.read = [];
      for (const p of readVariants) {
        try {
          const r = await rpc('hNvQHb', p, `${prefix}/app/${plain}`);
          const first = r.parsed[0] || {};
          const entry = { payload: JSON.stringify(p).replace(cid, '<cid>'), status: r.status, rawLen: first.rawLen || 0, err: first.err };
          if (first.inner) {
            Object.assign(entry, summarize(first.inner));
            entry.topLen = Array.isArray(first.inner) ? first.inner.length : null;
            entry.turns = Array.isArray(first.inner[0]) ? first.inner[0].length : null;
            entry.skeleton = JSON.stringify(skel(first.inner, 0, 9)).slice(0, 3500);
          }
          R.read.push(entry);
        } catch (e) { R.errors.push('read: ' + e.message); }
        await sleep(500);
      }
    }

    // ---------- C. 触发一次真实的"打开对话"，记录 Gemini 自己的请求参数 ----------
    const links = [...document.querySelectorAll('[data-test-id="conversation"] a[href*="/app/"]')];
    const cur = (location.pathname.match(/\/app\/([\w-]+)/) || [])[1];
    const target = links.reverse().find((a) => !a.getAttribute('href').includes(cur || '###'));
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.click();
      await sleep(8000);
    }
    restore();
    R.afterClickPage = location.pathname.replace(/[\w-]{10,}$/, '<id>');
    R.observed = caps.map((c) => {
      const u = new URL(c.url, location.origin);
      let freq = '';
      try { freq = new URLSearchParams(c.body).get('f.req') || ''; } catch (_) { /* 忽略 */ }
      const parsed = parseResp(c.resp);
      return {
        rpcids: u.searchParams.get('rpcids'),
        fReq: freq.replace(/c_[0-9a-f]{8,}/g, '<cid>').replace(/"[A-Za-z0-9_-]{60,}"/g, '"<long>"').slice(0, 400),
        rawLens: parsed.map((p) => p.rawLen),
      };
    });
  } catch (e) {
    restore();
    R.errors.push(String((e && e.stack) || e));
  }

  window.__probe = JSON.stringify(R);
  try { copy(window.__probe); } catch (_) { /* 忽略 */ }
  console.log(window.__probe);
  console.log(`✅ 探测完成（${window.__probe.length} 字），已复制。粘贴为空就输入 copy(window.__probe) 再粘贴。`);
})();
