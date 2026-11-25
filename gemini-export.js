// == Gemini Chat Exporter (API edition) ==
// == Gemini 聊天记录导出脚本（接口版）==
//
// Exports every Google Gemini conversation by calling the same internal endpoints the Gemini
// web app itself uses — no clicking, no scrolling.
//  · Every message carries a timestamp
//  · Independent of page rendering: keeps working in a background tab or a minimized window
//  · No need to expand the sidebar; it paginates to get the complete conversation list
//  · Resumable + incremental: a second run only exports new and updated conversations
//
// How to use
// 1. Open https://gemini.google.com/app in Chrome or Edge and sign in
//    (with several Google accounts, switch to the one you want to export first)
// 2. F12 → Console, paste this whole file, press Enter
// 3. Pick a mode. You can switch tabs or minimize afterwards; files download when it finishes
//
// Modes
//   1 = JSON packed into a ZIP (one .json per conversation)
//   2 = Markdown packed into a ZIP (one .md per conversation)
//   3 = JSON merged into one file
//   4 = Markdown merged into one file
//   5 = verify: read the open conversation through the API and compare it with the page
//       (run this once on a very long conversation before a full export)
//
// Language
//   Follows your browser language automatically. Chinese browsers get Chinese UI, everything
//   else gets English. Force it before running with:  window.__GX_LANG__ = 'en'   (or 'zh')
//
// 用法（中文）：
// 1. Edge/Chrome 打开并登录 https://gemini.google.com/app （多账号时进入你要导出的那个账号）
// 2. F12 → Console，粘贴本文件全部内容，回车
// 3. 选择模式。之后可以切走、最小化，导完自动下载
//
// 注意：这是 Gemini 未公开的内部接口，Google 改版后可能失效。
//       Edge 请在 edge://settings/system 里把 gemini.google.com 加入"从不让这些站点进入睡眠状态"，
//       否则长时间后台可能被 Edge 冻结。

