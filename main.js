'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { MiAccount, MinaService, ACCOUNT_BASE, MINA_BASE } = require('./src/mina');
const { PROVIDERS, providerFor, NETEASE_BASE, QQ_BASE } = require('./src/music');
const { MediaServer } = require('./src/mediaServer');
const { Store } = require('./src/store');
const {
  DEFAULT_REPO,
  DEFAULT_API,
  checkUpdate,
  downloadAsset,
  normalizeRepo,
} = require('./src/updater');
const pkg = require('./package.json');
const {
  QQ_DOMAIN,
  NETEASE_DOMAIN,
  QQ_PRIORITY,
  NETEASE_PRIORITY,
  buildCookieHeader,
  normalizeCookie,
  qqAuth,
  neteaseAuth,
} = require('./src/musicCookie');

function loadDotEnv() {
  try {
    const file = path.join(__dirname, '.env.local');
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      if (process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {
    /* 本地环境文件缺失或格式错误时忽略 */
  }
}

loadDotEnv();

const ACCOUNT = process.env.XIAOMI_ACCOUNT_BASE || ACCOUNT_BASE;
const MINA = process.env.XIAOMI_MINA_BASE || MINA_BASE;

let mainWindow = null;
let media = null;
let store = null;
let loginWin = null;

const cloud = { account: null, mina: null, devices: [], selected: null, qrAccount: null };
const musicBox = { current: 'netease', cache: {} };
const updateState = { result: null, checking: false, downloading: false };

const UA_LOGIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const COOKIE_KEY = { netease: 'neteaseCookie', qq: 'qqCookie' };

const LOGIN_PAGES = {
  netease: {
    url: process.env.NETEASE_LOGIN_URL || 'https://music.163.com/',
    title: '登录网易云音乐',
    match: (domain) => NETEASE_DOMAIN.test(String(domain || '')),
    priority: NETEASE_PRIORITY,
    ready: (cookie) => neteaseAuth(cookie).hasLogin,
  },
  qq: {
    url: process.env.QQ_LOGIN_URL || 'https://y.qq.com/n/ryqq/profile',
    fallback: 'https://y.qq.com/',
    warmup: 'https://y.qq.com/n/ryqq/player',
    title: '登录 QQ 音乐',
    match: (domain) => QQ_DOMAIN.test(String(domain || '')),
    priority: QQ_PRIORITY,
    ready: (cookie) => qqAuth(cookie).hasPlayback,
    partial: (cookie) => qqAuth(cookie).hasAccount,
  },
};

const TRUSTED_LOGIN_HOST = /(^|\.)(qq\.com|qqmusic\.com|gtimg\.com|gtimg\.cn|qpic\.cn|tencent\.com|weixin\.qq\.com|163\.com|126\.net|netease\.com)$/i;

function loginPartition(provider) {
  return `persist:music-login-${provider}`;
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log', line);
}

function lanInterfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ name, address: net.address, netmask: net.netmask });
    }
  }
  return out;
}

function pickHost() {
  const override = store && store.get('mediaHost');
  if (override) return override;
  const ifaces = lanInterfaces();
  return ifaces.length ? ifaces[0].address : '127.0.0.1';
}

function updateRepo() {
  const custom = store ? store.get('updateRepo', '') : '';
  return String(custom || process.env.UPDATE_REPO || DEFAULT_REPO).trim();
}

function updateToken() {
  const stored = store ? store.get('githubToken', '') : '';
  return String(stored || process.env.GITHUB_TOKEN || '').trim();
}

function updateApiBase() {
  return process.env.GITHUB_API_BASE || DEFAULT_API;
}

function openTrusted(target) {
  let parsed;
  try {
    parsed = new URL(String(target));
  } catch (_) {
    throw new Error('链接地址无效');
  }
  const trusted = /(^|\.)(github\.com|githubusercontent\.com)$/i.test(parsed.hostname);
  if (parsed.protocol !== 'https:' || !trusted) throw new Error('只允许打开 GitHub 链接');
  return shell.openExternal(parsed.href);
}

