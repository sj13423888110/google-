// ── 共享模块 ─────────────────────────────────────────────────────
// 胜率统计纯函数，与 content.js 共用同一份实现，避免双向漂移
// v3.12.4 升级：元裁判接入Binance历史K线做事后走势对照 / suppress误杀率专项统计 / 新增THRESHOLD_SUGGESTIONS机读块
importScripts('./winrate-calc.js');
const { calcWinRate, calcWinRateByLimit, calcConditionalWinRate } = self.WinRateCalc;

// storage 命名空间补丁（必须在任何 chrome.storage.local.* 调用之前执行）
importScripts('./storage-keys.js');
self.StorageNS.patchStorage();

// ── SW 启动广播：通知所有 tab 重置 isAutoAnalyzing/isSending ──────────
// MV3 SW 随时可能被回收再重启；重启后 content.js 的锁状态可能卡死
// 每次 SW 启动时广播一次，让 content.js 强制解锁，防止"没任何动静"
(function broadcastSwRestarted() {
  // Fix: SW 重启意味着任何正在运行的元裁判已强制中断，清除可能残留的僵尸标志
  // 否则 metaJudgeRunning:true 会永久留在 storage，导致主流程永远卡住
  chrome.storage.local.set({ metaJudgeRunning: false, metaJudgePendingAt: 0 }).catch(function() {});
  chrome.tabs.query({}, function(tabs) {
    tabs.forEach(function(tab) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'SW_RESTARTED' }).catch(function() {});
      }
    });
  });
})();

// ── 历史学家预计算缓存（key: 市场签名, value: {result, ts}）──────────────
// 分析完成后后台静默预热，下次分析直接读缓存，省去10-15s
let _historianCache = null;
// { result: string, ts: number, sig: string }
// v2.2 改动：TTL 从 4 分钟缩到 60 秒。原 4 分钟会跨 3-4 根 K 线，行情转折初期仍命中旧结论，
// 反而误导分析师。1 分钟的容差仅覆盖同一根 K 线内的重复触发。
const HISTORIAN_CACHE_TTL = 60 * 1000;

// K线状态签名：用于历史学家结果缓存的 key + 相似度检索的关键字段
// 维度：marketState(3) × RSI区(3) × MACD符号(2) × ADX强弱(2) × EMA排列(5) × BB%B区(5)
//       × 价格相对 EMA21 偏离度(4) — v2.2 新增
//       × 时段(4: 亚早/亚晚/欧/美) — v2.4 新增
// 理论组合 ≈ 14400 种。第三个参数 dataTimestamp 可选；缺省时尝试从 klineText 抓【入场时间戳】。
// v3.6 Bug3修复：makeKlineSig 改为优先从结构化 payload 提取多周期特征，
// 原实现用 t.match()（无g标志）只能读到文本中第一个匹配（1m数据），
// 导致签名退化为单周期，5m/15m 背离场景下缓存严重碰撞。
function makeKlineSig(klineText, marketState, dataTimestamp) {
  const t = klineText || '';

  // 优先从 JSON payload 提取多周期特征（精确、无碰撞）
  const payload = extractBinaryFeaturePayload(t);
  const f1m  = payload && payload.feature_pool && payload.feature_pool['1m']  || null;
  const f5m  = payload && payload.feature_pool && payload.feature_pool['5m']  || null;
  const f15m = payload && payload.feature_pool && payload.feature_pool['15m'] || null;

  // 从 payload 取值，兜底才用文本解析
  const num = (re, def) => {
    const m = t.match(re);
    if (!m) return def;
    const v = parseFloat(m[1]);
    return isFinite(v) ? v : def;
  };

  // 1m 基础字段（优先 payload，兜底文本）
  const rsi   = f1m && isFinite(f1m.rsi)      ? f1m.rsi      : num(/RSI(?:\(\d+\))?\s*[=：:]\s*([\d.]+)/i, 50);
  const dif   = f1m && isFinite(f1m.macdDif)  ? f1m.macdDif  : num(/\bDIF\s*[=：:]\s*([-\d.]+)/i, 0);
  const adx   = f1m && isFinite(f1m.adx)      ? f1m.adx      : num(/\bADX\s*[=：:]\s*([\d.]+)/i, 0);
  const ema21 = f1m && isFinite(f1m.ema21)    ? f1m.ema21    : num(/\bEMA21\s*[=：:]\s*([\d.]+)/i, NaN);
  const ema55 = f1m && isFinite(f1m.ema55)    ? f1m.ema55    : num(/\bEMA55\s*[=：:]\s*([\d.]+)/i, NaN);
  const ema8  = num(/\bEMA8\s*[=：:]\s*([\d.]+)/i, NaN);
  const bbU   = f1m && f1m.raw && isFinite(f1m.raw.bbUpper) ? f1m.raw.bbUpper : num(/BB[^\n]*?上轨\s*[=：:]\s*([\d.]+)/, NaN);
  const bbL   = f1m && f1m.raw && isFinite(f1m.raw.bbLower) ? f1m.raw.bbLower : num(/下轨\s*[=：:]\s*([\d.]+)/, NaN);
  const close = f1m && isFinite(f1m.price)    ? f1m.price    : (() => {
    const m = t.match(/收\s*([\d.]+)/); return m ? parseFloat(m[1]) : NaN;
  })();

  // 多周期签名维度（核心修复：加入5m/15m状态，防止单周期碰撞）
  const rsi5m  = f5m  && isFinite(f5m.rsi)  ? f5m.rsi  : NaN;
  const adx5m  = f5m  && isFinite(f5m.adx)  ? f5m.adx  : NaN;
  const rsi15m = f15m && isFinite(f15m.rsi) ? f15m.rsi : NaN;
  const trend5m = f5m  ? (f5m.trendBias  || '?') : '?';
  const trend15m = f15m ? (f15m.trendBias || '?') : '?';
  const rsiZone5m  = isFinite(rsi5m)  ? (rsi5m  > 70 ? 'ob' : rsi5m  < 30 ? 'os' : 'mid') : '?';
  const rsiZone15m = isFinite(rsi15m) ? (rsi15m > 70 ? 'ob' : rsi15m < 30 ? 'os' : 'mid') : '?';
  const adxLevel5m = isFinite(adx5m)  ? (adx5m  > 25 ? 'S' : 'W') : '?';

  // 1. RSI 区间
  const rsiZone  = rsi > 70 ? 'ob' : rsi < 30 ? 'os' : 'mid';
  // 2. MACD 符号
  const macdSign = dif >= 0 ? '+' : '-';
  // 3. ADX 强弱（>25 视为有效趋势）
  const adxLevel = adx > 25 ? 'S' : 'W';

  // 4. EMA 排列：多头/空头/上交叉/下交叉/混乱/未知
  let emaArr;
  if ([ema8, ema21, ema55].some(v => isNaN(v))) emaArr = '?';
  else if (ema8 > ema21 && ema21 > ema55)       emaArr = 'bull';
  else if (ema8 < ema21 && ema21 < ema55)       emaArr = 'bear';
  else if (ema8 > ema21 && ema21 < ema55)       emaArr = 'xup';   // 8 上穿 21，但 21 仍在 55 下方（早期反转）
  else if (ema8 < ema21 && ema21 > ema55)       emaArr = 'xdn';   // 8 下穿 21，但 21 仍在 55 上方（早期回调）
  else                                          emaArr = 'mix';

  // 5. BB %B 区间：上轨外/上半区/下半区/下轨外/未知
  let bbZone = '?';
  if (!isNaN(bbU) && !isNaN(bbL) && !isNaN(close) && bbU > bbL) {
    const pctB = (close - bbL) / (bbU - bbL);
    if      (pctB >= 1)   bbZone = 'top';   // 突破上轨
    else if (pctB >= 0.5) bbZone = 'up';    // 中轨上方
    else if (pctB >= 0)   bbZone = 'dn';    // 中轨下方
    else                  bbZone = 'btm';   // 跌破下轨
  }

  // 6. 价格相对 EMA21 偏离度区间 — v2.2 新增维度
  // 同一个市场状态/EMA排列下，价格在 EMA21 上方 0.1% 还是 0.5% 是完全不同的格局
  // 这一维度让缓存键的分辨率从 ~900 提升到 ~3600，降低 BTC 1m 常见组合凝固答案的风险
  let devZone = '?';
  if (!isNaN(close) && !isNaN(ema21) && ema21 > 0) {
    const dev = (close - ema21) / ema21;
    if      (dev >=  0.005) devZone = 'farUp'; // > +0.5%
    else if (dev >=  0)     devZone = 'up';
    else if (dev >  -0.005) devZone = 'dn';
    else                    devZone = 'farDn'; // < -0.5%
  }

  // 7. 时段维度 — v2.4 新增（UTC 小时分段）
  //    亚早盘(aEarly: UTC 0-6) / 亚晚盘(aLate: UTC 6-12) / 欧盘(euro: UTC 12-18) / 美盘(us: UTC 18-24)
  //    BTC 在不同时段的假突破频率和波动率差异显著，应让历史学家在同时段内匹配案例
  let sessionBand = '?';
  let _tsForBand = dataTimestamp;
  if (!_tsForBand || !Number.isFinite(_tsForBand)) {
    const _tsM = (klineText || '').match(/【入场时间戳】(\d+)/);
    if (_tsM) _tsForBand = parseInt(_tsM[1]);
  }
  if (_tsForBand && Number.isFinite(_tsForBand)) {
    const utcH = new Date(_tsForBand).getUTCHours();
    if      (utcH < 6)  sessionBand = 'aEarly';
    else if (utcH < 12) sessionBand = 'aLate';
    else if (utcH < 18) sessionBand = 'euro';
    else                sessionBand = 'us';
  }

  // v3.12: 相位 / 结构 / 量能regime / 动量 维度 —— 让历史学家匹配"同相位"案例。
  //   关键修复：原签名里"力竭底部(即将反弹)"和"健康推进(即将续跌)"几乎同签名(都farDn+空头)，
  //   历史胜率因此是噪声。加入相位后，只有同相位的历史才会被匹配。
  const lsPhase = payload && payload.layered_score && payload.layered_score.phase || null;
  const phaseSig = lsPhase && lsPhase.confirmed ? (lsPhase.phase || 'p?')
                 : 'noTrend';
  const retraceSig = lsPhase && lsPhase.retraceType ? lsPhase.retraceType : 'x';
  // 执行周期(优先5m)的结构与量能/动量
  const fEx = f5m || f1m || null;
  const structSig = fEx && fEx.swing ? (fEx.swing.structure || '?') : '?';   // up/down/range
  const volSig    = fEx && fEx.volRegime ? fEx.volRegime : '?';              // expanding/contracting/flat
  const divSig    = fEx && fEx.momDivergence ? fEx.momDivergence : 'x';      // bull/bear/x

  return [
    marketState || '?',
    rsiZone, macdSign, adxLevel, emaArr, bbZone, devZone, sessionBand,
    rsiZone5m, adxLevel5m, trend5m,   // v3.6: 5m维度，防止多周期背离时缓存碰撞
    rsiZone15m, trend15m,              // v3.6: 15m维度
    phaseSig, retraceSig, structSig, volSig, divSig  // v3.12: 相位指纹
  ].join('_');
}

// v3.13.5：历史学家专用"粗签名"（只3维），与 makeKlineSig(18维,用于缓存key)分离。
//   18维签名空间太大，"sim≥4且≥10条同类"几乎永远凑不齐 → 历史学家长期沉默。
//   粗签名只取最本质3维：相位 + 可交易方向 + 市场态，让同类案例能攒够、可比。
//   满分=3；历史学家要求 sim≥2 且 ≥10 条才给有效结论，不足则明说"样本不足、仅参考、不调置信度"。
function makeCoarseSig(klineText, marketState) {
  const payload = extractBinaryFeaturePayload(klineText || '');
  const ls = payload && payload.layered_score || null;
  const ph = ls && ls.phase || null;
  const phaseSig = ph && ph.phase ? ph.phase : 'p?';
  const dirSig = ph && ph.tradeDir ? ph.tradeDir : (ph && ph.bgDir ? ph.bgDir : 'd?');
  const ms = marketState || (payload && payload.feature_pool && payload.feature_pool['5m'] && payload.feature_pool['5m'].marketState) || '?';
  return [phaseSig, dirSig, ms].join('_');
}


