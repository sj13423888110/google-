// ════════════════════════════════════════════════════════════════
//  storage-keys.js — chrome.storage.local 命名空间统一前缀
//
//  修复：兼容不同 Chrome 扩展上下文中 storage API 既可能返回 Promise，
//       也可能返回 undefined（依赖 callback 形式）的差异，避免补丁后
//       `orig.get(...).then(...)` 在 content script 里同步抛错。
// ════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  const PREFIX = 'tvc2:';

  const KNOWN_KEYS = new Set([
    'models', 'defaultModel', 'lastModelIdx',
    'background', 'defaultPrompt', 'autoPrompt', 'autoPromptTemp',
    'agentModels', 'agentPrompts',
    'historianModel', 'historianPrompt',
    'enhancements', 'derivedThreshold',
    'sessions', 'autoSessions', 'autoTempSessions', 'autoResult',
    'biasMemory',
    'biasMemoryAnalyst', 'biasMemoryJudge', 'biasCompressedAt',
    'agentMaxTokens', 'promptDefaultsVersion',
    'metaJudgeReport', 'metaJudgeRunning', 'metaJudgeModelIdx', 'metaJudgeReports'
  ]);

  const KNOWN_PREFIXES = ['abExperiment_', 'abStats_'];

  function shouldNamespace(key) {
    if (typeof key !== 'string') return false;
    if (key.startsWith(PREFIX)) return false;
    if (KNOWN_KEYS.has(key)) return true;
    return KNOWN_PREFIXES.some(function (p) { return key.startsWith(p); });
  }

  function applyKey(k) {
    return shouldNamespace(k) ? PREFIX + k : k;
  }

  function applyToInput(input) {
    if (input == null) return input;
    if (typeof input === 'string') return applyKey(input);
    if (Array.isArray(input)) return input.map(applyKey);
    if (typeof input === 'object') {
      const out = {};
      for (const k of Object.keys(input)) out[applyKey(k)] = input[k];
      return out;
    }
    return input;
  }

  function stripPrefix(obj) {
    if (!obj || typeof obj !== 'object') return obj || {};
    const out = {};
    for (const k of Object.keys(obj)) {
      out[k.startsWith(PREFIX) ? k.slice(PREFIX.length) : k] = obj[k];
    }
    return out;
  }

  function patchStorage() {
    if (global.__tvcStoragePatched) return;
    if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) return;

    const local = chrome.storage.local;
    global.__tvcStorageOrig = {
      get: local.get.bind(local),
      set: local.set.bind(local),
      remove: local.remove.bind(local),
      clear: local.clear.bind(local)
    };

    const orig = global.__tvcStorageOrig;

    local.get = function (keys, callback) {
      const newKeys = applyToInput(keys);
      if (typeof callback === 'function') {
        orig.get(newKeys, function (result) { callback(stripPrefix(result)); });
        return;
      }
      const ret = orig.get(newKeys);
      if (ret && typeof ret.then === 'function') return ret.then(stripPrefix);
      // 某些环境若未返回 Promise，则退回原始返回值；由调用方的安全包装兜底
      return ret;
    };

    local.set = function (items, callback) {
      const newItems = applyToInput(items);
      if (typeof callback === 'function') {
        orig.set(newItems, callback);
        return;
      }
      return orig.set(newItems);
    };

    local.remove = function (keys, callback) {
      const newKeys = applyToInput(keys);
      if (typeof callback === 'function') {
        orig.remove(newKeys, callback);
        return;
      }
      return orig.remove(newKeys);
    };

    global.__tvcStoragePatched = true;
  }

  async function migrateLegacyKeys() {
    if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) {
      return { migrated: [], skipped: [], error: 'no chrome.storage' };
    }
    const orig = global.__tvcStorageOrig || {
      get: chrome.storage.local.get.bind(chrome.storage.local),
      set: chrome.storage.local.set.bind(chrome.storage.local),
      remove: chrome.storage.local.remove.bind(chrome.storage.local)
    };

    const all = await orig.get(null);
    const migrated = [];
    const skipped = [];
    const updates = {};
    const removals = [];

    for (const k of Object.keys(all)) {
      if (k.startsWith(PREFIX)) continue;
      if (!shouldNamespace(k)) continue;
      const newKey = PREFIX + k;
      if (all[newKey] !== undefined) {
        skipped.push(k);
        continue;
      }
      updates[newKey] = all[k];
      removals.push(k);
      migrated.push(k);
    }

    if (Object.keys(updates).length) {
      await orig.set(updates);
      await orig.remove(removals);
    }

    return { migrated, skipped };
  }

  global.StorageNS = {
    PREFIX: PREFIX,
    KNOWN_KEYS: KNOWN_KEYS,
    KNOWN_PREFIXES: KNOWN_PREFIXES,
    patchStorage: patchStorage,
    migrateLegacyKeys: migrateLegacyKeys,
    shouldNamespace: shouldNamespace,
    _internal: { applyToInput: applyToInput, stripPrefix: stripPrefix }
  };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
