// v2.2 改动：所有默认提示词统一从 background.js 通过 GET_DEFAULTS 拉取，
// popup.js 不再硬编码任何默认值，避免两地维护不一致。

const DEFAULT_AUTO_PROMPT_TEXT = '';

// storage 命名空间补丁（必须在任何 chrome.storage.local.* 调用之前执行）
if (self.StorageNS && typeof self.StorageNS.patchStorage === 'function') {
  self.StorageNS.patchStorage();
}

// v2.6: 流式连接测试 —— 跟真实 Agent 调用同样的路径（stream:true + SSE 解析）
// 测试成功 ≈ Agent 一定能用；旧版 stream:false 测试通过不代表流式可用，是常见坑。
// 返回 { ok: bool, msg: string, level: 'ok'|'warn'|'err' }
async function _streamTest(key, base, model, apiFormat) {
  const isAnthropicFmt = apiFormat === 'anthropic'
    || (base || '').includes('anthropic.com')
    || (base || '').includes('apikey.fun');
  const baseClean = (base || '').replace(/\/+$/, '');
  const endpoint = isAnthropicFmt
    ? baseClean + (baseClean.endsWith('/v1') ? '/messages' : '/v1/messages')
    : baseClean + (baseClean.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropicFmt) {
    headers['anthropic-version'] = '2023-06-01';
    headers['x-api-key'] = key;
  } else {
    headers['Authorization'] = 'Bearer ' + key;
  }
  const bodyObj = { model, max_tokens: 300, stream: true, messages: [{ role: 'user', content: 'hi' }] };
  if (isAnthropicFmt) {
    // 显式禁用思考模式：部分代理对新版 Claude 模型会自动开启 extended thinking，
    // 思考 token 会把 max_tokens 配额全部耗尽，导致正文一个字也输不出来。
    // Anthropic API 原生默认关闭思考，此处为保险起见显式注明。
    bodyObj.thinking = { type: 'disabled' };
  } else {
    bodyObj.enable_thinking = false; // 跟 background.js 真实调用对齐
  }
  const body = JSON.stringify(bodyObj);

  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
  } catch(e) {
    return { ok: false, level: 'err', msg: '网络失败：' + (e.message || String(e)).slice(0, 80) };
  }
  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch(_) {}
    try {
      const j = JSON.parse(errText);
      errText = (j.error && j.error.message) || j.message || errText;
    } catch(_) {}
    return { ok: false, level: 'err', msg: 'HTTP ' + res.status + '：' + String(errText).slice(0, 100) };
  }
  if (!res.body) {
    return { ok: false, level: 'err', msg: '响应无 body（代理可能不支持流式）' };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sawAnyEvent = false;
  let sawText = false;
  let buffer = '';
  const start = Date.now();
  try {
    while (Date.now() - start < 12000) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('data:')) sawAnyEvent = true;
      // 检测是否抓到任何文本 —— 覆盖主流 SSE 格式：
      // · Anthropic:  "text_delta" / content_block_start.text
      // · OpenAI:     choices[].delta.content / choices[].message.content
      // · Gemini:     candidates[].content.parts[].text
      // · Ollama:     message.content (非 choices 路径)
      if (/(\"text_delta\"|\"text\"\s*:\s*\"[^\"]|\"delta\"\s*:\s*\{[^}]*\"content\"\s*:\s*\"[^\"]|\"content\"\s*:\s*\"[^\"]|\"parts\"\s*:\s*\[|\"message\"\s*:\s*\{[^}]*\"content\"\s*:\s*\"[^\"])/.test(buffer)) {
        sawText = true;
        break;
      }
    }
  } catch(e) {
    try { await reader.cancel(); } catch(_) {}
    return { ok: false, level: 'err', msg: '流式读取异常：' + (e.message || String(e)).slice(0, 80) };
  } finally {
    try { reader.cancel().catch(() => {}); } catch(_) {}
  }
  if (sawText) {
    return { ok: true, level: 'ok', msg: '流式连接 + 文本输出正常' };
  }
  if (sawAnyEvent) {
    return { ok: false, level: 'warn', msg: '收到流式事件但未提取到文本——Agent 可能跑不通（多半是 SSE 格式不兼容 / max_tokens 太小被思考耗光）' };
  }
  return { ok: false, level: 'err', msg: '流式无任何事件返回（代理不支持流式）' };
}