function extractBinaryFeaturePayload(klineText) {
  if (!klineText || typeof klineText !== 'string') return null;
  const m = klineText.match(/【BINARY_OPTIONS_FEATURES_V2】([\s\S]*?)【\/BINARY_OPTIONS_FEATURES_V2】/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

function stripBinaryFeaturePayload(klineText) {
  return (klineText || '').replace(/\n?【BINARY_OPTIONS_FEATURES_V2】[\s\S]*?【\/BINARY_OPTIONS_FEATURES_V2】\n?/g, '\n').trim();
}

function summarizeBinaryCandidate(c) {
  if (!c) return '';
  const reasons = c.no_trade_reasons && c.no_trade_reasons.length ? ('；注意=' + c.no_trade_reasons.join('、')) : '';
  // v3.1: 不显示方向/置信度（已从规则算法移除，由LLM独立判断）
  return (c.label || (c.expiry + 'M')) + '：趋势分' + c.trend_score + '，触发分' + c.trigger_score + '，风险分' + c.risk_score + '，合计' + c.total_score + reasons;
}

function buildRoleSpecificViews(klineText) {
  const payload = extractBinaryFeaturePayload(klineText);
  const rawText = stripBinaryFeaturePayload(klineText || '');
  if (!payload) {
    return {
      payload: null,
      rawText,
      historianText: rawText,
      analystText: rawText,
      criticText: rawText,
      judgeText: rawText
    };
  }
  const featurePool = payload.feature_pool || {};
  const best = payload.best_candidate || null;
  const candidates = payload.expiry_candidates || [];
  const candidateLines = candidates.map(c => '  - ' + summarizeBinaryCandidate(c)).join('\n');
  const tfLines = Object.keys(featurePool).map(tf => {
    const f = featurePool[tf] || {};
    return '  - ' + tf + '：marketState=' + (f.marketState || '不明') +
      ' trendBias=' + (f.trendBias || 'unknown') +
      ' RSI=' + (f.rsi != null ? f.rsi : '—') +
      ' MACD柱=' + (f.macdHist != null ? f.macdHist : '—') +
      ' ADX=' + (f.adx != null ? f.adx : '—') +
      ' volRatio=' + (f.volRatio != null ? f.volRatio : '—') +
      ' flags=' + ((f.triggerFlags || []).join(',') || 'none');
  }).join('\n');
  const bestLine = best ? summarizeBinaryCandidate(best) : '无';
  const compactSummary = '【结构化期限候选】\n' + candidateLines + '\n\n【最佳候选】\n  - ' + bestLine;
  return {
    payload,
    rawText,
    historianText: rawText + '\n\n【结构化市场签名】\n' + tfLines + '\n\n【期限候选摘要】\n' + candidateLines,
    analystText: compactSummary + '\n\n【多周期特征池】\n' + tfLines,
    // v3.6 Bug4修复：给质疑师补充 tfLines（多周期特征池）
    // 原实现只给 rawText，但要求质疑师检查 dist 字段和多周期指标对比——这两类数据都不在 rawText 里。
    // 修复：加入 tfLines（含各周期RSI/MACD/ADX/volRatio/flags）和完整 dist 字段描述。
    criticText: compactSummary + '\n\n【多周期特征池（核查用）】\n' + tfLines +
      '\n\n【关键位距离（dist字段，各周期）】\n' + Object.keys(featurePool).map(tf => {
        const f = featurePool[tf] || {};
        const d = f.dist || {};
        return '  - ' + tf + '：ema21=' + (d.ema21_atr != null ? d.ema21_atr : '—') +
          ' vwap=' + (d.vwap_atr != null ? d.vwap_atr : '—') +
          ' prevH=' + (d.prevHigh_atr != null ? d.prevHigh_atr : '—') +
          ' prevL=' + (d.prevLow_atr != null ? d.prevLow_atr : '—') +
          ' round=' + (d.roundLevel_atr != null ? d.roundLevel_atr : '—');
      }).join('\n') +
      '\n\n【风险核查重点】\n' +
      '  - 检查各期限 risk_score 和 no_trade_reasons 是否有累积的风险信号\n' +
      '  - 检查关键位距离（见上方dist字段）：ema21_atr/vwap_atr/prevHigh_atr/prevLow_atr/roundLevel_atr，≤0.3视为临近\n' +
      '  - 检查 1m/5m 的 StochRSI、RSI、MACD柱是否存在极值或多周期背离（见上方多周期特征池）\n' +
      '  - 检查 volRatio 量能是否支撑方向\n' +
      '  - 注意：规则算法不提供方向建议，方向由分析师判断，你的任务是提出质疑和呈现事实\n\n【原始行情与指标】\n' + rawText,
    judgeText: compactSummary + '\n\n【多周期特征池】\n' + tfLines + '\n\n【原始行情与指标】\n' + rawText
  };
}

// ── 结构化日志 ────────────────────────────────────────────────────
const BgLog = {
  _history: [],
  _MAX: 300,
  _levels: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
  _curLevel: 1,
  _log(lvl, msg, data) {
    if (lvl < this._curLevel) return;
    const label = ['DEBUG','INFO','WARN','ERROR'][lvl];
    const entry = { ts: new Date().toLocaleTimeString('zh-CN'), label, msg };
    if (data !== undefined) entry.data = typeof data === 'object' ? JSON.stringify(data).slice(0,200) : String(data);
    this._history.push(entry);
    if (this._history.length > this._MAX) this._history.shift();
  },
  debug(m,d){ this._log(0,m,d); },
  info(m,d) { this._log(1,m,d); },
  warn(m,d) { this._log(2,m,d); },
  error(m,d){ this._log(3,m,d); console.error('[BG]',m,d||''); },
  getHistory() { return this._history.slice(-50); },
  getFullHistory() { return this._history.slice(); }
};

// 通用安全包装：抓到错误就 log，调用方不再写空 catch
function logSafe(scope, e) {
  if (!e) return;
  try { BgLog.warn(scope, e.message || String(e)); } catch(_) {}
}

// 给 tab 发消息的安全包装：tab 关闭/content.js 未注入属于预期错误，不污染日志
function safeSendToTab(tabId, msg) {
  if (!tabId) return Promise.resolve();
  return chrome.tabs.sendMessage(tabId, msg).catch(e => {
    const m = String(e && e.message || '');
    // 只在非预期错误时记录
    if (!m.includes('Receiving end does not exist') &&
        !m.includes('No tab with id') &&
        !m.includes('The message port closed')) {
      BgLog.warn('[sendToTab:' + (msg && msg.type || '?') + ']', m);
    }
  });
}

// 元裁判消息广播：优先发当前 tab；若没有 tabId，则回退广播到 Binance 页面
function notifyMetaJudgeTabs(tabId, msg) {
  if (tabId) return safeSendToTab(tabId, msg);
  return chrome.tabs.query({ url: '*://*.binance.com/*' }, function(tabs) {
    (tabs || []).forEach(function(tab) {
      if (tab && tab.id) safeSendToTab(tab.id, msg);
    });
  });
}

// ── 消息监听 ──────────────────────────────────────────────────────
// 用 Map 管理多个并发请求的 controller
// key 为自增 requestId，value 包含 { ctrl, source }
// 这样同 source（例如多个并发的 manual）也不会相互覆盖 controller
const fetchControllers = new Map();
let _ctrlSeq = 0;

function registerController(source, ctrl) {
  const id = ++_ctrlSeq;
  fetchControllers.set(id, { ctrl, source: source || 'manual' });
  return id;
}

function unregisterController(id) {
  fetchControllers.delete(id);
}

function abortFetch(source) {
  // abort 指定 source 下的所有 controller（用户点击"停止"时会清掉同类全部在途请求）
  const target = source || 'manual';
  for (const [id, entry] of fetchControllers.entries()) {
    if (entry.source === target) {
      try { entry.ctrl.abort(); } catch(e) { logSafe('[abortFetch:'+target+']', e); }
      fetchControllers.delete(id);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CANCEL') {
    abortFetch('manual');
    sendResponse({ ok: true }); return false;
  }
  if (msg.type === 'ANALYZE_TEXT') { handleAnalyzeText(msg, sender.tab.id).then(sendResponse); return true; }
  if (msg.type === 'FOLLOWUP')     { handleFollowup(msg, sender.tab.id).then(sendResponse);    return true; }
  if (msg.type === 'HISTORY_CHAT') { handleHistoryChat(msg, sender.tab.id).then(sendResponse); return true; }
  if (msg.type === 'AUTO_ANALYZE') {
    // sender.tab.id 是最可靠的 tabId，直接传入，不在 handleAutoAnalyze 里重新查询
    handleAutoAnalyze(msg, sender.tab.id);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'AUTO_START')   { startKeepAliveAlarm(); sendResponse({ ok: true }); return false; }
  if (msg.type === 'AUTO_STOP') {
    // v2.10 修复：AUTO_STOP 不再无条件杀 alarm，先检查是否有待验证的 session
    chrome.storage.local.get('autoSessions').then(function(d) {
      const _ss = d.autoSessions || [];
      const _hasPending = _ss.some(function(s) {
        return (s.direction && s.direction !== 'neutral' && !s.verifyResult && s.verifyAt) ||
               (s.analystDirection && s.analystDirection !== 'neutral' && !s.analystVerifyResult && s.analystVerifyAt) ||
               (!s.verifyResult && s.verifyAt) || (!s.analystVerifyResult && s.analystVerifyAt);
      });
      if (!_hasPending) stopKeepAliveAlarm();
    }).catch(function() { stopKeepAliveAlarm(); });
    sendResponse({ ok: true }); return false;
  }
  // v2.10 新增：content.js 倒计时到期时主动触发验证
  if (msg.type === 'TRIGGER_VERIFY') {
    const _tvTabId = sender && sender.tab && sender.tab.id || null;
    runPendingVerifications(null, null, _tvTabId).catch(e => logSafe('[triggerVerify]', e));
    chrome.storage.local.get('autoSessions').then(function(d) {
      const _ss = d.autoSessions || [];
      const _hasPending = _ss.some(function(s) {
        return (s.direction && s.direction !== 'neutral' && !s.verifyResult && s.verifyAt) ||
               (s.analystDirection && s.analystDirection !== 'neutral' && !s.analystVerifyResult && s.analystVerifyAt) ||
               (!s.verifyResult && s.verifyAt) || (!s.analystVerifyResult && s.analystVerifyAt);
      });
      if (_hasPending) startKeepAliveAlarm();
    }).catch(function() {});
    sendResponse({ ok: true }); return false;
  }
  // 默认提示词由 background.js 集中维护，popup.js 通过 GET_DEFAULTS 拉取
  if (msg.type === 'GET_DEFAULTS') {
    sendResponse({
      analystPrompt:   DEFAULT_ANALYST_PROMPT,
      criticPrompt:    DEFAULT_CRITIC_PROMPT,
      judgePrompt:     DEFAULT_JUDGE_PROMPT,
      historianPrompt: DEFAULT_HISTORIAN_PROMPT,
      background:      DEFAULT_BACKGROUND,
      defaultPrompt:   DEFAULT_PROMPT,
      agentMaxTokens:  DEFAULT_AGENT_MAX_TOKENS, // v2.7
      decisionProfile: 'balanced'
    });
    return false;
  }
  // 对话面板三角色分析（Fix 新功能）
  if (msg.type === 'ANALYZE_AGENTS_MANUAL') { handleAgentsManual(msg, sender.tab.id).then(sendResponse); return true; }

  // ── 诊断 ─────────────────────────────────────────────────
  // 接收来自 content.js 的日志，集中存储以便用户一键导出
  if (msg.type === 'CT_LOG') {
    const lvl = msg.level === 'ERROR' ? 3 : msg.level === 'WARN' ? 2 : msg.level === 'DEBUG' ? 0 : 1;
    BgLog._log(lvl, '[CT/' + (msg.scope || '?') + '] ' + (msg.msg || ''), msg.data);
    sendResponse({ ok: true });
    return false;
  }
  // popup 的"导出诊断日志"按钮拉取完整历史
  if (msg.type === 'GET_DIAGNOSTIC_HISTORY') {
    sendResponse({ history: BgLog.getFullHistory() });
    return false;
  }
  // 一键应用元裁判提示词建议
  if (msg.type === 'APPLY_META_JUDGE_SUGGESTIONS') {
    const _applyTabId = sender && sender.tab && sender.tab.id || null;
    (async function() {
      try {
        const _cfg = await chrome.storage.local.get('agentPrompts');
        const _prompts = (_cfg.agentPrompts && Array.isArray(_cfg.agentPrompts))
          ? _cfg.agentPrompts.slice() : ['', '', ''];
        // 确保三个槽位都存在
        while (_prompts.length < 3) _prompts.push('');
        const _sug = msg.suggestions || {};
        const _roles = ['analyst', 'critic', 'judge'];
        const _applied = [];
        const _stamp = '（元裁判建议·' + new Date().toLocaleDateString('zh-CN') + '）';
        // v3.2: 替换而非追加——先剥离上次元裁判建议块，再写入新建议
        // 这样提示词不会无限膨胀，且不会出现新旧建议互相矛盾的问题
        const _mjBlockRe = /\n*（元裁判建议·[^）]+）[^\n]*/g;
        _roles.forEach(function(role, i) {
          const txt = _sug[role];
          // 无论有无新建议，先清除旧的元裁判建议块
          _prompts[i] = (_prompts[i] || '').replace(_mjBlockRe, '').trimEnd();
          if (!txt || txt === '无' || txt === '—') return;
          _prompts[i] = (_prompts[i] ? _prompts[i] + '\n\n' : '') + _stamp + txt;
          _applied.push(role);
        });
        if (_applied.length) {
          await chrome.storage.local.set({ agentPrompts: _prompts });
          BgLog.info('[元裁判] 已应用提示词建议', _applied.join(','));
          sendResponse({ ok: true, applied: _applied });
        } else {
          sendResponse({ ok: true, applied: [] });
        }
      } catch(e) {
        logSafe('[applyMetaJudgeSuggestions]', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async
  }
  // 手动触发元裁判（content.js 里的"手动审计"按钮）
  if (msg.type === 'TRIGGER_META_JUDGE') {
    const _mjTabId = sender && sender.tab && sender.tab.id || null;
    handleMetaJudge(_mjTabId).catch(e => logSafe('[triggerMetaJudge]', e));
    sendResponse({ ok: true }); return false;
  }
  // 读取最新元裁判报告（popup 或面板拉取）
  if (msg.type === 'GET_META_JUDGE_REPORT') {
    chrome.storage.local.get('metaJudgeReport').then(function(d) {
      sendResponse({ report: d.metaJudgeReport || null });
    }).catch(function() { sendResponse({ report: null }); });
    return true; // async
  }
});

// ── 保活 alarm（防止 service worker 休眠） ────────────────────────
const KEEPALIVE_ALARM = 'tvc-keepalive';

// ── 元裁判 alarm ──────────────────────────────────────────────────
// 每 META_JUDGE_EVERY 条已验证 session 触发一次深度审计
const META_JUDGE_ALARM = 'tvc-meta-judge';
const META_JUDGE_EVERY = 30; // v3.13.5: 15→30。样本翻倍使分桶统计更可信，且触发频率减半=省一半token。
let _metaJudgeRunning = false; // 全局标志：元裁判正在运行时主流程等待

function startKeepAliveAlarm() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}
function stopKeepAliveAlarm() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name === KEEPALIVE_ALARM) {
    // 保活的同时顺带扫描到期验证，不依赖新分析触发
    runPendingVerifications(null, null, null).catch(e => logSafe('[alarm:runPendingVerifications]', e));
  }
  if (alarm.name === META_JUDGE_ALARM) {
    // 元裁判 one-shot alarm 触发：应回到真正承载 content.js 面板的 Binance 页面执行
    chrome.tabs.query({ url: '*://*.binance.com/*' }, function(tabs) {
      const tabId = (tabs && tabs[0]) ? tabs[0].id : null;
      BgLog.info('[元裁判] alarm 触发', 'binanceTabId=' + (tabId || 'null'));
      handleMetaJudge(tabId).catch(e => logSafe('[alarm:metaJudge]', e));
    });
  }
});

// 浏览器重启后：若有待验证的 session，自动重启 keepalive alarm 并立即扫描
chrome.runtime.onStartup.addListener(async function() {
  try {
    const stored = await chrome.storage.local.get('autoSessions');
    const sessions = stored.autoSessions || [];
    const hasPending = sessions.some(function(s) {
      return (s.direction && s.direction !== 'neutral' && !s.verifyResult && s.verifyAt) ||
             (s.analystDirection && s.analystDirection !== 'neutral' && !s.analystVerifyResult && s.analystVerifyAt) ||
             (!s.verifyResult && s.verifyAt) || (!s.analystVerifyResult && s.analystVerifyAt);
    });
    if (hasPending) {
      startKeepAliveAlarm();
      runPendingVerifications(null, null, null).catch(e => logSafe('[onStartup:runPendingVerifications]', e));
    }
  } catch(e) { logSafe('[onStartup]', e); }
});

// v2.10 新增：SW 每次重启（含浏览器关闭重开、SW 被系统回收后重启）都执行一次检查
// onStartup 只在浏览器冷启动时触发，无法覆盖 SW 被回收后重启场景，所以用 IIFE 补全
(function checkPendingOnSwStart() {
  chrome.storage.local.get('autoSessions').then(function(d) {
    const _ss = d.autoSessions || [];
    const _hasPending = _ss.some(function(s) {
      return (s.direction && s.direction !== 'neutral' && !s.verifyResult && s.verifyAt) ||
             (s.analystDirection && s.analystDirection !== 'neutral' && !s.analystVerifyResult && s.analystVerifyAt) ||
             (!s.verifyResult && s.verifyAt) || (!s.analystVerifyResult && s.analystVerifyAt);
    });
    if (_hasPending) {
      startKeepAliveAlarm();
      runPendingVerifications(null, null, null).catch(function(e) { logSafe('[swStart:verify]', e); });
    }
  }).catch(function() {});
})();

// 安装/更新时清理已废弃的 A/B 实验数据
// - bias_memory_v1: 旧设计是"用户级粘性绑定"，单用户只能落到一组，统计无意义
// - 升级到 bias_memory_v2 后清理 v1 残留，避免污染诊断日志
chrome.runtime.onInstalled.addListener(async function(details) {
  // 1. 先做 storage 命名空间迁移：把无前缀旧 key 全部搬到 tvc: 前缀
  //    注意：必须在其他清理之前执行，否则下面的旧 abExperiment_v1 可能还在无前缀位置
  try {
    if (self.StorageNS && typeof self.StorageNS.migrateLegacyKeys === 'function') {
      const report = await self.StorageNS.migrateLegacyKeys();
      if (report.migrated.length || report.skipped.length) {
        BgLog.info('[onInstalled] storage 命名空间迁移',
          'migrated=' + report.migrated.length + ' skipped=' + report.skipped.length);
      }
    }
  } catch(e) {
    logSafe('[onInstalled:migrateLegacy]', e);
  }

  // 2. 清理废弃的 A/B 实验 key（迁移后这些 key 已经在 tvc: 前缀下，patchStorage 会自动加回）
  try {
    const obsoleteKeys = [
      'abExperiment_bias_memory_v1',  // 旧的用户级绑定值
      'abStats_bias_memory_v1'        // 旧的 v1 统计数据
    ];
    const stored = await chrome.storage.local.get(obsoleteKeys);
    const toRemove = obsoleteKeys.filter(k => stored[k] !== undefined);
    if (toRemove.length) {
      await chrome.storage.local.remove(toRemove);
      BgLog.info('[onInstalled] 已清理旧 A/B 实验数据', toRemove.join(','));
    }
  } catch(e) {
    logSafe('[onInstalled:abCleanup]', e);
  }

  // 4. v2.7: 提示词自动迁移
  //   策略：仅当用户从未自定义过（stored 为空或恰好等于旧默认）才更新；任何手动改动都保留
  try {
    const PROMPT_VERSION = 'v3.13';
    const stored27 = await chrome.storage.local.get(['agentPrompts', 'historianPrompt', 'promptDefaultsVersion']);
    if (stored27.promptDefaultsVersion !== PROMPT_VERSION) {
      // 历史默认提示词的"起始指纹"——只要命中任一历史默认头部，即视为"用户未自定义过"，
      // 升级时刷新为 v3.13 决策层新默认；真正自己改过的(不匹配任何指纹)一律保留。
      const OLD_ANALYST_FPS = [
        '【背景】二元期权：预测准确盈利80%',                    // v2.6
        '[角色] BTC二元期权分析师。基于多周期结构化特征池'        // v3.0-v3.12
      ];
      const OLD_CRITIC_FPS = [
        '【背景】你是二元期权风险质疑者',                        // v2.6
        '[角色] 二元期权质疑师。你是辩护律师'                    // v3.0-v3.12
      ];
      const OLD_JUDGE_FPS = [
        '[角色] 二元期权裁判。综合分析师',                       // v2.6
        '[角色] 二元期权裁判。你是独立法官'                      // v3.0-v3.12
      ];
      const OLD_HIST_FPS = [
        '【背景】你是二元期权历史学家',                          // v2.6
        '[角色] 历史学家。你只负责比较'                          // v3.0-v3.12
      ];
      const isOldOrEmpty = function(stored, fps) {
        if (typeof stored !== 'string' || !stored.trim()) return true; // 空/未设
        return fps.some(function(fp) { return stored.startsWith(fp); }); // 命中任一历史默认 → 没改过
      };
      const arr = Array.isArray(stored27.agentPrompts) ? stored27.agentPrompts.slice() : ['', '', ''];
      let needWrite = false;
      if (isOldOrEmpty(arr[0], OLD_ANALYST_FPS)) { arr[0] = DEFAULT_ANALYST_PROMPT; needWrite = true; }
      if (isOldOrEmpty(arr[1], OLD_CRITIC_FPS))  { arr[1] = DEFAULT_CRITIC_PROMPT;  needWrite = true; }
      if (isOldOrEmpty(arr[2], OLD_JUDGE_FPS))   { arr[2] = DEFAULT_JUDGE_PROMPT;   needWrite = true; }
      const writeObj = { promptDefaultsVersion: PROMPT_VERSION };
      if (needWrite) writeObj.agentPrompts = arr;
      if (isOldOrEmpty(stored27.historianPrompt, OLD_HIST_FPS)) {
        writeObj.historianPrompt = DEFAULT_HISTORIAN_PROMPT;
      }
      await chrome.storage.local.set(writeObj);
      BgLog.info('[onInstalled] 提示词迁移到 v3.13(决策层)',
        '分析师=' + (writeObj.agentPrompts ? 'updated' : 'kept_custom') +
        ' 历史学家=' + (writeObj.historianPrompt ? 'updated' : 'kept_custom'));
    }
  } catch(e) {
    logSafe('[onInstalled:promptsMigrate]', e);
  }

  // 3. v2.3 升级：把旧 biasMemory（裁判+分析师混合版）作为种子拷贝到新双桶键
  //    新版本下次压缩会自然覆盖；过渡期间保证 4 Agent 仍能拿到一份偏差记忆
  try {
    const stored = await chrome.storage.local.get(['biasMemory', 'biasMemoryAnalyst', 'biasMemoryJudge']);
    if (stored.biasMemory && stored.biasMemory.content) {
      const seedUpdates = {};
      if (!stored.biasMemoryAnalyst) {
        seedUpdates.biasMemoryAnalyst = Object.assign({}, stored.biasMemory, {
          role: 'analyst',
          seededFromLegacy: true
        });
      }
      if (!stored.biasMemoryJudge) {
        seedUpdates.biasMemoryJudge = Object.assign({}, stored.biasMemory, {
          role: 'judge',
          seededFromLegacy: true
        });
      }
      if (Object.keys(seedUpdates).length) {
        await chrome.storage.local.set(seedUpdates);
        BgLog.info('[onInstalled] 已从旧 biasMemory 种子双桶记忆', Object.keys(seedUpdates).join(','));
      }
    }
  } catch(e) {
    logSafe('[onInstalled:biasMemoryMigrate]', e);
  }
});

// ── 默认提示词 ────────────────────────────────────────────────────
// v3.0 重写：推理内部完成，只输出结构化结论摘要，严格字数限制
// 所有默认提示词统一在 background.js 维护，popup.js 通过 GET_DEFAULTS 拉取
const DEFAULT_BACKGROUND = 'BTC二元期权剥头皮。盈利+80%/亏损-100%，盈亏平衡胜率56%。分析基于已收盘1M K线与结构化特征池，核心期限为5/10/15/30分钟。入场价=新K线开盘价。优先判断方向胜率与到期匹配度，宁可观望也不低质量入场。';

// 历史学家：只做相似结构比对，不负责拍板方向
const DEFAULT_HISTORIAN_PROMPT = '[角色] 历史学家·概率先验器。只回答："当前相位下顺主趋势做，历史命中多少？"禁止定方向、禁止建议观望、禁止下交易结论。推理内部完成，只输出3行，≤100字。\n\n[工作方式(不输出)]\n1. 读 layered_score.phase 的 phase 与 trendDir(主趋势方向)。\n2. 只检索"相同相位"案例(力竭/回踩/推进相位不同=不可比，直接写"无可比样本")。\n3. 同相位案例里统计"顺主趋势方向"的历史命中率 + 最常见1个失败原因。\n\n[输出格式，3行，不得增减]\n【相似案例】最相似1-2个：相位/主趋势方向/时段/最佳期限，sim分\n【顺势胜率】同相位顺势历史命中 X/Y(X%)；样本不足写"样本不足，按中性先验"\n【给分析师】一句先验：该相位顺势是否值得做+期限倾向(不替分析师定方向)';

const DEFAULT_PROMPT = '请基于上方截图和数值，判断当前BTC的短线方向（看涨/看跌/观望）、置信度（XX%）及建议入场依据。';

// ── 格式层（硬编码，不受用户自定义提示词影响） ────────────────────
// 机读摘要：所有LLM输出末尾追加一行JSON_RESULT，供代码稳定解析
// direction: bullish/bearish/neutral | conf: 0-100 | limit: 分钟(观望=0) | market: trend/oscillate/unknown
const JSON_RESULT_INSTRUCTION = '\n\n[系统机读字段 — 最高优先级，token紧张时优先保JSON截断自然语言]\n输出末尾必须有且仅有一行：\nJSON_RESULT={"direction":"bullish|bearish|neutral","conf":整数0-100,"limit":整数(观望填0,最小5),"market":"trend|oscillate|unknown","summary":"≤40字摘要"}';

// 分析师格式层
const ANALYST_FORMAT_LAYER = JSON_RESULT_INSTRUCTION + '\n\n[输出约束]\n· 每个【字段】独立一行，字段名严格不变\n· 总输出≤480字（含字段名），证据/风险字段必须写满，不得用单字或单词敷衍\n· JSON_RESULT.direction=【方向】，JSON_RESULT.conf=【置信度】数字，JSON_RESULT.limit=【建议期限】数字（观望=0）\n· 【首选方案】与【方向】必须一致，JSON_RESULT.direction 必须与【方向】一致\n· 禁止输出推理过程、解释、致谢';

// 质疑师格式层 v3.4（辩护律师，只提质疑和事实，不给结论不给评级）
const CRITIC_FORMAT_LAYER = '\n\n[输出约束]\n· 每个【字段】独立一行，字段名严格不变\n· 总输出≤350字（含字段名），每条质疑必须基于具体数据，不得泛泛而谈\n· 禁止输出：方向结论、置信度上限、风险等级评分、任何数字约束\n· 禁止输出推理过程、解释、致谢\n· 末尾必须有：CRITIC_RESULT={\"summary\":\"≤20字核心质疑\"}' ;

// 裁判格式层 v3.4：独立法官，不受质疑师数字约束
// v3.8: 去掉档位引用（档位系统已删除），保留信号摘要和JSON_RESULT机读字段
const JUDGE_FORMAT_LAYER = '\n\n[硬约束]\n① 期限约束：只能输出5/10/15/30分钟\n② 偏差约束：历史条件胜率<50%→下调置信度并在【修正说明】说明\n③ 置信度门槛：统一≥58%（高于56%保本线，不分趋势/震荡），低于门槛输出观望' + JSON_RESULT_INSTRUCTION + '\n\n[必填输出字段，总输出≤380字，每行单独输出，字段名严格不变，推理禁止出现在输出中]\n【方向】看涨/看跌/观望\n【置信度】XX%\n【信号级别】🟢A/🟡B/🔴C\n【建议期限】5/10/15/30分钟或"无"\n【市场状态】趋势/震荡/不明\n【采纳方案】方向=看涨/看跌时：写明独立判断依据；方向=观望时：必须写"观望，不入场"及原因\n【质疑师评估】质疑师核心质疑是否足以推翻分析师主张（一句话）\n【市场核查】基于市场数据独立核查一个关键事实（一句话，不得重复分析师或质疑师）\n【信号摘要】方向+级别+置信度｜期限｜最强依据（≤30字）\n【修正说明】说明原因或"无"\n· JSON_RESULT各字段必须与上方文本字段严格一致（direction/conf/limit)';

// 分析师：主策略输出者，围绕固定到期 5/10/15/30M 做判断
// v3.8: 分析师提示词对齐现有数据结构
const DEFAULT_ANALYST_PROMPT = '[角色] BTC二元期权分析师·机会生成器。天职是"找顺势入场机会"，不是看门人。二元期权要高频，趋势环境里多数K线都有顺势机会，必须主动给方向。只有"真震荡中部/力竭/疑似反转"才允许观望。\n\n[第一步 环境路由(不输出,PA系统§4)]\n· adx≥25且trendBias≠neutral且swing.structure=up/down → 趋势环境,用【顺势剧本】\n· bbw处近期最低区且volRegime=contracting → 挤压环境,用【突破剧本】:不预测方向,等首根放量+大实体+收极值的突破K顺其方向;未破=观望\n· adx<20且structure=range → 区间环境,用【边界反转剧本】:bbPct≥0.8顶做空/≤0.2底做多(做回中轨),中部0.35~0.65观望\n· 其余=不明,趋向观望\n\n[第二步 相位定可否+方向+期限(不输出,纯剥头皮:执行周期定方向,大周期只调期限/置信)]\n方向与可否都读 layered_score.phase:\n· phase.tradeDir 就是方向(由执行周期1M/5M的斜率结构S+动能M+量能V合力决定);tradeDir=null(unclear)才观望。\n· phase=impulse/执行周期主导 → 顺 tradeDir 做,顺风可短打5M,大周期中性也照做。\n· phase=counter_scalp 或 reversal_confirmed → 逆大周期的剥头皮反手单,方向照给但用5M短期限快进快出、降注。这是超短线常态,不是禁区。\n· phase=exhaustion力竭(已伸展到极值+≥2衰竭) → 短暂观望,防接最后一棒。\n· ★大周期(15M/30M)只是顺风/逆风,绝不否决执行周期方向。严禁因"大周期还在涨"就拒绝5M的做空。\n\n[期限(与方向同等重要,由数据算出,勿默认锁)] 以 phase.suggestExpiry 为准——它由动态到期引擎按"测量移动+动能续航+波动率+到关键位距离"算出(理由见 expiryWhy)。动能强/空间大→长(15/30M);波动大/反转逆风/已伸展/目标位近→短(5M)。你可微调一档但必须说明依据,严禁无脑固定5M。\n\n[何时才观望(从严)] 仅:①phase=unclear或tradeDir=null(执行周期合力不足) ②phase=exhaustion力竭(伸展到极值+衰竭,防接最后一棒) ③三周期ADX全<18且bbPct在0.4~0.6(真死盘)。其余按 phase.tradeDir 给方向,逆大周期也照给。\n\n[置信度校准(诚实)] 趋势确认+相位顺势+回撤入场=62~72%;趋势确认入场点一般=56~61%;逼近关键位=54~58%;只有真观望<54%。不要因怕错习惯性压低。\n\n[字段一致性] 【首选方案】与【方向】必须一致;JSON_RESULT.direction与【方向】一致(看涨=bullish/看跌=bearish/观望=neutral)。\n\n[输出格式,每行一个字段]\n【市场状态】趋势/震荡/不明(env_tf+exec_tf)\n【使用剧本】顺势/边界反转/突破跟随/观望\n【首选方案】期限+方向+置信度(只有真观望才写:观望+具体原因)\n【看涨证据】①多周期结构 ②相位与触发 ③关键位支撑(含数值)\n【看跌证据】①多周期结构 ②相位与触发 ③关键位压力(含数值)\n【主要风险】最关键1个失效点(含数值)\n【方向】看涨/看跌/观望\n【置信度】XX%\n【建议期限】5/10/15/30分钟或"无"\n【核心理由】主趋势方向+相位+入场点(≤30字)';
// 质疑师：风险审查官 v3.1（不产生方向，专注量化风险）
// v3.8: 质疑师补充dist字段和多周期特征的使用指引
// v3.9: 质疑师内置趋势市/震荡市两套规则，不再依赖外部开关
const DEFAULT_CRITIC_PROMPT = '[角色] 二元期权质疑师·陷阱过滤器。只做一件事:检查分析师顺势方案里有没有"会直接导致到期判负"的致命陷阱。没有则必须明确"无致命风险,支持放行"。严禁制造泛泛谨慎,严禁因指标偏高低就反对顺势趋势单。不给方向、不给置信度。\n\n[只拦这五类(PA系统§6量价+§7反陷阱),其余一律不质疑]\nG3-a 高潮量陷阱:volRatio≥2.5且bodyRatio≤0.3(巨量小实体) → 换手,禁顺该K追\nG3-b 量价背离:突破方向volRatio<0.7 或 obvSlope/momDivergence反向 → 无量支撑\nG4-a 止损猎杀:brokePrevHigh/Low=true但收盘回内+长影pinBar → 应反向,分析师顺势=接刀\nG4-b 撞关键位:分析师方向正前方0.3ATR内有整数关口/前高/前低(dist≤0.3) → 易假突破被打回\nG4-c 逆势抢反转:分析师方向与15M+30M主趋势相反,且无phase=reversal结构破坏证据\n\n[工作方式(不输出)]\n· 逐条核对,每条必须引用具体数值\n· 同时列支持分析师方向的市场事实(防单边失真)\n· 回踩场景(antiTrigDesc=📌回踩入场):只质疑"回踩是否结束"(dist.ema21_atr≤0.5?),不质疑方向\n· 五类全不成立 → 【最大隐患】写"无致命陷阱,支持按分析师方向放行"\n\n[输出格式,每行一个字段]\n【市场状态】趋势市/震荡市(ADX数值)\n【分析师主张】复述方向+期限+置信度(一行)\n【致命陷阱核查】逐条核对5类,命中写哪条+数值;全不命中写"五类均不成立"\n【正向支撑】支持分析师方向的市场事实2-3条,含数值\n【最大隐患】唯一最可能致负场景(≤25字含数值);无则写"无致命陷阱,支持放行"';
// 裁判：干净的仲裁者，只接收分析师+质疑师风险清单，不接触原始数据
// v3.1 重新设计：裁判不再是第四个分析者，只做最终取舍
// v3.8: 裁判去档位引用，加市场数据独立核查指引
const DEFAULT_JUDGE_PROMPT = '[角色] 二元期权裁判·最终决策器,这条流水线唯一否决点。默认立场:采纳分析师顺势方向并放行——二元期权要高频。只在"观望三条件"之一才观望。不要做第二个看门人。\n\n[决策规则(不输出)]\n0. ★相位第一权重(读layered_score.phase,纯剥头皮:执行周期定方向):方向=phase.tradeDir。\n   · tradeDir有值 → 放行该方向,不论大周期顺逆。大周期(15M/30M)只是顺风/逆风,绝不否决执行周期方向;严禁因"大周期还在涨"就否决5M做空(超短线被大周期锁死=过去亏损主因)。\n   · phase=counter_scalp/reversal_confirmed(逆大周期) → 照样放行,用5M短期限快进快出、可降注。\n   · phase=exhaustion(伸展极值+衰竭) → 短暂观望;phase=unclear/tradeDir=null → 观望。\n1. 默认采纳分析师方向。推翻只有两种合法理由:①相位压制 ②质疑师指出的致命陷阱(五类)已被市场数据证实。仅凭RSI/StochRSI偏高、布林带偏窄、ADX一般等噪声不得推翻顺势方向。\n2. 硬否决扫描(PA系统§8):红旗(相位压制/挤压未破对赌/方向不清/高潮量陷阱/多周期强冲突)任一→观望;黄旗(1H中性/背离/贴整数位/量能不足/过度伸展)→降一档+最小注+仅长期限。\n3. 用市场数据独立核查一个关键事实。\n4. 历史验证胜率<45%下调置信度并在【修正说明】说明;>60%保持逻辑。\n\n[置信度门槛(PA系统§0.1,动态)]\n系统按平台赔率p算保本胜率W*=1/(1+p)并加5%安全垫作为放行门槛(默认p=0.8→门槛≈61%)。你给的置信度要诚实反映把握:趋势确认+相位顺势+回撤入场=62~72%,入场点一般=56~61%,逼近关键位=54~58%。低于系统门槛会被强制观望,不要为过线虚高。\n\n[期限层(与方向同等重要,由数据算出)]\n以 phase.suggestExpiry 为准(动态到期引擎按测量移动+动能续航+波动率+到关键位距离算出,理由见expiryWhy)。动能强/空间大→15/30M;波动大/反转逆风/已伸展/目标位近→5M。分析师可微调一档但需有据;你核验其期限是否与行情匹配,不匹配则按引擎值修正。勿无脑锁5M,也勿给不切实际的长期限。\n\n[只在以下情况观望(从严)]\n①phase=unclear或tradeDir=null(执行周期合力不足) ②phase=exhaustion力竭 ③质疑师证实致命陷阱且无对冲证据。其余按 phase.tradeDir 放行,逆大周期也放行。严禁因大周期方向否决执行周期信号。\n\n[信号级别] 🟢A=趋势确认+相位顺势+回撤入场+无陷阱;🟡B=入场点一般或逼近关键位;🔴C=勉强放行(降期限或最小注)。\n\n[字段一致性硬规则]\n· 方向=看涨/看跌时【采纳方案】写顺势依据;观望写"观望,不入场"+①②③哪条\n· JSON_RESULT.direction与【方向】一致(看涨=bullish/看跌=bearish/观望=neutral);conf与【置信度】一致;limit与【建议期限】一致(观望=0)\n· 【市场状态】须与特征池marketState一致;趋势形成可标"趋势";严禁把震荡标趋势\n\n[输出格式,每行一个字段]\n【方向】看涨/看跌/观望\n【置信度】XX%\n【信号级别】🟢A/🟡B/🔴C\n【建议期限】5/10/15/30分钟或"无"\n【市场状态】趋势/震荡/不明\n【采纳方案】放行依据 或 "观望,不入场"+①②③哪条\n【质疑师评估】质疑师是否指出被证实的致命陷阱(一句话)\n【市场核查】独立核查的一个关键事实(一句话)\n【信号摘要】方向+级别+置信度｜期限｜最强依据(≤30字)\n【修正说明】原因或"无"';


// ── 尾部强化提醒（拼在每个Agent prompt的最末端）──────────────────
const PROMPT_TAIL_REMINDER = '\n\n[输出前最后检查]\n· 禁止输出任何推理过程、思考链、解释、前缀\n· 只输出提示词规定的【字段】，每行一个，字段名严格不变\n· 末尾必须有一行JSON_RESULT={...}（token紧张优先保JSON）\n· 立即输出第一个字段，不得有任何前置文字';

// ── 决策档位（v3.3：在v3.1基础上修复回踩场景下的档位失效问题）────────────
// 档位本质：裁判在何种风险等级下放行，在何种风险等级下否决
// v3.3 改动：
//   1. trendHunter.oscillateMaxHighRisks 1→2，配合 detectMarketRegimeFromPayload 修复后
//      回踩不再被误判为震荡，但保留一定容忍度以防极端震荡行情
//   2. 守门员保持原有严格参数，趋势豁免过滤（Gate层）对守门员不生效
//   3. 平衡者趋势市自动升级为猎手（v3.2逻辑保留），但升级前提是marketRegime正确检测

// v3.5: 档位系统已删除，裁判是独立法官，不受外部规则约束
// getDecisionProfile 保留签名避免调用方报错，返回固定的最低限制配置
function getDecisionProfile(enhancements) {
  return {
    key: 'none',
    name: '独立法官',
    minConfidence: 58,
    trendMinConf: 58,
    oscillateMinConf: 58,
    judgeStyle: '裁判独立判断，无档位约束。'
  };
}

// v3.5: 档位系统已删除，profileGuidance 只保留最小提示
function profileGuidance(profile, role) {
  if (role === 'analyst') {
    return '\n\n有充足多周期共振证据时给出明确主方案，证据不足时优先观望。';
  }
  if (role === 'critic') {
    return '\n\n你是辩护律师，提出有价值的质疑和呈现事实，帮助裁判做出独立判断。不给风险评级，不给置信度上限。';
  }
  if (role === 'judge') {
    return '\n\n你是独立法官，质疑师的质疑是参考信息而非约束，置信度由你自己独立评估。趋势明确时不应因短期噪声观望。';
  }
  return '';
}

function detectMarketRegimeFromPayload(payload, judgeResult) {
  // v3.10.3 修复：趋势必须由高周期（30M/1H）确认，5M/15M的短期冲动不算趋势。
  // 原逻辑：任意周期ADX≥25就判为趋势 → 5M ADX=32但30M ADX=15时误判为趋势市
  // → 用趋势市规则追短期冲动 → 趋势市胜率25%
  // 修复逻辑：
  //   1. 高周期（30M或1H）ADX≥25且trendBias明确 → 真正的趋势
  //   2. 高周期全部ADX<20 → 震荡（无论低周期ADX多高）
  //   3. 中间状态 → 用best_candidate和最大ADX兜底
  const best = payload && payload.best_candidate || null;
  const pool = payload && payload.feature_pool || {};

  // 高周期：30M和1H
  const highTfs = ['30m', '1h'].map(k => pool[k]).filter(function(f) {
    return f && typeof f.adx === 'number' && isFinite(f.adx);
  });
  // 低/中周期：1M/5M/15M
  const lowTfs = ['1m', '5m', '15m'].map(k => pool[k]).filter(function(f) {
    return f && typeof f.adx === 'number' && isFinite(f.adx);
  });

  // 第一优先：高周期有趋势 → 趋势市
  const highTrending = highTfs.some(function(f) {
    return f.adx >= 25 && f.trendBias && f.trendBias !== 'neutral';
  });
  if (highTrending) return 'trend';

  // 第二优先：高周期全部ADX≤18 → 震荡市（低周期冲动不改变高周期震荡性质）
  const highAllOscillate = highTfs.length > 0 && highTfs.every(function(f) {
    return f.adx <= 18;
  });
  if (highAllOscillate) return 'oscillate';

  // 兜底：best_candidate的marketState
  if (best && typeof best.marketState === 'string') {
    if (best.marketState.includes('趋势')) return 'trend';
    if (best.marketState.includes('震荡')) return 'oscillate';
  }

  // 最后：裁判文本解析
  const txt = judgeResult || '';
  if (/【市场状态】\s*趋势/.test(txt)) return 'trend';
  if (/【市场状态】\s*震荡/.test(txt)) return 'oscillate';
  return 'unknown';
}

function forceJudgeNeutral(judgeResult, reasonText) {
  let text = judgeResult || '';
  text = text
    .replace(/(【方向[^】]*】\s*)(看涨|看跌)/, '$1观望')
    .replace(/(【置信度[^】]*】\s*)\d+%?/, '$10%')
    .replace(/(【建议期限】\s*)([^\n]+)/, '$1无')
    .replace(/(【采纳方案】\s*)([^\n]+)/, '$1折中观望')
    .replace(/(【信号摘要】\s*)([^\n]+)/, '$1观望｜0%｜无')
    .replace(/("direction"\s*:\s*)"(bullish|bearish)"/, '$1"neutral"')
    .replace(/("conf"\s*:\s*)\d+/, '$10')
    .replace(/("limit"\s*:\s*)\d+/, '$10');
  if (!text.includes('【系统约束:人格挡位】')) {
    text += '\n\n【系统约束:人格挡位】' + reasonText;
  }
  return text;
}

// v3.8.2: applyDecisionProfileGate 彻底去除 DECISION_PROFILE_PRESETS 依赖
// 档位系统已删除，门控只做最低置信度检查，阈值写死在函数内
function applyDecisionProfileGate(judgeResult, ctx) {
  const marketRegime = ctx && ctx.marketRegime || 'unknown';
  const payload = ctx && ctx.payload || null;
  const conf = parseConfidence(judgeResult);
  const dir = parseDirection(judgeResult).label;

  if (!judgeResult || dir === 'neutral') {
    return { forced: false, judgeResult: judgeResult, reason: '' };
  }

  // ── v3.12.1 死盘硬否决（趋势回踩豁免）──────────────────
  //   横盘死盘要拦，但已确认的趋势回踩不能被一刀切否决。
  const pool = payload && payload.feature_pool || {};
  const f15 = pool['15m'];
  const f5  = pool['5m'];
  const bbw15 = f15 && isFinite(f15.bbw) ? f15.bbw : null;
  const atr5  = f5  && isFinite(f5.atr)  ? f5.atr  : null;
  const lsPhase = payload && payload.layered_score && payload.layered_score.phase || null;
  const phaseTrendConfirmed = !!(lsPhase && lsPhase.confirmed);
  // v3.13 (决策层G5)：原 bbw15<1.2% 误杀几乎全部行情（BTC 1m 级 15M 带宽常态~0.8%）。
  //   收紧到只拦"真横盘死盘"，且任何"已确认相位"(impulse/retrace/exhaustion 等)一律豁免，
  //   把可否交易的判断交回相位闸门 G0 + 硬否决清单，而不是用一条带宽线一刀切。
  const deadReasons = [];
  if (bbw15 != null && bbw15 < 0.45) deadReasons.push('15M布林带<0.45%(真横盘)');
  if (atr5  != null && atr5  < 12)   deadReasons.push('5M ATR<12(几乎不动)');
  if (deadReasons.length && !phaseTrendConfirmed) {
    const reason = '死盘硬否决：' + deadReasons.join('、') + '，强制观望。';
    return { forced: true, judgeResult: forceJudgeNeutral(judgeResult, reason), reason: reason };
  }

  // 置信度门槛（v3.13 决策层G7：按平台赔率动态算 W*=1/(1+p)+安全垫，取代写死的58%）
  //   p=平台净赔率(payoutRate, 默认0.85→W*≈54.1%)；安全垫+2%（贴近保本线以保证入场频率，
  //   而非过度保守把单子全拦掉）；下限54%防赔率配错时全放行。
  //   赔率可由 ctx.payoutRate 或 storage.payoutRate 覆盖；不同平台赔率变了门槛自动跟着变。
  const payout = (ctx && isFinite(ctx.payoutRate) && ctx.payoutRate > 0) ? ctx.payoutRate : 0.85;
  const breakeven = 1 / (1 + payout) * 100;      // 保本胜率 W*
  const threshold = Math.max(54, Math.round(breakeven + 2)); // +2% 安全垫

  if (conf != null && conf < threshold) {
    const reason = '置信度' + conf + '%低于门槛' + threshold + '%(W*≈' + breakeven.toFixed(1) + '%+安全垫)，强制观望。';
    return { forced: true, judgeResult: forceJudgeNeutral(judgeResult, reason), reason: reason };
  }

  return { forced: false, judgeResult: judgeResult, reason: '' };
}

// ── API 格式判断 ──────────────────────────────────────────────────
function isAnthropicStyle(baseUrl, apiFormat) {
  if (apiFormat === 'anthropic') return true;
  if (apiFormat === 'openai') return false;
  return baseUrl.includes('apikey.fun') || baseUrl.includes('anthropic.com');
}

// ── 统一 API 调用（流式） ─────────────────────────────────────────
// v2.1 修复点（在 v1.7.1 基础上追加新增 #7-9）：
// 1. try/finally 兜住 fetch 阶段抛错，避免 controller / 90s timeout 泄漏
// 2. 跟踪 sawText / sawThinking / stopReason / sawAnyEvent，区分多种"空响应"成因
// 3. 处理 SSE 的 `event: ` 前缀行（部分代理把事件类型放在 event 行里）
// 4. 兼容 \r\n 换行、空行心跳、注释行（:开头）
// 5. OpenAI 路径补取 message.content / text / 数组形式 delta.content
// 6. 监听 message_delta.stop_reason / choices.finish_reason，识别 max_tokens 提前耗尽
async function callAPI(apiKey, baseUrl, model, messages, apiFormat, tabId, source, maxTokens) {
  const headers = { 'Content-Type': 'application/json' };

  function buildEndpoint(base, path) {
    // 去掉末尾斜杠
    const b = base.replace(/\/+$/, '');
    // path 固定是 /v1/messages 或 /v1/chat/completions
    // 如果 base 已经以 /v1 结尾，去掉 path 里的 /v1 前缀避免重复
    // 否则直接拼接完整 path
    if (b.endsWith('/v1')) return b + path.replace(/^\/v1/, '');
    return b + path;
  }

  function sanitizeMessages(msgs) {
    return msgs.map(function(m) {
      if (typeof m.content === 'string') return m;
      if (!Array.isArray(m.content)) return m;
      const clean = m.content.filter(function(b) { return b.type === 'text' || b.type === 'image'; });
      if (!clean.length) return null;
      // 统一返回数组形式，避免下游同时处理 string 和 array
      return Object.assign({}, m, { content: clean });
    }).filter(Boolean);
  }

  // v2.2 改动：STREAM_CHUNK 50ms 合并窗口
  // 原实现每个 token 一次跨进程 sendMessage，长输出每秒数十次 IPC。
  // 攒一个 50ms 的小窗口再 flush，跨进程开销显著降低；前端渲染本就用 RAF debounce，体验无差异。
  let _chunkBuf = '';
  let _chunkTimer = null;
  function _flushChunk() {
    if (_chunkTimer) { clearTimeout(_chunkTimer); _chunkTimer = null; }
    if (!_chunkBuf) return;
    const out = _chunkBuf;
    _chunkBuf = '';
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'STREAM_CHUNK', chunk: out, source: source || 'manual' }).catch(function() {});
  }
  function pushChunk(chunk) {
    if (!tabId || !chunk) return;
    _chunkBuf += chunk;
    if (!_chunkTimer) _chunkTimer = setTimeout(_flushChunk, 50);
  }
  function pushDone() {
    _flushChunk(); // 先把缓冲区残留 flush 出去
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE', source: source || 'manual' }).catch(function() {});
  }

  const anthropic = isAnthropicStyle(baseUrl, apiFormat);
  let endpoint, body;

  if (anthropic) {
    headers['anthropic-version'] = '2023-06-01';
    headers['x-api-key'] = apiKey;
    endpoint = buildEndpoint(baseUrl, '/v1/messages');
    body = {
      model: model,
      max_tokens: maxTokens || 1024,
      stream: true,
      temperature: 0.3, // v2.7: 0.3 是指令遵循模式，把格式偏离率从 ~30% 压到 <10%
      // v3.2: 显式禁用 extended thinking。Anthropic API 默认关闭，但部分代理会自动开启，
      // 导致思考阶段把 max_tokens 全部耗尽、正文输出为零。此处显式写明避免代理误开。
      thinking: { type: 'disabled' },
      messages: sanitizeMessages(messages)
    };
  } else {
    headers['Authorization'] = 'Bearer ' + apiKey;
    endpoint = buildEndpoint(baseUrl, '/v1/chat/completions');
    const openaiMessages = sanitizeMessages(messages).map(function(m) {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const parts = m.content.map(function(p) {
        if (p.type === 'text') return { type: 'text', text: p.text };
        if (p.type === 'image') return { type: 'image_url', image_url: { url: 'data:' + p.source.media_type + ';base64,' + p.source.data } };
        return null;
      }).filter(Boolean);
      return { role: m.role, content: parts };
    });
    body = { model: model, max_tokens: maxTokens || 1024, stream: true, temperature: 0.3, messages: openaiMessages, enable_thinking: false };
  }

  const ctrl = new AbortController();
  const _ctrlId = registerController(source, ctrl);

  // 超时保护：meta_judge prompt 体积大，单独给 150s；其余 agent 保持 90s
  const _timeoutMs = (source === 'meta_judge') ? 150000 : 90000;
  const _timeoutId = setTimeout(() => ctrl.abort(), _timeoutMs);
  const _cleanupTimeout = () => clearTimeout(_timeoutId);
  ctrl.signal.addEventListener('abort', _cleanupTimeout, { once: true });

  // 统计性状态，用于区分多种"空响应"成因
  let sawText = false;
  let sawThinking = false;
  let sawAnyEvent = false;
  let stopReason = null;
  let currentEventType = null; // 处理 `event: xxx\ndata: ...` 这种 SSE 风格
  // 每次请求重置未匹配事件计数器
  parseSseLine._unmatchedCount = 0;

  // 把所有清理动作收敛到一处，避免 fetch 抛错时泄漏
  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    _cleanupTimeout();
    unregisterController(_ctrlId);
    // v2.2 改动：清理时强制 flush 残留 chunk，避免出错时丢失最后几十个字符
    try { _flushChunk(); } catch(_) {}
  }

  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch(fetchErr) {
    cleanup();
    // fetch 阶段失败（DNS / TLS / abort / 网络断）：包装成更易诊断的错误
    if (fetchErr.name === 'AbortError') {
      throw new Error('请求被中止（90s 超时或用户取消，source=' + (source || '?') + '）');
    }
    throw new Error('网络请求失败：' + (fetchErr.message || fetchErr) + '（source=' + (source || '?') + '）');
  }

  if (!res.ok) {
    cleanup();
    const errText = await res.text().catch(() => '');
    let errMsg = errText || ('HTTP ' + res.status);
    try {
      const errJson = JSON.parse(errText);
      // 兼容两种格式：{error:{message:...}} 和 {message:...,code:...}
      errMsg = (errJson.error && errJson.error.message) || errJson.message || errText;
    } catch(e) { errMsg = errText || ('HTTP ' + res.status); }
    // 接口不支持图片（image_url 被拒）→ 给出明确提示
    if (errMsg.includes('image_url') || errMsg.includes('deserialize')) {
      throw new Error('该接口不支持图片识别，请改用"抓取"（纯文字）模式，或换用支持视觉的模型');
    }
    throw new Error('HTTP ' + res.status + '：' + String(errMsg).slice(0, 200));
  }

  if (!res.body) {
    cleanup();
    throw new Error('响应无 body（source=' + (source || '?') + '），代理可能已断开连接');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  // 解析单行 SSE 数据，累积到 fullText
  function parseSseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    // SSE 注释行（部分代理用作心跳）
    if (trimmed.startsWith(':')) return;

    // event: 行 — 记录当前事件类型，等下一行 data: 来用
    if (trimmed.startsWith('event:')) {
      currentEventType = trimmed.slice(6).trim();
      return;
    }

    if (trimmed === 'data: [DONE]') { currentEventType = null; return; }
    if (trimmed.indexOf('data:') !== 0) return;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr) return;

    sawAnyEvent = true;

    let evt;
    try {
      evt = JSON.parse(jsonStr);
    } catch (e) {
      // 解析失败：保持安静，下一行再说
      return;
    }

    // 优先用 evt.type，否则用前一行 event: 携带的类型
    const evtType = evt.type || currentEventType || null;
    currentEventType = null; // 一次性消费

    if (evtType === 'error' && evt.error) {
      throw new Error((evt.error.message || JSON.stringify(evt.error)).slice(0, 200));
    }

    // Anthropic 流：content_block_delta
    if (evtType === 'content_block_delta' && evt.delta) {
      if (evt.delta.type === 'thinking_delta') {
        sawThinking = true;
        return;
      }
      if (evt.delta.type === 'text_delta') {
        const t = evt.delta.text || '';
        if (t) { fullText += t; sawText = true; pushChunk(t); }
        return;
      }
      // 部分代理把 text 直接放在 delta.text 而不带 type
      if (typeof evt.delta.text === 'string' && evt.delta.text) {
        fullText += evt.delta.text; sawText = true; pushChunk(evt.delta.text);
        return;
      }
    }

    // ── FIX v2.1：content_block_start 携带文本（部分代理省略 delta，在 start 就填好文本）──
    if (evtType === 'content_block_start' && evt.content_block) {
      const cb = evt.content_block;
      if (cb.type === 'thinking') { sawThinking = true; return; }
      if (cb.type === 'text' && typeof cb.text === 'string' && cb.text) {
        fullText += cb.text; sawText = true; pushChunk(cb.text);
        return;
      }
    }

    // Anthropic 流：message_delta 里的 stop_reason
    if (evtType === 'message_delta' && evt.delta && evt.delta.stop_reason) {
      stopReason = evt.delta.stop_reason;
    }

    // ── FIX v2.1：Anthropic 非流式信封包在 SSE 里（type=message，content=[]）──
    // 部分代理对 stream:true 返回完整 message 对象而非 delta 序列
    if ((evtType === 'message' || evt.type === 'message') && Array.isArray(evt.content)) {
      for (const block of evt.content) {
        if (block && block.type === 'text' && typeof block.text === 'string' && block.text) {
          fullText += block.text; sawText = true; pushChunk(block.text);
        }
      }
      if (sawText) return;
    }

    // ── FIX v2.1：顶层 evt.content[] 数组（不带 type 字段的裸信封）──
    if (!evt.type && !evt.choices && Array.isArray(evt.content)) {
      for (const block of evt.content) {
        if (block && block.type === 'text' && typeof block.text === 'string' && block.text) {
          fullText += block.text; sawText = true; pushChunk(block.text);
        }
      }
      if (sawText) return;
    }

    // ── FIX v2.1：顶层 evt.text 字符串（legacy 代理直接平铺文本）──
    if (typeof evt.text === 'string' && evt.text && !evt.choices) {
      fullText += evt.text; sawText = true; pushChunk(evt.text);
      return;
    }

    // ── FIX v2.1：顶层 evt.output[] 数组（部分自研代理用 output 字段）──
    if (Array.isArray(evt.output) && evt.output[0]) {
      const o0 = evt.output[0];
      const t = (typeof o0.text === 'string' && o0.text) ||
                (o0.content && typeof o0.content === 'string' && o0.content) || '';
      if (t) { fullText += t; sawText = true; pushChunk(t); return; }
    }

    // ── FIX v3.2：Gemini SSE 格式 —— candidates[].content.parts[].text ──────
    // Google AI Studio / Vertex AI 使用 OpenAI 兼容端点时仍返回 Gemini 原生格式：
    // data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},...}],...}
    if (Array.isArray(evt.candidates) && evt.candidates[0]) {
      const cand = evt.candidates[0];
      const parts = cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
      for (const part of parts) {
        if (part && typeof part.text === 'string' && part.text) {
          fullText += part.text; sawText = true; pushChunk(part.text);
        }
      }
      if (sawText) return;
    }

    // ── FIX v3.2：Ollama 流式格式 —— message.content（非 choices 路径）──────
    // Ollama /api/chat 返回：data: {"model":"llama3","message":{"role":"assistant","content":"Hi"},"done":false}
    // 也兼容 /v1/chat/completions Ollama 兼容层（走 choices 路径，此处为额外保险）
    if (evt.message && typeof evt.message.content === 'string' && evt.message.content && !evt.choices) {
      fullText += evt.message.content; sawText = true; pushChunk(evt.message.content);
      return;
    }

    // ── FIX v3.2：DeepSeek R1 reasoning_content 跳过（只要正文 content）──
    // DeepSeek R1 在 delta 里同时输出 reasoning_content 和 content，
    // reasoning_content 是推理过程，不应显示，直接忽略让代码继续走 choices 路径取 content。
    if (evt.choices && evt.choices[0] && evt.choices[0].delta) {
      const ds = evt.choices[0].delta;
      if (ds.reasoning_content && !ds.content) return; // 纯推理帧，跳过
    }

    // OpenAI 流：choices[].delta.content / message.content / text
    if (evt.choices && evt.choices[0]) {
      const c0 = evt.choices[0];
      if (c0.finish_reason === 'content_filter') {
        throw new Error('内容被模型过滤（content_filter），请调整提示词');
      }
      if (c0.finish_reason) stopReason = c0.finish_reason;

      const deltaContent = c0.delta && c0.delta.content;
      if (typeof deltaContent === 'string' && deltaContent) {
        fullText += deltaContent; sawText = true; pushChunk(deltaContent);
      } else if (Array.isArray(deltaContent)) {
        // 极少数代理把 delta.content 做成数组（OpenAI vision 风格）
        for (const part of deltaContent) {
          if (part && typeof part.text === 'string' && part.text) {
            fullText += part.text; sawText = true; pushChunk(part.text);
          }
        }
      }

      // 兜底：message.content（非流式风格但 stream=true 时也可能出现）
      if (c0.message && typeof c0.message.content === 'string' && c0.message.content && !fullText) {
        fullText += c0.message.content; sawText = true; pushChunk(c0.message.content);
      }

      // 兜底：legacy completion 风格 text
      if (typeof c0.text === 'string' && c0.text) {
        fullText += c0.text; sawText = true; pushChunk(c0.text);
      }

      if (c0.delta && c0.delta.refusal) {
        throw new Error('内容被模型拒绝: ' + String(c0.delta.refusal).slice(0, 100));
      }
    }

    // ── 诊断：所有分支均未提取到文字，记录原始事件供排查 ──────────────
    // 只记录前3个未匹配事件，避免日志爆炸；心跳/ping/message_start等无文字事件不算问题
    if (!sawText) {
      const _ignoredTypes = ['message_start', 'message_stop', 'content_block_stop', 'ping'];
      const _evtType = evt.type || evtType || '';
      // v2.5 噪音修复：OpenAI 流的"打招呼"开场 chunk（delta 只含 role 字段，无 content）不算未匹配
      //   原代码每次分析每个 Agent 都会触发一次 WARN，导致 100+ 条噪音掩盖真实问题
      const _isRoleOnlyOpener = evt.choices && evt.choices[0] && evt.choices[0].delta
        && typeof evt.choices[0].delta === 'object'
        && Object.keys(evt.choices[0].delta).length === 1
        && evt.choices[0].delta.role
        && !evt.choices[0].finish_reason;
      if (!_ignoredTypes.includes(_evtType) && !_isRoleOnlyOpener) {
        if (!parseSseLine._unmatchedCount) parseSseLine._unmatchedCount = 0;
        if (parseSseLine._unmatchedCount < 3) {
          parseSseLine._unmatchedCount++;
          BgLog.warn('[SSE未匹配事件#' + parseSseLine._unmatchedCount + '] source=' + (source||'?'),
            JSON.stringify(evt).slice(0, 300));
        }
      }
    }
  }

  let streamError = null;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        // flush TextDecoder 内部缓冲（处理多字节 UTF-8 尾部字节）
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      // 兼容 \r\n 和 \n 两种换行
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop(); // 保留最后一个不完整行
      for (let i = 0; i < lines.length; i++) parseSseLine(lines[i]);
    }
    // 排空 buffer：处理流末尾没有 \n 结尾的最后一行（部分代理不发送末尾换行）
    if (buffer.trim()) parseSseLine(buffer);
  } catch(e) {
    streamError = e;
  } finally {
    cleanup();
    if (streamError) {
      if (tabId) chrome.tabs.sendMessage(tabId, { type: 'STREAM_ERROR', error: streamError.message, source: source || 'manual' }).catch(() => {});
      throw streamError;
    }
  }

  if (!fullText) {
    // 区分多种"空响应"成因，便于诊断和重试策略
    let reason;
    if (sawThinking && !sawText) {
      reason = '模型仅输出 thinking 未输出正式内容，max_tokens=' + (maxTokens || 1024) + ' 可能不足';
    } else if (stopReason === 'max_tokens' || stopReason === 'length') {
      reason = 'stop_reason=' + stopReason + '（max_tokens 在产出文本前已耗尽）';
    } else if (!sawAnyEvent) {
      reason = '代理仅返回 [DONE] 无任何事件（HTTP 200 但 SSE 流为空）';
    } else {
      reason = '已接收事件但无可读文本（代理事件格式不兼容）';
    }
    throw new Error('流式响应未返回任何内容（source=' + (source || '?') + '，model=' + model + '，原因=' + reason + '）');
  }
  pushDone();
  return fullText;
}

