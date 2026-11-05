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

function collectBySplit(s) {
  const out = {};
  for (const part of s.split(/[;\r\n]+/)) {
    const raw = part.trim();
    if (!raw) continue;
    const idx = raw.indexOf('=');
    if (idx <= 0) continue;
    const name = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

function collectByRegex(s) {
  const out = {};
  const re = /([^\s;=]+)\s*=\s*("[^"]*"|[^;\s]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1].trim();
    let value = m[2].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name && value) out[name] = value;
  }
  return out;
}

function parseCookieHeader(text) {
  const s = String(text || '');
  if (!s) return {};
  // 两种策略都试，取解析出字段更多的一份：
  // - split：标准 Cookie 形态（分号 / 换行分隔），能保留含空格的值
  // - regex：单行 input 把多行 Cookie 的换行吞成空格后变成 "a=1 b=2 c=3"，
  //   split 只会拿到第一个对，必须逐对正则提取
  const a = collectBySplit(s);
  const b = collectByRegex(s);
  return Object.keys(b).length > Object.keys(a).length ? b : a;
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

  if (provider === 'qishui') {
    if (!/(^|;\s*)(sessionid|sessionid_ss|sid_tt|sid_guard)=/i.test(cookie)) {
      return { ok: false, cookie, reason: '汽水音乐 Cookie 缺少 sessionid 字段：请在汽水 PC 客户端抓 api.qishui.com 的请求，复制整行 Cookie' };
    }
    return { ok: true, cookie, reason: '' };
  }

  if (!neteaseAuth(cookie).hasLogin) {
    const hint = names.length
      ? `已识别到 ${names.length} 个字段但缺少 MUSIC_U（识别到的如：${names.slice(0, 4).join('、')}）。请确认复制的是 music.163.com 已登录域下的 Cookie`
      : '网易云 Cookie 缺少 MUSIC_U 字段，请确认已在浏览器登录 music.163.com';
    return { ok: false, cookie, reason: hint };
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
