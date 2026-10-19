(function () {
  'use strict';

  const SETTINGS_KEY = 'wps-personal-cloud.settings.v1';
  const MAP_KEY = 'wps-personal-cloud.file-map.v1';
  const MACHINE_KEY = 'wps-personal-cloud.machine-id.v1';
  const STATUS_KEY = 'wps-personal-cloud.status.v1';
  const PENDING_KEY = 'wps-personal-cloud.pending.v1';
  const RETRY_REQUEST_KEY = 'wps-personal-cloud.retry-request.v1';
  const AUTO_COMPARE_INTERVAL_MS = 60 * 1000;
  const DEFAULT_AUTO_SAVE_DELAY_SECONDS = 5;
  const ADDIN_TYPE = window.WPS_ADDIN_TYPE || 'wps';
  const SUPPORTED = new Set(['doc', 'docx', 'wps', 'dot', 'dotx', 'xls', 'xlsx', 'et', 'ppt', 'pptx', 'dps']);
  const running = new Map();
  const rerun = new Map();
  const recentSaveEvents = new Map();
  const registeredSaveEvents = new Set();
  let taskPane;

  function settings() {
    try { return Object.assign({ apiBase: 'http://127.0.0.1:8787', token: '', parentId: 'root', autoSync: true, autoCompare: false, autoSaveDelaySeconds: DEFAULT_AUTO_SAVE_DELAY_SECONDS }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
    catch { return { apiBase: 'http://127.0.0.1:8787', token: '', parentId: 'root', autoSync: true, autoCompare: false, autoSaveDelaySeconds: DEFAULT_AUTO_SAVE_DELAY_SECONDS }; }
  }

  function setStatus(message, detail) {
    const value = { message, detail: detail || '', at: new Date().toISOString() };
    try { localStorage.setItem(STATUS_KEY, JSON.stringify(value)); } catch { /* Settings storage may be unavailable. */ }
    if (message.startsWith('同步失败')) console.warn('[WPS Personal Cloud]', message, detail || '');
  }

  function OnAddInLoad() {
    registerSaveEvents();
    flushPendingQueue();
  }

  function registerSaveEvents() {
    const listeners = ADDIN_TYPE === 'et'
      ? [['FileAfterSave', onFileAfterSave], ['SheetChange', onContentChanged]]
      : ADDIN_TYPE === 'wpp'
        ? [['FileAfterSave', onFileAfterSave], ['WindowSelectionChange', onWppSelectionChanged]]
        : [['FileAfterSave', onFileAfterSave], ['DocumentChange', onContentChanged], ['ContentChange', onContentChanged]];
    if (listeners.every(([eventName]) => registeredSaveEvents.has(eventName))) return;
    if (!window.Application || !Application.ApiEvent) {
      setStatus('同步监听未就绪', 'WPS 尚未提供保存事件接口');
      return;
    }
    const errors = [];
    for (const [eventName, callback] of listeners) {
      if (registeredSaveEvents.has(eventName)) continue;
      try {
        Application.ApiEvent.AddApiEventListener(eventName, callback);
        registeredSaveEvents.add(eventName);
      } catch (error) {
        errors.push(`${eventName}: ${error.message}`);
        console.error(`[WPS Personal Cloud] Cannot register ${eventName}:`, error);
      }
    }
    if (registeredSaveEvents.size) {
      setStatus('同步监听已就绪', `已注册事件：${[...registeredSaveEvents].join('、')}${errors.length ? `；注册异常：${errors.join('；')}` : ''}`);
    } else if (errors.length) setStatus('同步失败', `保存事件注册失败：${errors.join('；')}`);
  }

  function OpenCloudPane() {
    if (taskPane) {
      taskPane.Visible = true;
      return;
    }
    const panelUrl = new URL('panel.html', window.location.href).href;
    taskPane = Application.CreateTaskPane(panelUrl, '个人云盘');
    if (taskPane) taskPane.Visible = true;
    else Application.alert('无法打开个人云盘面板，请检查加载项页面地址和 WPS 版本。');
  }

  function onFileAfterSave(doc, filePath, format) {
    handleAfterSave('FileAfterSave', [doc, filePath, format]);
  }

  function handleAfterSave(eventName, args) {
    const config = settings();
    if (!config.autoSync) {
      setStatus('未同步', `收到 ${eventName}，但自动同步未开启`);
      return;
    }
    if (!config.token) {
      setStatus('同步失败', `收到 ${eventName}，但未设置访问令牌`);
      return;
    }
    const path = findSavedPath(args);
    if (!path) {
      setStatus('未同步', `收到 ${eventName}，但没有读取到本地文档路径`);
      return;
    }
    if (!isSupportedLocalFile(path)) {
      setStatus('未同步', `收到 ${eventName}，但文件类型暂不支持：${path.split(/[\\/]/).pop()}`);
      return;
    }
    clearIdleSave(path);
    const key = path.toLowerCase();
    const now = Date.now();
    for (const [savedPath, time] of recentSaveEvents) {
      if (now - time > 5000) recentSaveEvents.delete(savedPath);
    }
    const lastEventAt = recentSaveEvents.get(key) || 0;
    if (now - lastEventAt < 1000) return;
    recentSaveEvents.set(key, now);
    queueSync(path);
  }

  function findSavedPath(args) {
    for (const value of args) {
      if (typeof value === 'string' && looksLikePath(value)) return normalizePath(value);
      if (value && typeof value === 'object') {
        for (const key of ['FullName', 'FilePath', 'Name', 'Path']) {
          try {
            const candidate = value[key];
            if (typeof candidate === 'string' && looksLikePath(candidate)) return normalizePath(candidate);
          } catch { /* Some COM proxy properties throw when unavailable. */ }
        }
      }
    }
    try {
      const doc = Application.ActiveDocument;
      const candidate = doc && doc.FullName;
      return typeof candidate === 'string' && looksLikePath(candidate) ? normalizePath(candidate) : '';
    } catch { return ''; }
  }

  function looksLikePath(value) {
    return /^(?:[a-z]:[\\/]|\\\\|file:\/\/)/i.test(value.trim());
  }

  function normalizePath(value) {
    let result = value.trim();
    if (/^file:\/\//i.test(result)) {
      try { result = decodeURIComponent(new URL(result).pathname).replace(/^\/(\w:)/, '$1'); }
      catch { return ''; }
    }
    return result.replaceAll('/', '\\');
  }

  function isSupportedLocalFile(filePath) {
    const extension = filePath.split(/[\\/]/).pop().split('.').pop().toLowerCase();
    return SUPPORTED.has(extension);
  }

  function queueSync(filePath) {
    savePending(filePath);
    setStatus('正在同步', filePath.split(/[\\/]/).pop());
    const key = filePath.toLowerCase();
    if (running.has(key)) {
      rerun.set(key, filePath);
      return;
    }
    running.set(key, true);
    syncWithRetry(filePath, 0).finally(() => {
      running.delete(key);
      const pending = rerun.get(key);
      rerun.delete(key);
      if (pending) queueSync(pending);
    });
  }

  async function syncWithRetry(filePath, attempt) {
    try {
      await syncOnce(filePath);
      removePending(filePath);
    } catch (error) {
      setStatus('同步失败', `${filePath}: ${error.message}`);
      if (attempt < 3 && !/conflict/i.test(error.code || '')) {
        const delay = [1500, 5000, 15000][attempt];
        await new Promise((resolve) => setTimeout(resolve, delay));
        return syncWithRetry(filePath, attempt + 1);
      }
    }
  }

  async function syncOnce(filePath) {
    const config = settings();
    const apiBase = config.apiBase.replace(/\/+$/, '');
    const pathHash = await sha256(filePath.toLowerCase());
    const machineId = getMachineId();
    const fileMap = readJson(MAP_KEY, {});
    const known = fileMap[pathHash] || {};
    const name = filePath.split(/[\\/]/).pop();
    const localSha256 = await sha256LocalFile(filePath);
    if (known.fileId) {
      const remoteFile = await apiRequest(`${apiBase}/api/files/${encodeURIComponent(known.fileId)}`, config.token);
      if (remoteFile.sha256 === localSha256) {
        fileMap[pathHash] = { ...known, version: remoteFile.version, sha256: localSha256, name };
        localStorage.setItem(MAP_KEY, JSON.stringify(fileMap));
        setStatus('已同步', `${name} · 本地与云端内容一致（版本 ${remoteFile.version}）`);
        return;
      }
      if (remoteFile.version !== (known.version || 0)) {
        const conflict = new Error(`云端已更新至版本 ${remoteFile.version}，本地内容也有差异；为避免覆盖，请先处理版本冲突`);
        conflict.code = 'version_conflict';
        throw conflict;
      }
    }
    let ticket;
    try {
      ticket = await apiRequest(`${apiBase}/api/sync-ticket`, config.token, {
        method: 'POST',
        body: JSON.stringify({
          name,
          machineId,
          pathHash,
          parentId: config.parentId || 'root',
          fileId: known.fileId || null,
          expectedVersion: known.version || 0,
        }),
      });
    } catch (error) {
      throw new Error(`获取上传票据失败：${error.message}`);
    }
    const uploadUrl = new URL(ticket.uploadPath, `${apiBase}/`).href;
    try {
      await uploadLocalFile(name, filePath, uploadUrl);
    } catch (error) {
      throw new Error(`WPS 上传文件失败：${error.message}`);
    }
    const savedVersion = ticket.expectedVersion + 1;
    fileMap[pathHash] = { fileId: ticket.fileId, version: savedVersion, sha256: localSha256, name };
    localStorage.setItem(MAP_KEY, JSON.stringify(fileMap));
    setStatus('已同步', `${name} · 版本 ${savedVersion}`);
  }

  function uploadLocalFile(name, filePath, uploadUrl) {
    return new Promise((resolve, reject) => {
      try {
        const accepted = Application.OAAssist.UploadFile(
          name,
          filePath,
          uploadUrl,
          'file',
          () => resolve(),
          (error) => {
            const message = typeof error === 'string' ? error : JSON.stringify(error || {});
            const failure = new Error(message || 'WPS 文件上传失败');
            if (/409|conflict/i.test(message)) failure.code = 'version_conflict';
            reject(failure);
          },
        );
        if (accepted === false) reject(new Error('WPS 拒绝启动文件上传'));
      } catch (error) { reject(error); }
    });
  }

  async function apiRequest(url, token, options = {}) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error || '网络请求失败');
      throw new Error(`${message}（请求 ${url}；请检查服务器地址、HTTPS 证书与 WPS 网络访问）`);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || `服务器返回 HTTP ${response.status}`);
      error.code = body.error;
      throw error;
    }
    return body;
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    return digestHex(bytes);
  }

  async function sha256LocalFile(filePath) {
    const binary = Application.FileSystem.readAsBinaryString(filePath);
    if (typeof binary !== 'string') throw new Error('WPS 未返回可用于校验的本地文件内容');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
    return digestHex(bytes);
  }

  async function digestHex(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function getMachineId() {
    let id = localStorage.getItem(MACHINE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(MACHINE_KEY, id);
    }
    return id;
  }

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || ''); } catch { return fallback; }
  }

  function savePending(filePath) {
    const pending = readJson(PENDING_KEY, {});
    pending[filePath.toLowerCase()] = filePath;
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  }

  function removePending(filePath) {
    const pending = readJson(PENDING_KEY, {});
    delete pending[filePath.toLowerCase()];
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  }

  function flushPendingQueue() {
    const config = settings();
    if ((!config.autoSync && !config.autoCompare) || !config.token) return;
    const pending = readJson(PENDING_KEY, {});
    for (const filePath of Object.values(pending)) {
      if (typeof filePath === 'string' && isSupportedLocalFile(filePath)) queueSync(filePath);
    }
  }

  let checkingLocalFiles = false;

  async function compareLocalDocumentsWithCloud() {
    const config = settings();
    if (!config.autoCompare || !config.token || !window.Application || checkingLocalFiles) return;
    checkingLocalFiles = true;
    try {
      for (const doc of getOpenDocuments()) {
        try {
          const filePath = getDocumentPath(doc);
          if (!filePath || !isSupportedLocalFile(filePath)) continue;
          if (doc.Saved === false || doc.Saved === 0) {
            scheduleIdleSave(doc, filePath);
            continue;
          }
          if (doc.Saved !== true && doc.Saved !== 1) continue;
          const pathHash = await sha256(filePath.toLowerCase());
          const mapping = readJson(MAP_KEY, {})[pathHash];
          if (mapping && mapping.fileId) queueSync(filePath);
        } catch (error) { setStatus('差异检查失败', `${getDocumentPath(doc) || '当前文档'}：${error.message || error}`); }
      }
    } finally {
      checkingLocalFiles = false;
    }
  }

  const idleSaveTimers = new Map();

  function onContentChanged(...args) {
    const eventDocument = ADDIN_TYPE === 'et'
      ? null
      : args.find((value) => value && typeof value === 'object' && getDocumentPath(value)) || null;
    const targetDocument = eventDocument || getActiveDocument();
    const filePath = getDocumentPath(targetDocument);
    if (!filePath || !isSupportedLocalFile(filePath)) {
      setStatus('检测到内容变化', '无法取得当前文档的本地路径，未启动空闲保存');
      return;
    }
    if (!settings().autoCompare) {
      setStatus('检测到内容变化', '请开启“空闲后自动保存并同步云端差异”以在停止编辑后自动保存');
      return;
    }
    scheduleIdleSave(targetDocument, filePath);
  }

  function onWppSelectionChanged() {
    const presentation = getActiveDocument();
    const filePath = getDocumentPath(presentation);
    if (!filePath) {
      setStatus('检测到演示选区变化', '当前演示文稿尚未保存到本地，请先保存一次');
      return;
    }
    if (!isSupportedLocalFile(filePath)) {
      setStatus('检测到演示选区变化', `当前文件类型不支持同步：${filePath.split(/[\\/]/).pop()}`);
      return;
    }
    if (!settings().autoCompare) {
      setStatus('检测到演示选区变化', '请开启“空闲后自动保存并同步云端差异”以在空闲时检查未保存修改');
      return;
    }
    scheduleIdleSave(presentation, filePath, true);
  }

  function scheduleIdleSave(doc, filePath, selectionOnly = false) {
    if (!settings().autoCompare) return;
    const key = filePath.toLowerCase();
    const previous = idleSaveTimers.get(key);
    if (previous) clearTimeout(previous.timer);
    const delaySeconds = normalizeAutoSaveDelay(settings().autoSaveDelaySeconds);
    const fileName = filePath.split(/[\\/]/).pop();
    setStatus(selectionOnly ? '等待空闲检查' : '等待空闲保存', selectionOnly
      ? `${fileName}：选区停止变化 ${delaySeconds} 秒后检查演示文稿是否有未保存修改`
      : `${fileName}：停止编辑 ${delaySeconds} 秒后自动保存并同步`);
    const timer = setTimeout(() => {
      idleSaveTimers.delete(key);
      autoSaveAndSyncIfDifferent(doc, filePath);
    }, delaySeconds * 1000);
    idleSaveTimers.set(key, { timer, doc });
  }

  function clearIdleSave(filePath) {
    const key = filePath.toLowerCase();
    const pending = idleSaveTimers.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    idleSaveTimers.delete(key);
  }

  function getActiveDocument() {
    try {
      if (ADDIN_TYPE === 'et') return Application.ActiveWorkbook || null;
      if (ADDIN_TYPE === 'wpp') return Application.ActivePresentation || null;
      return Application.ActiveDocument || null;
    } catch { return null; }
  }

  function normalizeAutoSaveDelay(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.max(1, Math.min(60, Math.round(seconds))) : DEFAULT_AUTO_SAVE_DELAY_SECONDS;
  }

  async function autoSaveAndSyncIfDifferent(doc, filePath) {
    if (!settings().autoCompare || !doc) return;
    try {
      if (doc.ReadOnly === true || doc.ReadOnly === 1 || doc.ReadOnly === -1 || typeof doc.Save !== 'function') {
        setStatus('自动保存失败', `${filePath}：文档只读或 WPS 未提供保存接口`);
        return;
      }
      if (ADDIN_TYPE === 'wpp') {
        const saved = doc.Saved;
        if (saved === true || saved === 1 || saved === -1) {
          setStatus('演示文稿未修改', `${filePath.split(/[\\/]/).pop()}：选区变化后未检测到未保存内容`);
          return;
        }
        if (saved !== false && saved !== 0) {
          setStatus('自动保存不可用', `${filePath}：无法读取演示文稿 Saved 状态，已跳过保存`);
          return;
        }
      }
      setStatus('自动保存中', filePath.split(/[\\/]/).pop());
      await Promise.resolve(doc.Save());
      setStatus('正在加入上传队列', filePath.split(/[\\/]/).pop());
      queueSync(filePath);
    } catch (error) {
      setStatus('自动保存失败', `${filePath}：${error.message || error}`);
    }
  }

  function getOpenDocuments() {
    const documents = [];
    try {
      const collection = ADDIN_TYPE === 'et'
        ? Application.Workbooks
        : ADDIN_TYPE === 'wpp'
          ? Application.Presentations
          : Application.Documents;
      const count = Number(collection && collection.Count);
      if (Number.isSafeInteger(count) && count > 0 && typeof collection.Item === 'function') {
        for (let index = 1; index <= count; index += 1) {
          try { documents.push(collection.Item(index)); } catch { /* Skip documents that WPS cannot expose. */ }
        }
      }
    } catch { /* Fall back to the active document when collection access is unavailable. */ }
    if (!documents.length) {
      const activeDocument = getActiveDocument();
      if (activeDocument) documents.push(activeDocument);
    }
    return [...new Set(documents)];
  }

  function getDocumentPath(doc) {
    for (const key of ['FullName', 'FilePath']) {
      try {
        const value = doc && doc[key];
        if (typeof value === 'string' && looksLikePath(value)) return normalizePath(value);
      } catch { /* Some COM proxy properties are unavailable. */ }
    }
    try {
      const path = doc && doc.Path;
      const name = doc && doc.Name;
      if (typeof path === 'string' && looksLikePath(path)) {
        const normalizedPath = normalizePath(path);
        if (isSupportedLocalFile(normalizedPath)) return normalizedPath;
        if (typeof name === 'string' && name.trim() && isSupportedLocalFile(name.trim())) {
          return `${normalizedPath.replace(/[\\/]+$/, '')}\\${name.trim()}`;
        }
      }
    } catch { /* Some COM proxy properties are unavailable. */ }
    return '';
  }

  function checkRetryRequest() {
    const request = localStorage.getItem(RETRY_REQUEST_KEY);
    if (!request) return;
    localStorage.removeItem(RETRY_REQUEST_KEY);
    flushPendingQueue();
  }

  window.OnAddInLoad = OnAddInLoad;
  window.OpenCloudPane = OpenCloudPane;
  registerSaveEvents();
  setInterval(compareLocalDocumentsWithCloud, AUTO_COMPARE_INTERVAL_MS);
  setInterval(checkRetryRequest, 1500);
}());