// ── 带重试的 API 调用（多档退避 + 智能调参）──────────────────────────
// v1.7.1 升级：
// 1. 重试 2 次（共 3 次尝试），1.5s / 4s 退避 + 随机抖动
// 2. 对 thinking / max_tokens 类失败把 max_tokens 拉高 1.5×（最高 8192）
// 3. 把 5xx / 408 / 429 / 网络瞬断 / 中止 也纳入可重试范围
async function callAPIWithRetry(apiKey, baseUrl, model, messages, apiFormat, tabId, source, maxTokens) {
  const RETRYABLE = [
    '流式响应未返回任何内容',
    '响应无 body',
    '网络请求失败',
    '请求被中止',
    'HTTP 5',          // 5xx
    'HTTP 429',
    'HTTP 408'
  ];
  const ATTEMPTS = 3;
  const baseDelays = [1500, 4000];
  let lastErr;
  let curMaxTokens = maxTokens;

  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      return await callAPI(apiKey, baseUrl, model, messages, apiFormat, tabId, source, curMaxTokens);
    } catch(e) {
      lastErr = e;
      const m = e && e.message || '';
      const retryable = RETRYABLE.some(s => m.includes(s));
      if (!retryable || i === ATTEMPTS - 1) throw e;
      const wait = baseDelays[i] + Math.floor(Math.random() * 500);
      BgLog.warn('[callAPIWithRetry] 第 ' + (i + 1) + ' 次失败，' + wait + 'ms 后重试',
                 source + ' | ' + m.slice(0, 120));
      // thinking 吃光 token 的情形：下次把额度拉高 1.5×（最多 4096，避免代理拒绝）
      if (m.includes('thinking') || m.includes('max_tokens') || m.includes('stop_reason=length')) {
        curMaxTokens = Math.min(Math.ceil((curMaxTokens || 1024) * 1.5), 8192); // v3.2: 思考模型需要更大空间，上限从4096提至8192
      }
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ── 从 storage 读取模型配置 ───────────────────────────────────────
// v2.6: 增加边界检查 + 越界自动回退默认模型 + 第二参数 agentLabel 用于日志定位
async function getModelConfig(modelIndex, agentLabel) {
  const data = await chrome.storage.local.get(['models', 'defaultModel']);
  const models = data.models || [];
  if (!models.length) {
    throw new Error('未配置任何模型，请先在扩展设置中添加（agent=' + (agentLabel || '?') + '）');
  }
  // 兜底默认模型索引也要做边界检查（用户可能清掉过 storage 或保存了陈旧值）
  let defIdx = (typeof data.defaultModel === 'number' && data.defaultModel >= 0)
    ? data.defaultModel : 0;
  if (defIdx >= models.length) defIdx = 0;

  let idx = (typeof modelIndex === 'number' && modelIndex >= 0) ? modelIndex : defIdx;
  if (idx >= models.length || idx < 0) {
    BgLog.warn('[模型配置] ' + (agentLabel || '?') + ' 原索引 #' + modelIndex +
      ' 越界（当前模型数=' + models.length + '），临时回退到默认模型 #' + defIdx);
    idx = defIdx;
  }
  const model = models[idx];
  if (!model) {
    throw new Error('模型配置 #' + idx + ' 为空（agent=' + (agentLabel || '?') + '），请在扩展设置中检查');
  }
  return model;
}

// ── v2.7: 读取 Agent max_tokens 配置（用户可在设置面板调整）─────
// 默认值大幅提升以兼容思考型模型（o1/o3/GPT-5 思考/Claude 扩展思考）
//   思考模式下模型先消耗大量 token "想"，再开始写。默认 300/800/1200/1500 不够，
//   会导致输出被截断、格式残缺、JSON_RESULT 丢失。
const DEFAULT_AGENT_MAX_TOKENS = {
  analyst:   3000,
  critic:    1500,
  judge:     2500,
  historian: 800
};
async function getAgentMaxTokens() {
  const stored = await chrome.storage.local.get('agentMaxTokens');
  const cfg = stored.agentMaxTokens || {};
  return {
    analyst:   (typeof cfg.analyst   === 'number' && cfg.analyst   >= 200) ? cfg.analyst   : DEFAULT_AGENT_MAX_TOKENS.analyst,
    critic:    (typeof cfg.critic    === 'number' && cfg.critic    >= 200) ? cfg.critic    : DEFAULT_AGENT_MAX_TOKENS.critic,
    judge:     (typeof cfg.judge     === 'number' && cfg.judge     >= 200) ? cfg.judge     : DEFAULT_AGENT_MAX_TOKENS.judge,
    historian: (typeof cfg.historian === 'number' && cfg.historian >= 200) ? cfg.historian : DEFAULT_AGENT_MAX_TOKENS.historian
  };
}

// ── 公共 prompt 构建函数 ──────────────────────────────────────────
async function buildPrompt(msg, promptKey, historySection) {
  const stored = await chrome.storage.local.get(['background', promptKey]);
  const bg = stored.background ? '【交易背景】' + stored.background + '\n\n' : '';
  const basePrompt = stored[promptKey] || '';
  const extraPrompt = msg.prompt ? '\n\n【补充指令】\n' + msg.prompt : '';
  const klineSection = msg.klineText ? '\n\n以下是当前K线及指标数据（请结合图表和数值进行分析）：\n' + msg.klineText : '';
  const userSection  = msg.userText  ? '\n\n' + msg.userText : '';
  return bg + basePrompt + extraPrompt + (historySection || '') + klineSection + userSection;
}

// ── 纯文字分析（无截图） ──────────────────────────────────────────
async function handleAnalyzeText(msg, tabId) {
  try {
    const model = await getModelConfig(msg.modelIndex, 'manual_analyze');
    const prompt = await buildPrompt(msg, 'defaultPrompt', '');

    const parts = [];
    if (msg.attachments && msg.attachments.length) {
      for (let i = 0; i < msg.attachments.length; i++) {
        const att = msg.attachments[i];
        if (att.type === 'image') parts.push({ type: 'image', source: { type: 'base64', media_type: att.mime, data: att.data } });
        else parts.push({ type: 'text', text: '[附件: ' + att.name + ']\n' + att.data });
      }
    }
    parts.push({ type: 'text', text: prompt });
    const content = parts.length === 1 ? parts[0].text : parts;

    const result = await callAPI(model.key, model.base, model.model, [{ role: 'user', content: content }], model.apiFormat, tabId, 'manual');

    const session = {
      id: Date.now().toString(),
      time: new Date().toLocaleString('zh-CN'),
      messages: [
        { role: 'user', content: prompt, isFirst: true },
        { role: 'assistant', content: result }
      ]
    };
    const s = await chrome.storage.local.get('sessions');
    const sessions = s.sessions || [];
    sessions.unshift(session);
    if (sessions.length > 20) sessions.length = 20;
    await chrome.storage.local.set({ sessions: sessions });
    return { result: result, sessionId: session.id };
  } catch(e) { return { error: e.message }; }
}

// ── 追问 ──────────────────────────────────────────────────────────
async function handleFollowup(msg, tabId) {
  try {
    const model = await getModelConfig(msg.modelIndex, 'followup');
    const s = await chrome.storage.local.get('sessions');
    const sessions = s.sessions || [];
    const session = sessions.find(function(x) { return x.id === msg.sessionId; });
    if (!session) return { error: '会话不存在' };

    const messages = [];
    for (let i = 0; i < session.messages.length; i++) {
      const m = session.messages[i];
      if (i === 0 && m.isFirst) {
        messages.push({ role: 'user', content: m.content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const newContent = [];
    if (msg.attachments && msg.attachments.length) {
      for (let i = 0; i < msg.attachments.length; i++) {
        const att = msg.attachments[i];
        if (att.type === 'image') newContent.push({ type: 'image', source: { type: 'base64', media_type: att.mime, data: att.data } });
        else newContent.push({ type: 'text', text: '[附件: ' + att.name + ']\n' + att.data });
      }
    }
    if (msg.text) newContent.push({ type: 'text', text: msg.text });
    if (!newContent.length) newContent.push({ type: 'text', text: '请继续分析' });

    messages.push({
      role: 'user',
      content: newContent.length === 1 && newContent[0].type === 'text' ? newContent[0].text : newContent
    });

    const result = await callAPI(model.key, model.base, model.model, messages, model.apiFormat, tabId, 'manual');

    const userMsg = { role: 'user', content: msg.text || '' };
    if (msg.attachments && msg.attachments.length) userMsg.attachments = msg.attachments.map(function(a) { return { name: a.name, type: a.type }; });
    session.messages.push(userMsg);
    session.messages.push({ role: 'assistant', content: result });

    // 单路径写回（autoTempSessions 遗留key已废弃，删除双路径）
    const manualSessions = (s.sessions || []);
    const inManual = manualSessions.find(function(x) { return x.id === msg.sessionId; });
    if (inManual) {
      inManual.messages = session.messages;
      await chrome.storage.local.set({ sessions: manualSessions });
    }
    return { result: result, sessionId: msg.sessionId };
  } catch(e) { return { error: e.message }; }
}

// ── 历史记录内联对话 ──────────────────────────────────────────────
// 用原始分析轮次作为上下文，追加用户追问，流式返回
async function handleHistoryChat(msg, tabId) {
  try {
    const cfg = await chrome.storage.local.get(['agentModels', 'agentPrompts', 'background', 'enhancements']);
    const agentModelIdxs = cfg.agentModels || [0, 0, 0];
    const agentPrompts = cfg.agentPrompts || [];
    const bg = cfg.background ? '【交易背景】' + cfg.background + '\n\n' : '';

    const agentIdx = msg.agent === 'analyst' ? 0 : msg.agent === 'critic' ? 1 : 2;
    const model = await getModelConfig(agentModelIdxs[agentIdx], 'history_chat_' + msg.agent);
    // agentPrompts 是数组，须用数字索引访问
    const basePrompt = Array.isArray(agentPrompts)
      ? (agentPrompts[agentIdx] || '')
      : (agentPrompts[msg.agent] || '');

    // 同时在自动会话和手动会话中查找（支持手动三角色历史追问）
    const stored = await chrome.storage.local.get(['autoSessions', 'sessions']);
    const allSessions = (stored.autoSessions || []).concat(stored.sessions || []);
    const s = allSessions.find(x => x.id === msg.sessionId);
    if (!s) return { error: '会话不存在（id=' + msg.sessionId + '）' };

    const klineSection = s.klineText ? '\n\n【K线及指标数据】\n' + s.klineText : '';
    const messages = [];

    if (msg.agent === 'analyst') {
      messages.push({ role: 'user', content: bg + basePrompt + klineSection + '\n\n请根据以上数据进行分析。' });
      if (s.analystResult) messages.push({ role: 'assistant', content: s.analystResult });
    } else if (msg.agent === 'critic') {
      const analystSec = s.analystResult ? '\n\n【分析师判断】\n' + s.analystResult : '';
      messages.push({ role: 'user', content: bg + basePrompt + klineSection + analystSec });
      if (s.criticResult) messages.push({ role: 'assistant', content: s.criticResult });
    } else {
      const analystSec = s.analystResult ? '\n\n【分析师判断】\n' + s.analystResult : '';
      const criticSec  = s.criticResult  ? '\n\n【质疑师意见】\n' + s.criticResult  : '';
      messages.push({ role: 'user', content: bg + basePrompt + klineSection + analystSec + criticSec });
      if (s.result) messages.push({ role: 'assistant', content: s.result });
    }

    if (msg.history && msg.history.length) {
      for (const h of msg.history) messages.push({ role: h.role, content: h.content });
    }
    messages.push({ role: 'user', content: msg.text });

    const result = await callAPI(model.key, model.base, model.model, messages, model.apiFormat, tabId, msg.streamSource || 'history_chat');
    return { result: result };
  } catch(e) { return { error: e.message }; }
}

// ── LLM 输出 JSON 解析 ───────────────────────────────────────────
// 模型按 JSON_RESULT_INSTRUCTION 在末尾输出一行 `JSON_RESULT={...}`
// 用正则定位到等号后的 JSON 对象做 try/catch 解析；失败返回 null。
// 逐字符配对花括号确保即使行内含有嵌套结构也能完整截取。
function parseJsonResult(text) {
  if (!text || typeof text !== 'string') return null;
  // 找到 JSON_RESULT= 后最后一个出现的位置（防止前面正文里有相同标记）
  const idx = text.lastIndexOf('JSON_RESULT=');
  if (idx < 0) return null;
  let i = text.indexOf('{', idx);
  if (i < 0) return null;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let p = i; p < text.length; p++) {
    const c = text[p];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = p; break; } }
  }
  if (end < 0) return null;
  const raw = text.slice(i, end + 1);
  try {
    return JSON.parse(raw);
  } catch (e) {
    BgLog.warn('[parseJsonResult] JSON 解析失败', (e.message || e) + ' | ' + raw.slice(0, 120));
    return null;
  }
}

// ── v2.8 原因四：解析裁判是否引用了历史学家建议，以及置信度调整幅度 ──────
// 从裁判输出的【历史学家参考】字段解析采纳情况和调整幅度
// 返回 { adopted: true/false, adjusted: number|null }
// adjusted: 正数=上调, 负数=下调, 0=无调整, null=未提及
function parseHistorianAdoption(judgeResult, historianResult) {
  if (!judgeResult || !historianResult || !historianResult.trim()) {
    return { adopted: false, adjusted: null };
  }
  // 裁判输出中是否出现【历史学家参考】字段且不为"无"
  const refM = judgeResult.match(/【历史学家参考[^】]*】([^\n]*)/);
  if (!refM) return { adopted: false, adjusted: null };
  const refContent = refM[1].trim();
  if (!refContent || refContent === '无' || refContent === '—') {
    return { adopted: false, adjusted: null };
  }
  // 判断是否确实采纳（非空且非"无"视为采纳）
  const adopted = refContent.length > 2;
  // 解析置信度调整幅度，如"+5%"或"-3%"或"无调整"
  const adjM = judgeResult.match(/置信度[^：:：]*[调整调整][^：:：]*[：:：]\s*([+-]?\d+)/);
  let adjusted = null;
  if (adjM) {
    adjusted = parseInt(adjM[1]);
  } else {
    // 匹配分析师ANALYST输出里的"本次置信度因此调整：+X%/-X%/无调整"
    const adjM2 = judgeResult.match(/(?:因此|因历史)[^\n]*([+-]\d+)%/);
    if (adjM2) adjusted = parseInt(adjM2[1]);
    else if (judgeResult.includes('无调整')) adjusted = 0;
  }
  return { adopted, adjusted };
}

// ── 提取信号摘要（从 result 里抓【信号摘要】到下一个【】之间的全部内容） ──
function extractSignalSummary(result) {
  // 优先用机读 JSON
  const jr = parseJsonResult(result);
  if (jr && typeof jr.summary === 'string' && jr.summary.trim()) {
    return jr.summary.trim().slice(0, 200);
  }
  // 降级：原正则解析【信号摘要】区块
  const m = result.match(/【信号摘要】([\s\S]*?)(?=【[^】]+】|$)/);
  if (m) {
    const content = m[1].trim();
    // 只过滤以模板说明词开头的内容，避免误过滤含这些词的正常摘要
    if (content &&
        !content.startsWith('必须输出') &&
        !content.startsWith('示例') &&
        !content.startsWith('格式固定') &&
        !content.startsWith('方向 置信度')) {
      return content;
    }
  }
  return null;
}

// ── 提取【修正说明】字段（裁判上次承诺的修正内容）────────────────
// ── 提取【市场状态】字段（趋势/震荡/不明） ───────────────────────
function extractMarketState(text) {
  // 优先用机读 JSON：market 字段映射回中文
  const jr = parseJsonResult(text);
  if (jr && typeof jr.market === 'string') {
    const map = { trend: '趋势', oscillate: '震荡', unknown: '不明' };
    const v = map[jr.market.toLowerCase()];
    if (v) return v;
  }
  // 降级：原正则
  const m = text.match(/【市场状态】([^【\n]*)/);
  if (!m) return null;
  const content = m[1].trim();
  // 精确匹配优先（防止模板回抄：含"/"或超过6字符视为未识别）
  if (content === '趋势' || content === '震荡' || content === '不明') return content;
  if (content.length > 6 || content.includes('/')) return '不明';
  if (content.includes('趋势')) return '趋势';
  if (content.includes('震荡')) return '震荡';
  return '不明';
}

// ── 从 klineText 解析周期 → Binance interval ─────────────────────
function parseTFToInterval(klineText) {
  if (!klineText) return null;

  // ── 方式1：新触发周期标记（content.js 自动注入）────────────────────
  const triggerM = klineText.match(/【触发周期:([\w]+)】/);
  if (triggerM) return triggerM[1]; // 例如 '1m'

  // ── 方式2：旧 WebSocket 系统注入标记 ─────────────────────────────
  if (klineText.includes('【系统注入】')) return '1m';

  // ── 方式3：DOM 抓取格式 - 解析第1个时间周期标签 ──────────────────
  const m = klineText.match(/第1个时间周期[^(（(]*[(（(]([^)）)]+)[)）)]/);
  if (m) {
    const tf = m[1].trim();
    const map = {
      '1分钟':'1m','3分钟':'3m','5分钟':'5m','15分钟':'15m',
      '30分钟':'30m','1小时':'1h','2小时':'2h','4小时':'4h'
    };
    if (map[tf]) return map[tf];
    // TradingView 英文短格式（如 "1", "5", "15"）
    const n = parseInt(tf);
    if (!isNaN(n)) {
      if (n === 1)   return '1m';
      if (n === 3)   return '3m';
      if (n === 5)   return '5m';
      if (n === 15)  return '15m';
      if (n === 30)  return '30m';
      if (n === 60)  return '1h';
      if (n === 120) return '2h';
      if (n === 240) return '4h';
    }
  }

  // 无法解析时返回 null，由调用方决定是否跳过验证
  return null;
}

// ── 取上一根已收盘K线完整 OHLC ─────────────────────────────────────
async function fetchLastClosedCandle(interval, symbol) {
  if (!interval) return null;
  symbol = symbol || 'BTCUSDT';
  try {
    const url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol + '&interval=' + interval + '&limit=2';
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    // data[0] 是上一根已收盘K线，data[1] 是当前正在跑的K线
    // 格式：[openTime, open, high, low, close, volume, closeTime, ...]
    if (!data || !data[0]) return null;
    const c = data[0];
    return {
      open:           parseFloat(c[1]),
      high:           parseFloat(c[2]),
      low:            parseFloat(c[3]),
      close:          parseFloat(c[4]),
      volume:         parseFloat(c[5]),
      closeTimestamp: c[6],                                      // 毫秒时间戳，用于 verifyAt 起点
      closeTime:      new Date(c[6]).toLocaleTimeString('zh-CN') // 显示用
    };
  } catch(e) {
    return null;
  }
}

// ── 胜率统计：见 winrate-calc.js（共享模块） ─────────────────────
// calcWinRate / calcWinRateByLimit / calcConditionalWinRate 已在文件顶部 importScripts 后解构引入

// ── 构建【上次信号验证】注入段（给分析师用，含分析师自己的胜率） ──
function buildAnalystVerificationSection(autoSessions, currentClosedPrice) {
  if (!autoSessions.length) return '';

  const last = autoSessions[0];
  const lastAnalystDir = last.analystDirection || null;

  let section = '\n\n【分析师历史胜率反馈】\n';

  // 上次预测结果（用真实 verifyResult，不用相邻价格估算）
  if (lastAnalystDir && lastAnalystDir !== 'neutral') {
    const dirText = lastAnalystDir === 'bullish' ? '看涨 📈' : '看跌 📉';
    section += '上次方向：' + dirText + '（' + last.time + '）\n';
    if (last.analystVerifyResult) {
      section += '验证结果：' + (last.analystVerifyResult === 'win' ? '✅ 正确' : '❌ 错误') +
        '（验证价：$' + (last.analystVerifyPrice || '—') + '）\n';
    } else {
      section += '验证结果：⏳ 待验证（建议期限未到）\n';
    }
  }

  // 近10次真实胜率
  const wr = calcWinRate(autoSessions, 'analystDirection', 'analystVerifyResult', 20);
  if (wr) {
    section += '分析师近' + wr.n + '次真实胜率：' + wr.wins + '/' + wr.total +
      '（' + wr.pct + '%）' +
      (wr.pct >= 60 ? ' 🔥 保持当前判断逻辑' : wr.pct < 40 ? ' ⚠️ 必须修正判断逻辑' : '') + '\n';
    // 按期限拆分胜率
    const byLimit = calcWinRateByLimit(autoSessions, 'analystDirection', 'analystVerifyResult', 'analystVerifyAt');
    if (byLimit) section += '各期限胜率：' + byLimit + '\n';
    if (wr.pct < 40) {
      section += '⚠️ 近期胜率严重偏低，说明当前判断逻辑存在系统性错误。请重新审视：\n';
      section += '  - 是否过度依赖某个指标？\n';
      section += '  - 是否忽略了趋势方向？\n';
      section += '  - 是否在震荡行情中强行给方向？\n';
    }
  } else {
    const pending = autoSessions.filter(s => s.analystDirection && s.analystDirection !== 'neutral' && !s.analystVerifyResult).length;
    if (pending > 0) section += '真实胜率统计中（' + pending + ' 条待验证）\n';
  }
  return section;
}

// ── 构建【上次信号验证】注入段（给裁判用，含裁判+分析师胜率） ─────────────
function buildVerificationSection(autoSessions, currentClosedPrice) {
  if (!autoSessions.length) return '';

  const last = autoSessions[0];
  // 用 != null 判断而不是 !lastPrice，避免 closedPrice=0 被误判
  const lastPrice = last.closedPrice != null ? last.closedPrice : null;
  // 即使没有 closedPrice 和 verifyResult，
  // 后续的胜率统计段（calcWinRate）仍有价值，不应整体跳过。
  // 仅当 direction 也缺失时（数据完全无效）才跳过整个 section。
  if (!last.direction) return '';

  const dirText = last.direction === 'bullish' ? '看涨 📈'
                : last.direction === 'bearish' ? '看跌 📉'
                : '观望 👀';

  let section = '\n\n【上次信号验证】\n';
  section += '上次方向：' + dirText + '（' + last.time + '）\n';

  // 用真实 verifyResult，不用相邻价格估算
  if (last.direction !== 'neutral') {
    if (last.verifyResult) {
      section += '验证结果：' + (last.verifyResult === 'win' ? '✅ 预测正确' : '❌ 预测错误') +
        '（验证价：$' + (last.verifyPrice ? last.verifyPrice.toLocaleString() : '—') +
        '，入场价：$' + (lastPrice ? lastPrice.toLocaleString() : '—') + '）\n';
    } else {
      // 没有真实验证结果时，用当前价格做临时参考（标注为未确认）
      if (currentClosedPrice && lastPrice) {
        const diff = currentClosedPrice - lastPrice;
        const pct  = ((diff / lastPrice) * 100).toFixed(2);
        const sign = diff >= 0 ? '+' : '';
        section += '当前价格参考：' + sign + pct + '%（⏳ 建议期限未到，结果未确认）\n';
      } else {
        section += '验证结果：⏳ 待验证\n';
      }
    }
  } else {
    // 上次观望：显示价格实际移动，判断是否错过信号
    if (currentClosedPrice && lastPrice) {
      const diff = currentClosedPrice - lastPrice;
      const pct  = ((Math.abs(diff) / lastPrice) * 100).toFixed(2);
      const sign = diff >= 0 ? '+' : '';
      const missedDir = diff > 0 ? '看涨 📈' : '看跌 📉';
      section += '观望后价格变动：' + sign + ((diff / lastPrice) * 100).toFixed(2) + '%';
      if (Math.abs(diff / lastPrice) >= 0.001) {
        // 移动超过0.1%，认定为错过有效信号
        section += '（⚠️ 价格出现明显单边行情，' + missedDir + '方向事后验证正确，观望导致错过有效信号，需反思入场门槛是否过高）\n';
      } else {
        section += '（价格波动较小，观望合理）\n';
      }
    }
  }

  // 裁判近10次真实胜率
  const wr = calcWinRate(autoSessions, 'direction', 'verifyResult', 20);
  if (wr) {
    section += '裁判近' + wr.n + '次真实胜率：' + wr.wins + '/' + wr.total +
      '（' + wr.pct + '%）' +
      (wr.pct >= 60 ? ' 🔥 保持当前判断逻辑' : wr.pct < 40 ? ' ⚠️ 必须修正判断逻辑' : '') + '\n';
    // 按期限拆分胜率
    const byLimit = calcWinRateByLimit(autoSessions, 'direction', 'verifyResult', 'verifyAt');
    if (byLimit) section += '各期限胜率：' + byLimit + '\n';
    if (wr.pct < 40) {
      section += '⚠️ 近期胜率严重偏低，必须修正判断逻辑，不可重复同类错误。\n';
    }
  } else {
    const pending = autoSessions.filter(s => s.direction !== 'neutral' && !s.verifyResult).length;
    if (pending > 0) section += '真实胜率统计中（' + pending + ' 条待验证）\n';
  }

  // P0改进：幅度感知胜率统计注入
  const pnlSessions = autoSessions.filter(s => s.realPnl != null && s.direction !== 'neutral').slice(0, 20);
  if (pnlSessions.length >= 3) {
    const wins  = pnlSessions.filter(s => s.realPnl > 0);
    const loses = pnlSessions.filter(s => s.realPnl <= 0);
    const avgWin  = wins.length  ? (wins.reduce((a,b) => a + b.realPnl, 0)  / wins.length  * 100).toFixed(3) : null;
    const avgLoss = loses.length ? (loses.reduce((a,b) => a + b.realPnl, 0) / loses.length * 100).toFixed(3) : null;
    const cumPnl  = (pnlSessions.reduce((a,b) => a + b.realPnl, 0) * 100).toFixed(3);
    const rr = (avgWin && avgLoss && parseFloat(avgLoss) !== 0)
      ? Math.abs(parseFloat(avgWin) / parseFloat(avgLoss)).toFixed(2) : null;
    section += '幅度统计（近' + pnlSessions.length + '次）：';
    if (avgWin)  section += '均盈+' + avgWin  + '%  ';
    if (avgLoss) section += '均亏' + avgLoss + '%  ';
    if (rr)      section += '盈亏比' + rr + '  ';
    section += '累计' + (parseFloat(cumPnl) >= 0 ? '+' : '') + cumPnl + '%\n';
    if (parseFloat(cumPnl) < -2) {
      section += '⚠️ 累计亏损超过2%，当前策略参数可能需要调整（阈值偏低或方向偏差）。\n';
    }
  }

  // P2改进：删除裁判section中的分析师胜率
  // 分析师胜率已在 buildAnalystVerificationSection 注入分析师自身提示词
  // 裁判收到"分析师WR=45%"反而产生混合信号干扰判断，去掉更干净

  // v2.8 原因四：历史学家采纳率与胜率对比统计
  const _histSamples = autoSessions.filter(s =>
    typeof s.historianAdopted === 'boolean' &&
    (s.verifyResult === 'win' || s.verifyResult === 'loss')
  );
  if (_histSamples.length >= 6) {
    const _adopted    = _histSamples.filter(s => s.historianAdopted);
    const _notAdopted = _histSamples.filter(s => !s.historianAdopted);
    const _wr = arr => arr.length
      ? arr.filter(s => s.verifyResult === 'win').length + '/' + arr.length +
        '（' + Math.round(arr.filter(s => s.verifyResult === 'win').length / arr.length * 100) + '%）'
      : '—';
    section += '历史学家采纳统计（近' + _histSamples.length + '次已验证）：\n';
    section += '  已采纳：' + _wr(_adopted) + '  未采纳：' + _wr(_notAdopted) + '\n';
    if (_adopted.length >= 3 && _notAdopted.length >= 3) {
      const _adoptedWR    = _adopted.filter(s => s.verifyResult === 'win').length / _adopted.length;
      const _notAdoptedWR = _notAdopted.filter(s => s.verifyResult === 'win').length / _notAdopted.length;
      if (_adoptedWR > _notAdoptedWR + 0.05) {
        section += '  → 采纳历史学家建议时胜率更高（+' + Math.round((_adoptedWR - _notAdoptedWR) * 100) + '%），建议优先引用历史学家参考\n';
      } else if (_notAdoptedWR > _adoptedWR + 0.05) {
        section += '  → 历史学家建议对当前行情参考价值有限（采纳时胜率反低' + Math.round((_notAdoptedWR - _adoptedWR) * 100) + '%），本次可降低权重\n';
      } else {
        section += '  → 采纳与否胜率差异不显著，正常参考即可\n';
      }
    }
  }

  return section;
}

// ── 裁判完整行情数据（v2.9：裁判拿到全部 klineText，而非5字段压缩摘要）────────────────
// 裁判是最终决策者，需要完整数据（BB带宽/ATR/StochRSI/VWAP）才能独立核查分析师/质疑师的依据
function buildJudgeKlineSummary(kt) {
  if (!kt) return '';
  const views = buildRoleSpecificViews(kt);
  return '\n\n【完整行情数据（供裁判核查用）】\n' + (views.judgeText || kt);
}

// ── 自动分析 ──────────────────────────────────────────────────────
async function handleAutoAnalyze(msg, senderTabId) {
  // senderTabId 由 onMessage listener 传入，是最可靠的 tabId
  // 不在这里重新查询 tab，避免用户切换 tab 后 tabId 变成 null 导致消息发不出去
  try {
    // P1改进：在分析开始前（非阻塞）更新数据驱动阈值
    deriveOptimalThreshold().catch(e => BgLog.warn('[阈值推导] 失败', e.message));

    const roleViews = buildRoleSpecificViews(msg.klineText || '');
    const payload = msg.structuredPayload || roleViews.payload || extractBinaryFeaturePayload(msg.klineText || '') || null;

    // 读取三 Agent 各自的模型配置和自定义提示词
    const cfg = await chrome.storage.local.get(['agentModels', 'agentPrompts', 'enhancements']);
    const agentModelIdxs = cfg.agentModels || [0, 0, 0];
    const agentPromptsCfg = cfg.agentPrompts || [];
    const [analystModel, criticModel, judgeModel] = await Promise.all([
      getModelConfig(agentModelIdxs[0], 'auto_analyst'),
      getModelConfig(agentModelIdxs[1], 'auto_critic'),
      getModelConfig(agentModelIdxs[2], 'auto_judge')
    ]);
    // 使用自定义提示词，未设置则用内置默认值；格式层由代码追加，不受用户修改影响
    const profile = getDecisionProfile(cfg.enhancements || {});
    const analystSysPrompt = ((agentPromptsCfg[0] && agentPromptsCfg[0].trim()) ? agentPromptsCfg[0] : DEFAULT_ANALYST_PROMPT) + profileGuidance(profile, 'analyst') + ANALYST_FORMAT_LAYER;
    const criticPrompt     = ((agentPromptsCfg[1] && agentPromptsCfg[1].trim()) ? agentPromptsCfg[1] : DEFAULT_CRITIC_PROMPT) + profileGuidance(profile, 'critic') + CRITIC_FORMAT_LAYER;
    const judgePrompt      = ((agentPromptsCfg[2] && agentPromptsCfg[2].trim()) ? agentPromptsCfg[2] : DEFAULT_JUDGE_PROMPT) + profileGuidance(profile, 'judge') + JUDGE_FORMAT_LAYER;
    // v2.7: 读取每个 Agent 的 max_tokens 配置（用户可在设置面板调整）
    const _maxTok = await getAgentMaxTokens();

    // 近20次信号摘要注入（裁判用）
    // v2.3 改动：偏差记忆分桶 → 同时读取 biasMemoryAnalyst / biasMemoryJudge
    //   旧字段 biasMemory 仅作为兜底（首次升级时尚未生成新版本之前），
    //   onInstalled 已把旧 biasMemory 同时种子到两个新键。
    const storedSessions = await chrome.storage.local.get([
      'autoSessions', 'biasMemory', 'biasMemoryAnalyst', 'biasMemoryJudge', 'metaJudgeReport'
    ]);
    const autoSessions = storedSessions.autoSessions || [];

    // 长期偏差记忆注入（双桶）
    const biasAnalyst = storedSessions.biasMemoryAnalyst || storedSessions.biasMemory || null;
    const biasJudge   = storedSessions.biasMemoryJudge   || storedSessions.biasMemory || null;

    // v3.1 元裁判结论注入（Layer 1）：把上次审计的行动建议注入给分析师和裁判
    // 注入维度5（提示词优化建议）和维度6（行动建议），去掉 PROMPT_SUGGESTIONS 机读块，避免污染
    // Fix P0: 原代码错误提取了维度4(亏损共性)和维度5，标签也对不上；
    //         同时 _dim5 用 $ 锚点会把维度6内容一起吞入，现改为正确的前瞻截断
    const _mjReport = storedSessions.metaJudgeReport || null;
    let metaJudgeSection = '';
    if (_mjReport && _mjReport.content) {
      // 剥离机读块，只保留自然语言部分
      const _mjClean = _mjReport.content
        .replace(/PROMPT_SUGGESTIONS_START[\s\S]*?PROMPT_SUGGESTIONS_END/g, '')
        .replace(/THRESHOLD_SUGGESTIONS_START[\s\S]*?THRESHOLD_SUGGESTIONS_END/g, '')
        .trim();
      // 维度5=提示词优化建议，维度6=行动建议；用前瞻截断防止跨维度溢出
      const _dim5 = _mjClean.match(/【维度5[^】]*】([\s\S]*?)(?=【维度6|PROMPT_SUGGESTIONS_START|$)/);
      const _dim6 = _mjClean.match(/【维度6[^】]*】([\s\S]*?)(?=【维度[7-9]|PROMPT_SUGGESTIONS_START|$)/);
      const _mjSnip = [
        _dim5 ? '【元裁判·提示词建议】' + _dim5[1].trim() : '',
        _dim6 ? '【元裁判·行动建议】'   + _dim6[1].trim() : ''
      ].filter(Boolean).join('\n');
      if (_mjSnip) {
        metaJudgeSection = '\n\n【元裁判上次审计（' + _mjReport.createdAt + '，基于' + _mjReport.basedOn + '条记录）】\n' +
          _mjSnip + '\n（以上为系统级建议，请在本次判断中参考执行）\n';
      }
    }

    // v2.2 改动：A/B 改为按 K 线时间戳哈希分组（可复现）
    // 提前从 klineText 解析 dataTimestamp，作为分组种子
    let _earlyDataTs = null;
    const _msMatchEarly = (msg.klineText || '').match(/【入场时间戳】(\d+)/);
    if (_msMatchEarly) _earlyDataTs = parseInt(_msMatchEarly[1]);
    const _abVariant = await getOrAssignABVariant(_earlyDataTs); // A=有偏差记忆, B=无偏差记忆(对照)

    // 分析师专属偏差段
    let biasSectionAnalyst = '';
    if (biasAnalyst && biasAnalyst.content && _abVariant === 'A') {
      biasSectionAnalyst = '\n\n【分析师长期偏差记忆（基于近' + biasAnalyst.basedOn + '次分析师验证，更新于' + biasAnalyst.updatedAt + '）】\n' +
        biasAnalyst.content + '\n';
    }
    // 裁判专属偏差段（质疑师沿用裁判版，因为质疑师服务于裁判决策）
    let biasSectionJudge = '';
    if (biasJudge && biasJudge.content && _abVariant === 'A') {
      biasSectionJudge = '\n\n【裁判长期偏差记忆（基于近' + biasJudge.basedOn + '次裁判验证，更新于' + biasJudge.updatedAt + '）】\n' +
        biasJudge.content + '\n';
    }
    // 兼容旧变量名：质疑师注入仍用 biasSection（=裁判版）
    const biasSection = biasSectionJudge;
    // variant B：不注入偏差记忆，作为对照组，其他完全相同

    // 条件胜率（按市场状态分组，裁判用）
    const condWR = calcConditionalWinRate(autoSessions, 'direction', 'verifyResult');
    let condWRSection = '';
    if (Object.keys(condWR).length > 0) {
      condWRSection = '\n\n【条件胜率（按市场状态分组）】\n';
      for (const [state, v] of Object.entries(condWR)) {
        condWRSection += state + '：' + v.wins + '/' + v.total + '（' + v.pct + '%）\n';
      }
    }

    // 分析师条件胜率
    const condWRA = calcConditionalWinRate(autoSessions, 'analystDirection', 'analystVerifyResult');
    let condWRSectionA = '';
    if (Object.keys(condWRA).length > 0) {
      condWRSectionA = '\n\n【分析师条件胜率（按市场状态分组）】\n';
      for (const [state, v] of Object.entries(condWRA)) {
        condWRSectionA += state + '：' + v.wins + '/' + v.total + '（' + v.pct + '%）\n';
      }
    }

    // P2改进：删除裁判的近期信号回顾（与偏差记忆高度重叠，增加"lost in middle"风险）
    // biasSection 已经包含了近期错误模式的压缩摘要，无需重复注入原始摘要列表
    let historySection = '';

    const tabId = senderTabId || null;

    // 从 klineText 解析周期（新格式固定返回 '1m'，旧 DOM 格式按标签解析）
    const interval = parseTFToInterval(msg.klineText);
    const symbol = msg.symbol || 'BTCUSDT';
    // 日线/周线等不支持的周期，interval 为 null，胜率验证无法进行，提前通知用户
    if (!interval && tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'STREAM_CHUNK',
        chunk: '⚠️ 当前时间周期不支持胜率验证（仅支持1/5/15/30分钟、1/2/4小时），本次分析不计入胜率统计。\n\n',
        source: 'auto_judge'
      }).catch(() => {});
    }
    // 入场价：用刚收盘 1M K 线的收盘价（≈ 新 K 线开盘价），比开盘价更贴近实际入场时刻
    const priceMatch = (msg.klineText || '').match(/收:\s*([\d,]+\.?\d*)/);
    const currentClosedPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;

    // 上次信号验证注入（裁判用，含裁判+分析师胜率）
    const verifySection = buildVerificationSection(autoSessions, currentClosedPrice);
    if (verifySection) historySection += verifySection;

    // 分析师专属验证段（含分析师自己的胜率）
    const analystVerifySection = buildAnalystVerificationSection(autoSessions, currentClosedPrice);

    // ── 分析师专属历史段：近5次摘要 ──────────────────────────────
    let analystHistorySection = analystVerifySection;
    const analystSummaries = [];
    for (let i = 0; i < Math.min(3, autoSessions.length); i++) {
      const s = autoSessions[i];
      const summary = extractSignalSummary(s.result || '');
      if (summary) analystSummaries.push('  ' + (i + 1) + '. [' + s.time + '] ' + summary);
    }
    if (analystSummaries.length) {
      analystHistorySection += '\n\n【近期信号回顾（最近' + analystSummaries.length + '次，由新到旧）】\n' +
        analystSummaries.join('\n') + '\n';
    }
    // P2改进：删除修正承诺记录注入（实验证明LLM无法跨会话执行承诺，徒增token浪费）
    // 裁判只需偏差记忆（compressBiasMemory生成的统计摘要）+ 条件胜率 + 验证结果

    // 注入长期偏差记忆 + 条件胜率（裁判用：裁判版偏差）
    if (biasSectionJudge) historySection += biasSectionJudge;
    if (condWRSection) historySection += condWRSection;
    // v3.1 元裁判结论注入（裁判用）
    if (metaJudgeSection) historySection += metaJudgeSection;
    // v2.4 新增：质疑师反馈闭环统计（裁判用，优化④）
    const _criticFb = buildCriticFeedbackSection(autoSessions);
    if (_criticFb) historySection += _criticFb;

    // 注入长期偏差记忆 + 分析师条件胜率（分析师用：分析师版偏差）
    if (biasSectionAnalyst) analystHistorySection += biasSectionAnalyst;
    if (condWRSectionA) analystHistorySection += condWRSectionA;
    // v3.1 元裁判结论注入（分析师用）
    if (metaJudgeSection) analystHistorySection += metaJudgeSection;

    // ── 读取增强开关设置 ───────────────────────────────────────────
    const enh = (await chrome.storage.local.get('enhancements')).enhancements || {};
    const enhOn = (key) => enh[key] !== false; // 默认全开

    // P1改进：读取数据驱动阈值（deriveOptimalThreshold 已在 handleAutoAnalyze 入口调用）
    const _threshCached = (await chrome.storage.local.get('derivedThreshold')).derivedThreshold
      || { base: 55, oscillating: 60, derived: false };

    // 错误模式库 和 三维胜率 与 偏差记忆/条件胜率 高度重叠，已合并到偏差记忆中
    // 去掉这两段节省 ~350 tokens，偏差记忆已覆盖同样的信息
    // （原 #4 错误模式库 和 #8 三维胜率 代码保留但不再注入）

    // ── 历史学家 Agent（先于分析师运行，99% 走缓存 <100ms）─────────────────────────
    // 先 await 历史学家，把报告注入分析师和裁判，修复原来信息流断裂的问题
    // 缓存命中时几乎零耗时；未命中时（首次/缓存过期）约需 5s，但这种情况极少
    const _t0 = Date.now();
    let _historianMs = 0, _analystMs = 0, _criticMs = 0, _judgeMs = 0;
    let historianResult = '';
    if (enhOn('historian')) {
      const _tH = Date.now();
      try {
        historianResult = await runHistorianAgent(autoSessions, roleViews.historianText || msg.klineText || '', tabId) || '';
        _historianMs = Date.now() - _tH;
      } catch(e) {
        BgLog.warn('[历史学家] 执行失败', e.message);
        historianResult = '';
        // v3.8.3: 出错时也通知面板，避免面板空白
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'STREAM_CHUNK', chunk: '⚠️ 历史学家执行出错：' + e.message, source: 'auto_historian' }).catch(() => {});
          chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE', source: 'auto_historian' }).catch(() => {});
        }
      }
    } else {
      // v3.8.3: 历史学家关闭时也通知面板
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'STREAM_CHUNK', chunk: '📴 历史学家已关闭（可在设置中开启）', source: 'auto_historian' }).catch(() => {});
        chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE', source: 'auto_historian' }).catch(() => {});
      }
    }

    // v3.1: 分析师上下文独立组装（不再经过 buildPrompt/autoPrompt 槽位）
    // 使用 stripBinaryFeaturePayload 确保分析师拿到的是干净的可读指标文本，不含裸JSON
    const stored_bg_a = (await chrome.storage.local.get('background')).background;
    const analystBg = stored_bg_a ? '【交易背景】' + stored_bg_a + '\n\n' : '';
    const analystCleanKline = stripBinaryFeaturePayload(msg.klineText || '');
    const analystKlineSection = analystCleanKline
      ? '\n\n【当前K线及指标数据】\n' + analystCleanKline
      : '';

    // 历史学家报告注入段（只注入给分析师）
    const historianSection = historianResult
      ? '\n\n【历史学家参考（请在置信度判断中明确引用）】\n' + historianResult.trim() + '\n'
      : '';

    // ── Agent 1：分析师（独立模型，纯文字模式） ────────────────────
    const analystDataSection = roleViews.analystText ? ('\n\n【分析师专用结构化数据（规则算法客观特征，方向由你独立判断）】\n' + roleViews.analystText) : '';
    const analystDecisionGuide = '\n\n【分析师输出强化要求】\n' +
      '规则算法只提供客观分数，不提供方向建议。你必须从原始指标和特征数据独立形成方向判断。\n' +
      '输出必须包含：首选方案（期限+方向+置信度）、最强做多证据、最强做空证据、主要风险、放弃的备选期限。\n' +
      '质疑师和裁判会基于你的输出做风险审查，请给出能被复核的高密度摘要。';
    const analystFullText = analystSysPrompt + analystBg + historianSection + analystHistorySection + analystKlineSection + analystDataSection + analystDecisionGuide + PROMPT_TAIL_REMINDER;

    // 启动分析师
    const _tA = Date.now();
    let analystResult;
    try {
      analystResult = await callAPIWithRetry(
        analystModel.key, analystModel.base, analystModel.model,
        [{ role: 'user', content: analystFullText }],
        analystModel.apiFormat, tabId, 'auto_analyst', _maxTok.analyst
      );
      _analystMs = Date.now() - _tA;
    } catch(e) {
      throw new Error('[分析师] ' + e.message);
    }

    // ── Agent 2：质疑师（辩护律师）──────────────────────────────
    // v3.9: 震荡市风险提升开关已删除。质疑师提示词内置两套规则（趋势市/震荡市），
    // 由质疑师自行根据 ADX 判断当前适用哪套规则，不再需要外部开关。

    // 正向证据强制：v3.2 更新 — 基础prompt已要求列证据，此处改为强化"量化"要求
    // 避免质疑师只写"均线多头"这类空洞表述，要求给出具体数值支撑
    const symmetryNote = enhOn('symmetry')
      ? '\n\n【正向证据量化要求（必须执行）】\n' +
        '【正向证据】字段中，每条证据必须包含具体数值或比较关系，例如：\n' +
        '  ✓ "ADX=28，趋势强度有效，高于24阈值"\n' +
        '  ✓ "MACD柱连续3根扩大，动能加速"\n' +
        '  ✗ "均线多头排列"（无量化，无效）\n' +
        '若无法量化某条正向证据，则该条不得列入【正向证据】。'
      : '';

    const criticKlineBlock = roleViews.criticText
      ? '\n\n【K线及指标完整数据（独立核验用）】\n' + roleViews.criticText
      : '';
    const analystForCritic = analystResult
      ? '\n\n【分析师主方案（待风险审查）】\n' + analystResult + '\n'
      : '';
    // v3.1: 质疑师先看原始数据，再看分析师结论，按风险审查官格式输出
    const criticFullText = criticPrompt + symmetryNote +
      criticKlineBlock + analystForCritic +
      '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '【风险审查任务】\n' +
      '请基于上方指标数据，对分析师的主方案进行风险审查：\n' +
      '1. 找出高级风险（可能直接导致失败的因素）\n' +
      '2. 找出中级风险（会降低胜算的因素）\n' +
      '3. 列出正向证据（支持分析师方向的最强理由）\n' +
      '4. 给出置信度上限建议\n' +
      '不要给出自己的交易方向，不要评价分析师对错，只做风险量化。\n' +
      PROMPT_TAIL_REMINDER;
    let criticResult;
    try {
      const _tC = Date.now();
      criticResult = await callAPIWithRetry(
        criticModel.key, criticModel.base, criticModel.model,
        [{ role: 'user', content: criticFullText }],
        criticModel.apiFormat, tabId, 'auto_critic', _maxTok.critic
      );
      _criticMs = Date.now() - _tC;
    } catch(e) {
      throw new Error('[质疑师] ' + e.message);
    }

    // ── Agent 3：裁判（干净仲裁者，v3.1不接收原始数据）──────────────
    // 裁判只接收：历史验证数据 + 分析师输出 + 质疑师风险清单
    // 不再传入 klineText/judgeKlineSummary，裁判专注仲裁，不做独立数据分析
    const stored_bg = (await chrome.storage.local.get('background')).background;
    const judgeBg = stored_bg ? '【交易背景】' + stored_bg + '\n\n' : '';
    const judgeContextText = judgeBg + historySection;
    // v3.5: 档位已删除，裁判独立法官
    const judgeDecisionGuide = '\n\n【裁判决策要求】\n' +
      '你是独立法官，质疑师的陈述是辩护意见而非约束。\n' +
      '基于分析师主张和质疑师质疑，做出你自己的独立判断。\n' +
      '明显趋势中质疑师需提供足够强的反驳才能推翻顺势方向，仅凭短期指标偏高不足以推翻趋势逻辑。\n' +
      '置信度门槛：统一≥58%（高于56%保本线，不分趋势/震荡）。低于门槛输出观望。';

    // v3.7: 裁判补全市场数据。原设计裁判不接原始数据，但裁判是独立法官，
    // 若分析师/质疑师遗漏关键信息，裁判无从发现。现补入多周期特征池和关键位距离供独立核查。
    const judgeMarketData = roleViews.judgeText
      ? '\n\n【市场数据（独立核查用）】\n' + roleViews.judgeText : '';
    const judgeFullText = judgePrompt + '\n\n' + judgeContextText +
      judgeMarketData +
      '\n\n【分析师判断】\n' + analystResult +
      '\n\n【质疑师审查结论】\n' + criticResult + judgeDecisionGuide + PROMPT_TAIL_REMINDER;
    let judgeResult;
    try {
      const _tJ = Date.now();
      judgeResult = await callAPIWithRetry(
        judgeModel.key, judgeModel.base, judgeModel.model,
        [{ role: 'user', content: judgeFullText }],
        judgeModel.apiFormat, tabId, 'auto_judge', _maxTok.judge
      );
      _judgeMs = Date.now() - _tJ;
    } catch(e) {
      throw new Error('[裁判] ' + e.message);
    }

    // v3.1: 方向冲突检测已删除（质疑师不再产生方向，无需检测冲突）

    // 置信度上限约束（基于质疑师风险评级）
    const _clamp = clampJudgeConfidence(analystResult, criticResult, judgeResult);
    if (_clamp.didClamp) {
      BgLog.warn('[裁判约束] 触发置信度上限约束',
        '原裁判=' + _clamp.original + '% 风险评级=' + (_clamp.debug.riskLevel || '?') + '% 质疑师上限=' + _clamp.debug.criticCap + '% → 限制至=' + _clamp.cap + '%');
      judgeResult = _clamp.newResultText;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: 'STREAM_CHUNK',
          chunk: '\n⚠️ 置信度约束：裁判 ' + _clamp.original + '% → ' + _clamp.cap + '%（质疑师风险上限）\n',
          source: 'auto_judge'
        }).catch(function() {});
      }
    }

    // ── 决策档位门控（v3.2 Fix3：gate 用 clamp 前的原始置信度做门槛判断）
    // 原因：clamp 已把置信度压到质疑师上限，若 gate 再用压后的值做门槛检查，
    // 等于质疑师的 cap 同时触发两把刀（cap本身 + gate阈值），形成链式死锁必观望。
    // 正确做法：gate 的置信度检查用 _clamp.original（裁判原始判断），
    // 风险条数检查保持不变（仍依赖 criticResult）。
    const _judgeResultForGate = _clamp.didClamp
      ? (() => {
          // 临时把 clamp 后的置信度改回原始值，只用于 gate 的置信度门槛检查
          let _tmp = judgeResult
            .replace(/(【置信度[^】]*】\s*)(\d+)/, function(_, p) { return p + _clamp.original; })
            .replace(/("conf"\s*:\s*)(\d+)/, function(_, p) { return p + _clamp.original; });
          return _tmp;
        })()
      : judgeResult;
    const _marketRegime = detectMarketRegimeFromPayload(payload, judgeResult);
    const _gate = applyDecisionProfileGate(_judgeResultForGate, { profile, criticResult, marketRegime: _marketRegime, payload: payload, payoutRate: (isFinite(enh.payoutRate) ? enh.payoutRate : undefined) });
    if (_gate.forced) {
      BgLog.warn('[决策档位门控] 拦截', _gate.reason);
      judgeResult = _gate.judgeResult;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: 'STREAM_CHUNK',
          chunk: '\n🚫 决策档位门控：' + (profile.name || 'balanced') + ' 触发强制观望\n',
          source: 'auto_judge'
        }).catch(function() {});
      }
    }

    // 解析质疑师输出，存入 session 用于反馈闭环统计
    const _criticParsed = parseCriticOutput(criticResult);

    // 以裁判结论作为本次最终 result
    const result = judgeResult;

    const direction = parseDirection(result);
    const analystDirection = parseDirection(analystResult); // 解析分析师方向
    const timeStr = new Date().toLocaleString('zh-CN');

    // 直接推送截图和K线数据给 content.js，不依赖 storage 时序
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'AUTO_RESULT_DATA',
        klineText: msg.klineText || null,
        direction: direction.label,
        time: timeStr
      }).catch(() => {});
    }

    chrome.notifications.create('tvc-auto-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon48.png',
      title: 'TVC 自动分析 ' + direction.icon,
      message: direction.summary || result.slice(0, 100)
    });

    const autoResult = { time: timeStr, result: result, direction: direction.label, klineText: msg.klineText };
    await chrome.storage.local.set({ autoResult: autoResult });

    // 竞态修复：写入时重新读取最新 autoSessions，避免并发覆盖
    const latest = await chrome.storage.local.get('autoSessions');
    const autoSessionsLatest = latest.autoSessions || [];
    // 从裁判结论解析【建议期限】，算出 verifyAt；解析失败则按当前周期默认
    const judgeVerifyParsed   = parseVerifyMinutes(result);
    const analystVerifyParsed = parseVerifyMinutes(analystResult);
    // 期限完全由提示词控制，代码不设任何兜底值
    // 裁判/分析师没输出【建议期限】→ verifyAt=null → 不计入胜率统计（列表显示"—"）
    const judgeVerifyMin   = judgeVerifyParsed.primary   || null;
    const analystVerifyMin = analystVerifyParsed.primary || null;
    const judgeVerifyMs    = judgeVerifyMin   ? judgeVerifyMin  * 60000 : null;
    const analystVerifyMs  = analystVerifyMin ? analystVerifyMin * 60000 : null;
    // dataTimestamp：分析所基于的「入场时刻」毫秒时间戳
    //   = 已收盘 K 线开盘时刻 + 60s（即新 K 线开盘的瞬间）
    // 用户修正(v2.2)：4 个 Agent 拿到的是已收盘 K 线的静态价格，真实入场就是新 K 开盘价，
    //   因此 dataTimestamp 取新 K 开盘时刻是正确口径；不再做"延迟入场"近似建模
    // 优先用 WebSocket 毫秒时间戳（最精确），其次解析日期字符串，最后用系统时间
    let dataTimestamp = Date.now();
    const msMatch = (msg.klineText || '').match(/【入场时间戳】(\d+)/);
    if (msMatch) {
      dataTimestamp = parseInt(msMatch[1]); // 直接用毫秒时间戳，精确到秒
    } else {
      const tsMatch = (msg.klineText || '').match(/【入场时刻】(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
      if (tsMatch) {
        const [, y, mo, d, h, mi, s] = tsMatch;
        dataTimestamp = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
      }
    }
    const entryTimeStr = new Date(dataTimestamp).toLocaleString('zh-CN'); // 新K线开盘时刻（正确）
    autoSessionsLatest.unshift({
      id: 'a-' + dataTimestamp.toString(),
      time: entryTimeStr,
      direction: direction.label,
      analystDirection: analystDirection.label,
      // v3.11: 市场状态以实测regime为准（detectMarketRegimeFromPayload，高周期ADX确认），
      //   不再用裁判自由文本——否则裁判把横盘说成"趋势"会污染条件胜率统计的分桶
      marketState: (_marketRegime === 'trend' ? '趋势'
                  : _marketRegime === 'oscillate' ? '震荡'
                  : (extractMarketState(result) || '不明')),
      abVariant: _abVariant, // A/B实验记录
      klineText: msg.klineText,
      structuredPayload: payload || null,
      symbol: symbol,
      closedPrice: currentClosedPrice,
      dataTimestamp: dataTimestamp,
      interval: interval,
      verifyAt:       judgeVerifyMs   ? dataTimestamp + judgeVerifyMs   : null,
      analystVerifyAt: analystVerifyMs ? dataTimestamp + analystVerifyMs : null,
      result: result,
      analystResult: analystResult,
      criticResult: criticResult,
      historianResult: historianResult || null,
      // v3.1: 质疑师风险审查官字段（替换旧的方向/立场字段）
      criticCap:        _criticParsed.cap,
      criticStrength:   _criticParsed.strength,   // 高→强/中→中/低→弱（向后兼容）
      criticRiskLevel:  _criticParsed.riskLevel,  // 高/中/低
      criticHighRisks:  _criticParsed.highRisks ? _criticParsed.highRisks.length : 0,
      criticMidRisks:   _criticParsed.midRisks  ? _criticParsed.midRisks.length  : 0,
      criticVetoCount:  _criticParsed.vetoCount,  // 高级风险条数
      // v3.1: 裁判置信度约束记录
      judgeClamped:      _clamp.didClamp,
      judgeOriginalConf: _clamp.original != null ? _clamp.original : null,
      judgeHardCap:      _clamp.cap != null ? _clamp.cap : null,
      // 历史学家采纳追踪
      historianAdopted:   (() => { const h = parseHistorianAdoption(result, historianResult); return h.adopted; })(),
      historianAdjusted:  (() => { const h = parseHistorianAdoption(result, historianResult); return h.adjusted; })(),
      agentTimes: {
        historian: _historianMs || null,
        analyst:   _analystMs   || null,
        critic:    _criticMs    || null,
        judge:     _judgeMs     || null,
        total:     Date.now() - _t0
      }
    });
    if (autoSessionsLatest.length > 200) { autoSessionsLatest.length = 200; BgLog.info('autoSessions 已修剪至200条'); }
    await chrome.storage.local.set({ autoSessions: autoSessionsLatest });

    // 触发到期验证（非阻塞）
    runPendingVerifications(currentClosedPrice, dataTimestamp, tabId).catch(() => {});

    // ── 后台预热历史学家缓存（非阻塞）──────────────────────────────────
    // 用本次刚完成的数据预跑，下次K线到来时直接读缓存，无需等待
    const enhForWarm = (await chrome.storage.local.get('enhancements')).enhancements || {};
    if (enhForWarm.historian !== false) {
      const freshSessions = await chrome.storage.local.get('autoSessions');
      preWarmHistorian(freshSessions.autoSessions || [], roleViews.historianText || msg.klineText || '').catch(() => {});
    }

    // 兜底解锁：防止 STREAM_DONE(auto_judge) 因 MV3 SW 回收而丢失导致 content.js 永久锁定
    // callAPI 内部已发过一次，这里补发；content.js 收到重复 STREAM_DONE(auto_judge) 只是幂等地再次 isAutoAnalyzing=false
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE', source: 'auto_judge' }).catch(() => {});
    }

    return { result: result, direction: direction.label };
  } catch(e) {
    chrome.notifications.create('tvc-auto-err-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon48.png',
      title: 'TVC 自动分析失败',
      message: e.message.slice(0, 100)
    });
    BgLog.error('[自动分析] 失败原因:', e.message);
    // 通知 content.js 解锁，并附带完整错误信息供状态栏显示
    try {
      if (senderTabId) {
        const errSource = e.message.startsWith('[分析师]') ? 'auto_analyst'
                        : e.message.startsWith('[质疑师]') ? 'auto_critic'
                        : 'auto_judge';
        // 发送 STREAM_ERROR 解锁 isAutoAnalyzing
        chrome.tabs.sendMessage(senderTabId, { type: 'STREAM_ERROR', error: e.message, source: errSource }).catch(() => {});
        // 额外发送一条专用消息，让状态栏显示完整错误（STREAM_ERROR 只显示在 Agent 面板）
        chrome.tabs.sendMessage(senderTabId, { type: 'AUTO_ANALYZE_ERROR', error: e.message }).catch(() => {});
      }
    } catch(_) { logSafe('[verify:autoSendError]', _); }
    return { error: e.message };
  }
}