(async function () {
  'use strict';

  // ==================== 语言 / Language ====================
  // 跟随浏览器语言；也可以在运行前执行 window.__GX_LANG__ = 'en' / 'zh' 强制指定。
  // Follows the browser language; force it with window.__GX_LANG__ = 'en' / 'zh' before running.
  const LANG = (() => {
    const forced = window.__GX_LANG__;
    if (forced === 'en' || forced === 'zh') return forced;
    const l = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^zh/i.test(l) ? 'zh' : 'en';
  })();

  const T = LANG === 'zh' ? {
    locale: 'zh-CN',
    alreadyRunning: '导出脚本已经在运行了',
    wrongHost: '请在 https://gemini.google.com 页面运行',
    noToken: '页面上找不到登录令牌，请确认已登录，并刷新页面后再运行',
    panelTitle: 'Gemini 导出（接口版）',
    preparing: '准备中…',
    preparingAction: '准备中',
    stop: '停止并保存已导出部分',
    stopping: '正在收尾并生成文件…',
    keepAwake: '🔊 防止 Edge 休眠',
    keepAwakeTitle: '播放几乎听不到的声音，浏览器不会冻结正在播放声音的标签页',
    keepOn: '✅ 已开启',
    keepFail: '开启失败',
    beat: (action, sec) => `正在：${action} · 最后活动 ${sec}s 前`,
    requestAction: (rpcid, n) => `请求 ${rpcid}（第 ${n} 次）`,
    authExpired: (s) => `登录已失效（HTTP ${s}），请刷新页面后重新运行（进度不会丢）`,
    badFormat: '返回格式无法解析',
    apiError: (e) => '接口返回错误 ' + e,
    timeout: (s) => `请求超过 ${s}s 没有响应`,
    requestFailed: '请求失败',
    retryWarn: (rpcid, n, msg) => `   ${rpcid} 第 ${n} 次失败：${msg}`,
    untitled: '(无标题)',
    listStatus: '获取对话列表…',
    listAction: '获取对话列表',
    listProgress: (n) => `获取对话列表… 已找到 ${n} 个`,
    listFound: (n) => `📋 共 ${n} 个对话`,
    readAction: (t) => `读取：${t}`,
    exportLine: (i, n, total, fresh) => `导出中 ${i}/${n}（共 ${total} 个，${fresh} 个已是最新）\n`,
    exportStats: (fails, sec) => `失败 ${fails} · 用时 ${sec}s`,
    background: '\n（后台运行中）',
    noMessages: '没有读到任何消息',
    okLine: (i, n, title, turns) => `✅ [${i}/${n}] ${title}（${turns} 轮）`,
    generating: '正在生成文件…',
    generatingAction: '生成文件',
    nothing: '没有导出任何对话',
    nothingAlert: '没有导出任何对话，详情见 Console',
    downloadAction: (f) => '下载 ' + f,
    dlButton: (f, mb) => `⬇️ 没自动下载？点这里下载 ${f}（${mb} MB）`,
    reportFile: '_导出报告.json',
    mergedTitle: (time, n) => `# Gemini 对话全量导出\n\n> 导出时间：${time}\n> 对话总数：${n}\n\n---\n\n`,
    summary: (ok, total, exported, fails, missing) =>
      (ok ? '✅ 全部完成' : '⚠️ 已保存，但有未完成项') +
      `\n列表共 ${total} 个 · 已导出 ${exported} 个\n失败 ${fails} 个 · 未导出 ${missing} 个` +
      (ok ? '' : '\n再运行一次选"增量更新"即可补齐') +
      '\n如果浏览器没有自动下载，点上面绿色的下载按钮',
    errorStatus: (m) => '❌ 出错了：' + m + '\n已导出的部分已保存，重新运行选"增量更新"即可继续',
    errorLog: '❌ 出错：',
    modePrompt: '请选择导出模式：\n' +
      '  1 = JSON 打包 ZIP（每个对话一个 .json）\n' +
      '  2 = Markdown 打包 ZIP（每个对话一个 .md）\n' +
      '  3 = JSON 合并成一个文件\n' +
      '  4 = Markdown 合并成一个文件\n' +
      '  5 = 校验当前对话（先测试用）\n\n输入 1-5：',
    incrConfirm: (n) => `发现之前导出过 ${n} 个对话。\n\n确定 = 增量更新（只导新对话和有更新的对话，最后打包全部）\n取消 = 清空，全部重新导出`,
    verifyNeedConv: '请先打开一个对话（网址是 /app/一串字符），再选模式 5',
    verifyReading: '用接口读取当前对话…',
    verifyResult: (turns, msgs, dom, fewer, incomplete) =>
      `接口读到 ${turns} 轮（${msgs} 条消息）\n页面上当前显示 ${dom} 条提问` +
      (fewer ? '\n⚠️ 接口读到的比页面少，请把这行告诉作者' : '\n✅ 接口没有比页面少（页面可能只显示了一部分）') +
      (incomplete ? '\n⚠️ 检测到无法使用的翻页标记' : ''),
    mdStarted: '开始时间：',
    mdUpdated: '最后更新：',
    mdMessages: '消息数：',
    mdLink: '原始链接：',
    mdIncomplete: '⚠️ 可能不完整',
    roleUser: '👤 用户',
    roleAssistant: '🤖 Gemini',
  } : {
    locale: 'en-CA',
    alreadyRunning: 'The exporter is already running.',
    wrongHost: 'Please run this on https://gemini.google.com',
    noToken: 'Could not find the auth token on this page. Make sure you are signed in, then refresh and run again.',
    panelTitle: 'Gemini Exporter (API)',
    preparing: 'Preparing…',
    preparingAction: 'preparing',
    stop: 'Stop and save what is exported',
    stopping: 'Wrapping up and building files…',
    keepAwake: '🔊 Keep tab awake',
    keepAwakeTitle: 'Plays near-silent audio so the browser will not freeze a tab that is playing sound',
    keepOn: '✅ On',
    keepFail: 'Failed',
    beat: (action, sec) => `Doing: ${action} · last activity ${sec}s ago`,
    requestAction: (rpcid, n) => `request ${rpcid} (attempt ${n})`,
    authExpired: (s) => `Session expired (HTTP ${s}). Refresh the page and run again — your progress is kept.`,
    badFormat: 'Could not parse the response',
    apiError: (e) => 'API returned an error ' + e,
    timeout: (s) => `No response after ${s}s`,
    requestFailed: 'Request failed',
    retryWarn: (rpcid, n, msg) => `   ${rpcid} attempt ${n} failed: ${msg}`,
    untitled: '(untitled)',
    listStatus: 'Fetching conversation list…',
    listAction: 'fetching conversation list',
    listProgress: (n) => `Fetching conversation list… ${n} found`,
    listFound: (n) => `📋 ${n} conversations in total`,
    readAction: (t) => `reading: ${t}`,
    exportLine: (i, n, total, fresh) => `Exporting ${i}/${n} (${total} in total, ${fresh} already up to date)\n`,
    exportStats: (fails, sec) => `${fails} failed · ${sec}s elapsed`,
    background: '\n(running in the background)',
    noMessages: 'No messages were read',
    okLine: (i, n, title, turns) => `✅ [${i}/${n}] ${title} (${turns} turns)`,
    generating: 'Building files…',
    generatingAction: 'building files',
    nothing: 'Nothing was exported',
    nothingAlert: 'Nothing was exported. See the Console for details.',
    downloadAction: (f) => 'downloading ' + f,
    dlButton: (f, mb) => `⬇️ No download started? Click to save ${f} (${mb} MB)`,
    reportFile: '_export-report.json',
    mergedTitle: (time, n) => `# All Gemini conversations\n\n> Exported at: ${time}\n> Conversations: ${n}\n\n---\n\n`,
    summary: (ok, total, exported, fails, missing) =>
      (ok ? '✅ All done' : '⚠️ Saved, but some items are unfinished') +
      `\n${total} in the list · ${exported} exported\n${fails} failed · ${missing} not exported` +
      (ok ? '' : '\nRun it again and choose "incremental" to fill the gaps') +
      '\nIf nothing downloaded automatically, click the green download button above',
    errorStatus: (m) => '❌ Error: ' + m + '\nEverything exported so far is saved. Run again and choose "incremental" to continue.',
    errorLog: '❌ Error:',
    modePrompt: 'Choose an export mode:\n' +
      '  1 = JSON as a ZIP (one .json per conversation)\n' +
      '  2 = Markdown as a ZIP (one .md per conversation)\n' +
      '  3 = all conversations in a single JSON file\n' +
      '  4 = all conversations in a single Markdown file\n' +
      '  5 = verify the current conversation (test run)\n\nEnter 1-5:',
    incrConfirm: (n) => `Found ${n} conversations exported earlier.\n\nOK = incremental update (only new and updated conversations, then package everything)\nCancel = clear the progress and export everything from scratch`,
    verifyNeedConv: 'Open a conversation first (the URL should contain /app/<id>), then choose mode 5',
    verifyReading: 'Reading the current conversation through the API…',
    verifyResult: (turns, msgs, dom, fewer, incomplete) =>
      `The API read ${turns} turns (${msgs} messages)\nThe page currently shows ${dom} questions` +
      (fewer ? '\n⚠️ The API returned fewer than the page — please report this line to the author' : '\n✅ The API did not return fewer than the page (the page may only render part of it)') +
      (incomplete ? '\n⚠️ Hit an unusable pagination cursor' : ''),
    mdStarted: 'Started: ',
    mdUpdated: 'Last updated: ',
    mdMessages: 'Messages: ',
    mdLink: 'Source: ',
    mdIncomplete: '⚠️ Possibly incomplete',
    roleUser: '👤 User',
    roleAssistant: '🤖 Gemini',
  };

  if (window.__GX_API_RUNNING__) { alert(T.alreadyRunning); return; }
  window.__GX_API_RUNNING__ = true;

  const CFG = {
    LIST_PAGE_SIZE: 20,     // 对话列表每页数量（Gemini 自己用 13 或 20）
    READ_PAGE_SIZE: 1000,   // 读取对话时每次请求的轮数
    DELAY_MS: 350,          // 请求之间的间隔，太快可能被限流
    RETRIES: 4,             // 单个请求失败重试次数（指数退避）
    REQUEST_TIMEOUT_MS: 45000, // 单个请求最长等待，超时就重试，绝不无限等
    DB_NAME: 'gemini-export-api',
    DEBUG: false,
  };

  // ==================== 后台不限速的计时器 ====================
  const timer = (() => {
    try {
      const src = 'onmessage=function(e){setTimeout(function(){postMessage(e.data)},e.data.ms)}';
      let url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      if (window.trustedTypes && trustedTypes.createPolicy) {
        try { url = trustedTypes.createPolicy('gx-api-timer', { createScriptURL: (u) => u }).createScriptURL(url); } catch (_) { /* 用原 URL */ }
      }
      const w = new Worker(url);
      const cbs = new Map();
      let n = 0, broken = false;
      w.onmessage = (e) => { const f = cbs.get(e.data.id); cbs.delete(e.data.id); if (f) f(); };
      w.onerror = () => { broken = true; for (const f of cbs.values()) setTimeout(f, 0); cbs.clear(); };
      return (fn, ms) => { if (broken) return setTimeout(fn, ms); const id = ++n; cbs.set(id, fn); w.postMessage({ id, ms }); };
    } catch (_) {
      return (fn, ms) => setTimeout(fn, ms);
    }
  })();
  const sleep = (ms) => new Promise((r) => timer(r, ms));
  const dbg = (...a) => { if (CFG.DEBUG) console.log('🔍', ...a); };

  // ==================== 面板 ====================
  let stopped = false;
  let panelStatus = null;
  function createPanel() {
    document.getElementById('gx-api-panel')?.remove();
    const box = document.createElement('div');
    box.id = 'gx-api-panel';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1f2937;color:#e5e7eb;' +
      'font:12px/1.7 system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.4);' +
      'max-width:360px;white-space:pre-line;border:1px solid rgba(255,255,255,.1)';
    const title = document.createElement('div');
    title.textContent = T.panelTitle;
    title.style.cssText = 'font-weight:600;margin-bottom:4px';
    const status = document.createElement('div');
    status.textContent = T.preparing;
    const btn = document.createElement('button');
    btn.textContent = T.stop;
    btn.style.cssText = 'margin-top:8px;padding:4px 12px;border:0;border-radius:6px;background:#ef4444;color:#fff;cursor:pointer;font-size:12px';
    btn.onclick = () => { stopped = true; btn.disabled = true; btn.style.opacity = '.5'; status.textContent = T.stopping; };
    const keep = document.createElement('button');
    keep.textContent = T.keepAwake;
    keep.title = T.keepAwakeTitle;
    keep.style.cssText = 'margin:8px 0 0 8px;padding:4px 10px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;font-size:12px';
    keep.onclick = () => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.value = 30;
        g.gain.value = 0.002;
        osc.connect(g).connect(ctx.destination);
        osc.start();
        ctx.resume();
        window.__GX_KEEP__ = ctx;
        keep.textContent = T.keepOn;
        keep.disabled = true;
        keep.style.background = '#16a34a';
      } catch (e) { keep.textContent = T.keepFail; }
    };
    const beat = document.createElement('div');
    beat.style.cssText = 'color:#9ca3af;margin-top:4px';
    const dl = document.createElement('div');
    dl.id = 'gx-api-dl';
    box.append(title, status, beat, dl, btn, keep);
    document.body.appendChild(box);
    panelStatus = status;
    panelBeat = beat;
    return box;
  }
  const setStatus = (m) => { if (panelStatus) panelStatus.textContent = m; dbg(m); };
  let lastActivity = Date.now(), lastAction = T.preparingAction;
  let panelBeat = null;
  setInterval(() => {
    if (panelBeat) panelBeat.textContent = T.beat(lastAction, Math.round((Date.now() - lastActivity) / 1000));
  }, 1000);

  // ==================== 接口 ====================
  const W = window.WIZ_global_data || {};
  const AT = W.SNlM0e, BL = W.cfb2h, FSID = W.FdrFJe;
  const PREFIX = (location.pathname.match(/^\/u\/\d+/) || [''])[0];   // 多账号时是 /u/1 之类
  const HL = document.documentElement.lang || 'zh-CN';
  let reqid = Math.floor(Math.random() * 90000) + 10000;

  function parseBatch(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
      const s = line.trim();
      if (!s.startsWith('[')) continue;
      try {
        for (const e of JSON.parse(s)) {
          if (Array.isArray(e) && e[0] === 'wrb.fr') {
            let inner = null;
            try { inner = e[2] ? JSON.parse(e[2]) : null; } catch (_) { /* 空 */ }
            out.push({ rpc: e[1], inner, err: e[5] || null });
          }
        }
      } catch (_) { /* 非完整行 */ }
    }
    return out;
  }

  class ApiError extends Error {}

  async function rpc(rpcid, payload, sourcePath) {
    let lastErr = null;
    for (let attempt = 0; attempt <= CFG.RETRIES; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** attempt);   // 2s, 4s, 8s, 16s
      reqid += 100000;
      const url = `${PREFIX}/_/BardChatUi/data/batchexecute?rpcids=${rpcid}` +
        `&source-path=${encodeURIComponent(sourcePath)}&bl=${encodeURIComponent(BL || '')}` +
        `&f.sid=${encodeURIComponent(FSID || '')}&hl=${encodeURIComponent(HL)}&_reqid=${reqid}&rt=c`;
      const body = new URLSearchParams();
      body.set('f.req', JSON.stringify([[[rpcid, JSON.stringify(payload), null, 'generic']]]));
      body.set('at', AT);
      const ac = new AbortController();
      let timedOut = false;
      timer(() => { timedOut = true; ac.abort(); }, CFG.REQUEST_TIMEOUT_MS);
      lastActivity = Date.now();
      lastAction = T.requestAction(rpcid, attempt + 1);
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
          body: body.toString(),
          signal: ac.signal,
        });
        if (res.status === 401 || res.status === 403) throw new ApiError(T.authExpired(res.status));
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const text = await res.text();
        lastActivity = Date.now();
        const parsed = parseBatch(text).find((p) => p.rpc === rpcid);
        if (!parsed) { lastErr = new Error(T.badFormat); continue; }
        if (parsed.err) { lastErr = new Error(T.apiError(JSON.stringify(parsed.err))); continue; }
        return parsed.inner;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        lastErr = timedOut ? new Error(T.timeout(CFG.REQUEST_TIMEOUT_MS / 1000)) : e;
        console.warn(T.retryWarn(rpcid, attempt + 1, lastErr.message));
      }
    }
    throw lastErr || new Error(T.requestFailed);
  }

  const plainId = (cid) => cid.replace(/^c_/, '');
  const convUrl = (cid) => `https://gemini.google.com${PREFIX}/app/${plainId(cid)}`;
  const tsToIso = (t) => (Array.isArray(t) && typeof t[0] === 'number'
    ? new Date(t[0] * 1000 + Math.floor((t[1] || 0) / 1e6)).toISOString() : null);
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(T.locale, { hour12: false }) : '');

  // ---- 对话列表（实测：MaZiqc，返回 [_, 翻页标记, [[c_id, 标题, _, _, _, [秒, 纳秒], ...], ...]]）----
  async function listAll(onProgress) {
    const all = new Map();
    // [0,null,1] 是普通列表；[1,null,1] 实测为空，推测是置顶/其他分组，也拉一遍以防漏
    for (const filter of [[0, null, 1], [1, null, 1]]) {
      let cursor = null;
      for (let page = 0; page < 1000; page++) {
        if (stopped) return all;
        const inner = await rpc('MaZiqc', [CFG.LIST_PAGE_SIZE, cursor, filter], `${PREFIX}/app`);
        const items = (inner && Array.isArray(inner[2])) ? inner[2] : [];
        let added = 0;
        for (const it of items) {
          const cid = it && it[0];
          if (typeof cid !== 'string' || all.has(cid)) continue;
          all.set(cid, { cid, title: it[1] || T.untitled, updatedAt: tsToIso(it[5]), order: all.size });
          added++;
        }
        onProgress(all.size);
        const next = inner && typeof inner[1] === 'string' ? inner[1] : null;
        if (!next || next === cursor || items.length === 0 || added === 0) break;
        cursor = next;
        await sleep(CFG.DELAY_MS);
      }
    }
    return all;
  }

  // ---- 读取单个对话（实测：hNvQHb，返回 [[轮, 轮, ...], ...]）----
  // 每一轮：[0]=[c_id, r_id]  [2][0][0]=提问文字  [3][0]=回答候选列表（[0]=rc_id, [1][0]=正文）
  //         [3][3]=选中的回答 rc_id  [4]=[秒, 纳秒] 时间
  async function readConversation(cid) {
    const turns = new Map();
    let cursor = null;
    let sawUnusableCursor = false;
    for (let page = 0; page < 200; page++) {
      const inner = await rpc('hNvQHb', [cid, CFG.READ_PAGE_SIZE, cursor, 1, [1], [4], null, 1], `${PREFIX}/app/${plainId(cid)}`);
      const list = (inner && Array.isArray(inner[0])) ? inner[0] : [];
      let added = 0;
      for (const t of list) {
        const key = (t && t[0] && t[0][1]) || JSON.stringify(t && t[4]);
        if (!turns.has(key)) { turns.set(key, t); added++; }
      }
      // 如果对话太长被分页，接口会给翻页标记（位置未完全确认，这里两处都检查）
      const next = inner ? [inner[1], inner[2]].find((x) => typeof x === 'string' && x.length > 8) : null;
      if (!next || next === cursor) break;
      if (added === 0) { sawUnusableCursor = true; break; }
      cursor = next;
      await sleep(CFG.DELAY_MS);
    }
    return { turns: Array.from(turns.values()), possiblyIncomplete: sawUnusableCursor };
  }

  const str = (v) => (typeof v === 'string' ? v : '');

  function turnToMessages(t) {
    const time = tsToIso(t && t[4]);
    const msgs = [];
    const userText = str(t && t[2] && t[2][0] && t[2][0][0]);
    if (userText) msgs.push({ role: 'user', time, content: userText });

    const resp = t && t[3];
    const cands = (resp && Array.isArray(resp[0])) ? resp[0] : [];
    const chosenId = resp && resp[3];
    const cand = cands.find((c) => c && c[0] === chosenId) || cands[0];
    const answer = cand && Array.isArray(cand[1]) ? cand[1].filter((x) => typeof x === 'string').join('\n\n') : '';
    if (answer) msgs.push({ role: 'assistant', time, content: answer });
    return msgs;
  }

  function buildRecord(meta, readResult) {
    const turns = readResult.turns.slice().sort((a, b) => {
      const ta = (a && a[4]) || [0, 0], tb = (b && b[4]) || [0, 0];
      return (ta[0] - tb[0]) || ((ta[1] || 0) - (tb[1] || 0));
    });
    const messages = turns.flatMap(turnToMessages);
    const times = messages.map((m) => m.time).filter(Boolean);
    return {
      conversationId: meta.cid,
      title: meta.title,
      url: convUrl(meta.cid),
      createdAt: times[0] || null,
      updatedAt: meta.updatedAt || times[times.length - 1] || null,
      exportedAt: new Date().toISOString(),
      turnCount: turns.length,
      messageCount: messages.length,
      possiblyIncomplete: readResult.possiblyIncomplete || undefined,
      messages,
      order: meta.order,
    };
  }

  // ==================== 断点续传存储 ====================
  const store = {
    db: null, mem: new Map(),
    async open() {
      try {
        this.db = await new Promise((res, rej) => {
          const r = indexedDB.open(CFG.DB_NAME, 1);
          r.onupgradeneeded = () => r.result.createObjectStore('convs', { keyPath: 'conversationId' });
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      } catch (_) { this.db = null; }
    },
    _req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    _os(m) { return this.db.transaction('convs', m).objectStore('convs'); },
    async put(v) { if (!this.db) { this.mem.set(v.conversationId, v); return; } return this._req(this._os('readwrite').put(v)); },
    async all() { if (!this.db) return [...this.mem.values()]; return this._req(this._os('readonly').getAll()); },
    async clear() { if (!this.db) { this.mem.clear(); return; } return this._req(this._os('readwrite').clear()); },
  };

  // ==================== ZIP（store，不压缩，UTF-8 文件名）====================
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
    return t;
  })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function createZip(files) {
    const enc = new TextEncoder();
    const chunks = [], entries = [];
    let offset = 0;
    const d = new Date();
    const dosTime = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
    const dosDate = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.content), crc = crc32(data);
      const h = new Uint8Array(30), v = new DataView(h.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
      v.setUint16(10, dosTime, true); v.setUint16(12, dosDate, true); v.setUint32(14, crc, true);
      v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
      entries.push({ name, crc, size: data.length, offset });
      chunks.push(h, name, data);
      offset += 30 + name.length + data.length;
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const e of entries) {
      const c = new Uint8Array(46), v = new DataView(c.buffer);
      v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true); v.setUint16(12, dosTime, true); v.setUint16(14, dosDate, true); v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true); v.setUint32(24, e.size, true); v.setUint16(28, e.name.length, true);
      v.setUint32(42, e.offset, true);
      chunks.push(c, e.name);
      cdSize += 46 + e.name.length;
    }
    const end = new Uint8Array(22), v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true);
    v.setUint32(12, cdSize, true); v.setUint32(16, cdStart, true);
    chunks.push(end);
    return new Blob(chunks, { type: 'application/zip' });
  }

  // ==================== 输出 ====================
  function download(blob, filename) {
    lastAction = T.downloadAction(filename);
    lastActivity = Date.now();
    const holder = document.getElementById('gx-api-dl');
    if (holder) {
      const b = document.createElement('button');
      const mb = (blob.size / 1048576).toFixed(1);
      b.textContent = T.dlButton(filename, mb);
      b.style.cssText = 'display:block;margin-top:8px;padding:6px 10px;border:0;border-radius:6px;background:#16a34a;color:#fff;cursor:pointer;font-size:12px;text-align:left';
      b.onclick = () => triggerDownload(blob, filename);
      holder.appendChild(b);
    }
    window.__GX_FILES__ = (window.__GX_FILES__ || []).concat([{ blob, filename }]);
    triggerDownload(blob, filename);
  }
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const downloadText = (t, name, mime) => download(new Blob([t], { type: mime }), name);
  const sanitize = (n) => String(n || 'gemini-chat').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 70) || 'gemini-chat';
  const strip = (r) => { const { order, ...rest } = r; return rest; };

  function toMarkdown(r, level = 1) {
    const h = '#'.repeat(level);
    let md = `${h} ${r.title}\n\n`;
    if (r.createdAt) md += `> ${T.mdStarted}${fmtTime(r.createdAt)}\n`;
    if (r.updatedAt) md += `> ${T.mdUpdated}${fmtTime(r.updatedAt)}\n`;
    md += `> ${T.mdMessages}${r.messageCount}\n> ${T.mdLink}${r.url}\n`;
    if (r.possiblyIncomplete) md += `> ${T.mdIncomplete}\n`;
    md += '\n---\n\n';
    for (const m of r.messages) {
      md += `${h}# ${m.role === 'user' ? T.roleUser : T.roleAssistant}${m.time ? ' · ' + fmtTime(m.time) : ''}\n\n${m.content}\n\n`;
    }
    return md;
  }

  // ==================== 模式 5：校验 ====================
  async function verifyCurrent() {
    const m = location.pathname.match(/\/app\/([\w-]{6,})/);
    if (!m) { alert(T.verifyNeedConv); return; }
    const cid = 'c_' + m[1];
    setStatus(T.verifyReading);
    const rr = await readConversation(cid);
    const rec = buildRecord({ cid, title: document.title.replace(/\s*[-–|—]\s*(Google\s+)?Gemini.*$/i, '') || cid, order: 0 }, rr);
    const domTurns = document.querySelectorAll('user-query').length;
    const msg = T.verifyResult(rec.turnCount, rec.messageCount, domTurns, domTurns > rec.turnCount, rr.possiblyIncomplete);
    setStatus(msg);
    console.log(msg);
    const base = sanitize(rec.title);
    downloadText(toMarkdown(rec), `${base}.md`, 'text/markdown;charset=utf-8');
    await sleep(400);
    downloadText(JSON.stringify(strip(rec), null, 2), `${base}.json`, 'application/json;charset=utf-8');
  }

  // ==================== 主流程 ====================
  async function run() {
    if (!location.hostname.includes('gemini.google.com')) { alert(T.wrongHost); return; }
    if (!AT) { alert(T.noToken); return; }
    createPanel();

    const choice = (prompt(T.modePrompt, '1') || '').trim();
    if (choice === '5') { await verifyCurrent(); return; }
    const modes = { 1: ['json', 'zip'], 2: ['md', 'zip'], 3: ['json', 'merge'], 4: ['md', 'merge'] };
    if (!modes[choice]) { document.getElementById('gx-api-panel')?.remove(); return; }
    const [format, mode] = modes[choice];

    await store.open();
    const prev = await store.all();
    if (prev.length && !confirm(T.incrConfirm(prev.length))) {
      await store.clear();
    }
    const saved = new Map((await store.all()).map((r) => [r.conversationId, r]));

    // 1. 拉全部对话列表 / fetch the full conversation list
    setStatus(T.listStatus);
    lastAction = T.listAction;
    const list = await listAll((n) => setStatus(T.listProgress(n)));
    console.log(T.listFound(list.size));

    // 2. 需要导出的：没导过的 + 有更新的 + 上次可能不完整的
    const todo = [...list.values()].filter((c) => {
      const s = saved.get(c.cid);
      return !s || s.possiblyIncomplete || (c.updatedAt && s.updatedAt && c.updatedAt > s.updatedAt);
    });
    const failures = [];
    const t0 = Date.now();

    for (let i = 0; i < todo.length && !stopped; i++) {
      const c = todo[i];
      lastAction = T.readAction(c.title.slice(0, 16));
      const sec = Math.round((Date.now() - t0) / 1000);
      setStatus(T.exportLine(i + 1, todo.length, list.size, saved.size) + `${c.title.slice(0, 30)}\n` + T.exportStats(failures.length, sec) +
        (document.hidden ? T.background : ''));
      try {
        const rec = buildRecord(c, await readConversation(c.cid));
        if (rec.messageCount === 0) throw new Error(T.noMessages);
        await store.put(rec);
        saved.set(rec.conversationId, rec);
        console.log(T.okLine(i + 1, todo.length, rec.title, rec.turnCount));
      } catch (e) {
        if (e instanceof ApiError) { alert(e.message); stopped = true; break; }
        failures.push({ title: c.title, url: convUrl(c.cid), reason: e.message });
        console.warn(`⚠️ ${c.title}: ${e.message}`);
      }
      await sleep(CFG.DELAY_MS);
    }

    // 3. 生成文件（包含以前导出过的全部）/ build the files (everything, including earlier runs)
    setStatus(T.generating);
    lastAction = T.generatingAction; lastActivity = Date.now();
    await sleep(50);
    const records = [...saved.values()].sort((a, b) => {
      const oa = list.get(a.conversationId)?.order ?? 1e9, ob = list.get(b.conversationId)?.order ?? 1e9;
      return oa - ob;
    });
    if (!records.length) { setStatus(T.nothing); alert(T.nothingAlert); return; }

    const missing = [...list.values()].filter((c) => !saved.has(c.cid)).map((c) => ({ title: c.title, url: convUrl(c.cid) }));
    const report = {
      generatedAt: new Date().toISOString(), listTotal: list.size, exported: records.length,
      stoppedManually: stopped, failures, missing,
      possiblyIncomplete: records.filter((r) => r.possiblyIncomplete).map((r) => ({ title: r.title, url: r.url })),
    };

    const stamp = new Date().toISOString().slice(0, 10);
    if (mode === 'zip') {
      const files = records.map((r, i) => ({
        name: `${String(i + 1).padStart(4, '0')}_${sanitize(r.title)}.${format === 'json' ? 'json' : 'md'}`,
        content: format === 'json' ? JSON.stringify(strip(r), null, 2) : toMarkdown(r),
      }));
      files.push({ name: T.reportFile, content: JSON.stringify(report, null, 2) });
      download(createZip(files), `gemini_chats_${stamp}.zip`);
    } else if (format === 'json') {
      downloadText(JSON.stringify({ platform: 'Google Gemini', exportedAt: new Date().toISOString(),
        totalConversations: records.length, conversations: records.map(strip), report }, null, 2),
      `gemini_all_${stamp}.json`, 'application/json;charset=utf-8');
    } else {
      let md = T.mergedTitle(fmtTime(new Date().toISOString()), records.length);
      for (const r of records) md += toMarkdown(r, 2) + '\n---\n\n';
      downloadText(md, `gemini_all_${stamp}.md`, 'text/markdown;charset=utf-8');
    }

    const ok = !stopped && !failures.length && !missing.length;
    const summary = T.summary(ok, list.size, records.length, failures.length, missing.length);
    setStatus(summary);
    console.log(summary);
    if (failures.length) console.table(failures);
  }

  try {
    await run();
  } catch (e) {
    console.error(T.errorLog, e);
    setStatus(T.errorStatus(e && e.message));
  } finally {
    window.__GX_API_RUNNING__ = false;
  }
})();
