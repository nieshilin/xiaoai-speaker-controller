'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { MiAccount, MinaService, ACCOUNT_BASE, MINA_BASE, MINA_BASE_ALT } = require('./src/mina');
const { PROVIDERS, providerFor, NETEASE_BASE, QQ_BASE } = require('./src/music');
const { createQishuiQrLoginBridge } = require('./src/qishui/qishuiLogin');
const { MediaServer } = require('./src/mediaServer');
const { synthesize, MAX_TOTAL } = require('./src/speech');
const { Store } = require('./src/store');
const { normalizeVolume } = require('./src/volumeSync');
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
// 汽水登录态实测结果：null=未检测 true=有效 false=已过期（probe 拿不到昵称）
let qishuiSessionValid = null;
const updateState = { result: null, checking: false, downloading: false };

/* 歌单连播队列：按顺序解析音源 → 推给音箱 → 轮询状态等待播完 → 下一首 */
const playQueue = {
  items: [],
  index: -1,
  running: false,
  stopFlag: false,
  paused: false,
  title: '',
};

const UA_LOGIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const COOKIE_KEY = { netease: 'neteaseCookie', qq: 'qqCookie', qishui: 'qishuiCookie' };
/** 汽水音乐需要的额外签名头（客户端每次请求现算，只能由用户抓包提供） */
const QISHUI_KEY = { helios: 'qishuiHelios', medusa: 'qishuiMedusa', deviceId: 'qishuiDeviceId' };
/** 汽水取不到完整音源时，用 QQ / 网易云的同名曲目兜底播放 */
const QISHUI_FALLBACK_KEY = 'qishuiFallback';
const TTS_VIA_AUDIO = new Set(['L05B', 'L05C', 'LX04', 'LX01', 'S12', 'S12A']);

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

const AUTHOR_BLOG = 'https://www.xiaonie.me/';
const SHORTCUT_NAME = 'Xiao Ai Speaker';

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
  const trusted = /(^|\.)(github\.com|githubusercontent\.com|xiaonie\.me)$/i.test(parsed.hostname);
  if (parsed.protocol !== 'https:' || !trusted) throw new Error('只允许打开项目与作者的可信链接');
  return shell.openExternal(parsed.href);
}