function appInfo() {
  return {
    name: (pkg.build && pkg.build.productName) || '小爱音箱控制台',
    version: app.getVersion(),
    description: pkg.description || '',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osVersion: `${os.type()} ${os.release()}`,
    userData: app.getPath('userData'),
    repo: updateRepo(),
    repoUrl: `https://github.com/${updateRepo()}`,
    hasToken: !!updateToken(),
    autoCheck: store ? store.get('autoCheckUpdate', true) !== false : true,
    mediaPort: (media && media.port) || 0,
    license: pkg.license || '',
    copyright: `© ${new Date().getFullYear()} nieshilin`,
  };
}

async function runUpdateCheck({ silent = false } = {}) {
  if (updateState.checking) return updateState.result || { ok: false, error: '正在检查更新' };
  updateState.checking = true;
  const repo = updateRepo();
  try {
    const result = await checkUpdate({
      repo,
      token: updateToken(),
      current: app.getVersion(),
      apiBase: updateApiBase(),
    });
    updateState.result = result;
    if (!silent) {
      log(result.hasUpdate
        ? `检查更新：发现新版本 v${result.latest}（当前 v${result.current}）`
        : `检查更新：已是最新版本 v${result.current}`);
    } else if (result.hasUpdate) {
      log(`发现新版本 v${result.latest}，点右上角版本号查看更新内容`);
    }
    if (result.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:available', {
        current: result.current,
        latest: result.latest,
        url: (result.release && result.release.url) || '',
      });
    }
    return result;
  } catch (err) {
    const failed = { ok: false, error: err.message, repo, current: app.getVersion(), checkedAt: Date.now() };
    updateState.result = failed;
    if (!silent) log(`检查更新失败：${err.message}`);
    return failed;
  } finally {
    updateState.checking = false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#f6f6f7',
    title: '小爱音箱控制台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.argv.includes('--smoke')) {
    const problems = [];
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) problems.push(message);
      console.log(`[renderer:${level}] ${message}`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const probe = await mainWindow.webContents.executeJavaScript(
            `JSON.stringify({
              hasApi: typeof window.api === 'object',
              title: document.querySelector('h1') && document.querySelector('h1').textContent,
              status: document.getElementById('statusText').textContent,
              buttons: document.querySelectorAll('button').length,
              songs: document.querySelectorAll('#songList li').length,
              playlist: document.querySelectorAll('#playlist li').length,
              logLines: document.getElementById('log').childElementCount
            })`
          );
          console.log('SMOKE_PROBE ' + probe);
          const st = JSON.parse(probe);
          const okAll = st.hasApi && st.title.includes('小爱音箱') && st.buttons >= 12 && problems.length === 0;
          console.log(okAll ? 'SMOKE_OK' : 'SMOKE_FAIL ' + JSON.stringify(problems));
          app.exit(okAll ? 0 : 1);
        } catch (err) {
          console.log('SMOKE_FAIL ' + err.message);
          app.exit(1);
        }
      }, 2500);
    });
  }

  if (process.argv.includes('--shot')) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.env.SHOT_JS) {
            const rv = await mainWindow.webContents.executeJavaScript(process.env.SHOT_JS, true);
            console.log('SHOT_JS_RESULT ' + String(rv).slice(0, 200));
          }
          await new Promise((r) => setTimeout(r, 400));
          const img = await mainWindow.webContents.capturePage();
          const out = process.env.SHOT_PATH || path.join(__dirname, 'shot.png');
          fs.writeFileSync(out, img.toPNG());
          console.log('SHOT_SAVED ' + out);
        } catch (err) {
          console.log('SHOT_FAIL ' + err.message);
        }
        app.exit(0);
      }, 1500);
    });
  }

  if (process.argv.includes('--e2e')) {
    require('./scripts/e2e-probe')(mainWindow, app, log);
  }

  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function requireDevice() {
  if (!cloud.mina || !cloud.selected) throw new Error('云端通道未就绪：请先扫码登录并选择音箱');
  return cloud.selected;
}

