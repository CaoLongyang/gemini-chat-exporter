// == Gemini 全量聊天记录导出脚本 v7（支持后台运行）==
// 导出所有 Gemini 历史对话为 JSON / Markdown，可打包成 ZIP
//
// 使用方法：
// 1. 浏览器打开并登录 https://gemini.google.com/app ，展开左侧侧边栏
// 2. 按 F12 → Console，粘贴本文件全部内容，回车
// 3. 按提示选择导出模式
// 4. ⚠️ 导出期间让这个标签页保持在前台（最好单独一个窗口）。
//    Chrome 会严重限速后台标签页，切走后脚本会慢到像卡死。
//
// 导出模式：
//   1 = JSON 打包 ZIP（每个对话一个 .json）
//   2 = Markdown 打包 ZIP（每个对话一个 .md）
//   3 = JSON 合并成一个文件
//   4 = Markdown 合并成一个文件
//   5 = 只导出当前打开的对话（先拿一个长对话测试用）
//
// 保证"全部导出"的机制：
//  · 侧边栏：从顶部按屏逐步滚到底，边滚边收集所有对话链接（兼容虚拟列表），
//    会自动点"显示更多"，连续多轮无新增 + 无加载圈才算到底。
//  · 单个对话：反复滚到对话区顶部，直到更早的消息不再出现，才开始解析。
//  · 切换判定：旧消息打标记，网址 + 新消息都对上才算打开成功；超时记失败，绝不把上一个对话错存。
//  · 失败/不完整的对话：自动再扫多轮重试，每轮放宽超时。
//  · 断点续传：每导出一个就存进浏览器 IndexedDB。中途停止、刷新、出错都不丢，
//    再次运行选"继续"会跳过已完成的。最终文件包含所有轮次导出的全部对话。
//  · 结束时生成 _导出报告.json，列出仍然失败的对话（如果有）。
//
// 提速：所有等待都用 MutationObserver 监听页面变化——新内容一出现立即进入下一步，
//       页面安静几百毫秒就判定完成，不再固定死等。

