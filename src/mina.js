'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const ACCOUNT_BASE = 'https://account.xiaomi.com';
const MINA_BASE = 'https://api2.mina.mi.com';
const JSON_PREFIX = '&&&START&&&';

const UA_LOGIN =
  'APP/com.xiaomi.mihome APPV/11.3.203 iosPassportSDK/4.2.50 iOS/26.3.1 MK/aVBob25lMTcsMg== DEVT/aVBob25l DEVS/aU9T BRA/QXBwbGU= L/zh_CN';
const UA_MINA =
  'MiHome/6.0.103 (com.xiaomi.mihome; build:6.0.103.1; iOS 14.4.0) Alamofire/6.0.103 MICO/iOSApp/appStore/6.0.103';

const PLAY_MUSIC_MODELS = new Set([
  'LX04', 'LX05', 'L05B', 'L05C', 'L06', 'L06A',
  'X08A', 'X10A', 'X08C', 'X08E', 'X8F', 'X4B',
  'OH2', 'OH2P', 'X6A',
]);

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function randomStr(n) {
  const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += pool[bytes[i] % pool.length];
  return out;
}

function defaultTransport(urlStr, { method = 'GET', headers = {}, form = null, cookies = {}, timeout = 30000, follow = 0, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('非法 URL：' + urlStr)); return; }
    const lib = u.protocol === 'http:' ? http : https;
    const body = form ? new URLSearchParams(form).toString() : null;
    const h = { ...headers };
    if (body) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const cookieStr = Object.entries(cookies)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (cookieStr) h.Cookie = cookieStr;

    const req = lib.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers: h },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', async () => {
          const setCookies = {};
          for (const c of res.headers['set-cookie'] || []) {
            const m = /^([^=;]+)=([^;]*)/.exec(c);
            if (m) setCookies[m[1]] = m[2];
          }
          const loc = res.headers.location;
          if (loc && REDIRECTS.has(res.statusCode) && follow > 0) {
            try {
              const nextUrl = new URL(loc, u).toString();
              const dropBody = res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST');
              const r2 = await defaultTransport(nextUrl, {
                method: dropBody ? 'GET' : method,
                headers,
                form: dropBody ? null : form,
                cookies: { ...cookies, ...setCookies },
                timeout,
                follow: follow - 1,
              });
              r2.cookies = { ...setCookies, ...r2.cookies };
              resolve(r2);
            } catch (e) {
              reject(e);
            }
            return;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: raw ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8'),
            buffer: Buffer.concat(chunks),
            cookies: setCookies,
            finalUrl: u.toString(),
          });
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`请求超时（${timeout}ms）：${u.hostname}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseResp(text) {
  const t = String(text == null ? '' : text).trim();
  let s = t.startsWith(JSON_PREFIX) ? t.slice(JSON_PREFIX.length) : t;
  s = s.replace(/("(?:nonce|p_ts|p_idcTs)"\s*:\s*)(\d{15,})(\s*[,}])/g, '$1"$2"$3');
  try {
    return JSON.parse(s);
  } catch (_) {
    return { code: -1, message: s.slice(0, 300) };
  }
}

class MiAccount {
  constructor({ token = {}, transport = defaultTransport, accountBase = ACCOUNT_BASE, onLog } = {}) {
    this.token = token || {};
    this.transport = transport;
    this.accountBase = accountBase;
    this.onLog = typeof onLog === 'function' ? onLog : () => {};
    this.jar = {};
    this._lp = null;
  }

  log(msg) {
    try { this.onLog(msg); } catch (_) { /* ignore */ }
  }

  async _http(url, opts = {}) {
    const res = await this.transport(url, { ...opts, cookies: { ...this.jar, ...(opts.cookies || {}) }, follow: opts.follow == null ? 5 : opts.follow });
    if (res && res.cookies) Object.assign(this.jar, res.cookies);
    return res;
  }

  async _serviceLogin(uri) {
    const url = `${this.accountBase}/pass/${uri}`;
    const cookies = { sdkVersion: '3.9', deviceId: this.token.deviceId };
    if (this.token.passToken && this.token.userId) {
      cookies.userId = this.token.userId;
      cookies.passToken = this.token.passToken;
    }
    const r = await this._http(url, { headers: { 'User-Agent': UA_LOGIN, Referer: `${this.accountBase}/` }, cookies });
    return parseResp(r.body);
  }

  async login(sid = 'micoapi') {
    this.token.deviceId = this.token.deviceId || randomStr(16).toUpperCase();
    const resp = await this._serviceLogin(`serviceLogin?sid=${sid}&_json=true`);
    this.log(`校验登录态 → code=${resp.code}`);
    if (Number(resp.code) !== 0) {
      throw new Error('登录态已失效，请重新扫码登录');
    }
    return this._finishLogin(sid, resp);
  }

  async qrStart(sid = 'micoapi') {
    this.token.deviceId = this.token.deviceId || randomStr(16).toUpperCase();
    const url = `${this.accountBase}/longPolling/loginUrl?sid=${encodeURIComponent(sid)}&_json=true&_locale=zh_CN`;
    const r = await this._http(url, { headers: { 'User-Agent': UA_LOGIN }, timeout: 20000 });
    const j = parseResp(r.body);
    if (!j.lp || !j.qr) throw new Error(`获取登录二维码失败：${String(r.body).slice(0, 160)}`);
    this._lp = { sid, lp: j.lp, qr: j.qr, timeout: Number(j.timeout) || 300 };
    return { qr: j.qr, lp: j.lp, timeout: this._lp.timeout };
  }

  async qrImage(url) {
    const r = await this._http(url, { headers: { 'User-Agent': UA_LOGIN }, raw: true, timeout: 20000 });
    const buf = Buffer.isBuffer(r.buffer) ? r.buffer : Buffer.from(String(r.body || ''), 'binary');
    if (!buf || !buf.length) throw new Error('二维码图片为空');
    const type = String((r.headers && r.headers['content-type']) || 'image/png').split(';')[0];
    return `data:${type};base64,${buf.toString('base64')}`;
  }

  async qrWait({ deadlineMs = 5 * 60 * 1000, onQr } = {}) {
    if (!this._lp) throw new Error('请先获取登录二维码');
    const sid = this._lp.sid;
    const started = Date.now();
    let renewals = 0;

    while (Date.now() - started < deadlineMs) {
      let resp = null;
      try {
        const r = await this._http(this._lp.lp, {
          headers: { 'User-Agent': UA_LOGIN },
          timeout: (this._lp.timeout + 30) * 1000,
        });
        resp = parseResp(r.body);
      } catch (_) {
        resp = null;
      }

      if (resp && resp.location && (resp.ssecurity || resp.nonce)) {
        this.log('扫码通过，正在换取登录凭据…');
        return this._finishLogin(sid, resp);
      }

      if (resp && Number(resp.code) === 0) {
        this.log('二维码已扫描，请在手机上确认登录…');
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }

      if (renewals >= 2) break;
      renewals += 1;
      this.log('二维码已过期，正在刷新…');
      const next = await this.qrStart(sid);
      if (typeof onQr === 'function') {
        try { onQr(await this.qrImage(next.qr)); } catch (_) { /* ignore */ }
      }
    }

    throw new Error('扫码登录等待超时（5 分钟），请重新点击「扫码登录」');
  }

  async _securityTokenService(location, nonce, ssecurity, { label = '' } = {}) {
    const sign = crypto.createHash('sha1').update(`nonce=${nonce}&${ssecurity}`).digest('base64');
    const stsUrl = `${location}${location.includes('?') ? '&' : '?'}clientSign=${encodeURIComponent(sign)}`;
    const loginCookies = {
      userId: this.token.userId,
      cUserId: this.token.cUserId,
      passToken: this.token.passToken,
      deviceId: this.token.deviceId,
      sdkVersion: '3.9',
    };

    const variants = [
      { label: 'clientSign', url: stsUrl, cookies: {}, ua: UA_LOGIN, follow: 0 },
      { label: 'clientSign+cookie', url: stsUrl, cookies: loginCookies, ua: UA_LOGIN, follow: 0 },
      { label: 'clientSign+跳转', url: stsUrl, cookies: loginCookies, ua: UA_LOGIN, follow: 5 },
      { label: 'clientSign+MiHomeUA', url: stsUrl, cookies: loginCookies, ua: UA_MINA, follow: 0 },
    ];

    const trail = [];
    for (const v of variants) {
      let r;
      try {
        r = await this._http(v.url, { headers: { 'User-Agent': v.ua }, cookies: v.cookies, follow: v.follow });
      } catch (err) {
        trail.push(`${v.label}:${err.message}`);
        continue;
      }
      const tok = (r.cookies && r.cookies.serviceToken) || '';
      trail.push(`${v.label}:${r.status}${tok ? '✓' : ''}`);
      if (tok) return { serviceToken: tok, trail };
    }
    const err = new Error(`换取 serviceToken 失败（${label}｜${trail.join(' ')}）`);
    err.trail = trail;
    throw err;
  }

  async _finishLogin(sid, resp) {
    const cands = [];
    const add = (label, c) => {
      if (!c || !c.location || !c.nonce || !c.ssecurity) return;
      const key = `${c.location.slice(-40)}|${c.nonce}|${c.ssecurity}`;
      if (cands.some((x) => x.key === key)) return;
      cands.push({ key, label, location: c.location, nonce: c.nonce, ssecurity: c.ssecurity });
    };

    add('扫码凭据', resp);

    const locNonce = String(resp.location || '').match(/[?&]nonce=([^&]+)/);
    if (resp.location && resp.ssecurity && locNonce) {
      add('location 自带 nonce', {
        location: resp.location,
        nonce: decodeURIComponent(locNonce[1]),
        ssecurity: resp.ssecurity,
      });
    }

    if (resp.userId) this.token.userId = this.token.userId || resp.userId;
    if (resp.passToken) this.token.passToken = this.token.passToken || resp.passToken;

    try {
      const full = await this._serviceLogin(`serviceLogin?sid=${sid}&_json=true`);
      if (Number(full.code) === 0) {
        if (full.userId) this.token.userId = full.userId;
        if (full.passToken) this.token.passToken = full.passToken;
        if (full.cUserId) this.token.cUserId = full.cUserId;
        add('会话复取凭据', full);
      }
    } catch (err) {
      this.log(`复取凭据失败（不影响换票）：${err.message}`);
    }

    if (!cands.length) throw new Error('登录响应缺少安全令牌，请重新扫码登录');

    let lastErr = null;
    for (const c of cands) {
      try {
        const { serviceToken } = await this._securityTokenService(c.location, c.nonce, c.ssecurity, { label: c.label });
        this.token[sid] = { ssecurity: c.ssecurity, serviceToken };
        this._lp = null;
        this.log(`✓ 换取 serviceToken 成功（${c.label}），userId=${this.token.userId || '未知'}`);
        return this.token;
      } catch (err) {
        lastErr = err;
        this.log(`换票未成功（${c.label}）：${err.message}`);
      }
    }
    throw lastErr;
  }

  async request(sid, url, data = null, headers = {}, allowRelogin = true) {
    if (!this.token[sid]) await this.login(sid);
    const cookies = { userId: this.token.userId, serviceToken: this.token[sid].serviceToken };
    const r = await this._http(url, { method: data ? 'POST' : 'GET', headers, form: data, cookies, follow: 0 });
    if (r.status === 401) {
      if (!allowRelogin) throw new Error('接口鉴权失败（401）');
      this.log('接口返回 401，正在重新登录…');
      delete this.token[sid];
      await this.login(sid);
      return this.request(sid, url, data, headers, false);
    }
    if (r.status !== 200) throw new Error(`接口返回 HTTP ${r.status}：${String(r.body).slice(0, 160)}`);
    const resp = parseResp(r.body);
    if (Number(resp.code) === 0) return resp;
    if (allowRelogin && /auth/i.test(resp.message || '')) {
      delete this.token[sid];
      await this.login(sid);
      return this.request(sid, url, data, headers, false);
    }
    throw new Error(`接口错误 code=${resp.code} ${resp.message || ''}`);
  }
}

class MinaService {
  constructor(account, { minaBase = MINA_BASE, onLog } = {}) {
    this.account = account;
    this.minaBase = minaBase;
    this.onLog = typeof onLog === 'function' ? onLog : () => {};
  }

  log(msg) {
    try { this.onLog(msg); } catch (_) { /* ignore */ }
  }

  async _mina(uri, data = null) {
    const requestId = 'app_ios_' + randomStr(30);
    let p = uri;
    if (data) {
      data.requestId = requestId;
    } else {
      p += (uri.includes('?') ? '&' : '?') + 'requestId=' + requestId;
    }
    return this.account.request('micoapi', this.minaBase + p, data, { 'User-Agent': UA_MINA });
  }

  async devices() {
    const resp = await this._mina('/admin/v2/device_list?master=0');
    return Array.isArray(resp.data) ? resp.data : [];
  }

  async ubus(deviceId, method, p, message) {
    return this._mina('/remote/ubus', { deviceId, message: JSON.stringify(message), method, path: p });
  }

  async _ok(deviceId, method, p, message) {
    const resp = await this.ubus(deviceId, method, p, message);
    return Number(resp.code) === 0;
  }

  textToSpeech(deviceId, text) {
    return this._ok(deviceId, 'text_to_speech', 'mibrain', { text });
  }

  setVolume(deviceId, volume) {
    return this._ok(deviceId, 'player_set_volume', 'mediaplayer', { volume, media: 'app_ios' });
  }

  play(deviceId) {
    return this._ok(deviceId, 'player_play_operation', 'mediaplayer', { action: 'play', media: 'app_ios' });
  }

  pause(deviceId) {
    return this._ok(deviceId, 'player_play_operation', 'mediaplayer', { action: 'pause', media: 'app_ios' });
  }

  stop(deviceId) {
    return this._ok(deviceId, 'player_play_operation', 'mediaplayer', { action: 'stop', media: 'app_ios' });
  }

  async status(deviceId) {
    const resp = await this.ubus(deviceId, 'player_get_play_status', 'mediaplayer', { media: 'app_ios' });
    const data = resp && resp.data;
    if (!data) return resp;
    if (typeof data.info === 'string') {
      try { return JSON.parse(data.info); } catch (_) { /* ignore */ }
    }
    return data;
  }

  async playUrl(deviceId, url, hardware) {
    if (PLAY_MUSIC_MODELS.has(String(hardware || '').toUpperCase())) {
      const audioId = '1582971365183456177';
      const cpId = '355454500';
      const music = {
        payload: {
          audio_type: '',
          audio_items: [
            {
              item_id: { audio_id: audioId, cp: { album_id: '-1', episode_index: 0, id: cpId, name: 'xiaowei' } },
              stream: { url },
            },
          ],
          list_params: { listId: '-1', loadmore_offset: 0, origin: 'xiaowei', type: 'MUSIC' },
        },
        play_behavior: 'REPLACE_ALL',
      };
      return this._ok(deviceId, 'player_play_music', 'mediaplayer', {
        startaudioid: audioId,
        music: JSON.stringify(music),
      });
    }
    return this._ok(deviceId, 'player_play_url', 'mediaplayer', { url, type: 2, media: 'app_ios' });
  }
}

module.exports = {
  MiAccount,
  MinaService,
  PLAY_MUSIC_MODELS,
  defaultTransport,
  parseResp,
  ACCOUNT_BASE,
  MINA_BASE,
};