function musicOf(name = musicBox.current) {
  if (!PROVIDERS[name]) throw new Error(`未知音源：${name}`);
  if (!musicBox.cache[name]) {
    musicBox.cache[name] = providerFor(name, {
      cookie: store.get(COOKIE_KEY[name], ''),
      ...(name === 'netease' ? { base: process.env.NETEASE_BASE || NETEASE_BASE } : {}),
      ...(name === 'qq' ? { base: process.env.QQ_SEARCH_BASE || QQ_BASE, apiBase: process.env.QQ_API_BASE || undefined } : {}),
    });
  }
  return musicBox.cache[name];
}

async function readLoginCookie(ses, page) {
  const cookies = await ses.cookies.get({});
  return buildCookieHeader(cookies, { match: page.match, priority: page.priority });
}

function saveMusicCookie(provider, cookie) {
  musicOf(provider).setCookie(cookie);
  store.setAll({ [COOKIE_KEY[provider]]: cookie });
}

async function clearLoginSession(provider) {
  try {
    const ses = session.fromPartition(loginPartition(provider));
    await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
  } catch (_) {
    /* 清除失败不影响退出逻辑 */
  }
}

const AUTO_CLICK_LOGIN = `
  setTimeout(() => {
    const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
    const target = nodes.find((node) => {
      const text = (node.textContent || '').trim();
      if (!/^(登录|立即登录|登陆)$/.test(text)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top < 560;
    });
    if (target) target.click();
  }, 800);
`;

async function openMusicLogin(provider) {
  const page = LOGIN_PAGES[provider];
  if (!page) throw new Error(`未知音源：${provider}`);
  if (loginWin && !loginWin.isDestroyed()) loginWin.close();

  const ses = session.fromPartition(loginPartition(provider));
  const cached = await readLoginCookie(ses, page).catch(() => '');
  if (cached && page.ready(cached)) {
    log(`${PROVIDERS[provider].label}：检测到已登录的网页会话，直接复用`);
    return { cookie: cached, reused: true };
  }

  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    parent: mainWindow || undefined,
    title: page.title,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition: loginPartition(provider),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  loginWin = win;
  win.setMenu(null);
  win.webContents.setUserAgent(UA_LOGIN);
  log(`已打开${PROVIDERS[provider].label}登录窗口，登录成功后会自动读取 Cookie`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let warmupWin = null;
    let warmupTimer = null;
    let warmupStarted = false;
    let hintTimer = null;
    let timer = null;
    let guard = null;
    let popupWin = null;

    const cleanup = () => {
      if (timer) clearInterval(timer);
      if (guard) clearTimeout(guard);
      if (warmupTimer) clearTimeout(warmupTimer);
      if (hintTimer) clearTimeout(hintTimer);
      if (warmupWin && !warmupWin.isDestroyed()) {
        try { warmupWin.close(); } catch (_) { /* ignore */ }
      }
      if (popupWin && !popupWin.isDestroyed()) {
        try { popupWin.close(); } catch (_) { /* ignore */ }
      }
      warmupWin = null;
      popupWin = null;
    };

    const stop = (err, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!win.isDestroyed()) win.close();
      loginWin = null;
      if (err) reject(err);
      else resolve(value);
    };

    const startWarmup = () => {
      if (settled || warmupStarted || !page.warmup) return;
      warmupStarted = true;
      warmupTimer = setTimeout(() => {
        warmupTimer = null;
        if (settled || win.isDestroyed()) return;
        log(`${PROVIDERS[provider].label}：账号已登录，正在唤醒播放凭证…`);
        warmupWin = new BrowserWindow({
          width: 720,
          height: 520,
          parent: win,
          show: false,
          autoHideMenuBar: true,
          webPreferences: {
            partition: loginPartition(provider),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          },
        });
        warmupWin.webContents.on('did-finish-load', () => setTimeout(check, 800));
        warmupWin.loadURL(page.warmup).catch(() => {});
      }, 1500);
    };

    const check = async () => {
      if (settled || win.isDestroyed()) return;
      let cookie;
      try {
        cookie = await readLoginCookie(ses, page);
      } catch (_) {
        return;
      }
      if (cookie && page.ready(cookie)) {
        await new Promise((r) => setTimeout(r, 450));
        const finalCookie = await readLoginCookie(ses, page).catch(() => cookie);
        const out = page.ready(finalCookie) ? finalCookie : cookie;
        await ses.flushStorageData().catch(() => {});
        log(`${PROVIDERS[provider].label}：已读取登录 Cookie（${out.split('; ').length} 项）`);
        stop(null, { cookie: out });
        return;
      }
      if (page.partial && cookie && page.partial(cookie)) startWarmup();
    };

    win.webContents.setWindowOpenHandler(({ url }) => {
      let host = '';
      try { host = new URL(url).hostname; } catch (_) { /* ignore */ }
      if (/^https?:/i.test(String(url || '')) && TRUSTED_LOGIN_HOST.test(host)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 720,
            height: 640,
            parent: win,
            autoHideMenuBar: true,
            webPreferences: {
              partition: loginPartition(provider),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
            },
          },
        };
      }
      if (/^https?:/i.test(String(url || ''))) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });

    win.webContents.on('did-create-window', (child) => {
      popupWin = child;
      child.webContents.on('did-finish-load', () => setTimeout(check, 600));
      child.on('closed', () => { if (popupWin === child) popupWin = null; });
    });

    win.webContents.on('did-finish-load', () => {
      check();
      win.webContents.executeJavaScript(AUTO_CLICK_LOGIN, true).catch(() => {});
    });

    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });

    win.on('closed', async () => {
      if (settled) return;
      const cookie = await readLoginCookie(ses, page).catch(() => '');
      if (cookie && page.ready(cookie)) stop(null, { cookie });
      else if (page.partial && cookie && page.partial(cookie)) {
        stop(new Error('QQ 账号已验证，但播放凭证未生成，请在窗口里点一次「播放」后再关闭'));
      } else {
        stop(new Error('登录窗口已关闭'));
      }
    });

    timer = setInterval(check, 1200);
    hintTimer = setTimeout(() => {
      if (!settled) log(`${PROVIDERS[provider].label}：5 分钟内未检测到登录态，可直接用「粘贴 Cookie」兜底`);
    }, 5 * 60 * 1000);
    guard = setTimeout(() => stop(new Error('登录超时（10 分钟），请重试')), 10 * 60 * 1000);

    const loadFirst = () => win.loadURL(page.url).catch((err) => {
      const message = String((err && err.message) || err || '');
      if (/HTTP2|PROTOCOL_ERROR|ERR_FAILED/i.test(message)) ses.clearCache().catch(() => {});
      if (page.fallback) return win.loadURL(page.fallback).catch(() => {});
      return null;
    });
    loadFirst();
  });
}