// ── v3.1: 解析质疑师输出（风险审查官版本）────────────────────────
// 新字段：risk=高/中/低, cap=置信度上限, highRisks=高级风险条数, summary=风险摘要
function parseCriticOutput(text) {
  if (!text || typeof text !== 'string') {
    return { cap: null, riskLevel: null, highRisks: [], midRisks: [], vetoCount: 0, strength: null, stance: null };
  }
  // 优先用机读块 CRITIC_RESULT={"risk":...,"cap":...,"high_risks":...}
  const crIdx = text.lastIndexOf('CRITIC_RESULT=');
  if (crIdx >= 0) {
    try {
      const jsonStart = text.indexOf('{', crIdx);
      let depth = 0, end = -1;
      for (let p = jsonStart; p < text.length; p++) {
        if (text[p] === '{') depth++;
        else if (text[p] === '}') { depth--; if (depth === 0) { end = p; break; } }
      }
      if (end >= 0) {
        const jr = JSON.parse(text.slice(jsonStart, end + 1));
        const cap = typeof jr.cap === 'number' ? Math.max(0, Math.min(100, jr.cap)) : null;
        const riskLevel = jr.risk || null;
        const highCount = typeof jr.high_risks === 'number' ? jr.high_risks : 0;
        return { cap, riskLevel, highRisks: new Array(highCount), midRisks: [], vetoCount: highCount, strength: riskLevel === '高' ? '强' : riskLevel === '中' ? '中' : '弱', stance: null };
      }
    } catch(_) {}
  }
  // 降级：正则解析字段
  const capM = text.match(/【置信度上限】\s*(\d+)/);
  const cap = capM ? Math.max(0, Math.min(100, parseInt(capM[1]))) : null;
  const riskM = text.match(/【风险总评】\s*([高中低])/);
  const riskLevel = riskM ? riskM[1] : null;
  // 统计高级风险条目数（按行计算，排除"无"）
  const highSection = text.match(/【高级风险】([\s\S]*?)(?=【中级风险】|【正向证据】|【风险总评】|$)/);
  const highLines = highSection ? highSection[1].trim().split('\n').filter(l => l.trim() && l.trim() !== '无') : [];
  const midSection = text.match(/【中级风险】([\s\S]*?)(?=【正向证据】|【风险总评】|$)/);
  const midLines = midSection ? midSection[1].trim().split('\n').filter(l => l.trim() && l.trim() !== '无') : [];
  const strength = riskLevel === '高' ? '强' : riskLevel === '中' ? '中' : '弱';
  return { cap, riskLevel, highRisks: highLines, midRisks: midLines, vetoCount: highLines.length, strength, stance: null };
}