// 默认值在 load() 时动态填充，全部来自 background.js
let DEFAULT_AGENT_PROMPTS    = ['', '', ''];
let DEFAULT_HISTORIAN_PROMPT = '';
let DEFAULT_BACKGROUND_TEXT  = '';
let DEFAULT_PROMPT_TEXT      = '';
let _defaultsLoaded = false;

async function fetchDefaultPrompts() {
  if (_defaultsLoaded) return;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_DEFAULTS' });
    if (resp && resp.agentMaxTokens) { window.DEFAULT_AGENT_MAX_TOKENS_FALLBACK = resp.agentMaxTokens; }
    if (resp) {
      DEFAULT_AGENT_PROMPTS    = [resp.analystPrompt || '', resp.criticPrompt || '', resp.judgePrompt || ''];
      DEFAULT_HISTORIAN_PROMPT = resp.historianPrompt || '';
      DEFAULT_BACKGROUND_TEXT  = resp.background || '';
      DEFAULT_PROMPT_TEXT      = resp.defaultPrompt || '';
      _defaultsLoaded = true;
    }
  } catch(e) {
    // background.js 未就绪（SW 冷启动），禁用保存按钮防止空提示词被写入 storage
    console.warn('获取默认提示词失败，将在下次重试', e.message);
    const saveBtn = document.getElementById('save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.title = 'background.js 未就绪，请关闭后重新打开弹窗';
      saveBtn.textContent = '⚠️ 请重新打开设置';
    }
  }
}

let models = [];

const DEFAULT_MODEL = {
  name:      'claude',
  key:       'sk-a3bcefc7579be17ee1c62c49905c0218c2ecedcdadcb068041779768865b1854',
  base:      'https://api.apikey.fun',
  model:     'claude-sonnet-4-6',
  apiFormat: 'anthropic'
};

// DEFAULT_BACKGROUND_TEXT 已上移到 fetchDefaultPrompts 区块 (v2.2 改动)

// 模型变更后立即持久化（不等用户点"保存设置"）
// 注意：render 系列函数会重置 select.value，必须在 render 前读取或直接传入 idx
async function autoSaveModels(defaultModelIdx) {
  const defaultModel = defaultModelIdx !== undefined
    ? defaultModelIdx
    : (+document.getElementById('defaultModel').value || 0);
  await chrome.storage.local.set({ models, defaultModel });
}

function renderAgentModelSelects(agentModels, historianModelIdx) {
  [0, 1, 2].forEach(i => {
    const sel = document.getElementById('agentModel' + i);
    if (!sel) return;
    if (!models.length) { sel.innerHTML = '<option value="">— 请先添加模型 —</option>'; return; }
    const saved = agentModels ? agentModels[i] : undefined;
    const defaultIdx = i === 2 ? models.length - 1 : 0;
    const selectedIdx = saved !== undefined ? saved : defaultIdx;
    sel.innerHTML = models.map((m, idx) =>
      `<option value="${idx}" ${selectedIdx == idx ? 'selected' : ''}>${escHtml(m.name)} (${escHtml(m.model)})</option>`
    ).join('');
  });
  // 历史学家模型选择器（默认选最轻量/第一个模型）
  const hSel = document.getElementById('historianModel');
  if (hSel) {
    if (!models.length) { hSel.innerHTML = '<option value="">— 请先添加模型 —</option>'; return; }
    const savedH = historianModelIdx !== undefined ? historianModelIdx : 0;
    hSel.innerHTML = models.map((m, idx) =>
      `<option value="${idx}" ${savedH == idx ? 'selected' : ''}>${escHtml(m.name)} (${escHtml(m.model)})</option>`
    ).join('');
  }
}

