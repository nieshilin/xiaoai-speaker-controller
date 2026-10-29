'use strict';

const QQ_DOMAIN = /(^|\.)(qq\.com|qqmusic\.com|tencentmusic\.com)$/i;
const NETEASE_DOMAIN = /(^|\.)(163\.com|126\.net|netease\.com)$/i;

const QQ_PRIORITY = [
  'uin',
  'qqmusic_uin',
  'wxuin',
  'p_uin',
  'pt2gguin',
  'login_type',
  'qm_keyst',
  'qqmusic_key',
  'music_key',
  'wxskey',
  'p_skey',
  'skey',
  'psrf_qqopenid',
  'psrf_qqunionid',
  'psrf_qqaccess_token',
  'psrf_qqrefresh_token',
  'wxopenid',
  'wxunionid',
  'wxrefresh_token',
  'ptcz',
  'RK',
];

const NETEASE_PRIORITY = [
  'MUSIC_U',
  '__csrf',
  'NMTID',
  'MUSIC_A',
  '__remember_me',
  '_ntes_nuid',
  '_ntes_nnid',
  'WEVNSM',
  'WNMCID',
  'JSESSIONID-WYYY',
];

const QQ_PLAYBACK_KEYS = ['qm_keyst', 'qqmusic_key', 'music_key', 'wxskey'];
const QQ_UIN_KEYS = ['uin', 'qqmusic_uin', 'wxuin', 'p_uin', 'pt2gguin'];
const MAX_HEADER = 8000;

function parseCookieHeader(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const raw = part.trim();
    if (!raw) continue;
    const idx = raw.indexOf('=');
    if (idx <= 0) continue;
    const name = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!name || !value) continue;
    out[name] = value;
  }
  return out;
}

function digitsOf(value) {
  return String(value || '').replace(/\D/g, '');
}

function firstOf(obj, keys) {
  for (const k of keys) if (obj[k]) return obj[k];
  return '';
}

function qqAuth(cookieText) {
  const obj = typeof cookieText === 'string' ? parseCookieHeader(cookieText) : (cookieText || {});
  const rawUin = digitsOf(firstOf(obj, QQ_UIN_KEYS));
  const uin = rawUin.length >= 5 ? rawUin : '';
  const keyName = QQ_PLAYBACK_KEYS.find((k) => obj[k]) || '';
  const key = keyName ? obj[keyName] : '';
  return {
    uin,
    keyName,
    key,
    hasAccount: !!uin && !!(key || obj.p_skey || obj.skey),
    hasPlayback: !!uin && !!key,
  };
}

function neteaseAuth(cookieText) {
  const obj = typeof cookieText === 'string' ? parseCookieHeader(cookieText) : (cookieText || {});
  return { hasLogin: String(obj.MUSIC_U || '').length > 20 };
}

function isExpired(cookie, nowSeconds) {
  const exp = Number(cookie && cookie.expirationDate);
  return Number.isFinite(exp) && exp > 0 && exp <= nowSeconds;
}

function cookieScore(cookie) {
  const domain = String((cookie && cookie.domain) || '').replace(/^\./, '').toLowerCase();
  let score = 0;
  if (domain === 'y.qq.com' || domain === 'music.163.com') score += 40;
  else if (/^u\d*\.y\.qq\.com$|^c\.y\.qq\.com$/.test(domain)) score += 30;
  else if (domain.endsWith('qq.com') || domain.endsWith('163.com')) score += 20;
  const segments = String((cookie && cookie.path) || '/').split('/').filter(Boolean).length;
  score += Math.min(segments, 5) * 2;
  if (cookie && cookie.secure) score += 4;
  if (cookie && cookie.hostOnly) score += 2;
  return score;
}

function buildCookieHeader(cookies, options = {}) {
  const matcher = options.match;
  const match = typeof matcher === 'function'
    ? matcher
    : (domain) => (matcher instanceof RegExp ? matcher.test(String(domain || '')) : true);
  const priority = options.priority || [];
  const now = Number(options.now) || Math.floor(Date.now() / 1000);
  const best = new Map();

  for (const cookie of cookies || []) {
    if (!cookie || !cookie.name || !cookie.value) continue;
    if (!match(String(cookie.domain || ''))) continue;
    if (isExpired(cookie, now)) continue;
    const score = cookieScore(cookie);
    const prev = best.get(cookie.name);
    if (!prev || score > prev.score || (score === prev.score && (Number(cookie.expirationDate) || 0) > prev.expires)) {
      best.set(cookie.name, { value: cookie.value, score, expires: Number(cookie.expirationDate) || 0 });
    }
  }

  const names = Array.from(best.keys());
  names.sort((a, b) => {
    const ia = priority.indexOf(a);
    const ib = priority.indexOf(b);
    if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return a.localeCompare(b);
  });

  const parts = [];
  let size = 0;
  for (const name of names) {
    const piece = `${name}=${best.get(name).value}`;
    if (size + piece.length + 2 > MAX_HEADER) break;
    size += piece.length + 2;
    parts.push(piece);
  }
  return parts.join('; ');
}

function normalizeCookie(provider, raw) {
  const text = String(raw || '')
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/[\r\n]+/g, '; ')
    .trim();
  if (!text) return { ok: true, cookie: '', reason: '' };

  const obj = parseCookieHeader(text);
  const names = Object.keys(obj);
  if (!names.length) return { ok: false, cookie: '', reason: '没有识别到 name=value 形式的 Cookie' };

  const priority = provider === 'qq' ? QQ_PRIORITY : NETEASE_PRIORITY;
  const ordered = names.slice().sort((a, b) => {
    const ia = priority.indexOf(a);
    const ib = priority.indexOf(b);
    if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return a.localeCompare(b);
  });
  const cookie = ordered.map((n) => `${n}=${obj[n]}`).join('; ');

  if (provider === 'qq') {
    const auth = qqAuth(cookie);
    if (!auth.key) {
      return { ok: false, cookie, reason: 'QQ 音乐 Cookie 缺少 qm_keyst（或 qqmusic_key）字段，请从 y.qq.com 已登录页面完整复制' };
    }
    if (!auth.uin) {
      return { ok: false, cookie, reason: 'QQ 音乐 Cookie 缺少 uin 字段，请复制整行 Cookie 而不是单个字段' };
    }
    return { ok: true, cookie, reason: '' };
  }

  if (!neteaseAuth(cookie).hasLogin) {
    return { ok: false, cookie, reason: '网易云 Cookie 缺少 MUSIC_U 字段，请确认已在浏览器登录 music.163.com' };
  }
  return { ok: true, cookie, reason: '' };
}

module.exports = {
  QQ_DOMAIN,
  NETEASE_DOMAIN,
  QQ_PRIORITY,
  NETEASE_PRIORITY,
  parseCookieHeader,
  buildCookieHeader,
  normalizeCookie,
  qqAuth,
  neteaseAuth,
};
