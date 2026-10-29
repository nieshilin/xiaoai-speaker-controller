'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { qqAuth, neteaseAuth } = require('./musicCookie');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const NETEASE_BASE = 'https://music.163.com';
const QQ_BASE = 'https://c.y.qq.com';
const QQ_API = 'https://u.y.qq.com';

function raw(url, opts = {}) {
  const { method = 'GET', headers = {}, form = null, payload = null, cookie = '', timeout = 15000 } = opts;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const h = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers };
    let body = null;
    if (form) {
      body = new URLSearchParams(form).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (payload != null) {
      body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      h['Content-Type'] = 'application/json';
    }
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);
    if (cookie) h.Cookie = cookie;

    const req = lib.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers: h },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), buffer: buf });
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', (err) => reject(new Error(`网络请求失败：${err.message}`)));
    if (body != null) req.write(body);
    req.end();
  });
}

function parseJson(text) {
  let t = String(text || '').trim();
  if (t.startsWith('&&&START&&&')) t = t.slice(10);
  const wrapped = t.match(/^[A-Za-z_$][\w$]*\((.*)\);?$/s);
  if (wrapped) t = wrapped[1];
  try {
    return JSON.parse(t);
  } catch (_) {
    throw new Error('接口返回了非 JSON 数据');
  }
}

async function fetchJson(url, opts = {}) {
  const r = await raw(url, opts);
  if (r.status !== 200) throw new Error(`接口返回 HTTP ${r.status}`);
  return parseJson(r.text);
}

