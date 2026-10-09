/*
 * HomeMemory 实验数据接口客户端
 *
 * 默认继续支持 EdgeOne KV；配置 Google Apps Script Web App 地址后，
 * 前后台会自动切换到 Google Sheets 存储。Apps Script 版本使用 JSONP
 * 读取和隐藏表单提交，避免 GitHub Pages 与 Google Web App 的跨域预检问题。
 */
(function () {
  const API_PATH = '/api/experiment';
  const ADMIN_TOKEN_KEY = 'homememory-experiment-admin-token';
  const EXPERIMENT_VERSION = 'two-condition-reading6-sus-v1';
  const appsScriptUrl = String(window.EXPERIMENT_APPS_SCRIPT_URL || '').trim().replace(/\/$/, '');
  const useAppsScript = Boolean(appsScriptUrl);
  let participantWriteQueue = Promise.resolve();

  function adminToken() {
    return window.EXPERIMENT_ADMIN_TOKEN || localStorage.getItem(ADMIN_TOKEN_KEY) || '';
  }

  function withPreviewAuth(path) {
    const target = new URL(path, window.location.href);
    const currentParams = new URLSearchParams(window.location.search);
    ['eo_token', 'eo_time'].forEach((key) => {
      if (currentParams.has(key) && !target.searchParams.has(key)) {
        target.searchParams.set(key, currentParams.get(key));
      }
    });
    return `${target.pathname}${target.search}${target.hash}`;
  }

  async function edgeRequest(url, options = {}, requiresAdmin = false) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body) headers.set('Content-Type', 'application/json');
    if (requiresAdmin && adminToken()) headers.set('x-admin-token', adminToken());
    let response = await fetch(withPreviewAuth(url), { ...options, headers });
    if (!response.ok) throw new Error(`实验数据接口请求失败（${response.status}）`);
    return response.json();
  }

  function jsonp(params) {
    return new Promise((resolve, reject) => {
      const callbackName = `__hmExperimentJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement('script');
      const query = new URLSearchParams({ ...params, callback: callbackName });
      let settled = false;
      const cleanup = () => {
        settled = true;
        delete window[callbackName];
        script.remove();
      };
      const timer = window.setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error('Google Sheets 数据读取超时'));
      }, 15000);
      window[callbackName] = (data) => {
        if (settled) return;
        window.clearTimeout(timer);
        cleanup();
        if (data?.error) reject(new Error(data.error));
        else resolve(data);
      };
      script.onerror = () => {
        if (settled) return;
        window.clearTimeout(timer);
        cleanup();
        reject(new Error('Google Sheets 数据读取失败'));
      };
      script.src = `${appsScriptUrl}?${query.toString()}`;
      document.head.appendChild(script);
    });
  }

  function appsScriptGet(params, requiresAdmin = false) {
    // Apps Script 与中间重定向层偶尔会返回刚才的读取结果；每次读取加入唯一值，
    // 使写入核验始终读取最新状态而非缓存响应。
    const query = { ...params, requestNonce: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
    const token = requiresAdmin ? adminToken() : '';
    if (token) {
      query.adminToken = token.trim();
    }
    const requestUrl = `${appsScriptUrl}?${new URLSearchParams(query).toString()}`;
    // Apps Script allows cross-origin reads. Fetch is more reliable than JSONP
    // when its response is redirected to script.googleusercontent.com.
    return fetch(requestUrl, { method: 'GET', redirect: 'follow', cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`Google Sheets 数据读取失败（${response.status}）`);
        return response.json().then((data) => {
          if (data?.error) throw new Error(data.error);
          return data;
        });
      })
      .catch((fetchError) => jsonp(query).catch((jsonpError) => {
        throw new Error(`${fetchError.message}；备用读取也失败：${jsonpError.message}`);
      }));
  }

  function appsScriptPost(payload, requiresAdmin = false) {
    const body = { payload: JSON.stringify(payload) };
    const token = requiresAdmin ? adminToken() : '';
    if (token) {
      body.adminToken = token.trim();
    }
    // Use a native form target rather than cross-origin fetch. Fetch can reject
    // with "Failed to fetch" in Safari/iOS and on some network transitions,
    // while a form POST is handled consistently by the Apps Script web app.
    return new Promise((resolve, reject) => {
      const requestId = `hm_apps_script_post_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const iframe = document.createElement('iframe');
      const form = document.createElement('form');
      let submitted = false;
      let settled = false;
      const cleanup = () => {
        form.remove();
        iframe.remove();
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        cleanup();
        if (error) reject(error);
        else resolve({ submitted: true });
      };
      iframe.name = requestId;
      iframe.src = 'about:blank';
      iframe.hidden = true;
      iframe.addEventListener('load', () => {
        if (submitted) {
          finish();
          return;
        }
        document.body.appendChild(form);
        submitted = true;
        try {
          form.submit();
        } catch (error) {
          finish(error);
        }
      });
      form.method = 'POST';
      form.action = appsScriptUrl;
      form.target = requestId;
      form.hidden = true;
      Object.entries(body).forEach(([name, value]) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      });
      const timer = window.setTimeout(() => finish(new Error('Google Sheets 数据写入超时')), 30000);
      document.body.appendChild(iframe);
    });
  }

  function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }

  async function verifyParticipantWrite(participantId, snapshot) {
    const expected = stableSerialize({ ...snapshot, participantId: Number(participantId) });
    let lastError = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt) await new Promise(resolve => window.setTimeout(resolve, 1200));
      let remote;
      try {
        remote = await appsScriptGet({ scope: 'participant', participantId, experimentVersion: EXPERIMENT_VERSION });
      } catch (error) {
        lastError = error;
        continue;
      }
      if (stableSerialize(remote?.state || {}) === expected) return { ok: true, verified: true };
      if (Number(remote?.state?.lastModified || 0) > Number(snapshot.lastModified || 0)) {
        throw new Error('云端已有更新的记录，当前页面停止覆盖；请重新进入该被试。');
      }
      if (Math.max(remote?.state?.clearedAt || 0, remote?.config?.clearedAt || 0) > (snapshot.clearedAt || 0)) {
        throw new Error('云端记录已清空，本页面的旧记录不会再上传；请刷新页面');
      }
    }
    throw new Error(`云端尚未确认本次写入，系统将重试${lastError ? `：${lastError.message}` : ''}`);
  }

  function requireAppsScript() {
    if (!useAppsScript) throw new Error('尚未配置 Google Sheets 数据接口地址');
  }

  window.ExperimentAPI = {
    usingAppsScript: useAppsScript,
    async whenIdle() { await participantWriteQueue.catch(() => {}); },
    async getParticipant(participantId) {
      if (useAppsScript) {
        requireAppsScript();
        return appsScriptGet({ scope: 'participant', participantId, experimentVersion: EXPERIMENT_VERSION });
      }
      return edgeRequest(`${API_PATH}?scope=participant&participantId=${encodeURIComponent(participantId)}`);
    },
    async getAll() {
      if (useAppsScript) {
        requireAppsScript();
        return appsScriptGet({ scope: 'all', experimentVersion: EXPERIMENT_VERSION }, true);
      }
      return edgeRequest(`${API_PATH}?scope=all`, {}, true);
    },
    async saveParticipant(participantId, state) {
      const snapshot = JSON.parse(JSON.stringify(state));
      participantWriteQueue = participantWriteQueue.catch(() => {}).then(() => {
        if (useAppsScript) {
          return appsScriptGet({ scope: 'participant', participantId, experimentVersion: EXPERIMENT_VERSION })
            .then((remote) => {
              if (Math.max(remote?.state?.clearedAt || 0, remote?.config?.clearedAt || 0) > (snapshot.clearedAt || 0)) {
                throw new Error('云端记录已清空，本页面的旧记录不会再上传；请刷新页面');
              }
              return appsScriptPost({ action: 'saveParticipant', participantId, experimentVersion: EXPERIMENT_VERSION, clientProtocol: 2, state: snapshot });
            })
            .then(() => verifyParticipantWrite(participantId, snapshot));
        }
        return edgeRequest(API_PATH, { method: 'POST', body: JSON.stringify({ action: 'saveParticipant', participantId, experimentVersion: EXPERIMENT_VERSION, state: snapshot }) });
      });
      return participantWriteQueue;
    },
    async saveConfig(config) {
      if (useAppsScript) return appsScriptPost({ action: 'saveConfig', experimentVersion: EXPERIMENT_VERSION, config }, true);
      return edgeRequest(API_PATH, { method: 'POST', body: JSON.stringify({ action: 'saveConfig', experimentVersion: EXPERIMENT_VERSION, config }) }, true);
    },
    async clear(scope) {
      if (useAppsScript) {
        await appsScriptPost({ action: 'clear', experimentVersion: EXPERIMENT_VERSION, scope }, true);
        const remote = await this.getAll();
        const fields = scope === 'reading' ? ['records'] : scope === 'questionnaires' ? ['questionnaires', 'questionnaireDrafts'] : ['records', 'questionnaires', 'questionnaireDrafts', 'consents', 'answers', 'starts'];
        const remaining = Object.values(remote.states || {}).some((state) => fields.some((field) => Object.keys(state?.[field] || {}).length));
        if (remaining) throw new Error('云端仍有记录，清空未完成；请稍后重试');
        return { ok: true, verified: true };
      }
      return edgeRequest(API_PATH, { method: 'POST', body: JSON.stringify({ action: 'clear', experimentVersion: EXPERIMENT_VERSION, scope }) }, true);
    }
  };
})();