// v3.2: 元裁判独立模型选择器渲染
function renderMetaJudgeModelSelect(metaJudgeModelIdx) {
  const mjSel = document.getElementById('metaJudgeModel');
  if (!mjSel) return;
  if (!models.length) { mjSel.innerHTML = '<option value="">— 请先添加模型 —</option>'; return; }
  // 默认选最后一个模型（通常是最强的）
  const defaultMJ = Math.max(0, models.length - 1);
  const savedMJ = (typeof metaJudgeModelIdx === 'number') ? metaJudgeModelIdx : defaultMJ;
  mjSel.innerHTML = models.map((m, idx) =>
    `<option value="${idx}" ${savedMJ == idx ? 'selected' : ''}>${escHtml(m.name)} (${escHtml(m.model)})</option>`
  ).join('');
}

// DEFAULT_HISTORIAN_PROMPT 已上移到 fetchDefaultPrompts 区块 (v2.2 改动)

async function load() {
  await fetchDefaultPrompts(); // 先从 background.js 拉取最新默认提示词
  const data = await chrome.storage.local.get(['models','defaultModel','background','defaultPrompt','autoPrompt','agentModels','agentPrompts','enhancements','historianModel','historianPrompt','agentMaxTokens','metaJudgeModelIdx']);
  models = data.models || [];
  if (!models.length) {
    models = [DEFAULT_MODEL];
    await chrome.storage.local.set({ models, defaultModel: 0 });
  }
  document.getElementById('background').value    = data.background    || DEFAULT_BACKGROUND_TEXT;
  document.getElementById('defaultPrompt').value = data.defaultPrompt || DEFAULT_PROMPT_TEXT;
  // 加载增强开关
  const enh = data.enhancements || {};
  // v3.1: selfCalib/errorPatterns/winRate3D 已废弃，不再读取
  // v3.9: oscillation 已删除，只保留 historian/symmetry
  ['historian','symmetry'].forEach(k => {
    const el = document.getElementById('enh-' + k);
    if (el) el.checked = enh[k] !== false;
  });
  // v3.6: 决策档位下拉菜单已删除
  // 加载历史学家提示词（优先使用用户已保存的值，没有时才用默认值）
  const hpEl = document.getElementById('historianPrompt');
  if (hpEl) hpEl.value = data.historianPrompt || DEFAULT_HISTORIAN_PROMPT;
  // 加载三个 agent 提示词（优先使用用户已保存的值，没有时才用默认值）
  const savedAgentPrompts = data.agentPrompts || [];
  [0, 1, 2].forEach(i => {
    document.getElementById('agentPrompt' + i).value = savedAgentPrompts[i] || DEFAULT_AGENT_PROMPTS[i];
  });
  // v2.7: 加载 Agent max_tokens 配置
  const _mtDefaults = (DEFAULT_AGENT_MAX_TOKENS_FALLBACK || { analyst: 3000, critic: 1500, judge: 2500, historian: 800 });
  const _mt = data.agentMaxTokens || {};
  const _setMT = (id, v, def) => { const el = document.getElementById(id); if (el) el.value = (typeof v === 'number' && v >= 200) ? v : def; };
  _setMT('maxTokHistorian', _mt.historian, _mtDefaults.historian);
  _setMT('maxTokAnalyst',   _mt.analyst,   _mtDefaults.analyst);
  _setMT('maxTokCritic',    _mt.critic,    _mtDefaults.critic);
  _setMT('maxTokJudge',     _mt.judge,     _mtDefaults.judge);
  renderModels();
  renderDefaultSelect(data.defaultModel);
  renderAgentModelSelects(data.agentModels, data.historianModel);
  renderMetaJudgeModelSelect(data.metaJudgeModelIdx);
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderModels() {
  const list = document.getElementById('modelList');
  if (!models.length) { list.innerHTML = '<div class="empty-tip">暂无模型，点击下方添加</div>'; renderDefaultSelect(); return; }
  list.innerHTML = models.map((m, i) => `
    <div class="model-item" id="mi-${i}">
      <div class="model-item-header">
        <span class="mi-name">${escHtml(m.name)}</span>
        <span class="mi-model">${escHtml(m.model)}</span>
        <div class="mi-actions">
          <button class="mi-test" data-i="${i}">测试</button>
          <button class="mi-edit" data-i="${i}">编辑</button>
          <button class="mi-del"  data-i="${i}">删除</button>
        </div>
      </div>
      <div class="model-edit-form" id="ef-${i}">
        <div><div class="ef-label">名称</div><input class="ef-name" value="${escHtml(m.name)}"></div>
        <div><div class="ef-label">API Key</div><input class="ef-key" type="password" value="${escHtml(m.key)}"></div>
        <div><div class="ef-label">Base URL</div><input class="ef-base" value="${escHtml(m.base)}"></div>
        <div><div class="ef-label">模型名</div><input class="ef-model" value="${escHtml(m.model)}"></div>
        <div>
          <div class="ef-label">API 格式</div>
          <div class="format-row">
            <label><input type="radio" name="fmt-${i}" value="anthropic" ${(m.apiFormat||'anthropic')==='anthropic'?'checked':''}> Anthropic</label>
            <label><input type="radio" name="fmt-${i}" value="openai" ${m.apiFormat==='openai'?'checked':''}> OpenAI 兼容</label>
          </div>
        </div>
        <div class="ef-btns">
          <button class="btn-save" data-i="${i}">保存</button>
          <button class="btn-cancel" data-i="${i}">取消</button>
        </div>
      </div>
    </div>`).join('');

  list.querySelectorAll('.mi-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = btn.dataset.i;
      const form = document.getElementById(`ef-${i}`);
      const isOpen = form.classList.contains('open');
      list.querySelectorAll('.model-edit-form').forEach(f => f.classList.remove('open'));
      if (!isOpen) form.classList.add('open');
    });
  });
  list.querySelectorAll('.btn-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = +btn.dataset.i;
      const form = document.getElementById(`ef-${i}`);
      models[i] = {
        name: form.querySelector('.ef-name').value.trim(),
        key:  form.querySelector('.ef-key').value.trim(),
        base: form.querySelector('.ef-base').value.trim().replace(/\/$/, ''),
        model: form.querySelector('.ef-model').value.trim(),
        apiFormat: form.querySelector(`input[name="fmt-${i}"]:checked`)?.value || 'anthropic'
      };
      const _curDef2 = +document.getElementById('defaultModel').value || 0;
      renderModels(); renderDefaultSelect();
      chrome.storage.local.get(['agentModels','historianModel','metaJudgeModelIdx']).then(d => { renderAgentModelSelects(d.agentModels, d.historianModel); renderMetaJudgeModelSelect(d.metaJudgeModelIdx); });
      autoSaveModels(_curDef2);
    });
  });
  list.querySelectorAll('.btn-cancel').forEach(btn => {
    btn.addEventListener('click', () => { document.getElementById(`ef-${btn.dataset.i}`).classList.remove('open'); });
  });
  list.querySelectorAll('.mi-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const delIdx = +btn.dataset.i;
      if (!confirm(`确认删除模型「${models[delIdx].name}」？`)) return;
      const _curDef3 = +document.getElementById('defaultModel').value || 0;
      models.splice(delIdx, 1);
      // v2.6 修复：同步修正 agentModels / historianModel 的索引
      //   ≥ 被删索引的 → 减 1（位置整体前移）
      //   == 被删索引的 → 重置为 0（指向第一个模型，相当于"默认"）
      //   仍越界（极端情况）→ 钳到 [0, models.length-1]
      const newDef = _curDef3 >= models.length ? Math.max(0, models.length - 1)
                    : _curDef3 > delIdx ? _curDef3 - 1
                    : _curDef3 === delIdx ? 0
                    : _curDef3;
      const stored = await chrome.storage.local.get(['agentModels','historianModel','metaJudgeModelIdx']);
      const fixIdx = (v) => {
        if (typeof v !== 'number') return 0;
        if (v === delIdx) return 0;             // 被删 → 重置
        if (v > delIdx)   return v - 1;          // 后面的整体前移
        return v;
      };
      const newAgentModels = Array.isArray(stored.agentModels)
        ? stored.agentModels.map(fixIdx).map(v => Math.min(Math.max(0, v), Math.max(0, models.length - 1)))
        : [0, 0, 0];
      const newHistorianModel = (typeof stored.historianModel === 'number')
        ? Math.min(Math.max(0, fixIdx(stored.historianModel)), Math.max(0, models.length - 1))
        : 0;
      const newMetaJudgeModelIdx = (typeof stored.metaJudgeModelIdx === 'number')
        ? Math.min(Math.max(0, fixIdx(stored.metaJudgeModelIdx)), Math.max(0, models.length - 1))
        : Math.max(0, models.length - 1);
      await chrome.storage.local.set({ agentModels: newAgentModels, historianModel: newHistorianModel, metaJudgeModelIdx: newMetaJudgeModelIdx });

      renderModels(); renderDefaultSelect();
      renderAgentModelSelects(newAgentModels, newHistorianModel);
      renderMetaJudgeModelSelect(newMetaJudgeModelIdx);
      autoSaveModels(newDef);
    });
  });
  list.querySelectorAll('.mi-test').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = +btn.dataset.i;
      const m = models[i];
      btn.textContent = '测试中…';
      btn.disabled = true;
      btn.style.color = '';
      try {
        // v2.6: 改用流式测试（与 Agent 真实调用同路径）
        const r = await _streamTest(m.key, m.base, m.model, m.apiFormat);
        if (r.ok) {
          btn.textContent = '测试';
          btn.style.color = '#4ade80';
          btn.title = '✅ ' + r.msg;
        } else {
          const errMsg = r.msg;
          btn.textContent = '测试';
          btn.style.color = r.level === 'warn' ? '#fbbf24' : '#f87171';
          btn.title = (r.level === 'warn' ? '⚠️ ' : '❌ ') + errMsg;
        }
      } catch(e) {
        btn.textContent = '测试';
        btn.style.color = '#f87171';
        btn.title = '❌ ' + (e.message || '网络超时').slice(0, 60);
      } finally {
        btn.disabled = false;
      }
    });
  });
  renderDefaultSelect();
}

