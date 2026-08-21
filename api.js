(function () {
  'use strict';

  const API_KEY = 'health-log-github-pages-api-url';
  const CREDS_KEY = 'health-log-github-pages-credentials';
  let sequence = 0;

  function cleanBase(value) {
    return String(value || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }

  function configuredApiUrl() {
    const query = new URLSearchParams(window.location.search);
    return cleanBase(query.get('api') || localStorage.getItem(API_KEY) || (window.HEALTH_LOG_CONFIG || {}).apiUrl);
  }

  function saveApiUrl(value) {
    const clean = cleanBase(value);
    if (clean) localStorage.setItem(API_KEY, clean);
    else localStorage.removeItem(API_KEY);
    return clean;
  }

  function parseCredentials(value) {
    const raw = String(value || '').trim();
    if (!raw) return { uid: '', sig: '' };
    try {
      const url = new URL(raw, window.location.href);
      return {
        uid: url.searchParams.get('uid') || '',
        sig: url.searchParams.get('sig') || url.searchParams.get('token') || '',
      };
    } catch (error) {
      return { uid: '', sig: '' };
    }
  }

  function credentialsFromStorage() {
    try {
      return JSON.parse(localStorage.getItem(CREDS_KEY) || '{}') || {};
    } catch (error) {
      return { uid: '', sig: '' };
    }
  }

  function saveCredentials(value) {
    const parsed = parseCredentials(value);
    localStorage.setItem(CREDS_KEY, JSON.stringify(parsed));
    return parsed;
  }

  function queryString(params) {
    return Object.keys(params || {})
      .filter(key => params[key] !== undefined && params[key] !== null && String(params[key]) !== '')
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');
  }

  function get(resource, params) {
    return new Promise((resolve, reject) => {
      const base = configuredApiUrl();
      if (!base) {
        reject(new Error('請先填入 Apps Script /exec 網址。'));
        return;
      }

      const callbackName = `healthLogApiCallback_${Date.now()}_${sequence++}`;
      const script = document.createElement('script');
      let finished = false;
      const timeout = window.setTimeout(() => finish(new Error('API 讀取逾時，請確認網址是 /exec 且 Apps Script 已部署。')), 15000);

      function cleanup() {
        window.clearTimeout(timeout);
        try { delete window[callbackName]; } catch (error) { window[callbackName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      function finish(error, value) {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else if (value && value.ok === false) reject(new Error(value.error || 'API 回傳錯誤。'));
        else resolve(value);
      }

      window[callbackName] = value => finish(null, value);
      script.onerror = () => finish(new Error('無法連到 Apps Script API，請檢查 /exec 網址。'));
      script.async = true;
      script.src = `${base}?${queryString(Object.assign({ api: '1', resource, callback: callbackName }, params || {}))}`;
      document.head.appendChild(script);
    });
  }

  window.HealthLogApi = {
    configuredApiUrl,
    saveApiUrl,
    parseCredentials,
    credentialsFromStorage,
    saveCredentials,
    get,
  };
})();
