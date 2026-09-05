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
    if (requiresAdmin && response.status === 401 && !adminToken() && typeof window.prompt === 'function') {
      const token = window.prompt('请输入实验后台访问令牌');
      if (token) {
        localStorage.setItem(ADMIN_TOKEN_KEY, token.trim());
        headers.set('x-admin-token', token.trim());
        response = await fetch(withPreviewAuth(url), { ...options, headers });
      }
    }
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
    if (requiresAdmin) {
      const token = adminToken() || (typeof window.prompt === 'function' ? window.prompt('请输入实验后台访问令牌') : '');
      if (!token) return Promise.reject(new Error('需要实验后台访问令牌'));
      localStorage.setItem(ADMIN_TOKEN_KEY, token.trim());
      query.adminToken = token.trim();
    }
    return jsonp(query);
  }

  function appsScriptPost(payload, requiresAdmin = false) {
    const body = { payload: JSON.stringify(payload) };
    if (requiresAdmin) {
      const token = adminToken() || (typeof window.prompt === 'function' ? window.prompt('请输入实验后台访问令牌') : '');
      if (!token) return Promise.reject(new Error('需要实验后台访问令牌'));
      localStorage.setItem(ADMIN_TOKEN_KEY, token.trim());
      body.adminToken = token.trim();
    }
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      const frameName = `__hmExperimentPost_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      frame.name = frameName;
      frame.title = '实验数据提交';
      frame.style.display = 'none';
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = appsScriptUrl;
      form.target = frameName;
      form.style.display = 'none';
      Object.entries(body).forEach(([name, value]) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      });
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        frame.remove();
        form.remove();
        if (error) reject(error);
        else resolve({ ok: true });
      };
      const timer = window.setTimeout(() => finish(), 15000);
      frame.onerror = () => finish(new Error('Google Sheets 数据提交失败'));
      document.body.append(frame, form);
      form.submit();
      window.setTimeout(() => finish(), 1200);
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