function renderDefaultSelect(selected) {
  const sel = document.getElementById('defaultModel');
  if (!models.length) { sel.innerHTML = '<option value="">— 请先添加模型 —</option>'; return; }
  sel.innerHTML = models.map((m, i) =>
    `<option value="${i}" ${selected==i?'selected':''}>${escHtml(m.name)} (${escHtml(m.model)})</option>`
  ).join('');
}

document.getElementById('showAddForm').addEventListener('click', () => { document.getElementById('addForm').classList.toggle('open'); });
document.getElementById('cancelAdd').addEventListener('click', () => { document.getElementById('addForm').classList.remove('open'); });
// 测试连接功能
const _testAddBtn = document.getElementById('testAdd');
if (_testAddBtn) _testAddBtn.addEventListener('click', async () => {
  const key   = document.getElementById('newKey').value.trim();
  const base  = document.getElementById('newBase').value.trim().replace(/\/$/, '');
  const model = document.getElementById('newModel').value.trim();
  const fmt   = document.querySelector('input[name="newFormat"]:checked')?.value || 'anthropic';
  const resultEl = document.getElementById('testResult');

  if (!key || !base || !model) {
    resultEl.style.display = 'block';
    resultEl.style.background = '#2d1a1a';
    resultEl.style.color = '#f87171';
    resultEl.textContent = '⚠️ 请先填写 API Key、Base URL 和模型名';
    return;
  }

  const btn = document.getElementById('testAdd');
  btn.textContent = '测试中…'; btn.disabled = true;
  resultEl.style.display = 'none';

  try {
    // v2.6: 改用流式测试（与 Agent 真实调用同路径）
    const r = await _streamTest(key, base, model, fmt);
    if (r.ok) {
      resultEl.style.background = '#0f2a1a';
      resultEl.style.color = '#4ade80';
      resultEl.textContent = '✅ ' + r.msg + '（流式测试通过，Agent 可用）';
    } else if (r.level === 'warn') {
      resultEl.style.background = '#2d2a1a';
      resultEl.style.color = '#fbbf24';
      resultEl.textContent = '⚠️ ' + r.msg;
    } else {
      resultEl.style.background = '#2d1a1a';
      resultEl.style.color = '#f87171';
      resultEl.textContent = '❌ ' + r.msg;
    }
  } catch(e) {
    resultEl.style.background = '#2d1a1a';
    resultEl.style.color = '#f87171';
    resultEl.textContent = '❌ 连接失败: ' + (e.message || '网络超时').slice(0, 80);
  } finally {
    btn.textContent = '⚡ 测试连接';
    btn.disabled = false;
    resultEl.style.display = 'block';
  }
});