function appInfo() {
  return {
    name: (pkg.build && pkg.build.productName) || 'Xiao Ai Speaker',
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
    autoCheck: store ? store.get('autoCheckUpdate', true) !== false : true,
    mediaPort: (media && media.port) || 0,
    mediaHost: media && media.port ? pickHost() : '',
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
    title: 'Xiao Ai Speaker',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
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
              title: document.querySelector('.rail-brand-text strong') && document.querySelector('.rail-brand-text strong').textContent,
              view: document.querySelector('h1') && document.querySelector('h1').textContent,
              status: document.getElementById('statusText').textContent,
              buttons: document.querySelectorAll('button').length,
              songs: document.querySelectorAll('#songList li').length,
              playlist: document.querySelectorAll('#playlist li').length,
              logLines: document.getElementById('log').childElementCount
            })`
          );
          console.log('SMOKE_PROBE ' + probe);
          const st = JSON.parse(probe);
          const okAll = st.hasApi && (st.title.includes('Xiao Ai') || st.title.includes('小爱')) && st.buttons >= 12 && problems.length === 0;
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

/** 汽水扫码登录桥：配置落在 userData，登录态与 store 里的 Cookie 双向同步 */
let qishuiLoginBridge = null;
function qishuiAuth() {
  if (!qishuiLoginBridge) {
    qishuiLoginBridge = createQishuiQrLoginBridge({
      configFile: path.join(app.getPath('userData'), 'qishui-login.json'),
    });
  }
  return qishuiLoginBridge;
}

function musicOf(name = musicBox.current) {
  if (!PROVIDERS[name]) throw new Error(`未知音源：${name}`);
  if (!musicBox.cache[name]) {
    musicBox.cache[name] = providerFor(name, {
      cookie: store.get(COOKIE_KEY[name], ''),
      ...(name === 'netease' ? { base: process.env.NETEASE_BASE || NETEASE_BASE } : {}),
      ...(name === 'qq' ? { base: process.env.QQ_SEARCH_BASE || QQ_BASE, apiBase: process.env.QQ_API_BASE || undefined } : {}),
      ...(name === 'qishui' ? {
        helios: store.get(QISHUI_KEY.helios, ''),
        medusa: store.get(QISHUI_KEY.medusa, ''),
        deviceId: store.get(QISHUI_KEY.deviceId, ''),
      } : {}),
    });
  }
  return musicBox.cache[name];
}

/** 保存汽水的签名凭证；只覆盖传入的字段（留空=不改），任意变化都重建实例 */
function saveQishuiKeys({ helios, medusa, deviceId } = {}) {
  const patch = {};
  if (helios !== undefined) patch[QISHUI_KEY.helios] = String(helios || '').trim();
  if (medusa !== undefined) patch[QISHUI_KEY.medusa] = String(medusa || '').trim();
  if (deviceId !== undefined) patch[QISHUI_KEY.deviceId] = String(deviceId || '').trim();
  if (Object.keys(patch).length) store.setAll(patch);
  delete musicBox.cache.qishui;
  return {
    helios: store.get(QISHUI_KEY.helios, ''),
    medusa: store.get(QISHUI_KEY.medusa, ''),
    deviceId: store.get(QISHUI_KEY.deviceId, ''),
  };
}

async function readLoginCookie(ses, page) {
  const cookies = await ses.cookies.get({});
  return buildCookieHeader(cookies, { match: page.match, priority: page.priority });
}

function saveMusicCookie(provider, cookie) {
  musicOf(provider).setCookie(cookie);
  store.setAll({ [COOKIE_KEY[provider]]: cookie });
  if (provider === 'qishui') {
    try { qishuiAuth().setCookie(cookie); } catch (_) { /* 扫码桥未初始化时忽略 */ }
    qishuiSessionValid = null; // 换了 Cookie 就重新校验
    validateQishuiSession();
  }
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
    const inst = musicOf(name);
    out[name] = {
      label: PROVIDERS[name].label,
      loggedIn: inst.loggedIn,
      ...(name === 'qishui'
        ? {
          signed: inst.hasSignature,
          // 取流走 web 网关，只要登录 Cookie 就够；签名头只在搜索等 PC 接口才需要
          ready: inst.loggedIn,
          canSearch: inst.loggedIn && inst.hasSignature,
          hasHelios: !!inst.helios,
          hasMedusa: !!inst.medusa,
          deviceId: inst.deviceId || '',
          fallback: fallbackEnabled(),
          // 实测校验过会话已失效（probe 拿不到昵称），提示用户重新扫码
          expired: inst.loggedIn && qishuiSessionValid === false,
          trialHint: !!inst.trialHint,
        }
        : {}),
    };
  }
  return { current: musicBox.current, providers: out };
}

/** 实测校验汽水会话是否还有效（Cookie 过期时汽水不报错，只悄悄降级成试听，必须主动探测） */
async function validateQishuiSession() {
  const qs = musicOf('qishui');
  if (!qs.cookie || !qs.loggedIn) { qishuiSessionValid = null; return null; }
  try {
    await qs.probe();
    qishuiSessionValid = true;
    if (qs.trialHint) {
      qs.trialHint = false;
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    // 网络抖动不下「已过期」的结论，只有接口明确回绝（空响应/HTTP 4xx/读不到账号）才算
    if (/socket|timeout|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|hang up|HTTP 5\d\d/i.test(msg)) {
      qishuiSessionValid = null;
    } else {
      qishuiSessionValid = false;
      log(`⚠ 汽水登录态已失效（${msg}），请到「汽水」页重新扫码登录`);
      pushMusicStatus();
    }
  }
  return qishuiSessionValid;
}

function pushMusicStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('music:changed', musicStatus()); } catch (_) { /* 窗口已关 */ }
  }
}

/* ---------- 歌单连播 ---------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function queueState() {
  return {
    running: playQueue.running,
    paused: playQueue.paused,
    index: playQueue.index,
    total: playQueue.items.length,
    current: playQueue.items[playQueue.index] || null,
    title: playQueue.title,
  };
}

function pushQueueState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('playlist:progress', queueState());
  }
}

function fallbackEnabled() {
  return store.get(QISHUI_FALLBACK_KEY, true) !== false;
}

/** 曲名归一化：去掉括号补充说明（(Live)/(女声版)…）和标点，避免同名曲匹配不上 */
function normalizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(\[【].*?[）)\]】]/g, '')
    .replace(/[\s\-_·・,，.。!！?？'"“”‘’/\\|:：;；+&]/g, '');
}

function artistTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[\/、,&;；]+|\s{2,}/)
    .map((s) => normalizeTitle(s))
    .filter(Boolean);
}

function artistsMatch(a, b) {
  const left = artistTokens(a);
  const right = artistTokens(b);
  if (!left.length || !right.length) return true; // 缺歌手信息时不因此否决
  return left.some((x) => right.some((y) => x.includes(y) || y.includes(x)));
}

/** 在 QQ / 网易云里找同名同歌手的曲目，用于汽水取不到完整音源时的兜底 */
async function findSameSong(song) {
  const title = normalizeTitle(song.name);
  if (!title) return null;
  const artist = artistTokens(song.artists)[0] || '';
  for (const name of ['qq', 'netease']) {
    let list = [];
    try {
      list = await musicOf(name).search(`${song.name} ${artist}`.trim(), { limit: 8 });
    } catch (_) {
      continue;
    }
    const hit = (list || []).find((s) => normalizeTitle(s.name) === title && artistsMatch(s.artists, song.artists));
    if (!hit) continue;
    try {
      const picked = await musicOf(name).songUrl(hit.id);
      if (picked && picked.url && !picked.trial) {
        return { provider: name, id: hit.id, name: hit.name, artists: hit.artists, picked };
      }
    } catch (_) {
      /* 这个音源没有版权，试下一个 */
    }
  }
  return null;
}

async function resolveSongUrl(song) {
  const src = song.provider || musicBox.current;
  let picked = null;
  let firstError = null;
  try {
    picked = await musicOf(src).songUrl(song.id);
  } catch (err) {
    firstError = err;
  }

  let alt = null;
  const needAlt = src === 'qishui' && fallbackEnabled() && song.name && (!picked || picked.trial);
  if (needAlt) {
    alt = await findSameSong(song).catch(() => null);
    if (alt) {
      picked = alt.picked;
      log(`汽水音源不可用，改用${PROVIDERS[alt.provider].label}同名曲目：${alt.name}${alt.artists ? ` - ${alt.artists}` : ''}`);
    }
  }
  if (!picked) {
    if (src === 'qishui' && fallbackEnabled() && song.name) {
      throw new Error(
        `${firstError ? firstError.message : '汽水未给完整音源'}；同名曲兜底也没在 QQ / 网易云找到可播放的版本，可换一首试试`,
      );
    }
    throw firstError || new Error('这首歌暂时取不到播放地址');
  }

  const useProvider = alt ? alt.provider : src;
  const useId = alt ? alt.id : song.id;
  let url = picked.url.replace(/^http:/, 'https:');
  if (media && media.port) url = media.proxyUrl(useProvider, useId, pickHost());
  return {
    url,
    trial: !!picked.trial,
    br: picked.br || 0,
    encrypted: !!picked.encrypted,
    provider: useProvider,
    matched: alt ? { provider: alt.provider, label: PROVIDERS[alt.provider].label, name: alt.name, artists: alt.artists } : null,
  };
}

async function stopQueue(waitMs = 6000) {
  if (!playQueue.running) return;
  playQueue.stopFlag = true;
  const deadline = Date.now() + waitMs;
  while (playQueue.running && Date.now() < deadline) await sleep(200);
}

async function waitSongEnd(dev, song, startedAt = Date.now()) {
  // 音箱播放状态：1=播放中 2=暂停 0/-1=空闲。连续两次非播放态视为播完。
  //
  // 汽水/代理音源的坑：有些固件在拉加密转码流时状态回报会滞后甚至一直报 1/拿不到，
  // 只靠状态轮询会让连播「停在当前这首不动」。所以再叠一层时长兜底：
  // 知道曲目长度就按「时长 + 25s 容差」判定结束；状态长时间取不到也按超时放行。
  const durationMs = Number(song && song.duration) || 0;
  let deadline = durationMs > 0 ? startedAt + durationMs + 25000 : 0;
  let idle = 0;
  let unknown = 0;
  let pausedAt = 0;
  await sleep(4000); // 起播缓冲
  for (let i = 0; i < 3600; i++) {
    if (playQueue.stopFlag) return;
    // 用户点了暂停：不算播完，保持当前曲目等待恢复（否则会误判为空闲而跳下一首）
    if (playQueue.paused) {
      idle = 0;
      if (!pausedAt) pausedAt = Date.now();
      await sleep(1000);
      continue;
    }
    // 恢复播放：暂停了多久就把时长兜底往后顺延多久
    if (pausedAt) {
      if (deadline) deadline += Date.now() - pausedAt;
      pausedAt = 0;
    }
    if (deadline && Date.now() > deadline) {
      log(`⏱ 按曲目时长判定「${song.name || ''}」播放结束（${Math.round(durationMs / 1000)}s）`);
      return;
    }
    let s = null;
    try {
      const st = await cloud.mina.status(dev.id);
      s = st && typeof st.status === 'number' ? st.status : null;
    } catch (_) { /* 状态获取失败按继续等待处理 */ }
    if (s === 1) { idle = 0; unknown = 0; }
    else if (s !== null) {
      idle += 1;
      if (idle >= 2) return;
    } else {
      // 状态一直取不到：既没时长兜底又超过约 3 分钟，就当作本首结束，别把队列卡死
      unknown += 1;
      if (!deadline && unknown >= 60) {
        log(`⚠ 长时间取不到「${song.name || ''}」的播放状态，先继续下一首`);
        return;
      }
    }
    await sleep(3000);
  }
}

async function playQueueLoop(dev) {
  playQueue.running = true;
  playQueue.stopFlag = false;
  playQueue.paused = false;
  log(`▶ 开始连播「${playQueue.title}」（共 ${playQueue.items.length} 首）`);
  pushQueueState();
  let hinted = false;
  let consecutiveFails = 0;
  try {
    while (!playQueue.stopFlag && playQueue.index < playQueue.items.length - 1) {
      playQueue.index += 1;
      const song = playQueue.items[playQueue.index];
      try {
        if (playQueue.stopFlag) break;
        const { url, trial } = await resolveSongUrl(song);
        // 取址是网络请求，期间用户可能已经点了「停止连播」，别再下发下一首
        if (playQueue.stopFlag) break;
        const ok = await cloud.mina.playUrl(dev.id, url, dev.hardware);
        if (!ok) throw new Error('音箱拒绝播放该音源');
        const startedAt = Date.now();
        log(`▶ 歌单 ${playQueue.index + 1}/${playQueue.items.length}：${song.name}${song.artists ? ` - ${song.artists}` : ''}${trial ? '（试听片段）' : ''}`);
        if (trial && (song.provider || musicBox.current) === 'qishui') {
          // 汽水对过期 Cookie 不报错，只悄悄降级成 29s 试听：在这里点破，别让用户猜
          log('⚠ 汽水只给了试听片段：登录多半已过期或该曲需 VIP，建议重新扫码登录');
          if (qishuiSessionValid !== false) validateQishuiSession();
        }
        pushQueueState();
        await waitSongEnd(dev, song, startedAt);
        consecutiveFails = 0;
      } catch (err) {
        consecutiveFails += 1;
        log(`⚠ 跳过「${song.name}」：${err.message}`);
        if (!hinted) {
          hinted = true;
          if (/会员|VIP|权限|登录|Cookie|音源/i.test(err.message)) {
            log('提示：请检查音乐账号是否已登录，建议重新登录，并确认该账号有对应的 VIP 权益');
          }
        }
        // 连续取不到就刹车：与其静默跳完整张歌单，不如明确告诉用户哪里坏了
        if (consecutiveFails >= 3) {
          log(`✗ 连续 ${consecutiveFails} 首取不到可用音源，已停止连播（${err.message}）`);
          if (/汽水|试听|登录/i.test(err.message)) log('提示：到「汽水」页重新扫码登录后，再点「播放全部」');
          break;
        }
      }
    }
  } finally {
    const stopped = playQueue.stopFlag;
    playQueue.running = false;
    playQueue.paused = false;
    log(stopped ? '■ 已停止歌单连播' : '✓ 歌单连播完毕');
    pushQueueState();
  }
}


async function finishCloudLogin(account) {
  store.setAll({ miToken: account.token });
  const mina = new MinaService(account, {
    minaBase: MINA,
    minaFallback: process.env.XIAOMI_MINA_BASE ? null : MINA_BASE_ALT,
    onLog: log,
  });
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
      ttsMode: store.get('ttsMode', 'auto'),
    };
  });

  ipcMain.handle('config:set', (_e, patch) => store.setAll(patch));

  ipcMain.handle('app:info', () => appInfo());

  ipcMain.handle('app:openRepo', () => openTrusted(`https://github.com/${updateRepo()}`));

  ipcMain.handle('app:openBlog', () => openTrusted(AUTHOR_BLOG));

  ipcMain.handle('app:createShortcut', () => {
    if (!app.isPackaged) throw new Error('开发模式下无法创建快捷方式，请使用安装版或便携版程序');
    const name = `${SHORTCUT_NAME}.lnk`;
    const target = process.execPath;
    const options = {
      target,
      cwd: path.dirname(target),
      icon: target,
      iconIndex: 0,
      description: '小爱音箱控制台',
      appUserModelId: 'com.local.xiaomi.speaker',
    };
    const created = [];
    for (const dir of [app.getPath('desktop'), app.getPath('appData') + '\\Microsoft\\Windows\\Start Menu\\Programs']) {
      const file = path.join(dir, name);
      try {
        const ok = shell.writeShortcutLink(file, 'create', options);
        if (ok) created.push(file);
      } catch (err) {
        log(`创建快捷方式失败（${dir}）：${err.message}`);
      }
    }
    if (!created.length) throw new Error('创建快捷方式失败，请检查桌面与开始菜单目录权限');
    log(`✓ 已创建快捷方式：${created.join('、')}`);
    return { ok: true, files: created };
  });

  ipcMain.handle('update:state', () => ({
    ...appInfo(),
    checked: updateState.result,
    checking: updateState.checking,
    downloading: updateState.downloading,
  }));

  ipcMain.handle('update:check', () => runUpdateCheck());

  ipcMain.handle('update:config', (_e, { repo, autoCheck } = {}) => {
    const patch = {};
    if (repo !== undefined) patch.updateRepo = String(repo || '').trim() ? normalizeRepo(repo) : '';
    if (autoCheck !== undefined) patch.autoCheckUpdate = !!autoCheck;
    store.setAll(patch);
    const info = appInfo();
    updateState.result = null;
    log(`更新源已设为 ${info.repo}`);
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
      case 'pause':
        result = await mina.pause(dev.id);
        if (result && playQueue.running) { playQueue.paused = true; pushQueueState(); }
        break;
      case 'resume':
        result = await mina.play(dev.id);
        if (result && playQueue.running) { playQueue.paused = false; pushQueueState(); }
        break;
      case 'stop':
        result = await mina.stop(dev.id);
        if (playQueue.running) { playQueue.stopFlag = true; pushQueueState(); }
        break;
      case 'status': {
        const st = await mina.status(dev.id);
        // 手机 APP / 语音指令改过音量后，查询到的是设备真实值：
        // 归一化后回写，渲染层据此同步滑块（对应 issue #2：UI 不同步）
        const rawVol = st && typeof st === 'object' ? st.volume : undefined;
        const vol = normalizeVolume(rawVol);
        if (vol !== null) {
          if (st && typeof st === 'object') st.volume = vol;
          store.set('volume', vol);
        }
        return { ok: true, status: st, volume: vol };
      }
      case 'tts': {
        const text = String(value || '').trim();
        if (!text) throw new Error('请输入要播报的文字');
        if (text.length > MAX_TOTAL) throw new Error(`播报文字请控制在 ${MAX_TOTAL} 字以内`);
        const mode = store.get('ttsMode', 'auto');
        const model = String(dev.hardware || '').toUpperCase();
        let useAudio = mode === 'audio' || (mode === 'auto' && TTS_VIA_AUDIO.has(model));
        let via = '';
        if (!useAudio) {
          try {
            const r = await mina.textToSpeech(dev.id, text);
            via = r.method === 'text_to_speech' ? '云端 TTS' : '云端 TTS（兼容模式）';
          } catch (err) {
            log(`云端 TTS 未被设备接受：${err.message}`);
            useAudio = true;
          }
        }
        if (useAudio) {
          await media.start();
          const voice = await synthesize(text, { dir: path.join(app.getPath('temp'), 'xiaoai-tts') });
          const mediaId = media.addFile(voice.file);
          const url = media.urlFor(mediaId, pickHost());
          log(`已合成语音 ${voice.segments} 段（${Math.round(voice.bytes / 1024)}KB），经本地服务播报`);
          const ok = await mina.playUrl(dev.id, url, dev.hardware);
          if (!ok) throw new Error('音箱拒绝播放播报音频（检查局域网与防火墙专用网络放行）');
          via = '本地合成播报';
        }
        log(`✓ 语音播报（${via}）：${text.slice(0, 24)}${text.length > 24 ? '…' : ''}`);
        return { ok: true, mode: via };
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
    if (name === 'qishui') {
      throw new Error('汽水音乐请用「扫码登录」：点登录按钮后用汽水音乐 App 扫二维码');
    }
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
    if (name === 'qishui') await qishuiAuth().clear().catch(() => {});
    log(`已退出${PROVIDERS[name].label}`);
    return musicStatus();
  });

  /* 汽水扫码登录：生成二维码 → 前端轮询 → 成功后自动保存 Cookie */
  ipcMain.handle('qishui:qr', async () => {
    const result = await qishuiAuth().createQrCode();
    const data = (result && result.data) || {};
    log('已生成汽水音乐登录二维码，请用汽水音乐 App 扫码');
    return {
      token: String(data.token || ''),
      qrcode: String(data.qrcode || ''),
      scanUrl: String(data.scan_url || ''),
      expireAt: Number(data.expire_time || 0),
    };
  });

  ipcMain.handle('qishui:qrCheck', async (_e, { token } = {}) => {
    let result;
    try {
      result = await qishuiAuth().checkQrConnect(token);
    } catch (err) {
      // 用户关掉二次验证窗口：返回明确状态，避免前端立刻重新拉起验证
      if (err && err.code === 'QISHUI_MFA_CANCELLED') {
        log('汽水二次验证已取消，等待用户刷新二维码');
        return {
          confirmed: false,
          cancelled: true,
          status: 'mfa_cancelled',
          expired: false,
          message: String(err.message || '二次验证未完成'),
        };
      }
      throw err;
    }
    const data = (result && result.data) || {};
    if (data.confirmed) {
      const cookie = qishuiAuth().getCookie();
      if (!cookie) throw new Error('扫码已确认，但没读到登录 Cookie，请刷新二维码重试');
      saveMusicCookie('qishui', cookie);
      const profile = await musicOf('qishui').profile()
        .then((p) => { qishuiSessionValid = true; return p; })
        .catch(() => { qishuiSessionValid = false; return null; });
      log(`✓ 汽水音乐登录成功${profile && profile.nickname ? `：${profile.nickname}` : ''}`);
      return { confirmed: true, ...musicStatus(), profile };
    }
    const status = String(data.status || '');
    return {
      confirmed: false,
      status,
      expired: status === 'expired' || Number(data.error_code) === 2,
      message: String(data.description || (result && result.message) || ''),
    };
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

  ipcMain.handle('music:keys', async (_e, keys = {}) => {
    const saved = saveQishuiKeys(keys || {});
    log(`汽水音乐签名凭证已保存（X-Helios ${saved.helios ? '✓' : '×'} / X-Medusa ${saved.medusa ? '✓' : '×'}）`);
    return musicStatus();
  });

  ipcMain.handle('music:search', async (_e, { keywords, limit, offset, provider } = {}) => {
    const name = provider || musicBox.current;
    // 显式指定音源（例如汽水独立界面）时不改动「音乐」页当前选中的音源
    if (PROVIDERS[name] && !provider) musicBox.current = name;
    const songs = await musicOf(name).search(keywords, { limit: limit || 30, offset: offset || 0 });
    log(`${PROVIDERS[name].label}搜索「${keywords}」→ ${songs.length} 首`);
    return songs;
  });

  ipcMain.handle('music:play', async (_e, { id, name, artists, provider } = {}) => {
    const dev = requireDevice();
    const src = provider || musicBox.current;
    const resolved = await resolveSongUrl({ id, name, artists, provider: src });
    log(`解析音源：${name || id}${resolved.trial ? '（试听片段）' : `（${Math.round(resolved.br / 1000)}kbps${resolved.encrypted ? ' · 内存解密' : ''}）`}${resolved.matched ? ` · 来自${resolved.matched.label}` : ''}`);
    const ok = await cloud.mina.playUrl(dev.id, resolved.url, dev.hardware);
    if (!ok) throw new Error('音箱拒绝播放该音源');
    log(`✓ 已让音箱播放：${name || id}`);
    setTimeout(async () => {
      try {
        // status=2 是暂停（可能是用户刚点的），只有空闲/未知才提示「未进入播放态」
        if (playQueue.paused) return;
        const st = await cloud.mina.status(dev.id);
        if (st.status !== 1 && st.status !== 2) log(`⚠ 音箱未进入播放态（status=${st.status}），请检查电脑与音箱是否同一局域网、防火墙是否放行 ${media ? media.port : 8931} 端口`);
      } catch (_) {
        /* 状态探测失败不影响播放 */
      }
    }, 2500);
    return { ok: true, trial: resolved.trial, br: resolved.br, matched: resolved.matched };
  });

  /* ---------- 平台歌单（直接读取账号里收藏的歌单） ---------- */

  ipcMain.handle('music:playlists', async (_e, { provider } = {}) => {
    const name = provider || musicBox.current;
    if (PROVIDERS[name]) musicBox.current = name;
    const list = await musicOf(name).playlists();
    log(`${PROVIDERS[name].label}歌单：${list.length} 个`);
    return list;
  });

  ipcMain.handle('music:playlistSongs', async (_e, { provider, id } = {}) => {
    const name = provider || musicBox.current;
    const songs = await musicOf(name).playlistSongs(id);
    log(`已读取歌单内容：${songs.length} 首`);
    return songs;
  });

  /* ---------- 汽水音乐独立界面：推荐流 / 兜底开关 ---------- */

  ipcMain.handle('qishui:feed', async (_e, { cursor, count, refresh, exclude } = {}) => {
    const inst = musicOf('qishui');
    if (typeof inst.feed !== 'function') throw new Error('当前版本不支持汽水推荐流');
    const res = await inst.feed({ cursor, count, refresh, exclude });
    log(`汽水推荐：取到 ${res.songs.length} 首${refresh ? '（换一批）' : ''}`);
    return res;
  });

  ipcMain.handle('qishui:fallback', (_e, { enabled } = {}) => {
    store.set(QISHUI_FALLBACK_KEY, enabled !== false);
    log(enabled !== false ? '已开启「汽水取不到音源时用 QQ/网易云同名曲目」' : '已关闭汽水跨音源兜底');
    return musicStatus();
  });

  ipcMain.handle('queue:state', () => queueState());

  ipcMain.handle('queue:play', async (_e, { title, songs, index = 0 } = {}) => {
    const dev = requireDevice();
    const list = (Array.isArray(songs) ? songs : []).filter((s) => s && s.id);
    if (!list.length) throw new Error('这个歌单里没有可播放的歌曲');
    await stopQueue();
    const start = Math.max(0, Math.min(Number(index) || 0, list.length - 1));
    playQueue.items = list.map((s) => ({
      id: String(s.id),
      name: s.name || '',
      artists: s.artists || '',
      provider: s.provider || musicBox.current,
      duration: Number(s.duration) || 0,
    }));
    playQueue.index = start - 1;
    playQueue.title = title || '歌单';
    playQueueLoop(dev).catch((err) => log(`✗ 歌单连播异常：${err.message}`));
    return queueState();
  });

  ipcMain.handle('queue:stop', async () => {
    if (playQueue.running) {
      playQueue.stopFlag = true;
      log('■ 收到停止连播指令');
    }
    // 停止连播后音箱不再拉流，解密缓冲没有意义，立刻释放内存（不落盘、不残留）
    if (media) media.clearBuffers('停止连播');
    return queueState();
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

/*
 * 数据目录固定
 * --------------------------------------------------------------
 * 应用显示名（productName）从 XiaoAiSpeakerControl 改成了 Xiao Ai Speaker，
 * 而 Electron 默认用 productName 取 userData 目录 —— 直接升级会变成「空目录」，
 * 账号登录态、汽水 Cookie、设置全像丢了一样。这里显式钉回老目录，
 * 并把新目录里可能已写入的数据迁回来，保证改名不影响已登录用户。
 */
(function pinUserData() {
  if (isTestMode) return;
  const OLD_DIR_NAME = 'xiaomi-speaker-controller'; // package.json 的 name，一直没改
  const appData = app.getPath('appData');
  const legacy = path.join(appData, OLD_DIR_NAME);
  const current = app.getPath('userData');
  if (path.resolve(legacy) === path.resolve(current)) return;
  const hasData = (dir) => {
    try { return fs.existsSync(path.join(dir, 'config.json')); } catch (_) { return false; }
  };
  if (!hasData(legacy) && hasData(current)) return; // 新目录已经是主数据目录，别动
  try {
    // 老目录为空、新目录有数据：先把新数据搬过去，再钉到老目录
    if (!hasData(legacy) && fs.existsSync(current) && !fs.existsSync(path.join(legacy, 'Cache'))) {
      fs.mkdirSync(legacy, { recursive: true });
      for (const name of fs.readdirSync(current)) {
        fs.renameSync(path.join(current, name), path.join(legacy, name));
      }
    }
  } catch (_) { /* 迁移失败就保持默认目录，至少不影响启动 */ }
  app.setPath('userData', legacy);
})();

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  store = new Store(app.getPath('userData'));

  // 汽水登录态：扫码配置与 store 里的 Cookie 双向补齐，避免重装/换版本后掉登录
  try {
    const qishuiCookie = qishuiAuth().getCookie();
    const stored = store.get(COOKIE_KEY.qishui, '');
    if (qishuiCookie && qishuiCookie !== stored) saveMusicCookie('qishui', qishuiCookie);
    else if (!qishuiCookie && stored) qishuiAuth().setCookie(stored);
  } catch (_) { /* 登录态读取失败不影响启动 */ }
  // 启动时实测一次汽水会话：Cookie 过期是汽水「不能播」的头号原因，早发现早提示
  setTimeout(() => { validateQishuiSession().catch(() => {}); }, 2000);
  media = new MediaServer({ port: 8931, onLog: log });
  media.registerResolver('qq', (mid) => musicOf('qq').songUrl(mid));
  media.registerResolver('netease', (sid) => musicOf('netease').songUrl(sid));
  media.registerResolver('qishui', async (tid) => {
    const qs = musicOf('qishui');
    const picked = await qs.songUrl(tid);
    // 汽水完整音源是 AES-CTR 加密的 MP4：本地在内存里解密后直接喂给音箱，不写磁盘
    if (picked.encrypted) {
      const dec = await qs.fetchDecrypted(tid);
      if (dec) return { buffer: dec.buffer, contentType: dec.contentType };
      throw new Error('汽水音源解密失败');
    }
    return { url: picked.url, br: picked.br };
  });

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