// ── v2.4: 通用置信度解析（裁判用） ──────────────────────────────
// 优先 JSON_RESULT.conf，降级正则【置信度】
function parseConfidence(text) {
  if (!text || typeof text !== 'string') return null;
  const jr = parseJsonResult(text);
  if (jr && typeof jr.conf === 'number' && jr.conf >= 0 && jr.conf <= 100) {
    return Math.round(jr.conf);
  }
  const m = text.match(/【置信度[^】]*】\s*(\d+)/);
  if (m) {
    const n = parseInt(m[1]);
    if (n >= 0 && n <= 100) return n;
  }
  return null;
}

// ── v2.4: 分析师置信度（取看涨/看跌中较大的那个） ────────────────
function parseAnalystConfidence(text) {
  if (!text || typeof text !== 'string') return null;
  // 优先 JSON_RESULT.conf（分析师的 ANALYST_FORMAT_LAYER 也带 JSON_RESULT）
  const jr = parseJsonResult(text);
  if (jr && typeof jr.conf === 'number' && jr.conf >= 0 && jr.conf <= 100) {
    return Math.round(jr.conf);
  }
  // 降级：扫"看涨XX%"或"看跌XX%"
  const bullM = text.match(/看涨[^\d]{0,8}(\d+)\s*%/);
  const bearM = text.match(/看跌[^\d]{0,8}(\d+)\s*%/);
  if (bullM || bearM) {
    const b = bullM ? parseInt(bullM[1]) : 0;
    const r = bearM ? parseInt(bearM[1]) : 0;
    const v = Math.max(b, r);
    if (v >= 0 && v <= 100) return v;
  }
  return null;
}