document.getElementById('confirmAdd').addEventListener('click', () => {
  const name  = document.getElementById('newName').value.trim();
  const key   = document.getElementById('newKey').value.trim();
  const base  = document.getElementById('newBase').value.trim().replace(/\/$/, '');
  const model = document.getElementById('newModel').value.trim();
  const fmt   = document.querySelector('input[name="newFormat"]:checked')?.value || 'anthropic';
  if (!name||!key||!base||!model) { alert('请填写所有字段'); return; }
  models.push({ name, key, base, model, apiFormat: fmt });
  renderModels();
  // 新模型索引 = models.length - 1，但保持 defaultModel 不变
  chrome.storage.local.get(['agentModels','historianModel','metaJudgeModelIdx']).then(d => { renderAgentModelSelects(d.agentModels, d.historianModel); renderMetaJudgeModelSelect(d.metaJudgeModelIdx); });
  chrome.storage.local.get('defaultModel').then(d => autoSaveModels(d.defaultModel || 0));
  document.getElementById('addForm').classList.remove('open');
  ['newName','newKey','newBase','newModel'].forEach(id => document.getElementById(id).value = '');
  document.querySelector('input[name="newFormat"][value="anthropic"]').checked = true;
});

document.getElementById('resetBackground').addEventListener('click', () => {
  if (confirm('恢复为内置默认交易背景？')) document.getElementById('background').value = DEFAULT_BACKGROUND_TEXT;
});
document.getElementById('resetPrompt').addEventListener('click', () => {
  if (confirm('恢复为内置默认提示词？')) document.getElementById('defaultPrompt').value = DEFAULT_PROMPT_TEXT;
});
document.getElementById('resetHistorianPrompt')?.addEventListener('click', () => {
  if (confirm('恢复历史学家默认提示词？')) {
    const el = document.getElementById('historianPrompt');
    if (el) el.value = DEFAULT_HISTORIAN_PROMPT;
  }
});
[0, 1, 2].forEach(i => {
  document.getElementById('resetAgentPrompt' + i).addEventListener('click', () => {
    const names = ['分析师', '质疑师', '裁判'];
    if (confirm('恢复' + names[i] + '默认提示词？')) {
      document.getElementById('agentPrompt' + i).value = DEFAULT_AGENT_PROMPTS[i];
    }
  });
});

