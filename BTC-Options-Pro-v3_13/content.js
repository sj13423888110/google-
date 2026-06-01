// ════════════════════════════════════════════════════════════════
//  TradingView Claude Analyzer — content.js  v1.7 (Binance)
//  v1.7: 新增指标交叉检测、BB %B/带宽、量比、RSI近14序列；删除永续模式
// ════════════════════════════════════════════════════════════════
(function () {
  // 只在顶层页面运行，防止注入到 iframe 后 chrome.storage 不可用
  if (window.self !== window.top) return;

  // storage 命名空间补丁（必须在任何 chrome.storage.local.* 调用之前执行）
  // background.js 已经做过 onInstalled 迁移，这里只需要透明前缀
  if (self.StorageNS && typeof self.StorageNS.patchStorage === 'function') {
    self.StorageNS.patchStorage();
  }

  // 安全包装：插件重载后旧 content.js 调用 chrome API 会抛 "Extension context invalidated"
  // 用这些函数替代所有 chrome API 调用，静默忽略上下文失效错误
  // 上下文失效是预期场景（用户更新扩展后的旧页面），无需上报
  function _isCtxInvalidated(e) {
    const m = String(e && e.message || '');
    return m.includes('Extension context invalidated') ||
           m.includes('Receiving end does not exist') ||
           m.includes('The message port closed');
  }
  function safeSendMessage(msg, callback) {
    try {
      if (callback) chrome.runtime.sendMessage(msg, callback);
      else chrome.runtime.sendMessage(msg).catch(e => {
        if (!_isCtxInvalidated(e)) console.warn('[content/sendMessage]', e.message || e);
      });
    } catch(e) { /* 扩展上下文已失效，忽略 */ }
  }

  // 内容脚本日志器：异步推送到 background.js 的 BgLog，方便用户从 popup 一键导出
  // 失败也不要再抛错，避免日志器本身成为新的错误源
  const CtLog = {
    _send(level, scope, msg, data) {
      try {
        chrome.runtime.sendMessage({
          type: 'CT_LOG', level: level, scope: scope || '?',
          msg: String(msg || ''),
          data: data === undefined ? undefined : (typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : String(data))
        }).catch(() => {});
      } catch(_) { /* SW 未唤醒/上下文失效，忽略 */ }
    },
    debug(scope, m, d) { this._send('DEBUG', scope, m, d); if (typeof console !== 'undefined') console.debug('[CT]', scope, m, d || ''); },
    info(scope, m, d)  { this._send('INFO',  scope, m, d); },
    warn(scope, m, d)  { this._send('WARN',  scope, m, d); if (typeof console !== 'undefined') console.warn('[CT]', scope, m, d || ''); },
    error(scope, m, d) { this._send('ERROR', scope, m, d); if (typeof console !== 'undefined') console.error('[CT]', scope, m, d || ''); }
  };

  // ── 扩展上下文失效提示 ──
  // 当扩展更新或被禁用后，旧的 content.js 仍在页面上运行但所有 chrome.* API 都会抛异常
  // 此时静默吞错会让"读 storage 拿空对象→以为用户没配置→保存时覆盖"的危险路径出现
  // 改为弹一次顶部横幅，提醒用户刷新页面。
  let _ctxLostBannerShown = false;
  function _showCtxLostBanner(reason) {
    if (_ctxLostBannerShown) return;
    // v3.13.4：真·上下文失效时 chrome.runtime.id 会变 undefined。
    //   新页面正常载入时它有值——用它当守卫，避免注入时机/瞬时抖动导致"每次刷新都弹"。
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        // 上下文仍有效，是误报，不弹横幅
        return;
      }
    } catch(_) { /* 访问 chrome.runtime 本身抛错才是真失效，继续弹 */ }
    _ctxLostBannerShown = true;
    try {
      const banner = document.createElement('div');
      banner.id = 'tvc-ctx-lost-banner';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'background:#7f1d1d;color:#fff;padding:8px 14px;font-size:13px;' +
        'font-family:-apple-system,sans-serif;text-align:center;' +
        'box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer';
      banner.innerHTML = '⚠️ GOODLE 扩展已更新或上下文失效，' +
        '<span style="text-decoration:underline">点此刷新页面</span>' +
        ' 以恢复功能 <span style="opacity:.6">(' + (reason || 'context lost') + ')</span>';
      banner.addEventListener('click', () => location.reload());
      document.documentElement.appendChild(banner);
    } catch(_) { /* 连 DOM 都挂了就放弃 */ }
  }

  function _wrapStoragePromise(p, fallback, opName, keys) {
    if (!p || typeof p.then !== 'function') return Promise.resolve(fallback);
    return p.catch(e => {
      const m = String(e && e.message || e);
      if (_isCtxInvalidated(e)) {
        _showCtxLostBanner('storage.' + opName + ' failed');
      } else {
        CtLog.warn('[storage:' + opName + ']', m, keys);
      }
      return fallback;
    });
  }

  // v3.13.4：横幅只在"真·上下文失效"时弹。同步 throw 但非上下文失效（如注入时机早于
  //   chrome.storage 就绪、patch 包装的边角异常）不再误弹横幅——这是"每次刷新都弹"的根因。
  function safeStorageGet(keys) {
    try {
      return _wrapStoragePromise(chrome.storage.local.get(keys), {}, 'get', keys);
    } catch(e) {
      if (_isCtxInvalidated(e)) _showCtxLostBanner('storage.get failed');
      else CtLog.warn('[storage:get:sync]', e.message || e, keys);
      return Promise.resolve({});
    }
  }
  function safeStorageSet(obj) {
    try {
      return _wrapStoragePromise(chrome.storage.local.set(obj), undefined, 'set', Object.keys(obj || {}));
    } catch(e) {
      if (_isCtxInvalidated(e)) _showCtxLostBanner('storage.set failed');
      else CtLog.warn('[storage:set:sync]', e.message || e, Object.keys(obj || {}));
      return Promise.resolve();
    }
  }
  function safeStorageRemove(keys) {
    try {
      return _wrapStoragePromise(chrome.storage.local.remove(keys), undefined, 'remove', keys);
    } catch(e) {
      if (_isCtxInvalidated(e)) _showCtxLostBanner('storage.remove failed');
      else CtLog.warn('[storage:remove:sync]', e.message || e, keys);
      return Promise.resolve();
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  K线数据抓取（iframe 和父页面共用）
  // ══════════════════════════════════════════════════════════════════

  // 指标子项标签映射表（按数据窗口截图确认的顺序）
  const INDICATOR_LABELS = [
    { match: /\bmacd\b/i,              labels: ['Histogram', 'MACD', 'Signal line'] },
    { match: /\brsi\b/i,               labels: ['RSI', 'RSI-based MA'] },
    { match: /\badx\b|adx and di/i,    labels: ['DI+', 'DI-', 'ADX'] },
    { match: /\bbb\b|bollinger/i,      labels: ['Basis', 'Upper', 'Lower'] },
    { match: /stoch\s*rsi/i,           labels: ['K', 'D'] },
    { match: /vwap/i,                  labels: ['VWAP', 'Upper Band', 'Lower Band'] },
    { match: /vp\s*levels|volume\s*profile/i, labels: ['POC', 'VAH', 'VAL'] },
    { match: /成交量|volume/i,          labels: ['Volume', 'Volume MA'] },
    { match: /\batr\b/i,               labels: ['ATR'] },
    { match: /\bema\b/i,               labels: ['EMA'] },
  ];

  function getLabels(indicatorName) {
    for (const entry of INDICATOR_LABELS) {
      if (entry.match.test(indicatorName)) return entry.labels;
    }
    return null;
  }

  // 从 Binance 页面 URL 解析交易对
  // 支持：/trade/BTC_USDT、/trade/BTCUSDT、/futures/BTCUSDT、/delivery/BTCUSD_PERP
  function getSymbolFromUrl() {
    const url = window.location.href;
    // 合约页：/futures/BTCUSDT 或 /delivery/BTCUSD_PERP
    const fut = url.match(/\/(?:futures|delivery)\/([A-Z0-9_]+)/i);
    if (fut) return fut[1].replace(/_PERP$/i, '').replace(/_/g, '').toUpperCase();
    // 现货下划线格式：/trade/BTC_USDT
    const spotUnd = url.match(/\/trade\/([A-Z]{2,10})_([A-Z]{2,10})/i);
    if (spotUnd) return (spotUnd[1] + spotUnd[2]).toUpperCase();
    // 现货直连格式：/trade/BTCUSDT
    const spotDirect = url.match(/\/trade\/([A-Z]{6,14})(?:[/?#]|$)/i);
    if (spotDirect) return spotDirect[1].toUpperCase();
    return null; // URL 不匹配时返回 null，避免用错误 symbol 做价格验证
  }

  function extractTF(title) {
    const zhMatch = title.match(/([\d]+)\s*(小时|分钟)/);
    if (zhMatch) {
      const n = parseInt(zhMatch[1]);
      return zhMatch[2] === '小时' ? n + '小时' : n + '分钟';
    }
    if (/日线|1D\b/i.test(title)) return '日线';
    if (/周线|1W\b/i.test(title)) return '周线';
    const cleaned = title.replace(/Binance|OKX|Bybit|Coinbase|Kraken|Huobi|Gate\.io|Bitget|MEXC|Upbit/gi, '');
    const m = cleaned.match(/(\d+)\s*$/);
    if (!m) return '';
    const n = parseInt(m[1]);
    if (n < 60) return n+'分钟'; if (n===60) return '1小时'; if (n===120) return '2小时';
    if (n===240) return '4小时'; if (n===480) return '8小时'; if (n===1440) return '日线';
    return n+'';
  }
  function extractPair(title) {
    const m = title.match(/([A-Za-z][A-Za-z ]{1,20}?)\s*\/\s*([A-Za-z][A-Za-z ]{1,20})/);
    return m ? `${m[1].trim()}/${m[2].trim()}` : '';
  }
  function extractKline(vals) {
    // 后续会用 高>=开>=收>=低 做校验，防止 DOM 顺序变化时静默映射错误
    const filtered = vals.filter(x => /^[\d,]+\.\d{1,8}$/.test(x.v) && !x.v.includes('%'));
    if (filtered.length < 4) return null;
    const prices = filtered.map(x => ({ s: x.v, n: parseFloat(x.v.replace(/,/g, '')) }));
    const [o, h, l, c] = prices;
    // 基本合法性校验：高 >= 开/收，低 <= 开/收（DOM 数据错位时高低会反常）
    if (h.n < Math.max(o.n, l.n, c.n) || l.n > Math.min(o.n, h.n, c.n)) return null;
    return { 开: o.s, 高: h.s, 低: l.s, 收: c.s };
  }
  function cleanName(raw) {
    const fl = raw.split('\n')[0].trim();
    const nm = fl.match(/^([A-Za-z一-龥][A-Za-z一-龥 ()（）·\-_\.]*)/);
    const name = nm ? nm[1].trim() : fl;
    const nums = (fl.match(/\d+/g)||[]).filter(n => parseInt(n)<=500);
    return name + (nums.length ? ` (${nums.join(', ')})` : '');
  }
  // ── 父页面模式：Binance 主页面，注入完整 UI ──────────────────────

  // 清除上次注入残留的 timer（SPA 切换时 DOM 重建但 window 不变）
  if (window.__tvcTimer)      { clearInterval(window.__tvcTimer);      window.__tvcTimer      = null; }
  if (window.__tvcCloseTimeout)   { clearTimeout(window.__tvcCloseTimeout);    window.__tvcCloseTimeout   = null; }
  if (window.__tvcAnalyzeTimeout) { clearTimeout(window.__tvcAnalyzeTimeout);  window.__tvcAnalyzeTimeout = null; }
  window.__tvcRunning = false;

  // 清除上次注入残留的 document 级监听器（防止重复注入时叠加）
  if (window.__tvcMouseMove)   { document.removeEventListener('mousemove', window.__tvcMouseMove);   window.__tvcMouseMove   = null; }
  if (window.__tvcMouseUp)     { document.removeEventListener('mouseup',   window.__tvcMouseUp);     window.__tvcMouseUp     = null; }
  if (window.__tvcResizeMove)  { document.removeEventListener('mousemove', window.__tvcResizeMove);  window.__tvcResizeMove  = null; }
  if (window.__tvcResizeUp)    { document.removeEventListener('mouseup',   window.__tvcResizeUp);    window.__tvcResizeUp    = null; }

  if (document.getElementById('tv-claude-sidebar')) return;

  // ── 悬浮按钮 ────────────────────────────────────────────────────
  const floatBtn = document.createElement('div');
  floatBtn.id = 'tv-claude-btn';
  floatBtn.innerHTML = '🤖 Claude 分析';
  document.body.appendChild(floatBtn);

  floatBtn.addEventListener('mousedown', e => {
    let moved = false;
    const baseLeft = floatBtn.offsetLeft;
    const baseTop  = floatBtn.offsetTop;
    const bw = floatBtn.offsetWidth;
    const bh = floatBtn.offsetHeight;
    const startX = e.clientX, startY = e.clientY;
    let dx = 0, dy = 0;

    floatBtn.style.left      = baseLeft + 'px';
    floatBtn.style.top       = baseTop  + 'px';
    floatBtn.style.right     = 'auto';
    floatBtn.style.bottom    = 'auto';
    floatBtn.style.transform = 'translate(0,0)';

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999999;cursor:grabbing';
    document.body.appendChild(overlay);

    let rafId = null, latestX = startX, latestY = startY;
    overlay.addEventListener('mousemove', ev => {
      latestX = ev.clientX; latestY = ev.clientY;
      if (Math.abs(latestX - startX) > 4 || Math.abs(latestY - startY) > 4) moved = true;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const W = window.innerWidth, H = window.innerHeight;
        dx = Math.min(Math.max(-baseLeft, latestX - startX), W - baseLeft - bw);
        dy = Math.min(Math.max(-baseTop,  latestY - startY), H - baseTop  - bh);
        floatBtn.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      });
    }, { passive: true });

    const end = () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      floatBtn.style.left      = (baseLeft + dx) + 'px';
      floatBtn.style.top       = (baseTop  + dy) + 'px';
      floatBtn.style.transform = '';
      floatBtn.style.cursor    = 'grab';
      overlay.remove();
      document.removeEventListener('mouseup', end);
      // overlay 拦截了 click 事件，在这里直接判断是否为点击
      if (!moved) toggleSidebar();
    };
    document.addEventListener('mouseup', end);
  });
  // ── 面板 HTML ────────────────────────────────────────────────────
  const sidebar = document.createElement('div');
  sidebar.id = 'tv-claude-sidebar';
  sidebar.innerHTML = `
    <div class="tvc-header">
      <div class="tvc-tabs">
        <button class="tvc-tab active" data-tab="chat">对话</button>
        <button class="tvc-tab" id="tvc-clear-btn" title="清空对话" style="color:#f87171;font-size:13px;padding:3px 6px">🗑</button>
        <button class="tvc-tab" data-tab="auto">自动</button>
        <button class="tvc-tab" id="tvc-auto-clear-tab-btn" title="清空自动记录" style="color:#f87171;font-size:13px;padding:3px 6px">🗑</button>
        <button class="tvc-tab" data-tab="history">历史</button>
        <button class="tvc-tab" id="tvc-winrate-clear-btn" title="清空历史记录" style="color:#f87171;font-size:13px;padding:3px 6px">🗑</button>
        <button class="tvc-tab" data-tab="agent">Agent</button>
        <button class="tvc-tab" data-tab="winrate">胜率</button>
      </div>
      <div class="tvc-header-right">
        <select id="tvc-model-sel" title="对话模式使用的模型（自动分析的三角色模型在设置中配置）"></select>
        <button class="tvc-min" id="tvc-min" title="最小化">－</button>
        <button class="tvc-close" id="tvc-close" title="关闭">✕</button>
      </div>
    </div>

    <!-- 对话视图 -->
    <div id="tvc-chat-view">
      <div class="tvc-prompt-toggle" id="tvc-prompt-toggle">▸ 自定义提示词</div>
      <div class="tvc-prompt-wrap" id="tvc-prompt-wrap" style="display:none">
        <textarea id="tvc-prompt" placeholder="自定义提示词（留空使用默认分析提示）"></textarea>
      </div>
      <div class="tvc-kline-btns">
        <button class="tvc-kline-btn tvc-kline-btn-extract" id="tvc-btn-extract">🔍 抓取 K线数据</button>
      </div>
      <div id="tvc-messages">
        <div class="tvc-empty">抓取 K 线数据后点击「发送分析」开始</div>
      </div>
      <div id="tvc-compose">
        <div class="tvc-attach-bar" id="tvc-attach-bar"></div>
        <div class="tvc-action-row">
          <button class="tvc-send-btn" id="tvc-send-btn" disabled>发送分析 ▶</button>
          <button class="tvc-send-agents-btn" id="tvc-send-agents-btn" disabled title="使用三角色（分析师+质疑师+裁判）进行深度分析">⚡ 三角色</button>
          <button class="tvc-stop-btn" id="tvc-stop-btn" style="display:none" title="中止请求">⏹ 停止</button>
        </div>
        <div class="tvc-input-row" style="margin-top:4px">
          <button class="tvc-attach-btn" id="tvc-attach-btn" title="附加文件">＋</button>
          <textarea id="tvc-user-input" rows="2" placeholder="补充文字说明，或直接输入追问…"></textarea>
        </div>
        <input type="file" id="tvc-file-input" style="display:none" multiple accept="image/*,.txt,.md,.csv">
      </div>
    </div>

    <!-- 自动分析视图 -->
    <div id="tvc-auto-view" style="display:none">
      <!-- 顶部醒目状态条 -->
      <div id="tvc-auto-hero">
        <div id="tvc-auto-hero-dir">— 待机中</div>
        <div id="tvc-auto-hero-meta">
          <span id="tvc-auto-hero-conf"></span>
          <span id="tvc-auto-hero-analyzing">⚡ 分析中…</span>
          <span id="tvc-auto-hero-time" style="margin-left:auto"></span>
        </div>
        <div id="tvc-auto-hero-winrate" style="display:flex;align-items:center;gap:8px">
          <span id="tvc-auto-hero-wr-text"></span>
          
        </div>
      </div>
      <!-- 可滚动内容区 -->
      <div id="tvc-auto-view-scroll">
      <div class="tvc-auto-controls">

        <!-- 自定义提示词 -->
        <div class="tvc-prompt-toggle" id="tvc-auto-prompt-toggle">▸ 自定义提示词</div>
        <div class="tvc-auto-prompt-wrap" id="tvc-auto-prompt-wrap" style="display:none">
          <textarea id="tvc-auto-prompt" placeholder="自定义提示词（留空使用设置面板中的自动分析提示词）"></textarea>
        </div>

        <!-- 周期固定 1 分钟 -->
        <div class="tvc-auto-row" id="tvc-scalp-row">
          <label class="tvc-auto-label">周期</label>
          <span class="tvc-mode-fixed-label">1 分钟（固定）</span>
          <span id="tvc-kline-countdown" style="margin-left:auto;font-size:12px;color:#fbbf24;font-variant-numeric:tabular-nums;min-width:36px;text-align:right"></span>
        </div>
        <div class="tvc-auto-row">
          <div class="tvc-auto-half">
          </div>
          <div class="tvc-auto-half">
            <button class="tvc-auto-btn tvc-auto-start" id="tvc-auto-start" style="width:100%">▶ 启动自动分析</button>
            <button class="tvc-auto-btn tvc-auto-stop" id="tvc-auto-stop" style="display:none">⏹ 停止</button>
            <div class="tvc-auto-status" id="tvc-auto-status">未运行</div>
          </div>
        </div>

      </div>
      <div class="tvc-auto-result-wrap" id="tvc-auto-result-wrap" style="display:none;flex-direction:column;flex:1;overflow:hidden">
        <!-- 分析中状态条 -->
        <div id="tvc-agent-judge-status" style="display:none;font-size:11px;color:#787b86;padding:4px 8px;flex-shrink:0">⚖️ 分析中…</div>
        <!-- 元裁判徽章：平时隐藏，审计时显示 -->
        <div id="tvc-meta-judge-badge" style="display:inline-block;font-size:10px;color:#93c5fd;background:#1e3a5f;border-radius:4px;padding:2px 8px;margin:2px 8px;cursor:pointer;user-select:none" title="点击手动触发元裁判审计">📋 元裁判报告</div>
        <!-- 历史结果列表，可上滑查看 -->
        <div id="tvc-auto-result-list" style="flex:1;overflow-y:auto;padding:6px 8px;display:flex;flex-direction:column;gap:10px"></div>
      </div>
      </div>
    </div>

    <!-- 历史视图 -->
    <div id="tvc-history-view" style="display:none">
      <div class="tvc-history-subtabs">
        <button class="tvc-history-subtab active" data-htab="auto">🤖 自动</button>
        <button class="tvc-history-subtab" data-htab="manual">💬 手动</button>
      </div>
      <div class="tvc-history-filter" id="tvc-history-filter">
        <button class="tvc-history-filter-btn active" data-dir="all">全部</button>
        <button class="tvc-history-filter-btn" data-dir="bullish">📈 看涨</button>
        <button class="tvc-history-filter-btn" data-dir="bearish">📉 看跌</button>
        <button class="tvc-history-filter-btn" data-dir="neutral">👀 观望</button>
      </div>
      <div id="tvc-history-scroll">
        <div id="tvc-history-list"></div>
      </div>
    </div>

    <!-- Agent 面板 -->
    <div id="tvc-agent-view" style="display:none">
      <div id="tvc-agent-status-bar" style="display:none;padding:6px 10px;font-size:11px;color:#787b86;border-bottom:1px solid #2a2e39;display:flex;align-items:center;gap:6px">
        <span id="tvc-agent-status-text">待机中</span>
      </div>
      <!-- 固定区：变化摘要 + 截图 + K线数据（不随下方文字滚动） -->
      <div id="tvc-agent-fixed" style="flex-shrink:0;border-bottom:1px solid #2a2e39;padding:6px 10px;display:none;flex-direction:column;gap:4px">
        <!-- 变化量摘要 -->
        <div id="tvc-agent-change-wrap" style="display:none;background:#1a1f2e;border:1px solid #2a2e39;border-radius:6px;padding:6px 8px;font-size:11px;color:#787b86;white-space:pre-wrap"></div>
        <!-- K线数据（可折叠） -->
        <div id="tvc-agent-kline-toggle" style="display:none;font-size:11px;color:#4fc3f7;cursor:pointer;user-select:none;padding:2px 0">▸ 查看抓取数据</div>
        <div id="tvc-agent-kline-wrap" style="display:none;background:#131722;border:1px solid #2a2e39;border-radius:6px;padding:8px;font-size:11px;color:#787b86;white-space:pre-wrap;max-height:180px;overflow-y:auto"></div>
      </div>
      <div id="tvc-agent-scroll" style="flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:8px">
        <!-- 历史学家 -->
        <div id="tvc-agent-panel-historian" style="display:none">
          <div class="tvc-agent-label" id="tvc-agent-panel-historian-label" style="color:#a78bfa">🏛️ 历史学家 <span class="tvc-agent-spinner">●</span><span class="tvc-agent-collapse-arrow" style="margin-left:auto">▾</span></div>
          <div class="tvc-agent-body" id="tvc-agent-panel-historian-body"></div>
        </div>
        <!-- 分析师 -->
        <div id="tvc-agent-panel-analyst" style="display:none">
          <div class="tvc-agent-label" id="tvc-agent-panel-analyst-label">🔍 分析师 <span class="tvc-agent-spinner">●</span><span class="tvc-agent-collapse-arrow" style="margin-left:auto">▾</span></div>
          <div class="tvc-agent-body" id="tvc-agent-panel-analyst-body"></div>
        </div>
        <!-- 质疑师 -->
        <div id="tvc-agent-panel-critic" style="display:none">
          <div class="tvc-agent-label" id="tvc-agent-panel-critic-label">⚔️ 质疑师 <span class="tvc-agent-spinner">●</span><span class="tvc-agent-collapse-arrow" style="margin-left:auto">▾</span></div>
          <div class="tvc-agent-body" id="tvc-agent-panel-critic-body"></div>
        </div>
        <!-- 裁判 -->
        <div id="tvc-agent-panel-judge" style="display:none">
          <div class="tvc-agent-label" id="tvc-agent-panel-judge-label">⚖️ 裁判 <span class="tvc-agent-spinner">●</span><span class="tvc-agent-collapse-arrow" style="margin-left:auto">▾</span></div>
          <div class="tvc-agent-body" id="tvc-agent-panel-judge-body"></div>
        </div>
        <!-- 最终结论（裁判完成后高亮显示） -->
        <div id="tvc-agent-conclusion" style="display:none;background:#1a2a1a;border:1px solid #2a4a2a;border-radius:6px;padding:10px;font-size:13px;color:#d1d4dc;line-height:1.7"></div>
      </div>
    </div>

    <!-- 胜率面板 -->
    <div id="tvc-winrate-view" style="display:none;flex-direction:column;flex:1;overflow-y:auto;padding:10px;box-sizing:border-box;min-width:0">
      <div id="tvc-winrate-content" style="width:100%;min-width:0"></div>
    </div>`;
  document.body.appendChild(sidebar);

  // ── 状态 ────────────────────────────────────────────────────────
  let currentSessionId = null;
  let pendingKlineText = null;
  let pendingAttachments = [];
  let models = [];
  let defaultModelIdx = 0;
  let autoRunning = false;
  function getModelIdx() { return defaultModelIdx; }
  function getMsgs()     { return document.getElementById('tvc-messages'); }

  // 页面加载时重置所有自动运行状态，防止残留
  safeSendMessage({ type: 'AUTO_STOP' });

  // 从 storage 恢复顶部状态条（显示上次分析结果）
  safeStorageGet('autoSessions').then(d => {
    const sessions = d.autoSessions || [];
    if (!sessions.length) return;
    const last = sessions[0];
    const heroDir = document.getElementById('tvc-auto-hero-dir');
    const heroConf = document.getElementById('tvc-auto-hero-conf');
    const heroTime = document.getElementById('tvc-auto-hero-time');
    if (!heroDir) return;
    const confMatch = (last.result || '').match(/(?:方向置信度[：:][^\n]*?|【置信度[^】]*】[^0-9]*)(\d+)\s*[%％]/);
    const confStr = confMatch ? '置信度 ' + confMatch[1] + '%' : '';
    if (last.direction === 'bullish') { heroDir.textContent = '看涨 📈'; heroDir.className = 'bullish'; }
    else if (last.direction === 'bearish') { heroDir.textContent = '看跌 📉'; heroDir.className = 'bearish'; }
    else { heroDir.textContent = '观望 👀'; heroDir.className = 'neutral'; }
    if (heroConf) heroConf.textContent = confStr;
    if (heroTime) heroTime.textContent = last.time || '';
  }).catch(e => CtLog.warn('[heroBar:loadStored]', e.message || e));

  // ── 胜率统计函数：见 winrate-calc.js（共享模块） ─────────────────
  // 由 manifest content_scripts 先于 content.js 加载，挂在 self.WinRateCalc
  const WR = self.WinRateCalc || {};
  const _calcWR    = WR.calcWinRate || (() => null);
  const _calcCondWR = WR.calcConditionalWinRate || (() => ({}));
  if (!self.WinRateCalc) CtLog.warn('[boot]', 'winrate-calc.js 未加载，胜率统计将退化');

  function updateWinRate(sessions) {
    const el = document.getElementById('tvc-auto-hero-wr-text');
    if (!el) return;
    const wrJudge   = _calcWR(sessions, 'direction',        'verifyResult',        20);
    const wrAnalyst = _calcWR(sessions, 'analystDirection', 'analystVerifyResult', 20);
    // 统计有 analystDirection 但还没验证结果的数量，用于显示"待验证"
    const analystPending = sessions.filter(s => s.analystDirection && s.analystDirection !== 'neutral' && !s.analystVerifyResult).length;
    const fmt = (wr, label) => {
      if (!wr) return '';
      const icon = wr.pct >= 60 ? '🔥' : wr.pct < 40 ? '⚠️' : '';
      return label + ' ' + wr.pct + '%' + (icon ? icon : '');
    };
    const parts = [];
    if (wrAnalyst) parts.push(fmt(wrAnalyst, '析'));
    else if (analystPending > 0) parts.push('析 待验证(' + analystPending + ')');
    if (wrJudge) parts.push(fmt(wrJudge, '裁'));
    el.textContent = parts.join(' · ');
  }

  // ── 胜率面板渲染 ─────────────────────────────────────────────────
  // 倒计时定时器句柄，切换面板时清除
  let _winrateCountdownTimer = null;

  function _fmtVerifyMin(ms) {
    // 将毫秒期限转为显示字符串：5M / 1H / 2H 等
    const m = Math.round(ms / 60000);
    if (m < 60) return m + 'M';
    const h = Math.round(m / 60);
    return h + 'H';
  }

  function _fmtPrice(p) {
    if (!p && p !== 0) return '—';
    return '$' + Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _fmtTime(idOrTs) {
    // session.id 可能是 'a-1234567890' 或 'm-1234567890'，需先剥离前缀再 parseInt
    const raw = typeof idOrTs === 'string' ? idOrTs.replace(/^[a-z]+-/, '') : idOrTs;
    const d = new Date(parseInt(raw));
    if (isNaN(d.getTime())) return '--:--';
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function _countdown(verifyAt) {
    const diff = verifyAt - Date.now();
    if (diff <= 0) return null; // 已到期
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return m + ':' + s.toString().padStart(2, '0');
  }

  // 距下一根K线收盘的倒计时（基于当前周期间隔）
  function _nextKlineCountdown(intervalMin) {
    // 用 Binance WebSocket 推送的 closeTime 倒计时，对齐服务器时间
    const buf = _bnBuffers && _bnBuffers['1m'];
    if (buf && buf.length > 0) {
      const latest = buf[buf.length - 1];
      if (latest) {
        // latest.T：WebSocket实时推送有此字段（服务器closeTime）
        // 历史REST数据无T字段，用 t + intervalMs - 1 补算（t是openTime）
        const intervalMs = intervalMin * 60 * 1000;
        const closeTime = latest.T != null ? latest.T : (latest.t + intervalMs - 1);
        const remaining = Math.max(0, closeTime - (Date.now() + _serverTimeOffset));
        const totalSec = Math.ceil(remaining / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return m + ':' + s.toString().padStart(2, '0');
      }
    }
    // 降级：buffer尚未就绪时用本地时间估算
    const now = new Date();
    const totalSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const intervalSec = intervalMin * 60;
    const remaining = intervalSec - (totalSec % intervalSec);
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    return m + ':' + s.toString().padStart(2, '0');
  }

  async function renderWinRatePanel() {
    const el = document.getElementById('tvc-winrate-content');
    if (!el) return;

    // 清除旧倒计时
    if (_winrateCountdownTimer) { clearInterval(_winrateCountdownTimer); _winrateCountdownTimer = null; }

    // 立即刷新周期倒计时（面板打开时即时显示，不等1秒）
    const data = await safeStorageGet(['autoSessions', 'enhancements']);
    const sessions = data.autoSessions || [];

    // v3.8: 档位系统已删除，只显示待验证数
    const _pendingCount = sessions.filter(s => s.direction && s.direction !== 'neutral' && !s.verifyResult && s.verifyAt).length;
    const _totalNonNeutral = sessions.filter(s => s.direction && s.direction !== 'neutral').length;

    // v3.15 观望踏空率：观望后价格单边走了(本可盈利却踏空)的比例
    const _watched = sessions.filter(s => s.watchResult === 'miss' || s.watchResult === 'correct');
    const _missCnt = _watched.filter(s => s.watchResult === 'miss').length;
    const _missRate = _watched.length >= 5 ? Math.round(_missCnt / _watched.length * 100) : null;
    const _missColor = _missRate == null ? '#4a4e5a' : _missRate >= 50 ? '#f87171' : _missRate <= 20 ? '#4ade80' : '#fbbf24';
    const _missStr = _missRate == null ? '' : ' &nbsp;|&nbsp; <span style="color:' + _missColor + '">观望踏空率 ' + _missRate + '%(' + _missCnt + '/' + _watched.length + ')</span>';

    const _profileBadge = '<div style="display:flex;justify-content:flex-end;align-items:center;background:#12151e;border:1px solid #2a2e39;border-radius:6px;padding:5px 8px;margin-bottom:8px;font-size:11px">'
      + '<span style="color:#4a4e5a">⏳ ' + _pendingCount + ' 待验证 &nbsp;|&nbsp; 共 ' + _totalNonNeutral + ' 笔' + _missStr + '</span>'
      + '</div>';

    if (!sessions.length) {
      // 只有面板本身也是空的时候才显示"暂无记录"
      // 若已有内容，说明是后台写入中途/SW重启导致的瞬间空读，保留上次内容不覆盖
      if (!el.innerHTML || el.innerHTML.includes('暂无记录')) {
        el.innerHTML = _profileBadge + '<div style="color:#4a4e5a;font-size:13px;text-align:center;padding:36px 0">暂无记录</div>';
      }
      return;
    }

    // 总胜率（最近50条已验证）
    const wrA = _calcWR(sessions, 'analystDirection', 'analystVerifyResult', 50);
    const wrJ = _calcWR(sessions, 'direction',        'verifyResult',        50);

    // 条件胜率（按市场状态分组）
    const condA = _calcCondWR(sessions, 'analystDirection', 'analystVerifyResult');
    const condJ = _calcCondWR(sessions, 'direction',        'verifyResult');

    function fmtWr(wr, label, color) {
      if (!wr) return '<div style="flex:1;background:#12151e;border:1px solid #2a2e39;border-radius:6px;padding:5px 8px;text-align:center">'
        + '<div style="font-size:10px;color:#4a4e5a">' + label + '</div>'
        + '<div style="font-size:13px;color:#4a4e5a">—</div></div>';
      const icon = wr.pct >= 60 ? '🔥' : wr.pct < 40 ? '⚠️' : '';
      return '<div style="flex:1;background:#12151e;border:1px solid #2a2e39;border-radius:6px;padding:5px 8px;text-align:center">'
        + '<div style="font-size:10px;color:#787b86">' + label + '</div>'
        + '<div style="font-size:16px;font-weight:800;color:' + color + '">' + wr.pct + '%' + (icon ? icon : '') + '</div>'
        + '<div style="font-size:10px;color:#4a4e5a">' + wr.wins + '/' + wr.total + '</div></div>';
    }

    // 勾选框状态（已移除过滤器，始终显示全部）

    // ── 幅度感知PnL汇总（近20条已验证记录）──────────────────────────
    function calcPnlSummary(sessArr, pnlKey) {
      const valid = sessArr.filter(s => s[pnlKey] != null).slice(0, 20);
      if (valid.length < 3) return null;
      const wins  = valid.filter(s => s[pnlKey] > 0);
      const loses = valid.filter(s => s[pnlKey] <= 0);
      const avgWin  = wins.length  ? wins.reduce((a,b)=>a+b[pnlKey],0)  / wins.length  * 100 : null;
      const avgLoss = loses.length ? loses.reduce((a,b)=>a+b[pnlKey],0) / loses.length * 100 : null;
      const cumPnl  = valid.reduce((a,b)=>a+b[pnlKey],0) * 100;
      const rr = (avgWin && avgLoss && avgLoss !== 0) ? Math.abs(avgWin / avgLoss) : null;
      return { n: valid.length, avgWin, avgLoss, cumPnl, rr };
    }
    const pnlJ = calcPnlSummary(sessions, 'realPnl');
    const pnlA = calcPnlSummary(sessions, 'analystRealPnl');

    function fmtPnl(p, label, color) {
      if (!p) return '';
      const cumColor = p.cumPnl >= 0 ? '#4ade80' : '#f87171';
      const cumSign  = p.cumPnl >= 0 ? '+' : '';
      return '<div style="flex:1;background:#12151e;border:1px solid #2a2e39;border-radius:6px;padding:5px 8px">'
        + '<div style="font-size:10px;color:#787b86;margin-bottom:2px">' + label + ' 幅度（近' + p.n + '次）</div>'
        + '<div style="display:flex;justify-content:space-between;font-size:11px">'
        + (p.avgWin  != null ? '<span style="color:#4ade80">均盈+' + p.avgWin.toFixed(2)  + '%</span>' : '')
        + (p.avgLoss != null ? '<span style="color:#f87171">均亏' + p.avgLoss.toFixed(2) + '%</span>' : '')
        + (p.rr      != null ? '<span style="color:#fbbf24">RR ' + p.rr.toFixed(2) + '</span>' : '')
        + '</div>'
        + '<div style="font-size:12px;font-weight:700;color:' + cumColor + ';margin-top:2px">累计 ' + cumSign + p.cumPnl.toFixed(3) + '%</div>'
        + '</div>';
    }

    function buildHTML() {
      // v3.2: 顶部档位徽章（已在 renderWinRatePanel 构建）
      let html = _profileBadge;

      // 总胜率（紧凑）
      html += '<div style="display:flex;gap:6px;margin-bottom:8px">'
        + fmtWr(wrA, '分析师总胜率', '#4fc3f7')
        + fmtWr(wrJ, '裁判总胜率',   '#4ade80')
        + '</div>';

      // 幅度感知PnL汇总（有数据才显示）
      if (pnlJ || pnlA) {
        html += '<div style="display:flex;gap:6px;margin-bottom:8px">'
          + fmtPnl(pnlA, '分析师', '#4fc3f7')
          + fmtPnl(pnlJ, '裁判',   '#4ade80')
          + '</div>';
      }

      // 条件胜率块（按市场状态）
      const hasCondData = Object.keys(condA).length > 0 || Object.keys(condJ).length > 0;
      if (hasCondData) {
        function fmtCell(cond, state) {
          const v = cond[state];
          if (!v) return '<div style="text-align:center;color:#4a4e5a;font-size:11px">—</div>';
          const color = v.pct >= 60 ? '#4ade80' : v.pct < 40 ? '#f87171' : '#d1d4dc';
          const icon  = v.pct >= 60 ? '🔥' : v.pct < 40 ? '⚠️' : '';
          return '<div style="text-align:center">'
            + '<span style="font-size:12px;font-weight:700;color:' + color + '">' + v.pct + '%' + icon + '</span>'
            + '<br><span style="font-size:9px;color:#4a4e5a">' + v.wins + '/' + v.total + '</span></div>';
        }
        html += '<div style="background:#12151e;border:1px solid #2a2e39;border-radius:6px;padding:6px 8px;margin-bottom:8px">'
          + '<div style="font-size:10px;color:#787b86;margin-bottom:5px">条件胜率（按市场状态）</div>'
          + '<div style="display:grid;grid-template-columns:44px 1fr 1fr 1fr;gap:4px;align-items:center">'
          + '<div></div>'
          + '<div style="text-align:center;font-size:10px;color:#787b86">趋势</div>'
          + '<div style="text-align:center;font-size:10px;color:#787b86">震荡</div>'
          + '<div style="text-align:center;font-size:10px;color:#787b86">不明</div>'
          + '<div style="font-size:10px;color:#4fc3f7">分析师</div>'
          + fmtCell(condA, '趋势') + fmtCell(condA, '震荡') + fmtCell(condA, '不明')
          + '<div style="font-size:10px;color:#4ade80">裁判</div>'
          + fmtCell(condJ, '趋势') + fmtCell(condJ, '震荡') + fmtCell(condJ, '不明')
          + '</div></div>';
      }

      // v3.9: 质疑师风险评级准确性统计已删除

      // 流水账列表：先过滤出有方向的记录，再取最近20条（观望不显示）
      const rows = sessions.filter(s => {
        const hasA = s.analystDirection && s.analystDirection !== 'neutral';
        const hasJ = s.direction        && s.direction        !== 'neutral';
        return hasA || hasJ;
      }).slice(0, 20);
      for (const s of rows) {
        const showAnalyst = s.analystDirection && s.analystDirection !== 'neutral';
        const showJudge   = s.direction        && s.direction        !== 'neutral';

        const timeStr  = _fmtTime(s.id);
        const priceStr = _fmtPrice(s.closedPrice);

        // 市场状态
        const _ms    = s.marketState || '不明';
        const _msClr = _ms === '趋势' ? '#4fc3f7' : _ms === '震荡' ? '#fbbf24' : '#4a4e5a';
        const _msBadge = '<span style="color:' + _msClr + ';font-size:9px;border:1px solid ' + _msClr + ';border-radius:3px;padding:0 2px;flex-shrink:0">' + _ms + '</span>';

        let judgeFieldsHtml = '';
        if (showJudge) {
          const verifyMs    = s.verifyAt ? s.verifyAt - s.dataTimestamp : null;
          const limitStr    = verifyMs ? _fmtVerifyMin(verifyMs) : '—';
          const dirIcon     = s.direction === 'bullish' ? '看涨' : s.direction === 'bearish' ? '看跌' : '观望';
          const dirColor    = s.direction === 'bullish' ? '#4ade80' : '#f87171';
          const cd          = s.verifyAt && !s.verifyResult ? _countdown(s.verifyAt) : null;
          const resultStr   = !s.verifyAt && !s.verifyResult ? '—' : s.verifyResult === 'win' ? '✔️' : s.verifyResult === 'loss' ? '❌' : s.verifyResult === 'terminated' ? '—' : '⏳';
          const resultColor = !s.verifyAt && !s.verifyResult ? '#4a4e5a' : s.verifyResult === 'win' ? '#4ade80' : s.verifyResult === 'loss' ? '#f87171' : s.verifyResult === 'terminated' ? '#4a4e5a' : '#fbbf24';
          judgeFieldsHtml = '<div style="display:flex;align-items:center;gap:4px;font-size:11px;padding:1px 0;min-width:0;overflow:hidden" data-verify-at="' + (s.verifyAt||'') + '" data-result="' + (s.verifyResult||'') + '" data-role="judge">'
            + _msBadge
            + '<span style="color:#a0a0a0;min-width:22px;flex-shrink:0">' + limitStr + '</span>'
            + '<span style="color:#fbbf24;min-width:32px;flex-shrink:0" data-countdown="judge-' + s.id + '">' + (cd ? cd : '') + '</span>'
            + '<span style="color:#d1d4dc;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">' + _fmtPrice(s.verifyPrice) + '</span>'
            + (s.realPnl != null ? '<span style="color:' + (s.realPnl>=0?'#4ade80':'#f87171') + ';font-size:10px;flex-shrink:0">' + (s.realPnl>=0?'+':'') + (s.realPnl*100).toFixed(2) + '%</span>' : '<span style="min-width:38px;flex-shrink:0"></span>')
            + '<span style="flex:1"></span>'
            + '<span style="color:' + dirColor + ';min-width:28px;flex-shrink:0;text-align:right">' + dirIcon + '</span>'
            + '<span style="color:' + resultColor + ';font-weight:700;flex-shrink:0">' + resultStr + '</span>'
            + '</div>';
        }

        let analystFieldsHtml = '';
        if (showAnalyst) {
          const aVerifyMs    = s.analystVerifyAt ? s.analystVerifyAt - s.dataTimestamp : null;
          const aLimitStr    = aVerifyMs ? _fmtVerifyMin(aVerifyMs) : '—';
          const aDirIcon     = s.analystDirection === 'bullish' ? '看涨' : s.analystDirection === 'bearish' ? '看跌' : '观望';
          const aDirColor    = s.analystDirection === 'bullish' ? '#4ade80' : '#f87171';
          const acd          = s.analystVerifyAt && !s.analystVerifyResult ? _countdown(s.analystVerifyAt) : null;
          const aResultStr   = !s.analystVerifyAt && !s.analystVerifyResult ? '—' : s.analystVerifyResult === 'win' ? '✔️' : s.analystVerifyResult === 'loss' ? '❌' : s.analystVerifyResult === 'terminated' ? '—' : '⏳';
          const aResultColor = !s.analystVerifyAt && !s.analystVerifyResult ? '#4a4e5a' : s.analystVerifyResult === 'win' ? '#4ade80' : s.analystVerifyResult === 'loss' ? '#f87171' : s.analystVerifyResult === 'terminated' ? '#4a4e5a' : '#fbbf24';
          analystFieldsHtml = '<div style="display:flex;align-items:center;gap:4px;font-size:11px;padding:1px 0;min-width:0;overflow:hidden" data-verify-at="' + (s.analystVerifyAt||'') + '" data-result="' + (s.analystVerifyResult||'') + '" data-role="analyst">'
            + _msBadge
            + '<span style="color:#a0a0a0;min-width:22px;flex-shrink:0">' + aLimitStr + '</span>'
            + '<span style="color:#fbbf24;min-width:32px;flex-shrink:0" data-countdown="analyst-' + s.id + '">' + (acd ? acd : '') + '</span>'
            + '<span style="color:#d1d4dc;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">' + _fmtPrice(s.analystVerifyPrice) + '</span>'
            + (s.analystRealPnl != null ? '<span style="color:' + (s.analystRealPnl>=0?'#4ade80':'#f87171') + ';font-size:10px;flex-shrink:0">' + (s.analystRealPnl>=0?'+':'') + (s.analystRealPnl*100).toFixed(2) + '%</span>' : '<span style="min-width:38px;flex-shrink:0"></span>')
            + '<span style="flex:1"></span>'
            + '<span style="color:' + aDirColor + ';min-width:28px;flex-shrink:0;text-align:right">' + aDirIcon + '</span>'
            + '<span style="color:' + aResultColor + ';font-weight:700;flex-shrink:0">' + aResultStr + '</span>'
            + '</div>';
        }

        html += '<div style="background:#1a1f2e;border:1px solid #2a2e39;border-radius:6px;padding:5px 8px;margin-bottom:5px;cursor:pointer;display:flex;align-items:center;gap:0;min-width:0;overflow:hidden" data-session-id="' + s.id + '">'
          + '<div style="flex-shrink:0;width:28px;margin-right:6px">'
          + (showJudge   ? '<div style="font-size:11px;font-weight:700;color:#4ade80;padding:1px 0">裁判</div>' : '')
          + (showAnalyst ? '<div style="font-size:11px;font-weight:700;color:#4fc3f7;padding:1px 0">分析</div>' : '')
          + '</div>'
          + '<div style="text-align:center;padding:0 8px;border-left:1px solid #2a2e39;border-right:1px solid #2a2e39;margin-right:8px;flex-shrink:0;min-width:60px">'
          + '<div style="font-size:11px;color:#787b86">' + timeStr + '</div>'
          + '<div style="font-size:11px;color:#d1d4dc;margin-top:1px">' + priceStr + '</div>'
          + '</div>'
          + '<div style="flex:1">' + judgeFieldsHtml + analystFieldsHtml + '</div>'
          + '</div>';
      }

      return html;
    }

    el.innerHTML = buildHTML();

    function startCountdown() {
      if (_winrateCountdownTimer) clearInterval(_winrateCountdownTimer);
      _winrateCountdownTimer = setInterval(() => {
        const spans = el.querySelectorAll('[data-countdown]');
        // 用 content.js 自己的运行标志判断
        let anyPending = window.__tvcRunning;
        spans.forEach(span => {
          const row = span.closest('[data-verify-at]');
          if (!row) return;
          const verifyAt = parseInt(row.getAttribute('data-verify-at'));
          const result   = row.getAttribute('data-result');
          if (result) return;
          if (!verifyAt) return;
          const cd = _countdown(verifyAt);
          if (cd) {
            span.textContent = cd;
            anyPending = true;
          } else {
            span.textContent = '';
            safeSendMessage({ type: 'TRIGGER_VERIFY' });
            if (!window.__tvcVerifyRefreshPending) {
              window.__tvcVerifyRefreshPending = true;
              setTimeout(() => {
                window.__tvcVerifyRefreshPending = false;
                renderWinRatePanel();
              }, 8000);
            }
          }
        });
        if (!anyPending) { clearInterval(_winrateCountdownTimer); _winrateCountdownTimer = null; }
      }, 1000);
    }

    startCountdown();

    el.querySelectorAll('[data-session-id]').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('input')) return;
        const sessionId = card.getAttribute('data-session-id');
        if (!sessionId) return;

        const historyTabBtn = sidebar.querySelector('.tvc-tab[data-tab="history"]');
        if (!historyTabBtn) return;
        sidebar.querySelectorAll('.tvc-tab[data-tab]').forEach(t => t.classList.remove('active'));
        historyTabBtn.classList.add('active');
        document.getElementById('tvc-chat-view').style.display    = 'none';
        document.getElementById('tvc-auto-view').style.display    = 'none';
        document.getElementById('tvc-history-view').style.display = 'flex';
        document.getElementById('tvc-agent-view').style.display   = 'none';
        document.getElementById('tvc-winrate-view').style.display = 'none';

        historyTab = 'auto';
        document.querySelectorAll('.tvc-history-subtab').forEach(t => {
          t.classList.toggle('active', t.dataset.htab === 'auto');
        });
        const filterEl = document.getElementById('tvc-history-filter');
        if (filterEl) filterEl.style.display = 'flex';

        renderHistory().then(() => {
          const target = document.querySelector('.tvc-auto-history-item[data-auto-id="' + sessionId + '"]');
          if (!target) return;
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.style.outline = '1px solid #4fc3f7';
          setTimeout(() => { target.style.outline = ''; }, 1200);
        });
      });
    });
  }

  function toggleSidebar() {
    sidebar.classList.toggle('open');
    floatBtn.classList.toggle('active', sidebar.classList.contains('open'));
    if (sidebar.classList.contains('open')) loadSettings();
  }

  async function loadSettings() {
    const data = await safeStorageGet(['models', 'defaultModel', 'lastModelIdx', 'autoPromptTemp']);
    models = data.models || [];
    defaultModelIdx = (data.lastModelIdx !== undefined) ? data.lastModelIdx : (data.defaultModel || 0);
    if (defaultModelIdx >= models.length) defaultModelIdx = data.defaultModel || 0;
    renderModelSel();
    if (data.autoPromptTemp) {
      document.getElementById('tvc-auto-prompt').value = data.autoPromptTemp;
    }
  }

  function renderModelSel() {
    const sel = document.getElementById('tvc-model-sel');
    if (!models.length) { sel.innerHTML = '<option>— 请先配置模型 —</option>'; return; }
    sel.innerHTML = models.map((m, i) =>
      '<option value="' + i + '" ' + (i === defaultModelIdx ? 'selected' : '') + '>' + m.name + '</option>'
    ).join('');
    sel.value = defaultModelIdx;
  }

  document.getElementById('tvc-model-sel').addEventListener('change', e => {
    defaultModelIdx = +e.target.value;
    chrome.storage.local.set({ lastModelIdx: defaultModelIdx });
  });
  document.getElementById('tvc-min').addEventListener('click', () => { sidebar.classList.toggle('minimized'); });
  document.getElementById('tvc-close').addEventListener('click', () => {
    sidebar.classList.remove('open');
    sidebar.style.display = '';  // 清除可能残留的内联样式
    floatBtn.classList.remove('active');
  });

  // 清空对话
  document.getElementById('tvc-clear-btn').addEventListener('click', () => {
    currentSessionId = null;
    pendingKlineText = null; pendingAttachments = [];
    streamingDiv = null; streamingText = '';
    getMsgs().innerHTML = '<div class="tvc-empty">抓取 K 线数据后点击「发送分析」开始</div>';
    document.getElementById('tvc-user-input').value = '';
    document.getElementById('tvc-attach-bar').innerHTML = '';
    document.getElementById('tvc-prompt-wrap').style.display = 'none';
    document.getElementById('tvc-prompt-toggle').textContent = '▸ 自定义提示词';
    document.getElementById('tvc-prompt').value = '';
    updateSendState();
  });

  // ── Tab 切换 ─────────────────────────────────────────────────────
  sidebar.querySelectorAll('.tvc-tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      sidebar.querySelectorAll('.tvc-tab[data-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tvc-chat-view').style.display    = tab.dataset.tab === 'chat'    ? 'flex' : 'none';
      document.getElementById('tvc-auto-view').style.display    = tab.dataset.tab === 'auto'    ? 'flex' : 'none';
      document.getElementById('tvc-history-view').style.display = tab.dataset.tab === 'history' ? 'flex' : 'none';
      document.getElementById('tvc-agent-view').style.display   = tab.dataset.tab === 'agent'   ? 'flex' : 'none';
      document.getElementById('tvc-winrate-view').style.display = tab.dataset.tab === 'winrate' ? 'flex' : 'none';
      if (tab.dataset.tab === 'history') {
        const filterEl = document.getElementById('tvc-history-filter');
        if (filterEl) filterEl.style.display = historyTab === 'auto' ? 'flex' : 'none';
        renderHistory();
      }
      if (tab.dataset.tab === 'auto') refreshAutoResult();
      if (tab.dataset.tab === 'winrate') renderWinRatePanel();
    });
  });

  // ── 后台→前台时强制重渲倒计时 ─────────────────────────────────────
  // 浏览器在标签后台/合上盖子后 setInterval 会被节流甚至冻结，回到前台时
  // 倒计时数值滞后。绝对时间戳保证数据是对的，但 UI 不会立即刷新；
  // 这里在页面重新可见时强制触发对应面板的重渲，避免用户看到旧的数字。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const winrateView = document.getElementById('tvc-winrate-view');
      if (winrateView && winrateView.style.display !== 'none') {
        renderWinRatePanel();
      }
      const autoView = document.getElementById('tvc-auto-view');
      if (autoView && autoView.style.display !== 'none') {
        refreshAutoResult().catch(e => CtLog.warn('[visibilitychange:autoRefresh]', e.message || e));
      }
    } catch(e) {
      CtLog.warn('[visibilitychange]', e.message || e);
    }
  });

  document.getElementById('tvc-prompt-toggle').addEventListener('click', () => {
    const wrap = document.getElementById('tvc-prompt-wrap');
    const tog  = document.getElementById('tvc-prompt-toggle');
    const open = wrap.style.display !== 'none';
    wrap.style.display = open ? 'none' : 'block';
    tog.textContent = (open ? '▸' : '▾') + ' 自定义提示词';
  });

  // ── 拖动面板 ──────────────────────────────────────────────────────
  let dragBaseLeft = 0, dragBaseTop = 0;
  let dragStartX = 0, dragStartY = 0;
  let dragDx = 0, dragDy = 0;
  let dragRafId = null;
  let dragLatestX = 0, dragLatestY = 0;

  function _isDragTarget(el) {
    if (!el.closest('.tvc-header')) return false;
    const tag = el.tagName;
    return !(tag === 'BUTTON' || tag === 'SELECT' || tag === 'INPUT' ||
             tag === 'TEXTAREA' || tag === 'A' || tag === 'LABEL');
  }

  sidebar.addEventListener('mousedown', e => {
    if (!_isDragTarget(e.target)) return;
    if (e.target.classList && e.target.classList.contains('tvc-resize-handle')) return;

    const cW = sidebar.offsetWidth;
    const cH = sidebar.offsetHeight;
    dragBaseLeft = sidebar.offsetLeft;
    dragBaseTop  = sidebar.offsetTop;
    dragStartX   = e.clientX;
    dragStartY   = e.clientY;
    dragDx = 0; dragDy = 0;
    dragLatestX  = e.clientX;
    dragLatestY  = e.clientY;

    sidebar.style.left      = dragBaseLeft + 'px';
    sidebar.style.top       = dragBaseTop  + 'px';
    sidebar.style.right     = 'auto';
    sidebar.style.transform = 'translate(0,0)';

    let dragStarted = false;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
                            'z-index:999999;cursor:grabbing;user-select:none';

    const onDragMove = ev => {
      dragLatestX = ev.clientX; dragLatestY = ev.clientY;
      if (!dragStarted) {
        if (Math.abs(dragLatestX - dragStartX) > 4 || Math.abs(dragLatestY - dragStartY) > 4) {
          dragStarted = true;
          document.body.appendChild(overlay);
          sidebar.style.pointerEvents = 'none';
        } else { return; }
      }
      if (dragRafId) return;
      dragRafId = requestAnimationFrame(() => {
        dragRafId = null;
        const W = window.innerWidth, H = window.innerHeight;
        dragDx = Math.min(Math.max(-dragBaseLeft, dragLatestX - dragStartX), W - dragBaseLeft - cW);
        dragDy = Math.min(Math.max(-dragBaseTop,  dragLatestY - dragStartY), H - dragBaseTop  - cH);
        sidebar.style.transform = 'translate(' + dragDx + 'px,' + dragDy + 'px)';
      });
    };

    const endDrag = () => {
      if (dragRafId) { cancelAnimationFrame(dragRafId); dragRafId = null; }
      if (dragStarted) {
        sidebar.style.left          = (dragBaseLeft + dragDx) + 'px';
        sidebar.style.top           = (dragBaseTop  + dragDy) + 'px';
        sidebar.style.transform     = '';
        sidebar.style.pointerEvents = '';
        overlay.remove();
      }
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', endDrag);
    };

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', endDrag);
  });

  // ── 四边 resize handle ────────────────────────────────────────
  const RESIZE_DIRS = ['n','s','w','e','nw','ne','sw','se'];
  RESIZE_DIRS.forEach(dir => {
    const h = document.createElement('div');
    h.className = 'tvc-resize-handle ' + dir;
    h.dataset.dir = dir;
    sidebar.appendChild(h);
  });

  const RS_MIN_W = 300, RS_MIN_H = 300;
  const cursorMap = { n:'n-resize',s:'s-resize',w:'w-resize',e:'e-resize',
                      nw:'nw-resize',ne:'ne-resize',sw:'sw-resize',se:'se-resize' };

  sidebar.addEventListener('mousedown', e => {
    const handle = e.target.closest('.tvc-resize-handle');
    if (!handle) return;
    e.stopPropagation(); e.preventDefault();

    const dir    = handle.dataset.dir;
    const startX = e.clientX, startY = e.clientY;
    const startW = sidebar.offsetWidth,  startH = sidebar.offsetHeight;
    const startL = sidebar.offsetLeft,   startT = sidebar.offsetTop;
    sidebar.style.right = 'auto';

    let rsRafId = null, rsLatestX = startX, rsLatestY = startY;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
                            'z-index:999999;cursor:' + (cursorMap[dir] || 'nwse-resize') +
                            ';user-select:none';
    document.body.appendChild(overlay);
    sidebar.style.pointerEvents = 'none';

    overlay.addEventListener('mousemove', ev => {
      rsLatestX = ev.clientX; rsLatestY = ev.clientY;
      if (rsRafId) return;
      rsRafId = requestAnimationFrame(() => {
        rsRafId = null;
        const dx = rsLatestX - startX, dy = rsLatestY - startY;
        let newW = startW, newH = startH, newL = startL, newT = startT;
        if (dir.includes('e')) newW = Math.max(RS_MIN_W, startW + dx);
        if (dir.includes('s')) newH = Math.max(RS_MIN_H, startH + dy);
        if (dir.includes('w')) { newW = Math.max(RS_MIN_W, startW - dx); newL = startL + startW - newW; }
        if (dir.includes('n')) { newH = Math.max(RS_MIN_H, startH - dy); newT = startT + startH - newH; }
        sidebar.style.width  = newW + 'px';
        sidebar.style.height = newH + 'px';
        sidebar.style.left   = newL + 'px';
        sidebar.style.top    = newT + 'px';
      });
    }, { passive: true });

    const endResize = () => {
      if (rsRafId) { cancelAnimationFrame(rsRafId); rsRafId = null; }
      sidebar.style.pointerEvents = '';
      overlay.remove();
      document.removeEventListener('mouseup', endResize);
    };
    document.addEventListener('mouseup', endResize);
  });

  // ── Agent 折叠/展开 ──────────────────────────────────────────────
  sidebar.addEventListener('click', e => {
    const label = e.target.closest('.tvc-agent-label');
    if (!label) return;
    const body = label.nextElementSibling;
    if (!body || !body.classList.contains('tvc-agent-body')) return;
    const arrow = label.querySelector('.tvc-agent-collapse-arrow');
    const collapsed = body.classList.toggle('collapsed');
    if (arrow) arrow.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
  });

  // ── Agent 面板 K线数据折叠 ────────────────────────────────────────
  const agentKlineToggle = document.getElementById('tvc-agent-kline-toggle');
  const agentKlineWrap   = document.getElementById('tvc-agent-kline-wrap');
  if (agentKlineToggle) agentKlineToggle.addEventListener('click', () => {
    const open = agentKlineWrap.style.display !== 'none';
    agentKlineWrap.style.display = open ? 'none' : 'block';
    agentKlineToggle.textContent = open ? '▸ 查看抓取数据' : '▾ 收起抓取数据';
  });

  function setPendingKline(text) {
    pendingKlineText = text;
    updateSendState();
  }

  function clearPendingKline(klineEl) {
    pendingKlineText = null;
    if (klineEl) {
      const card = klineEl.closest('.tvc-card');
      if (card && card.querySelectorAll('.tvc-msg-screenshot, .tvc-msg-kline-wrap').length === 1) card.remove();
      else klineEl.remove();
    }
    updateSendState();
  }

  function updateSendState() {
    const has = !!(pendingKlineText || pendingAttachments.length
      || document.getElementById('tvc-user-input').value.trim() || currentSessionId);
    document.getElementById('tvc-send-btn').disabled = !has;
    // 三角色按钮：仅在有K线数据时可用
    const hasData = !!(pendingKlineText);
    const agentsBtn = document.getElementById('tvc-send-agents-btn');
    if (agentsBtn) agentsBtn.disabled = !hasData || isChatAgents || isSending;
  }

  // ── 消息渲染 ─────────────────────────────────────────────────────
  function clearEmpty() {
    const e = getMsgs().querySelector('.tvc-empty');
    if (e) e.remove();
  }

  function scrollBottom() {
    const m = getMsgs();
    requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
  }

  function createCard() {
    clearEmpty();
    const card = document.createElement('div');
    card.className = 'tvc-card';
    getMsgs().appendChild(card);
    scrollBottom();
    return card;
  }

  function getLatestCard() {
    const cards = getMsgs().querySelectorAll('.tvc-card');
    if (cards.length) return cards[cards.length - 1];
    return createCard();
  }

  function appendKlineBubble(text) {
    const card = createCard();
    const wrap = document.createElement('div');
    wrap.className = 'tvc-msg-kline-wrap tvc-pending-item';
    const div = document.createElement('div');
    div.className = 'tvc-msg-kline';
    div.textContent = text;
    const btn = document.createElement('button');
    btn.className = 'tvc-item-close'; btn.textContent = '✕'; btn.title = '删除';
    btn.addEventListener('click', () => clearPendingKline(wrap));
    wrap.appendChild(btn); wrap.appendChild(div);
    card.appendChild(wrap);
    scrollBottom();
  }

  function appendError(msg) {
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'tvc-error';
    div.textContent = '✗ ' + msg;
    getMsgs().appendChild(div);
    scrollBottom();
  }

  function appendUserMsg(text, attNames) {
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'tvc-msg-user';
    let html = '';
    if (attNames?.length) html += attNames.map(n => `<span class="tvc-att-chip-inline">📎 ${n}</span>`).join('');
    if (text) html += (html ? '<br>' : '') + escHtml(text);
    div.innerHTML = html;
    getLatestCard().appendChild(div);
    scrollBottom();
  }

  function appendAssistantMsg(text) {
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'tvc-msg-assistant';
    div.innerHTML = formatAssistant(text);
    getLatestCard().appendChild(div);
    scrollBottom();
    return div;
  }

  function appendLoading() {
    const div = document.createElement('div');
    div.className = 'tvc-loading';
    div.innerHTML = '<div class="tvc-spinner"></div><span>分析中…</span>';
    getLatestCard().appendChild(div);
    scrollBottom();
    return div;
  }

  function formatAssistant(text) {
    let html = escHtml(text)
      .replace(/【(.+?)】/g, '<b>【$1】</b>')
      .replace(/(看涨\s*📈)/g, '<span style="color:#4ade80">$1</span>')
      .replace(/(看跌\s*📉)/g, '<span style="color:#f87171">$1</span>')
      .replace(/(观望\s*[👀⚪]?)/g, '<span style="color:#fbbf24">$1</span>')
      .replace(/🟢/g, '<span style="color:#4ade80">🟢</span>')
      .replace(/🔴/g, '<span style="color:#f87171">🔴</span>')
      .replace(/🟡/g, '<span style="color:#fbbf24">🟡</span>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    html = html.replace(
      /(<b>【方向[^】]*】<\/b>)\s*(看涨|看跌|观望)/g,
      (_, tag, dir) => {
        const cls = dir === '看涨' ? 'bullish' : dir === '看跌' ? 'bearish' : 'neutral';
        const icon = dir === '看涨' ? ' 📈' : dir === '看跌' ? ' 📉' : ' 👀';
        return `<span class="tvc-judge-dir-line ${cls}">${tag} ${dir}${icon}</span>`;
      }
    );
    return html;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── ① 抓取 ──────────────────────────────────────────────────────
  document.getElementById('tvc-btn-extract').addEventListener('click', async () => {
    const btn = document.getElementById('tvc-btn-extract');
    btn.disabled = true; btn.textContent = '抓取中…';
    try {
      pendingKlineText = null;
      getMsgs().querySelectorAll('.tvc-msg-kline-wrap.tvc-pending-item').forEach(el => {
        const card = el.closest('.tvc-card');
        if (card && card.querySelectorAll('.tvc-msg-screenshot, .tvc-msg-kline-wrap').length === 1) card.remove();
        else el.remove();
      });
      const t = await requestKlineFromIframe();
      appendKlineBubble(t);
      setPendingKline(t);
    }
    catch (e) { appendError(e.message); }
    finally { btn.disabled = false; btn.textContent = '🔍 抓取'; }
  });

  // ── ② 抓取+截图（已移除独立截图按钮）
  // ── 发送分析 ────────────────────────────────────────────────────
  document.getElementById('tvc-send-btn').addEventListener('click', sendAnalysis);
  document.getElementById('tvc-send-agents-btn').addEventListener('click', sendAgentsAnalysis);
  document.getElementById('tvc-user-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendAnalysis();
  });

  let isSending = false;
  let currentAbort = null;

  function showStopBtn(show) {
    const s = document.getElementById('tvc-stop-btn');
    if (s) s.style.display = show ? 'inline-flex' : 'none';
  }

  document.getElementById('tvc-stop-btn').addEventListener('click', () => {
    if (currentAbort) { currentAbort.abort(); currentAbort = null; }
    safeSendMessage({ type: 'CANCEL' });
  });

  async function sendAnalysis() {
    if (isSending) return;
    if (!models.length) { appendError('请先在弹出窗口中配置模型'); return; }

    const userText = document.getElementById('tvc-user-input').value.trim();
    const prompt   = document.getElementById('tvc-prompt').value.trim();
    const hasKlineText   = !!pendingKlineText;
    const hasUserText    = !!userText;
    const hasAttachments = pendingAttachments.length > 0;
    const isFollowup     = !!currentSessionId && !hasKlineText;

    if (!hasKlineText && !hasUserText && !hasAttachments && !currentSessionId) {
      appendError('请先截图或抓取数值'); return;
    }

    isSending = true;
    streamingDiv = null; streamingText = '';
    currentAbort = new AbortController();
    const sendBtn = document.getElementById('tvc-send-btn');
    sendBtn.disabled = true;
    showStopBtn(true);
    if (hasUserText || hasAttachments) appendUserMsg(userText, pendingAttachments.map(a => a.name));
    const loading = appendLoading();

    try {
      let resp;
      const abortSignal = currentAbort.signal;

      if (!isFollowup) {
        currentSessionId = null;
        resp = await sendMessageWithAbort({
          type: 'ANALYZE_TEXT',
          prompt: prompt || undefined,
          klineText: hasKlineText ? pendingKlineText : undefined,
          userText: hasUserText ? userText : undefined,
          modelIndex: getModelIdx(), attachments: pendingAttachments
        }, abortSignal);
      } else {
        resp = await sendMessageWithAbort({
          type: 'FOLLOWUP', sessionId: currentSessionId, text: userText,
          modelIndex: getModelIdx(), attachments: pendingAttachments
        }, abortSignal);
      }

      loading.remove();
      if (resp?.aborted) { appendError('已手动停止'); isSending = false; showStopBtn(false); updateSendState(); return; }
      if (resp?.error) { appendError(resp.error); isSending = false; showStopBtn(false); updateSendState(); return; }
      if (resp?.sessionId) {
        currentSessionId = resp.sessionId;
      }
      if (resp?.result && !streamingDiv && !getMsgs().querySelector('.tvc-msg-assistant:last-child')) {
        appendAssistantMsg(resp.result);
      }

      pendingKlineText = null; pendingAttachments = [];
      getMsgs().querySelectorAll('.tvc-pending-item .tvc-item-close').forEach(b => b.remove());
      getMsgs().querySelectorAll('.tvc-pending-item').forEach(el => el.classList.remove('tvc-pending-item'));
      document.getElementById('tvc-user-input').value = '';
      document.getElementById('tvc-attach-bar').innerHTML = '';
    } catch (e) {
      loading.remove();
      if (e.name === 'AbortError') appendError('已手动停止');
      else appendError('网络错误: ' + e.message);
    } finally {
      isSending = false;
      currentAbort = null;
      showStopBtn(false);
      updateSendState();
      if (pendingAutoTrigger !== null && !isAutoAnalyzing) {
        const mode = pendingAutoTrigger;
        pendingAutoTrigger = null;
        if (window.__tvcRunning) {
          setTimeout(() => triggerAutoAnalysis(), 500);
        }
      }
    }
  }

  function sendMessageWithAbort(msg, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) { resolve({ aborted: true }); return; }
      // settled 必须先于 onAbort 声明，避免 abort 同步触发时的 TDZ 错误
      let settled = false;
      const onAbort = () => { settled = true; resolve({ aborted: true }); };
      signal.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve({ error: '请求超时（60s），请检查网络或重试' });
        }
      }, 60000);
      try {
        chrome.runtime.sendMessage(msg, resp => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            signal.removeEventListener('abort', onAbort);
            resolve(resp || { error: '无响应' });
          }
        });
      } catch(e) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener('abort', onAbort);
          resolve({ error: '扩展上下文失效，请刷新页面' });
        }
      }
    });
  }

  // ── 三角色分析（新功能）──────────────────────────────────────────
  async function sendAgentsAnalysis() {
    if (isSending || isChatAgents) return;
    if (!models.length) { appendError('请先在弹出窗口中配置模型'); return; }
    if (!pendingKlineText && !pendingAttachments.length && !document.getElementById('tvc-user-input').value.trim() && !currentSessionId) { appendError('请先抓取数值'); return; }

    isChatAgents = true;
    isSending = true;
    streamingDiv = null;
    streamingText = '';

    // 重置 chatAgentState
    Object.values(chatAgentState).forEach(s => { s.text = ''; s.div = null; });
    chatAgentCard = null;

    const sendBtn = document.getElementById('tvc-send-btn');
    const agentsBtn = document.getElementById('tvc-send-agents-btn');
    if (sendBtn) sendBtn.disabled = true;
    if (agentsBtn) agentsBtn.disabled = true;
    showStopBtn(true);

    const prompt = document.getElementById('tvc-prompt').value.trim();
    const card = createCard();
    chatAgentCard = card;

    // 在卡片中创建三个折叠面板
    const agents = [
      { key: 'chat_analyst', label: '🔍 分析师', color: '#4fc3f7' },
      { key: 'chat_critic',  label: '⚔️ 质疑师', color: '#fbbf24' },
      { key: 'chat_judge',   label: '⚖️ 裁判',   color: '#4ade80' },
    ];

    agents.forEach(({ key, label, color }) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:6px';
      wrap.dataset.agentKey = key;

      const lbl = document.createElement('div');
      lbl.className = 'tvc-agent-label';
      lbl.style.cursor = 'pointer';
      lbl.innerHTML = '<span style="color:' + color + '">' + label + '</span>'
        + ' <span class="tvc-agent-spinner">●</span>'
        + '<span class="tvc-agent-collapse-arrow" style="margin-left:auto">▾</span>';

      const body = document.createElement('div');
      body.className = 'tvc-agent-body';
      body.innerHTML = '<span style="color:#4a4e5a;font-size:11px">等待中…</span>';

      lbl.addEventListener('click', () => {
        const collapsed = body.classList.toggle('collapsed');
        const arr = lbl.querySelector('.tvc-agent-collapse-arrow');
        if (arr) arr.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
      });

      wrap.appendChild(lbl);
      wrap.appendChild(body);
      card.appendChild(wrap);

      // 关联到 chatAgentState
      chatAgentState[key].div = body;
    });

    scrollBottom();

    try {
      currentAbort = new AbortController();   // 连接到停止按钮
      const resp = await sendMessageWithAbort({
        type: 'ANALYZE_AGENTS_MANUAL',
        klineText: pendingKlineText || undefined,
        prompt: prompt || undefined,
        modelIndex: getModelIdx()
      }, currentAbort.signal);

      if (resp?.error) {
        appendError(resp.error);
      } else if (resp?.result && chatAgentState.chat_judge.text === '') {
        // 非流式回退：直接渲染结果
        chatAgentState.chat_judge.div.innerHTML = formatAssistant(resp.result);
        if (resp.analystResult) chatAgentState.chat_analyst.div.innerHTML = formatAssistant(resp.analystResult);
        if (resp.criticResult)  chatAgentState.chat_critic.div.innerHTML  = formatAssistant(resp.criticResult);
      }

      if (resp?.sessionId) currentSessionId = resp.sessionId;

      pendingKlineText = null;
      getMsgs().querySelectorAll('.tvc-pending-item .tvc-item-close').forEach(b => b.remove());
      getMsgs().querySelectorAll('.tvc-pending-item').forEach(el => el.classList.remove('tvc-pending-item'));
      document.getElementById('tvc-user-input').value = '';
    } catch(e) {
      appendError('三角色分析出错: ' + e.message);
    } finally {
      isChatAgents = false;
      isSending = false;
      showStopBtn(false);
      updateSendState();
    }
  }

  // ── 附件 ────────────────────────────────────────────────────────
  document.getElementById('tvc-attach-btn').addEventListener('click', () => {
    document.getElementById('tvc-file-input').click();
  });
  document.getElementById('tvc-file-input').addEventListener('change', async e => {
    for (const file of [...e.target.files]) {
      const reader = new FileReader();
      reader.onload = ev => {
        const result = ev.target.result;
        if (file.type.startsWith('image/'))
          pendingAttachments.push({ name: file.name, type: 'image', mime: file.type, data: result.split(',')[1] });
        else
          pendingAttachments.push({ name: file.name, type: 'text', data: result });
        renderAttachBar(); updateSendState();
      };
      file.type.startsWith('image/') ? reader.readAsDataURL(file) : reader.readAsText(file);
    }
    e.target.value = '';
  });
  function renderAttachBar() {
    const bar = document.getElementById('tvc-attach-bar');
    bar.innerHTML = pendingAttachments.map((a, i) =>
      `<span class="tvc-att-chip">${a.type==='image'?'🖼':'📄'} ${a.name}<button data-i="${i}">✕</button></span>`
    ).join('');
    bar.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => { pendingAttachments.splice(+btn.dataset.i, 1); renderAttachBar(); updateSendState(); });
    });
  }
  document.getElementById('tvc-user-input').addEventListener('input', updateSendState);

  // ── 自动分析控制 ──────────────────────────────────────────────────
  let pendingAutoTrigger = null;
  let lastAutoPrice = null;
  let isAutoAnalyzing = false;
  let lastAutoTriggerTime = 0;
  let _klineCountdownTimer = null; // 周期行倒计时 timer

  // 更新周期行倒计时显示（运行中每秒调用）
  function _updateKlineCountdownDisplay() {
    const isRunning = window.__tvcRunning;
    const elS = document.getElementById('tvc-kline-countdown');
    if (!isRunning) { if (elS) elS.textContent = ''; return; }
    const txt = _nextKlineCountdown(1);
    if (elS) elS.textContent = txt ? '下次分析 ' + txt : '';
  }

  function _startKlineCountdown() {
    _updateKlineCountdownDisplay();
    if (_klineCountdownTimer) return; // 已在跑
    _klineCountdownTimer = setInterval(_updateKlineCountdownDisplay, 1000);
  }

  function _stopKlineCountdown() {
    if (_klineCountdownTimer) { clearInterval(_klineCountdownTimer); _klineCountdownTimer = null; }
    const elS = document.getElementById('tvc-kline-countdown');
    if (elS) elS.textContent = '';
  }

  // ── Binance 直连行情 WebSocket ────────────────────────────────────
  // 直接订阅 Binance 官方 K 线流，不依赖 TradingView WebSocket
  let _lastWsKlineData = null; // 最新一次完整多周期数据缓存

  const _bnBuffers = { '1m': [], '5m': [], '10m': [], '15m': [], '30m': [], '1h': [] };
  // 1000：容纳 900 根 1m（保证 15m 降采样后有 60 根，EMA55 可收敛）+ 安全余量
  const _BN_BUF_SIZE = 1000;
  let _bnReady = false;    // 历史数据已加载完成
  let _serverTimeOffset = 0; // Binance服务器时间与本地时间的偏差（ms），正值=服务器快

  // ══════════════════════════════════════════════════════════════════
  //  指标计算引擎（行业标准参数，基于 Binance 原始 OHLCV 数据）
  // ══════════════════════════════════════════════════════════════════

  // Wilder 平滑均值（RSI/ADX 标准算法）
  function _wilderSmooth(arr, n) {
    if (arr.length < n) return [];
    const out = [];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[i];
    out.push(sum / n);
    for (let i = n; i < arr.length; i++) {
      out.push((out[out.length - 1] * (n - 1) + arr[i]) / n);
    }
    return out;
  }

  // EMA
  function _ema(closes, n) {
    if (closes.length < n) return [];
    const k = 2 / (n + 1);
    const out = [];
    let val = closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
    out.push(val);
    for (let i = n; i < closes.length; i++) {
      val = closes[i] * k + val * (1 - k);
      out.push(val);
    }
    return out;
  }

  // RSI(14) — Wilder 平滑
  function _rsi(closes, n) {
    n = n || 14;
    if (closes.length < n + 1) return [];
    const gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gains.push(d > 0 ? d : 0);
      losses.push(d < 0 ? -d : 0);
    }
    const ag = _wilderSmooth(gains, n);
    const al = _wilderSmooth(losses, n);
    return ag.map((g, i) => al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i]));
  }

  // MACD(12,26,9)
  function _macd(closes) {
    const ema12 = _ema(closes, 12);
    const ema26 = _ema(closes, 26);
    if (!ema12.length || !ema26.length) return null;
    // 对齐：ema26 比 ema12 短 14 根
    const offset = ema12.length - ema26.length;
    const dif = ema26.map((v, i) => ema12[i + offset] - v);
    const dea = _ema(dif, 9);
    if (!dea.length) return null;
    const difOffset = dif.length - dea.length;
    const hist = dea.map((v, i) => dif[i + difOffset] - v);
    return { dif, dea, hist };
  }

  // Bollinger Bands(20, 2σ)
  function _bb(closes, n, mult) {
    n = n || 20; mult = mult || 2;
    if (closes.length < n) return null;
    const basis = [], upper = [], lower = [], bw = [];
    for (let i = n - 1; i < closes.length; i++) {
      const slice = closes.slice(i - n + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / n;
      const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
      basis.push(mean);
      upper.push(mean + mult * std);
      lower.push(mean - mult * std);
      bw.push(mean > 0 ? (mult * 2 * std / mean * 100) : 0);
    }
    return { basis, upper, lower, bw };
  }

  // ATR(14)
  function _atr(candles, n) {
    n = n || 14;
    if (candles.length < 2) return [];
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return _wilderSmooth(trs, n);
  }

  // ADX(14) — 返回 { adx, pdi, mdi } 数组（等长）
  function _adx(candles, n) {
    n = n || 14;
    if (candles.length < n + 1) return null;
    const pDMs = [], mDMs = [], trs = [];
    for (let i = 1; i < candles.length; i++) {
      const upMove   = candles[i].h - candles[i - 1].h;
      const downMove = candles[i - 1].l - candles[i].l;
      pDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
      mDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
      const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const atr  = _wilderSmooth(trs, n);
    const aPDM = _wilderSmooth(pDMs, n);
    const aMDM = _wilderSmooth(mDMs, n);
    const len = Math.min(atr.length, aPDM.length, aMDM.length);
    const pdi = [], mdi = [], dx = [];
    for (let i = 0; i < len; i++) {
      const p = atr[i] > 0 ? 100 * aPDM[i] / atr[i] : 0;
      const m = atr[i] > 0 ? 100 * aMDM[i] / atr[i] : 0;
      pdi.push(p); mdi.push(m);
      dx.push((p + m) > 0 ? 100 * Math.abs(p - m) / (p + m) : 0);
    }
    const adx = _wilderSmooth(dx, n);
    const adxOffset = pdi.length - adx.length;
    return { adx, pdi: pdi.slice(adxOffset), mdi: mdi.slice(adxOffset) };
  }

  // OBV
  function _obv(candles) {
    if (candles.length < 2) return [];
    const out = [0];
    for (let i = 1; i < candles.length; i++) {
      const prev = out[out.length - 1];
      if (candles[i].c > candles[i - 1].c)      out.push(prev + candles[i].v);
      else if (candles[i].c < candles[i - 1].c) out.push(prev - candles[i].v);
      else                                        out.push(prev);
    }
    return out;
  }

  // StochRSI(14, 14, 3, 3) — 返回 { k, d } 平滑数组
  // rsiPeriod=14, stochPeriod=14, kSmooth=3, dSmooth=3（TradingView 默认参数）
  function _stochRsi(closes, rsiPeriod, stochPeriod, kSmooth, dSmooth) {
    rsiPeriod   = rsiPeriod   || 14;
    stochPeriod = stochPeriod || 14;
    kSmooth     = kSmooth     || 3;
    dSmooth     = dSmooth     || 3;
    const rsiArr = _rsi(closes, rsiPeriod);
    if (rsiArr.length < stochPeriod) return null;
    // StochRSI raw：RSI 在 stochPeriod 窗口内的归一化位置（0-100）
    const rawK = [];
    for (let i = stochPeriod - 1; i < rsiArr.length; i++) {
      const win = rsiArr.slice(i - stochPeriod + 1, i + 1);
      const lo  = Math.min(...win);
      const hi  = Math.max(...win);
      rawK.push(hi === lo ? 0 : (rsiArr[i] - lo) / (hi - lo) * 100);
    }
    // %K = rawK 的 kSmooth 期 SMA
    if (rawK.length < kSmooth) return null;
    const k = [];
    for (let i = kSmooth - 1; i < rawK.length; i++) {
      const s = rawK.slice(i - kSmooth + 1, i + 1);
      k.push(s.reduce((a, b) => a + b, 0) / kSmooth);
    }
    // %D = %K 的 dSmooth 期 SMA
    if (k.length < dSmooth) return null;
    const d = [];
    for (let i = dSmooth - 1; i < k.length; i++) {
      const s = k.slice(i - dSmooth + 1, i + 1);
      d.push(s.reduce((a, b) => a + b, 0) / dSmooth);
    }
    // 对齐 k 与 d（d 比 k 短 dSmooth-1 根）
    const offset = k.length - d.length;
    return { k: k.slice(offset), d };
  }

  // VWAP（日内成交量加权均价，每天 UTC 零点重置）
  // 典型价 = (高 + 低 + 收) / 3
  // v2.2 改动：从本地时区零点改为 UTC 零点。Binance 等交易所均按 UTC 计日，
  //   原实现下日本/欧洲用户算出的 VWAP 与盘面常用值错位 8-12 小时。
  //   Unix 毫秒戳本就是 UTC 基准，直接 floor 到 86400000 倍数即得 UTC 00:00。
  function _vwap(candles) {
    if (!candles || !candles.length) return null;
    const last     = candles[candles.length - 1];
    const dayStart = Math.floor(last.t / 86400000) * 86400000; // UTC 00:00
    let cumTPV = 0, cumVol = 0;
    for (const c of candles) {
      if (c.t < dayStart) continue;
      const tp  = (c.h + c.l + c.c) / 3;
      cumTPV   += tp * c.v;
      cumVol   += c.v;
    }
    return cumVol > 0 ? cumTPV / cumVol : null;
  }

  // 降采样：把 1m 缓冲区合成 5m / 15m K 线
  function _resample(buf1m, minutes) {
    const out = [];
    if (buf1m.length < minutes) return out;
    // 找第一根对齐的 K 线（开盘时间 mod minutes*60000 === 0）
    const step = minutes * 60000;
    let i = 0;
    // v2.2 改动：容差从 1000ms 扩到 2000ms，吸收 Binance 偶发的秒级时间戳偏移
    // (实测在网络抖动期间会出现 ~1.5s 的偏差导致对齐失败丢失多根 K 线)
    while (i < buf1m.length && (buf1m[i].t % step) > 2000) i++;
    while (i + minutes <= buf1m.length) {
      const slice = buf1m.slice(i, i + minutes);
      out.push({
        t: slice[0].t,
        o: slice[0].o,
        h: Math.max(...slice.map(c => c.h)),
        l: Math.min(...slice.map(c => c.l)),
        c: slice[slice.length - 1].c,
        v: slice.reduce((s, c) => s + c.v, 0),
        x: slice[slice.length - 1].x
      });
      i += minutes;
    }
    return out;
  }

  // 取数组最后 n 个元素
  function _tail(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }

  // 格式化数字（价格保留原精度，指标保留2位小数）
  function _fmt(v, dec) { return typeof v === 'number' ? v.toFixed(dec !== undefined ? dec : 2) : '—'; }


  function _last(arr, offset) {
    if (!Array.isArray(arr) || !arr.length) return null;
    const idx = arr.length - 1 - (offset || 0);
    return idx >= 0 ? arr[idx] : null;
  }

  function _clamp(v, min, max) {
    if (!isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
  }

  function _sma(arr, n) {
    if (!Array.isArray(arr) || arr.length < n || n <= 0) return null;
    const slice = arr.slice(arr.length - n);
    return slice.reduce((a, b) => a + b, 0) / n;
  }

  function _roundLevelStep(price) {
    if (!isFinite(price) || price <= 0) return 100;
    if (price >= 100000) return 1000;
    if (price >= 50000) return 500;
    if (price >= 10000) return 100;
    if (price >= 1000) return 50;
    return 10;
  }

  function _nearestRoundLevel(price) {
    if (!isFinite(price) || price <= 0) return null;
    const step = _roundLevelStep(price);
    return Math.round(price / step) * step;
  }

  function _percentileRank(arr, value) {
    if (!Array.isArray(arr) || !arr.length || !isFinite(value)) return null;
    const less = arr.filter(v => v <= value).length;
    return less / arr.length;
  }

  function _zoneFromValue(v, low, high) {
    if (!isFinite(v)) return 'unknown';
    if (v <= low) return 'low';
    if (v >= high) return 'high';
    return 'mid';
  }

  function _distAtr(price, target, atr) {
    if (!isFinite(price) || !isFinite(target) || !isFinite(atr) || atr <= 0) return null;
    return (price - target) / atr;
  }

  function _barsDirection(buf, n) {
    if (!Array.isArray(buf) || buf.length < n + 1) return 'mixed';
    let up = 0, down = 0;
    for (let i = buf.length - n; i < buf.length; i++) {
      const cur = buf[i], prev = buf[i - 1];
      if (!cur || !prev) continue;
      if (cur.c > prev.c) up++;
      else if (cur.c < prev.c) down++;
    }
    if (up === n) return 'up';
    if (down === n) return 'down';
    if (up >= Math.ceil(n * 0.7)) return 'mostly_up';
    if (down >= Math.ceil(n * 0.7)) return 'mostly_down';
    return 'mixed';
  }

  function _findPrevSwing(buf, side, lookback) {
    if (!Array.isArray(buf) || buf.length < 5) return null;
    const end = Math.max(2, buf.length - 2);
    const start = Math.max(2, end - (lookback || 30));
    for (let i = end; i >= start; i--) {
      const a = buf[i - 2], b = buf[i - 1], c = buf[i], d = buf[i + 1], e = buf[i + 2];
      if (!(a && b && c && d && e)) continue;
      if (side === 'high') {
        if (c.h >= b.h && c.h >= d.h && c.h >= a.h && c.h >= e.h) return c.h;
      } else {
        if (c.l <= b.l && c.l <= d.l && c.l <= a.l && c.l <= e.l) return c.l;
      }
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  v3.12 模块0：摆动高低点结构（骨架）
  //  用5根分形找出窗口内所有 swing high/low，输出高低点序列方向、
  //  前高/前低是否被吃掉、下跌/上涨斜率是否走平。
  //  这是判断"段的起止"和"回踩vs反转"的骨架，量能/动能挂在它上面共振。
  // ══════════════════════════════════════════════════════════════════
  function _swingStructure(buf, lookback) {
    const out = {
      lastHigh: null, prevHigh2: null, lastLow: null, prevLow2: null,
      highSeq: '?', lowSeq: '?', structure: '?',
      brokePrevHigh: false, brokePrevLow: false,
      slopeFlatten: false, swingHighCount: 0, swingLowCount: 0
    };
    if (!Array.isArray(buf) || buf.length < 7) return out;
    const end = buf.length - 2;            // 最后一根未确认分形（需右侧2根）
    const start = Math.max(2, end - (lookback || 60));
    const highs = [], lows = [];
    for (let i = start; i <= end; i++) {
      const a = buf[i - 2], b = buf[i - 1], c = buf[i], d = buf[i + 1], e = buf[i + 2];
      if (!(a && b && c && d && e)) continue;
      if (c.h >= b.h && c.h >= d.h && c.h >= a.h && c.h >= e.h) highs.push({ i, p: c.h });
      if (c.l <= b.l && c.l <= d.l && c.l <= a.l && c.l <= e.l) lows.push({ i, p: c.l });
    }
    out.swingHighCount = highs.length;
    out.swingLowCount = lows.length;
    const cur = _last(buf, 0);
    const curC = cur ? cur.c : null;

    if (highs.length >= 1) out.lastHigh = highs[highs.length - 1].p;
    if (highs.length >= 2) out.prevHigh2 = highs[highs.length - 2].p;
    if (lows.length >= 1) out.lastLow = lows[lows.length - 1].p;
    if (lows.length >= 2) out.prevLow2 = lows[lows.length - 2].p;

    // 高点序列：最近一个 swing high 相对前一个 → HH(走高)/LH(走低)
    if (out.lastHigh != null && out.prevHigh2 != null)
      out.highSeq = out.lastHigh > out.prevHigh2 ? 'HH' : out.lastHigh < out.prevHigh2 ? 'LH' : 'EQ';
    // 低点序列：HL(走高)/LL(走低)
    if (out.lastLow != null && out.prevLow2 != null)
      out.lowSeq = out.lastLow > out.prevLow2 ? 'HL' : out.lastLow < out.prevLow2 ? 'LL' : 'EQ';

    // 结构方向：高低点同时走低=下跌；同时走高=上涨；其余=震荡/不明
    if (out.highSeq === 'LH' && out.lowSeq === 'LL') out.structure = 'down';
    else if (out.highSeq === 'HH' && out.lowSeq === 'HL') out.structure = 'up';
    else if (out.highSeq !== '?' || out.lowSeq !== '?') out.structure = 'range';

    // 破前高/前低：当前收盘价吃掉最近一个已确认摆动点 → 结构被打破信号
    if (curC != null && out.lastHigh != null) out.brokePrevHigh = curC > out.lastHigh;
    if (curC != null && out.lastLow != null) out.brokePrevLow = curC < out.lastLow;

    // 斜率走平：最近一段摆动点连线的陡峭度是否比更早一段变缓（推进段衰竭信号）
    // 下跌看低点连线，上涨看高点连线
    const pts = out.structure === 'up' ? highs : lows;
    if (pts.length >= 3) {
      const n = pts.length;
      const recentSlope = Math.abs(pts[n - 1].p - pts[n - 2].p) / Math.max(1, pts[n - 1].i - pts[n - 2].i);
      const priorSlope = Math.abs(pts[n - 2].p - pts[n - 3].p) / Math.max(1, pts[n - 2].i - pts[n - 3].i);
      if (priorSlope > 0 && recentSlope < priorSlope * 0.6) out.slopeFlatten = true;
    }
    return out;
  }

  // ── v3.12 模块A：量能 / 动能 / StochRSI转向 ──────────────────────
  // 量能regime：近 win 根均量 vs 前 win 根均量 → 放量/缩量/平
  function _volRegime(vols, win) {
    win = win || 4;
    if (!Array.isArray(vols) || vols.length < win * 2) return { regime: '?', ratio: null };
    const recent = vols.slice(-win).reduce((a, b) => a + b, 0) / win;
    const prior  = vols.slice(-win * 2, -win).reduce((a, b) => a + b, 0) / win;
    if (!(prior > 0)) return { regime: '?', ratio: null };
    const r = recent / prior;
    const regime = r >= 1.25 ? 'expanding' : r <= 0.8 ? 'contracting' : 'flat';
    return { regime, ratio: Number(r.toFixed(3)) };
  }

  // 动能背离：价格创窗口新低/高，但动能(RSI/MACD柱)未同步 → 底/顶背离
  // 标准定义：当前价 ≤ 前低 但 动能 > 前低处动能 = 底背离(bull)；反之顶背离(bear)
  function _momDivergence(closes, rsiArr, histArr, win) {
    win = win || 14;
    if (!Array.isArray(closes) || closes.length < win + 2) return null;
    const c = closes.slice(-win);
    const r = (Array.isArray(rsiArr)  && rsiArr.length  >= win) ? rsiArr.slice(-win)  : null;
    const h = (Array.isArray(histArr) && histArr.length >= win) ? histArr.slice(-win) : null;
    const last = c.length - 1;
    const prior = c.slice(0, last); // 不含当前根
    let pLo = 0, pHi = 0;
    for (let k = 1; k < prior.length; k++) {
      if (prior[k] < prior[pLo]) pLo = k;
      if (prior[k] > prior[pHi]) pHi = k;
    }
    // 底背离：当前≤前低，但RSI/柱更高
    if (c[last] <= prior[pLo] * 1.0005) {
      if (r && isFinite(r[last]) && isFinite(r[pLo]) && r[last] > r[pLo] + 1) return 'bull';
      if (h && isFinite(h[last]) && isFinite(h[pLo]) && h[last] > h[pLo]) return 'bull';
    }
    // 顶背离：当前≥前高，但RSI/柱更低
    if (c[last] >= prior[pHi] * 0.9995) {
      if (r && isFinite(r[last]) && isFinite(r[pHi]) && r[last] < r[pHi] - 1) return 'bear';
      if (h && isFinite(h[last]) && isFinite(h[pHi]) && h[last] < h[pHi]) return 'bear';
    }
    return null;
  }

  // StochRSI转向：%K相对%D的金叉/死叉 + 所处极值区
  function _stochTurn(kArr, dArr) {
    if (!Array.isArray(kArr) || !Array.isArray(dArr) || kArr.length < 2 || dArr.length < 2) return null;
    const k0 = kArr[kArr.length - 2], k1 = kArr[kArr.length - 1];
    const d0 = dArr[dArr.length - 2], d1 = dArr[dArr.length - 1];
    if (![k0, k1, d0, d1].every(isFinite)) return null;
    const crossUp = k0 <= d0 && k1 > d1;
    const crossDn = k0 >= d0 && k1 < d1;
    if (crossUp && k1 <= 35) return 'up_from_oversold';
    if (crossDn && k1 >= 65) return 'down_from_overbought';
    if (crossUp) return 'cross_up';
    if (crossDn) return 'cross_down';
    return null;
  }

  function _detectTriggerFlags(buf, ema21, vwapVal, atr) {
    const cur = _last(buf, 0), prev = _last(buf, 1);
    if (!(cur && prev)) return [];
    const body = Math.abs(cur.c - cur.o);
    const range = Math.max(cur.h - cur.l, 1e-8);
    const bodyRatio = body / range;
    const flags = [];
    if (isFinite(ema21)) {
      if (prev.c <= ema21 && cur.c > ema21) flags.push('reclaim_ema21');
      if (prev.c >= ema21 && cur.c < ema21) flags.push('lose_ema21');
    }
    if (isFinite(vwapVal)) {
      if (prev.c <= vwapVal && cur.c > vwapVal) flags.push('reclaim_vwap');
      if (prev.c >= vwapVal && cur.c < vwapVal) flags.push('lose_vwap');
    }
    if (bodyRatio >= 0.65) flags.push(cur.c > cur.o ? 'impulse_up' : 'impulse_down');
    if (isFinite(atr) && atr > 0 && range >= atr * 1.2) flags.push('range_expand');
    if (cur.h - Math.max(cur.c, cur.o) >= range * 0.35) flags.push('upper_wick_reject');
    if (Math.min(cur.c, cur.o) - cur.l >= range * 0.35) flags.push('lower_wick_reject');
    return flags;
  }

  function _computeTfFeature(label, buf) {
    if (!Array.isArray(buf) || buf.length < 20) return null;
    const closes = buf.map(c => c.c);
    const vols = buf.map(c => c.v);
    const cur = _last(buf, 0);
    const prev = _last(buf, 1);
    if (!(cur && prev)) return null;

    const ema9Arr  = _ema(closes, 9);
    const ema21Arr = _ema(closes, 21);
    const ema55Arr = _ema(closes, 55);
    const rsiArr = _rsi(closes, 14);
    const macdData = _macd(closes);
    const adxData = _adx(buf, 14);
    const bbData = _bb(closes, 20, 2);
    const atrArr = _atr(buf, 14);
    const obvArr = _obv(buf);
    const stoch = _stochRsi(closes, 14, 14, 3, 3);
    const vwapVal = _vwap(buf);
    const volMA20 = vols.length >= 20 ? _sma(vols, 20) : null;
    const atr = _last(atrArr, 0);
    const ema9  = _last(ema9Arr,  0);
    const ema21 = _last(ema21Arr, 0);
    const ema55 = _last(ema55Arr, 0);
    const rsi = _last(rsiArr, 0);
    const macdHist = macdData ? _last(macdData.hist, 0) : null;
    const macdDif = macdData ? _last(macdData.dif, 0) : null;
    const macdDea = macdData ? _last(macdData.dea, 0) : null;
    const adx = adxData ? _last(adxData.adx, 0) : null;
    const pdi = adxData ? _last(adxData.pdi, 0) : null;
    const mdi = adxData ? _last(adxData.mdi, 0) : null;
    const bbUpper = bbData ? _last(bbData.upper, 0) : null;
    const bbLower = bbData ? _last(bbData.lower, 0) : null;
    const bbBasis = bbData ? _last(bbData.basis, 0) : null;
    const bbw = bbData ? _last(bbData.bw, 0) : null;
    const bbPct = (isFinite(bbUpper) && isFinite(bbLower) && bbUpper > bbLower) ? (cur.c - bbLower) / (bbUpper - bbLower) : null;
    const stochK = stoch ? _last(stoch.k, 0) : null;
    const stochD = stoch ? _last(stoch.d, 0) : null;
    const volRatio = (isFinite(volMA20) && volMA20 > 0) ? cur.v / volMA20 : null;
    const roundLevel = _nearestRoundLevel(cur.c);
    const prevHigh = _findPrevSwing(buf, 'high', Math.min(40, buf.length - 3));
    const prevLow = _findPrevSwing(buf, 'low', Math.min(40, buf.length - 3));
    const body = Math.abs(cur.c - cur.o);
    const range = Math.max(cur.h - cur.l, 1e-8);
    const upperWick = cur.h - Math.max(cur.c, cur.o);
    const lowerWick = Math.min(cur.c, cur.o) - cur.l;
    const impulse = body / range;
    const closeLocation = (cur.c - cur.l) / range;
    const obvSlope = (obvArr.length >= 4) ? (obvArr[obvArr.length - 1] - obvArr[obvArr.length - 4]) : null;
    // v3.12: 段起止判断三件套——骨架(swing结构) + 量能regime + 动能背离 + StochRSI转向
    const _swing = _swingStructure(buf, Math.min(60, buf.length - 3));
    const _volReg = _volRegime(vols, 4);
    const _momDiv = _momDivergence(closes, rsiArr, macdData ? macdData.hist : null, 14);
    const _stochTurnSig = _stochTurn(stoch ? stoch.k : null, stoch ? stoch.d : null); // v3.12 fix: 变量名改掉避免与函数名冲突导致TDZ崩溃
    // v3.10: K线形态识别（用于5M触发评分）
    const _prevC = _last(buf, 1);
    const _engulfing = _prevC ? (() => {
      const curBull = cur.c > cur.o, prevBull = _prevC.c > _prevC.o;
      if (curBull && !prevBull && cur.o <= _prevC.c && cur.c >= _prevC.o) return 'bullish';
      if (!curBull && prevBull && cur.o >= _prevC.c && cur.c <= _prevC.o) return 'bearish';
      return null;
    })() : null;
    const _body = Math.abs(cur.c - cur.o);
    const _upperW = cur.h - Math.max(cur.c, cur.o);
    const _lowerW = Math.min(cur.c, cur.o) - cur.l;
    // v3.10.1: Pin Bar 阈值从3倍改为2倍，加BB位置和StochRSI状态用于有效性判断
    const _pinBarType = _body > 0
      ? (_lowerW >= _body * 2 && _upperW < _body * 0.8) ? 'bullish_pin'
      : (_upperW >= _body * 2 && _lowerW < _body * 0.8) ? 'bearish_pin'
      : null : null;
    // BB位置：bbPct>0.85=近上轨，bbPct<0.15=近下轨
    const _bbPos = isFinite(bbPct) ? (bbPct > 0.85 ? 'upper' : bbPct < 0.15 ? 'lower' : 'mid') : 'unknown';
    // StochRSI状态：stochK>=80=超买，stochK<=20=超卖
    const _stochState = isFinite(stochK)
      ? (stochK >= 80 ? 'overbought' : stochK <= 20 ? 'oversold' : 'neutral') : 'unknown';
    // 有效Pin Bar：看涨Pin在下轨附近+超卖 / 看跌Pin在上轨附近+超买
    const _pinBarValid = _pinBarType === 'bullish_pin'
        ? (_bbPos === 'lower' && _stochState === 'oversold')
        : _pinBarType === 'bearish_pin'
        ? (_bbPos === 'upper' && _stochState === 'overbought')
        : false;
    const _pinBar = _pinBarType; // 保留原始类型字段

    const triggerFlags = _detectTriggerFlags(buf, ema21, vwapVal, atr);
    const dist = {
      ema21_atr: _distAtr(cur.c, ema21, atr),
      ema55_atr: _distAtr(cur.c, ema55, atr),
      vwap_atr: _distAtr(cur.c, vwapVal, atr),
      prevHigh_atr: _distAtr(cur.c, prevHigh, atr),
      prevLow_atr: _distAtr(cur.c, prevLow, atr),
      roundLevel_atr: _distAtr(cur.c, roundLevel, atr),
      bbUpper_atr: _distAtr(cur.c, bbUpper, atr),
      bbLower_atr: _distAtr(cur.c, bbLower, atr)
    };

    let trendBias = 'neutral';
    if (isFinite(ema21) && isFinite(ema55)) {
      if (cur.c > ema21 && ema21 > ema55) trendBias = 'bullish';
      else if (cur.c < ema21 && ema21 < ema55) trendBias = 'bearish';
      else if (cur.c > ema21) trendBias = 'mild_bullish';
      else if (cur.c < ema21) trendBias = 'mild_bearish';
    }

    // v3.12.3: marketState 三维判断——ADX + barsDirection + trendBias
    // 避免ADX单指标滞后导致加密快行情漏判
    let marketState = '不明';
    const _bd3 = _barsDirection(buf, 3);
    const _bd5 = _barsDirection(buf, 5);
    const _momentumDirectional = (_bd3 === 'up' || _bd3 === 'down') &&
      (_bd5 === 'up' || _bd5 === 'mostly_up' || _bd5 === 'down' || _bd5 === 'mostly_down');
    if (isFinite(adx)) {
      if (adx >= 25) {
        marketState = '趋势';
      } else if (_momentumDirectional && trendBias !== 'neutral') {
        marketState = '趋势形成';
      } else if (adx <= 20 && !_momentumDirectional) {
        marketState = '震荡';
      } else {
        marketState = '不明';
      }
    }

    return {
      tf: label,
      candles: buf.length,
      price: cur.c,
      marketState,
      trendBias,
      barsDirection3: _barsDirection(buf, 3),
      barsDirection5: _barsDirection(buf, 5),
      bodyRatio: isFinite(impulse) ? Number(impulse.toFixed(4)) : 0,
      upperWickRatio: isFinite(upperWick / range) ? Number((upperWick / range).toFixed(4)) : 0,
      lowerWickRatio: isFinite(lowerWick / range) ? Number((lowerWick / range).toFixed(4)) : 0,
      closeLocation: isFinite(closeLocation) ? Number(closeLocation.toFixed(4)) : 0,
      rsi: isFinite(rsi) ? Number(rsi.toFixed(2)) : null,
      rsiZone: _zoneFromValue(rsi, 40, 60),
      macdHist: isFinite(macdHist) ? Number(macdHist.toFixed(4)) : null,
      macdDif: isFinite(macdDif) ? Number(macdDif.toFixed(4)) : null,
      macdDea: isFinite(macdDea) ? Number(macdDea.toFixed(4)) : null,
      adx: isFinite(adx) ? Number(adx.toFixed(2)) : null,
      diPlus: isFinite(pdi) ? Number(pdi.toFixed(2)) : null,
      diMinus: isFinite(mdi) ? Number(mdi.toFixed(2)) : null,
      atr: isFinite(atr) ? Number(atr.toFixed(4)) : null,
      bbw: isFinite(bbw) ? Number(bbw.toFixed(2)) : null,
      bbPct: isFinite(bbPct) ? Number(bbPct.toFixed(4)) : null,
      stochK: isFinite(stochK) ? Number(stochK.toFixed(2)) : null,
      stochD: isFinite(stochD) ? Number(stochD.toFixed(2)) : null,
      volRatio: isFinite(volRatio) ? Number(volRatio.toFixed(3)) : null,
      obvSlope: isFinite(obvSlope) ? Number(obvSlope.toFixed(2)) : null,
      // v3.12 段起止三件套
      swing: _swing,                         // 高低点结构：highSeq/lowSeq/structure/brokePrevHigh/brokePrevLow/slopeFlatten
      volRegime: _volReg.regime,             // expanding放量 / contracting缩量 / flat
      volRegimeRatio: _volReg.ratio,
      momDivergence: _momDiv,                // bull底背离 / bear顶背离 / null
      stochTurn: _stochTurnSig,                 // up_from_oversold / down_from_overbought / cross_up / cross_down / null
      ema9:  isFinite(ema9)  ? Number(ema9.toFixed(4))  : null,
      ema21: isFinite(ema21) ? Number(ema21.toFixed(4)) : null,
      ema55: isFinite(ema55) ? Number(ema55.toFixed(4)) : null,
      engulfing: _engulfing,
      pinBar: _pinBar,
      pinBarValid: _pinBarValid,   // true=满足BB位置+StochRSI条件的高质量Pin Bar
      pinBarBBPos: _bbPos,         // 'upper'/'lower'/'mid'
      pinBarStoch: _stochState,    // 'overbought'/'oversold'/'neutral'
      vwap: isFinite(vwapVal) ? Number(vwapVal.toFixed(4)) : null,
      prevHigh: isFinite(prevHigh) ? Number(prevHigh.toFixed(4)) : null,
      prevLow: isFinite(prevLow) ? Number(prevLow.toFixed(4)) : null,
      roundLevel: isFinite(roundLevel) ? Number(roundLevel.toFixed(4)) : null,
      triggerFlags,
      dist,
      raw: {
        open: cur.o, high: cur.h, low: cur.l, close: cur.c, volume: cur.v,
        bbBasis: isFinite(bbBasis) ? Number(bbBasis.toFixed(4)) : null,
        bbUpper: isFinite(bbUpper) ? Number(bbUpper.toFixed(4)) : null,
        bbLower: isFinite(bbLower) ? Number(bbLower.toFixed(4)) : null
      }
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  v3.10 三层评分系统（替代原 _scoreTrend/_scoreRisk）
  //  第一层：1H方向权重  第二层：15M信号得分  第三层：5M触发得分
  //  打分结果作为语义数据传给Agent，不作为硬门槛
  // ══════════════════════════════════════════════════════════════════

  // 1H方向权重：EMA21/55结构 + 价格位置，输出 -2 到 +2
  function _score1hBias() {
    const buf1h = _bnBuffers['1h'];
    if (!buf1h || buf1h.length < 30) return { score: 0, label: '1H数据不足' };
    const closes1h = buf1h.map(c => c.c);
    const e21arr = _ema(closes1h, 21);
    const e55arr = _ema(closes1h, 55);
    const cur = buf1h[buf1h.length - 1];
    const e21 = e21arr[e21arr.length - 1];
    const e55 = e55arr[e55arr.length - 1];
    if (!isFinite(e21) || !isFinite(e55) || !cur) return { score: 0, label: '1H指标不足' };
    let score = 0;
    if (e21 > e55) score += 1; else if (e21 < e55) score -= 1; // EMA结构
    if (cur.c > e21) score += 1; else if (cur.c < e21) score -= 1; // 价格位置
    const label = score >= 2 ? '强多' : score === 1 ? '偏多' : score === 0 ? '中性'
                : score === -1 ? '偏空' : '强空';
    return { score, label, ema21: Number(e21.toFixed(2)), ema55: Number(e55.toFixed(2)) };
  }

  // 15M信号得分：EMA结构/RSI/VWAP/布林带/量能，各±1，总分 -5 到 +5
  function _score15mSignal(tf) {
    if (!tf) return { score: 0, label: '数据不足', details: [], vetoes: [] };
    let score = 0;
    const details = [], vetoes = [];

    // ① EMA结构（用trendBias代表EMA9/21关系）
    if (tf.trendBias === 'bullish' || tf.trendBias === 'mild_bullish') {
      score += 1; details.push('EMA多头+1');
    } else if (tf.trendBias === 'bearish' || tf.trendBias === 'mild_bearish') {
      score -= 1; details.push('EMA空头-1');
    }

    // ② RSI区间（震荡区为否决项）
    if (isFinite(tf.rsi)) {
      if (tf.rsi > 55)      { score += 1; details.push('RSI动能多+1'); }
      else if (tf.rsi < 45) { score -= 1; details.push('RSI动能空-1'); }
      else                  { vetoes.push('RSI震荡区(45-55)，无动能方向'); }
    }

    // ③ VWAP位置
    const vwapDist = tf.dist && tf.dist.vwap_atr;
    if (isFinite(vwapDist)) {
      if (vwapDist > 0.15)       { score += 1; details.push('VWAP上方+1'); }
      else if (vwapDist < -0.15) { score -= 1; details.push('VWAP下方-1'); }
      // |dist|<0.15 视为穿越区，不加分
    }

    // ④ 布林带宽度（v3.11: 带宽是无方向的波动率，不再贡献多空分；只做波动率/横盘否决标注）
    if (isFinite(tf.bbw)) {
      if (tf.bbw < 1.2)      { details.push('带宽极窄(横盘无波动)'); vetoes.push('布林带极窄'); }
      else if (tf.bbw > 2.0) { details.push('带宽扩张(波动放大)'); }
    }

    // ⑤ 成交量配合趋势方向（v3.11: 仅在已有明确方向(score≠0)时用量能确认；
    //    方向中性时放量/缩量都不该凭空制造多空，避免无方向行情被量能带偏）
    if (isFinite(tf.volRatio) && score !== 0) {
      const isBull = score > 0; // 此时 score 只含 EMA/RSI/VWAP 等方向性指标，读数干净
      if (tf.volRatio >= 1.3)    { score += (isBull ? 1 : -1); details.push('放量配合' + (isBull?'+1':'-1')); }
      else if (tf.volRatio < 0.7){ score -= (isBull ? 1 : -1); details.push('缩量' + (isBull?'-1':'+1')); }
    }

    const label = score >= 4 ? '极强' : score >= 2 ? '较强' : score === 1 ? '偏多'
                : score === 0 ? '中性' : score === -1 ? '偏空'
                : score <= -2 ? '偏弱' : '极弱';
    return { score, label, details, vetoes };
  }

  // 5M触发得分：K线形态+关键位回踩，有方向性
  function _score5mTrigger(tf, tf1m) {  // tf=5m特征，tf1m=1m特征（用于Pin Bar共振验证）
    if (!tf) return { score: 0, signals: [] };
    let score = 0;
    const signals = [];

    // 吞没K线
    if (tf.engulfing === 'bullish') { score += 1; signals.push('看涨吞没+1'); }
    else if (tf.engulfing === 'bearish') { score -= 1; signals.push('看跌吞没-1'); }

    // Pin Bar（结合1m周期验证）
    // 有效条件：5m Pin Bar在BB上下轨+StochRSI超卖/超买，且1m也触及BB轨+1m StochRSI配合
    if (tf.pinBar === 'bullish_pin') {
      const _1mAtLower = tf1m && isFinite(tf1m.bbPct) && tf1m.bbPct < 0.15;
      const _1mOversold = tf1m && isFinite(tf1m.stochK) && tf1m.stochK <= 25;
      if (tf.pinBarValid && (_1mAtLower || _1mOversold)) {
        score += 2; signals.push('🎯看涨PinBar+2(5m+1m共振)');
      } else if (tf.pinBarValid) {
        score += 1; signals.push('看涨PinBar+1(5m有效)');
      } else {
        signals.push('⚠️看涨PinBar未达标(BB/StochRSI不配合)');
      }
    } else if (tf.pinBar === 'bearish_pin') {
      const _1mAtUpper = tf1m && isFinite(tf1m.bbPct) && tf1m.bbPct > 0.85;
      const _1mOverbought = tf1m && isFinite(tf1m.stochK) && tf1m.stochK >= 75;
      if (tf.pinBarValid && (_1mAtUpper || _1mOverbought)) {
        score -= 2; signals.push('🎯看跌PinBar-2(5m+1m共振)');
      } else if (tf.pinBarValid) {
        score -= 1; signals.push('看跌PinBar-1(5m有效)');
      } else {
        signals.push('⚠️看跌PinBar未达标(BB/StochRSI不配合)');
      }
    }

    // 回踩EMA21（距离≤0.4 ATR视为接触）
    if (tf.dist && isFinite(tf.dist.ema21_atr)) {
      const d = tf.dist.ema21_atr;
      if (Math.abs(d) <= 0.4) {
        if (d >= 0) { score += 1; signals.push('回踩EMA21支撑+1'); }
        else        { score -= 1; signals.push('回踩EMA21压力-1'); }
      }
    }

    // 回踩VWAP（距离≤0.4 ATR）
    if (tf.dist && isFinite(tf.dist.vwap_atr)) {
      const d = tf.dist.vwap_atr;
      if (Math.abs(d) <= 0.4) {
        if (d >= 0) { score += 1; signals.push('回踩VWAP支撑+1'); }
        else        { score -= 1; signals.push('回踩VWAP压力-1'); }
      }
    }

    return { score, signals };
  }

  // 硬否决检查（标注，不强制禁止）
  function _hardVetoCheck(tf15m, tf5m, bias1h) {
    const flags = [];
    if (tf15m) {
      if (isFinite(tf15m.rsi) && tf15m.rsi >= 45 && tf15m.rsi <= 55)
        flags.push('15M RSI震荡区(45-55)，无明确动能方向');
      if (isFinite(tf15m.bbw) && tf15m.bbw < 1.2)
        flags.push('15M 布林带极窄，行情横盘无波动');
    }
    if (tf5m) {
      if (isFinite(tf5m.atr) && tf5m.atr < 20)
        flags.push('5M ATR极低(<20)，价格几乎不动');
      const b5 = tf5m.barsDirection5;
      if ((b5 === 'up' || b5 === 'mostly_up') && tf5m.trendBias === 'bearish')
        flags.push('5M连续多根阳线，追空注意反弹风险');
      if ((b5 === 'down' || b5 === 'mostly_down') && tf5m.trendBias === 'bullish')
        flags.push('5M连续多根阴线，追多注意继续回调风险');
    }
    return flags;
  }

  // v3.10: 保留旧函数签名供 _candidateForExpiry 调用，内部用新逻辑
  function _scoreTrend(tf) {
    if (!tf) return 0;
    let score = 0;
    if (tf.trendBias === 'bullish') score += 2;
    else if (tf.trendBias === 'bearish') score -= 2;
    else if (tf.trendBias === 'mild_bullish') score += 1;
    else if (tf.trendBias === 'mild_bearish') score -= 1;
    if (isFinite(tf.adx)) {
      if (tf.adx >= 25) score += tf.diPlus > tf.diMinus ? 1 : tf.diMinus > tf.diPlus ? -1 : 0;
    }
    if (isFinite(tf.rsi)) {
      if (tf.rsi > 70)       score -= 1;  // 超买极值：动量过度延伸，减多头分
      else if (tf.rsi < 30)  score += 1;  // 超卖极值：动量过度延伸，减空头分
      else if (tf.rsi >= 52 && tf.rsi <= 65) score += 1;   // 多头回归区：从中性向上恢复
      else if (tf.rsi <= 48 && tf.rsi >= 35) score -= 1;   // 空头回归区：从中性向下恢复
    }
    if (isFinite(tf.macdHist)) score += tf.macdHist > 0 ? 1 : tf.macdHist < 0 ? -1 : 0;
    return score;
  }

  function _scoreTrigger(tf1m, tf5m) {
    const flags = [].concat(tf1m && tf1m.triggerFlags || [], tf5m && tf5m.triggerFlags || []);
    let score = 0;
    flags.forEach(f => {
      if (f === 'reclaim_ema21' || f === 'reclaim_vwap' || f === 'impulse_up' || f === 'lower_wick_reject') score += 1;
      if (f === 'lose_ema21' || f === 'lose_vwap' || f === 'impulse_down' || f === 'upper_wick_reject') score -= 1;
    });
    if (tf1m && isFinite(tf1m.stochK) && isFinite(tf1m.stochD)) {
      if (tf1m.stochK <= 20 && tf1m.stochK > tf1m.stochD) score += 1;
      if (tf1m.stochK >= 80 && tf1m.stochK < tf1m.stochD) score -= 1;
    }
    return score;
  }

  function _scoreRisk(baseTf, execTf, triggerTf) {
    // v3.8.3 修复：原逻辑把趋势信号（放量/大实体/宽布林带）计为风险，导致趋势越强越被拦截。
    // 修复：风险评估必须区分趋势市和震荡市。
    // · 趋势市（ADX≥24）：放量/大实体/宽布林带是正常现象，不计为风险
    // · 震荡市/不明（ADX<24）：才把这些视为噪音风险
    let risk = 0;
    const ref = triggerTf || execTf || baseTf;
    if (!ref) return 1;
    const envAdx = isFinite(baseTf && baseTf.adx) ? baseTf.adx : 0;
    const isTrend = envAdx >= 24; // 有效趋势阈值

    // 仅震荡市才把高波动/放量/大实体计为风险
    if (!isTrend) {
      if (isFinite(ref.bbw) && ref.bbw >= 4.5) risk += 1;      // 震荡中宽布林带=假突破风险
      if (isFinite(ref.volRatio) && ref.volRatio >= 1.8) risk += 1; // 震荡中放量=可疑
      if (isFinite(ref.bodyRatio) && ref.bodyRatio >= 0.75) risk += 1; // 震荡中大实体=追高风险
    }
    // 无论趋势/震荡，ADX过低和整数关口风险都计入
    if (envAdx <= 15) risk += 1; // ADX极低=方向不明
    if (isFinite(execTf && execTf.dist && execTf.dist.roundLevel_atr) && Math.abs(execTf.dist.roundLevel_atr) <= 0.2) risk += 1;
    return risk;
  }

  function _decideDirection(execTf, triggerTf, envTf) {
    const trend = _scoreTrend(envTf) + _scoreTrend(execTf);
    const trigger = _scoreTrigger(triggerTf || execTf, execTf);
    const total = trend + trigger;
    if (total >= 2) return 'bullish';
    if (total <= -2) return 'bearish';
    return 'neutral';
  }

  function _candidateForExpiry(expiry, envTf, execTf, triggerTf) {
    if (!(envTf && execTf && triggerTf)) return null;
    // v3.1: 规则算法只计算客观分数，不输出方向/置信度（交给LLM独立判断）
    const trendScore = _scoreTrend(envTf) + _scoreTrend(execTf);
    const triggerScore = _scoreTrigger(triggerTf, execTf);
    const riskScore = _scoreRisk(envTf, execTf, triggerTf);
    const total = trendScore + triggerScore - riskScore;
    const noTradeReasons = [];

    // v3.2 Fix: 环境TF已有明确方向（|envScore|≥3）时属于正常回踩结构，
    // execTf与envTf反向是"回踩入场"的特征，不应判为"方向不明确"。
    // 只有envTf本身也没有明确方向时，合并trendScore低才算真正的多空均衡。
    const _envScore = _scoreTrend(envTf);
    const _isEnvStrong = Math.abs(_envScore) >= 3;
    if (!_isEnvStrong && Math.abs(trendScore) < 2 && Math.abs(triggerScore) < 1) noTradeReasons.push('多空力量均衡，方向不明确');
    if (isFinite(execTf.adx) && execTf.adx < 14 && expiry <= 10) noTradeReasons.push('执行周期ADX过低');
    if (isFinite(triggerTf.volRatio) && triggerTf.volRatio < 0.75 && expiry <= 10) noTradeReasons.push('触发量能不足');
    if (isFinite(triggerTf.bbw) && triggerTf.bbw < 1.2 && expiry <= 10) noTradeReasons.push('波动率压缩过窄');
    // v3.8.3: 趋势市riskScore基数低（最多2分），不会触发此条；震荡市才触发
    const _isTrendEnv = isFinite(envTf && envTf.adx) && envTf.adx >= 24;
    if (riskScore >= 3 && !_isTrendEnv) noTradeReasons.push('震荡市噪音/波动过高，方向不明确');
    if (riskScore >= 2 && _isTrendEnv) noTradeReasons.push('整数关口或ADX偏低，注意回踩深度');
    if (isFinite(execTf.dist && execTf.dist.roundLevel_atr) && Math.abs(execTf.dist.roundLevel_atr) <= 0.12) noTradeReasons.push('过近整数关口');

    // v3.3 反向触发信号检测（修复回踩入场场景）：
    // 原逻辑：trendScore 与 triggerScore 方向相反 → 禁止追方向
    // 问题：envTf 强势趋势（|envScore|≥3）时，1M 出现逆势信号恰恰是回踩结束、顺势入场的最佳时机。
    //       原逻辑把"强趋势+1M回踩金叉"判为禁入，导致分析师只能在追势最深处入场 → 30%胜率。
    // 修复：envTf 强势时豁免 anti_trigger 判定，只有趋势不明确时才视为真正的方向冲突。
    const _antiEnvScore = _scoreTrend(envTf);
    const _antiEnvStrong = Math.abs(_antiEnvScore) >= 3; // envTf 明确趋势 → 1M逆势=回踩，不是禁入
    const antiTriggerScore = _antiEnvStrong ? 0          // 强趋势回踩：豁免，由LLM判断入场时机
                           : (trendScore < -1 && triggerScore > 0) ? triggerScore
                           : (trendScore >  1 && triggerScore < 0) ? -triggerScore
                           : 0;
    if (antiTriggerScore > 0) {
      const msg = trendScore < 0
        ? '触发TF出现超卖/反弹信号（StochRSI金叉/MACD金叉），趋势不明确时追空面临反弹风险'
        : '触发TF出现超买/回调信号（StochRSI死叉/MACD死叉），趋势不明确时追多面临回调风险';
      noTradeReasons.push(msg);
    }

    // trendBias 保留给LLM参考（描述性，非决策性）
    const trendDesc    = trendScore >= 2 ? '多方占优' : trendScore <= -2 ? '空方占优' : '多空拉锯';
    const triggerDesc  = triggerScore >= 1 ? '触发信号偏多' : triggerScore <= -1 ? '触发信号偏空' : '触发中性';
    const antiTrigDesc = antiTriggerScore > 0 ? (trendScore < 0 ? '⚠️方向冲突:超卖反弹信号' : '⚠️方向冲突:超买回调信号')
                       : (_antiEnvStrong && triggerScore !== 0) ? (trendScore < 0 ? '📌回踩入场:1M超卖反弹' : '📌回踩入场:1M超买回调') : '';
    return {
      expiry,
      label: expiry + 'M',
      trend_score: trendScore,
      trigger_score: triggerScore,
      anti_trigger_score: antiTriggerScore,   // v3.2: >0表示触发方向与趋势方向相反，禁止追方向
      risk_score: riskScore,
      total_score: total,
      marketState: envTf.marketState || execTf.marketState || '不明',
      env_tf: envTf.tf,
      exec_tf: execTf.tf,
      trigger_tf: triggerTf.tf,
      no_trade_reasons: noTradeReasons,
      summary: '趋势分=' + trendScore + '(' + trendDesc + ')，触发分=' + triggerScore + '(' + triggerDesc + ')' + (antiTrigDesc ? '，' + antiTrigDesc : '') + '，风险分=' + riskScore + (noTradeReasons.length ? '，注意=' + noTradeReasons.join('/') : '')
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  v3.12 模块B：相位引擎
  //  输入特征池，判定"这一段走到哪了"，输出相位+回踩/反转判别+顺势力度+期限。
  //  优先级：力竭区(防在底部追) > 回踩结束(强顺势) > 回踩进行(判回踩/反转) > 推进段。
  //  三件套：swing骨架(段在不在/坏没坏) + 量能(真假续航) + 动能(拐点提前量)。
  // ══════════════════════════════════════════════════════════════════
  function _phaseEngine(pool) {
    // v3.13 重写（依五本书核心：趋势延续/回踩/反转 由 斜率结构+动能+量能 三维加权投票决定）
    //   关键修复：方向不再死锁在15M/30M。高周期=背景偏向(顺风/逆风)；执行周期(5M)解析"当前可交易方向"。
    //   执行周期决定性逆背景(结构破位/放量同向+合力强) → 反转确认，顺执行周期方向(可反手)。
    //   回踩"进行中"=观望(等结束)，回踩"结束"=强顺势(短周期可入)。不搞硬共振，用加权分竞争。
    const res = { confirmed: false, trendDir: null, bgDir: null, tradeDir: null,
                  phase: 'none', retraceType: null, contBias: 0, suppress: false,
                  suggestExpiry: null, evidence: [], label: '', scores: null, trendSign: 0 };
    if (!pool) return res;
    const f1 = pool['1m'], f5 = pool['5m'], f15 = pool['15m'], f30 = pool['30m'];
    if (!f15 || !f30 || !(f5 || f1)) { res.label = '数据不足'; return res; }
    const biasSign = (tb) => tb === 'bullish' ? 2 : tb === 'mild_bullish' ? 1
                          : tb === 'bearish' ? -2 : tb === 'mild_bearish' ? -1 : 0;

    // ── 背景偏向(15M+30M)：决定顺风/逆风，不再独占方向 ──
    const s15 = biasSign(f15.trendBias), s30 = biasSign(f30.trendBias);
    const bgSign = s15 + s30;
    const bgDir = bgSign >= 3 ? 'bullish' : bgSign > 0 ? 'mild_bullish'
                : bgSign <= -3 ? 'bearish' : bgSign < 0 ? 'mild_bearish' : 'neutral';
    res.bgDir = bgDir;

    const ex = f5 || f1;   // 执行周期(主)：结构/动能/量能
    const tr = f1 || f5;   // 触发周期(辅)：即时确认
    const sw = ex.swing || {};
    const fl = ex.triggerFlags || [];
    const flT = tr.triggerFlags || [];
    const moveUp = (ex.barsDirection3 === 'up' || ex.barsDirection3 === 'mostly_up');
    const moveDn = (ex.barsDirection3 === 'down' || ex.barsDirection3 === 'mostly_down');

    // ════ 三维加权评分(正=多/负=空)：斜率结构 S + 动能 M + 量能 V ════
    // ① 斜率/结构 S —— Brooks "always-in" 骨架，权重最高（趋势方向以结构为准，动能只做修正）
    let S = 0; const sEv = [];
    if (sw.structure === 'up') { S += 2; sEv.push('5M结构HH/HL'); }
    else if (sw.structure === 'down') { S -= 2; sEv.push('5M结构LH/LL'); }
    if (ex.barsDirection5 === 'up') S += 2;
    else if (ex.barsDirection5 === 'mostly_up') S += 1;
    else if (ex.barsDirection5 === 'down') S -= 2;
    else if (ex.barsDirection5 === 'mostly_down') S -= 1;
    // v3.13.6：trendBias 的 mild 档也给分（上涨/下跌初段最常见，原来只认 bullish/bearish 导致初段丢分）
    if (ex.trendBias === 'bullish') S += 1.5;
    else if (ex.trendBias === 'mild_bullish') S += 1;
    else if (ex.trendBias === 'bearish') S -= 1.5;
    else if (ex.trendBias === 'mild_bearish') S -= 1;
    // v3.13.6：价格相对 EMA8/EMA21 的即时位置——最快反映当下斜向，补结构滞后
    if (isFinite(ex.ema9) && isFinite(ex.ema21)) {
      if (ex.price > ex.ema9 && ex.ema9 >= ex.ema21) { S += 1; sEv.push('价>EMA8>EMA21(即时偏多)'); }
      else if (ex.price < ex.ema9 && ex.ema9 <= ex.ema21) { S -= 1; sEv.push('价<EMA8<EMA21(即时偏空)'); }
    }
    if (sw.brokePrevLow)  { S -= 1; sEv.push('跌破前低'); }
    if (sw.brokePrevHigh) { S += 1; sEv.push('升破前高'); }
    if (sw.slopeFlatten)  { S = S * 0.6; sEv.push('斜率走平'); }

    // ② 动能 M —— 拐点提前量（降权：动能滞后，只做修正不主导方向）
    let M = 0; const mEv = [];
    // v3.13.6：MACD 柱绝对符号滞后严重（上涨初段柱常还是负），权重砍半，避免把结构方向带反
    if (isFinite(ex.macdHist)) M += ex.macdHist > 0 ? 0.5 : ex.macdHist < 0 ? -0.5 : 0;
    if (isFinite(ex.rsi)) { if (ex.rsi > 55) M += 1; else if (ex.rsi < 45) M -= 1; }
    if (ex.momDivergence === 'bear' || tr.momDivergence === 'bear') { M -= 1; mEv.push('顶背离'); }
    if (ex.momDivergence === 'bull' || tr.momDivergence === 'bull') { M += 1; mEv.push('底背离'); }
    const st = tr.stochTurn || ex.stochTurn;
    if (st === 'up_from_oversold') { M += 1; mEv.push('StochRSI超卖金叉'); }
    else if (st === 'down_from_overbought') { M -= 1; mEv.push('StochRSI超买死叉'); }
    else if (st === 'cross_up') M += 0.5;
    else if (st === 'cross_down') M -= 0.5;
    // v3.13.6：动能与结构冲突时，限制动能反向幅度——结构(Brooks)说了算，动能不能压过结构定方向
    if (S > 0 && M < 0) M = Math.max(M, -1.5);
    else if (S < 0 && M > 0) M = Math.min(M, 1.5);

    // ③ 量能 V —— VPA：确认当前这一段移动是否有量支撑（放量同向=真，缩量=无需求/无供给）
    let V = 0; const vEv = [];
    if (ex.volRegime === 'expanding') {
      if (moveUp) { V += 1.5; vEv.push('放量推升'); }
      else if (moveDn) { V -= 1.5; vEv.push('放量下杀'); }
    } else if (ex.volRegime === 'contracting') {
      if (moveUp) { V -= 0.5; vEv.push('上涨缩量(无需求)'); }
      else if (moveDn) { V += 0.5; vEv.push('下跌缩量(抛压减弱)'); }
    }
    if (isFinite(ex.obvSlope)) V += ex.obvSlope > 0 ? 0.5 : ex.obvSlope < 0 ? -0.5 : 0;

    const opScore = Number((S + M + V).toFixed(1));   // 执行周期"可交易方向"合力
    const opDir = opScore >= 2.5 ? 'bullish' : opScore <= -2.5 ? 'bearish' : 'neutral';
    res.scores = { S: Number(S.toFixed(1)), M: Number(M.toFixed(1)), V: Number(V.toFixed(1)), op: opScore, bg: bgSign };

    // ════ v3.13.2 纯剥头皮模式（Volman：执行周期定方向，大周期只作顺风/逆风加减分，绝不否决）════
    //   方向 = 执行周期合力 opDir（|op|≥2.5 直接定向）。大周期 bgDir 只调 contBias(置信)与期限：
    //   顺风→加分、可短打；逆风→方向照给但缩期限/降注；大周期中性→纯看执行周期。
    const bgUp = bgSign > 0;
    const bgNeutral = bgDir === 'neutral';
    const tailwind = !bgNeutral && ((bgUp && opDir === 'bullish') || (!bgUp && opDir === 'bearish'));
    const headwind = !bgNeutral && ((bgUp && opDir === 'bearish') || (!bgUp && opDir === 'bullish'));
    const upMove = opDir === 'bullish';

    // 力竭料（仅在合力很强且已伸展到极值时短暂观望，防接最后一棒；剥头皮门槛放宽）
    const dEma = ex.dist && isFinite(ex.dist.ema21_atr) ? ex.dist.ema21_atr : null;
    const stretch = dEma != null && (upMove ? dEma >= 2.0 : dEma <= -2.0);
    const bbP = isFinite(ex.bbPct) ? ex.bbPct : (isFinite(tr.bbPct) ? tr.bbPct : null);
    const atExtreme = bbP != null && (upMove ? bbP >= 0.9 : bbP <= 0.1);
    const exhaustSignals = [];
    if (upMove) {
      if (ex.momDivergence === 'bear' || tr.momDivergence === 'bear') exhaustSignals.push('顶背离');
      if (st === 'down_from_overbought') exhaustSignals.push('StochRSI超买死叉');
    } else if (opDir === 'bearish') {
      if (ex.momDivergence === 'bull' || tr.momDivergence === 'bull') exhaustSignals.push('底背离');
      if (st === 'up_from_oversold') exhaustSignals.push('StochRSI超卖金叉');
    }
    if (sw.slopeFlatten) exhaustSignals.push('斜率走平');

    const setDir = (d) => { res.trendDir = d; res.tradeDir = d; res.trendSign = d === 'bullish' ? 1 : d === 'bearish' ? -1 : 0; };

    // v3.13.9 前方空间闸（Volman整数关口/阻力墙 + 做市商"勿买在墙下"）：
    //   顺势方向前方最近阻挡(前高/前低/整数位)若太近，价格几乎无运行空间 → 追该方向=接盘。
    const _d = ex.dist || {};
    const fwdRaw = upMove
      ? [_d.prevHigh_atr, _d.roundLevel_atr, _d.bbUpper_atr]
      : [_d.prevLow_atr, _d.roundLevel_atr, _d.bbLower_atr];
    const fwdRoomList = fwdRaw.filter(v => isFinite(v))
      .filter(v => upMove ? v > 0 : v < 0)
      .map(v => Math.abs(v));
    const fwdRoom = fwdRoomList.length ? Math.min.apply(null, fwdRoomList) : null;
    const noRoom = fwdRoom != null && fwdRoom <= 0.5;       // v3.16 贴脸阻挡放宽：≤0.5ATR(原0.3几乎不触发)
    const tightRoom = fwdRoom != null && fwdRoom <= 0.8;     // 空间偏小：≤0.8ATR
    res.fwdRoom = fwdRoom;

    // ════ v3.16 修复①：趋势市"追最后一棒"闸（晚入场是趋势市33%胜率的主因）════
    //   ADX≥25 成熟趋势 + 价格已伸展(离EMA21≥1.5ATR) + 无"回撤结束"新鲜反向确认
    //   (StochRSI转回/背离/反包/拒绝针/破前高低) → 这是追最后一棒，按五本书"回撤结束才入场"应观望。
    //   仍有新鲜确认→照常入场(不误伤健康回撤后顺势/突破创新高)；不设op上限——
    //   op越高=趋势越成熟越拥挤越伸展，正是最该等回撤的晚入场区(若仍在创新高brokePrevHigh则算新鲜确认不拦)。
    const adxEx = isFinite(ex.adx) ? ex.adx : null;
    const matureTrend = adxEx != null && adxEx >= 25;
    const stretchMild = dEma != null && (upMove ? dEma >= 1.5 : dEma <= -1.5);
    const freshPullbackEnd = upMove
      ? ((st === 'up_from_oversold') || ex.momDivergence === 'bull' || tr.momDivergence === 'bull'
         || ex.engulfing === 'bullish' || tr.engulfing === 'bullish'
         || ex.pinBar === 'bullish_pin' || tr.pinBar === 'bullish_pin' || sw.brokePrevHigh)
      : ((st === 'down_from_overbought') || ex.momDivergence === 'bear' || tr.momDivergence === 'bear'
         || ex.engulfing === 'bearish' || tr.engulfing === 'bearish'
         || ex.pinBar === 'bearish_pin' || tr.pinBar === 'bearish_pin' || sw.brokePrevLow);
    const lateChase = matureTrend && stretchMild && !freshPullbackEnd;

    // ════ v3.16 修复②：逆"强背景"反手接飞刀闸 ════
    //   执行周期逆15M+30M强一致背景(|bg|≥4)反手，却无结构破位/无放量确认，且合力不强(|op|<3.5)
    //   → 接飞刀(烂信号)，观望；等结构破位或放量确认再反手。
    const flippedConfirm = sw.brokePrevLow || sw.brokePrevHigh || ex.volRegime === 'expanding';
    const counterKnife = headwind && !flippedConfirm && Math.abs(bgSign) >= 4 && Math.abs(opScore) < 3.5;

    // ════ v3.16.4 修复P0(审计维度1/4)：强ADX追势撞动能极值闸 ════
    //   强ADX(≥30)趋势里顺势追单，却把单子追进动能极值：看跌时已超卖(卖在地板)/看涨时已超买(买在墙上)，
    //   且无回撤结束的新鲜反向确认 → 这就是审计里 impulse|ADX≥30 连败(0/6,追空进超卖反弹)的根因。观望。
    //   有新鲜确认(破位/反包/动能转回)则照常入场，不误伤；只拦"撞极值+无确认"的接盘单。
    const adxStrong = adxEx != null && adxEx >= 30;
    const stochK = isFinite(ex.stochK) ? ex.stochK : null;
    const intoOversold   = !upMove && ((stochK != null && stochK <= 20) || (isFinite(ex.rsi) && ex.rsi <= 35) || (bbP != null && bbP <= 0.1));
    const intoOverbought =  upMove && ((stochK != null && stochK >= 80) || (isFinite(ex.rsi) && ex.rsi >= 65) || (bbP != null && bbP >= 0.9));
    const chaseExtreme = adxStrong && (intoOversold || intoOverbought) && !freshPullbackEnd;

    if (opDir === 'neutral') {
      // 执行周期合力不足 → 真没方向，观望（剥头皮唯一的方向性观望）
      res.confirmed = false; res.phase = 'unclear';
      res.trendDir = null; res.tradeDir = null; res.trendSign = 0; res.suggestExpiry = null;
      res.evidence = ['执行周期合力不足(op=' + opScore + ')，无明确方向'];
      res.label = '方向不清(观望)';
    } else if (Math.abs(opScore) >= 4 && (atExtreme || stretch) && exhaustSignals.length >= 1) {
      // 力竭：合力强 + 已伸展到极值 + ≥1项衰竭 → 观望防接最后一棒（v3.16：衰竭信号2→1，更早拦力竭）
      res.confirmed = true; res.phase = 'exhaustion'; res.suppress = true;
      res.trendDir = opDir; res.tradeDir = null; res.trendSign = 0;
      res.contBias = 0; res.suggestExpiry = null;
      res.evidence = ['伸展到极值'].concat(exhaustSignals);
      res.label = '力竭区(短暂观望，防接最后一棒)';
    } else if (lateChase) {
      // v3.16 修复①：趋势已伸展但无回撤结束确认 → 追最后一棒，观望等回撤结束反向确认再顺势入
      res.confirmed = true; res.phase = 'late_chase'; res.suppress = true;
      res.trendDir = opDir; res.tradeDir = null; res.trendSign = 0;
      res.contBias = 0; res.suggestExpiry = null;
      res.evidence = ['趋势市(ADX=' + (adxEx != null ? adxEx.toFixed(0) : '?') + ')已伸展'
                      + (dEma != null ? dEma.toFixed(1) : '?') + 'ATR离EMA21',
                      '无回撤结束确认，追=接最后一棒',
                      '等回撤结束(反向拒绝针/反包/动能转回)再顺势入'];
      res.label = '趋势伸展无确认(观望，等回撤结束)';
    } else if (chaseExtreme) {
      // v3.16.4 修复P0：强ADX追势撞动能极值(看跌进超卖/看涨进超买)且无回撤结束确认 → 卖在地板/买在墙上，观望
      res.confirmed = true; res.phase = 'chase_extreme'; res.suppress = true;
      res.trendDir = opDir; res.tradeDir = null; res.trendSign = 0;
      res.contBias = 0; res.suggestExpiry = null;
      res.evidence = ['强ADX(' + (adxEx != null ? adxEx.toFixed(0) : '?') + ')追势但'
                      + (upMove ? '已超买(买在墙上)' : '已超卖(卖在地板)'),
                      '无回撤结束确认，追=接盘', '等回撤结束反向确认再顺势'];
      res.label = (upMove ? '追多进超买' : '追空进超卖') + '(观望，勿接盘)';
    } else if (counterKnife) {
      // v3.16 修复②：逆强背景反手但无破位/放量确认 → 接飞刀，观望
      res.confirmed = true; res.phase = 'counter_knife'; res.suppress = true;
      res.trendDir = opDir; res.tradeDir = null; res.trendSign = 0;
      res.contBias = 0; res.suggestExpiry = null;
      res.evidence = ['逆强背景(bg=' + bgSign + ')反手但无破位/放量确认',
                      '合力不足(op=' + opScore + ')，接飞刀风险', '等破位/放量确认再反手'];
      res.label = '逆强背景反手无确认(观望，勿接飞刀)';
    } else if (noRoom && Math.abs(opScore) < 6) {
      // v3.13.9 前方空间闸：顺势方向前方≤0.3ATR就有阻挡(前高/前低/整数位)，且信号不强 →
      //   追该方向=买在墙下/卖在地板上，几乎无空间，极易被拒回落 → 观望。
      res.confirmed = false; res.phase = 'no_room'; res.suppress = true;
      res.trendDir = opDir; res.tradeDir = null; res.trendSign = 0; res.suggestExpiry = null;
      res.evidence = ['顺势方向前方仅' + fwdRoom.toFixed(2) + 'ATR即遇阻挡', '空间不足，追=接盘'];
      res.label = '空间不足(贴阻力/支撑，观望)';
    } else {
      // 正常：执行周期方向直接成交。大周期只调 contBias 与期限。
      setDir(opDir);
      res.confirmed = true;
      if (tailwind) {
        res.phase = 'impulse'; res.contBias = 2;
        res.evidence = ['执行周期' + (upMove ? '多' : '空') + '(op=' + opScore + ')', '大周期顺风'].concat(sEv.slice(0, 1));
        res.label = '顺风推进(执行周期主导)';
      } else if (headwind) {
        // 逆大周期 = 典型剥头皮反手/反转单：方向照给，缩期限快进快出
        const flipped = sw.brokePrevLow || sw.brokePrevHigh || ex.volRegime === 'expanding';
        res.phase = flipped ? 'reversal_confirmed' : 'counter_scalp';
        res.retraceType = 'reversal'; res.contBias = 1;
        res.evidence = ['执行周期' + (upMove ? '多' : '空') + '(op=' + opScore + ')',
                        '逆大周期(背景' + (bgUp ? '涨' : '跌') + ')'].concat(mEv.slice(0, 1));
        res.label = flipped ? '反转确认(执行周期破位/放量，逆大周期反手)' : '逆风剥头皮(执行周期主导)';
      } else {
        // 大周期中性：纯看执行周期
        res.phase = 'impulse'; res.contBias = 2;
        res.evidence = ['执行周期' + (upMove ? '多' : '空') + '(op=' + opScore + ')', '大周期中性'];
        res.label = '执行周期主导(大周期中性)';
      }
    }

    // ════ 动态到期周期引擎（书的核心：测量移动 measured move + 动能续航 + 波动率）════
    //   到期时长 = 这段方向"能维持多久"的时间投影，与方向同等重要，不锁死。
    //   依据：①动能续航(|op|越强→走得越久→可长) ②波动率(ATR/bbw大→快速兑现→宜短)
    //         ③到关键位距离(measured move：目标位近→短，远→长) ④入场类型(反转/逆风→快进快出→短)
    if (res.tradeDir) {
      res.suggestExpiry = _expiryEngine(res, ex, tr, { tailwind: tailwind, headwind: headwind, opScore: opScore, upMove: upMove });
    } else {
      res.suggestExpiry = null;
    }
    return res;
  }

  // 动态到期引擎：输出 5/10/15/30 之一。四档平权，纯按 动能续航+波动率+前方空间 决定，
  //   不预设偏短或偏长，不因顺逆大周期而锁定（方向与期限是独立维度）。
  function _expiryEngine(res, ex, tr, ctx) {
    const support = ['5', '10', '15', '30'];   // 平台支持的到期(分钟)
    let score = 0;   // 越大→越长期限；越小→越短
    const why = [];

    // ① 动能续航：|op| 合力越强，趋势越能延续，可给更长到期
    const absOp = Math.abs(ctx.opScore);
    if (absOp >= 8)      { score += 2; why.push('动能极强'); }
    else if (absOp >= 6) { score += 1.5; why.push('动能强'); }
    else if (absOp >= 4) { score += 0.5; }
    else                 { score -= 0.5; why.push('动能一般'); }

    // ② 波动率(measured move 的速度)：ATR/价格 越大，价格兑现越快 → 宜短
    const atrPct = (isFinite(ex.atr) && isFinite(ex.price) && ex.price > 0) ? ex.atr / ex.price * 100 : null;
    if (atrPct != null) {
      if (atrPct >= 0.35)      { score -= 1.5; why.push('波动大(快速兑现→短)'); }
      else if (atrPct >= 0.2)  { score -= 0.5; }
      else                     { score += 1; why.push('波动小(需时间→长)'); }
    }
    // bbw 极窄(挤压)：突破后常有持续行情，可略长
    if (isFinite(ex.bbw) && ex.bbw < 0.8) { score += 0.5; why.push('带宽窄(蓄势)'); }

    // ③ 到关键位距离(measured move 目标)：顺势方向前方最近阻挡有多远(ATR)
    const d = ex.dist || {};
    const fwd = ctx.upMove
      ? [d.prevHigh_atr, d.roundLevel_atr, d.bbUpper_atr]   // 做多看上方阻力(正值=在上方)
      : [d.prevLow_atr, d.roundLevel_atr, d.bbLower_atr];   // 做空看下方支撑(负值=在下方)
    const fwdDists = fwd.filter(v => isFinite(v)).map(v => Math.abs(v)).filter(v => v > 0.05);
    if (fwdDists.length) {
      const nearest = Math.min.apply(null, fwdDists);
      if (nearest <= 0.5)    { score -= 3; why.push('目标位极近(' + nearest.toFixed(1) + 'ATR→强制短)'); }
      else if (nearest <= 1) { score -= 1.5; why.push('目标位近(' + nearest.toFixed(1) + 'ATR→短)'); }
      else if (nearest >= 3) { score += 1.5; why.push('空间大(' + nearest.toFixed(1) + 'ATR→长)'); }
    }

    // ④ 入场类型：仅"明确反转/回踩反手"节奏快→适度偏短；逆大周期本身不压短(逆风也可能有大空间，
    //    期限由空间+动能决定，不由顺逆背景预设——符合"高周期不限制期限")。
    if (res.phase === 'reversal_confirmed' || res.phase === 'counter_scalp') {
      score -= 1; why.push('反转/反手(节奏快→偏短)');
    } else if (ctx.tailwind) {
      score += 0.5;
    }
    // 力竭附近(伸展)即使做也要短
    const dEma = ex.dist && isFinite(ex.dist.ema21_atr) ? ex.dist.ema21_atr : null;
    if (dEma != null && Math.abs(dEma) >= 1.8) { score -= 1; why.push('已伸展→短'); }

    // 映射到档位：score → 5/10/15/30
    let idx;
    if (score <= -1.5)     idx = 0; // 5M
    else if (score < 1)    idx = 1; // 10M
    else if (score < 2.5)  idx = 2; // 15M
    else                   idx = 3; // 30M
    res.expiryWhy = why.join('、') || '中性';
    return parseInt(support[idx]);
  }

  function _buildBinaryFeaturePayload(symbol) {
    const buf1m = _bnBuffers['1m'];
    if (!buf1m || buf1m.length < 60) return null;
    const tfBuffers = {
      '1m': buf1m,
      '5m': _resample(buf1m, 5),
      '10m': _resample(buf1m, 10),
      // v3.9: 优先使用 REST 直接拉取的原始数据，兜底才降采样
      '15m': _bnBuffers['15m'].length >= 20 ? _bnBuffers['15m'] : _resample(buf1m, 15),
      '30m': _bnBuffers['30m'].length >= 20 ? _bnBuffers['30m'] : _resample(buf1m, 30),
      '1h': _bnBuffers['1h'] || []
    };
    const featurePool = {};
    Object.keys(tfBuffers).forEach(tf => {
      const feat = _computeTfFeature(tf, tfBuffers[tf]);
      if (feat) featurePool[tf] = feat;
    });
    if (!featurePool['1m'] || !featurePool['5m']) return null;

    const candidates = [];
    // v3.6 修复：c5 环境周期从5m改为15m，确保5分钟期限有高周期过滤
    const c5 = _candidateForExpiry(5, featurePool['15m'] || featurePool['10m'] || featurePool['5m'], featurePool['1m'], featurePool['1m']);
    const c10 = _candidateForExpiry(10, featurePool['15m'] || featurePool['10m'] || featurePool['5m'], featurePool['5m'], featurePool['1m']);
    // v3.7: c15 exec改为15m，trigger改为5m，真正代表15分钟视角（原与c10共享5m数据等于重复信号）
    const c15 = _candidateForExpiry(15, featurePool['30m'] || featurePool['1h'] || featurePool['15m'], featurePool['15m'] || featurePool['5m'], featurePool['5m'] || featurePool['1m']);
    const c30 = _candidateForExpiry(30, featurePool['30m'] || featurePool['1h'] || featurePool['15m'], featurePool['15m'] || featurePool['5m'], featurePool['5m']);
    [c5, c10, c15, c30].forEach(c => { if (c) candidates.push(c); });
    if (!candidates.length) return null;

    // v3.13：相位引擎前移到 best 排序之前，供 best 初选服从相位（防力竭追顶被排第一）。
    const _phase = _phaseEngine(featurePool);

    // best_candidate 排序逻辑（仅作期限初选）
    // v3.13 (决策层G6初选)：best 必须服从相位——
    //   力竭/反转相位重罚高 total_score 候选(防把追顶/追底排第一)；
    //   健康回撤奖励长期限候选(15/30M 扛回撤)。
    const best = candidates.slice().sort((a, b) => {
      const quality = c => {
        let v = c.total_score;
        v -= c.no_trade_reasons.length * 1.5;   // 禁入原因惩罚加重
        if (c.risk_score >= 3) v -= 2;           // 高风险额外惩罚
        if (c.trigger_score > 0) v += 0.5;       // 有触发信号小幅加分
        if (_phase && _phase.suppress) v -= 8;   // 力竭/回踩进行中：重罚高分候选(防追顶底/回踩接刀；真正否决在裁判G0)
        if (_phase && _phase.phase === 'retrace_end' && c.expiry <= 10) v += 1; // 回踩结束：短周期顺势可入
        return v;
      };
      return quality(b) - quality(a);
    })[0];

    const keyLevels = {};
    ['1m', '5m', '10m', '15m', '30m', '1h'].forEach(tf => {
      const f = featurePool[tf];
      if (!f) return;
      keyLevels[tf] = {
        prevHigh: f.prevHigh,
        prevLow: f.prevLow,
        roundLevel: f.roundLevel,
        ema21: f.ema21,
        ema55: f.ema55,
        vwap: f.vwap
      };
    });

    // v3.10: 计算三层评分
    const _bias1h    = _score1hBias();
    const _sig15m    = _score15mSignal(featurePool['15m']);
    const _trig5m    = _score5mTrigger(featurePool['5m'] || featurePool['1m'], featurePool['1m']);
    const _vetoes    = _hardVetoCheck(featurePool['15m'], featurePool['5m'], _bias1h);
    const _baseTotal = _bias1h.score + _sig15m.score + _trig5m.score;

    // v3.12: 相位引擎调整。趋势确认时，按相位对"顺势方向"的总分做加减，
    //   并按相位给期限；力竭/反转相位把延续分压向中性（不反向，只压制）。
    //   （_phase 已在 best 排序前计算，此处复用）
    // v3.13 相位调整：按"可交易方向 tradeDir"(可能反手做空)对总分加减，而非死锁的高周期趋势。
    //   suppress(力竭/回踩进行中)→分数收向中性(观望)；反转确认→朝执行周期方向加分。
    let _totalScore3 = _baseTotal;
    let _phaseNote = '';
    if (_phase.confirmed && _phase.tradeDir) {
      const ts = _phase.trendSign; // tradeDir 的符号：+1看涨 / -1看跌（反转确认时即执行周期方向）
      _totalScore3 = _baseTotal + ts * _phase.contBias;
      _phaseNote = '相位[' + _phase.label + ']→' + (ts > 0 ? '看涨' : '看跌') + '加分' + _phase.contBias
                 + (_phase.scores ? '（执行周期合力op=' + _phase.scores.op + '|S' + _phase.scores.S + '/M' + _phase.scores.M + '/V' + _phase.scores.V + '）' : '');
    } else if (_phase.confirmed && _phase.suppress) {
      // 力竭/回踩进行中：把高周期方向的基础分朝中性收，避免在观望相位仍给强方向分
      const refSign = _phase.trendDir === 'bullish' ? 1 : _phase.trendDir === 'bearish' ? -1 : 0;
      const cut = Math.min(Math.abs(_baseTotal), 3);
      _totalScore3 = _baseTotal - refSign * cut;
      _phaseNote = '相位[' + _phase.label + ']→观望(分数收向中性)';
    } else {
      _phaseNote = _phase.label || '方向不清，相位模型不介入';
    }

    // 期限：完全由动态到期引擎(phase.suggestExpiry)决定，不再有默认锁
    const _expirySuggest = (_phase.confirmed && _phase.suppress)
      ? '观望（相位：' + _phase.label + '）'
      : (_phase.confirmed && _phase.tradeDir && _phase.suggestExpiry)
      ? (_phase.suggestExpiry + '分钟（' + (_phase.expiryWhy || '动能/波动/空间综合') + '）')
      : '观望（信号不足）';

    const layeredScore = {
      bias1h:    _bias1h,
      signal15m: _sig15m,
      trigger5m: _trig5m,
      vetoes:    _vetoes,
      baseTotal: _baseTotal,
      phase:     _phase,          // v3.12 相位判定（confirmed/phase/retraceType/contBias/suppress/evidence/label）
      phaseNote: _phaseNote,
      total:     _totalScore3,
      expirySuggest: _expirySuggest
    };

    const agentViews = {
      historian_focus: '优先比较 相位(layered_score.phase.phase) 与 执行周期合力方向是否相同——力竭/回踩进行中/反转确认/推进相位不同则历史不可比；再比 scores(S/M/V)、量能regime、动能背离、与关键位距离',
      analyst_focus: '判断顺序：①先读 phase。suppress=true(力竭/回踩进行中/late_chase趋势已伸展无回撤结束确认/counter_knife逆强背景反手无确认/chase_extreme强ADX追势撞超卖超买无确认)→倾向观望：late_chase别追最后一棒、chase_extreme别卖在地板/买在墙上、都等回撤结束(反向拒绝针/反包/动能转回)再顺势入；counter_knife别接飞刀、等破位或放量再反手；phase=reversal_confirmed→顺 tradeDir 方向(可反手做空/做多)；phase=retrace_end→顺 tradeDir 强顺势(短周期可入)；phase=impulse→顺势但回撤后入场勿追顶。②方向以 phase.tradeDir 为准(不是高周期背景 bgDir)；tradeDir=null 时观望。③再用 scores 和 feature_pool 确认置信度。相位仅供参考，你若看到明确机会(如已出现回撤结束确认)可独立推翻观望。',
      critic_focus: '核查：①回踩进行中是否被误判为可顺势？②反转确认(reversal_confirmed)的结构破位/放量证据是否成立(有迹可循，非乱反手)？③力竭衰竭证据(背离/缩量/斜率走平)是否齐？④tradeDir 与执行周期 S/M/V 合力是否一致？⑤phase=late_chase/counter_knife(引擎建议观望)时分析师却要入场→核查其是否给出"回撤结束确认/破位放量确认"的具体证据，没有则支持观望(勿接最后一棒/勿接飞刀)。',
      judge_focus: '相位第一权重(参考)：phase.suppress=true(力竭/回踩进行中/late_chase/counter_knife)倾向观望——late_chase=趋势已伸展无回撤结束确认(别追最后一棒)，counter_knife=逆强背景反手无破位/放量(别接飞刀)；方向必须用 phase.tradeDir(可能与高周期相反=反转单)，严禁因"高周期还在涨"就否决执行周期已确认的反转；retrace_end/impulse 顺 tradeDir 放行。相位会机械误判，与你和两位Agent的扎实证据冲突时以人(LLM)为准。'
    };

    return {
      version: 'BINARY_OPTIONS_FEATURES_V3',
      symbol: symbol || 'BTCUSDT',
      generatedAt: Date.now(),
      supported_expiries: [5, 10, 15, 30],
      feature_pool: featurePool,
      expiry_candidates: candidates,
      best_candidate: best,
      key_levels: keyLevels,
      layered_score: layeredScore,
      agent_views: agentViews
    };
  }

  function _buildStructuredTextBundle(symbol) {
    const legacyText = _buildIndicatorText(symbol);
    const payload = _buildBinaryFeaturePayload(symbol);
    if (!payload) return { payload: null, combinedText: legacyText };
    const best = payload.best_candidate || {};
    const candidateLines = (payload.expiry_candidates || []).map(c => {
      const reasons = c.no_trade_reasons && c.no_trade_reasons.length ? ('；注意=' + c.no_trade_reasons.join('、')) : '';
      return '  - ' + c.label + '：趋势分' + c.trend_score + '，触发分' + c.trigger_score + '，风险分' + c.risk_score + '，合计' + c.total_score + reasons;
    }).join('\n');
    const ls = payload.layered_score || {};
    const ls1h  = ls.bias1h    || {};
    const ls15m = ls.signal15m || {};
    const ls5m  = ls.trigger5m || {};
    const lsTotal = ls.total != null ? ls.total : '—';
    const vetoText = ls.vetoes && ls.vetoes.length ? ls.vetoes.join('；') : '无';
    const _ph = ls.phase || {};
    const _bgTxt = _ph.bgDir === 'bullish' ? '看涨' : _ph.bgDir === 'bearish' ? '看跌'
                 : _ph.bgDir === 'mild_bullish' ? '偏多' : _ph.bgDir === 'mild_bearish' ? '偏空' : '中性';
    const _tradeTxt = _ph.tradeDir === 'bullish' ? '看涨' : _ph.tradeDir === 'bearish' ? '看跌' : '—';
    const _scTxt = _ph.scores ? ('执行周期合力op=' + _ph.scores.op + '（斜率结构S' + _ph.scores.S + ' 动能M' + _ph.scores.M + ' 量能V' + _ph.scores.V + '）') : '—';
    const phaseBlock = '\n【相位参考信号（仅供参考，最终由你独立判断，可推翻）】\n' +
      (_ph.confirmed
        ? ('  高周期背景(15M+30M)：' + _bgTxt + '\n' +
           '  ' + _scTxt + '\n' +
           '  规则引擎倾向：' + (_ph.label || _ph.phase) + '\n' +
           '  依据：' + ((_ph.evidence && _ph.evidence.length) ? _ph.evidence.join('、') : '—') + '\n' +
           '  引擎参考意见：' + (_ph.suppress
              ? ('倾向观望——' + (_ph.phase === 'exhaustion' ? '力竭区(防接最后一棒)' : _ph.phase === 'no_room' ? '顺势方向前方空间不足(贴阻力/支撑)' : '方向不清'))
              : ('倾向 ' + _tradeTxt + '｜参考到期 ' + (_ph.suggestExpiry || '—') + '分钟（' + (_ph.expiryWhy || '动能/波动/空间综合') + '）')) +
           '\n  ⚠️这是规则引擎的机械计算，可能误判(如贴阻力追多、把回踩当反转)。请结合下方原始K线与指标自行判断，有不同看法时以你的分析为准并说明理由。\n')
        : ('  ' + (ls.phaseNote || '方向不清') + '（规则引擎参考，可推翻）\n'));

    const summary = phaseBlock + '\n【量化评分（三层打分）】\n' +
      '  1H方向权重：' + (ls1h.score != null ? (ls1h.score > 0 ? '+' : '') + ls1h.score : '—') +
        '（' + (ls1h.label || '—') + '，EMA21=' + (ls1h.ema21 || '—') + ' EMA55=' + (ls1h.ema55 || '—') + '）\n' +
      '  15M信号得分：' + (ls15m.score != null ? (ls15m.score > 0 ? '+' : '') + ls15m.score : '—') +
        '（' + (ls15m.label || '—') + '）' +
        (ls15m.details && ls15m.details.length ? ' ▸ ' + ls15m.details.join(' ') : '') + '\n' +
      '  5M触发得分：' + (ls5m.score != null ? (ls5m.score > 0 ? '+' : '') + ls5m.score : '—') +
        (ls5m.signals && ls5m.signals.length ? ' ▸ ' + ls5m.signals.join(' ') : '') + '\n' +
      '  硬否决项：' + vetoText + '\n' +
      '  总分(已含相位调整)：' + (lsTotal > 0 ? '+' : '') + lsTotal + (ls.phaseNote ? '（' + ls.phaseNote + '）' : '') + '  建议期限参考：' + (ls.expirySuggest || '—') + '\n' +
      '\n【期限候选】\n' + candidateLines + '\n' +
      '  注：以上相位/评分均为规则引擎的【参考信号】，非命令。方向、是否入场、期限由你(分析师LLM)结合原始K线与多周期指标【独立判断】，可推翻引擎倾向，但须说明理由。\n';
    return {
      payload,
      combinedText: legacyText + summary + '\n【BINARY_OPTIONS_FEATURES_V2】' + JSON.stringify(payload) + '【/BINARY_OPTIONS_FEATURES_V2】\n'
    };
  }

  function _safeBuildStructuredBundle(symbol, scope) {
    try {
      return _buildStructuredTextBundle(symbol);
    } catch (e) {
      CtLog.warn(scope || '[structuredBundle]', 'build failed, fallback to legacy indicator text', e && (e.stack || e.message || String(e)));
      let legacyText = '';
      try {
        legacyText = _buildIndicatorText(symbol);
      } catch (inner) {
        CtLog.warn(scope || '[structuredBundle]', 'legacy indicator build also failed', inner && (inner.stack || inner.message || String(inner)));
      }
      return { payload: null, combinedText: legacyText || '' };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  关键事件检测（第一批：8个核心事件）
  // ══════════════════════════════════════════════════════════════════

  function _detectEvents(tf, closes, candles, rsiArr, macdData, adxData, bbData, atrArr, volMA20, obvArr, stochRsiData) {
    const events = [];
    const n = closes.length;
    if (n < 3) return events;

    // ── 1. RSI 中轴穿越（50线）──────────────────────────────────────
    if (rsiArr.length >= 2) {
      const r0 = rsiArr[rsiArr.length - 2];
      const r1 = rsiArr[rsiArr.length - 1];
      if (r0 < 50 && r1 >= 50) events.push({ tf, strength: '强', name: 'RSI 上穿50中轴', detail: `${_fmt(r0)}→${_fmt(r1)}，多头开始主导` });
      if (r0 > 50 && r1 <= 50) events.push({ tf, strength: '强', name: 'RSI 下穿50中轴', detail: `${_fmt(r0)}→${_fmt(r1)}，空头开始主导` });
    }

    // ── 2. RSI 超买超卖钝化（连续≥3根停留在极值区）──────────────────
    if (rsiArr.length >= 3) {
      const recent = _tail(rsiArr, 5);
      const overbought = recent.filter(v => v >= 70).length;
      const oversold   = recent.filter(v => v <= 30).length;
      if (overbought >= 3) events.push({ tf, strength: '中', name: 'RSI 超买钝化', detail: `近${recent.length}根中${overbought}根≥70，强趋势延续，勿逆势空` });
      if (oversold   >= 3) events.push({ tf, strength: '中', name: 'RSI 超卖钝化', detail: `近${recent.length}根中${oversold}根≤30，强趋势延续，勿逆势多` });
    }

    // ── 3. MACD 金叉/死叉（带零轴位置）─────────────────────────────
    if (macdData && macdData.dif.length >= 2 && macdData.dea.length >= 2) {
      const dif = macdData.dif, dea = macdData.dea;
      const d0 = dif[dif.length - 2] - dea[dea.length - 2];
      const d1 = dif[dif.length - 1] - dea[dea.length - 1];
      const curDif = dif[dif.length - 1];
      const zone = curDif > 0 ? '零轴上方' : '零轴下方';
      if (d0 < 0 && d1 >= 0) events.push({ tf, strength: curDif > 0 ? '强' : '中', name: `MACD 金叉（${zone}）`, detail: `DIF=${_fmt(curDif)}，${curDif > 0 ? '强势信号' : '反转初期，强度偏低'}` });
      if (d0 > 0 && d1 <= 0) events.push({ tf, strength: curDif < 0 ? '强' : '中', name: `MACD 死叉（${zone}）`, detail: `DIF=${_fmt(curDif)}，${curDif < 0 ? '强势看跌' : '回调信号，强度偏低'}` });
    }

    // ── 4. MACD 零轴穿越（DIF 正负切换）────────────────────────────
    if (macdData && macdData.dif.length >= 2) {
      const dif = macdData.dif;
      const d0 = dif[dif.length - 2], d1 = dif[dif.length - 1];
      if (d0 < 0 && d1 >= 0) events.push({ tf, strength: '强', name: 'MACD DIF 上穿零轴', detail: `多头格局确立，趋势级别转折` });
      if (d0 > 0 && d1 <= 0) events.push({ tf, strength: '强', name: 'MACD DIF 下穿零轴', detail: `空头格局确立，趋势级别转折` });
    }

    // ── 5. ADX 市场状态切换（25/20 阈值）───────────────────────────
    if (adxData && adxData.adx.length >= 2) {
      const adx = adxData.adx;
      const a0 = adx[adx.length - 2], a1 = adx[adx.length - 1];
      if (a0 < 25 && a1 >= 25) events.push({ tf, strength: '强', name: 'ADX 突破25', detail: `${_fmt(a0)}→${_fmt(a1)}，震荡转趋势，追势策略生效` });
      if (a0 > 20 && a1 <= 20) events.push({ tf, strength: '强', name: 'ADX 跌破20', detail: `${_fmt(a0)}→${_fmt(a1)}，趋势转震荡，趋势策略失效` });
      const cur = a1;
      if (cur > 40) events.push({ tf, strength: '中', name: 'ADX 极端强趋势', detail: `ADX=${_fmt(cur)}，趋势末期，警惕反转` });
      if (cur < 15) events.push({ tf, strength: '中', name: 'ADX 极低（无趋势）', detail: `ADX=${_fmt(cur)}，完全震荡，趋势策略全部失效` });
    }

    // ── 6. 布林带挤压/张开 ──────────────────────────────────────────
    if (bbData && bbData.bw.length >= 20) {
      const bw = bbData.bw;
      const cur = bw[bw.length - 1];
      const hist50 = _tail(bw, 50);
      const minBw = Math.min(...hist50);
      const maxBw = Math.max(...hist50);
      const range = maxBw - minBw;
      if (range > 0) {
        const pct = (cur - minBw) / range;
        if (pct <= 0.1) events.push({ tf, strength: '强', name: '布林带挤压', detail: `带宽${_fmt(cur)}%处于近50根最低10%，突破临近，方向待定` });
        if (pct >= 0.85 && bw.length >= 2 && bw[bw.length - 2] < bw[bw.length - 1]) {
          events.push({ tf, strength: '中', name: '布林带张开（喇叭口）', detail: `带宽${_fmt(cur)}%快速扩张，突破已启动` });
        }
      }
    }

    // ── 7. 放量突破 ─────────────────────────────────────────────────
    if (candles.length >= 21 && volMA20 !== null) {
      const cur = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const volRatio = cur.v / volMA20;
      if (volRatio >= 1.5 && cur.c > prev.h) {
        events.push({ tf, strength: '强', name: '放量向上突破', detail: `量比${_fmt(volRatio)}x，价格突破前高，有效突破信号` });
      }
      if (volRatio >= 1.5 && cur.c < prev.l) {
        events.push({ tf, strength: '强', name: '放量向下突破', detail: `量比${_fmt(volRatio)}x，价格跌破前低，有效跌破信号` });
      }
      if (cur.c > prev.c && volRatio < 0.6) {
        events.push({ tf, strength: '弱', name: '缩量上涨', detail: `量比${_fmt(volRatio)}x，动能衰竭警告` });
      }
    }

    // ── 8. ATR 异常扩张 ─────────────────────────────────────────────
    if (atrArr.length >= 20) {
      const cur = atrArr[atrArr.length - 1];
      const ma20 = _tail(atrArr, 20).reduce((a, b) => a + b, 0) / 20;
      if (cur > ma20 * 1.5) {
        events.push({ tf, strength: '中', name: 'ATR 异常扩张', detail: `当前ATR是近20根均值的${_fmt(cur / ma20)}x，波动率突变，警惕重大行情` });
      }
    }

    // ── 9. OBV 背离检测 ─────────────────────────────────────────────
    // 用近6根窗口：价格方向与OBV方向相反 → 背离信号
    if (obvArr && obvArr.length >= 6 && closes.length >= 6) {
      const priceUp = closes[closes.length - 1] > closes[closes.length - 6];
      const obvUp   = obvArr[obvArr.length - 1]  > obvArr[obvArr.length - 6];
      if (priceUp && !obvUp)
        events.push({ tf, strength: '中', name: 'OBV 顶背离', detail: `近6根价格上涨但OBV下降，上涨缺乏量能支撑，警惕回落` });
      if (!priceUp && obvUp)
        events.push({ tf, strength: '中', name: 'OBV 底背离', detail: `近6根价格下跌但OBV上升，抛压减弱，关注反弹机会` });
    }

    // ── 10. StochRSI 超买/超卖区金叉/死叉 ──────────────────────────
    if (stochRsiData && stochRsiData.k.length >= 2 && stochRsiData.d.length >= 2) {
      const sk = stochRsiData.k, sd = stochRsiData.d;
      const k0 = sk[sk.length - 2], k1 = sk[sk.length - 1];
      const d0 = sd[sd.length - 2], d1 = sd[sd.length - 1];
      // 超卖区金叉（≤20）—— 最强买入信号
      if (k0 < d0 && k1 >= d1 && k1 <= 20)
        events.push({ tf, strength: '强', name: 'StochRSI 超卖金叉', detail: `%K=${_fmt(k1)} 上穿 %D=${_fmt(d1)}，超卖区（≤20），强反弹信号` });
      // 超买区死叉（≥80）—— 最强卖出信号
      else if (k0 > d0 && k1 <= d1 && k1 >= 80)
        events.push({ tf, strength: '强', name: 'StochRSI 超买死叉', detail: `%K=${_fmt(k1)} 下穿 %D=${_fmt(d1)}，超买区（≥80），强回调信号` });
      // 中性区金叉/死叉 —— 中等信号
      else if (k0 < d0 && k1 >= d1 && k1 > 20 && k1 < 80)
        events.push({ tf, strength: '中', name: 'StochRSI 中性金叉', detail: `%K=${_fmt(k1)} 上穿 %D=${_fmt(d1)}，中性区，看涨动能增强` });
      else if (k0 > d0 && k1 <= d1 && k1 > 20 && k1 < 80)
        events.push({ tf, strength: '中', name: 'StochRSI 中性死叉', detail: `%K=${_fmt(k1)} 下穿 %D=${_fmt(d1)}，中性区，看跌动能增强` });
    }

    return events;
  }

  // ══════════════════════════════════════════════════════════════════
  //  多周期指标计算 + 格式化为 LLM 可读文本
  // ══════════════════════════════════════════════════════════════════

  function _buildIndicatorText(symbol) {
    const buf1m = _bnBuffers['1m'];
    if (buf1m.length < 30) return '【指标数据】数据不足，请等待历史K线加载完成\n';

    // 降采样生成 5m / 10m / 15m / 30m
    const buf5m  = _resample(buf1m, 5);
    const buf10m = _resample(buf1m, 10);
    // v3.9: 优先使用 REST 直接数据
    const buf15m = _bnBuffers['15m'].length >= 20 ? _bnBuffers['15m'] : _resample(buf1m, 15);
    const buf30m = _bnBuffers['30m'].length >= 20 ? _bnBuffers['30m'] : _resample(buf1m, 30);

    const allEvents = [];
    let text = '';

    // 计算单个周期的指标并生成文本
    function _processTF(label, buf, showOHLC) {
      if (buf.length < 26) return '';
      const closes = buf.map(c => c.c);
      const rsiArr  = _rsi(closes, 14);
      const macdData = _macd(closes);
      const adxData  = _adx(buf, 14);
      const bbData   = _bb(closes, 20, 2);
      const atrArr   = _atr(buf, 14);
      const ema8     = _ema(closes, 8);
      const ema21    = _ema(closes, 21);
      const ema55    = _ema(closes, 55);
      const obvArr       = _obv(buf);
      const vols         = buf.map(c => c.v);
      const volMA20      = vols.length >= 20 ? _tail(vols, 20).reduce((a, b) => a + b, 0) / 20 : null;
      const stochRsiData = _stochRsi(closes, 14, 14, 3, 3);
      const vwapVal      = _vwap(buf);
      const volRatio     = (volMA20 && buf.length) ? buf[buf.length - 1].v / volMA20 : null;

      // 最新值
      const rsi    = rsiArr.length ? rsiArr[rsiArr.length - 1]              : null;
      const e8     = ema8.length   ? ema8[ema8.length - 1]                  : null;
      const e21    = ema21.length  ? ema21[ema21.length - 1]                : null;
      const e55    = ema55.length  ? ema55[ema55.length - 1]                : null;
      const atr    = atrArr.length ? atrArr[atrArr.length - 1]              : null;
      const stochK = stochRsiData  ? stochRsiData.k[stochRsiData.k.length - 1] : null;
      const stochD = stochRsiData  ? stochRsiData.d[stochRsiData.d.length - 1] : null;

      const macdDif  = macdData ? macdData.dif[macdData.dif.length - 1]   : null;
      const macdDea  = macdData ? macdData.dea[macdData.dea.length - 1]   : null;
      const macdHist = macdData ? macdData.hist[macdData.hist.length - 1] : null;

      const adxVal = adxData ? adxData.adx[adxData.adx.length - 1] : null;
      const pdi    = adxData ? adxData.pdi[adxData.pdi.length - 1] : null;
      const mdi    = adxData ? adxData.mdi[adxData.mdi.length - 1] : null;

      const bbBasis = bbData ? bbData.basis[bbData.basis.length - 1] : null;
      const bbUpper = bbData ? bbData.upper[bbData.upper.length - 1] : null;
      const bbLower = bbData ? bbData.lower[bbData.lower.length - 1] : null;
      const bbBW    = bbData ? bbData.bw[bbData.bw.length - 1]       : null;

      // RSI 近12根时序
      const rsiSeq = _tail(rsiArr, 12).map(v => _fmt(v)).join(', ');
      // MACD 柱状图近8根时序
      const histSeq = macdData ? _tail(macdData.hist, 8).map(v => _fmt(v)).join(', ') : '—';

      let out = `【${label}技术指标】\n`;
      if (showOHLC) {
        const c = buf[buf.length - 1];
        out += `  K线: 开${_fmt(c.o, 4)} 高${_fmt(c.h, 4)} 低${_fmt(c.l, 4)} 收${_fmt(c.c, 4)} 量${_fmt(c.v, 2)}\n`;
      }
      out += `  EMA8=${_fmt(e8, 4)}  EMA21=${_fmt(e21, 4)}  EMA55=${_fmt(e55, 4)}\n`;
      out += `  RSI(14)=${_fmt(rsi)}  近12根序列: [${rsiSeq}]\n`;
      out += `  MACD DIF=${_fmt(macdDif)}  DEA=${_fmt(macdDea)}  柱=${_fmt(macdHist)}  近8根柱序列: [${histSeq}]\n`;
      out += `  ADX=${_fmt(adxVal)}  DI+=${_fmt(pdi)}  DI-=${_fmt(mdi)}\n`;
      out += `  BB 上轨=${_fmt(bbUpper, 4)}  中轨=${_fmt(bbBasis, 4)}  下轨=${_fmt(bbLower, 4)}  带宽=${_fmt(bbBW)}%\n`;
      out += `  ATR(14)=${_fmt(atr, 4)}  量比=${volRatio !== null ? _fmt(volRatio) : '—'}x  VWAP=${vwapVal !== null ? _fmt(vwapVal, 4) : '—'}\n`;
      if (stochK !== null && stochD !== null) {
        const _sZone = stochK >= 80 ? '🔴超买区' : stochK <= 20 ? '🟢超卖区' : '中性区';
        const _sPriceDiff = vwapVal !== null ? (closes[closes.length - 1] >= vwapVal ? '价格在VWAP上方↑' : '价格在VWAP下方↓') : '';
        out += `  StochRSI %K=${_fmt(stochK)}  %D=${_fmt(stochD)}  [${_sZone}]  ${_sPriceDiff}\n`;
      }

      // 均线排列判断
      if (e8 !== null && e21 !== null && e55 !== null) {
        const align = e8 > e21 && e21 > e55 ? '多头排列↑' : e8 < e21 && e21 < e55 ? '空头排列↓' : '混乱/交叉';
        out += `  均线排列: ${align}\n`;
      }

      // 事件检测
      const evts = _detectEvents(label, closes, buf, rsiArr, macdData, adxData, bbData, atrArr, volMA20, obvArr, stochRsiData);
      evts.forEach(e => allEvents.push(e));

      return out;
    }

    text += _processTF('1m', buf1m, false);
    text += _processTF('5m', buf5m, false);
    if (buf10m.length >= 26) text += _processTF('10m', buf10m, false);
    if (buf15m.length >= 26) text += _processTF('15m', buf15m, false);
    if (buf30m.length >= 20) text += _processTF('30m', buf30m, false);
    // 1H：REST 取 200 根原始数据 + WS 实时更新，全部指标可完整收敛
    const buf1h = _bnBuffers['1h'];
    if (buf1h && buf1h.length >= 55) text += _processTF('1H', buf1h, false);

    // 多周期共振检测
    function _tfTrend(buf) {
      if (buf.length < 55) return null;
      const closes = buf.map(c => c.c);
      const e8  = _ema(closes, 8);
      const e21 = _ema(closes, 21);
      const e55 = _ema(closes, 55);
      if (!e8.length || !e21.length || !e55.length) return null;
      const v8 = e8[e8.length-1], v21 = e21[e21.length-1], v55 = e55[e55.length-1];
      if (v8 > v21 && v21 > v55) return 'bull';
      if (v8 < v21 && v21 < v55) return 'bear';
      return 'mixed';
    }
    const buf1hRes = _bnBuffers['1h'] || [];
    // v2.9 优化：多周期共振判定放宽
    // 原逻辑：1m/5m/15m/1H 全部同向才算共振，否则直接输出"方向分歧"
    // 问题：1m BTC EMA 排列几乎从不与更高周期完全一致，导致每次都输出"分歧"喂给质疑师
    // 新逻辑：以 5m/15m/1H 三个周期为主（1m 太噪，仅辅助参考），2 个以上同向即为共振
    const t1 = _tfTrend(buf1m), t5 = _tfTrend(buf5m), t15 = _tfTrend(buf15m), t1h = _tfTrend(buf1hRes);
    const higherTFs = [t5, t15, t1h].filter(Boolean); // 5m/15m/1H（排除噪声最大的1m）
    if (higherTFs.length >= 2) {
      const bullCount = higherTFs.filter(t => t === 'bull').length;
      const bearCount = higherTFs.filter(t => t === 'bear').length;
      const activeTFs = [t5&&'5m', t15&&'15m', t1h&&'1H'].filter(Boolean);
      // 1m 方向标注（仅作参考，不计入共振判定）
      const t1Label = t1 ? ('1m=' + t1) : '';
      if (bullCount >= 2) {
        // 多头共振：5m/15m/1H 中 ≥2 个多头排列
        const strength = bullCount === 3 ? '强' : '中';
        const alignedTFs = [t5==='bull'&&'5m', t15==='bull'&&'15m', t1h==='bull'&&'1H'].filter(Boolean);
        allEvents.push({ tf: '共振', strength, name: alignedTFs.length + '周期多头共振', detail: alignedTFs.join('/') + ' EMA多头排列' + (t1Label ? '（' + t1Label + '）' : '') + '，趋势方向向上' });
      } else if (bearCount >= 2) {
        // 空头共振：5m/15m/1H 中 ≥2 个空头排列
        const strength = bearCount === 3 ? '强' : '中';
        const alignedTFs = [t5==='bear'&&'5m', t15==='bear'&&'15m', t1h==='bear'&&'1H'].filter(Boolean);
        allEvents.push({ tf: '共振', strength, name: alignedTFs.length + '周期空头共振', detail: alignedTFs.join('/') + ' EMA空头排列' + (t1Label ? '（' + t1Label + '）' : '') + '，趋势方向向下' });
      } else {
        // 真正分歧：5m/15m/1H 没有 2 个以上同向，才算分歧
        const detailParts = [t5&&('5m='+t5), t15&&('15m='+t15), t1h&&('1H='+t1h)].filter(Boolean);
        allEvents.push({ tf: '共振', strength: '弱', name: '高周期方向分歧', detail: detailParts.join(' ') + (t1Label ? ' ' + t1Label : '') + '，高周期信号分歧，建议等待方向明朗' });
      }
    }

    // 格式化事件列表
    if (allEvents.length > 0) {
      text += '\n【关键事件检测】\n';
      // 按强度排序：强 > 中 > 弱
      const order = { '强': 0, '中': 1, '弱': 2 };
      allEvents.sort((a, b) => (order[a.strength] || 2) - (order[b.strength] || 2));
      // 最多 8 条，按 强>中>弱 排序后取 head，保证选到最强信号而非最弱
      allEvents.slice(0, 8).forEach(e => {
        const icon = e.strength === '强' ? '🔴' : e.strength === '中' ? '🟡' : '🟢';
        text += `  ${icon} [${e.strength}信号/${e.tf}] ${e.name}: ${e.detail}\n`;
      });
    } else {
      text += '\n【关键事件检测】本周期无显著技术事件，市场处于震荡整理\n';
    }

    return text;
  }

  // REST / WS 端点（现货固定）
  const _REST_BASE = 'https://api.binance.com';
  const _WS_BASE   = 'wss://stream.binance.com:9443';
  const _REST_PATH = '/api/v3/klines';

  // 拉取历史 K 线，填充缓冲区
  async function _fetchHistory(symbol, interval, limit) {
    try {
      const url = _REST_BASE + _REST_PATH +
        '?symbol=' + symbol + '&interval=' + interval + '&limit=' + limit;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return false;
      const data = await res.json();
      if (!Array.isArray(data)) return false;
      // 格式：[openTime, open, high, low, close, volume, closeTime, ...]
      _bnBuffers[interval] = data.map(d => ({
        t: d[0], o: parseFloat(d[1]), h: parseFloat(d[2]),
        l: parseFloat(d[3]), c: parseFloat(d[4]), v: parseFloat(d[5]),
        x: true  // 历史数据均为已收盘
      }));
      return true;
    } catch (e) { return false; }
  }

  // 更新缓冲区中的某根 K 线（实时推送）
  function _updateBuffer(interval, k) {
    const buf = _bnBuffers[interval];
    const candle = {
      t: k.t, T: k.T,  // t=openTime, T=closeTime（Binance服务器时间，用于精确倒计时）
      o: parseFloat(k.o), h: parseFloat(k.h),
      l: parseFloat(k.l), c: parseFloat(k.c), v: parseFloat(k.v),
      x: k.x
    };
    const idx = buf.findIndex(x => x.t === candle.t);
    if (idx >= 0) buf[idx] = candle;
    else {
      buf.push(candle);
      buf.sort((a, b) => a.t - b.t);
      if (buf.length > _BN_BUF_SIZE) buf.splice(0, buf.length - _BN_BUF_SIZE);
    }
  }

  // v3.10: 恢复每分钟触发（事件触发已移除）
  // 二元期权每分钟都是独立预测机会，过滤触发等于放弃样本

  // 1M K 线收盘时，组装多周期数据并触发分析
  function _onNewCandle() {
    const buf1m = _bnBuffers['1m'];
    if (buf1m.length < 2) return;

    const closed = buf1m[buf1m.length - 1];
    if (!closed) return;

    // v3.10: 每分钟触发（二元期权每分钟都是独立预测机会）

    const entryTs = closed.t + 60000;
    const fmtOpts = { year:'numeric', month:'2-digit', day:'2-digit',
                      hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false };
    const closedTimeStr = new Date(closed.t).toLocaleString('zh-CN', fmtOpts);
    const entryTimeStr  = new Date(entryTs).toLocaleString('zh-CN', fmtOpts);

    const symbol = getSymbolFromUrl();

    // OHLCV 精确数据（background.js 用"收:"解析入场价，用"入场时间戳"算 verifyAt）
    // 同时注入最新5M K线的OHLCV（供Agent判断5M级别方向和动能）
    const buf5mNow = _resample(_bnBuffers['1m'], 5);
    const last5m = buf5mNow.length ? buf5mNow[buf5mNow.length - 1] : null;
    const last5mText = last5m
      ? `【最新5M K线（当前周期，可能未收盘）】\n` +
        `  收: ${last5m.c}\n` +
        `  开: ${last5m.o}\n` +
        `  高: ${last5m.h}\n` +
        `  低: ${last5m.l}\n` +
        `  量: ${Number(last5m.v).toFixed(4)}\n` +
        `  已收盘: ${last5m.x ? '是' : '否'}\n`
      : '';

    const lastCandleText =
      `【最后完整1M K线（已收盘）】\n` +
      `  K线开盘: ${closedTimeStr}\n` +
      `  收: ${closed.c}\n` +
      `  开: ${closed.o}\n` +
      `  高: ${closed.h}\n` +
      `  低: ${closed.l}\n` +
      `  量: ${Number(closed.v).toFixed(4)}\n` +
      last5mText +
      `【入场时刻】${entryTimeStr}\n` +
      `【入场时间戳】${entryTs}\n`;

    // 代码计算的多周期指标 + 二元期权结构化特征
    const structuredBundle = _safeBuildStructuredBundle(symbol, '[structuredBundle]');
    const indicatorText = structuredBundle.combinedText;

    _lastWsKlineData = {
      timestamp: Date.now(),
      price: closed.c,
      lastCandleText,
      indicatorText,
      structuredPayload: structuredBundle.payload,
      lastCandleClose: closed.c
    };

    // 1H 由 WS 订阅实时推送维护，无需每分钟 REST 拉取

    if (window.__tvcRunning) {
      lastAutoTriggerTime = Date.now();
      if (window.__tvcCloseTimeout) clearTimeout(window.__tvcCloseTimeout);
      window.__tvcCloseTimeout = setTimeout(function() {
        window.__tvcCloseTimeout = null;
        if (!window.__tvcRunning) return;
        triggerAutoAnalysis();
      }, 0);
    }
  }

  // 订阅单个 K 线流
  function _subscribeStream(symbol, interval) {
    const url = _WS_BASE + '/ws/' + symbol.toLowerCase() + '@kline_' + interval;
    let ws;
    let reconnectTimer = null;
    let lastConnectTime = Date.now();
    // 记录上次成功 open 的时刻，用于判断实际断线时长（区分"刚启动"与"长断线"）
    let lastSuccessTime = Date.now();
    function connect() {
      lastConnectTime = Date.now();
      ws = new WebSocket(url);
      ws.onmessage = function(evt) {
        try {
          const msg = JSON.parse(evt.data);
          if (!msg.k) return;
          _updateBuffer(interval, msg.k);
          if (interval === '1m' && msg.k.x) _onNewCandle();
        } catch(e) { CtLog.warn('[ws:'+interval+'] msg parse', e.message || e); }
      };
      ws.onopen = function() {
        // gap 是上次成功 open 到本次 open 的时长（不含握手延迟）
        const gap = Date.now() - lastSuccessTime;
        lastSuccessTime = Date.now();  // 成功连接后更新
        // v2.2 改动：阈值从 90s 降到 30s。
        // 原 90s 之内的断线会留下空洞但代码继续按完整序列算指标，
        // RSI/MACD 等带状态的指标会静默失真几分钟；30s 足以覆盖单根 1m 周期，
        // 超过就强制补 refill，宁多算一次 REST 也不让指标失真。
        if (gap > 30000) {
          const refillLimit = interval === '1m' ? 900 : interval === '1h' ? 200 : 500;
          _fetchHistory(symbol, interval, refillLimit).catch(e => CtLog.warn('[ws-reconnect:fetchHistory]', e.message || e));
        }
      };
      ws.onclose = function() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 5000);
      };
      ws.onerror = function() { ws.close(); };
    }

    connect();
    if (!window.__tvcBnWs) window.__tvcBnWs = [];
    window.__tvcBnWs.push({ close: () => { if (reconnectTimer) clearTimeout(reconnectTimer); ws && ws.close(); } });
  }

  // 关闭所有 WS 连接（SPA 切页时调用，防止连接泄漏）
  function _closeBnWs() {
    const list = window.__tvcBnWs || [];
    list.forEach(w => { try { w.close(); } catch(e) {} });
    window.__tvcBnWs = [];
    _bnReady = false;
    _lastWsKlineData = null;
  }

  // 初始化：拉历史 + 订阅实时
  async function _initBnWs() {
    _closeBnWs();
    const symbol = getSymbolFromUrl();
    // symbol 为 null 时提前退出，避免构造 ?symbol=null 的错误请求
    const statusEl = document.getElementById('tvc-auto-status');
    if (!symbol) {
      if (statusEl) statusEl.textContent = '⚠️ 请先导航到 Binance 交易页面（/trade/ 或 /futures/）';
      return;
    }
    if (statusEl) statusEl.textContent = '加载历史K线数据…';

    // 拉取 1650 根 1m 历史：1650÷30=55根30m，保证新增 30m 特征层的 EMA55 有足够样本
    // 若样本不足，结构化 payload 容易不完整，进而拖慢或阻断初始化就绪
    const ok1 = await _fetchHistory(symbol, '1m', 1650);

    if (!ok1) {
      if (statusEl) statusEl.textContent = '⚠️ 历史数据加载失败，请刷新页面重试';
      return;
    }

    // v3.9: 15m/30m/1H 全部直接从 REST 拉取原始数据，不再依赖降采样
    // 这样指标数值与 TradingView 盘面完全一致，消除降采样精度损耗
    const ok15m = await _fetchHistory(symbol, '15m', 300);
    if (!ok15m) CtLog.warn('[initBnWs]', '15M历史数据加载失败，降级为降采样');
    const ok30m = await _fetchHistory(symbol, '30m', 200);
    if (!ok30m) CtLog.warn('[initBnWs]', '30M历史数据加载失败，降级为降采样');
    const ok1h = await _fetchHistory(symbol, '1h', 200);
    if (!ok1h) CtLog.warn('[initBnWs]', '1H历史数据加载失败，1H周期指标将不可用');

    // v3.8.4: 同步Binance服务器时间，修正倒计时偏差
    try {
      const _t0 = Date.now();
      const _tRes = await fetch('https://api.binance.com/api/v3/time', { signal: AbortSignal.timeout(3000) });
      const _tData = await _tRes.json();
      const _t1 = Date.now();
      // 用往返时间的中点估算请求发出时的本地时间，抵消网络延迟
      _serverTimeOffset = _tData.serverTime - Math.round((_t0 + _t1) / 2);
      CtLog.info('[timeSync]', 'offset=' + _serverTimeOffset + 'ms');
    } catch(e) {
      _serverTimeOffset = 0;
      CtLog.warn('[timeSync]', '服务器时间同步失败，使用本地时间');
    }
    _bnReady = true;
    const buf1m = _bnBuffers['1m'];
    const latest = buf1m[buf1m.length - 1];

    // 初始化时预计算一次指标，供手动分析使用
    const structuredBundle = _safeBuildStructuredBundle(symbol, '[structuredBundle]');
    const indicatorText = structuredBundle.combinedText;
    _lastWsKlineData = {
      timestamp: Date.now(),
      price: latest ? latest.c : null,
      lastCandleText: latest ? (
        `【最后完整1M K线（已收盘）】\n` +
        `  收: ${latest.c}\n  开: ${latest.o}\n  高: ${latest.h}\n  低: ${latest.l}\n` +
        `  量: ${Number(latest.v).toFixed(4)}\n` +
        `【入场时间戳】${latest.t + 60000}\n`
      ) : '',
      indicatorText,
      structuredPayload: structuredBundle.payload,
      lastCandleClose: latest ? latest.c : null
    };

    _subscribeStream(symbol, '1m');
    // v3.9: 订阅 15m/30m/1H 流，实时维护各周期缓冲区
    _subscribeStream(symbol, '15m');
    _subscribeStream(symbol, '30m');
    _subscribeStream(symbol, '1h');
    if (statusEl) statusEl.textContent = '数据就绪，等待K线收盘触发';
  }

  // 页面加载后自动初始化
  _initBnWs();

  function setAutoUI(running, intervalSec) {
    const startBtn = document.getElementById('tvc-auto-start');
    const stopBtn  = document.getElementById('tvc-auto-stop');
    const statusEl = document.getElementById('tvc-auto-status');
    if (!startBtn) return;
    if (running) {
      startBtn.style.display = 'none';
      stopBtn.style.display  = '';
      statusEl.textContent   = '运行中，每根K线收盘触发';
      statusEl.className     = 'tvc-auto-status tvc-auto-running';
    } else {
      startBtn.style.display = '';
      stopBtn.style.display  = 'none';
      statusEl.textContent   = '已停止';
      statusEl.className     = 'tvc-auto-status';
    }
  }

  document.getElementById('tvc-auto-prompt-toggle').addEventListener('click', () => {
    const wrap = document.getElementById('tvc-auto-prompt-wrap');
    const tog  = document.getElementById('tvc-auto-prompt-toggle');
    const open = wrap.style.display !== 'none';
    wrap.style.display = open ? 'none' : 'block';
    tog.textContent = (open ? '▸' : '▾') + ' 自定义提示词';
  });

  // 自动提示词框内容持久化
  document.getElementById('tvc-auto-prompt').addEventListener('input', () => {
    const val = document.getElementById('tvc-auto-prompt').value;
    safeStorageSet({ autoPromptTemp: val });
  });

  // 截图模式 — 开始
  
  // 统一停止函数，确保所有状态一次性清干净
  function stopMode() {
    clearInterval(window.__tvcTimer); window.__tvcTimer = null;
    window.__tvcRunning = false;
    if (window.__tvcCloseTimeout)   { clearTimeout(window.__tvcCloseTimeout);   window.__tvcCloseTimeout   = null; }
    if (window.__tvcAnalyzeTimeout) { clearTimeout(window.__tvcAnalyzeTimeout); window.__tvcAnalyzeTimeout = null; }
    pendingAutoTrigger = null;
    isAutoAnalyzing = false;
    _stopKlineCountdown();
    setAutoUI(false, 0);
    safeSendMessage({ type: 'AUTO_STOP' });
  }


  // 自动分析 — 开始（WS模式）
  document.getElementById('tvc-auto-start').addEventListener('click', async () => {
    if (!_lastWsKlineData) {
      alert('WebSocket 数据尚未就绪，请等待图表加载完成后再启动。\n（通常需要等待 5-10 秒）');
      return;
    }
    safeSendMessage({ type: 'AUTO_START' });
    window.__tvcRunning = true;
    setAutoUI( true, 1);
    lastAutoTriggerTime = Date.now();
    _startKlineCountdown();
  });

  // 仅DOM模式 — 停止
  document.getElementById('tvc-auto-stop').addEventListener('click', () => stopMode());

  // 自动/历史面板 — 清空历史记录和摘要，同时清空胜率统计
  document.getElementById('tvc-auto-clear-tab-btn').addEventListener('click', async () => {
    if (!confirm('确认清空所有历史记录和胜率统计？此操作不可撤销。')) return;
    // v3.10.1: 同步清空 autoSessions、偏差记忆、压缩水位线，胜率面板一并重置
    await safeStorageRemove([
      'autoSessions', 'autoResult',
      'biasMemory', 'biasMemoryAnalyst', 'biasMemoryJudge', 'biasCompressedAt'
    ]);
    document.getElementById('tvc-auto-result-wrap').style.display = 'none';
    const list = document.getElementById('tvc-auto-result-list');
    if (list) list.innerHTML = '';
    currentAutoCard = null;
    resetAgentPanels();
    renderWinRatePanel();
    updateWinRate([]);
  });

  // 胜率面板 — 清空历史记录（autoSessions + 双桶 biasMemory + 压缩水位线）
  document.getElementById('tvc-winrate-clear-btn').addEventListener('click', async () => {
    if (!confirm('确认清空所有历史记录和偏差记忆？此操作不可撤销。')) return;
    // v2.3: 同时清掉新双桶键和压缩水位线，否则旧的偏差记忆/水位线会污染新一轮统计
    await safeStorageRemove([
      'autoSessions', 'autoResult',
      'biasMemory', 'biasMemoryAnalyst', 'biasMemoryJudge', 'biasCompressedAt'
    ]);
    document.getElementById('tvc-auto-result-wrap').style.display = 'none';
    const list = document.getElementById('tvc-auto-result-list');
    if (list) list.innerHTML = '';
    currentAutoCard = null;
    resetAgentPanels();
    renderWinRatePanel();
    updateWinRate([]);
  });
  let streamingDiv  = null;
  let streamingText = '';
  let currentAutoCard = null; // 当前正在流式写入的自动面板卡片

  // 三角色流式状态 — 同时驱动自动面板内嵌区块和 Agent 专属面板
  const agentState = {
    auto_analyst: {
      panelWrap: 'tvc-agent-panel-analyst', panelLabel: 'tvc-agent-panel-analyst-label', panelBody: 'tvc-agent-panel-analyst-body',
      text: '', startTime: null, labelText: '🔍 分析师'
    },
    auto_critic: {
      panelWrap: 'tvc-agent-panel-critic', panelLabel: 'tvc-agent-panel-critic-label', panelBody: 'tvc-agent-panel-critic-body',
      text: '', startTime: null, labelText: '⚔️ 质疑师'
    },
    auto_judge: {
      panelWrap: 'tvc-agent-panel-judge', panelLabel: 'tvc-agent-panel-judge-label', panelBody: 'tvc-agent-panel-judge-body',
      text: '', startTime: null, labelText: '⚖️ 裁判'
    },
    // 历史学家 Agent 流式输出（显示在自动面板顶部）
    auto_historian: {
      panelWrap: 'tvc-agent-panel-historian', panelLabel: 'tvc-agent-panel-historian-label', panelBody: 'tvc-agent-panel-historian-body',
      text: '', startTime: null, labelText: '🏛️ 历史学家'
    },
  };

  // 对话面板三角色状态（新功能：对话Tab中显示三角色分析）
  const chatAgentState = {
    chat_analyst: { text: '', div: null, labelText: '🔍 分析师' },
    chat_critic:  { text: '', div: null, labelText: '⚔️ 质疑师' },
    chat_judge:   { text: '', div: null, labelText: '⚖️ 裁判'  },
  };
  let chatAgentCard = null;    // 当前三角色分析的卡片容器
  let isChatAgents = false;   // 是否正在三角色分析

  function resetAgentPanels() {
    agentState.auto_analyst.labelText = '🔍 分析师';
    agentState.auto_critic.labelText  = '⚔️ 质疑师';
    agentState.auto_judge.labelText   = '⚖️ 裁判';
    const modeTag = '<span style="font-size:10px;color:#fbbf24;font-weight:600;margin-left:4px">正在分析</span>';

    Object.values(agentState).forEach(a => {
      a.text = '';
      a.startTime = null;
      // Agent 专属面板区块
      const pw = document.getElementById(a.panelWrap);
      const pb = document.getElementById(a.panelBody);
      const pl = document.getElementById(a.panelLabel);
      if (pw) pw.style.display = 'none';
      if (pb) { pb.innerHTML = ''; pb.classList.remove('collapsed'); }
      if (pl) pl.innerHTML = a.labelText + modeTag + ' <span class="tvc-agent-spinner">●</span><span class="tvc-agent-collapse-arrow" style="margin-left:auto">▾</span>';
    });
    // 顶部状态条：切换为分析中
    const heroDir = document.getElementById('tvc-auto-hero-dir');
    const heroAnalyzing = document.getElementById('tvc-auto-hero-analyzing');
    if (heroDir) { heroDir.className = ''; heroDir.textContent = '分析中…'; }
    if (heroAnalyzing) heroAnalyzing.style.display = 'inline';
    // 自动面板：重置状态条，创建新卡片插入列表顶部
    const st = document.getElementById('tvc-agent-judge-status');
    if (st) { st.style.display = 'block'; st.textContent = '⚖️ 分析中…'; }
    const list = document.getElementById('tvc-auto-result-list');
    if (list) {
      // 创建新卡片
      currentAutoCard = document.createElement('div');
      currentAutoCard.style.cssText = 'background:#1a1f2e;border:1px solid #2a2e39;border-radius:6px;padding:8px;font-size:12px;color:#d1d4dc;line-height:1.7';
      // 时间+方向占位行
      const header = document.createElement('div');
      header.className = 'tvc-auto-card-header';
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:11px;color:#787b86';
      header.innerHTML = '<span class="tvc-auto-card-time">' + new Date().toLocaleTimeString('zh-CN') + '</span><span class="tvc-auto-card-dir"></span>';
      currentAutoCard.appendChild(header);
      // 裁判内容区（toggleBtn 先隐藏，等裁判开始输出后再显示）
      const toggleBtn = document.createElement('div');
      toggleBtn.className = 'tvc-auto-card-toggle';
      toggleBtn.innerHTML = '▾ 收起';
      toggleBtn.style.display = 'none'; // 裁判未开始前隐藏
      const body = document.createElement('div');
      body.className = 'tvc-auto-card-body'; // 默认展开
      toggleBtn.addEventListener('click', () => {
        const collapsed = body.classList.toggle('collapsed');
        toggleBtn.innerHTML = collapsed ? '▸ 查看详情' : '▾ 收起';
      });
      currentAutoCard.appendChild(toggleBtn);
      currentAutoCard.appendChild(body);
      // 插入到顶部（不在此处折叠旧卡片，等裁判第一个 chunk 到达时再折叠）
      list.insertBefore(currentAutoCard, list.firstChild);
      // 显示容器
      document.getElementById('tvc-auto-result-wrap').style.display = 'flex';
    }
    // 重置结论区
    const conc = document.getElementById('tvc-agent-conclusion');
    if (conc) { conc.style.display = 'none'; conc.innerHTML = ''; }
    const changeWrap = document.getElementById('tvc-agent-change-wrap');
    if (changeWrap) changeWrap.style.display = 'none';
    // 重置 Agent 面板 K线区
    const agKlineToggle = document.getElementById('tvc-agent-kline-toggle');
    const agKlineWrap   = document.getElementById('tvc-agent-kline-wrap');
    if (agKlineToggle) { agKlineToggle.style.display = 'none'; agKlineToggle.textContent = '▸ 查看抓取数据'; }
    if (agKlineWrap)   { agKlineWrap.style.display = 'none'; agKlineWrap.textContent = ''; }
    // 固定区无内容时隐藏，避免空白边框占位
    const agFixed = document.getElementById('tvc-agent-fixed');
    if (agFixed) agFixed.style.display = 'none';
  }

  // v3.16.3 元裁判：审计结果不再弹窗，改为内联展示在「历史」标签(自动子标签)的列表里(像旧版)。
  //   徽章 = 手动触发审计 + 显示进度；完成后若正在看历史页则自动刷新出新的审计卡片。
  (function _bindMetaJudge() {
    function _setBadge(txt) {
      var b = document.getElementById('tvc-meta-judge-badge');
      if (b) { b.style.display = 'inline-block'; b.textContent = txt; }
    }
    function _tryBind() {
      var _badge = document.getElementById('tvc-meta-judge-badge');
      if (!_badge) { setTimeout(_tryBind, 1000); return; }
      if (!_badge._mjBound) {
        _badge._mjBound = true;
        _badge.title = '点击手动触发元裁判审计（结果显示在「历史」标签·自动子标签）';
        _badge.addEventListener('click', function() {
          safeSendMessage({ type: 'TRIGGER_META_JUDGE' });
          _setBadge('⏳ 元裁判审计中…（完成后见「历史」标签）');
        });
      }
      safeStorageGet('metaJudgeReport').then(function(d) {
        if (d && d.metaJudgeReport && d.metaJudgeReport.content) {
          _setBadge('📋 元裁判报告（' + (d.metaJudgeReport.createdAt || '') + '）见历史');
        }
      });
    }
    setTimeout(_tryBind, 800);

    function _refreshHistoryIfVisible() {
      try {
        var hv = document.getElementById('tvc-history-view');
        if (hv && hv.style.display !== 'none' && typeof renderHistory === 'function') renderHistory();
      } catch (_) {}
    }

    // 元裁判进度/完成/错误监听：只更新徽章状态；完成后把报告渲染进「历史」列表
    chrome.runtime.onMessage.addListener(function(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'META_JUDGE_START') _setBadge('⏳ 元裁判审计中…（完成后见「历史」标签）');
      else if (msg.type === 'META_JUDGE_PROGRESS') _setBadge('⏳ ' + (msg.step || '审计中…'));
      else if (msg.type === 'META_JUDGE_DONE') {
        _setBadge('📋 审计完成（见「历史」标签·自动）✓');
        _refreshHistoryIfVisible();
      }
      else if (msg.type === 'META_JUDGE_ERROR') _setBadge('⚠️ 元裁判：' + (msg.error || '失败'));
    });
  })();

    chrome.runtime.onMessage.addListener((msg) => {
    // ── SW 被回收后重启：强制重置 lock，避免 content.js 永久卡死 ──
    // v1.7.1 新增：background.js 启动时会广播 SW_RESTARTED，
    // 此前 content.js 没有处理 → isAutoAnalyzing/isSending 锁可能挂死直到 240s 超时
    if (msg.type === 'VERIFY_DONE') {
      const _wrView = document.getElementById('tvc-winrate-view');
      if (_wrView && _wrView.style.display !== 'none') {
        renderWinRatePanel();
      }
      return;
    }
    if (msg.type === 'SW_RESTARTED') {
      try {
        // Fix: SW 重启说明元裁判已中断，同步清除 storage 侧标志（双保险）
        try { chrome.storage.local.set({ metaJudgeRunning: false, metaJudgePendingAt: 0 }); } catch(_) {}
        if (isAutoAnalyzing) {
          isAutoAnalyzing = false;
          if (window.__tvcAnalyzeTimeout) { clearTimeout(window.__tvcAnalyzeTimeout); window.__tvcAnalyzeTimeout = null; }
          const _st = document.getElementById('tvc-agent-judge-status');
          if (_st) { _st.style.display = 'block'; _st.textContent = '⚠️ 后台已重启，已自动恢复（等待下一根 K 线）'; }
          // 只把 spinner 标记成"已中断"，不重建卡片（避免抹掉上一次结果）
          Object.values(agentState).forEach(a => {
            const pl = document.getElementById(a.panelLabel);
            if (pl) pl.innerHTML = (a.labelText || '') + ' <span style="color:#fbbf24;font-size:10px">(已中断)</span><span class="tvc-agent-collapse-arrow" style="margin-left:auto">▾</span>';
          });
        }
        if (isSending) {
          isSending = false;
          if (typeof showStopBtn === 'function') showStopBtn(false);
          if (typeof updateSendState === 'function') updateSendState();
        }
        if (typeof isChatAgents !== 'undefined' && isChatAgents) {
          isChatAgents = false;
        }
        try { chrome.runtime.sendMessage({ type: 'CT_LOG', level: 'WARN', scope: 'SW', msg: 'SW_RESTARTED 已处理，本地 lock 重置' }); } catch(_) {}
      } catch(e) {
        console.warn('[content] SW_RESTARTED 处理异常', e);
      }
      return;
    }
    if (msg.type === 'STREAM_CHUNK') {
      // v2: 每次有 chunk 到达就续期看门狗，长分析不会被误杀
      if (typeof window.__tvcArmWatchdog === 'function' && isAutoAnalyzing) { try { window.__tvcArmWatchdog(); } catch(_) {} }
      const agentSrc = agentState[msg.source];
      if (agentSrc) {
        // 累积文本（所有 agent 都要做）
        agentSrc.text += msg.chunk;
        // 记录首个 chunk 到达时间（用于耗时计算）
        if (!agentSrc.startTime) agentSrc.startTime = Date.now();

        // 自动面板：只更新状态条（分析师/质疑师）或实时写入结果区（裁判）
        if (msg.source === 'auto_analyst') {
          const st = document.getElementById('tvc-agent-judge-status');
          if (st) { st.style.display = 'block'; st.textContent = '🔍 分析师分析中…'; }
        } else if (msg.source === 'auto_critic') {
          const st = document.getElementById('tvc-agent-judge-status');
          if (st) st.textContent = '⚔️ 质疑师审查中…';
        } else if (msg.source === 'auto_judge') {
          const st = document.getElementById('tvc-agent-judge-status');
          if (st) st.textContent = '⚖️ 裁判综合中…';
          // 实时写入当前卡片的 body
          if (currentAutoCard) {
            const cardBody = currentAutoCard.querySelector('.tvc-auto-card-body');
            if (cardBody) {
              if (!cardBody._rafPending) {
                cardBody._rafPending = true;
                requestAnimationFrame(() => {
                  cardBody._rafPending = false;
                  cardBody.innerHTML = formatAssistant(agentSrc.text);
                  // 裁判第一个 chunk：显示 toggleBtn + 折叠其他旧卡片
                  const tb = currentAutoCard.querySelector('.tvc-auto-card-toggle');
                  if (tb && tb.style.display === 'none') {
                    tb.style.display = '';
                    // 折叠列表里除当前卡片外所有展开的卡片
                    const list = document.getElementById('tvc-auto-result-list');
                    if (list) {
                      list.querySelectorAll('.tvc-auto-card-body:not(.collapsed)').forEach(b => {
                        if (b === cardBody) return; // 跳过当前新卡片
                        b.classList.add('collapsed');
                        const t = b.previousElementSibling;
                        if (t && t.classList.contains('tvc-auto-card-toggle')) t.innerHTML = '▸ 查看详情';
                      });
                    }
                  }
                  const list2 = document.getElementById('tvc-auto-result-list');
                  if (list2) list2.scrollTop = 0;
                });
              }
            }
          }
        }

        // Agent 专属面板：所有 agent 都实时写入
        const pw = document.getElementById(agentSrc.panelWrap);
        const pb = document.getElementById(agentSrc.panelBody);
        if (pw) pw.style.display = 'block';
        if (pb) {
          pb.classList.remove('collapsed');
          const parr = pw && pw.querySelector('.tvc-agent-collapse-arrow');
          if (parr) parr.style.transform = 'rotate(0deg)';
          if (!pb._rafPending) {
            pb._rafPending = true;
            requestAnimationFrame(() => {
              pb._rafPending = false;
              pb.innerHTML = formatAssistant(agentSrc.text);
              // 同时滚动 body 自身（有 max-height 内滚）和外层容器
              pb.scrollTop = pb.scrollHeight;
              const agentScroll = document.getElementById('tvc-agent-scroll');
              if (agentScroll) agentScroll.scrollTop = agentScroll.scrollHeight;
            });
          }
        }
        return;
      }
      if (msg.source === 'auto') return; // 旧 source 兼容，忽略

      // ── 元裁判流式输出 ────────────────────────────────────────────
      if (msg.source === 'meta_judge') {
        // 找或创建元裁判流式区块（挂在裁判 Agent 面板里）
        let _mjStream = document.getElementById('tvc-meta-judge-stream');
        if (!_mjStream) {
          const _judgePanel = document.getElementById('tvc-agent-auto_judge-content');
          if (_judgePanel) {
            _mjStream = document.createElement('div');
            _mjStream.id = 'tvc-meta-judge-stream';
            _mjStream.style.cssText = 'margin-top:12px;padding:10px;background:#0f2744;' +
              'border-left:3px solid #3b82f6;border-radius:4px;font-size:11px;' +
              'color:#e2e8f0;white-space:pre-wrap;word-break:break-word';
            const _hdr = document.createElement('div');
            _hdr.id = 'tvc-meta-judge-stream-hdr';
            _hdr.style.cssText = 'color:#60a5fa;font-weight:bold;margin-bottom:6px';
            _hdr.textContent = '📋 元裁判审计报告（生成中…）';
            const _body = document.createElement('div');
            _body.id = 'tvc-meta-judge-stream-text';
            _mjStream.appendChild(_hdr);
            _mjStream.appendChild(_body);
            _judgePanel.appendChild(_mjStream);
          }
        }
        // 累积文本并 RAF 渲染
        const _mjTextEl = document.getElementById('tvc-meta-judge-stream-text');
        if (_mjTextEl) {
          _mjTextEl._buf = (_mjTextEl._buf || '') + msg.chunk;
          if (!_mjTextEl._rafPending) {
            _mjTextEl._rafPending = true;
            requestAnimationFrame(function() {
              _mjTextEl._rafPending = false;
              _mjTextEl.textContent = _mjTextEl._buf;
            });
          }
        }
        return;
      }

      // ── 对话面板三角色流式（新功能）─────────────────────────────
      const chatAgentSrc = chatAgentState[msg.source];
      if (chatAgentSrc) {
        chatAgentSrc.text += msg.chunk;
        if (chatAgentSrc.div) {
          if (!chatAgentSrc.div._rafPending) {
            chatAgentSrc.div._rafPending = true;
            requestAnimationFrame(() => {
              chatAgentSrc.div._rafPending = false;
              chatAgentSrc.div.innerHTML = formatAssistant(chatAgentSrc.text);
              scrollBottom();
            });
          }
        }
        return;
      }
      // 历史内联对话流式
      if (msg.source && msg.source.startsWith('hchat_')) {
        const target = _historyStreamTargets.get(msg.source);
        if (target) {
          target.text += msg.chunk;
          if (!target.div._rafPending) {
            target.div._rafPending = true;
            requestAnimationFrame(() => {
              target.div._rafPending = false;
              target.div.innerHTML = formatAssistant(target.text);
              target.msgsArea.scrollTop = target.msgsArea.scrollHeight;
            });
          }
        }
        return;
      }
      // 对话面板流式
      if (!streamingDiv) {
        getMsgs().querySelectorAll('.tvc-loading').forEach(el => el.remove());
        streamingDiv = document.createElement('div');
        streamingDiv.className = 'tvc-msg-assistant';
        getLatestCard().appendChild(streamingDiv);
        streamingText = '';
      }
      streamingText += msg.chunk;
      if (!streamingDiv._rafPending) {
        streamingDiv._rafPending = true;
        const _sd = streamingDiv; // 捕获引用，防止 RAF 回调执行时 streamingDiv 已被置 null
        requestAnimationFrame(() => {
          _sd._rafPending = false;
          _sd.innerHTML = formatAssistant(streamingText);
          scrollBottom();
        });
      }
    }
    if (msg.type === 'STREAM_DONE') {
      const agentSrc = agentState[msg.source];
      if (agentSrc) {
        // Agent 专属面板：标题変为完成态，保留折叠箭头
        const pl = document.getElementById(agentSrc.panelLabel);
        const elapsed = agentSrc.startTime ? ((Date.now() - agentSrc.startTime) / 1000).toFixed(1) + 's' : '';
        const elapsedTag = elapsed ? '<span style="font-size:10px;color:#787b86;margin-left:4px">' + elapsed + '</span>' : '';
        if (pl) pl.innerHTML = agentSrc.labelText + ' ✓' + elapsedTag + '<span class="tvc-agent-collapse-arrow" style="margin-left:auto">▾</span>';
        // 裁判完成 → 无条件解锁，隐藏状态条，更新卡片头部，写入 Agent 面板结论区
        if (msg.source === 'auto_judge') {
          isAutoAnalyzing = false;
          if (window.__tvcAnalyzeTimeout) { clearTimeout(window.__tvcAnalyzeTimeout); window.__tvcAnalyzeTimeout = null; }
          const st = document.getElementById('tvc-agent-judge-status');
          if (st) st.style.display = 'none';
          const conc = document.getElementById('tvc-agent-conclusion');
          if (conc) { conc.style.display = 'block'; conc.innerHTML = formatAssistant(agentSrc.text); }
          if (currentAutoCard) {
            const timeEl = currentAutoCard.querySelector('.tvc-auto-card-time');
            const dirEl  = currentAutoCard.querySelector('.tvc-auto-card-dir');
            if (timeEl) timeEl.textContent = new Date().toLocaleTimeString('zh-CN');
            if (dirEl) {
              const dirMatch  = agentSrc.text.match(/【方向[^】]*】\s*(看涨|看跌|观望)/);
              const confMatch = agentSrc.text.match(/(?:方向置信度[：:][^\n]*?|【置信度[^】]*】[^0-9]*)(\d+)\s*[%％]/);
              const dirRaw = dirMatch ? dirMatch[1]
                : /看涨/.test(agentSrc.text) ? '看涨'
                : /看跌/.test(agentSrc.text) ? '看跌'
                : /观望/.test(agentSrc.text) ? '观望' : '';
              const conf = confMatch ? confMatch[1] + '%' : '';
              if (dirRaw === '看涨') { dirEl.textContent = '看涨 📈' + (conf ? ' ' + conf : ''); dirEl.style.color = '#4ade80'; }
              else if (dirRaw === '看跌') { dirEl.textContent = '看跌 📉' + (conf ? ' ' + conf : ''); dirEl.style.color = '#f87171'; }
              else if (dirRaw === '观望') { dirEl.textContent = '观望 👀' + (conf ? ' ' + conf : ''); dirEl.style.color = '#fbbf24'; }
            }
            safeStorageGet('autoSessions').then(d => {
              const sessions = d.autoSessions || [];
              if (sessions.length && currentAutoCard && !currentAutoCard.dataset.sessionId) {
                currentAutoCard.dataset.sessionId = sessions[0].id;
              }
              refreshAutoResult().catch(e => CtLog.warn('[autoCard:refreshAutoResult]', e.message || e));
            }).catch(e => CtLog.warn('[autoCard:loadSessions]', e.message || e));
          }
          // 更新顶部醒目状态条
          const heroDir = document.getElementById('tvc-auto-hero-dir');
          const heroConf = document.getElementById('tvc-auto-hero-conf');
          const heroTime = document.getElementById('tvc-auto-hero-time');
          const heroAnalyzing = document.getElementById('tvc-auto-hero-analyzing');
          if (heroAnalyzing) heroAnalyzing.style.display = 'none';
          if (heroDir && heroConf && heroTime) {
            const dirMatch2  = agentSrc.text.match(/【方向[^】]*】\s*(看涨|看跌|观望)/);
            const confMatch2 = agentSrc.text.match(/(?:方向置信度[：:][^\n]*?|【置信度[^】]*】[^0-9]*)(\d+)\s*[%％]/);
            const dir2  = dirMatch2  ? dirMatch2[1]  : '';
            const conf2 = confMatch2 ? confMatch2[1] + '%' : '';
            if (dir2 === '看涨') { heroDir.textContent = '看涨 📈'; heroDir.className = 'bullish'; }
            else if (dir2 === '看跌') { heroDir.textContent = '看跌 📉'; heroDir.className = 'bearish'; }
            else if (dir2) { heroDir.textContent = '观望 👀'; heroDir.className = 'neutral'; }
            heroConf.textContent = conf2 ? '置信度 ' + conf2 : '';
            heroTime.textContent = new Date().toLocaleTimeString('zh-CN');
          }
          // 立即更新状态栏，不依赖 refreshAutoResult 是否成功
          const statusEl2 = document.getElementById('tvc-auto-status');
          const nowTime = new Date().toLocaleTimeString('zh-CN');
          if (window.__tvcRunning && statusEl2) {
            statusEl2.textContent = '✅ 运行中，上次: ' + nowTime;
            statusEl2.className = 'tvc-auto-status tvc-auto-running';
          }
          // 延迟刷新：等待 background.js 完成 autoSessions 写入后再更新面板
          // （STREAM_DONE 在 storage.set 之前发出，存在竞态，1.5s 足够覆盖）
          // v3.8.3: 分析完成后无条件刷新两个面板，不再要求用户必须在对应tab上
          setTimeout(() => {
            renderWinRatePanel().catch(e => CtLog.warn('[autoJudge:renderWinRate]', e.message || e));
            renderHistory().catch(e => CtLog.warn('[autoJudge:renderHistory]', e.message || e));
          }, 1500);
        }
        return;
      }
      // 对话面板三角色完成
      if (chatAgentState[msg.source]) {
        const ca = chatAgentState[msg.source];
        const lbl = ca.div ? ca.div.previousElementSibling : null;
        if (lbl && lbl.classList.contains('tvc-agent-label')) {
          lbl.innerHTML = ca.labelText + ' ✓<span class="tvc-agent-collapse-arrow" style="margin-left:auto">▾</span>';
        }
        if (msg.source === 'chat_judge') {
          isChatAgents = false;
          isSending = false;
          showStopBtn(false);
          updateSendState();
          // 写入裁判最终内容（确保完整）
          if (ca.div) ca.div.innerHTML = formatAssistant(ca.text);
          scrollBottom();
        }
        return;
      }
      // 元裁判流式完成：更新标题
      if (msg.source === 'meta_judge') {
        const _hdr = document.getElementById('tvc-meta-judge-stream-hdr');
        if (_hdr) _hdr.textContent = '📋 元裁判审计报告（完成，查看历史可回看）';
      }
      if (msg.source !== 'auto') { streamingDiv = null; streamingText = ''; }
      if (msg.source && msg.source.startsWith('hchat_')) return; // 内联对话由 sendHistoryChat 清理
    }
    if (msg.type === 'AUTO_RESULT_DATA') {
      // 截图和K线数据已在 triggerAutoAnalysis 里直接填入 Agent 面板，此处仅播放提示音
      playBeep(msg.direction);
    }
    // ── v3.1 元裁判消息处理 ──────────────────────────────────────
    if (msg.type === 'META_JUDGE_START') {
      const _mjBadge = document.getElementById('tvc-meta-judge-badge');
      if (_mjBadge) { _mjBadge.style.display = 'inline-block'; _mjBadge.textContent = '⏳ 元裁判审计中…'; _mjBadge.style.background = '#92400e'; }
      const _st = document.getElementById('tvc-agent-judge-status');
      if (_st) { _st.style.display = 'block'; _st.textContent = '⏳ 元裁判正在深度审计，主流程暂停等待…'; }
    }
    if (msg.type === 'META_JUDGE_PROGRESS') {
      const _mjBadge = document.getElementById('tvc-meta-judge-badge');
      if (_mjBadge) _mjBadge.textContent = '⏳ ' + (msg.step || '元裁判审计中…');
      const _st = document.getElementById('tvc-agent-judge-status');
      if (_st) { _st.style.display = 'block'; _st.textContent = '⏳ ' + (msg.step || '元裁判审计中…'); }
    }
    if (msg.type === 'META_JUDGE_DONE') {
      const _mjBadge = document.getElementById('tvc-meta-judge-badge');
      if (_mjBadge) { _mjBadge.textContent = '✅ 元裁判报告已更新'; _mjBadge.style.background = '#065f46'; }
      const _st = document.getElementById('tvc-agent-judge-status');
      if (_st) { _st.style.display = 'block'; _st.textContent = '✅ 元裁判审计完成，下一根K线恢复分析'; }
      // 3秒后隐藏状态条
      setTimeout(function() {
        if (_st) _st.style.display = 'none';
        if (_mjBadge) { _mjBadge.textContent = '📋 元裁判报告'; _mjBadge.style.background = '#1e3a5f'; }
      }, 3000);
      // 若有报告内容，注入到裁判面板（流式块已在生成时创建，更新标题即可）
      const _mjStreamHdr = document.getElementById('tvc-meta-judge-stream-hdr');
      if (_mjStreamHdr) {
        _mjStreamHdr.textContent = '📋 元裁判审计报告（' + (msg.report && msg.report.createdAt || '') +
          '，基于' + (msg.report && msg.report.basedOn || '?') + '条记录）';
      }
      // Layer 2：若有提示词建议，显示一键应用区
      const _sug = msg.suggestions || {};
      const _hasSug = _sug.analyst || _sug.critic || _sug.judge;
      if (_hasSug) {
        const _mjStream = document.getElementById('tvc-meta-judge-stream');
        const _judgePanel = document.getElementById('tvc-agent-auto_judge-content');
        const _container = _mjStream || _judgePanel;
        if (_container) {
          // 移除旧的应用区（防止重复）
          const _oldApply = document.getElementById('tvc-mj-apply-wrap');
          if (_oldApply) _oldApply.remove();

          const _applyWrap = document.createElement('div');
          _applyWrap.id = 'tvc-mj-apply-wrap';
          _applyWrap.style.cssText = 'margin-top:10px;padding:8px;background:#0c1f3a;border:1px solid #3b82f6;border-radius:4px;font-size:11px';

          const _applyTitle = document.createElement('div');
          _applyTitle.style.cssText = 'color:#60a5fa;font-weight:bold;margin-bottom:6px';
          _applyTitle.textContent = '💡 提示词修改建议（点击"应用"追加到对应提示词末尾）';
          _applyWrap.appendChild(_applyTitle);

          const _roleNames = { analyst: '🔍 分析师', critic: '⚔️ 质疑师', judge: '⚖️ 裁判' };
          Object.entries(_sug).forEach(function(_entry) {
            const role = _entry[0], txt = _entry[1];
            if (!txt) return;
            const _row = document.createElement('div');
            _row.style.cssText = 'display:flex;align-items:flex-start;gap:6px;margin-bottom:4px';
            const _label = document.createElement('span');
            _label.style.cssText = 'color:#93c5fd;min-width:60px;flex-shrink:0';
            _label.textContent = _roleNames[role] || role;
            const _desc = document.createElement('span');
            _desc.style.cssText = 'color:#e2e8f0;flex:1;line-height:1.4';
            _desc.textContent = txt;
            _row.appendChild(_label);
            _row.appendChild(_desc);
            _applyWrap.appendChild(_row);
          });

          const _btnRow = document.createElement('div');
          _btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px';

          const _applyBtn = document.createElement('button');
          _applyBtn.style.cssText = 'background:#1d4ed8;color:#fff;border:none;border-radius:4px;padding:4px 12px;font-size:11px;cursor:pointer';
          _applyBtn.textContent = '✅ 一键应用';
          _applyBtn.addEventListener('click', function() {
            _applyBtn.disabled = true;
            _applyBtn.textContent = '应用中…';
            safeSendMessage({ type: 'APPLY_META_JUDGE_SUGGESTIONS', suggestions: _sug }, function(resp) {
              if (resp && resp.ok) {
                const _n = (resp.applied || []).length;
                _applyBtn.textContent = _n > 0 ? ('✅ 已应用' + _n + '条，在设置页可查看') : '✅ 无需修改';
                _applyBtn.style.background = '#065f46';
              } else {
                _applyBtn.textContent = '⚠️ 应用失败';
                _applyBtn.style.background = '#7f1d1d';
                _applyBtn.disabled = false;
              }
            });
          });

          const _skipBtn = document.createElement('button');
          _skipBtn.style.cssText = 'background:#374151;color:#9ca3af;border:none;border-radius:4px;padding:4px 10px;font-size:11px;cursor:pointer';
          _skipBtn.textContent = '跳过';
          _skipBtn.addEventListener('click', function() { _applyWrap.remove(); });

          _btnRow.appendChild(_applyBtn);
          _btnRow.appendChild(_skipBtn);
          _applyWrap.appendChild(_btnRow);
          _container.appendChild(_applyWrap);
        }
      }
    }
    if (msg.type === 'META_JUDGE_ERROR') {
      const _mjBadge = document.getElementById('tvc-meta-judge-badge');
      if (_mjBadge) { _mjBadge.textContent = '⚠️ 元裁判失败'; _mjBadge.style.background = '#7f1d1d'; }
      const _st = document.getElementById('tvc-agent-judge-status');
      if (_st) { _st.style.display = 'block'; _st.textContent = '⚠️ 元裁判审计失败：' + (msg.error || '').slice(0, 60); }
    }
    if (msg.type === 'AUTO_ANALYZE_ERROR') {
      // background.js 分析管道整体失败（如模型配置错误、网络错误），在状态栏醒目显示
      isAutoAnalyzing = false;
      if (window.__tvcAnalyzeTimeout) { clearTimeout(window.__tvcAnalyzeTimeout); window.__tvcAnalyzeTimeout = null; }
      const errShort = (msg.error || '未知错误').slice(0, 80);
      const autoStatusEl = document.getElementById('tvc-auto-status');
      if (autoStatusEl) autoStatusEl.textContent = '❌ ' + errShort;
      const st = document.getElementById('tvc-agent-judge-status');
      if (st) { st.style.display = 'block'; st.textContent = '❌ ' + errShort; }
      console.error('[content] AUTO_ANALYZE_ERROR:', msg.error);
    }
    if (msg.type === 'STREAM_ERROR') {
      // 对话面板三角色出错
      if (chatAgentState[msg.source]) {
        isChatAgents = false;
        isSending = false;
        showStopBtn(false);
        updateSendState();
        const rawErr = (msg.error || '未知错误').replace(/^\[(分析师|质疑师|裁判)\]\s*/, '');
        appendError((msg.source === 'chat_analyst' ? '分析师' : msg.source === 'chat_critic' ? '质疑师' : '裁判') + '出错: ' + rawErr.slice(0, 100));
        return;
      }
      if (agentState[msg.source]) {
        isAutoAnalyzing = false; // 三角色出错时解锁
        if (window.__tvcAnalyzeTimeout) { clearTimeout(window.__tvcAnalyzeTimeout); window.__tvcAnalyzeTimeout = null; }
        // 剥离 background.js 注入的角色前缀，避免重复显示
        const rawErr = (msg.error || '未知错误').replace(/^\[(分析师|质疑师|裁判)\]\s*/, '');
        const errText = (msg.source === 'auto_analyst' ? '分析师' : msg.source === 'auto_critic' ? '质疑师' : '裁判')
          + '出错: ' + rawErr.slice(0, 100);
        const autoStatusEl = document.getElementById('tvc-auto-status');
        if (window.__tvcRunning && autoStatusEl) autoStatusEl.textContent = errText;
        // 同时在 Agent 面板状态栏显示
        const agentStatusText = document.getElementById('tvc-agent-status-text');
        if (agentStatusText) agentStatusText.textContent = errText;
        const st = document.getElementById('tvc-agent-judge-status');
        if (st) { st.style.display = 'block'; st.textContent = '❌ ' + errText; }
        return;
      }
      if (msg.source === 'auto') return;
      getMsgs().querySelectorAll('.tvc-loading').forEach(el => el.remove());
      if (streamingDiv) { streamingDiv = null; streamingText = ''; }
      appendError(msg.error);
    }
  });

  // ── 胜率面板 & 历史记录自动刷新：storage 更新时重绘 ──────────────
  // v3.2 Fix: storage-keys.js 会给 key 加 'tvc2:' 前缀写入，
  // 所以 changes 里的 key 是 'tvc2:autoSessions'，不是 'autoSessions'。
  // 同时兼容两种 key 名，以防 StorageNS.PREFIX 在不同上下文不一致。
  const _NS_PREFIX = (typeof StorageNS !== 'undefined' && StorageNS.PREFIX) || 'tvc2:';
  // v3.8.3: autoSessions变化时无条件刷新两个面板
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const hasAutoSessions = changes['autoSessions'] || changes[_NS_PREFIX + 'autoSessions'];
    if (!hasAutoSessions) return;
    renderWinRatePanel().catch(() => {});
    renderHistory().catch(() => {});
  });

  // ── Web Audio 提示音 ─────────────────────────────────────────────
  function playBeep(direction) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const freqs = direction === 'bullish' ? [523, 659, 784]
                  : direction === 'bearish' ? [784, 659, 523]
                  : [600, 600];
      let t = ctx.currentTime;
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq; osc.type = 'sine';
        gain.gain.setValueAtTime(0, t + i * 0.12);
        gain.gain.linearRampToValueAtTime(0.3, t + i * 0.12 + 0.02);
        gain.gain.linearRampToValueAtTime(0, t + i * 0.12 + 0.18);
        osc.start(t + i * 0.12); osc.stop(t + i * 0.12 + 0.2);
      });
    } catch (e) { /* 静默失败 */ }
  }

  async function triggerAutoAnalysis() {
    // models 可能尚未加载（侧边栏未打开过），先补加载一次
    if (!models.length) {
      await loadSettings();
    }
    if (!models.length) {
      const statusEl = document.getElementById('tvc-auto-status');
      if (statusEl) statusEl.textContent = '⚠️ 请先在弹出窗口中配置模型';
      return;
    }
    if (!window.__tvcRunning) return;

    if (isAutoAnalyzing) return;
    isAutoAnalyzing = true;
    if (isSending) { isAutoAnalyzing = false; return; }

    // v3.1 元裁判：若元裁判正在运行，等待其完成后再分析（最多等 90s）
    const _mjCheck = await safeStorageGet('metaJudgeRunning');
    if (_mjCheck.metaJudgeRunning) {
      isAutoAnalyzing = false;
      const statusEl2 = document.getElementById('tvc-auto-status');
      if (statusEl2) statusEl2.textContent = '⏳ 元裁判审计中，等待完成后自动恢复…';
      const _mjBadge = document.getElementById('tvc-meta-judge-badge');
      if (_mjBadge) { _mjBadge.style.display = 'inline-block'; _mjBadge.textContent = '⏳ 元裁判审计中'; }
      return;
    }

    const statusEl = document.getElementById('tvc-auto-status');

    // ── Step1: 组装数据（同步，无需等待）────────────────────────────
    const ws = _lastWsKlineData;
    if (!ws || !ws.lastCandleText) {
      if (statusEl) statusEl.textContent = '⚠️ 等待K线数据就绪…';
      isAutoAnalyzing = false;
      return;
    }

    const klineText = '【触发周期:1m】\n' + ws.lastCandleText + '\n' + (ws.indicatorText || '');

    // ── Step2: 重置面板并立即显示数据 ───────────────────────────────
    resetAgentPanels();

    const agKlineToggle = document.getElementById('tvc-agent-kline-toggle');
    const agKlineWrap   = document.getElementById('tvc-agent-kline-wrap');
    const agFixed       = document.getElementById('tvc-agent-fixed');
    if (agKlineToggle && agKlineWrap) {
      agKlineWrap.textContent = klineText;
      agKlineToggle.style.display = 'block';
      if (agFixed) agFixed.style.display = 'flex';
    }

    // 价格变化追踪
    const currentPrice = ws.price;
    let changeSummary = '';
    if (lastAutoPrice !== null && currentPrice !== null) {
      const priceDiff = Math.abs((currentPrice - lastAutoPrice) / lastAutoPrice * 100);
      const sign = currentPrice >= lastAutoPrice ? '+' : '';
      changeSummary = '价格变化：' + sign + (currentPrice - lastAutoPrice).toFixed(0) +
        '（' + sign + priceDiff.toFixed(2) + '%）';
    }
    lastAutoPrice = currentPrice;
    if (changeSummary) {
      const changeWrap = document.getElementById('tvc-agent-change-wrap');
      if (changeWrap) { changeWrap.style.display = 'block'; changeWrap.textContent = changeSummary; }
      if (agFixed) agFixed.style.display = 'flex';
    }

    if (!window.__tvcRunning) { isAutoAnalyzing = false; return; }
    if (statusEl) statusEl.textContent = '分析中…';

    const customPrompt = document.getElementById('tvc-auto-prompt') ?
      document.getElementById('tvc-auto-prompt').value.trim() : '';
    if (document.hidden) {
      if (statusEl) statusEl.textContent = '⏸ 页面不在前台，已跳过';
      isAutoAnalyzing = false;
      return;
    }

    // v2: 90秒看门狗。每次收到 STREAM_CHUNK 自动续期，长分析不会被误杀。
    //     挂到 window 上让 STREAM_CHUNK handler 也能调用续期。
    window.__tvcArmWatchdog = function() {
      if (window.__tvcAnalyzeTimeout) clearTimeout(window.__tvcAnalyzeTimeout);
      window.__tvcAnalyzeTimeout = setTimeout(() => {
        window.__tvcAnalyzeTimeout = null;
        if (isAutoAnalyzing) {
          isAutoAnalyzing = false;
          console.warn('[content/v2] 分析90s无进度，强制解锁');
          if (statusEl) statusEl.textContent = '⚠️ 运行中（90s 无响应，已解锁等下根K线）';
        }
      }, 90000);
    };
    window.__tvcArmWatchdog();

    // 用回调形式发送，确认 SW 已收到；若失败（SW 刚被唤醒还未就绪）延迟 800ms 重试一次
    const _autoMsg = {
      type: 'AUTO_ANALYZE',
      klineText: klineText,
      prompt: customPrompt || undefined,
      modelIndex: getModelIdx(),
      symbol: getSymbolFromUrl()
    };
    try {
      chrome.runtime.sendMessage(_autoMsg, (resp) => {
        if (chrome.runtime.lastError) {
          // SW 未就绪，直接解锁，等下一分钟自然触发，不重试（避免干扰下次触发）
          console.error('[content] AUTO_ANALYZE 发送失败，解锁:', chrome.runtime.lastError.message);
          isAutoAnalyzing = false;
          if (window.__tvcAnalyzeTimeout) { clearTimeout(window.__tvcAnalyzeTimeout); window.__tvcAnalyzeTimeout = null; }
          const st = document.getElementById('tvc-auto-status');
          if (st) st.textContent = '❌ 后台未就绪，下次自动重试';
        }
        // resp.ok === true 表示 SW 已收到，正常流程继续
      });
    } catch(e) {
      isAutoAnalyzing = false;
      if (window.__tvcAnalyzeTimeout) { clearTimeout(window.__tvcAnalyzeTimeout); window.__tvcAnalyzeTimeout = null; }
    }
  }

  async function refreshAutoResult() {
    let data;
    try {
      data = await safeStorageGet(['autoSessions']);
    } catch (e) { return; }
    const autoSessions = data.autoSessions || [];
    if (!autoSessions.length) return;

    const list = document.getElementById('tvc-auto-result-list');
    if (!list) return;

    document.getElementById('tvc-auto-result-wrap').style.display = 'flex';

    if (list.children.length === 0) {
      list.innerHTML = '';
      autoSessions.forEach(s => {
        const card = _makeAutoCard(s);
        list.appendChild(card);
      });
      return;
    }

    const existingIds = new Set();
    list.querySelectorAll('[data-session-id]').forEach(el => existingIds.add(el.dataset.sessionId));

    autoSessions.forEach(s => {
      if (!existingIds.has(s.id)) {
        const card = _makeAutoCard(s);
        list.appendChild(card);
      }
    });
  }

  function _makeAutoCard(s) {
    const card = document.createElement('div');
    card.dataset.sessionId = s.id;
    card.style.cssText = 'background:#1a1f2e;border:1px solid #2a2e39;border-radius:6px;padding:8px;font-size:12px;color:#d1d4dc;line-height:1.7';

    let dir = s.direction;
    if (!dir && s.result) {
      const dm = s.result.match(/【方向[^】]*】\s*(看涨|看跌|观望)/);
      if (dm) dir = dm[1] === '看涨' ? 'bullish' : dm[1] === '看跌' ? 'bearish' : 'neutral';
    }

    const dirColor = dir === 'bullish' ? '#4ade80' : dir === 'bearish' ? '#f87171' : dir === 'neutral' ? '#fbbf24' : '#787b86';
    const dirText  = dir === 'bullish' ? '看涨 📈' : dir === 'bearish' ? '看跌 📉' : dir === 'neutral' ? '观望 👀' : '';
    const confMatch = (s.result || '').match(/(?:方向置信度[：:][^\n]*?|【置信度[^】]*】[^0-9]*)(\d+)\s*[%％]/);
    const confStr   = confMatch ? ' ' + confMatch[1] + '%' : '';
    card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:11px;color:#787b86">'
      + '<span>' + s.time + '</span>'
      + (dirText ? '<span style="color:' + dirColor + ';font-weight:700">' + dirText + confStr + '</span>' : '')
      + '</div>';
    const toggleBtn = document.createElement('div');
    toggleBtn.className = 'tvc-auto-card-toggle';
    toggleBtn.innerHTML = '▸ 查看详情';
    const body = document.createElement('div');
    body.className = 'tvc-auto-card-body collapsed';
    body.innerHTML = formatAssistant(s.result || '');
    toggleBtn.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      toggleBtn.innerHTML = collapsed ? '▸ 查看详情' : '▾ 收起';
    });
    card.appendChild(toggleBtn);
    card.appendChild(body);
    return card;
  }

  // ── 历史 ────────────────────────────────────────────────────────
  // 内联对话流式目标：key = streamSource, value = { div, text }
  const _historyStreamTargets = new Map();

  const _historyThumbObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
        _historyThumbObserver.unobserve(img);
      }
    });
  }, { rootMargin: '80px' });

  function _parseCriticInfo(criticResult) {
    if (!criticResult) return { dir: null, conf: null };
    const jrIdx = criticResult.lastIndexOf('JSON_RESULT=');
    if (jrIdx >= 0) {
      try {
        const jsonStart = criticResult.indexOf('{', jrIdx);
        if (jsonStart >= 0) {
          let depth = 0, end = -1;
          for (let p = jsonStart; p < criticResult.length; p++) {
            if (criticResult[p] === '{') depth++;
            else if (criticResult[p] === '}') { depth--; if (depth === 0) { end = p; break; } }
          }
          if (end >= 0) {
            const jr = JSON.parse(criticResult.slice(jsonStart, end + 1));
            if (jr && jr.direction) {
              const d = jr.direction.toLowerCase();
              return { dir: d === 'bullish' ? 'bullish' : d === 'bearish' ? 'bearish' : 'neutral', conf: typeof jr.conf === 'number' ? jr.conf : null };
            }
          }
        }
      } catch(_) {}
    }
    const dirM  = criticResult.match(/[【独立判断方向】]\s*([看涨看跌观望])/);
    const confM = criticResult.match(/[【独立置信度】]\s*(\d+)/);
    const dirM2 = criticResult.match(/【独立判断方向】\s*(看涨|看跌|观望)/);
    const confM2 = criticResult.match(/【独立置信度】\s*(\d+)/);
    return {
      dir:  dirM2  ? (dirM2[1]  === '看涨' ? 'bullish' : dirM2[1] === '看跌' ? 'bearish' : 'neutral') : null,
      conf: confM2 ? parseInt(confM2[1]) : null
    };
  }

  function _makeHistoryItem(s, isAuto, sessions, autoSessions) {
    const item = document.createElement('div');
    item.className = 'tvc-history-item'
      + (isAuto ? ' tvc-auto-history-item' : '')
      + (s.isAgents ? ' tvc-manual-agents-item' : '');
    if (isAuto) item.dataset.autoId = s.id;
    if (s.isAgents) item.dataset.sessionId = s.id;
    else        item.dataset.id     = s.id;

    const top = document.createElement('div');
    top.className = 'tvc-history-top';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'tvc-history-time';
    timeSpan.textContent = s.time;
    top.appendChild(timeSpan);

    if (s.isMetaJudge) {
      // 元裁判报告：显示专属标签
      const mjSpan = document.createElement('span');
      mjSpan.style.cssText = 'font-size:11px;font-weight:700;color:#60a5fa';
      mjSpan.textContent = '📋 元裁判审计（基于' + (s.basedOn || '?') + '条记录）';
      top.appendChild(mjSpan);
    } else if (isAuto) {
      // 裁判方向 + 置信度
      const dirColor  = s.direction === 'bullish' ? '#4ade80' : s.direction === 'bearish' ? '#f87171' : '#fbbf24';
      const dirText   = s.direction === 'bullish' ? '看涨 📈' : s.direction === 'bearish' ? '看跌 📉' : '观望 👀';
      const confMatch = (s.result || '').match(/(?:方向置信度[：:][^\n]*?|【置信度[^】]*】[^0-9]*)(\d+)\s*[%％]/);
      const confStr   = confMatch ? ' ' + confMatch[1] + '%' : '';
      // 分析师方向 + 置信度
      const aDirColor = s.analystDirection === 'bullish' ? '#4ade80' : s.analystDirection === 'bearish' ? '#f87171' : '#fbbf24';
      const aDirText  = s.analystDirection === 'bullish' ? '看涨 📈' : s.analystDirection === 'bearish' ? '看跌 📉' : s.analystDirection === 'neutral' ? '观望 👀' : '';
      const aConfMatch = (s.analystResult || '').match(/(?:方向置信度[：:][^\n]*?|【置信度[^】]*】[^0-9]*)(\d+)\s*[%％]/);
      const aConfStr  = aConfMatch ? ' ' + aConfMatch[1] + '%' : '';
      const dirWrap = document.createElement('span');
      dirWrap.style.cssText = 'display:flex;flex-direction:row;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end';
      const dirSpan = document.createElement('span');
      dirSpan.style.cssText = 'font-size:11px;font-weight:700;color:' + dirColor;
      dirSpan.textContent = '⚖️ ' + dirText + confStr;
      dirWrap.appendChild(dirSpan);
      if (aDirText) {
        const sep = document.createElement('span');
        sep.style.cssText = 'font-size:10px;color:#4b5563';
        sep.textContent = '|';
        dirWrap.appendChild(sep);
        const aDirSpan = document.createElement('span');
        aDirSpan.style.cssText = 'font-size:10px;font-weight:600;color:' + aDirColor;
        aDirSpan.textContent = '🔍 ' + aDirText + aConfStr;
        dirWrap.appendChild(aDirSpan);
      }
      const criticInfo = _parseCriticInfo(s.criticResult);
      if (criticInfo.dir !== null) {
        const cDirColor = criticInfo.dir === 'bullish' ? '#4ade80' : criticInfo.dir === 'bearish' ? '#f87171' : '#fbbf24';
        const cDirText  = criticInfo.dir === 'bullish' ? '看涨 📈' : criticInfo.dir === 'bearish' ? '看跌 📉' : '观望 👀';
        const cConfStr  = criticInfo.conf != null ? ' ' + criticInfo.conf + '%' : '';
        const sep2 = document.createElement('span');
        sep2.style.cssText = 'font-size:10px;color:#4b5563';
        sep2.textContent = '|';
        dirWrap.appendChild(sep2);
        const cDirSpan = document.createElement('span');
        cDirSpan.style.cssText = 'font-size:10px;font-weight:600;color:' + cDirColor;
        cDirSpan.textContent = '⚔️ ' + cDirText + cConfStr;
        dirWrap.appendChild(cDirSpan);
      }
      top.appendChild(dirWrap);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'tvc-history-del' + (isAuto ? ' tvc-auto-del' : '');
    delBtn.title = '删除';
    delBtn.textContent = '🗑';
    if (isAuto) delBtn.dataset.autoId = s.id;
    else        delBtn.dataset.id     = s.id;

    // 内联对话按钮（仅自动模式），保存引用供后面事件绑定用
    let _chatBtnRef = null;
    if (isAuto || s.isAgents) {
      _chatBtnRef = document.createElement('button');
      _chatBtnRef.className = 'tvc-history-chat-btn';
      _chatBtnRef.title = '展开对话';
      _chatBtnRef.textContent = '💬';
      // 不插入 DOM（点卡片直接展开内联，按钮多余），但保留引用供 click() 驱动
    }
    top.appendChild(delBtn);
    item.appendChild(top);

    if (s.screenshot) {
      const img = document.createElement('img');
      img.className = 'tvc-history-thumb';
      img.alt = '';
      img.dataset.src = 'data:image/jpeg;base64,' + s.screenshot;
      item.appendChild(img);
      _historyThumbObserver.observe(img);
    }

    const preview = isAuto
      ? (s.result?.slice(0, 80) || '')
      : (s.messages?.find(m => m.role === 'assistant')?.content?.slice(0, 80) || '');
    const prevDiv = document.createElement('div');
    prevDiv.className = 'tvc-history-preview';
    prevDiv.textContent = preview + (preview.length >= 80 ? '…' : '');
    item.appendChild(prevDiv);

    // 显示各 Agent 耗时（仅自动模式，且有记录时）
    if (isAuto && s.agentTimes) {
      const t = s.agentTimes;
      const fmt = ms => ms ? (ms / 1000).toFixed(1) + 's' : '—';
      const timeParts = [];
      if (t.historian) timeParts.push('🏛️ ' + fmt(t.historian));
      if (t.analyst)   timeParts.push('🔍 ' + fmt(t.analyst));
      if (t.critic)    timeParts.push('⚔️ ' + fmt(t.critic));
      if (t.judge)     timeParts.push('⚖️ ' + fmt(t.judge));
      if (t.total)     timeParts.push('∑ ' + fmt(t.total));
      if (timeParts.length) {
        const timesDiv = document.createElement('div');
        timesDiv.style.cssText = 'font-size:10px;color:#4b5563;margin-top:3px;letter-spacing:0.02em';
        timesDiv.textContent = timeParts.join('  ');
        item.appendChild(timesDiv);
      }
    }

    delBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (isAuto) {
        const updated = autoSessions.filter(x => x.id !== s.id);
        await safeStorageSet({ autoSessions: updated });
      } else {
        const updated = sessions.filter(x => x.id !== s.id);
        await safeStorageSet({ sessions: updated });
      }
      renderHistory();
    });
    item.addEventListener('click', e => {
      if (e.target === delBtn) return;
      if (e.target.closest('.tvc-history-chat-btn')) return;
      if (e.target.closest('.tvc-history-chat')) return;
      if (s.isMetaJudge) {
        // 元裁判报告：点击展开/收起内联报告块
        let _mjInline = item.querySelector('.tvc-mj-inline');
        if (_mjInline) { _mjInline.style.display = _mjInline.style.display === 'none' ? 'block' : 'none'; return; }
        _mjInline = document.createElement('div');
        _mjInline.className = 'tvc-mj-inline';
        _mjInline.style.cssText = 'padding:10px;background:#0f2744;border-left:3px solid #3b82f6;' +
          'border-radius:4px;font-size:11px;color:#e2e8f0;white-space:pre-wrap;word-break:break-word;margin-top:6px';
        _mjInline.textContent = s.result || '（无内容）';
        item.appendChild(_mjInline);
        return;
      }
      if (!isAuto && !s.isAgents) {
        loadSession(s.id, sessions);  // 普通单模型会话：跳转到对话面板
      } else if (_chatBtnRef) {
        _chatBtnRef.click(); // 自动/三角色：点击条目 = 展开/收起内联对话
      }
    });

    // ── 内联对话区（自动模式 + 手动三角色） ───────────────────────────
    if ((isAuto || s.isAgents) && _chatBtnRef) {
      const chatBtn = _chatBtnRef;
      const chatArea = document.createElement('div');
      chatArea.className = 'tvc-history-chat';
      chatArea.style.display = 'none';

      // Agent 选择 tabs
      const tabsRow = document.createElement('div');
      tabsRow.className = 'tvc-hchat-tabs';
      // 历史学家 tab 只在有内容时显示
      const agentDefs = [
        ...(s.historianResult ? [{ key: 'historian', label: '🏛️ 历史学家' }] : []),
        { key: 'analyst', label: '🔍 分析师' },
        { key: 'critic',  label: '⚔️ 质疑师' },
        { key: 'judge',   label: '⚖️ 裁判' },
      ];
      agentDefs.forEach((a, i) => {
        const t = document.createElement('button');
        t.className = 'tvc-hchat-tab' + (i === 0 ? ' active' : '');
        t.dataset.agent = a.key;
        t.textContent = a.label;
        tabsRow.appendChild(t);
      });
      chatArea.appendChild(tabsRow);

      // ── 抓取数据折叠区（回测用）────────────────────────────────
      if (s.klineText) {
        const klineToggle = document.createElement('div');
        klineToggle.style.cssText = 'font-size:11px;color:#4fc3f7;cursor:pointer;padding:4px 0;user-select:none;border-top:1px solid #2a2e39;margin-top:4px';
        klineToggle.textContent = '▸ 查看抓取数据';

        const klineBox = document.createElement('div');
        klineBox.style.cssText = 'display:none;background:#0d1117;border:1px solid #2a2e39;border-radius:6px;padding:8px;font-size:10px;color:#787b86;white-space:pre-wrap;max-height:200px;overflow-y:auto;margin-bottom:6px;line-height:1.6;font-family:monospace';
        klineBox.textContent = s.klineText;

        klineToggle.addEventListener('click', () => {
          const open = klineBox.style.display === 'none';
          klineBox.style.display = open ? 'block' : 'none';
          klineToggle.textContent = open ? '▾ 收起抓取数据' : '▸ 查看抓取数据';
        });

        chatArea.appendChild(klineToggle);
        chatArea.appendChild(klineBox);
      }

      // Agent 原始内容区
      const agentContentMap = {
        historian: s.historianResult || '',
        analyst:   s.analystResult   || '（暂无分析师内容）',
        critic:    s.criticResult    || '（暂无质疑师内容）',
        judge:     s.result          || '（暂无裁判内容）',
      };
      const originalContent = document.createElement('div');
      originalContent.className = 'tvc-hchat-original';
      chatArea.appendChild(originalContent);

      // 对话消息区（追问记录）
      const msgsArea = document.createElement('div');
      msgsArea.className = 'tvc-hchat-msgs';
      chatArea.appendChild(msgsArea);

      // 输入行
      const inputRow = document.createElement('div');
      inputRow.className = 'tvc-hchat-input-row';
      const textarea = document.createElement('textarea');
      textarea.className = 'tvc-hchat-input';
      textarea.placeholder = '向选中的 Agent 追问…';
      textarea.rows = 2;
      const sendBtn2 = document.createElement('button');
      sendBtn2.className = 'tvc-hchat-send';
      sendBtn2.textContent = '发送';
      inputRow.appendChild(textarea);
      inputRow.appendChild(sendBtn2);
      chatArea.appendChild(inputRow);
      item.appendChild(chatArea);

      // 对话状态（每个 item 独立）
      let chatAgent = s.historianResult ? 'historian' : 'analyst';
      const chatHistory = { historian: [], judge: [], analyst: [], critic: [] };

      function renderChatMsgs() {
        // 显示当前 Agent 的原始分析内容
        originalContent.innerHTML = formatAssistant(agentContentMap[chatAgent] || '');
        // 显示追问对话记录
        msgsArea.innerHTML = '';
        chatHistory[chatAgent].forEach(m => {
          const div = document.createElement('div');
          div.className = m.role === 'user' ? 'tvc-hchat-user' : 'tvc-hchat-assistant';
          div.innerHTML = m.role === 'assistant' ? formatAssistant(m.content) : escHtml(m.content);
          msgsArea.appendChild(div);
        });
        msgsArea.scrollTop = msgsArea.scrollHeight;
      }

      async function sendHistoryChat() {
        const text = textarea.value.trim();
        if (!text || sendBtn2.disabled) return;
        textarea.value = '';
        sendBtn2.disabled = true;
        chatHistory[chatAgent].push({ role: 'user', content: text });
        renderChatMsgs();

        const streamSource = 'hchat_' + s.id + '_' + chatAgent;
        const streamDiv = document.createElement('div');
        streamDiv.className = 'tvc-hchat-assistant tvc-hchat-streaming';
        streamDiv.textContent = '…';
        msgsArea.appendChild(streamDiv);
        msgsArea.scrollTop = msgsArea.scrollHeight;
        _historyStreamTargets.set(streamSource, { div: streamDiv, text: '', msgsArea });

        try {
          const resp = await chrome.runtime.sendMessage({
            type: 'HISTORY_CHAT',
            sessionId: s.id,
            agent: chatAgent,
            history: chatHistory[chatAgent].slice(0, -1),
            text: text,
            streamSource: streamSource
          });
          if (resp && resp.result) {
            chatHistory[chatAgent].push({ role: 'assistant', content: resp.result });
          } else {
            streamDiv.textContent = '❌ ' + (resp && resp.error ? resp.error : '请求失败');
          }
        } catch(e) {
          streamDiv.textContent = '❌ 发送失败';
        }
        _historyStreamTargets.delete(streamSource);
        sendBtn2.disabled = false;
        renderChatMsgs();
      }
      chatBtn.addEventListener('click', e => {
        e.stopPropagation();
        const isOpen = chatArea.style.display !== 'none';
        chatArea.style.display = isOpen ? 'none' : 'block';
        chatBtn.classList.toggle('active', !isOpen);
        if (!isOpen) { renderChatMsgs(); textarea.focus(); }
      });
      // chatBtn 未插入 DOM，renderHistory 无法用 querySelector 找到它。
      // 暴露 _tvcOpen 供 renderHistory 恢复展开状态时直接调用。
      // scrollTops: { chat, orig } — 恢复内部各区域的滚动位置，防止新记录进来时跳回顶部
      chatArea._tvcOpen = (scrollTops) => {
        chatArea.style.display = 'block';
        chatBtn.classList.add('active');
        renderChatMsgs();
        if (scrollTops) {
          requestAnimationFrame(() => {
            if (scrollTops.chat != null) chatArea.scrollTop = scrollTops.chat;
            if (scrollTops.orig != null) {
              const origEl = chatArea.querySelector('.tvc-hchat-original');
              if (origEl) origEl.scrollTop = scrollTops.orig;
            }
            if (scrollTops.msgs != null) {
              const msgsEl = chatArea.querySelector('.tvc-hchat-msgs');
              if (msgsEl) msgsEl.scrollTop = scrollTops.msgs;
            }
          });
        }
      };
      tabsRow.addEventListener('click', e => {
        const tab = e.target.closest('.tvc-hchat-tab');
        if (!tab) return;
        chatAgent = tab.dataset.agent;
        tabsRow.querySelectorAll('.tvc-hchat-tab').forEach(t => t.classList.toggle('active', t === tab));
        renderChatMsgs();
      });
      sendBtn2.addEventListener('click', sendHistoryChat);
      textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendHistoryChat(); }
      });
    }

    return item;
  }

  // ── 历史子 tab 和方向筛选状态 ──────────────────────────────────
  let historyTab = 'auto';   // 'auto' | 'manual'
  let historyDir = 'all';    // 'all' | 'bullish' | 'bearish' | 'neutral'

  document.getElementById('tvc-history-view').addEventListener('click', e => {
    const subtab = e.target.closest('.tvc-history-subtab');
    if (subtab) {
      historyTab = subtab.dataset.htab;
      document.querySelectorAll('.tvc-history-subtab').forEach(t => t.classList.remove('active'));
      subtab.classList.add('active');
      const filterEl = document.getElementById('tvc-history-filter');
      if (filterEl) filterEl.style.display = historyTab === 'auto' ? 'flex' : 'none';
      renderHistory();
      return;
    }
    const filterBtn = e.target.closest('.tvc-history-filter-btn');
    if (filterBtn) {
      historyDir = filterBtn.dataset.dir;
      document.querySelectorAll('.tvc-history-filter-btn').forEach(b => b.classList.remove('active'));
      filterBtn.classList.add('active');
      renderHistory();
    }
  });

  // v3.16.3 元裁判审计卡片（内联进「历史」列表，替代弹窗；样式贴近会话卡片，可折叠/复制）
  function _makeMetaJudgeItem(report) {
    const item = document.createElement('div');
    item.className = 'tvc-meta-history-item';
    item.style.cssText = 'border:1px solid #2a3350;border-left:3px solid #4fc3f7;border-radius:8px;'
      + 'background:#161b2b;padding:8px 10px';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:5px;cursor:pointer';
    head.innerHTML = '<span style="color:#6b7280">' + (report.createdAt || '') + '</span>'
      + '<span style="color:#93c5fd;font-weight:600">📋 元裁判审计（基于'
      + (report.basedOn != null ? report.basedOn : '—') + '条记录）</span>'
      + '<span class="tvc-meta-copy" title="复制报告" style="cursor:pointer;color:#6b7280;margin-left:auto">⧉</span>'
      + '<span class="tvc-agent-collapse-arrow" style="margin-left:2px;transform:rotate(-90deg)">▾</span>';
    const body = document.createElement('div');
    body.style.cssText = 'display:none;font-size:11.5px;line-height:1.55;color:#cbd5e1;white-space:pre-wrap;'
      + 'word-break:break-word;user-select:text';
    body.textContent = report.content || '';
    head.addEventListener('click', function(e) {
      if (e.target && e.target.classList.contains('tvc-meta-copy')) {
        try {
          navigator.clipboard.writeText(report.content || '');
          e.target.textContent = '✓';
          setTimeout(function() { e.target.textContent = '⧉'; }, 1200);
        } catch (_) {}
        return;
      }
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      const arr = head.querySelector('.tvc-agent-collapse-arrow');
      if (arr) arr.style.transform = collapsed ? '' : 'rotate(-90deg)';
    });
    item.appendChild(head); item.appendChild(body);
    return item;
  }

  async function renderHistory() {
    const data = await safeStorageGet(['sessions', 'autoSessions', 'metaJudgeReports', 'metaJudgeReport']);
    const sessions = data.sessions || [];
    const autoSessions = data.autoSessions || [];
    const list = document.getElementById('tvc-history-list');

    // ── Fix: 重绘前保存状态，重绘后恢复（防止新记录打断查看）────────
    const savedScrollTop = list.scrollTop;  // 滚动位置

    // 记录已展开的对话区 + 其中的输入框内容
    const openAutoIds = new Set();
    const savedInputs      = {};   // id → textarea value
    const savedAgent       = {};   // id → active tab key
    const savedChatScrolls = {};   // id → { chat, orig, msgs } 内部各区域滚动位置
    list.querySelectorAll('.tvc-auto-history-item, .tvc-manual-agents-item').forEach(el => {
      const chatArea = el.querySelector('.tvc-history-chat');
      if (chatArea && chatArea.style.display !== 'none') {
        const id = el.dataset.autoId || el.dataset.sessionId;
        openAutoIds.add(id);
        const ta = chatArea.querySelector('textarea');
        if (ta && ta.value) savedInputs[id] = ta.value;
        const activeTab = chatArea.querySelector('.tvc-hchat-tab.active');
        if (activeTab) savedAgent[id] = activeTab.dataset.agent;
        // 保存内部各滚动区的位置
        const origEl = chatArea.querySelector('.tvc-hchat-original');
        const msgsEl = chatArea.querySelector('.tvc-hchat-msgs');
        savedChatScrolls[id] = {
          chat: chatArea.scrollTop,
          orig: origEl ? origEl.scrollTop : 0,
          msgs: msgsEl ? msgsEl.scrollTop : 0,
        };
      }
    });

    if (historyTab === 'auto') {
      const filtered = historyDir === 'all'
        ? autoSessions
        : autoSessions.filter(s => s.direction === historyDir);
      // v3.16.3 元裁判审计报告内联到历史列表，按时间与会话交错；方向过滤(看涨/看跌/观望)时不混入审计
      let metaReports = data.metaJudgeReports || [];
      if (!metaReports.length && data.metaJudgeReport && data.metaJudgeReport.content) metaReports = [data.metaJudgeReport];
      if (historyDir !== 'all') metaReports = [];
      if (!filtered.length && !metaReports.length) {
        list.innerHTML = '<div class="tvc-empty">暂无记录</div>'; return;
      }
      const _items = [];
      filtered.forEach(s => _items.push({ ts: s.dataTimestamp || 0, build: () => _makeHistoryItem(s, true, sessions, autoSessions) }));
      metaReports.forEach(r => _items.push({ ts: r.ts || Date.now(), build: () => _makeMetaJudgeItem(r) }));
      _items.sort((a, b) => b.ts - a.ts);
      const frag = document.createDocumentFragment();
      _items.forEach(it => frag.appendChild(it.build()));
      list.innerHTML = '';
      list.appendChild(frag);
      // 恢复展开状态 + 输入框内容 + tab选中 + 滚动位置
      if (openAutoIds.size) {
        list.querySelectorAll('.tvc-auto-history-item').forEach(el => {
          const id = el.dataset.autoId;
          if (openAutoIds.has(id)) {
            // chatBtn 不在 DOM 中，直接调用 _tvcOpen 恢复展开状态
            const chatArea = el.querySelector('.tvc-history-chat');
            if (chatArea && chatArea._tvcOpen) chatArea._tvcOpen(savedChatScrolls[id]);
            // 恢复 tab 选中
            if (savedAgent[id]) {
              const tab = el.querySelector(`.tvc-hchat-tab[data-agent="${savedAgent[id]}"]`);
              if (tab) tab.click();
            }
            // 恢复输入框
            if (savedInputs[id]) {
              const ta = el.querySelector('.tvc-history-chat textarea');
              if (ta) ta.value = savedInputs[id];
            }
          }
        });
      }
      // 恢复滚动位置（放 requestAnimationFrame 等 DOM 更新后执行）
      requestAnimationFrame(() => { list.scrollTop = savedScrollTop; });
    } else {
      if (!sessions.length) {
        list.innerHTML = '<div class="tvc-empty">暂无手动分析记录</div>'; return;
      }
      const frag = document.createDocumentFragment();
      sessions.forEach(s => frag.appendChild(_makeHistoryItem(s, false, sessions, autoSessions)));
      list.innerHTML = '';
      list.appendChild(frag);
      // 恢复三角色手动会话展开状态 + 输入 + tab + 滚动
      if (openAutoIds.size) {
        list.querySelectorAll('.tvc-manual-agents-item').forEach(el => {
          const id = el.dataset.sessionId;
          if (openAutoIds.has(id)) {
            // chatBtn 不在 DOM 中，直接调用 _tvcOpen 恢复展开状态
            const chatArea = el.querySelector('.tvc-history-chat');
            if (chatArea && chatArea._tvcOpen) chatArea._tvcOpen(savedChatScrolls[id]);
            if (savedAgent[id]) {
              const tab = el.querySelector(`.tvc-hchat-tab[data-agent="${savedAgent[id]}"]`);
              if (tab) tab.click();
            }
            if (savedInputs[id]) {
              const ta = el.querySelector('.tvc-history-chat textarea');
              if (ta) ta.value = savedInputs[id];
            }
          }
        });
      }
      requestAnimationFrame(() => { list.scrollTop = savedScrollTop; });
    }
  }

  function loadSession(id, sessions) {
    const s = sessions.find(x => x.id === id);
    if (!s) return;
    currentSessionId = s.id;
    sidebar.querySelectorAll('.tvc-tab').forEach(t => t.classList.remove('active'));
    sidebar.querySelector('.tvc-tab[data-tab="chat"]').classList.add('active');
    document.getElementById('tvc-chat-view').style.display = 'flex';
    document.getElementById('tvc-auto-view').style.display = 'none';
    document.getElementById('tvc-history-view').style.display = 'none';
    getMsgs().innerHTML = '';

    if (s.isAgents) {
      // ── 三角色会话：渲染三个折叠面板 ─────────────────────────────
      const card = createCard();
      const agents = [
        { key: 'analyst', label: '🔍 分析师', color: '#4fc3f7', text: s.analystResult },
        { key: 'critic',  label: '⚔️ 质疑师', color: '#fbbf24', text: s.criticResult  },
        { key: 'judge',   label: '⚖️ 裁判',   color: '#4ade80', text: s.result        },
      ];
      agents.forEach(({ label, color, text }) => {
        if (!text) return;
        const wrap = document.createElement('div');
        wrap.style.marginBottom = '6px';

        const lbl = document.createElement('div');
        lbl.className = 'tvc-agent-label';
        lbl.style.cursor = 'pointer';
        lbl.innerHTML = '<span style="color:' + color + '">' + label + '</span>'
          + '<span class="tvc-agent-collapse-arrow" style="margin-left:auto">▾</span>';

        const body = document.createElement('div');
        body.className = 'tvc-agent-body';
        body.innerHTML = formatAssistant(text);

        lbl.addEventListener('click', () => {
          const collapsed = body.classList.toggle('collapsed');
          const arr = lbl.querySelector('.tvc-agent-collapse-arrow');
          if (arr) arr.style.transform = collapsed ? 'rotate(-90deg)' : '';
        });

        wrap.appendChild(lbl);
        wrap.appendChild(body);
        card.appendChild(wrap);
      });
      scrollBottom();
    } else {
      // ── 普通单模型会话：渲染消息列表 ──────────────────────────────
      s.messages.forEach(m => {
        if (m.role === 'user' && !m.isFirst) appendUserMsg(m.content, m.attachments?.map(a => a.name));
        else if (m.role === 'assistant') appendAssistantMsg(m.content);
      });
    }
    updateSendState();
  }

  // ── 向 iframe 请求 K线数据 ──────────────────────────────────────
  function requestKlineFromIframe(timeoutMs) {
    timeoutMs = timeoutMs || 6000;
    return new Promise(function(resolve, reject) {
      const iframe = document.querySelector('iframe[id^="tradingview_"]') ||
                     document.querySelector('iframe[src^="blob:"]') ||
                     document.querySelector('iframe[title*="图表"]') ||
                     document.querySelector('iframe[title*="chart"]') ||
                     document.querySelector('iframe[title*="Chart"]');
      if (!iframe) {
        reject(new Error('未找到图表 iframe，请确认在 Binance 交易页面使用'));
        return;
      }
      function tryRead() {
        try {
          const doc = iframe.contentDocument;
          if (!doc || !doc.body) {
            reject(new Error('图表 iframe 尚未加载，请稍候重试'));
            return;
          }
          const result = runKlineInDoc(doc);
          resolve(result);
        } catch(e) {
          reject(new Error('访问图表 iframe 失败: ' + e.message));
        }
      }
      // 必须先注册 load 监听器再检查 readyState，否则两步之间状态可能切到 complete，监听器永远不触发
      const t = setTimeout(function() {
        reject(new Error('图表 iframe 加载超时，请刷新页面后重试'));
      }, timeoutMs);
      const onLoad = function() { clearTimeout(t); tryRead(); };
      iframe.addEventListener('load', onLoad, { once: true });
      // 注册完监听器后再检查：若已经 complete，直接读取并移除监听器
      if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
        clearTimeout(t);
        iframe.removeEventListener('load', onLoad);
        tryRead();
      }
    });
  }

  function runKlineInDoc(doc) {
    const ITEM_SEL  = ['[class*="item-"]','[class*="legendItem"]','[class*="legend-"]'];
    const TITLE_SEL = ['[class*="titlesWrapper"]','[class*="title"]','[class*="name"]'];
    const VAL_SEL   = ['[class*="valueValue"]','[class*="value-"]','[class*="price"]'];

    function tryFind(root, sels) { for (const s of sels) { const e = root.querySelector(s); if (e) return e; } return null; }
    function tryFindAll(root, sels) { for (const s of sels) { const es = [...root.querySelectorAll(s)]; if (es.length) return es; } return []; }

    let allItems = [];
    for (const sel of ITEM_SEL) {
      allItems = [...doc.querySelectorAll(sel)].filter(el => tryFind(el, TITLE_SEL) && tryFind(el, VAL_SEL));
      if (allItems.length) break;
    }
    if (!allItems.length) return '未找到图例节点，请将鼠标移入图表区域后再抓取。';

    const panes = []; let cur = null; let curInd = null;
    allItems.forEach(item => {
      const titleEl = tryFind(item, TITLE_SEL);
      const rawTitle = titleEl?.innerText?.trim() || '';
      const vals = tryFindAll(item, VAL_SEL)
        .map(v => ({ v: v.innerText?.trim(), c: v.style.color }))
        .filter(x => x.v && x.v !== '∅' && x.v !== '' && !/^[−\-]?0+\.?0*$/.test(x.v));
      const isMain = /Bitcoin|Ethereum|Ripple|Solana|Binance|Tether|USDT|USD\b|BTC|ETH|XRP|SOL/i.test(rawTitle)
        && vals.some(x => /%/.test(x.v));
      if (isMain) {
        cur = { pair: extractPair(rawTitle), tf: extractTF(rawTitle), kline: extractKline(vals), indicators: [], _nc: {} };
        panes.push(cur);
      } else if (cur && rawTitle) {
        const bn = cleanName(rawTitle);
        cur._nc[bn] = (cur._nc[bn] || 0) + 1;
        const count = cur._nc[bn];
        const rawName = cleanName(rawTitle) + (count > 1 ? ' #' + count : '');
        curInd = { name: rawName, rawTitle: rawTitle, vals: vals };
        cur.indicators.push(curInd);
      }
    });

    // 清理：去掉 _nc 辅助字段
    panes.forEach(p => { delete p._nc; });

    // 修正指标名（用 INDICATOR_LABELS 匹配后的规范名覆盖）
    panes.forEach(p => {
      p.indicators.forEach(ind => {
        const labels = getLabels(ind.rawTitle);
        if (labels) ind.name = ind.rawTitle.split('\n')[0].trim();
        else ind.name = ind.bn;
      });
    });

    if (!panes.length) return '未能识别时间周期，请将鼠标移入图表区域后再抓取。';

    const allZero = panes.every(p => p.indicators.every(ind => ind.vals.length === 0));
    const zeroHint = allZero && panes.some(p => p.indicators.length > 0)
      ? '⚠️ 指标数值均为空（可能鼠标未悬停在图表上），请将鼠标移到图表蜡烛上后再抓取。\n\n'
      : '';

    let out = zeroHint + `【时间】${new Date().toLocaleString('zh-CN')}\n【时间周期数】${panes.length}\n`;
    panes.forEach((pane, i) => {
      out += `\n${'═'.repeat(38)}\n▌ 第${i+1}个时间周期`;
      if (pane.tf) out += ` (${pane.tf})`;
      if (pane.pair) out += `  ${pane.pair}`;
      out += `\n${'═'.repeat(38)}\n`;
      if (pane.kline) { out += '\n【K线数据】\n'; Object.entries(pane.kline).forEach(([k,v]) => { out += `  ${k}: ${v}\n`; }); }
      if (pane.indicators.length) {
        out += '\n【技术指标】\n';
        pane.indicators.forEach(ind => {
          out += `\n  ┌─ ${ind.name}\n`;
          if (!ind.vals.length) {
            out += '  │  （无数值，请将鼠标移到图表上后再抓取）\n';
          } else {
            const labels = getLabels(ind.rawTitle);
            ind.vals.forEach((x, idx) => {
              const label = labels && labels[idx] ? labels[idx] + ': ' : '';
              out += `  │  ${label}${x.v}\n`;
            });
          }
          out += '  └─\n';
        });
      }
    });
    return out;
  }

})();