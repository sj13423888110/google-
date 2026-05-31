// ════════════════════════════════════════════════════════════════
//  winrate-calc.js — 胜率统计纯函数模块
//
//  在 background.js（service worker）和 content.js 中共用同一份实现，
//  避免两边各自维护后逻辑漂移导致前后端胜率显示对不上。
//
//  · background.js 顶部用 importScripts('./winrate-calc.js') 加载
//  · manifest.json 的 content_scripts.js 把本文件排在 content.js 之前
//  · 三个 API 全部为纯函数，无副作用，无依赖
// ════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  // 计算最近 windowSize 条已验证记录的胜率
  // sessions: 自动分析 session 数组（按时间倒序，最新在前）
  // dirKey/resultKey: 'direction'+'verifyResult' 或 'analystDirection'+'analystVerifyResult'
  // 返回 { wins, total, pct, n } 或 null（无可统计样本）
  function calcWinRate(sessions, dirKey, resultKey, windowSize) {
    if (!Array.isArray(sessions)) return null;
    const counted = sessions
      .filter(s => s && s[dirKey] && s[dirKey] !== 'neutral' && s[resultKey])
      .slice(0, windowSize);
    if (!counted.length) return null;
    const wins  = counted.filter(s => s[resultKey] === 'win').length;
    const total = counted.length;
    return { wins, total, pct: Math.round(wins / total * 100), n: total };
  }

  // 按建议期限拆分胜率，返回字符串如 "5M 30%(3/10) · 10M 60%(6/10)"
  // 期限根据 verifyAt - dataTimestamp 折算并对齐到固定枚举（3/5/10/15/30/60/240/1440 分钟）
  function calcWinRateByLimit(sessions, dirKey, resultKey, verifyAtKey) {
    if (!Array.isArray(sessions)) return null;
    const groups = {};
    for (const s of sessions) {
      if (!s || !s[dirKey] || s[dirKey] === 'neutral') continue;
      if (!s[resultKey]) continue;
      const vAt = s[verifyAtKey] || s.verifyAt;
      const dTs = s.dataTimestamp || parseInt(s.id) || 0;
      if (!vAt || !dTs) continue;
      const mins = Math.round((vAt - dTs) / 60000);
      if (mins <= 0 || mins > 2880) continue;
      // 对齐到固定枚举，防止 59M/60M 碎片化
      // v3.0: 恢复 5M 桶，支持 5/10/15/30M 二元期权统计
      const bMin = mins <= 7 ? 5 : mins <= 12 ? 10 : mins <= 20 ? 15 :
                   mins <= 45 ? 30 : mins <= 90 ? 60 : mins <= 300 ? 240 : 1440;
      const key = bMin < 60 ? bMin + 'M' : bMin === 60 ? '1H' : bMin === 240 ? '4H' : '1D';
      if (!groups[key]) groups[key] = { wins: 0, total: 0, mins };
      groups[key].total++;
      if (s[resultKey] === 'win') groups[key].wins++;
    }
    const keys = Object.keys(groups).sort((a, b) => groups[a].mins - groups[b].mins);
    if (!keys.length) return null;
    return keys.map(k => {
      const g = groups[k];
      const pct = Math.round(g.wins / g.total * 100);
      return k + ' ' + pct + '%(' + g.wins + '/' + g.total + ')';
    }).join(' · ');
  }

  // 按市场状态分组的条件胜率
  // 返回 { '趋势': {wins,total,pct}, '震荡': {wins,total,pct}, '不明': {wins,total,pct} }
  // 没有样本的状态不会出现在结果里
  function calcConditionalWinRate(sessions, dirKey, resultKey) {
    if (!Array.isArray(sessions)) return {};
    const groups = { '趋势': { wins: 0, total: 0 }, '震荡': { wins: 0, total: 0 }, '不明': { wins: 0, total: 0 } };
    for (const s of sessions) {
      if (!s || !s[dirKey] || s[dirKey] === 'neutral') continue;
      if (!s[resultKey]) continue;
      const state = s.marketState || '不明';
      const key = groups[state] ? state : '不明';
      groups[key].total++;
      if (s[resultKey] === 'win') groups[key].wins++;
    }
    const result = {};
    for (const [k, v] of Object.entries(groups)) {
      if (v.total > 0) result[k] = { wins: v.wins, total: v.total, pct: Math.round(v.wins / v.total * 100) };
    }
    return result;
  }

  global.WinRateCalc = {
    calcWinRate: calcWinRate,
    calcWinRateByLimit: calcWinRateByLimit,
    calcConditionalWinRate: calcConditionalWinRate
  };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