document.getElementById('save').addEventListener('click', async () => {
  const defaultModel  = +document.getElementById('defaultModel').value || 0;
  const background    = document.getElementById('background').value.trim();
  const defaultPrompt = document.getElementById('defaultPrompt').value.trim();
  const agentModels   = [0, 1, 2].map(i => +document.getElementById('agentModel' + i).value || 0);
  const agentPrompts  = [0, 1, 2].map(i => document.getElementById('agentPrompt' + i).value.trim());
  const enhancements = {};
  // v3.1: 只保留有实际效果的三个开关
  ['historian','symmetry'].forEach(k => {
    const el = document.getElementById('enh-' + k);
    if (el) enhancements[k] = el.checked;
  });
  enhancements.decisionProfile = 'none'; // v3.6: 档位系统已删除
  const historianModel = +document.getElementById('historianModel')?.value || 0;
  const historianPrompt = document.getElementById('historianPrompt')?.value?.trim() || '';
  const metaJudgeModelIdx = +document.getElementById('metaJudgeModel')?.value || 0;
  // v2.7: 收集 max_tokens 配置（合法范围 200-16000；非法回退默认）
  const _mtRead = (id, def) => {
    const v = parseInt(document.getElementById(id)?.value, 10);
    if (!isFinite(v) || v < 200 || v > 16000) return def;
    return v;
  };
  const agentMaxTokens = {
    analyst:   _mtRead('maxTokAnalyst',   3000),
    critic:    _mtRead('maxTokCritic',    1500),
    judge:     _mtRead('maxTokJudge',     2500),
    historian: _mtRead('maxTokHistorian', 800)
  };
  await chrome.storage.local.set({ models, defaultModel, background, defaultPrompt, agentModels, agentPrompts, enhancements, historianModel, historianPrompt, agentMaxTokens, metaJudgeModelIdx });
  const saved = document.getElementById('saved');
  saved.style.display = 'block';
  setTimeout(() => saved.style.display = 'none', 2000);
});