// ── v3.4: clampJudgeConfidence 已禁用 ─────────────────────────────
// 质疑师 v3.4 不再输出置信度上限数字，裁判有独立判断权，不受外部数字约束。
// 保留函数签名避免调用方报错，始终返回不触发约束。
function clampJudgeConfidence(analystResult, criticResult, judgeResult) {
  const judgeConf = parseConfidence(judgeResult);
  return { clamped: judgeConf, original: judgeConf, didClamp: false, cap: null, newResultText: judgeResult, debug: { disabled: 'v3.4' } };
}
// ── v3.1: 质疑师风险反馈统计段（裁判用）────────────────────────
// v3.1: 质疑师风险评级与实际结果相关性统计（裁判用）
// 统计质疑师高/中/低风险评级下的实际胜率，验证风险审查有效性
function buildCriticFeedbackSection(autoSessions) {
  const samples = autoSessions.filter(function(s) {
    return s.criticStrength && (s.verifyResult === 'win' || s.verifyResult === 'loss');
  });
  if (samples.length < 5) return '';

  const high = samples.filter(function(s) { return s.criticStrength === '强'; });
  const mid  = samples.filter(function(s) { return s.criticStrength === '中'; });
  const low  = samples.filter(function(s) { return s.criticStrength === '弱'; });

  function _wr(arr) {
    if (!arr.length) return null;
    const wins = arr.filter(function(s) { return s.verifyResult === 'win'; }).length;
    return wins + '/' + arr.length + '（' + Math.round(wins / arr.length * 100) + '%）';
  }

  let section = '\n\n【质疑师风险评级准确性（基于近' + samples.length + '次已验证）】\n';
  if (high.length >= 3) section += '高风险评级实际胜率：' + _wr(high) + '（越低越说明风险评级有效）\n';
  if (mid.length >= 3)  section += '中风险评级实际胜率：' + _wr(mid) + '\n';
  if (low.length >= 3)  section += '低风险评级实际胜率：' + _wr(low) + '（越高越说明低风险判断准确）\n';

  // 核心洞察：高风险评级下，强制观望是否比放行更好
  if (high.length >= 3) {
    const highWR = high.filter(function(s) { return s.verifyResult === 'win'; }).length / high.length;
    if (highWR < 0.4) section += '→ 高风险评级胜率' + Math.round(highWR * 100) + '%，远低于盈亏平衡线，风险门控有效\n';
    else if (highWR > 0.6) section += '→ 高风险评级胜率' + Math.round(highWR * 100) + '%，风险评级可能过于保守，可适当放宽\n';
  }
  return section;
}

// ── 解析【建议期限】（分钟数） ────────────────────────────────────
// 解析【建议期限】，允许：3/5/10/15/30/60(1H)/1440(1D)
function parseVerifyMinutes(text) {
  // 优先用机读 JSON
  const jr = parseJsonResult(text);
  if (jr && typeof jr.limit === 'number' && jr.limit >= 5 && jr.limit <= 2880) {
    return { primary: Math.round(jr.limit) };
  }
  // 降级：从【建议期限】文本解析
  const m = text.match(/【建议期限[^】]*】\s*([\d]+)\s*分钟/);
  if (!m) return { primary: null };
  const n = parseInt(m[1]);
  if (isNaN(n) || n < 5 || n > 2880) return { primary: null };
  return { primary: n };
}

// ── 真实验证：取 verifyAt 时刻收盘的那根K线的收盘价 ──────────────
// verifyAt 是"持仓到期时刻"（如 9:30:00.000），对应的是在该时刻收盘的K线
// 即 openTime = verifyAt - intervalMs，closeTime = verifyAt - 1ms
// 用 endTime = verifyAt - 1 查询，Binance 返回在该时刻之前最后一根已收盘K线
async function fetchPriceAtTime(interval, timestampMs, symbol) {
  if (!interval || !timestampMs) return null;
  symbol = symbol || 'BTCUSDT';
  const intervalMs = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
    '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000
  };
  const ms = intervalMs[interval] || 60000;
  // verifyAt 已经是整K线边界（如 9:30:00.000），用 endTime = verifyAt - 1
  // 取在该时刻收盘的K线（openTime=9:25:00, closeTime=9:29:59.999）
  const endTime = timestampMs - 1;
  try {
    const url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol + '&interval=' + interval +
      '&endTime=' + endTime + '&limit=1';
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data[0]) return null;
    // 验证取到的K线确实在 verifyAt 时刻收盘（closeTime 应 >= verifyAt - intervalMs）
    const candleCloseTime = data[0][6]; // closeTime（毫秒）
    if (candleCloseTime < timestampMs - ms) return null; // 取到的K线太旧，说明目标K线还未收盘
    return parseFloat(data[0][4]); // close price
  } catch(e) { return null; }
}

// ── 压缩式长期记忆（偏差记忆）────────────────────────────────────
// v2.3 改动：分析师 / 裁判分别压缩、分别存储、分别注入
//   旧方案两者共用一段偏差记忆，但两个角色性质完全不同：
//     · 分析师偏差 = "看图能力问题"（指标读偏、形态识别错）
//     · 裁判偏差 = "决策权重问题"（过度信任或忽视质疑师 / 历史学家）
//   合并喂给两边会出现"分析师收到一堆裁判才用得上的建议"的污染。
//   现在用 role 参数分流，写到 biasMemoryAnalyst / biasMemoryJudge。
const BIAS_COMPRESS_EVERY = 5;
let _biasCompressRunning = { analyst: false, judge: false };

async function compressBiasMemoryRole(role, autoSessions, judgeModel) {
  if (_biasCompressRunning[role]) return;
  _biasCompressRunning[role] = true;
  try {
    const dirKey = role === 'analyst' ? 'analystDirection' : 'direction';
    const resKey = role === 'analyst' ? 'analystVerifyResult' : 'verifyResult';

    // 只取该角色"实际给方向且已验证"的样本——观望样本不进入压缩
    const verified = autoSessions.filter(s =>
      s[dirKey] && s[dirKey] !== 'neutral' && (s[resKey] === 'win' || s[resKey] === 'loss')
    ).slice(0, 10);
    if (verified.length < 3) return;

    let sessionsText = '';
    for (let i = 0; i < verified.length; i++) {
      const s = verified[i];
      const dirCode = s[dirKey];
      const resCode = s[resKey];
      const dir = dirCode === 'bullish' ? '看涨' : dirCode === 'bearish' ? '看跌' : '观望';
      const res = resCode === 'win' ? '✅正确' : resCode === 'loss' ? '❌错误' : '⏳待验';
      const state = s.marketState || '不明';
      const summary = extractSignalSummary(s.result || '') || '（无摘要）';
      sessionsText += (i + 1) + '. [' + s.time + '] 市场状态:' + state + ' 方向:' + dir + ' 结果:' + res + '\n   摘要:' + summary + '\n';
    }

    // 两个角色用不同的反思维度
    const roleIntro = role === 'analyst'
      ? '你正在为"分析师"角色复盘。分析师的职责是从K线指标中读出方向证据，独立形成交易判断。'
      : '你正在为"裁判"角色复盘。裁判的职责是综合分析师主张和质疑师风险清单，做最终仲裁决策。';

    const reflectFocus = role === 'analyst'
      ? '1. 【指标读取偏差】：分析师在哪些指标组合上容易误判方向？\n' +
        '2. 【市场状态识别】：分析师在哪种行情结构下最容易把震荡当趋势 / 把回调当反转？\n' +
        '3. 【期限选择偏差】：分析师建议的期限是否系统性偏长或偏短？\n' +
        '4. 【对分析师的执行建议】：下次读图时最需要注意的一句话提醒。'
      : '1. 【仲裁偏差】：裁判在接受/拒绝质疑师风险约束时是否系统性过于宽松或过于严格？\n' +
        '2. 【市场状态决策规律】：趋势/震荡行情下，裁判分别在什么条件下胜率高/低？\n' +
        '3. 【置信度校准】：裁判给出的置信度是否系统性偏高/偏低于实际胜率？\n' +
        '4. 【对裁判的执行建议】：下次仲裁时最需要注意的一句话提醒。';

    const compressPrompt = roleIntro + '\n\n以下是该角色最近' + verified.length + '次"有方向且已验证"的交易信号（由新到旧）：\n\n' + sessionsText +
      '\n\n请按以下四个维度复盘，每项不超过2句话：\n' + reflectFocus +
      '\n\n输出格式严格按以下结构，不要添加其他内容：\n' +
      '【维度1】\n（内容）\n【维度2】\n（内容）\n【维度3】\n（内容）\n【维度4】\n（内容）';

    const biasResult = await callAPI(
      judgeModel.key, judgeModel.base, judgeModel.model,
      [{ role: 'user', content: compressPrompt }],
      // source 用具名字符串而不是 null，避免 fetchControllers.set(null) 冲突
      judgeModel.apiFormat, null, 'bias_compress_' + role, 512
    );

    if (biasResult && biasResult.length > 20) {
      const storeKey = role === 'analyst' ? 'biasMemoryAnalyst' : 'biasMemoryJudge';
      await chrome.storage.local.set({
        [storeKey]: {
          content: biasResult,
          updatedAt: new Date().toLocaleString('zh-CN'),
          basedOn: verified.length,
          role: role
        }
      });
      BgLog.info('[compressBiasMemoryRole:' + role + '] 已更新偏差记忆', 'basedOn=' + verified.length);
    }
  } catch(e) {
    // v2.2 改动：不再静默吞噬。失败必须 warn 出来便于诊断
    BgLog.warn('[compressBiasMemoryRole:' + role + '] 压缩失败', e && (e.message || String(e)));
  } finally {
    _biasCompressRunning[role] = false;
  }
}

// 兼容入口：同时压缩两个角色（非阻塞，并行）
async function compressBiasMemory(autoSessions, judgeModel) {
  // 不 await，让两个角色并行压缩；调用方原本就是非阻塞调度
  compressBiasMemoryRole('analyst', autoSessions, judgeModel).catch(e => BgLog.warn('[bias:analyst]', e.message));
  compressBiasMemoryRole('judge',   autoSessions, judgeModel).catch(e => BgLog.warn('[bias:judge]',   e.message));
}

// ── 扫描并执行到期验证 ────────────────────────────────────────────
// wsPrice: 当前触发时 WebSocket 收到的刚收盘K线收盘价（klineText中的"收:"字段，不受鼠标影响）
// wsTimestamp: 当前触发时间戳（null时用Date.now()）
// tabId: 用于发送提示消息
// 优先用 wsPrice（在窗口内），否则调 fetchPriceAtTime 拉 Binance 历史收盘价
// 只有 Binance 也返回 null（网络错误）时才跳过，下次重试；不再自动 terminated
let _verifyRunning = false;


// ── A/B 实验框架 ─────────────────────────────────────────────────
// 每次分析独立随机分配 variant A 或 B，分别追踪胜率和 PnL
// 当前实验：A = biasMemory 注入（标准流程），B = 不注入 biasMemory（对照组）
// 单用户场景下也能积累两组样本做配对统计；持久化"绑定一组"的旧设计已废弃

const AB_EXPERIMENT_ID = 'bias_memory_v3'; // v2.2: 实验设计变更，重置统计

// v2.2 改动：从 Math.random() 改为基于 K 线时间戳的确定性哈希
// 优点：同一根 K 线永远落到同一组 → 可复现、可回放、可回测
// 单次随机分组的噪声会盖掉真信号，确定性分组可对每一根 K 线做配对比较
// v3.1 修复：改用字符串哈希避免毫秒级时间戳超出32位整数导致的截断失真
function _hashAB(seed) {
  const str = String(seed);
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
  }
  return h % 2 === 0 ? 'A' : 'B';
}
async function getOrAssignABVariant(dataTimestamp) {
  if (dataTimestamp && Number.isFinite(dataTimestamp)) return _hashAB(dataTimestamp);
  // 兜底（理论不会到这里）：拿当前时刻分组
  return _hashAB(Date.now());
}

async function recordABResult(variant, pnl, won) {
  const key = 'abStats_' + AB_EXPERIMENT_ID;
  const stored = await chrome.storage.local.get(key);
  const stats = stored[key] || { A: { n:0, wins:0, pnlSum:0 }, B: { n:0, wins:0, pnlSum:0 } };
  if (!stats[variant]) stats[variant] = { n:0, wins:0, pnlSum:0 };
  stats[variant].n++;
  if (won) stats[variant].wins++;
  if (pnl != null) stats[variant].pnlSum += pnl;
  await chrome.storage.local.set({ [key]: stats });

  // 当两组各自有 ≥20 个样本时，自动汇报
  if (stats.A.n >= 20 && stats.B.n >= 20) {
    const aWR = stats.A.n ? (stats.A.wins / stats.A.n * 100).toFixed(1) : '—';
    const bWR = stats.B.n ? (stats.B.wins / stats.B.n * 100).toFixed(1) : '—';
    const aPnl = stats.A.n ? (stats.A.pnlSum / stats.A.n * 100).toFixed(3) : '—';
    const bPnl = stats.B.n ? (stats.B.pnlSum / stats.B.n * 100).toFixed(3) : '—';
    BgLog.info('[A/B实验 ' + AB_EXPERIMENT_ID + '] A(偏差记忆):' + aWR + '%WR/' + aPnl + '%PnL  B(对照组):' + bWR + '%WR/' + bPnl + '%PnL');
  }
}

// ── P1改进：数据驱动阈值推导（v2.3 按期限分桶）─────────────────────────
// v2.2 目标函数：胜率 × 1.8 - 1（二元期权真实期望收益），Wilson 95% 下界抑噪。
// v2.3 关键改动：按期限分桶推导 —— 3分钟和30分钟的最优入场条件完全不同，
//   原先一套阈值打天下等于用 30 分钟均值参数管 3 分钟快单。
//   现在每个桶（3M/5M/10M/15M/30M/1H）独立扫描置信度阈值；
//   样本不足的桶退回全局兜底（仍按全期限合并推一遍）。
//
// 返回结构：
//   {
//     byPeriod: { '3M': {base, oscillating, sampleN, derived, ...}, '5M': {...}, ... },
//     base: 55, oscillating: 65,   // 全局兜底（向下兼容旧调用）
//     sampleN, derived, ...
//   }
async function deriveOptimalThreshold() {
  const stored = await chrome.storage.local.get(['autoSessions', 'derivedThreshold']);
  const sessions = (stored.autoSessions || []).filter(
    s => s.direction && s.direction !== 'neutral' && (s.verifyResult === 'win' || s.verifyResult === 'loss')
  );

  const cached = stored.derivedThreshold;

  // Wilson score interval 下界（95% 置信度），抑制小样本噪声
  function wilsonLower(wins, total) {
    if (total === 0) return 0;
    const z = 1.96;
    const p = wins / total;
    const denom = 1 + z * z / total;
    const center = p + z * z / (2 * total);
    const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));
    return (center - margin) / denom;
  }

  // 把分钟数映射到桶
  function periodBucket(mins) {
    if (mins == null) return null;
    if (mins <= 7) return '5M';
    if (mins <= 12) return '10M';
    if (mins <= 20) return '15M';
    if (mins <= 45) return '30M';
    return '1H';
  }

  // 单组样本扫描出最优阈值
  function scanThreshold(withConf, minSamplesPerBin) {
    let bestT = null, bestExp = -Infinity, bestW = 0;
    for (let t = 45; t <= 75; t += 5) {
      const trades = withConf.filter(x => x.conf >= t);
      if (trades.length < minSamplesPerBin) continue;
      const wins = trades.filter(x => x.won).length;
      const wl = wilsonLower(wins, trades.length);
      const exp = wl * 1.8 - 1;
      if (exp > bestExp) { bestExp = exp; bestT = t; bestW = wl; }
    }
    return bestT == null ? null : { threshold: bestT, expReturn: bestExp, wilson: bestW };
  }

  // 给每个 session 附加 conf / 桶
  const enriched = sessions.map(s => {
    const m = (s.result || '').match(/【置信度[^】]*】\s*(\d+)/);
    if (!m) return null;
    const conf = parseInt(m[1]);
    const periodMin = s.verifyAt && s.dataTimestamp
      ? Math.round((s.verifyAt - s.dataTimestamp) / 60000) : null;
    return {
      conf,
      won: s.verifyResult === 'win',
      bucket: periodBucket(periodMin)
    };
  }).filter(Boolean);

  // 总样本不足：兜底
  if (enriched.length < 30) {
    return cached || { byPeriod: {}, base: 55, oscillating: 60, sampleN: enriched.length, derived: false };
  }

  // 全局扫描（向下兼容旧调用 & 用作桶内样本不足时的兜底）
  const globalScan = scanThreshold(enriched, 30);
  const globalResult = globalScan
    ? {
        base: globalScan.threshold,
        oscillating: Math.min(globalScan.threshold + 5, 70),
        sampleN: enriched.length,
        derived: true,
        wilsonWinRate: (globalScan.wilson * 100).toFixed(1) + '%',
        expectedReturn: (globalScan.expReturn * 100).toFixed(2) + '%',
        expectedPnl: (globalScan.expReturn * 100).toFixed(2) + '%' // 兼容旧字段
      }
    : { base: 55, oscillating: 60, sampleN: enriched.length, derived: false };

  // 分桶扫描：每桶要求 ≥ 20 样本（比全局的 30 略松，但仍能压制噪声）
  const PER_BUCKET_MIN = 20;
  const byPeriod = {};
  const buckets = ['5M', '10M', '15M', '30M', '1H'];
  for (const b of buckets) {
    const subset = enriched.filter(x => x.bucket === b);
    if (subset.length < PER_BUCKET_MIN) {
      byPeriod[b] = {
        base: globalResult.base || 55,
        oscillating: globalResult.oscillating || 60,
        sampleN: subset.length,
        derived: false,
        fellBackToGlobal: true
      };
      continue;
    }
    const sc = scanThreshold(subset, Math.max(10, Math.floor(PER_BUCKET_MIN / 2)));
    if (!sc) {
      byPeriod[b] = {
        base: globalResult.base || 55,
        oscillating: globalResult.oscillating || 60,
        sampleN: subset.length,
        derived: false,
        fellBackToGlobal: true
      };
      continue;
    }
    byPeriod[b] = {
      base: sc.threshold,
      oscillating: Math.min(sc.threshold + 5, 70),
      sampleN: subset.length,
      derived: true,
      wilsonWinRate: (sc.wilson * 100).toFixed(1) + '%',
      expectedReturn: (sc.expReturn * 100).toFixed(2) + '%'
    };
  }

  const result = Object.assign({}, globalResult, {
    byPeriod,
    updatedAt: new Date().toLocaleTimeString('zh-CN')
  });

  await chrome.storage.local.set({ derivedThreshold: result });
  const bucketLog = buckets
    .map(b => b + '=' + byPeriod[b].base + '/' + byPeriod[b].oscillating + '(n=' + byPeriod[b].sampleN + (byPeriod[b].derived ? '' : '*') + ')')
    .join(' ');
  BgLog.info('[阈值推导分桶] 全局base=' + result.base + '% n=' + result.sampleN + ' | ' + bucketLog + ' (*=兜底)');
  return result;
}

// 工具：把 analyst 给出的分钟数映射到桶（与 deriveOptimalThreshold 同步保持口径一致）
function _periodBucketFromMinutes(mins) {
  if (mins == null) return null;
  if (mins <= 7)  return '5M';
  if (mins <= 12) return '10M';
  if (mins <= 20) return '15M';
  if (mins <= 45) return '30M';
  return '1H';
}

async function runPendingVerifications(wsPrice, wsTimestamp, tabId) {
  if (_verifyRunning) return;
  _verifyRunning = true;
  try {
    const stored = await chrome.storage.local.get('autoSessions');
    const sessions = stored.autoSessions || [];
    let changed = false;
    let retroCount = 0;
    const iMsMap = { '1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000 };
    const effectiveNow = wsTimestamp || Date.now();

    for (const s of sessions) {
      // 观望方向但 verifyAt 已到期 → 标记为 terminated，避免 UI 永久显示 ⏳
      if ((!s.direction || s.direction === 'neutral') && !s.verifyResult && s.verifyAt && s.verifyAt <= effectiveNow) {
        s.verifyResult = 'terminated'; changed = true;
      }
      if ((!s.analystDirection || s.analystDirection === 'neutral') && !s.analystVerifyResult && s.analystVerifyAt && s.analystVerifyAt <= effectiveNow) {
        s.analystVerifyResult = 'terminated'; changed = true;
      }
      // AI 没有输出建议期限（verifyAt=null）但方向非观望 → 也标记为 terminated，不再卡在 ⏳
      if (s.direction && s.direction !== 'neutral' && !s.verifyAt && !s.verifyResult) {
        s.verifyResult = 'terminated'; changed = true;
      }
      if (s.analystDirection && s.analystDirection !== 'neutral' && !s.analystVerifyAt && !s.analystVerifyResult) {
        s.analystVerifyResult = 'terminated'; changed = true;
      }
      if (s.direction === 'neutral' && (!s.analystDirection || s.analystDirection === 'neutral')) continue;
      if (!s.closedPrice) continue;
      const iMs = iMsMap[s.interval || '1m'] || 60000;
      const sym = s.symbol || 'BTCUSDT';

      // 裁判验证（含重试 terminated 旧记录）
      if ((!s.verifyResult || s.verifyResult === 'terminated') && s.direction && s.direction !== 'neutral' && s.verifyAt && s.verifyAt <= effectiveNow) {
        if (wsPrice && effectiveNow <= s.verifyAt + iMs) {
          // 正常路径：在当前K线窗口内，用 WS 收盘价直接验证
          const diff = wsPrice - s.closedPrice;
          s.verifyResult = ((s.direction === 'bullish' && diff > 0) || (s.direction === 'bearish' && diff < 0)) ? 'win' : 'loss';
          s.verifyPrice  = wsPrice;
          // P0改进：幅度感知胜率 — realPnl = 方向 × 收益率（正=盈，负=亏）
          s.realPnl = (s.direction === 'bullish' ? 1 : -1) * (wsPrice - s.closedPrice) / s.closedPrice;
          changed = true;
        } else {
          // 错过窗口 或 无 wsPrice：用 Binance REST 拉历史收盘价
          const histPrice = await fetchPriceAtTime(s.interval || '1m', s.verifyAt, sym);
          if (histPrice) {
            const diff = histPrice - s.closedPrice;
            s.verifyResult = ((s.direction === 'bullish' && diff > 0) || (s.direction === 'bearish' && diff < 0)) ? 'win' : 'loss';
            s.verifyPrice  = histPrice;
            // P0改进：幅度感知胜率 — realPnl
            s.realPnl = (s.direction === 'bullish' ? 1 : -1) * (histPrice - s.closedPrice) / s.closedPrice;
            changed = true; retroCount++;
          }
          // histPrice 为 null（网络错误或K线未收盘）→ 跳过，下次重试
        }
      }

      // 分析师验证（含重试 terminated 旧记录）
      if ((!s.analystVerifyResult || s.analystVerifyResult === 'terminated') && s.analystDirection && s.analystDirection !== 'neutral' && s.analystVerifyAt && s.analystVerifyAt <= effectiveNow) {
        if (wsPrice && effectiveNow <= s.analystVerifyAt + iMs) {
          const aDiff = wsPrice - s.closedPrice;
          s.analystVerifyResult = ((s.analystDirection === 'bullish' && aDiff > 0) || (s.analystDirection === 'bearish' && aDiff < 0)) ? 'win' : 'loss';
          s.analystVerifyPrice  = wsPrice;
          s.analystRealPnl = (s.analystDirection === 'bullish' ? 1 : -1) * (wsPrice - s.closedPrice) / s.closedPrice;
          changed = true;
        } else {
          const aHistPrice = await fetchPriceAtTime(s.interval || '1m', s.analystVerifyAt, sym);
          if (aHistPrice) {
            const aDiff = aHistPrice - s.closedPrice;
            s.analystVerifyResult = ((s.analystDirection === 'bullish' && aDiff > 0) || (s.analystDirection === 'bearish' && aDiff < 0)) ? 'win' : 'loss';
            s.analystVerifyPrice  = aHistPrice;
            s.analystRealPnl = (s.analystDirection === 'bullish' ? 1 : -1) * (aHistPrice - s.closedPrice) / s.closedPrice;
            changed = true; retroCount++;
          }
        }
      }
    }

    if (changed) {
      // 竞态修复：写入前重新读取，把验证结果合并进最新数据
      const latestForVerify = await chrome.storage.local.get('autoSessions');
      const latestSessions = latestForVerify.autoSessions || [];
      for (const s of sessions) {
        const idx = latestSessions.findIndex(x => x.id === s.id);
        if (idx !== -1) {
          if (s.verifyResult != null)        latestSessions[idx].verifyResult        = s.verifyResult;
          if (s.verifyPrice != null)         latestSessions[idx].verifyPrice         = s.verifyPrice;
          if (s.realPnl != null)             latestSessions[idx].realPnl             = s.realPnl;
          if (s.analystVerifyResult != null) latestSessions[idx].analystVerifyResult = s.analystVerifyResult;
          if (s.analystVerifyPrice != null)  latestSessions[idx].analystVerifyPrice  = s.analystVerifyPrice;
          if (s.analystRealPnl != null)      latestSessions[idx].analystRealPnl      = s.analystRealPnl;
          // P2改进：A/B实验结果记录（有 variant 且本次刚验证完的 session）
          if (s.abVariant && s.realPnl != null && (s.verifyResult === 'win' || s.verifyResult === 'loss')) {
            recordABResult(s.abVariant, s.realPnl, s.verifyResult === 'win').catch(e => logSafe('[recordABResult]', e));
          }
        }
      }
      await chrome.storage.local.set({ autoSessions: latestSessions });
      if (retroCount > 0) {
        const msg = '📡 ' + retroCount + ' 条验证记录已通过 Binance 历史数据补全。\n';
        if (tabId) chrome.tabs.sendMessage(tabId, { type: 'STREAM_CHUNK', chunk: msg, source: 'auto_judge' }).catch(() => {});
        else chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title: 'TVC 历史验证', message: msg.trim() });
      }
      // v2.10 新增：验证完成后通知 content.js 刷新胜率面板
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'VERIFY_DONE' }).catch(() => {});
      } else {
        chrome.tabs.query({ url: '*://*.tradingview.com/*' }, function(tabs) {
          (tabs || []).forEach(function(t) {
            chrome.tabs.sendMessage(t.id, { type: 'VERIFY_DONE' }).catch(() => {});
          });
        });
      }
      // v2.3 修复：旧用 verifiedCount % 5 === 0 在一次补验多条时会跳过倍数 → 压缩永远不触发
      //   改为水位线：当 verifiedCount 比上次压缩时多 ≥ BIAS_COMPRESS_EVERY 就触发，且为分析师/裁判分别水位
      const verifiedCountJudge = latestSessions.filter(s => s.verifyResult === 'win' || s.verifyResult === 'loss').length;
      const verifiedCountAnalyst = latestSessions.filter(s => s.analystVerifyResult === 'win' || s.analystVerifyResult === 'loss').length;
      const watermark = (await chrome.storage.local.get('biasCompressedAt')).biasCompressedAt || { analyst: 0, judge: 0 };
      const needJudge   = verifiedCountJudge   >= (watermark.judge   || 0) + BIAS_COMPRESS_EVERY;
      const needAnalyst = verifiedCountAnalyst >= (watermark.analyst || 0) + BIAS_COMPRESS_EVERY;
      if (needJudge || needAnalyst) {
        try {
          const cfg = await chrome.storage.local.get(['agentModels']);
          const agentModelIdxs = (cfg.agentModels) || [0, 0, 0];
          const judgeModel = await getModelConfig(agentModelIdxs[2], 'bias_compress');
          // 分别按角色触发，压缩函数内部并发安全
          if (needJudge) {
            compressBiasMemoryRole('judge', latestSessions, judgeModel)
              .then(() => chrome.storage.local.get('biasCompressedAt'))
              .then(stored => {
                const wm = stored.biasCompressedAt || { analyst: 0, judge: 0 };
                wm.judge = verifiedCountJudge;
                return chrome.storage.local.set({ biasCompressedAt: wm });
              })
              .catch(e => BgLog.warn('[偏差记忆:裁判] 压缩失败', e.message));
          }
          if (needAnalyst) {
            compressBiasMemoryRole('analyst', latestSessions, judgeModel)
              .then(() => chrome.storage.local.get('biasCompressedAt'))
              .then(stored => {
                const wm = stored.biasCompressedAt || { analyst: 0, judge: 0 };
                wm.analyst = verifiedCountAnalyst;
                return chrome.storage.local.set({ biasCompressedAt: wm });
              })
              .catch(e => BgLog.warn('[偏差记忆:分析师] 压缩失败', e.message));
          }
        } catch(e) { logSafe('[verify:biasCompressDispatch]', e); }
      }
      // v3.1 元裁判：验证计数变化后检查是否需要触发审计
      checkMetaJudgeTrigger(latestSessions, tabId).catch(e => logSafe('[checkMetaJudge]', e));
    }
  } finally {
    _verifyRunning = false;
  }
}