(async function () {
  'use strict';

  if (window.__GEMINI_EXPORT_RUNNING__) {
    alert('导出脚本已经在运行了。如需重来，请先点面板上的"停止"或刷新页面。');
    return;
  }
  window.__GEMINI_EXPORT_RUNNING__ = true;

  // ==================== 可调参数 ====================
  // 网络慢、仍有漏加载 → 调大 QUIET_MS / ROUND_MAX_MS / HISTORY_STABLE_ROUNDS
  const CFG = {
    POLL_MS: 150,                // 轮询间隔
    QUIET_MS: 700,               // 页面多久没变化算"安静"
    ROUND_MAX_MS: 6000,          // 单轮等待上限（加载圈一直在就一直等到这个上限）
    CONV_MAX_MS: 180000,         // 单个对话加载历史的总时长上限（超了先存已加载的，标记可能不完整）
    CONV_DEADLINE_MS: 240000,    // 单个对话从点击到解析完的硬上限，超了直接放弃、稍后重试
    OPEN_TIMEOUT: 20000,         // 打开一个对话的超时（重试轮次会自动放宽）
    HISTORY_STABLE_ROUNDS: 3,    // 对话区滚到顶后连续几轮没有更早的消息才算加载完
    HISTORY_MAX_ROUNDS: 800,     // 单个对话向上加载轮次上限
    FINAL_QUIET_MS: 1200,        // 解析前要求正文安静多久
    SIDEBAR_STABLE_ROUNDS: 4,    // 侧边栏到底后连续几轮无新增才算收集完
    SIDEBAR_MAX_ROUNDS: 2000,    // 侧边栏滚动轮次上限
    SCROLL_STEP_RATIO: 0.85,     // 侧边栏每次滚动推进视口比例
    BETWEEN_MS: 250,             // 对话之间间隔
    MAX_PASSES: 3,               // 总轮次（第 2、3 轮用于补漏和重试失败的）
    DB_NAME: 'gemini-export-v5',
    DEBUG: false,
  };

  // ==================== Gemini 页面结构 ====================
  // 实测结构：<gem-nav-list-item data-test-id="conversation"><a href="/u/1/app/<16位id>?pageId=none" aria-label="标题">
  // 注意：侧边栏收起时这些 <a> 不存在，必须保证侧边栏展开
  const SIDEBAR_SELECTORS = [
    '[data-test-id="conversation"] a[href*="/app/"]',
    'nav a[href*="/app/"]',
    '[role="navigation"] a[href*="/app/"]',
    'a[href*="/app/"]',
  ];
  const MESSAGE_SELECTORS = [
    'user-query, model-response',
    '[data-test-id="user-query"], [data-test-id="model-response"]',
  ];
  const CHAT_SCROLLER_SELECTORS = [
    'infinite-scroller',
    '[data-test-id="chat-history-container"]',
    '[class*="chat-history"]',
  ];
  const LOADING_SELECTORS = 'mat-progress-spinner, mat-spinner, mat-progress-bar, [role="progressbar"]';

  const SKIP_LABELS = /^(new chat|新对话|新聊天|发起新对话|new conversation|设置|settings|帮助|help|活动|activity|发现|explore|gem|升级|upgrade|管理|manage)$/i;
  const NOISE_TEXT = /^(copy|复制|复制代码|copy code|share|分享|good response|bad response|more|更多|edit|编辑|retry|重新生成|show drafts|显示草稿|like|dislike|赞|踩|show more|显示更多|show less|收起|你说[:：]?|you said[:：]?|gemini 说[:：]?|gemini said[:：]?)$/i;
  const SHOW_MORE_BTN = /^(show more|显示更多|查看更多|展开更多|load more|加载更多)$/i;
  const EXPAND_LABEL = /(expand|展开|显示更多|show more)/i;

  // ==================== 基础工具 ====================
  let stopped = false;     // 导出阶段：停止并保存
  let skipScan = false;    // 扫描阶段：不再扫描，直接导出已发现的
  let phase = 'scan';
  // ---- 后台计时器 ----
  // 标签页在后台时，浏览器会把页面里的 setTimeout 压到 1 秒甚至 1 分钟才跑一次，脚本看起来就像"偷懒"。
  // Web Worker 里的计时器不受这种限速，所以等待和轮询都改用 Worker 计时。Worker 被页面安全策略拦下时，退回普通计时器。
  const timerWorker = (() => {
    try {
      const src = 'onmessage=function(e){setTimeout(function(){postMessage(e.data.id)},e.data.ms)}';
      let url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      if (window.trustedTypes && trustedTypes.createPolicy) {
        try { url = trustedTypes.createPolicy('gx-export-timer', { createScriptURL: (u) => u }).createScriptURL(url); } catch (_) { /* 用原 URL 再试 */ }
      }
      const w = new Worker(url);
      const cbs = new Map();
      let n = 0, broken = false;
      w.onmessage = (e) => { const f = cbs.get(e.data); cbs.delete(e.data); if (f) f(); };
      w.onerror = () => { broken = true; for (const f of cbs.values()) setTimeout(f, 0); cbs.clear(); };
      return {
        get ok() { return !broken; },
        set(fn, ms) { if (broken) return setTimeout(fn, ms); const id = ++n; cbs.set(id, fn); w.postMessage({ id, ms }); return 'w' + id; },
        clear(id) { if (typeof id === 'string') cbs.delete(Number(id.slice(1))); else clearTimeout(id); },
      };
    } catch (e) {
      console.warn('后台计时器不可用（页面安全策略拦截），后台运行会变慢：', e && e.message);
      return null;
    }
  })();
  const setT = (fn, ms) => (timerWorker ? timerWorker.set(fn, ms) : setTimeout(fn, ms));
  const clearT = (id) => (timerWorker ? timerWorker.clear(id) : clearTimeout(id));
  const sleep = (ms) => new Promise((r) => setT(r, ms));

  // 每个对话的硬截止时间：超时就放弃这个对话（之后自动重试），绝不在一个对话上无限卡住
  let deadline = Infinity;
  const pastDeadline = () => Date.now() > deadline;

  // 记录这个对话处理期间标签页有没有进过后台
  let wasHidden = false;
  document.addEventListener('visibilitychange', () => { if (document.hidden) wasHidden = true; });
  const log = (...a) => console.log(...a);
  const dbg = (...a) => { if (CFG.DEBUG) console.log('🔍', ...a); };

  function normText(el) {
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  function isLoading(scope) {
    const root = scope || document;
    for (const el of root.querySelectorAll(LOADING_SELECTORS)) if (isVisible(el)) return true;
    return false;
  }

  async function waitUntil(fn, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopped || pastDeadline()) return false;
      try { if (fn()) return true; } catch (_) { /* 忽略 */ }
      await sleep(CFG.POLL_MS);
    }
    return false;
  }

  // 智能等待：cond 成立 → 'cond'；页面安静 quietMs 且无加载圈 → 'quiet'；超时 → 'timeout'
  function waitSmart({ scope, cond = null, quietMs = CFG.QUIET_MS, maxMs = CFG.ROUND_MAX_MS, childOnly = false }) {
    const target = scope || document.body;
    return new Promise((resolve) => {
      const start = Date.now();
      let lastMut = start;
      let timer = null;
      const obs = new MutationObserver(() => { lastMut = Date.now(); });
      // 侧边栏只看节点增删：动画、悬停效果之类的文字变化不算"还在加载"
      obs.observe(target, childOnly ? { childList: true, subtree: true } : { childList: true, subtree: true, characterData: true });
      const done = (r) => { clearT(timer); obs.disconnect(); resolve(r); };
      const tick = () => {
        if (stopped) return done('stopped');
        if (pastDeadline()) return done('deadline');
        try { if (cond && cond()) return done('cond'); } catch (_) { /* 忽略 */ }
        const now = Date.now();
        if (now - start >= maxMs) return done('timeout');
        if (now - lastMut >= quietMs && !isLoading(target)) return done('quiet');
        timer = setT(tick, CFG.POLL_MS);
      };
      timer = setT(tick, CFG.POLL_MS);
    });
  }

  function scrollableAncestors(start) {
    const chain = [];
    let node = start;
    while (node && node !== document.body && node !== document.documentElement) {
      const oy = getComputedStyle(node).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight - node.clientHeight > 10) chain.push(node);
      node = node.parentElement;
    }
    return chain;
  }

  function sanitizeFilename(name) {
    return String(name || 'gemini-chat')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 70) || 'gemini-chat';
  }

  // ==================== 状态面板 ====================
  let panelStatus = null, panelWarn = null, panelBtn = null, panelStep = null;
  let curStep = '', stepStart = 0;

  // 当前步骤 + 已用秒数，每秒刷新。万一再卡住，看这一行就知道卡在哪一步。
  function step(name) {
    curStep = name;
    stepStart = Date.now();
    dbg('步骤：' + name);
  }
  setInterval(() => {
    if (panelStep && curStep) panelStep.textContent = `当前步骤：${curStep}（${Math.round((Date.now() - stepStart) / 1000)}s）`;
  }, 1000);

  function setPhase(p) {
    phase = p;
    if (!panelBtn || stopped) return;
    panelBtn.disabled = false;
    panelBtn.style.opacity = '1';
    if (p === 'scan') {
      panelBtn.textContent = '停止扫描，直接导出已发现的对话';
      panelBtn.style.background = '#f59e0b';
    } else {
      panelBtn.textContent = '停止并保存已导出部分';
      panelBtn.style.background = '#ef4444';
    }
  }

  function createPanel() {
    document.getElementById('gemini-export-panel')?.remove();
    const box = document.createElement('div');
    box.id = 'gemini-export-panel';
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'background:#1f2937', 'color:#e5e7eb', 'font:12px/1.7 system-ui,-apple-system,sans-serif',
      'padding:10px 14px', 'border-radius:10px', 'box-shadow:0 8px 28px rgba(0,0,0,.4)',
      'max-width:360px', 'border:1px solid rgba(255,255,255,.1)', 'white-space:pre-line',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Gemini 导出 v7';
    title.style.cssText = 'font-weight:600;margin-bottom:4px;';
    const status = document.createElement('div');
    status.textContent = '准备中…';
    const stepEl = document.createElement('div');
    stepEl.style.cssText = 'color:#9ca3af;margin-top:4px;';
    panelStep = stepEl;
    const warn = document.createElement('div');
    warn.style.cssText = 'color:#fbbf24;margin-top:4px;';
    const btn = document.createElement('button');
    btn.textContent = '停止并保存已导出部分';
    btn.style.cssText = 'margin-top:8px;padding:4px 12px;border:0;border-radius:6px;background:#ef4444;color:#fff;cursor:pointer;font-size:12px;';
    btn.onclick = () => {
      if (phase === 'scan') {
        skipScan = true;
        status.textContent = '停止扫描，马上开始导出已发现的对话…';
      } else {
        stopped = true;
        status.textContent = '已请求停止，正在收尾并生成文件…';
      }
      btn.disabled = true;
      btn.style.opacity = '0.5';
    };
    const keep = document.createElement('button');
    keep.textContent = '🔊 开启后台保活';
    keep.title = '播放一段几乎听不到的声音，让浏览器不把这个标签页休眠/限速';
    keep.style.cssText = 'margin:8px 0 0 8px;padding:4px 10px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;';
    keep.onclick = () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 30;      // 30Hz 低频，加上极低音量，基本听不到
        gain.gain.value = 0.002;       // 不能是 0：完全静音时浏览器不算"正在播放"
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        ctx.resume();
        window.__GX_KEEPALIVE__ = ctx;
        keep.textContent = '✅ 后台保活已开启';
        keep.disabled = true;
        keep.style.background = '#16a34a';
      } catch (e) {
        keep.textContent = '保活开启失败';
        console.warn('后台保活开启失败：', e);
      }
    };
    box.append(title, status, stepEl, warn, btn, keep);
    document.body.appendChild(box);
    panelStatus = status;
    panelWarn = warn;
    panelBtn = btn;
    setPhase('scan');

    const onVis = () => {
      panelWarn.textContent = document.hidden
        ? (window.__GX_KEEPALIVE__ ? '标签页在后台运行中（已保活）；没加载出来的对话会在切回后自动补' : '⚠️ 标签页在后台，可能变慢；建议点“开启后台保活”')
        : '';
    };
    document.addEventListener('visibilitychange', onVis);
    return { box, btn };
  }

  function setStatus(msg) {
    if (panelStatus) panelStatus.textContent = msg;
    dbg(msg);
  }

  // ==================== 断点续传存储（IndexedDB，失败则退回内存）====================
  const store = {
    db: null,
    mem: new Map(),
    async open() {
      try {
        this.db = await new Promise((res, rej) => {
          const r = indexedDB.open(CFG.DB_NAME, 1);
          r.onupgradeneeded = () => r.result.createObjectStore('convs', { keyPath: 'conversationId' });
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      } catch (e) {
        console.warn('IndexedDB 不可用，进度只保存在内存里（刷新会丢）：', e);
        this.db = null;
      }
    },
    _req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    _os(mode) { return this.db.transaction('convs', mode).objectStore('convs'); },
    async put(v) { if (!this.db) { this.mem.set(v.conversationId, v); return; } return this._req(this._os('readwrite').put(v)); },
    async all() { if (!this.db) return Array.from(this.mem.values()); return this._req(this._os('readonly').getAll()); },
    async clear() { if (!this.db) { this.mem.clear(); return; } return this._req(this._os('readwrite').clear()); },
  };

  // ==================== 侧边栏 ====================
  function conversationIdOf(href) {
    const m = String(href || '').match(/\/app\/([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : null;
  }

  function getSidebarItems() {
    for (const sel of SIDEBAR_SELECTORS) {
      const raw = document.querySelectorAll(sel);
      if (raw.length === 0) continue;
      const seen = new Set();
      const items = [];
      for (const el of raw) {
        const href = el.getAttribute('href') || '';
        if (/^\/app\/?$/.test(href)) continue;          // "新对话" 就是 /app
        const id = conversationIdOf(href);
        if (!id || seen.has(id)) continue;
        const label = (el.getAttribute('aria-label') || '').trim() || normText(el);
        if (!label || label.length > 300 || SKIP_LABELS.test(label)) continue;
        seen.add(id);
        items.push({ id, href, label, el });
      }
      if (items.length > 0) return items;
    }
    return [];
  }

  // 从真实的对话链接往上找滚动容器（不会误找到"新对话"按钮那边）
  function getSidebarScroller() {
    const items = getSidebarItems();
    for (const it of [items[items.length - 1], items[0]]) {
      if (!it) continue;
      const chain = scrollableAncestors(it.el);
      if (chain.length) return chain[0];
    }
    // 实测：侧边栏的 infinite-scroller 有时是 overflow:hidden（带 disable-scroll 类），
    // 上面的检测会找不到它，导致只收集到第一屏。程序设置 scrollTop 对 hidden 同样有效。
    return (items[0] && items[0].el.closest('infinite-scroller'))
      || document.querySelector('[role="navigation"] infinite-scroller')
      || null;
  }

  // 侧边栏收起时对话链接根本不渲染。自动尝试展开，展开不了就提示用户并等待。
  function sidebarVisible() {
    return getSidebarItems().some((it) => it.el.getBoundingClientRect().height > 0);
  }

  function findMenuButton() {
    const direct = document.querySelector('[data-test-id="side-nav-menu-button"] button, button[data-test-id="side-nav-menu-button"]');
    if (direct) return direct;
    for (const b of document.querySelectorAll('button[aria-label]')) {
      const l = (b.getAttribute('aria-label') || '').trim();
      if (/^(主菜单|main menu|展开菜单|打开菜单|open menu|expand menu|展开侧边栏|打开侧边栏)$/i.test(l) && isVisible(b)) return b;
    }
    return null;
  }

  async function ensureSidebarOpen() {
    if (sidebarVisible()) return true;
    const b = findMenuButton();
    if (b) {
      b.click();
      if (await waitUntil(sidebarVisible, 3000)) return true;
    }
    const prev = panelStatus ? panelStatus.textContent : '';
    setStatus('⚠️ 侧边栏收起了，看不到对话列表。\n请点左上角 ☰ 把侧边栏展开，展开后脚本会自动继续。');
    console.warn('⚠️ 侧边栏收起了，等待展开…');
    const ok = await waitUntil(sidebarVisible, 10 * 60 * 1000);
    if (ok) setStatus(prev);
    return ok;
  }

  function getSidebarScope() {
    const it = getSidebarItems()[0];
    return (it && it.el.closest('nav, [role="navigation"], side-navigation, bard-sidenav'))
      || getSidebarScroller() || document.body;
  }

  // 老版本侧边栏有"显示更多"按钮
  function clickShowMore() {
    const scope = getSidebarScope();
    for (const b of scope.querySelectorAll('button, [role="button"]')) {
      if (SHOW_MORE_BTN.test(normText(b)) && isVisible(b)) {
        try { b.click(); return true; } catch (_) { /* 忽略 */ }
      }
    }
    return false;
  }

  // 阶段一：从顶到底逐屏滚动，收集全部对话
  const convList = new Map();   // id -> { id, href, label, order }

  function harvest() {
    let added = 0;
    for (const it of getSidebarItems()) {
      if (!convList.has(it.id)) {
        convList.set(it.id, { id: it.id, href: it.href, label: it.label, order: convList.size });
        added++;
      }
    }
    return added;
  }

  async function collectAllConversations() {
    const scanStart = Date.now();
    step('扫描侧边栏');
    if (!(await ensureSidebarOpen())) return convList.size;
    let sc = getSidebarScroller();
    if (sc) {
      sc.scrollTop = 0;
      await waitSmart({ scope: sc, quietMs: 300, maxMs: 2000, childOnly: true, cond: () => skipScan });
    }
    harvest();

    let stable = 0;
    for (let round = 0; round < CFG.SIDEBAR_MAX_ROUNDS; round++) {
      if (stopped || skipScan) break;
      if (!sidebarVisible() && !(await ensureSidebarOpen())) break;
      const before = convList.size;
      // 一出现新对话就立刻进入下一步，不用等页面完全安静
      const grewOrSkip = () => skipScan || stopped || (harvest(), convList.size > before);

      if (clickShowMore()) {
        await waitSmart({ scope: getSidebarScope(), maxMs: 6000, childOnly: true, cond: grewOrSkip });
        harvest();
        stable = 0;
        continue;
      }

      sc = getSidebarScroller();
      let moved = false;
      if (sc) {
        const prev = sc.scrollTop;
        const step = Math.max(200, Math.floor(sc.clientHeight * CFG.SCROLL_STEP_RATIO));
        sc.scrollTop = Math.min(prev + step, sc.scrollHeight);
        moved = Math.abs(sc.scrollTop - prev) > 1;
        if (!moved) {
          // 已到底：往上抖一下再滚回底部，触发加载更多
          sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - 300);
          await sleep(80);
          sc.scrollTop = sc.scrollHeight;
          const items = getSidebarItems();
          items[items.length - 1]?.el.scrollIntoView({ block: 'end' });
        }
      }

      await waitSmart({
        scope: getSidebarScope(),
        quietMs: moved ? 250 : Math.round(CFG.QUIET_MS * 1.5),
        maxMs: moved ? 2500 : 6000,
        childOnly: true,
        cond: grewOrSkip,
      });
      harvest();

      if (!moved && convList.size === before) stable++;
      else stable = 0;

      const sec = Math.round((Date.now() - scanStart) / 1000);
      setStatus(`扫描侧边栏… 已发现 ${convList.size} 个对话（${sec}s）` +
        (stable ? `\n到底确认中 ${stable}/${CFG.SIDEBAR_STABLE_ROUNDS}` : '') +
        '\n嫌慢可点下方按钮，直接导出已发现的');
      if (stable >= CFG.SIDEBAR_STABLE_ROUNDS) break;
    }
    return convList.size;
  }

  function findLinkById(id) {
    for (const a of document.querySelectorAll('a[href*="/app/"]')) {
      if (conversationIdOf(a.getAttribute('href')) === id) return a;
    }
    return null;
  }

  // 节点可能被重渲染/回收：现查；查不到就从侧边栏顶部逐屏往下找
  async function findAndClick(id) {
    const tryClick = () => {
      const a = findLinkById(id);
      if (!a) return false;
      a.scrollIntoView({ block: 'center' });
      a.click();
      return true;
    };
    if (tryClick()) return true;
    if (!(await ensureSidebarOpen())) return false;
    if (tryClick()) return true;

    const sc = getSidebarScroller();
    if (!sc) return false;
    const found = () => stopped || !!findLinkById(id);
    sc.scrollTop = 0;
    await waitSmart({ scope: sc, quietMs: 300, maxMs: 3000, childOnly: true, cond: found });
    for (let i = 0; i < 1000; i++) {
      if (stopped || pastDeadline()) return false;
      if (tryClick()) return true;
      const prev = sc.scrollTop;
      sc.scrollTop = Math.min(prev + Math.floor(sc.clientHeight * 0.8), sc.scrollHeight);
      await waitSmart({ scope: sc, quietMs: 300, maxMs: 6000, childOnly: true, cond: found });
      if (Math.abs(sc.scrollTop - prev) <= 1 && !isLoading(sc)) {
        return tryClick();   // 到底了
      }
    }
    return false;
  }

  // ==================== 对话区 ====================
  function getMain() { return document.querySelector('main') || document.body; }

  function findMessageTurns() {
    const root = getMain();
    for (const sel of MESSAGE_SELECTORS) {
      let found = Array.from(root.querySelectorAll(sel));
      if (found.length === 0 && root !== document.body) {
        found = Array.from(document.querySelectorAll(sel))
          .filter((el) => !el.closest('nav, [role="navigation"], [class*="sidenav"], [class*="sidebar"]'));
      }
      if (found.length > 0) return found;
    }
    return [];
  }

  function contentSignature() {
    const turns = findMessageTurns();
    let len = 0;
    for (const t of turns) len += (t.textContent || '').length;
    return `${turns.length}|${len}`;
  }

  function getChatScroller(turn) {
    // 实测：对话区滚动容器是 <infinite-scroller data-test-id="chat-history-container">
    const known = document.querySelector('infinite-scroller[data-test-id="chat-history-container"], [data-test-id="chat-history-container"]');
    if (known) return known;
    if (turn) {
      const chain = scrollableAncestors(turn);
      if (chain.length) return chain[0];
    }
    for (const sel of CHAT_SCROLLER_SELECTORS) {
      const el = document.querySelector(`main ${sel}`) || document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight) return el;
    }
    return null;
  }

  // 旧版给旧消息打标记、等"全部都是新元素"才算切换完成。
  // 但 Angular 切换对话时会复用 <user-query>/<model-response> 元素，标记永远不会消失，
  // 结果每个对话都要白等满 20 秒超时——这就是"一直在加载"的主要原因。
  // 现在改为比较内容：网址变成目标 ID，并且第一条消息的内容和切换前不同，就算打开成功。
  async function openConversation(conv, timeout) {
    if (conversationIdOf(location.pathname) === conv.id && findMessageTurns().length > 0) return true;

    const beforeKey = turnKey(findMessageTurns()[0]);
    step('打开对话');
    if (!(await findAndClick(conv.id))) return false;

    const idOk = () => conversationIdOf(location.pathname) === conv.id;
    const changed = await waitUntil(() => {
      if (!idOk()) return false;
      const turns = findMessageTurns();
      return turns.length > 0 && turnKey(turns[0]) !== beforeKey;
    }, timeout);
    if (changed) return true;

    // 两个对话第一句完全相同的罕见情况：网址对了、有消息、内容稳定，也接受
    if (idOk() && findMessageTurns().length > 0) {
      await waitSmart({ scope: getMain(), childOnly: true, quietMs: 1000, maxMs: 4000 });
      return true;
    }
    return false;
  }

  // 核心：反复滚到对话区顶部，直到更早的消息不再出现
  // 结束条件只看"有没有真正的新进展"：消息数创新高，或者顶部出现了从没见过的消息。
  // 不再用"元素是否同一个"判断——Gemini 重渲染节点时元素会变，旧版因此永远停不下来。
  const turnKey = (t) => (t ? t.tagName + '|' + (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '');

  async function loadFullHistory() {
    step('加载完整历史');
    const main = getMain();
    const convStart = Date.now();
    await waitSmart({ scope: main, childOnly: true, maxMs: 4000 });

    let stable = 0, rounds = 0, maxCount = 0, shrunk = false, timedOut = false;
    const seenTops = new Set();
    const t0 = findMessageTurns();
    maxCount = t0.length;
    seenTops.add(turnKey(t0[0]));

    while (rounds < CFG.HISTORY_MAX_ROUNDS) {
      if (stopped) break;
      if (Date.now() - convStart > CFG.CONV_MAX_MS || pastDeadline()) { timedOut = true; break; }
      rounds++;

      const turns = findMessageTurns();
      if (turns.length === 0) break;
      const n = turns.length;
      const topKey = turnKey(turns[0]);
      const sc = getChatScroller(turns[0]);

      if (sc) {
        if (sc.scrollTop <= 5) {         // 已在顶部：先往下抖一下，否则不会再触发加载
          sc.scrollTop = 150;
          await sleep(50);
        }
        sc.scrollTop = 0;
      }
      turns[0].scrollIntoView({ block: 'start' });

      const r = await waitSmart({
        scope: main,
        childOnly: true,                 // 只看节点增删，动画/光标之类的文字变化不算
        cond: () => {
          const t = findMessageTurns();
          return t.length > n || turnKey(t[0]) !== topKey;
        },
      });

      const now = findMessageTurns();
      const nowTop = turnKey(now[0]);
      if (now.length < maxCount) shrunk = true;

      const progressed = now.length > maxCount || (nowTop && !seenTops.has(nowTop));
      maxCount = Math.max(maxCount, now.length);
      seenTops.add(nowTop);

      if (progressed) stable = 0;
      else stable++;

      const sec = Math.round((Date.now() - convStart) / 1000);
      dbg(`↑ 第 ${rounds} 轮：${now.length} 条，${r}，稳定 ${stable}`);
      setStatus(`${curStatusPrefix}\n加载历史中… 已加载 ${now.length} 条（第 ${rounds} 轮，${sec}s，${r}）` +
        (stable ? `\n到顶确认中 ${stable}/${CFG.HISTORY_STABLE_ROUNDS}` : ''));

      const noOverflow = !sc || sc.scrollHeight - sc.clientHeight <= 10;
      if (noOverflow && stable >= 1) break;               // 不满一屏的短对话
      if (stable >= CFG.HISTORY_STABLE_ROUNDS) break;
    }

    await expandCollapsedQueries();
    await waitSmart({ scope: main, childOnly: true, quietMs: CFG.FINAL_QUIET_MS, maxMs: 6000 });

    if (shrunk) console.warn('   ⚠️ 加载过程中消息数变少过，页面可能用了虚拟列表，请检查这个对话');
    if (timedOut) console.warn(`   ⚠️ 单个对话超过 ${CFG.CONV_MAX_MS / 1000}s，先保存已加载的部分并标记为可能不完整`);
    return { rounds, hitLimit: rounds >= CFG.HISTORY_MAX_ROUNDS || timedOut, shrunk };
  }

  // 展开被折叠的长提问
  async function expandCollapsedQueries() {
    let clicked = 0;
    for (const q of findMessageTurns()) {
      if (q.tagName.toLowerCase() !== 'user-query') continue;
      for (const b of q.querySelectorAll('button')) {
        const label = (b.getAttribute('aria-label') || '') + ' ' + normText(b);
        if (EXPAND_LABEL.test(label) && b.getAttribute('aria-expanded') !== 'true') {
          try { b.click(); clicked++; } catch (_) { /* 忽略 */ }
        }
      }
    }
    if (clicked) await sleep(300);
  }

  // ==================== 解析 ====================
  let curStatusPrefix = '';
  let lastTitle = '';

  function getTitle(fallback) {
    let t = '';
    const dt = (document.title || '').trim();
    const cleaned = dt.replace(/\s*[-–|—]\s*(Google\s+)?Gemini.*$/i, '').trim();
    if (cleaned && !/^(google\s+)?gemini$/i.test(cleaned)) t = cleaned;
    // document.title 偶尔滞后于路由，读到上一个对话的标题时改用侧边栏文字
    if (t && t === lastTitle && fallback && fallback !== t) t = fallback;
    if (!t) t = fallback || 'gemini-chat';
    lastTitle = t;
    return t.slice(0, 80);
  }

  function detectRole(turn) {
    const tag = turn.tagName.toLowerCase();
    if (tag === 'user-query') return 'user';
    if (tag === 'model-response') return 'assistant';
    const tid = (turn.getAttribute('data-test-id') || '').toLowerCase();
    if (/user|query/.test(tid)) return 'user';
    return 'assistant';
  }

  const SPEAKER_PREFIX = /^\s*(你说|您说|you said|gemini\s*说|gemini said)[:：]?\s*/i;
  const BLOCK_SEL ='p, li, pre, h1, h2, h3, h4, h5, h6, td, th, blockquote';

  function extractBlocks(turn) {
    const nodes = turn.querySelectorAll(BLOCK_SEL);
    const blocks = [];
    const captured = new Set();

    for (const el of nodes) {
      if (el.closest('button, [role="button"], [aria-hidden="true"]')) continue;
      if (el.closest('.cdk-visually-hidden, [class*="visually-hidden"], [class*="screen-reader"], [class*="sr-only"]')) continue;
      // 祖先已收录就跳过（避免 li > p 重复）；沿父链查 Set，线性复杂度
      let p = el.parentElement, inside = false;
      while (p && p !== turn) { if (captured.has(p)) { inside = true; break; } p = p.parentElement; }
      if (inside) continue;

      const text = (el.innerText || el.textContent || '').trim();   // innerText 保留换行
      if (!text || NOISE_TEXT.test(text)) continue;

      const tag = el.tagName.toLowerCase();
      // 实测：每条提问开头有一个 <h5><span>你说</span>…</h5>，是给读屏软件的隐藏标题，
      // 内容和下面的段落重复。导出时跳过，否则每条提问会变成"##### 你说xxx"并重复一遍。
      if (/^h[1-6]$/.test(tag) && SPEAKER_PREFIX.test(text)) continue;
      let formatted = text;
      if (tag === 'pre') formatted = '```\n' + text + '\n```';
      else if (tag === 'li') formatted = '- ' + text.replace(/\n/g, '\n  ');
      else if (tag === 'blockquote') formatted = '> ' + text.replace(/\n/g, '\n> ');
      else if (/^h[1-6]$/.test(tag)) formatted = '#'.repeat(Number(tag[1])) + ' ' + text;

      blocks.push({ tag, text, formatted });
      captured.add(el);
    }

    if (blocks.length === 0) {
      const whole = (turn.innerText || turn.textContent || '')
        .split('\n').filter((l) => !NOISE_TEXT.test(l.trim())).join('\n').trim()
        .replace(SPEAKER_PREFIX, '').trim();
      if (whole) blocks.push({ tag: 'p', text: whole, formatted: whole });
    }
    return blocks;
  }

  function parseConversation(fallbackTitle) {
    const turns = findMessageTurns();
    const messages = [];
    for (const turn of turns) {
      const blocks = extractBlocks(turn);
      if (blocks.length === 0) continue;
      messages.push({ role: detectRole(turn), content: blocks.map((b) => b.text).join('\n'), blocks });
    }
    if (messages.length === 0) return null;
    return {
      title: getTitle(fallbackTitle),
      url: location.href,
      conversationId: conversationIdOf(location.pathname),
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    };
  }

  // ==================== ZIP 打包（store，不压缩，UTF-8 文件名）====================
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time, date };
  }

  function createZip(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const entries = [];
    let offset = 0;
    const { time: dosTime, date: dosDate } = dosDateTime(new Date());
    const FLAG_UTF8 = 0x0800;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = encoder.encode(file.content);
      const crc = crc32(dataBytes);
      const lh = new Uint8Array(30);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, FLAG_UTF8, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, dataBytes.length, true);
      dv.setUint32(22, dataBytes.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      entries.push({ nameBytes, crc, size: dataBytes.length, offset });
      chunks.push(lh, nameBytes, dataBytes);
      offset += lh.length + nameBytes.length + dataBytes.length;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const e of entries) {
      const cd = new Uint8Array(46);
      const dv = new DataView(cd.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, FLAG_UTF8, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, dosTime, true);
      dv.setUint16(14, dosDate, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.size, true);
      dv.setUint32(24, e.size, true);
      dv.setUint16(28, e.nameBytes.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, e.offset, true);
      chunks.push(cd, e.nameBytes);
      cdSize += cd.length + e.nameBytes.length;
    }

    const eocd = new Uint8Array(22);
    const dv = new DataView(eocd.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(4, 0, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, entries.length, true);
    dv.setUint16(10, entries.length, true);
    dv.setUint32(12, cdSize, true);
    dv.setUint32(16, cdStart, true);
    dv.setUint16(20, 0, true);
    chunks.push(eocd);
    return new Blob(chunks, { type: 'application/zip' });
  }

  // ==================== 下载 & 输出格式 ====================
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const downloadText = (content, filename, mime) => downloadBlob(new Blob([content], { type: mime }), filename);

  const stripMeta = (d) => {
    const { order, possiblyIncomplete, sidebarLabel, ...rest } = d;
    return possiblyIncomplete ? { ...rest, possiblyIncomplete } : rest;
  };
  const toJsonSingle = (d) => JSON.stringify(stripMeta(d), null, 2);
  const toJsonBundle = (arr) => JSON.stringify({
    platform: 'Google Gemini',
    exportedAt: new Date().toISOString(),
    totalConversations: arr.length,
    conversations: arr.map(stripMeta),
  }, null, 2);

  function toMarkdownSingle(d) {
    let md = `# ${d.title}\n\n`;
    md += `> 导出时间：${new Date(d.exportedAt).toLocaleString()}\n`;
    md += `> 消息数：${d.messageCount}\n`;
    md += `> 原始链接：${d.url}\n`;
    if (d.possiblyIncomplete) md += `> ⚠️ 可能不完整（达到加载轮次上限）\n`;
    md += `\n---\n\n`;
    for (const m of d.messages) {
      md += `## ${m.role === 'user' ? '👤 用户' : '🤖 Gemini'}\n\n`;
      for (const b of m.blocks) md += b.formatted + '\n\n';
      md += '---\n\n';
    }
    return md;
  }

  function toMarkdownBundle(arr) {
    let md = `# Gemini 对话全量导出\n\n> 导出时间：${new Date().toLocaleString()}\n> 对话总数：${arr.length}\n\n---\n\n`;
    arr.forEach((d, i) => {
      md += `## 对话 ${i + 1}：${d.title}\n\n> 消息数：${d.messageCount}　链接：${d.url}\n\n`;
      for (const m of d.messages) {
        md += `### ${m.role === 'user' ? '👤 用户' : '🤖 Gemini'}\n\n`;
        for (const b of m.blocks) md += b.formatted + '\n\n';
      }
      md += '---\n\n';
    });
    return md;
  }

  // ==================== 模式 5：只导当前对话 ====================
  async function exportCurrentOnly() {
    setPhase('export');
    curStatusPrefix = '当前对话';
    setStatus('加载当前对话的完整历史…');
    const info = await loadFullHistory();
    const data = parseConversation('');
    if (!data) { setStatus('当前页面没有解析到消息'); alert('⚠️ 当前页面没有解析到消息'); return; }
    const base = sanitizeFilename(data.title);
    downloadText(toMarkdownSingle(data), `${base}.md`, 'text/markdown;charset=utf-8');
    await sleep(500);
    downloadText(toJsonSingle(data), `${base}.json`, 'application/json;charset=utf-8');
    setStatus(`✅ ${data.title}\n${data.messageCount} 条消息（向上加载 ${info.rounds} 轮）`);
  }

  // ==================== 主流程 ====================
  async function run() {
    if (!location.hostname.includes('gemini.google.com')) {
      alert('⚠️ 请先在浏览器中打开 https://gemini.google.com/app 并登录');
      return;
    }

    const panel = createPanel();

    const choice = (prompt(
      '请选择导出模式：\n' +
      '  1 = JSON 打包 ZIP（每个对话一个 .json）\n' +
      '  2 = Markdown 打包 ZIP（每个对话一个 .md）\n' +
      '  3 = JSON 合并成一个文件\n' +
      '  4 = Markdown 合并成一个文件\n' +
      '  5 = 只导出当前打开的对话（先测试用）\n\n' +
      '输入 1-5：', '1') || '').trim();

    if (choice === '5') { await exportCurrentOnly(); return; }

    let format, mode;
    if (choice === '1') { format = 'json'; mode = 'zip'; }
    else if (choice === '2') { format = 'markdown'; mode = 'zip'; }
    else if (choice === '3') { format = 'json'; mode = 'merge'; }
    else if (choice === '4') { format = 'markdown'; mode = 'merge'; }
    else { panel.box.remove(); log('已取消'); return; }

    // 断点续传
    await store.open();
    const previous = await store.all();
    if (previous.length > 0) {
      const resume = confirm(
        `发现上次的导出进度：已完成 ${previous.length} 个对话。\n\n` +
        '确定 = 继续（跳过已完成的，最后一起打包）\n' +
        '取消 = 清空进度，从头开始'
      );
      if (!resume) await store.clear();
    }

    const doneIds = new Set((await store.all()).filter((r) => !r.possiblyIncomplete).map((r) => r.conversationId));
    const failures = new Map();   // id -> { title, href, reason }
    let exportedThisRun = 0;
    const startedAt = Date.now();

    let scanSkipped = false;
    let extraPasses = 0;            // 因为后台导致失败的，额外多给几轮重试，不占正常轮次
    for (let pass = 0; pass < CFG.MAX_PASSES + extraPasses && !stopped; pass++) {
      let total;
      if (scanSkipped) {
        // 用户主动跳过了扫描：后面几轮只重试已发现但失败的，不再重新扫
        total = convList.size;
      } else {
        setPhase('scan');
        // 侧边栏的"滚动加载更多"依赖页面渲染，后台标签页不渲染，扫描必然漏。所以扫描只在前台做。
        if (document.hidden) {
          setStatus('⏸ 扫描侧边栏需要本标签页在前台。\n切回这个标签页后会自动继续（导出阶段可以放后台）。');
          await waitUntil(() => !document.hidden, 24 * 3600 * 1000);
        }
        setStatus(`第 ${pass + 1} 轮：扫描侧边栏…`);
        total = await collectAllConversations();
        if (skipScan) {
          scanSkipped = true;
          log(`⏭ 已跳过剩余扫描，导出已发现的 ${total} 个对话`);
        }
      }
      setPhase('export');
      if (total === 0) {
        alert('⚠️ 未找到侧边栏对话列表。\n\n请确认：\n1. 侧边栏已展开\n2. 有历史对话\n3. 页面已加载完成');
        break;
      }
      log(`📋 第 ${pass + 1} 轮：侧边栏共 ${total} 个对话，已完成 ${doneIds.size} 个`);

      const pending = Array.from(convList.values())
        .filter((c) => !doneIds.has(c.id))
        .sort((a, b) => a.order - b.order);
      if (pending.length === 0) break;

      const openTimeout = CFG.OPEN_TIMEOUT * (1 + pass * 0.5);   // 重试轮次放宽超时

      let hiddenFailures = 0;
      for (let i = 0; i < pending.length; i++) {
        if (stopped) break;
        const conv = pending[i];
        deadline = Date.now() + CFG.CONV_DEADLINE_MS * (1 + pass * 0.5);
        wasHidden = document.hidden;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        curStatusPrefix =
          `第 ${pass + 1} 轮 · ${i + 1}/${pending.length}：${conv.label.slice(0, 24)}\n` +
          `已完成 ${doneIds.size}/${convList.size} · 失败 ${failures.size} · 用时 ${elapsed}s`;
        setStatus(curStatusPrefix);
        log(`⏳ [${doneIds.size + 1}/${convList.size}] ${conv.label.slice(0, 40)}`);

        const opened = await openConversation(conv, openTimeout);
        if (!opened) {
          if (stopped) break;
          const why = wasHidden ? '标签页在后台，页面没有加载' : (pastDeadline() ? '超过单个对话时长上限' : '打开超时或找不到侧边栏项');
          if (wasHidden) hiddenFailures++;
          console.warn(`   ⚠️ ${why}，稍后重试`);
          failures.set(conv.id, { title: conv.label, href: conv.href, reason: why });
          continue;
        }

        const info = await loadFullHistory();
        if (stopped) break;   // 停止时这个对话可能没加载完，不保存
        if (pastDeadline() && wasHidden) {
          // 后台期间超时：加载很可能不完整，不保存这一份，稍后重试
          hiddenFailures++;
          console.warn('   ⚠️ 标签页在后台导致加载超时，稍后重试');
          failures.set(conv.id, { title: conv.label, href: conv.href, reason: '标签页在后台，页面没有加载' });
          continue;
        }

        step('解析消息');
        const data = parseConversation(conv.label);
        if (!data) {
          console.warn('   ⚠️ 未解析到消息，稍后重试');
          failures.set(conv.id, { title: conv.label, href: conv.href, reason: '未解析到消息' });
          continue;
        }
        if (data.conversationId !== conv.id) {
          console.warn('   ⚠️ 打开的不是目标对话，稍后重试');
          failures.set(conv.id, { title: conv.label, href: conv.href, reason: '页面与目标对话不一致' });
          continue;
        }

        data.order = conv.order;
        data.sidebarLabel = conv.label;
        if (info.hitLimit) data.possiblyIncomplete = true;
        step('保存进度');
        await store.put(data);
        exportedThisRun++;
        failures.delete(conv.id);
        if (!info.hitLimit) doneIds.add(conv.id);
        else failures.set(conv.id, { title: conv.label, href: conv.href, reason: '达到加载轮次上限，可能不完整' });

        log(`   ✅ ${data.title}（${data.messageCount} 条消息，向上加载 ${info.rounds} 轮）`);
        await sleep(CFG.BETWEEN_MS);
      }
      deadline = Infinity;
      if (hiddenFailures > 0 && extraPasses < 7) {
        extraPasses++;
        log(`🔁 本轮有 ${hiddenFailures} 个对话因为后台没加载，会再多补一轮`);
      }

      if (failures.size === 0 && pass > 0) break;   // 第二轮起，没有失败就不必再扫
    }

    // ==================== 生成文件 ====================
    deadline = Infinity;
    step('生成文件');
    setStatus('正在生成文件…');
    const records = (await store.all()).sort((a, b) => {
      const oa = convList.get(a.conversationId)?.order ?? a.order ?? 1e9;
      const ob = convList.get(b.conversationId)?.order ?? b.order ?? 1e9;
      return oa - ob;
    });

    const exportedIds = new Set(records.map((r) => r.conversationId));
    const missing = Array.from(convList.values())
      .filter((c) => !exportedIds.has(c.id))
      .map((c) => ({ title: c.label, href: c.href, reason: failures.get(c.id)?.reason || (stopped ? '手动停止前未处理' : '未知') }));
    const incomplete = records.filter((r) => r.possiblyIncomplete).map((r) => ({ title: r.title, href: r.url }));

    const report = {
      generatedAt: new Date().toISOString(),
      sidebarTotal: convList.size,
      exported: records.length,
      exportedThisRun,
      stoppedManually: stopped,
      scanSkipped,
      missing,
      possiblyIncomplete: incomplete,
    };

    if (records.length === 0) {
      const msg = stopped
        ? '还没开始导出就停止了，所以没有文件。\n扫描阶段如果嫌慢，请点橙色的"停止扫描，直接导出已发现的对话"，\n它会继续导出，而不是结束。'
        : '没有成功导出任何对话。\n请把 CFG.DEBUG 改为 true 重新运行，把 Console 输出发出来排查。';
      setStatus(msg);
      alert('⚠️ ' + msg);
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const ext = format === 'json' ? 'json' : 'md';
    if (mode === 'zip') {
      const files = records.map((d, i) => ({
        name: `${String(i + 1).padStart(4, '0')}_${sanitizeFilename(d.title)}.${ext}`,
        content: format === 'json' ? toJsonSingle(d) : toMarkdownSingle(d),
      }));
      files.push({ name: '_导出报告.json', content: JSON.stringify(report, null, 2) });
      downloadBlob(createZip(files), `gemini_chats_${stamp}.zip`);
    } else {
      if (format === 'json') {
        downloadText(toJsonBundle(records), `gemini_all_${stamp}.json`, 'application/json;charset=utf-8');
      } else {
        downloadText(toMarkdownBundle(records), `gemini_all_${stamp}.md`, 'text/markdown;charset=utf-8');
      }
      if (missing.length || incomplete.length) {
        await sleep(500);
        downloadText(JSON.stringify(report, null, 2), `gemini_export_report_${stamp}.json`, 'application/json;charset=utf-8');
      }
    }

    const allDone = missing.length === 0 && incomplete.length === 0 && !stopped && !scanSkipped;
    const summary =
      `${allDone ? '✅ 全部完成' : '⚠️ 已保存，但有未完成项'}\n` +
      `已发现 ${convList.size} 个 · 已导出 ${records.length} 个\n` +
      `仍缺 ${missing.length} 个 · 可能不完整 ${incomplete.length} 个` +
      (scanSkipped ? '\n扫描被跳过，侧边栏更下面可能还有没发现的对话' : '') +
      (!allDone ? '\n再运行一次脚本选"继续"（让扫描跑完）即可只补剩下的' : '');
    setStatus(summary);

    log('\n════════════════════════');
    log(summary);
    if (missing.length) console.table(missing);
    if (incomplete.length) console.table(incomplete);
    log('════════════════════════');
    log(`进度保存在浏览器 IndexedDB（${CFG.DB_NAME}）。确认文件没问题后可在 Console 运行：indexedDB.deleteDatabase('${CFG.DB_NAME}')`);
  }

  try {
    await run();
  } catch (e) {
    console.error('❌ 导出出错：', e);
    setStatus('❌ 出错了，详情见 Console。\n已导出的部分保存在 IndexedDB，重新运行选"继续"即可。');
  } finally {
    window.__GEMINI_EXPORT_RUNNING__ = false;
  }
})();
