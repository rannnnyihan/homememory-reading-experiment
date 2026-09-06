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
    const query = { ...params };
    const token = requiresAdmin ? adminToken() : '';
    if (token) {
      query.adminToken = token.trim();
    }
    return jsonp(query);
  }

  function appsScriptPost(payload, requiresAdmin = false) {
    const body = { payload: JSON.stringify(payload) };
    const token = requiresAdmin ? adminToken() : '';
    if (token) {
      body.adminToken = token.trim();
    }
    const formBody = new URLSearchParams(body);
    return fetch(appsScriptUrl, {
      method: 'POST',
      mode: 'no-cors',
      keepalive: true,
      body: formBody
    }).then(() => {
      return { ok: true };
    });
  }

  function requireAppsScript() {
    if (!useAppsScript) throw new Error('尚未配置 Google Sheets 数据接口地址');
  }

  window.ExperimentAPI = {
    usingAppsScript: useAppsScript,
    async getParticipant(participantId) {
      if (useAppsScript) {
        requireAppsScript();
        return appsScriptGet({ scope: 'participant', participantId });
      }
      return edgeRequest(`${API_PATH}?scope=participant&participantId=${encodeURIComponent(participantId)}`);
    },
    async getAll() {
      if (useAppsScript) {
        requireAppsScript();
        return appsScriptGet({ scope: 'all' }, true);
      }
      return edgeRequest(`${API_PATH}?scope=all`, {}, true);
    },
    async saveParticipant(participantId, state) {
      participantWriteQueue = participantWriteQueue.catch(() => {}).then(() => {
        if (useAppsScript) return appsScriptPost({ action: 'saveParticipant', participantId, state });
        return edgeRequest(API_PATH, { method: 'POST', body: JSON.stringify({ action: 'saveParticipant', participantId, state }) });
      });
      return participantWriteQueue;
    },
    async saveConfig(config) {
      if (useAppsScript) return appsScriptPost({ action: 'saveConfig', config }, true);
      return edgeRequest(API_PATH, { method: 'POST', body: JSON.stringify({ action: 'saveConfig', config }) }, true);
    },
    async clear(scope) {
      if (useAppsScript) return appsScriptPost({ action: 'clear', scope }, true);
      return edgeRequest(API_PATH, { method: 'POST', body: JSON.stringify({ action: 'clear', scope }) }, true);
    }
  };
})();