// ── 解析信号级别（🟢A / 🟡B / 🔴C） ──────────────────────────────
function parseSignalGrade(text) {
  if (!text) return null;
  const m = text.match(/【信号级别[^】]*】\s*([🟢🟡🔴]?\s*[ABC])/u);
  if (!m) return null;
  const s = m[1].trim();
  if (s.includes('A')) return 'A';
  if (s.includes('B')) return 'B';
  if (s.includes('C')) return 'C';
  return null;
}

// ── 解析方向 ─────────────────────────────────────────────────────
function parseDirection(text) {
  // 优先用机读 JSON
  const jr = parseJsonResult(text);
  if (jr && typeof jr.direction === 'string') {
    const d = jr.direction.toLowerCase();
    if (d === 'bullish') return { label: 'bullish', icon: '📈', summary: extractSummary(text) };
    if (d === 'bearish') return { label: 'bearish', icon: '📉', summary: extractSummary(text) };
    if (d === 'neutral') return { label: 'neutral', icon: '👀', summary: extractSummary(text) };
  }
  // 降级：原【方向】行解析
  // 只取【方向】同行内容，不读下一行（下一行可能是【置信度】说明，含看涨/看跌词汇会干扰判断）
  const dirMatch = text.match(/【方向[^】]*】([^\n]*)/);
  const target = dirMatch ? dirMatch[1].trim() : text.slice(0, 120);

  // P0 修复：优先识别【方向】行开头的显式结论，避免
  // 「看涨（若失效则观望）」/「看跌，证据不足时观望」这种说明文字
  // 因包含“观望”二字被误判成 neutral，导致 Agent 面板有方向、
  // 但写入 autoSessions 后历史/胜率都按“观望”处理。
  const explicit = target.match(/^(看涨|看跌|观望|bullish|bearish|neutral)/i);
  if (explicit) {
    const token = explicit[1].toLowerCase();
    if (token === '看涨' || token === 'bullish') return { label: 'bullish', icon: '📈', summary: extractSummary(text) };
    if (token === '看跌' || token === 'bearish') return { label: 'bearish', icon: '📉', summary: extractSummary(text) };
    if (token === '观望' || token === 'neutral') return { label: 'neutral', icon: '👀', summary: extractSummary(text) };
  }

  // 如果 target 同时含看涨/看跌/观望三个词，说明是模板行（如"看涨/看跌/观望"），跳过直接返回 neutral
  const hasBullish = /看涨|📈|bullish/i.test(target);
  const hasBearish = /看跌|📉|bearish/i.test(target);
  const hasNeutral = /观望|neutral/i.test(target);
  if (hasBullish && hasBearish && hasNeutral) {
    BgLog.warn('[parseDirection] 模板回抄，方向字段含三个词，归为neutral', target.slice(0, 60));
    return { label: 'neutral', icon: '👀', summary: extractSummary(text) };
  }
  // 没有显式首词时，才退回包含判断
  if (hasBullish && !hasBearish) return { label: 'bullish', icon: '📈', summary: extractSummary(text) };
  if (hasBearish && !hasBullish) return { label: 'bearish', icon: '📉', summary: extractSummary(text) };
  if (hasNeutral && !hasBullish && !hasBearish) {
    return { label: 'neutral', icon: '👀', summary: extractSummary(text) };
  }
  return { label: 'neutral', icon: '👀', summary: extractSummary(text) };
}


// ── 对话面板三角色分析（新功能）──────────────────────────────────────
// 与自动分析逻辑基本相同，但流式 source 使用 chat_analyst/chat_critic/chat_judge
// 这样 content.js 可以在对话面板中展示三个角色的实时输出
async function handleAgentsManual(msg, tabId) {
  try {
    const cfg = await chrome.storage.local.get(['agentModels', 'agentPrompts', 'background']);
    const agentModelIdxs = cfg.agentModels || [0, 0, 0];
    const agentPromptsCfg = cfg.agentPrompts || [];
    const [analystModel, criticModel, judgeModel] = await Promise.all([
      getModelConfig(agentModelIdxs[0], 'chat_analyst'),
      getModelConfig(agentModelIdxs[1], 'chat_critic'),
      getModelConfig(agentModelIdxs[2], 'chat_judge')
    ]);

    const profile = getDecisionProfile(cfg.enhancements || {});
    const analystSysPrompt = ((agentPromptsCfg[0] && agentPromptsCfg[0].trim()) ? agentPromptsCfg[0] : DEFAULT_ANALYST_PROMPT) + profileGuidance(profile, 'analyst') + ANALYST_FORMAT_LAYER;
    const criticPrompt     = ((agentPromptsCfg[1] && agentPromptsCfg[1].trim()) ? agentPromptsCfg[1] : DEFAULT_CRITIC_PROMPT) + profileGuidance(profile, 'critic') + CRITIC_FORMAT_LAYER;
    const judgePrompt      = ((agentPromptsCfg[2] && agentPromptsCfg[2].trim()) ? agentPromptsCfg[2] : DEFAULT_JUDGE_PROMPT) + profileGuidance(profile, 'judge') + JUDGE_FORMAT_LAYER;
    // v2.7: 读取每个 Agent 的 max_tokens 配置
    const _maxTok = await getAgentMaxTokens();

    const bg = cfg.background ? '【交易背景】' + cfg.background + '\n\n' : '';
    const klineSection = msg.klineText ? '\n\n以下是当前K线及指标数据（请结合图表和数值进行分析）：\n' + msg.klineText : '';
    const extraPrompt = msg.prompt ? '\n\n【补充指令】\n' + msg.prompt : '';
    const manualRoleViews = buildRoleSpecificViews(msg.klineText || '');

    // ── Agent 1：分析师（纯文字模式） ──────────────────────────────
    // 系统指令直接拼入 user 消息头部（代理不支持 system 字段）
    const analystDataSection = manualRoleViews.analystText ? ('\n\n【分析师专用结构化数据】\n' + manualRoleViews.analystText) : '';
    const analystDecisionGuide = '\n\n【分析师输出强化要求】\n' +
      '你输出给裁判和会话历史的内容会被直接复用，必须优先保留：首选方案、主要证据、主要风险、放弃备选。';
    const analystFullText = analystSysPrompt + bg + extraPrompt + klineSection + analystDataSection + analystDecisionGuide + PROMPT_TAIL_REMINDER;

    let analystResult;
    try {
      analystResult = await callAPIWithRetry(
        analystModel.key, analystModel.base, analystModel.model,
        [{ role: 'user', content: analystFullText }],
        analystModel.apiFormat, tabId, 'chat_analyst', _maxTok.analyst
      );
    } catch(e) { throw new Error('[分析师] ' + e.message); }

    // ── Agent 2：质疑师（风险审查官）──────────────────────────────
    const criticDataSection = manualRoleViews.criticText ? ('\n\n【K线及指标完整数据（独立核验用）】\n' + manualRoleViews.criticText) : '';
    const analystForManualCritic = analystResult
      ? '\n\n【分析师主方案（待风险审查）】\n' + analystResult + '\n'
      : '';
    const criticFullText = criticPrompt + klineSection + criticDataSection + analystForManualCritic +
      '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '【风险审查任务】\n' +
      '请基于上方指标数据，对分析师的主方案进行风险审查：\n' +
      '1. 找出高级风险（可能直接导致失败的因素）\n' +
      '2. 找出中级风险（会降低胜算的因素）\n' +
      '3. 列出正向证据（支持分析师方向的最强理由）\n' +
      '4. 给出置信度上限建议\n' +
      '不要给出自己的交易方向，只做风险量化。\n' +
      PROMPT_TAIL_REMINDER;
    let criticResult;
    try {
      criticResult = await callAPIWithRetry(
        criticModel.key, criticModel.base, criticModel.model,
        [{ role: 'user', content: criticFullText }],
        criticModel.apiFormat, tabId, 'chat_critic', _maxTok.critic
      );
    } catch(e) { throw new Error('[质疑师] ' + e.message); }

    // ── Agent 3：裁判（干净仲裁者，不接收原始数据）──────────────────
    // v3.5: 档位已删除，裁判独立法官
    const judgeDecisionGuide = '\n\n【裁判决策要求】\n' +
      '你是独立法官，质疑师的陈述是辩护意见而非约束。\n' +
      '基于分析师主张和质疑师质疑，做出你自己的独立判断。\n' +
      '明显趋势中质疑师需提供足够强的反驳才能推翻顺势方向，仅凭短期指标偏高不足以推翻趋势逻辑。\n' +
      '置信度门槛：统一≥58%（高于56%保本线，不分趋势/震荡）。低于门槛输出观望。';
    const judgeFullText = judgePrompt + '\n\n' + bg +
      '\n\n【分析师判断】\n' + analystResult +
      '\n\n【质疑师风险审查结论】\n' + criticResult + judgeDecisionGuide + PROMPT_TAIL_REMINDER;
    let judgeResult;
    try {
      judgeResult = await callAPIWithRetry(
        judgeModel.key, judgeModel.base, judgeModel.model,
        [{ role: 'user', content: judgeFullText }],
        judgeModel.apiFormat, tabId, 'chat_judge', _maxTok.judge
      );
    } catch(e) { throw new Error('[裁判] ' + e.message); }

    const _manualPayload = manualRoleViews.payload || extractBinaryFeaturePayload(msg.klineText || '');
    const _manualMarketRegime = detectMarketRegimeFromPayload(_manualPayload, judgeResult);
    // v3.2 Fix3: 手动流程无 clamp 步骤，gate 直接用裁判原始输出，无链式死锁问题
    // v3.13: 补入 payload，使手动模式也走完整 G0相位/G5否决/G7门槛
    const _manualGate = applyDecisionProfileGate(judgeResult, {
      profile,
      criticResult,
      marketRegime: _manualMarketRegime,
      payload: _manualPayload
    });
    if (_manualGate.forced) {
      BgLog.warn('[决策档位门控][手动] 拦截', _manualGate.reason);
      judgeResult = _manualGate.judgeResult;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: 'STREAM_CHUNK',
          chunk: '\n🚫 决策档位门控：' + (profile.name || 'balanced') + ' 已将手动结论改为观望\n',
          source: 'chat_judge'
        }).catch(function() {});
      }
    }

    // 保存到 sessions（与普通分析同样的格式，方便历史查询）
    const prompt = bg + extraPrompt + klineSection;
    const session = {
      id: 'm-' + Date.now().toString(),
      time: new Date().toLocaleString('zh-CN'),
      isAgents: true,          // 标记为三角色会话，供 loadSession 识别
      result:        judgeResult,   // 裁判（根级，供历史面板直接读取）
      analystResult: analystResult, // 分析师（根级）
      criticResult:  criticResult,  // 质疑师（根级）
      messages: [
        { role: 'user', content: prompt, isFirst: true },
        { role: 'assistant', content: judgeResult, analystResult, criticResult }
      ]
    };
    const stored = await chrome.storage.local.get('sessions');
    const sessions = stored.sessions || [];
    sessions.unshift(session);
    if (sessions.length > 20) sessions.length = 20;
    await chrome.storage.local.set({ sessions });

    return { result: judgeResult, analystResult, criticResult, sessionId: session.id };
  } catch(e) {
    BgLog.error('handleAgentsManual 失败', e.message);
    // 通知 content.js 解锁
    if (tabId) {
      const errSrc = e.message.startsWith('[分析师]') ? 'chat_analyst'
                   : e.message.startsWith('[质疑师]') ? 'chat_critic'
                   : 'chat_judge';
      chrome.tabs.sendMessage(tabId, { type: 'STREAM_ERROR', error: e.message, source: errSrc }).catch(() => {});
    }
    return { error: e.message };
  }
}


// ── 历史学家 Agent：调用真实模型，深度分析历史相似案例 ─────────────────
// 把近期已验证历史案例格式化后交给模型，让模型找出相似规律并给出建议
// tabId 用于流式展示（historian 流式输出到 auto_historian source）
async function runHistorianAgent(autoSessions, klineText, tabId, skipCache) {
  // v2.3 修复：历史学家原先只看 verifyResult（裁判结果），
  //   裁判持续观望时分析师 analystVerifyResult 被完全忽略，导致历史学家永远激活不了。
  //   现在接受任一角色有验证结果即纳入样本。
  // v3.10.2: 去掉 klineText 过滤条件，旧session未必保存klineText，
  // 导致已验证记录数量被低估，历史学家迟迟无法激活。
  // klineText在历史学家实际使用时（bucket匹配阶段）再校验。
  const verified = autoSessions.filter(s => {
    const judgeOK   = s.verifyResult        === 'win' || s.verifyResult        === 'loss';
    const analystOK = s.analystVerifyResult === 'win' || s.analystVerifyResult === 'loss';
    return judgeOK || analystOK;
  });
  // v3.12.2: 历史学家全局激活门槛降到6条。
  // 用户要求更早介入做参考，因此把“待积累样本”从30条改成6条；
  // 具体相似桶仍保留单独门槛，避免样本太少时胡乱类比。
  const HISTORIAN_MIN_GLOBAL_SAMPLES = 6;
  const HISTORIAN_MIN_BUCKET_MATCHES = 10; // 签名相似度≥4的案例至少10条

  if (verified.length < HISTORIAN_MIN_GLOBAL_SAMPLES) {
    const remaining = HISTORIAN_MIN_GLOBAL_SAMPLES - verified.length;
    if (tabId && !skipCache) {
      const _msg0 = '📭 历史学家待机中（还需积累 ' + remaining + ' 条已验证记录才激活，当前 ' + verified.length + ' 条）。';
      chrome.tabs.sendMessage(tabId, { type: 'STREAM_CHUNK', chunk: _msg0, source: 'auto_historian' }).catch(() => {});
      chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE', source: 'auto_historian' }).catch(() => {});
    }
    return '';
  }

  // ── 缓存命中检查（预计算缓存的核心）────────────────────────────────
  // v2.9 修复：用当前 klineText ADX 推导市场状态，不依赖上一条 session 的状态
  // 原代码 autoSessions[0]?.marketState 是上根K线的状态，市场切换时 cache key 会错误
  function _deriveMarketFromKline(kt) {
    if (!kt) return '不明';
    const m = (kt || '').match(/ADX[^=：:]*[=：:]\s*([\d.]+)/i);
    if (!m) return '不明';
    const adxV = parseFloat(m[1]);
    if (adxV >= 25) return '趋势';
    if (adxV <= 20) return '震荡';
    return '不明';
  }
  const curMarket = _deriveMarketFromKline(klineText);
  // v2.4: 从 klineText 抓【入场时间戳】，让签名带上时段维度（makeKlineSig 内部也有兜底，但显式更清楚）
  const _curTsM = (klineText || '').match(/【入场时间戳】(\d+)/);
  const _curTs = _curTsM ? parseInt(_curTsM[1]) : null;
  const sig = makeKlineSig(klineText, curMarket, _curTs);
  const now = Date.now();
  if (!skipCache && _historianCache &&
      _historianCache.sig === sig &&
      now - _historianCache.ts < HISTORIAN_CACHE_TTL) {
    BgLog.info('历史学家命中缓存，跳过API调用', sig);
    // 缓存命中时手动推送内容，让 content.js 的 spinner 正常消失
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'STREAM_CHUNK', chunk: _historianCache.result, source: 'auto_historian' }).catch(() => {});
      chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE', source: 'auto_historian' }).catch(() => {});
    }
    return _historianCache.result; // ← 直接返回，节省10-15s
  }

  // v2.4 改造：按 K 线签名相似度排序后取 Top 6，而不是按时间倒序取最新 6 条
  //   - 用相同的 makeKlineSig 给当前 K 线和每个历史样本各打一个签名
  //   - 相似度 = 两个签名（下划线分隔）按位匹配的维度数
  //   - 8 维全等 → 8 分；时段不同、指标完全一致 → 7 分；等等
  //   - 同分按时间倒序（最新优先）
  function _scoreSig(sigA, sigB) {
    if (!sigA || !sigB) return 0;
    const a = sigA.split('_');
    const b = sigB.split('_');
    let sc = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== '?' && b[i] !== '?' && a[i] === b[i]) sc++;
    }
    return sc;
  }
  const _curSigForRank = makeCoarseSig(klineText, curMarket); // v3.13.5：用3维粗签名比对（满分3）
  const ranked = verified
    .map(sx => {
      const _sx_sig = makeCoarseSig(sx.klineText, sx.marketState);
      return { s: sx, sig: _sx_sig, score: _scoreSig(_curSigForRank, _sx_sig) };
    })
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      // 同分按 dataTimestamp 倒序（最近优先）
      return (y.s.dataTimestamp || 0) - (x.s.dataTimestamp || 0);
    });

  // v3.13.5：粗签名满分3，相似要求 sim≥2（3维中至少2维相同：如相位+方向 或 相位+市场态）
  const candidatePool = ranked.filter(r => r.score >= 2);

  // v3.13.5：相似案例不足时不再沉默，而是降级输出——明确告知"样本不足、仅供参考、不得用于调整置信度"。
  //   这样数据少时历史学家诚实标注不可信(避免少样本噪音误导)，够10条才允许影响置信度。
  const bucketLow = candidatePool.length < HISTORIAN_MIN_BUCKET_MATCHES;
  const confidenceNote = bucketLow
    ? '⚠️【低可信】同类样本仅' + candidatePool.length + '条(<' + HISTORIAN_MIN_BUCKET_MATCHES + ')，胜率统计为噪声级，仅供参考，禁止据此调整置信度。'
    : '【可用】同类样本' + candidatePool.length + '条，统计有参考价值。';

  const finalCases = (candidatePool.length >= 3 ? candidatePool : ranked).slice(0, 6);

  // v2.4：案例摘要分别展示分析师/裁判的方向和期限，让历史学家看到两者差异
  //   原来只用一个角色的期限会让"5M预测对了但裁判改成15M" 之类的差异丢失
  const cases = finalCases.map((r, i) => {
    const sx = r.s;
    const judgeOK   = sx.verifyResult === 'win' || sx.verifyResult === 'loss';
    const analystOK = sx.analystVerifyResult === 'win' || sx.analystVerifyResult === 'loss';

    // 分析师段
    let analystSeg = '';
    if (sx.analystDirection && sx.analystDirection !== 'neutral') {
      const aDir = sx.analystDirection === 'bullish' ? '看涨' : '看跌';
      const aMin = sx.analystVerifyAt && sx.dataTimestamp
        ? Math.round((sx.analystVerifyAt - sx.dataTimestamp) / 60000) : null;
      const aPer = aMin ? (aMin < 60 ? aMin + 'M' : aMin === 60 ? '1H' : Math.round(aMin / 60) + 'H') : '?';
      const aOut = analystOK ? (sx.analystVerifyResult === 'win' ? '✅' : '❌') : '⏳';
      analystSeg = '分析师' + aDir + aPer + aOut;
    }
    // 裁判段
    let judgeSeg = '';
    if (sx.direction && sx.direction !== 'neutral') {
      const jDir = sx.direction === 'bullish' ? '看涨' : '看跌';
      const jMin = sx.verifyAt && sx.dataTimestamp
        ? Math.round((sx.verifyAt - sx.dataTimestamp) / 60000) : null;
      const jPer = jMin ? (jMin < 60 ? jMin + 'M' : jMin === 60 ? '1H' : Math.round(jMin / 60) + 'H') : '?';
      const jOut = judgeOK ? (sx.verifyResult === 'win' ? '✅' : '❌') : '⏳';
      judgeSeg = '裁判' + jDir + jPer + jOut;
    } else if (sx.direction === 'neutral') {
      judgeSeg = '裁判观望';
    }
    // 拼接：若两段一致则只显示一段（防冗余），不一致则同时显示
    let roleStr;
    if (analystSeg && judgeSeg) roleStr = analystSeg + ' / ' + judgeSeg;
    else roleStr = analystSeg || judgeSeg || '（无效）';

    // 时段标签：从签名末位提取，便于历史学家观察时段规律
    const _sigParts = r.sig ? r.sig.split('_') : [];
    const _band = _sigParts[_sigParts.length - 1] || '?';
    const _bandLabel = _band === 'aEarly' ? '亚早' : _band === 'aLate' ? '亚晚'
                     : _band === 'euro'   ? '欧盘' : _band === 'us'    ? '美盘' : '时段?';

    const sumM = (sx.result || '').match(/【信号摘要】(.{0,80})/);
    const sum = sumM ? sumM[1].trim() : '（无摘要）';
    return `【案例${i+1}】sim=${r.score}/3 | ${sx.time || ''} | ${sx.marketState || '不明'}·${_bandLabel} | ${roleStr} | ${sum}`;
  }).join('\n');

  // 使用用户在设置面板配置的提示词（若未设置则用顶层 DEFAULT_HISTORIAN_PROMPT）
  const storedHPrompt = (await chrome.storage.local.get('historianPrompt')).historianPrompt;
  const historianSysPrompt = (storedHPrompt && storedHPrompt.trim()) ? storedHPrompt : DEFAULT_HISTORIAN_PROMPT;
  const historianPrompt = historianSysPrompt + '\n\n' +
    '【当前行情数据】\n' + (klineText || '（无数据）') + '\n\n' +
    '【样本可信度】' + confidenceNote + '\n\n' +
    '【历史档案（最近' + verified.slice(0,15).length + '条已验证记录）】\n' + cases + '\n\n' +
    '请完成以下三项任务（简洁，总字数不超过200字）：\n' +
    '1. 找出与当前行情最相似的1-3个历史案例，说明相似点（相位、可交易方向、市场状态）\n' +
    '2. 基于这些案例总结：当前这种市场环境的历史胜率和规律\n' +
    '3. 给本次分析师一条建议；★若【样本可信度】为低可信，必须在建议里写明"样本不足仅供参考，不据此调整置信度"\n\n' +
    '输出格式：\n【相似案例】\n【顺势胜率】\n【给分析师的建议】';

  // 读取历史学家模型配置
  // v2.6: 越界自动回退默认模型 + WARN，避免静默拿"最后一个"凑数导致跑错模型
  const stored = await chrome.storage.local.get(['historianModel', 'models', 'defaultModel']);
  const storedModels = stored.models || [];
  if (!storedModels.length) {
    BgLog.warn('[历史学家] 未配置任何模型，跳过');
    return '';
  }
  let defIdx = (typeof stored.defaultModel === 'number' && stored.defaultModel >= 0)
    ? stored.defaultModel : 0;
  if (defIdx >= storedModels.length) defIdx = 0;
  let hIdx = (typeof stored.historianModel === 'number' && stored.historianModel >= 0)
    ? stored.historianModel : defIdx;
  if (hIdx >= storedModels.length || hIdx < 0) {
    BgLog.warn('[历史学家] 原索引 #' + stored.historianModel +
      ' 越界（当前模型数=' + storedModels.length + '），临时回退到默认模型 #' + defIdx);
    hIdx = defIdx;
  }
  const hModel = storedModels[hIdx];
  if (!hModel) {
    BgLog.warn('[历史学家] 模型配置 #' + hIdx + ' 为空');
    return '';
  }

  try {
    // 历史学家流式输出到独立 source，让用户在自动面板能看到进度
    // v2.7: 读取 max_tokens 配置（思考型模型 300 token 一定不够）
    const _hMaxTok = (await getAgentMaxTokens()).historian;
    const result = await callAPI(
      hModel.key, hModel.base, hModel.model,
      [{ role: 'user', content: historianPrompt }],
      hModel.apiFormat, tabId, 'auto_historian', _hMaxTok
    );
    if (!result || !result.trim()) return '';
    const section = '【历史学家报告】\n' + result.trim() + '\n';
    // 写入缓存（供下次分析直接使用）
    _historianCache = { result: section, ts: Date.now(), sig };
    BgLog.info('历史学家结果已缓存', sig);
    return section;
  } catch(e) {
    BgLog.warn('历史学家调用失败', e.message);
    return ''; // 失败不阻断主流程
  }
}