function mapNeteaseSong(s) {
  return {
    id: String(s.id),
    name: s.name || '',
    artists: (s.ar || s.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
    album: (s.al || s.album || {}).name || '',
    cover: (s.al || s.album || {}).picUrl || '',
    duration: Number(s.dt || s.duration) || 0,
    vip: Number(s.fee) === 1,
  };
}

function mapQQSong(s) {
  return {
    id: s.songmid || s.mid || '',
    name: s.songname || s.title || '',
    artists: (s.singer || []).map((a) => a.name).filter(Boolean).join(' / '),
    album: s.albumname || (s.album && s.album.name) || '',
    cover: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : '',
    duration: (Number(s.interval) || 0) * 1000,
    vip: !!(s.pay && Number(s.pay.play_1073) === 1),
  };
}

class NeteaseMusic {
  constructor({ cookie = '', base = NETEASE_BASE } = {}) {
    this.base = base;
    this.setCookie(cookie);
  }

  setCookie(cookie) {
    this.cookie = String(cookie || '').trim().replace(/^\s*Cookie:\s*/i, '');
  }

  get loggedIn() {
    return /MUSIC_U=[^;\s]{20,}/i.test(this.cookie);
  }

  get cookieHeader() {
    const extra = this.cookie ? `${this.cookie}; ` : '';
    return `${extra}os=pc; appver=2.9.7`;
  }

  async search(keywords, { limit = 30, offset = 0 } = {}) {
    const kw = String(keywords || '').trim();
    if (!kw) throw new Error('请输入要搜索的歌曲、歌手或专辑');
    const body = await fetchJson(`${this.base}/api/cloudsearch/pc`, {
      method: 'POST',
      form: { s: kw, type: 1, limit: Math.min(50, Math.max(1, limit)), offset: Math.max(0, offset) },
      headers: { Referer: `${this.base}/` },
      cookie: this.cookieHeader,
    });
    return (((body.result || {}).songs) || []).map(mapNeteaseSong);
  }

  async songUrl(id, { level = 'exhigh' } = {}) {
    const sid = String(id || '').trim();
    if (!sid) throw new Error('缺少歌曲 id');

    const levels = [level, 'standard'].filter((v, i, a) => a.indexOf(v) === i);
    let trial = null;

    for (const lv of levels) {
      const body = await fetchJson(`${this.base}/api/song/enhance/player/url/v1`, {
        method: 'POST',
        form: { ids: `[${sid}]`, level: lv, encodeType: 'flac' },
        headers: { Referer: `${this.base}/` },
        cookie: this.cookieHeader,
      }).catch(() => null);
      const d = body && body.data && body.data[0];
      if (!d) continue;
      if (d.url && !d.freeTrialInfo) return { url: d.url, br: Number(d.br) || 0, level: lv, trial: false };
      if (d.url && d.freeTrialInfo && !trial) trial = { url: d.url, br: Number(d.br) || 0, level: lv, trial: true };
    }

    const legacy = await fetchJson(`${this.base}/api/song/enhance/player/url`, {
      method: 'POST',
      form: { ids: `[${sid}]`, br: 320000 },
      headers: { Referer: `${this.base}/` },
      cookie: this.cookieHeader,
    }).catch(() => null);
    const d = legacy && legacy.data && legacy.data[0];
    if (d && d.url && !d.freeTrialInfo) return { url: d.url, br: Number(d.br) || 0, level: 'legacy', trial: false };

    if (trial) return trial;
    throw new Error('这首歌没有可播放的音源（多为版权/会员限制），请登录会员账号后再试');
  }

  async lyric(id) {
    const sid = String(id || '').trim();
    if (!sid) return '';
    const body = await fetchJson(`${this.base}/api/song/lyric?id=${encodeURIComponent(sid)}&lv=-1&kv=-1&tv=-1`, {
      headers: { Referer: `${this.base}/` },
      cookie: this.cookieHeader,
    }).catch(() => null);
    return (body && body.lrc && body.lrc.lyric) || '';
  }

  async profile() {
    if (!this.loggedIn) return null;
    const body = await fetchJson(`${this.base}/api/nuser/account/get`, {
      headers: { Referer: `${this.base}/` },
      cookie: this.cookieHeader,
    }).catch(() => null);
    if (!body || !body.profile) return null;
    return { nickname: body.profile.nickname || '', userId: body.profile.userId || '' };
  }
}

class QQMusic {
  constructor({ cookie = '', base = QQ_BASE, apiBase = QQ_API, probe = true } = {}) {
    this.base = base;
    this.apiBase = apiBase;
    this.probeEnabled = probe !== false;
    this.guid = String(10000 + Math.floor(Math.random() * 8999999999));
    this.setCookie(cookie);
  }

  setCookie(cookie) {
    this.cookie = String(cookie || '').trim().replace(/^\s*Cookie:\s*/i, '');
    const auth = qqAuth(this.cookie);
    this.uin = auth.uin;
    this.key = auth.key;
  }

  get loggedIn() {
    return !!this.uin && !!this.key;
  }

  async search(keywords, { limit = 30, offset = 0 } = {}) {
    const kw = String(keywords || '').trim();
    if (!kw) throw new Error('请输入要搜索的歌曲、歌手或专辑');
    const n = Math.min(50, Math.max(1, limit));
    const page = Math.floor(Math.max(0, offset) / n) + 1;
    const qs = new URLSearchParams({
      format: 'json', w: kw, n: String(n), p: String(page), cr: '1', t: '0', g_tk: '5381',
      inCharset: 'utf-8', outCharset: 'utf-8', notice: '0', platform: 'yqq.json', needNewCode: '0',
    });
    const body = await fetchJson(`${this.base}/soso/fcgi-bin/client_search_cp?${qs}`, {
      headers: { Referer: 'https://y.qq.com/' },
      cookie: this.cookie,
    });
    const list = (((body.data || {}).song) || {}).list || [];
    return list.map(mapQQSong).filter((s) => s.id);
  }

  async _songFile(mid) {
    const body = await fetchJson(`${this.base}/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(mid)}&format=json`, {
      headers: { Referer: 'https://y.qq.com/' },
      cookie: this.cookie,
    }).catch(() => null);
    const song = ((body || {}).data || [])[0] || {};
    return { mediaMid: String((song.file || {}).media_mid || mid), sizes: song.file || {} };
  }

  async _vkeyBatch(mid, files) {
    const uid = this.uin || '0';
    const ask = async (withAuth) => {
      const qs = new URLSearchParams({
        '-': 'getplaysongvkey', g_tk: '5381', loginUin: uid, hostUin: '0', format: 'json',
        inCharset: 'utf8', outCharset: 'utf-8', notice: '0', platform: 'yqq.json', needNewCode: '0',
      });
      const payload = {
        req_0: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: { guid: this.guid, songmid: [mid], songtype: [0], filename: files, uin: uid, loginflag: 1, platform: '20' },
        },
        comm: { uin: uid, format: 'json', ct: 19, cv: 0, ...(withAuth && this.key ? { authst: this.key } : {}) },
      };
      const body = await fetchJson(`${this.apiBase}/cgi-bin/musicu.fcg?${qs}`, {
        method: 'POST',
        payload,
        headers: { Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com' },
        cookie: this.cookie,
      });
      const block = body.req_0 || body.req || {};
      const data = block.data || {};
      const infos = data.midurlinfo || [];
      const sips = data.sip || [];
      const sip = sips.find((s) => !/^http:\/\/ws\./i.test(s)) || sips[0] || '';
      const items = files.map((file) => {
        const info = infos.find((i) => (i.filename || '') === file) || infos[0] || {};
        return {
          file,
          purl: info.purl || '',
          result: Number(info.result) || 0,
          filename: info.filename || file,
        };
      });
      return { sip, items };
    };

    const withAuth = await ask(!!this.key);
    if (withAuth.items.some((i) => i.purl) || !this.key) return withAuth;
    const anon = await ask(false);
    return anon.items.some((i) => i.purl) ? anon : withAuth;
  }

  async _urlReachable(url) {
    if (!this.probeEnabled) return false;
    try {
      const r = await raw(url, { headers: { Range: 'bytes=0-1' }, timeout: 8000 });
      return r.status === 200 || r.status === 206;
    } catch (_) {
      return false;
    }
  }

  async songUrl(id) {
    const mid = String(id || '').trim();
    if (!mid) throw new Error('缺少歌曲 mid');

    const ALL = [
      ['M800', 'mp3', 320000, 'size_320mp3'],
      ['M500', 'mp3', 128000, 'size_128mp3'],
      ['C400', 'm4a', 128000, 'size_96aac'],
    ];
    const file = await this._songFile(mid);
    let candidates = ALL.filter(([, , , sizeKey]) => Number(file.sizes[sizeKey]) > 0);
    if (!candidates.length) candidates = ALL;

    const attempt = async (fileBase) => {
      const files = candidates.map(([p, ext]) => `${p}${fileBase}.${ext}`);
      const { sip, items } = await this._vkeyBatch(mid, files);
      let reason = 0;
      let fallback = null;
      for (const item of items) {
        if (!item.purl) {
          reason = reason || item.result;
          continue;
        }
        const m = `${item.filename || ''}${item.purl}`.match(/^(M800|M500|C400)/);
        const spec = candidates.find(([p]) => p === (m ? m[1] : item.file.slice(0, 4))) || candidates[0];
        const url = (sip || 'https://ws.stream.qqmusic.qq.com/') + item.purl;
        if (!fallback) fallback = { url, br: spec[2], level: spec[0] === 'M800' ? '320k' : spec[0] === 'M500' ? '128k' : 'm4a', trial: false };
        if (await this._urlReachable(url)) return { fallback, reason };
      }
      return { fallback, reason };
    };

    let out = await attempt(file.mediaMid);
    if (!out.fallback && file.mediaMid !== mid) out = await attempt(mid);
    if (out.fallback) return out.fallback;
    if (out.reason === 104003) {
      throw new Error('这首歌需要 QQ 音乐会员，或账号无权播放（未登录同样如此），请登录会员账号再试');
    }
    throw new Error('这首歌没有可播放的音源，换一首或登录后再试');
  }

  async lyric(id) {
    const mid = String(id || '').trim();
    if (!mid) return '';
    const qs = new URLSearchParams({
      songmid: mid, format: 'json', nobase64: '1', g_tk: '5381', loginUin: '0', hostUin: '0',
      inCharset: 'utf-8', outCharset: 'utf-8', notice: '0', platform: 'yqq.json', needNewCode: '0',
    });
    const body = await fetchJson(`${this.base}/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${qs}`, {
      headers: { Referer: 'https://y.qq.com/portal/player.html' },
      cookie: this.cookie,
    }).catch(() => null);
    return (body && body.lyric) || '';
  }

  async profile() {
    if (!this.loggedIn) return null;
    return { nickname: this.uin ? `QQ ${this.uin}` : '已登录', userId: this.uin };
  }
}

const PROVIDERS = {
  netease: { label: '网易云音乐', create: (opts) => new NeteaseMusic(opts) },
  qq: { label: 'QQ 音乐', create: (opts) => new QQMusic(opts) },
};

function providerFor(name, opts) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`未知音源：${name}`);
  return p.create(opts);
}

module.exports = { NeteaseMusic, QQMusic, PROVIDERS, providerFor, NETEASE_BASE, QQ_BASE };
