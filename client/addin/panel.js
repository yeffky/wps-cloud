(function () {
  'use strict';
  const SETTINGS_KEY = 'wps-personal-cloud.settings.v1';
  const STATUS_KEY = 'wps-personal-cloud.status.v1';
  const PENDING_KEY = 'wps-personal-cloud.pending.v1';
  const RETRY_REQUEST_KEY = 'wps-personal-cloud.retry-request.v1';
  const $ = (id) => document.getElementById(id);

  function readSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  }

  function loadSettings() {
    const value = readSettings();
    $('apiBase').value = value.apiBase || 'http://127.0.0.1:8787';
    $('token').value = value.token || '';
    $('parentId').value = value.parentId || 'root';
    $('autoSync').checked = value.autoSync !== false;
    $('autoCompare').checked = value.autoCompare === true;
    $('autoSaveDelay').value = String(normalizeAutoSaveDelay(value.autoSaveDelaySeconds));
    renderSyncStatus();
  }

  function saveSettings() {
    const autoSaveDelaySeconds = normalizeAutoSaveDelay($('autoSaveDelay').value);
    $('autoSaveDelay').value = String(autoSaveDelaySeconds);
    const value = {
      apiBase: $('apiBase').value.trim().replace(/\/+$/, ''),
      token: $('token').value.trim(),
      parentId: $('parentId').value.trim() || 'root',
      autoSync: $('autoSync').checked,
      autoCompare: $('autoCompare').checked,
      autoSaveDelaySeconds,
    };
    if (!/^https?:\/\//i.test(value.apiBase)) return setConnection('服务器地址必须以 http:// 或 https:// 开头。', true);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
    setConnection('设置已保存。');
  }

  function normalizeAutoSaveDelay(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.max(1, Math.min(60, Math.round(seconds))) : 5;
  }

  async function api(path) {
    const config = readSettings();
    if (!config.token) throw new Error('请先填写访问令牌并保存设置。');
    const url = `${config.apiBase.replace(/\/+$/, '')}${path}`;
    let response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${config.token}` } });
    } catch (error) {
      throw new Error(`授权目录请求失败：${error.message || error}（${url}）`);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `服务器返回 HTTP ${response.status}`);
    return body;
  }

  async function testConnection() {
    saveSettings();
    try {
      const config = readSettings();
      const apiBase = config.apiBase.replace(/\/+$/, '');
      const healthUrl = `${apiBase}/api/health`;
      let healthResponse;
      try {
        healthResponse = await fetch(healthUrl);
      } catch (error) {
        throw new Error(`健康检查请求失败：${error.message || error}（${healthUrl}）`);
      }
      if (!healthResponse.ok) throw new Error(`健康检查返回 HTTP ${healthResponse.status}（${healthUrl}）`);
      try {
        await api('/api/files?parentId=root');
      } catch (error) {
        throw new Error(`服务器可访问，但令牌/目录检查失败：${error.message}`);
      }
      setConnection('连接成功，服务器已授权。');
    } catch (error) { setConnection(error.message, true); }
  }

  async function refreshFiles() {
    $('files').textContent = '正在读取目录…';
    try {
      const config = readSettings();
      const result = await api(`/api/files?parentId=${encodeURIComponent(config.parentId || 'root')}`);
      const items = result.items || [];
      if (!items.length) { $('files').textContent = '目录暂时没有文件。'; return; }
      $('files').replaceChildren(...items.map(renderFile));
    } catch (error) { $('files').textContent = error.message; }
  }

  function renderFile(file) {
    const row = document.createElement('div');
    row.className = 'file';
    const info = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = file.name;
    const meta = document.createElement('small');
    meta.textContent = `版本 ${file.version} · ${formatBytes(file.size)}`;
    info.append(name, meta);
    const open = document.createElement('button');
    open.className = 'secondary small';
    open.textContent = '下载打开';
    open.addEventListener('click', () => downloadAndOpen(file));
    row.append(info, open);
    return row;
  }

  async function downloadAndOpen(file) {
    setConnection(`正在准备下载：${file.name}`);
    try {
      const config = readSettings();
      const result = await api(`/api/files/${encodeURIComponent(file.id)}/download-ticket`);
      const currentFile = { ...file, ...result };
      const cachePath = getCloudCachePath(currentFile.fileId, currentFile.version, currentFile.name);
      if (Application.FileSystem.Exists(cachePath)) {
        setConnection(`正在打开本地缓存：${currentFile.name}`);
        await openCloudFile(cachePath, currentFile);
        return;
      }
      const url = new URL(result.downloadPath, `${config.apiBase}/`).href;
      setConnection(`已取得下载链接，正在由 WPS 下载：${file.name}`);
      const localDownloadPath = await downloadWithWps(url, currentFile.name);
      setConnection(`下载完成，正在写入本地缓存：${currentFile.name}`);
      const openPath = cacheDownloadedFile(localDownloadPath, currentFile);
      await openCloudFile(openPath, currentFile);
    } catch (error) {
      setConnection(error.message, true);
    }
  }

  function downloadWithWps(url, fileName) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => finish(new Error(`WPS 下载未返回结果：${fileName}。请检查 WPS 下载权限或网络。`)), 60000);
      const finish = (error, path) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(path);
      };
      try {
        Application.OAAssist.DownloadFile(url, (...results) => {
          const path = results.map(extractDownloadPath).find(Boolean);
          if (!path) {
            finish(new Error(`WPS 下载回调中没有可识别的本地路径（返回 ${results.length} 个参数）`));
            return;
          }
          finish(null, path);
        }, (error) => {
          const message = typeof error === 'string' ? error : JSON.stringify(error || {});
          finish(new Error(`WPS 下载失败：${message || '未提供错误详情'}`));
        });
      } catch (error) { finish(error); }
    });
  }

  function extractDownloadPath(value) {
    if (typeof value === 'string') {
      const text = value.trim();
      const quotedPath = text.match(/^(["'])((?:[a-z]:[\\/]|\\\\)[^"']+)\1(?:\s*,|$)/i);
      if (quotedPath) return quotedPath[2].replaceAll('/', '\\');
      const path = text.match(/(?:[a-z]:[\\/]|\\\\)[^"',\r\n]+/i);
      if (path) return path[0].trim().replaceAll('/', '\\');
      return '';
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const path = extractDownloadPath(item);
        if (path) return path;
      }
      return '';
    }
    if (value && typeof value === 'object') {
      for (const key of ['filePath', 'path', 'localPath', 'FilePath', 'Path']) {
        try {
          const path = extractDownloadPath(value[key]);
          if (path) return path;
        } catch { /* Ignore unavailable COM proxy properties. */ }
      }
    }
    return '';
  }

  function getCloudCachePath(fileId, version, fileName) {
    if (typeof fileId !== 'string' || !/^[a-f0-9-]{1,80}$/i.test(fileId)) throw new Error('云端文件 ID 无效');
    if (!Number.isSafeInteger(Number(version)) || Number(version) < 1) throw new Error('云端文件版本无效');
    const appDataPath = Application.Env.GetAppDataPath().replace(/[\\/]+$/, '').replaceAll('/', '\\');
    if (!appDataPath) throw new Error('WPS 无法获取本机 AppData 目录');
    const cacheDirectory = `${appDataPath}\\WPSPersonalCloud\\cache\\${fileId}\\v${Number(version)}`;
    ensureDirectory(cacheDirectory);
    return `${cacheDirectory}\\${safeCacheFileName(fileName)}`;
  }

  function ensureDirectory(directoryPath) {
    const fs = Application.FileSystem;
    if (fs.Exists(directoryPath)) return;
    const separator = directoryPath.lastIndexOf('\\');
    const parent = separator > 2 ? directoryPath.slice(0, separator) : '';
    if (parent && !fs.Exists(parent)) ensureDirectory(parent);
    fs.Mkdir(directoryPath);
    if (!fs.Exists(directoryPath)) throw new Error(`无法创建本地缓存目录：${directoryPath}`);
  }

  function safeCacheFileName(fileName) {
    let safeName = String(fileName || 'document.docx')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/, '')
      .trim();
    if (!safeName) safeName = 'document.docx';
    if (safeName.length > 180) {
      const extension = safeName.match(/\.[^.]+$/)?.[0] || '';
      safeName = `${safeName.slice(0, 180 - extension.length)}${extension}`;
    }
    return safeName;
  }

  function cacheDownloadedFile(sourcePath, file) {
    const targetPath = getCloudCachePath(file.fileId, file.version, file.name);
    const fs = Application.FileSystem;
    if (fs.Exists(targetPath)) return targetPath;
    const normalizedSource = sourcePath.replaceAll('/', '\\');
    if (!fs.Exists(normalizedSource)) throw new Error('WPS 返回的临时下载文件不存在');
    fs.copyFileSync(normalizedSource, targetPath);
    if (!fs.Exists(targetPath)) throw new Error('无法将下载文件写入个人云盘缓存目录');
    return targetPath;
  }

  async function openCloudFile(localPath, file) {
    await rememberCloudFile(localPath, file);
    const openedDocument = Application.Documents.Open(localPath, null, false, true);
    if (openedDocument && typeof openedDocument.Activate === 'function') openedDocument.Activate();
    setConnection(`已打开云端版本 ${file.version}：${file.name}`);
  }

  async function rememberCloudFile(localPath, file) {
    if (typeof localPath !== 'string' || !localPath) return;
    const normalized = localPath.replaceAll('/', '\\').toLowerCase();
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    const pathHash = [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    let fileMap = {};
    try { fileMap = JSON.parse(localStorage.getItem('wps-personal-cloud.file-map.v1') || '{}'); } catch { /* Start a fresh local mapping. */ }
    fileMap[pathHash] = { fileId: file.id, version: file.version, name: file.name };
    localStorage.setItem('wps-personal-cloud.file-map.v1', JSON.stringify(fileMap));
    if (!localStorage.getItem('wps-personal-cloud.machine-id.v1')) {
      localStorage.setItem('wps-personal-cloud.machine-id.v1', crypto.randomUUID());
    }
  }

  function setConnection(message, failed) {
    $('connection').textContent = message;
    $('connection').style.color = failed ? '#b42318' : '#16834b';
  }

  function renderSyncStatus() {
    try {
      const status = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}');
      $('syncStatus').textContent = status.message ? `${status.message}${status.detail ? `：${status.detail}` : ''}` : '尚未同步';
    } catch { $('syncStatus').textContent = '尚未同步'; }
    try {
      const pending = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
      const count = Object.keys(pending).length;
      $('pendingStatus').textContent = `上传队列：${count}`;
    } catch { $('pendingStatus').textContent = '上传队列：0'; }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  $('save').addEventListener('click', saveSettings);
  $('connect').addEventListener('click', testConnection);
  $('refresh').addEventListener('click', refreshFiles);
  $('retry').addEventListener('click', () => {
    localStorage.setItem(RETRY_REQUEST_KEY, String(Date.now()));
    setConnection('已请求重试上传队列。');
    setTimeout(renderSyncStatus, 500);
  });
  loadSettings();
  setInterval(renderSyncStatus, 1000);
}());