// ── 已配置模型折叠开关 ────────────────────────────────────────────
document.getElementById('modelListToggle').addEventListener('click', () => {
  const wrap  = document.getElementById('modelListWrap');
  const arrow = document.getElementById('modelListArrow');
  const open  = wrap.classList.toggle('open');
  arrow.textContent = open ? '▼' : '▶';
});

// ── 诊断工具：导出 / 复制日志 ─────────────────────────────────────
function _formatHistory(history) {
  if (!history || !history.length) return '(无日志)';
  return history.map(e => {
    const data = e.data ? '  ' + e.data : '';
    return '[' + e.ts + '] ' + e.label + ' ' + e.msg + data;
  }).join('\n');
}

function _setDiagStatus(text, isErr) {
  const el = document.getElementById('diagStatus');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isErr ? '#f87171' : '#4ade80';
  if (text) setTimeout(() => { el.textContent = ''; }, 3500);
}

async function _fetchDiagnosticHistory() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTIC_HISTORY' });
    return (resp && resp.history) || [];
  } catch (e) {
    _setDiagStatus('读取失败：' + (e.message || e), true);
    return null;
  }
}

document.getElementById('diagExport')?.addEventListener('click', async () => {
  const history = await _fetchDiagnosticHistory();
  if (!history) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const blob = new Blob([_formatHistory(history)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: 'tvc-diagnostic-' + ts + '.txt', saveAs: true });
    _setDiagStatus('✓ 已导出 ' + history.length + ' 条日志');
  } catch (e) {
    // 没有 downloads 权限时降级：直接打开新窗口
    const a = document.createElement('a');
    a.href = url; a.download = 'tvc-diagnostic-' + ts + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    _setDiagStatus('✓ 已导出 ' + history.length + ' 条日志');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
});

document.getElementById('diagCopy')?.addEventListener('click', async () => {
  const history = await _fetchDiagnosticHistory();
  if (!history) return;
  try {
    await navigator.clipboard.writeText(_formatHistory(history));
    _setDiagStatus('✓ 已复制 ' + history.length + ' 条日志到剪贴板');
  } catch (e) {
    _setDiagStatus('复制失败：' + (e.message || e), true);
  }
});

load();