// ── 后台静默预热历史学家（分析结束后异步调用）──────────────────────────
// 分析完成 → 后台用刚完成的数据预跑历史学家 → 结果存缓存
// 下次K线到来时直接读缓存，历史学家从关键路径消失
async function preWarmHistorian(autoSessions, klineText) {
  if (!autoSessions || !klineText) return;
  // 用当前数据重跑历史学家（skipCache=true 强制重算，覆盖旧缓存）
  try {
    await runHistorianAgent(autoSessions, klineText, null, true);
  } catch(e) {
    BgLog.warn('[预热历史学家] 失败', e.message);
  }
}

function extractSummary(text) {
  const m = text.match(/【(?:核心)?理由】(.+)/);
  return m ? m[1].trim().slice(0, 80) : text.replace(/\n/g, ' ').slice(0, 80);
}

// ── v3.12.4 元裁判：解析机读建议块（含阈值建议）──────────────────
// 从 LLM 输出里提取 PROMPT_SUGGESTIONS_START...END 和 THRESHOLD_SUGGESTIONS_START...END
// 返回 { analyst, critic, judge, suppressAction, confidenceGate, trendCondition }
function parseMetaJudgeSuggestions(text) {
  if (!text) return { analyst: null, critic: null, judge: null };
  const m = text.match(/PROMPT_SUGGESTIONS_START([\s\S]*?)PROMPT_SUGGESTIONS_END/);
  const block = m ? m[1] : '';
  function _extract(role) {
    const re = new RegExp(role + ':\\s*([^\\n]+)');
    const rm = block.match(re);
    if (!rm) return null;
    const v = rm[1].trim();
    return (v === '无' || v === '' || v === '—') ? null : v;
  }
  const tm = text.match(/THRESHOLD_SUGGESTIONS_START([\s\S]*?)THRESHOLD_SUGGESTIONS_END/);
  const tblock = tm ? tm[1] : '';
  function _tExtract(key) {
    const re = new RegExp(key + ':\\s*([^\\n]+)');
    const rm = tblock.match(re);
    return rm ? rm[1].trim() : null;
  }
  return {
    analyst:          _extract('ANALYST'),
    critic:           _extract('CRITIC'),
    judge:            _extract('JUDGE'),
    suppressAction:   _tExtract('SUPPRESS_ACTION'),
    confidenceGate:   _tExtract('CONFIDENCE_GATE'),
    trendCondition:   _tExtract('TREND_ENTRY_CONDITION')
  };
}

// ── v3.12.4 元裁判：拉取入场后 N 根 K 线（事后走势对照）──────────
async function fetchPostKlines(symbol, interval, dataTimestamp, limit) {
  if (!symbol || !interval || !dataTimestamp) return null;
  limit = limit || 16;
  const intervalMs = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
    '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000
  };
  const ms = intervalMs[interval] || 60000;
  const startTime = dataTimestamp + ms;
  try {
    const url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol
      + '&interval=' + interval
      + '&startTime=' + startTime
      + '&limit=' + limit;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return data.map(function(k) {
      return { t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]) };
    });
  } catch(e) { return null; }
}

// ── v3.12.4 元裁判：构建单条 session 的完整事后对照摘要 ──────────
async function buildSessionAuditLine(s, idx) {
  const jDir = s.direction === 'bullish' ? '看涨' : s.direction === 'bearish' ? '看跌' : '观望';
  const jRes = s.verifyResult === 'win' ? '✅' : s.verifyResult === 'loss' ? '❌' : '⏳';
  const aDir = s.analystDirection === 'bullish' ? '看涨' : s.analystDirection === 'bearish' ? '看跌' : '观望';
  const aRes = s.analystVerifyResult === 'win' ? '✅' : s.analystVerifyResult === 'loss' ? '❌' : '⏳';
  const state = s.marketState || '不明';

  const payload = s.structuredPayload || extractBinaryFeaturePayload(s.klineText || '');
  const lsPhase = payload && payload.layered_score && payload.layered_score.phase;
  const phaseLabel = lsPhase ? (lsPhase.phase || '无') + (lsPhase.suppress ? '[suppress]' : '') : '无';
  const featurePool = (payload && payload.feature_pool) || {};
  const f5m  = featurePool['5m']  || {};
  const f15m = featurePool['15m'] || {};
  const adx5m    = f5m.adx  != null ? (+f5m.adx).toFixed(1)  : '—';
  const rsi5m    = f5m.rsi  != null ? (+f5m.rsi).toFixed(1)  : '—';
  const rsi15m   = f15m.rsi != null ? (+f15m.rsi).toFixed(1) : '—';
  const bias5m   = f5m.trendBias || '—';

  const analystCore = (function() {
    if (!s.analystResult) return '—';
    const mc = s.analystResult.match(/【核心理由[^】]*】([^\n]{1,80})/);
    return mc ? mc[1].trim().slice(0, 50) : s.analystResult.slice(0, 50);
  })();

  const criticRisk = (function() {
    if (!s.criticResult) return '—';
    const mc = s.criticResult.match(/【最大隐患[^】]*】([^\n]{1,60})/);
    const lvl = s.criticRiskLevel || s.criticStrength || '';
    return (lvl ? '[' + lvl + '] ' : '') + (mc ? mc[1].trim().slice(0, 40) : '—');
  })();

  const judgeConf = (function() {
    if (!s.result) return '—';
    const mc = s.result.match(/【置信度[^】]*】\s*(\d+)/);
    return mc ? mc[1] + '%' : '—';
  })();

  const gateNote = s.judgeClamped ? '[clamp:' + s.judgeOriginalConf + '%→' + s.judgeHardCap + '%]' : '';

  let postLine = '事后走势：无数据（未到期或缺少时间戳）';
  if (s.dataTimestamp && s.interval && s.symbol && (s.verifyResult === 'win' || s.verifyResult === 'loss')) {
    const postK = await fetchPostKlines(s.symbol, s.interval, s.dataTimestamp, 16);
    if (postK && postK.length >= 2) {
      const entryOpen = postK[0].o;
      const moves = [];
      [4, 9, 14].forEach(function(ci) {
        if (postK[ci]) {
          const pct = ((postK[ci].c - entryOpen) / entryOpen * 100).toFixed(3);
          moves.push((ci + 1) + '棒:' + (pct > 0 ? '+' : '') + pct + '%');
        }
      });
      const maxH = Math.max.apply(null, postK.map(function(k) { return k.h; }));
      const minL = Math.min.apply(null, postK.map(function(k) { return k.l; }));
      const maxUp   = ((maxH - entryOpen) / entryOpen * 100).toFixed(3);
      const maxDown = ((minL - entryOpen) / entryOpen * 100).toFixed(3);
      const lastC   = postK[postK.length - 1].c;
      const actualDir = lastC > entryOpen ? 'bullish' : 'bearish';
      const judgeMatch   = s.direction        === actualDir ? '裁判✓' : '裁判✗';
      const analystMatch = s.analystDirection === actualDir ? '分析师✓' : '分析师✗';
      postLine = '事后' + postK.length + '棒：' + moves.join(' | ')
        + ' | 区间[+' + maxUp + '% / ' + maxDown + '%]'
        + ' → ' + judgeMatch + ' ' + analystMatch;
    }
  }

  return (idx + 1) + '. [' + (s.time || '') + '] 市场:' + state
    + ' | phase:' + phaseLabel
    + ' | 5M(ADX=' + adx5m + ' RSI=' + rsi5m + ' bias=' + bias5m + ')'
    + ' | 15M(RSI=' + rsi15m + ')\n'
    + '   分析师:' + aDir + aRes + ' 核心:' + analystCore + '\n'
    + '   质疑师:' + criticRisk + '\n'
    + '   裁判:' + jDir + jRes + ' conf:' + judgeConf + gateNote + '\n'
    + '   ' + postLine + '\n';
}
// ── v3.1 元裁判：触发检查 ────────────────────────────────────────
// 每当验证计数增加，检查是否达到 META_JUDGE_EVERY 的水位线
// 用 metaJudgeCompressedAt 水位线（类似 biasCompressedAt）防止重复触发
async function checkMetaJudgeTrigger(sessions, tabId) {
  if (_metaJudgeRunning) return; // 已在运行，跳过
  const verifiedCount = sessions.filter(s =>
    s.verifyResult === 'win' || s.verifyResult === 'loss'
  ).length;
  const stored = await chrome.storage.local.get(['metaJudgeReport', 'metaJudgePendingAt']);
  const lastReport = stored.metaJudgeReport || null;
  const lastAt = lastReport ? (lastReport.verifiedAt || 0) : 0;
  const pendingAt = typeof stored.metaJudgePendingAt === 'number' ? stored.metaJudgePendingAt : 0;
  if (verifiedCount < META_JUDGE_EVERY) return; // 样本不足
  if (verifiedCount < lastAt + META_JUDGE_EVERY) return; // 未到下一个水位
  if (pendingAt >= verifiedCount) return; // 这一水位已挂起待执行，防止重复触发
  BgLog.info('[元裁判] 触发审计', 'verifiedCount=' + verifiedCount + ' lastAt=' + lastAt + ' pendingAt=' + pendingAt);
  await chrome.storage.local.set({ metaJudgePendingAt: verifiedCount });
  // 如果有 tabId 直接执行；没有 tabId 也创建 alarm，等回调里自动查找页面执行
  if (tabId) {
    handleMetaJudge(tabId).catch(e => logSafe('[checkMetaJudge:direct]', e));
  }
  chrome.alarms.create(META_JUDGE_ALARM, { delayInMinutes: 0.05 }); // ~3s 后兜底触发
}

// ── v3.1 元裁判：核心执行函数 ────────────────────────────────────
// 汇总近40条 session + 3段提示词 + 偏差记忆 + 条件胜率，调用 LLM 做深度审计
// 结果存入 metaJudgeReport，并通知 content.js 更新面板
async function handleMetaJudge(tabId) {
  if (_metaJudgeRunning) {
    BgLog.info('[元裁判] 已在运行，跳过重复触发', 'tabId=' + (tabId || 'null'));
    return;
  }
  _metaJudgeRunning = true;
  await chrome.storage.local.set({ metaJudgeRunning: true });
  BgLog.info('[元裁判] 开始执行', 'tabId=' + (tabId || 'null'));
  notifyMetaJudgeTabs(tabId, { type: 'META_JUDGE_START' });

  // 兜底看门狗——若 SW 在审计途中被系统回收，finally 不会执行，
  // 180s 后强制清除标志（对应新的 150s 超时：3次重试最坏约 460s，但正常1次150s内完成）
  let _mjWatchdog = setTimeout(async function() {
    if (_metaJudgeRunning) {
      BgLog.warn('[元裁判] 看门狗超时，强制清除运行标志', 'tabId=' + (tabId || 'null'));
      _metaJudgeRunning = false;
      chrome.storage.local.set({ metaJudgeRunning: false, metaJudgePendingAt: 0 }).catch(function() {});
      notifyMetaJudgeTabs(tabId, { type: 'META_JUDGE_ERROR', error: '元裁判看门狗超时，已强制恢复主流程' });
    }
  }, 180000);

  try {
    const stored = await chrome.storage.local.get([
      'autoSessions', 'agentModels', 'agentPrompts', 'historianPrompt',
      'metaJudgeModelIdx', 'background'
    ]);
    const autoSessions = stored.autoSessions || [];
    const agentModelIdxs = stored.agentModels || [0, 0, 0];
    const agentPromptsCfg = stored.agentPrompts || [];
    const bg = stored.background ? '【交易背景】' + stored.background + '\n\n' : '';

    const _mjModelIdx = (typeof stored.metaJudgeModelIdx === 'number')
      ? stored.metaJudgeModelIdx
      : Math.max(0, agentModelIdxs[2]);
    const judgeModel = await getModelConfig(_mjModelIdx, 'meta_judge');

    // 近40条已验证 session
    // Fix P2: 过滤掉裁判方向=观望(neutral)的 session——这类 session verifyResult 不会有 win/loss，
    // 混入后会在 buildSessionAuditLine 显示「裁判:观望⏳」，干扰 LLM 对裁判胜率的判断
    const verified = autoSessions.filter(function(s) {
      const judgeVerified = (s.verifyResult === 'win' || s.verifyResult === 'loss') && s.direction && s.direction !== 'neutral';
      const analystVerified = (s.analystVerifyResult === 'win' || s.analystVerifyResult === 'loss') && s.analystDirection && s.analystDirection !== 'neutral';
      return judgeVerified || analystVerified;
    }).slice(0, 40);

    if (verified.length < 10) {
      BgLog.info('[元裁判] 样本不足10条，跳过', 'n=' + verified.length);
      notifyMetaJudgeTabs(tabId, { type: 'META_JUDGE_ERROR', error: '样本不足10条，已跳过本次审计' });
      return;
    }

    // ── v3.12.4 核心升级：并发拉取事后 K 线，构建完整对照摘要 ──
    notifyMetaJudgeTabs(tabId, { type: 'META_JUDGE_PROGRESS', step: '正在拉取事后走势数据（Binance API）…' });

    // 最多并发20条（原12条，提升后更多记录有真实K线，分析质量更高）
    const enrichLimit = 20;
    const auditLines = [];
    for (let i = 0; i < verified.length; i++) {
      if (i < enrichLimit) {
        try {
          auditLines.push(await buildSessionAuditLine(verified[i], i));
        } catch(e) {
          // 拉取失败时回退到纯文字摘要
          const s = verified[i];
          const jDir = s.direction === 'bullish' ? '看涨' : s.direction === 'bearish' ? '看跌' : '观望';
          const jRes = s.verifyResult === 'win' ? '✅' : s.verifyResult === 'loss' ? '❌' : '⏳';
          auditLines.push((i + 1) + '. [' + (s.time || '') + '] 市场:' + (s.marketState || '不明')
            + ' | 裁判:' + jDir + jRes + ' (K线拉取失败)\n');
        }
      } else {
        // 超出并发限制，只做文字摘要
        const s = verified[i];
        const jDir = s.direction === 'bullish' ? '看涨' : s.direction === 'bearish' ? '看跌' : '观望';
        const jRes = s.verifyResult === 'win' ? '✅' : s.verifyResult === 'loss' ? '❌' : '⏳';
        const summary = extractSignalSummary(s.result || '') || '（无摘要）';
        auditLines.push((i + 1) + '. [' + (s.time || '') + '] 市场:' + (s.marketState || '不明')
          + ' | 裁判:' + jDir + jRes + ' | ' + summary + '\n');
      }
    }
    const sessionsText = auditLines.join('');

    // ── 整体胜率统计 ──
    const judgeVerified   = verified.filter(function(s) { return s.verifyResult === 'win' || s.verifyResult === 'loss'; });
    const judgeWins       = judgeVerified.filter(function(s) { return s.verifyResult === 'win'; }).length;
    const analystVerified = verified.filter(function(s) { return s.analystVerifyResult === 'win' || s.analystVerifyResult === 'loss'; });
    const analystWins     = analystVerified.filter(function(s) { return s.analystVerifyResult === 'win'; }).length;
    const condWR    = calcConditionalWinRate(verified, 'direction', 'verifyResult');
    let condWRText  = '';
    for (const [state, v] of Object.entries(condWR)) {
      condWRText += state + ':' + v.wins + '/' + v.total + '(' + v.pct + '%) ';
    }

    // ── suppress 误杀率专项统计 ──
    const suppressSessions = verified.filter(function(s) {
      const payload = s.structuredPayload || extractBinaryFeaturePayload(s.klineText || '');
      const phase = payload && payload.layered_score && payload.layered_score.phase;
      return phase && phase.suppress === true;
    });
    let suppressText = '';
    if (suppressSessions.length >= 2) {
      const supVerified = suppressSessions.filter(function(s) { return s.verifyResult === 'win' || s.verifyResult === 'loss'; });
      const supWins = supVerified.filter(function(s) { return s.verifyResult === 'win'; }).length;
      suppressText = '\nsuppress=true 场景：' + supWins + '/' + supVerified.length
        + (supVerified.length ? '（' + Math.round(supWins / supVerified.length * 100) + '%）' : '')
        + '  ← suppress 触发时系统观望，若实际胜率偏高说明 suppress 误杀顺势信号';
    }

    // ── 质疑师风险评级准确性 ──
    const criticFeedback = buildCriticFeedbackSection(verified);

    // ── 分析师vs裁判方向背离统计 ──
    const diverge = verified.filter(function(s) {
      return s.direction && s.analystDirection
        && s.direction !== 'neutral' && s.analystDirection !== 'neutral'
        && s.direction !== s.analystDirection;
    });
    let divergeText = '';
    if (diverge.length >= 2) {
      const judgeWinsWhenDiverge   = diverge.filter(function(s) { return s.verifyResult === 'win'; }).length;
      const analystWinsWhenDiverge = diverge.filter(function(s) { return s.analystVerifyResult === 'win'; }).length;
      divergeText = '\n分析师vs裁判方向背离：' + diverge.length + '次'
        + ' | 背离时裁判胜率:' + judgeWinsWhenDiverge + '/' + diverge.length
        + ' | 背离时分析师胜率:' + analystWinsWhenDiverge + '/' + diverge.length;
    }

    // ── Fix P1：realPnl 幅度感知统计 ──
    // 二元期权 win/loss 是二元的，但 +0.01% 的 win 与 +2% 的 win 信息量完全不同
    // 把平均盈亏幅度传给元裁判，让其区分"噪音级胜利"和"有效方向判断"
    let pnlText = '';
    const pnlSessions = judgeVerified.filter(function(s) { return s.realPnl != null; });
    if (pnlSessions.length >= 3) {
      const pnlWins  = pnlSessions.filter(function(s) { return s.realPnl > 0; });
      const pnlLoss  = pnlSessions.filter(function(s) { return s.realPnl <= 0; });
      const avgWin   = pnlWins.length  ? (pnlWins.reduce(function(a, b) { return a + b.realPnl; }, 0)  / pnlWins.length  * 100).toFixed(3) : null;
      const avgLoss  = pnlLoss.length  ? (pnlLoss.reduce(function(a, b) { return a + b.realPnl; }, 0) / pnlLoss.length * 100).toFixed(3) : null;
      const cumPnl   = (pnlSessions.reduce(function(a, b) { return a + b.realPnl; }, 0) * 100).toFixed(3);
      pnlText = '\n幅度统计（裁判近' + pnlSessions.length + '次）：'
        + (avgWin  != null ? '平均盈利+' + avgWin  + '%' : '')
        + (avgLoss != null ? ' / 平均亏损' + avgLoss + '%' : '')
        + ' / 累计' + cumPnl + '%'
        + '  ← 幅度接近0的win/loss更可能是噪音，请在分析时加权考虑';
    }

    // ── Fix P2：phase × ADX 二维条件胜率预计算 ──
    // LLM被要求分析phase/ADX组合但原来只有marketState分桶，现补充更细粒度的预计算统计
    let phaseAdxText = '';
    (function() {
      const phaseGroups = {};
      judgeVerified.forEach(function(s) {
        const payload = s.structuredPayload || extractBinaryFeaturePayload(s.klineText || '');
        const lsPhase = payload && payload.layered_score && payload.layered_score.phase;
        const featurePool = (payload && payload.feature_pool) || {};
        const f5m = featurePool['5m'] || {};
        const phaseLabel = lsPhase ? (lsPhase.phase || '无') + (lsPhase.suppress ? '[suppress]' : '') : '无';
        const adxVal = f5m.adx != null ? +f5m.adx : null;
        const adxBucket = adxVal == null ? 'ADX不明'
          : adxVal < 20 ? 'ADX<20(弱)'
          : adxVal < 30 ? 'ADX20-30(中)'
          : 'ADX≥30(强)';
        const key = phaseLabel + ' | ' + adxBucket;
        if (!phaseGroups[key]) phaseGroups[key] = { wins: 0, total: 0 };
        phaseGroups[key].total++;
        if (s.verifyResult === 'win') phaseGroups[key].wins++;
      });
      const lines = Object.entries(phaseGroups)
        .filter(function(e) { return e[1].total >= 2; })
        .sort(function(a, b) {
          return (a[1].wins / a[1].total) - (b[1].wins / b[1].total); // 胜率从低到高
        })
        .map(function(e) {
          const pct = Math.round(e[1].wins / e[1].total * 100);
          return e[0] + ':' + e[1].wins + '/' + e[1].total + '(' + pct + '%)';
        });
      if (lines.length >= 2) {
        phaseAdxText = '\nphase×ADX条件胜率（裁判，低→高排序）：\n' + lines.join('\n');
      }
    })();

    // ── 提示词摘要 ──
    const analystPromptSnip = ((agentPromptsCfg[0] || DEFAULT_ANALYST_PROMPT) + '').slice(0, 100);
    const criticPromptSnip  = ((agentPromptsCfg[1] || DEFAULT_CRITIC_PROMPT)  + '').slice(0, 100);
    const judgePromptSnip   = ((agentPromptsCfg[2] || DEFAULT_JUDGE_PROMPT)   + '').slice(0, 100);

    notifyMetaJudgeTabs(tabId, { type: 'META_JUDGE_PROGRESS', step: '正在构建审计上下文…' });

    const metaPrompt = bg +
      '[角色] 你是元裁判（Meta-Judge），基于三类数据做深度审计：\n' +
      '  ① Binance 事后真实K线（入场后16棒走势，非Agent自述）\n' +
      '  ② 每条 session 的完整 Agent 输出链（分析师→质疑师→裁判）\n' +
      '  ③ 入场时结构化特征（phase/ADX/RSI/trendBias 等）\n' +
      '你的核心职责：找出「预测方向与实际走势不一致」的系统性规律，给出硬性可执行结论。\n\n' +
      '【整体胜率】\n' +
      '裁判：' + judgeWins + '/' + judgeVerified.length +
        (judgeVerified.length ? '（' + Math.round(judgeWins / judgeVerified.length * 100) + '%）' : '') + '\n' +
      '分析师：' + analystWins + '/' + analystVerified.length +
        (analystVerified.length ? '（' + Math.round(analystWins / analystVerified.length * 100) + '%）' : '') + '\n' +
      (condWRText ? '条件胜率：' + condWRText : '') +
      suppressText + divergeText + pnlText + phaseAdxText + criticFeedback + '\n\n' +
      '【近' + verified.length + '条已验证记录（事后走势对照，由新到旧）】\n' +
      '说明：前' + Math.min(enrichLimit, verified.length) + '条已拉取Binance真实K线（含事后N棒走势+区间涨跌幅+方向对照），✓=方向正确 ✗=方向错误；第' + (Math.min(enrichLimit, verified.length) + 1) + '条起为文字摘要（无K线数据），请降低权重\n' +
      sessionsText +
      '\n【当前提示词摘要（前100字）】\n' +
      '分析师：' + analystPromptSnip + '…\n' +
      '质疑师：' + criticPromptSnip + '…\n' +
      '裁判：'   + judgePromptSnip  + '…\n\n' +
      '[审计任务] 基于事后真实走势，按以下6个维度输出审计报告，每项不超过3句话，总字数≤500字：\n' +
      '【维度1：方向判断准确率分析】哪类结构（phase/marketState/ADX范围）下方向✗最集中？列出最差的2个组合及错误率。\n' +
      '【维度2：suppress 误杀评估】suppress=true 时系统强制观望，事后走势显示有多少比例是顺势行情被误杀？应调整为软压制还是保持硬否决？\n' +
      '【维度3：分析师vs裁判背离价值】背离时谁更准？质疑师对最终方向的影响是正向还是负向？\n' +
      '【维度4：亏损 session 共性特征】连续亏损的 session 在 phase/trendBias/ADX 上有何共性？这类场景应直接观望。\n' +
      '【维度5：提示词优化建议】基于实际走势数据，三段提示词各有哪一处最需要调整？\n' +
      '【维度6：下一步行动建议】最高优先级的1-2条具体可执行改进建议（必须含量化目标和修改位置）。\n\n' +
      '[输出格式] 先严格按6个【维度X】标题输出，然后追加以下两个机读块（必须完整输出）：\n\n' +
      'PROMPT_SUGGESTIONS_START\n' +
      'ANALYST: （分析师提示词末尾追加的一句话，≤40字；若无需修改填"无"）\n' +
      'CRITIC: （质疑师提示词末尾追加的一句话，≤40字；若无需修改填"无"）\n' +
      'JUDGE: （裁判提示词末尾追加的一句话，≤40字；若无需修改填"无"）\n' +
      'PROMPT_SUGGESTIONS_END\n\n' +
      'THRESHOLD_SUGGESTIONS_START\n' +
      'SUPPRESS_ACTION: （三选一：soft_cap_58=改为下调置信度上限至58% / hard_block=保持完全拒绝 / keep=维持现状）\n' +
      'CONFIDENCE_GATE: （建议将 applyDecisionProfileGate 门槛改为多少%，当前为58，填数字）\n' +
      'TREND_ENTRY_CONDITION: （一条可补充进分析师提示词的趋势入场条件，≤30字；若无填"无"）\n' +
      'THRESHOLD_SUGGESTIONS_END';

    notifyMetaJudgeTabs(tabId, { type: 'META_JUDGE_PROGRESS', step: '元裁判审计中（约30-60秒）…' });

    BgLog.info('[元裁判] 即将调用模型', 'model=' + (judgeModel.model || '?') + ' tabId=' + (tabId || 'null') + ' basedOn=' + verified.length);
    const result = await callAPIWithRetry(
      judgeModel.key, judgeModel.base, judgeModel.model,
      [{ role: 'user', content: metaPrompt }],
      judgeModel.apiFormat, tabId, 'meta_judge', 2500
    );

    if (!result || result.length < 20) {
      throw new Error('元裁判返回内容为空');
    }

    const report = {
      content: result,
      createdAt: new Date().toLocaleString('zh-CN'),
      verifiedAt: autoSessions.filter(function(s) {
        return s.verifyResult === 'win' || s.verifyResult === 'loss';
      }).length,
      basedOn: verified.length
    };
    await chrome.storage.local.set({ metaJudgeReport: report });
    BgLog.info('[元裁判] 审计报告已生成', 'basedOn=' + verified.length);
    notifyMetaJudgeTabs(tabId, { type: 'META_JUDGE_DONE', report: report });
  } catch (e) {
    logSafe('[handleMetaJudge]', e);
    notifyMetaJudgeTabs(tabId, { type: 'META_JUDGE_ERROR', error: e && (e.message || String(e)) });
  } finally {
    clearTimeout(_mjWatchdog);
    _metaJudgeRunning = false;
    chrome.storage.local.set({ metaJudgeRunning: false, metaJudgePendingAt: 0 }).catch(function() {});
  }
}