function musicStatus() {
  const out = {};
  for (const name of Object.keys(PROVIDERS)) {
    out[name] = { label: PROVIDERS[name].label, loggedIn: musicOf(name).loggedIn };
  }
  return { current: musicBox.current, providers: out };
}

async function finishCloudLogin(account) {
  store.setAll({ miToken: account.token });
  const mina = new MinaService(account, { minaBase: MINA, onLog: log });
  cloud.account = account;
  cloud.mina = mina;
  const devices = await mina.devices();
  cloud.devices = devices;
  log(`账号下找到 ${devices.length} 个小爱设备`);
  return devices.map((d) => ({
    id: d.deviceID || d.deviceId,
    name: d.name || d.alias || '未命名设备',
    hardware: d.hardware || '',
    model: d.model || '',
    online: d.presence === 'online' || d.presence === undefined,
  }));
}

function registerIpc() {
  ipcMain.handle('config:get', () => {
    const tk = store.get('miToken', {}) || {};
    return {
      volume: store.get('volume', 40),
      mediaHost: store.get('mediaHost', ''),
      hosts: lanInterfaces(),
      appVersion: app.getVersion(),
      volumeValue: store.get('volume', 40),
      hasCloudToken: !!tk.passToken,
      xiaomiUserId: tk.userId || '',
      hasNeteaseCookie: !!store.get('neteaseCookie', ''),
      music: musicStatus(),
      deviceName: store.get('deviceName', ''),
    };
  });

  ipcMain.handle('config:set', (_e, patch) => store.setAll(patch));

  ipcMain.handle('app:info', () => appInfo());

  ipcMain.handle('app:openRepo', () => openTrusted(`https://github.com/${updateRepo()}`));

  ipcMain.handle('update:state', () => ({
    ...appInfo(),
    checked: updateState.result,
    checking: updateState.checking,
    downloading: updateState.downloading,
  }));

  ipcMain.handle('update:check', () => runUpdateCheck());

  ipcMain.handle('update:config', (_e, { repo, token, autoCheck } = {}) => {
    const patch = {};
    if (repo !== undefined) patch.updateRepo = String(repo || '').trim() ? normalizeRepo(repo) : '';
    if (token !== undefined) patch.githubToken = String(token || '').trim();
    if (autoCheck !== undefined) patch.autoCheckUpdate = !!autoCheck;
    store.setAll(patch);
    const info = appInfo();
    updateState.result = null;
    log(`更新源已设为 ${info.repo}${info.hasToken ? '（已配置 Token）' : '（未配置 Token）'}`);
    return info;
  });

  ipcMain.handle('update:openRelease', () => {
    const rel = updateState.result && updateState.result.release;
    return openTrusted((rel && rel.url) || `https://github.com/${updateRepo()}/releases`);
  });

  ipcMain.handle('update:download', async () => {
    const st = updateState.result;
    if (!st || !st.ok || !st.hasUpdate) throw new Error('请先检查更新');
    if (updateState.downloading) throw new Error('安装包正在下载中');
    if (!st.asset) {
      log('该版本没有附带安装包，已打开发布页');
      await openTrusted(st.release.url || `https://github.com/${updateRepo()}/releases`);
      return { opened: true };
    }
    const dir = store.get('downloadDir', '') || process.env.UPDATE_DOWNLOAD_DIR || app.getPath('downloads');
    updateState.downloading = true;
    log(`开始下载 ${st.asset.name}（${Math.round((st.asset.size || 0) / 1024 / 1024)}MB）→ ${dir}`);
    try {
      const saved = await downloadAsset(st.asset, {
        token: updateToken(),
        destDir: dir,
        onProgress: (p) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:progress', p);
        },
      });
      log(`✓ 安装包已保存：${saved.file}`);
      shell.showItemInFolder(saved.file);
      return { ...saved };
    } catch (err) {
      log(`下载安装包失败：${err.message}`);
      throw err;
    } finally {
      updateState.downloading = false;
    }
  });

  ipcMain.handle('cloud:resume', async () => {
    const stored = store.get('miToken', {}) || {};
    if (!stored.passToken) throw new Error('本机没有保存的登录态，请先扫码登录');
    log('检测到上次的登录态，正在自动恢复云端连接…');
    const account = new MiAccount({ token: stored, accountBase: ACCOUNT, onLog: log });
    await account.login('micoapi');
    return { devices: await finishCloudLogin(account), userId: account.token.userId };
  });

  ipcMain.handle('cloud:qrStart', async () => {
    const account = new MiAccount({
      token: (store.get('miToken', {}) || {}),
      accountBase: ACCOUNT,
      onLog: log,
    });
    cloud.qrAccount = account;
    const r = await account.qrStart('micoapi');
    const image = await account.qrImage(r.qr);
    log('已生成登录二维码（有效期约 5 分钟），请用米家 App 扫码');
    return { image, timeout: r.timeout };
  });

  ipcMain.handle('cloud:qrWait', async () => {
    const account = cloud.qrAccount;
    if (!account) throw new Error('请先生成登录二维码');
    await account.qrWait({
      onQr: (image) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cloud:qr', { image });
      },
    });
    cloud.qrAccount = null;
    return { devices: await finishCloudLogin(account), userId: account.token.userId };
  });

  ipcMain.handle('cloud:logout', async () => {
    cloud.account = null;
    cloud.mina = null;
    cloud.devices = [];
    cloud.selected = null;
    cloud.qrAccount = null;
    store.setAll({ miToken: {}, deviceName: '' });
    log('已退出小米账号');
    return true;
  });

  ipcMain.handle('cloud:select', async (_e, { id, name, hardware } = {}) => {
    if (!id) throw new Error('请选择小爱音箱');
    cloud.selected = { id, name: name || '小爱音箱', hardware: hardware || '' };
    store.setAll({ deviceName: name || '' });
    log(`已选定音箱：${cloud.selected.name}${hardware ? `（${hardware}）` : ''}`);
    return { name: cloud.selected.name, hardware: cloud.selected.hardware };
  });

  ipcMain.handle('player:action', async (_e, { action, value } = {}) => {
    const dev = requireDevice();
    const mina = cloud.mina;
    let result;

    switch (action) {
      case 'playUrl': {
        const url = String(value || '').trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('播放地址必须是 http:// 或 https:// 开头');
        result = await mina.playUrl(dev.id, url, dev.hardware);
        log(`${result ? '✓' : '×'} 下发播放地址 → ${url}`);
        if (!result) throw new Error('音箱拒绝了这条播放指令');
        return { ok: true, url };
      }
      case 'pause': result = await mina.pause(dev.id); break;
      case 'resume': result = await mina.play(dev.id); break;
      case 'stop': result = await mina.stop(dev.id); break;
      case 'status': {
        const st = await mina.status(dev.id);
        return { ok: true, status: st };
      }
      case 'tts': {
        const text = String(value || '').trim();
        if (!text) throw new Error('请输入要播报的文字');
        result = await mina.textToSpeech(dev.id, text);
        break;
      }
      case 'volume': {
        const v = Math.max(0, Math.min(100, Math.round(Number(value))));
        result = await mina.setVolume(dev.id, v);
        if (result) store.set('volume', v);
        log(`${result ? '✓' : '×'} 设置音量 ${v}`);
        return { ok: !!result, volume: v };
      }
      default:
        throw new Error(`未知动作：${action}`);
    }

    log(`${result ? '✓' : '×'} 云端指令 ${action}`);
    if (!result) throw new Error(`音箱执行 ${action} 失败（可能离线或该型号不支持）`);
    return { ok: true };
  });

  ipcMain.handle('music:state', () => musicStatus());

  ipcMain.handle('music:provider', (_e, { provider } = {}) => {
    if (!PROVIDERS[provider]) throw new Error(`未知音源：${provider}`);
    musicBox.current = provider;
    log(`已切换到${PROVIDERS[provider].label}`);
    return musicStatus();
  });

  ipcMain.handle('music:login', async (_e, { provider } = {}) => {
    const name = provider || musicBox.current;
    let got;
    try {
      got = await openMusicLogin(name);
    } catch (err) {
      if (/已关闭/.test(err.message)) throw new Error('已取消登录');
      throw err;
    }
    saveMusicCookie(name, got.cookie);
    const profile = await musicOf(name).profile().catch(() => null);
    log(`✓ ${PROVIDERS[name].label}登录成功${profile && profile.nickname ? `：${profile.nickname}` : ''}`);
    return { ...musicStatus(), profile };
  });

  ipcMain.handle('music:logout', async (_e, { provider } = {}) => {
    const name = provider || musicBox.current;
    saveMusicCookie(name, '');
    await clearLoginSession(name);
    log(`已退出${PROVIDERS[name].label}`);
    return musicStatus();
  });

  ipcMain.handle('music:cookie', async (_e, { provider, cookie } = {}) => {
    const name = provider || musicBox.current;
    const parsed = normalizeCookie(name, cookie);
    if (!parsed.ok) throw new Error(parsed.reason);
    const c = parsed.cookie;
    saveMusicCookie(name, c);
    const inst = musicOf(name);
    const profile = c ? await inst.profile().catch(() => null) : null;
    log(c
      ? `${PROVIDERS[name].label} Cookie 已保存${profile && profile.nickname ? `（${profile.nickname}）` : ''}`
      : `已清除${PROVIDERS[name].label} Cookie`);
    return { ...musicStatus(), profile, hasCookie: !!c };
  });

  ipcMain.handle('music:search', async (_e, { keywords, limit, offset, provider } = {}) => {
    const name = provider || musicBox.current;
    if (PROVIDERS[name]) musicBox.current = name;
    const songs = await musicOf(name).search(keywords, { limit: limit || 30, offset: offset || 0 });
    log(`${PROVIDERS[name].label}搜索「${keywords}」→ ${songs.length} 首`);
    return songs;
  });

  ipcMain.handle('music:play', async (_e, { id, name, provider } = {}) => {
    const dev = requireDevice();
    const src = provider || musicBox.current;
    const picked = await musicOf(src).songUrl(id);
    const direct = picked.url.replace(/^http:/, 'https:');
    log(`解析音源：${name || id}${picked.trial ? '（试听片段）' : `（${Math.round(picked.br / 1000)}kbps）`}`);
    let url = direct;
    if (media && media.port) {
      url = media.proxyUrl(src, id, pickHost());
      log(`转本地代理：${url.replace(/^http:\/\//, '')}`);
    }
    const ok = await cloud.mina.playUrl(dev.id, url, dev.hardware);
    if (!ok) throw new Error('音箱拒绝播放该音源');
    log(`✓ 已让音箱播放：${name || id}`);
    setTimeout(async () => {
      try {
        const st = await cloud.mina.status(dev.id);
        if (st.status !== 1) log(`⚠ 音箱未进入播放态（status=${st.status}），请检查电脑与音箱是否同一局域网、防火墙是否放行 ${media ? media.port : 8931} 端口`);
      } catch (_) {
        /* 状态探测失败不影响播放 */
      }
    }, 2500);
    return { ok: true, url, direct, trial: picked.trial, br: picked.br };
  });

  ipcMain.handle('media:pick', async () => {
    if (!mainWindow) return [];
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择音乐文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '音频文件', extensions: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'ape', 'wma'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths.length) return [];
    await media.start();
    const items = [];
    for (const p of filePaths) {
      try {
        const id = media.addFile(p);
        items.push({ id, path: p, name: path.basename(p), size: fs.statSync(p).size });
      } catch (err) {
        log(`跳过 ${p}：${err.message}`);
      }
    }
    return items;
  });

  ipcMain.handle('media:status', async () => {
    await media.start();
    const host = pickHost();
    return { port: media.port, host, url: `http://${host}:${media.port}/` };
  });

  ipcMain.handle('media:playLocal', async (_e, { id, name } = {}) => {
    const dev = requireDevice();
    if (!id) throw new Error('缺少媒体 id');
    await media.start();
    const url = media.urlFor(id, pickHost());
    log(`本地文件播放 → ${url}`);
    const ok = await cloud.mina.playUrl(dev.id, url, dev.hardware);
    if (!ok) throw new Error('音箱拒绝播放该文件（检查防火墙是否放行本程序的专用网络）');
    log(`✓ 已让音箱播放本地文件：${name || id}`);
    return { ok: true, url };
  });
}

const isTestMode = ['--smoke', '--shot', '--e2e'].some((f) => process.argv.includes(f));
if (isTestMode) app.setPath('userData', path.join(os.tmpdir(), `xiaoai-test-${Date.now()}`));

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  store = new Store(app.getPath('userData'));
  media = new MediaServer({ port: 8931, onLog: log });
  media.registerResolver('qq', (mid) => musicOf('qq').songUrl(mid));
  media.registerResolver('netease', (sid) => musicOf('netease').songUrl(sid));

  registerIpc();
  createWindow();

  if (!isTestMode && store.get('autoCheckUpdate', true) !== false) {
    setTimeout(() => {
      runUpdateCheck({ silent: true }).catch(() => {});
    }, 3500);
  }

  media.start()
    .then(() => {
      log(`媒体服务地址：http://${pickHost()}:${media.port}（音箱需能访问该地址）`);
      log('提示：首次播放本地文件若失败，请在 Windows 防火墙中允许本程序的“专用网络”入站。');
    })
    .catch((err) => log(`媒体服务启动失败：${err.message}`));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (media) media.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (media) media.stop();
});
