'use strict';

/**
 * 汽水音乐（Soda Music）音源
 * ------------------------------------------------------------------
 * 汽水没有开放的第三方播放接口，这里走的是它自家客户端在用的几套接口：
 *   web 网关 https://api5-lq.qishui.com —— 推荐流、**单曲取流（media-player）**
 *   PC 端   https://api.qishui.com      —— 搜索、我的歌单（需要 X-Helios / X-Medusa 签名头）
 *   App 端  https://beta-luna.douyin.com —— 歌单详情
 *
 * 取流的关键：web 网关的 `POST /luna/media-player` 只要**登录 Cookie**（扫码即可拿到），
 * 不需要客户端签名头。返回的完整音源是 AES-CTR 加密的 MP4，密钥藏在 encrypt_info.spade_a 里，
 * 用 src/qishui/decryptor.js 在内存里解出明文，不写磁盘。
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { resolveAudioKey, decryptAudioBuffer } = require('./qishui/decryptor');

const PC_BASE = 'https://api.qishui.com';
const LUNA_BASE = 'https://beta-luna.douyin.com';
/** 推荐流走 web 网关：api.qishui.com 上没有这个路由，api5-lq 才认 */
const FEED_BASE = 'https://api5-lq.qishui.com';
const PC_UA = 'LunaPC/3.0.0(290101097)';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.1.0 Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36';
const APP_UA = 'Luna/19.1.0 Android';
const AID = '386088';
const IID = '27960026095955';
const VERSION_CODE = '30020100';
const MAX_PAGES = 8;

function request(url, { method = 'GET', headers = {}, payload = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const h = { Accept: 'application/json, text/plain, */*', ...headers };
    let body = null;
    if (payload != null) {
      body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      h['Content-Type'] = h['Content-Type'] || 'application/json; charset=utf-8';
    }
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);

    const req = lib.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers: h },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', (err) => reject(new Error(`网络请求失败：${err.message}`)));
    if (body != null) req.write(body);
    req.end();
  });
}

function stripCookie(value) {
  return String(value || '').trim().replace(/^\s*Cookie:\s*/i, '').replace(/[\r\n]+/g, '');
}

function trimHeader(value) {
  return String(value || '').trim().replace(/[\r\n]+/g, '');
}

function pickUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return pickUrl(value[0]);
  if (Array.isArray(value.urls) && value.urls.length) return `${value.urls[0] || ''}${value.uri || ''}`;
  return value.url || value.uri || value.template || '';
}

/**
 * 汽水的封面是「hosts[0] + uri + ~{template_prefix}-image.jpg」拼出来的，
 * 直接拼 hosts[0]+uri 会被图床判 400，这里统一补上模板后缀。
 */
function coverUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const uri = String(value.uri || value.uri_thumb || '').trim();
  const hosts = Array.isArray(value.urls) ? value.urls.filter(Boolean) : [];
  if (!uri || !hosts.length) return pickUrl(value);
  if (uri.includes('~')) return hosts[0] + uri;
  const prefix = String(value.template_prefix || '').trim();
  return `${hosts[0]}${uri}${prefix ? `~${prefix}-image.jpg` : ''}`;
}

/** 从任意层级里找第一个命中的键（汽水接口字段名经常换，只能宽容匹配） */
function findValue(input, keys, depth = 0) {
  if (!input || depth > 8) return null;
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  if (Array.isArray(input)) {
    for (const item of input) {
      const hit = findValue(item, keys, depth + 1);
      if (hit !== null && hit !== undefined && hit !== '') return hit;
    }
    return null;
  }
  if (typeof input !== 'object') return null;
  for (const [k, v] of Object.entries(input)) {
    if (wanted.has(k.toLowerCase())) {
      if (v !== null && v !== undefined && v !== '') return v;
    }
  }
  for (const v of Object.values(input)) {
    const hit = findValue(v, keys, depth + 1);
    if (hit !== null && hit !== undefined && hit !== '') return hit;
  }
  return null;
}

/** 在整棵树里收集所有音频直链候选（带码率信息，便于挑最高档） */
function collectAudio(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectAudio(item, out, depth + 1);
    return out;
  }
  const url = node.main_url || node.mainUrl || node.backup_url || node.backupUrl
    || node.play_url || node.playUrl || node.audio_url || node.audioUrl;
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    const br = Number(node.br || node.bit_rate || node.bitrate || node.bit_rate_kbps) || 0;
    const isAudio = /\.(m4a|mp3|aac|flac|mp4)(\?|$)/i.test(url) || br > 0;
    if (isAudio) out.push({ url, br });
  }
  for (const v of Object.values(node)) collectAudio(v, out, depth + 1);
  return out;
}

function findAudio(body) {
  const list = collectAudio(body).filter((item, i, arr) => arr.findIndex((x) => x.url === item.url) === i);
  const sorted = list.sort((a, b) => b.br - a.br);
  const spade = findValue(body, ['spade_a', 'spadeA', 'play_auth', 'playAuth']);
  return {
    url: (sorted[0] || {}).url || '',
    br: (sorted[0] || {}).br || 0,
    spade: typeof spade === 'string' ? spade : (spade ? JSON.stringify(spade) : ''),
    candidates: sorted.length,
  };
}

function unwrapTrack(item) {
  if (!item || typeof item !== 'object') return null;
  return (
    (item.entity && (item.entity.track_wrapper || {}).track)
    || (item.entity && item.entity.track)
    || item.track
    || null
  );
}

function artistName(a) {
  if (!a) return '';
  return a.name || a.simple_display_name || (a.user_info || {}).nickname || '';
}

function mapSong(track) {
  if (!track || !track.id) return null;
  const album = track.album || {};
  const duration = Number(track.duration || track.duration_ms) || 0;
  const range = track.playable_range || {};
  const rangeDuration = Number(range.duration) || 0;
  // 试听限制：可播区间明显短于整首时，标记为受限（VIP / 版权）
  const restricted = !!(duration && rangeDuration && rangeDuration < duration * 0.9);
  const label = track.label_info || {};
  return {
    id: String(track.id),
    name: track.name || track.trackName || '',
    artists: (Array.isArray(track.artists) ? track.artists : []).map(artistName).filter(Boolean).join(' / '),
    album: album.name || '',
    cover: coverUrl(album.url_cover || album.cover_url || album.coverURL),
    duration,
    vip: restricted || track.is_vip === true || label.only_vip_playable === true,
  };
}

/** 从搜索接口响应里抽出歌曲列表（结构：result_groups[].data[]，每项可能是 track 或带 entity 的包装） */
function extractSearchTracks(body) {
  const out = [];
  const push = (track) => {
    const song = mapSong(track);
    if (song && !out.some((s) => s.id === song.id)) out.push(song);
  };
  const groups = (body && (body.result_groups || body.resultGroups)) || [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const item of (group && group.data) || []) {
      const type = item && (item.type || '');
      if (type && type !== 'track') continue;
      push(unwrapTrack(item) || (item && item.track));
    }
  }
  if (!out.length) {
    const fallback = findValue(body, ['tracks', 'track_list']);
    if (Array.isArray(fallback)) fallback.forEach((t) => push(unwrapTrack(t) || t));
  }
  return out;
}

/** 从歌单详情里抽出歌曲列表（media_resources[].entity.track_wrapper.track） */
function extractPlaylistTracks(body) {
  const out = [];
  const resources = (body && (body.media_resources || body.mediaResources)) || [];
  for (const item of Array.isArray(resources) ? resources : []) {
    const song = mapSong(unwrapTrack(item));
    if (song && !out.some((s) => s.id === song.id)) out.push(song);
  }
  return out;
}

function extractPlaylists(body) {
  const list = (body && (body.playlists || body.playlist_list)) || [];
  return (Array.isArray(list) ? list : []).map((p) => ({
    id: String(p.id || p.playlist_id || ''),
    name: p.title || p.name || '未命名歌单',
    count: Number(p.count_tracks || p.track_count || p.song_count) || 0,
    cover: pickUrl(p.url_cover || p.cover || p.cover_url),
  })).filter((p) => p.id);
}

/** 推荐流：items[].entity.track_wrapper.track，附带收藏数用于展示热度 */
function extractFeedTracks(body) {
  const items = (body && (body.items || body.media_list)) || [];
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item && item.type && item.type !== 'track' && !item.entity) continue;
    const track = unwrapTrack(item) || (item && item.track);
    const song = mapSong(track);
    if (!song || out.some((s) => s.id === song.id)) continue;
    const stats = (track && track.stats) || {};
    const label = (track && track.label_info) || {};
    // 推荐流里的 playable_range 是「副歌片段」，不能拿来判断会员；
    // 这里只认 label_info.only_vip_playable，否则整屏都会被标成 VIP。
    song.vip = label.only_vip_playable === true;
    song.hot = Number(stats.count_collected || stats.count_shared || 0) || 0;
    out.push(song);
  }
  return out;
}

class QishuiMusic {
  constructor({ cookie = '', helios = '', medusa = '', deviceId = '', fp = '', base = PC_BASE, lunaBase = LUNA_BASE, feedBase = FEED_BASE, send = null } = {}) {
    this.base = base;
    this.lunaBase = lunaBase;
    this.feedBase = feedBase;
    this.send = send || request; // 可注入，便于离线测试
    this.setCookie(cookie);
    this.setKeys({ helios, medusa, deviceId, fp });
    this._playerCache = new Map(); // id -> { picked, at }：取流结果短时复用，避免重复请求
  }

  /** 取流结果缓存：同一首歌在「解析」和「代理取流」两个环节会各查一次 */
  _cachePlayer(id, picked) {
    this._playerCache.set(id, { picked, at: Date.now() });
    if (this._playerCache.size > 40) {
      const oldest = [...this._playerCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this._playerCache.delete(oldest[0]);
    }
  }

  _readPlayerCache(id) {
    const hit = this._playerCache.get(id);
    if (!hit) return null;
    if (Date.now() - hit.at > 4 * 60 * 1000) {
      this._playerCache.delete(id);
      return null;
    }
    return hit.picked;
  }

  setCookie(cookie) {
    this.cookie = stripCookie(cookie);
  }

  setKeys({ helios = '', medusa = '', deviceId = '', fp = '' } = {}) {
    this.helios = trimHeader(helios);
    this.medusa = trimHeader(medusa);
    this.deviceId = trimHeader(deviceId);
    this.fp = trimHeader(fp);
  }

  get loggedIn() {
    return /(^|;\s*)(sessionid|sessionid_ss|sid_tt|sid_guard)=/i.test(this.cookie);
  }

  get hasSignature() {
    return !!(this.helios && this.medusa);
  }

  get ready() {
    return this.loggedIn && this.hasSignature;
  }

  _params(extra = {}) {
    const deviceId = this.deviceId || String(1000000000000000 + Math.floor(Math.random() * 8999999999999999));
    return {
      aid: AID,
      app_name: 'luna_pc',
      region: 'cn',
      geo_region: 'cn',
      os_region: 'cn',
      sim_region: '',
      device_id: deviceId,
      cdid: '',
      iid: IID,
      version_name: '3.0.0',
      version_code: '30000000',
      channel: 'official',
      build_mode: 'master',
      network_carrier: '',
      ac: 'wifi',
      tz_name: 'Asia/Shanghai',
      resolution: '',
      device_platform: 'windows',
      device_type: 'Windows',
      os_version: 'Windows 11',
      fp: this.fp || deviceId,
      ...extra,
    };
  }

  async _call(url, { method = 'GET', headers, payload } = {}) {
    const r = await this.send(url, { method, headers, payload });
    const text = (r.buffer ? r.buffer.toString('utf8') : String(r.text || '')).trim();
    if (r.status !== 200) throw new Error(`汽水接口返回 HTTP ${r.status}${text ? `：${text.slice(0, 120)}` : ''}`);
    if (!text) return null; // 签名头缺失/过期时，上游会返回 200 + 空响应体
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error('汽水接口返回了非 JSON 数据');
    }
  }

  _pcHeaders() {
    return {
      'User-Agent': PC_UA,
      'Content-Type': 'application/json; charset=utf-8',
      ...(this.helios ? { 'X-Helios': this.helios } : {}),
      ...(this.medusa ? { 'X-Medusa': this.medusa } : {}),
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    };
  }

  _appHeaders() {
    return {
      'User-Agent': APP_UA,
      'Content-Type': 'application/json; charset=utf-8',
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    };
  }

  /** web 网关（api5-lq）只认网页版的公共参数，PC 客户端参数会被判成别的设备 */
  _webParams(extra = {}) {
    return {
      aid: AID,
      app_name: 'luna_pc',
      device_platform: 'web',
      channel: 'pc_web',
      ...extra,
    };
  }

  _webHeaders() {
    return {
      'User-Agent': WEB_UA,
      'Content-Type': 'application/json; charset=utf-8',
      Referer: 'https://www.qishui.com/',
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    };
  }

  async _postWeb(path, payload, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(this._webParams(params))) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    return this._call(`${this.feedBase}${path}?${qs}`, {
      method: 'POST',
      headers: this._webHeaders(),
      payload,
    });
  }

  /**
   * 推荐流（「猜你喜欢」/ song tab）
   * 同一条流既能在已登录时按账号口味推荐，未登录时也能拿到大众热门，
   * 所以独立界面不用等登录就有内容可看。
   */
  async feed({ cursor = 0, count = 10, refresh = false, exclude = [] } = {}) {
    const n = Math.min(10, Math.max(1, Number(count) || 10));
    const from = Math.max(0, Number(cursor) || 0);
    const seen = (Array.isArray(exclude) ? exclude : []).slice(-20).map((v) => String(v || '')).filter(Boolean);
    const body = await this._postWeb(
      '/luna/pc/feed/song-tab',
      {
        count: n,
        cursor: from,
        played_media: seen,
        common_params: {
          trigger_name: refresh ? 'xiaoai_refresh' : 'xiaoai_feed',
          scene: 'feed',
          source: 'xiaoai',
        },
        ...(refresh ? { refresh: 1 } : {}),
      },
      { cursor: String(from) },
    );
    if (!body) throw new Error(this._explainEmpty());
    const code = Number(body.status_code) || 0;
    if (code) {
      const msg = String((body.status_info || {}).status_msg || '').trim();
      throw new Error(`汽水推荐接口返回 ${code}${msg ? `：${msg}` : ''}`);
    }
    const songs = extractFeedTracks(body);
    const step = (Array.isArray(body.items) ? body.items : []).length || songs.length;
    return {
      songs,
      nextCursor: from + Math.max(step, songs.length),
      hasMore: body.has_more !== false,
    };
  }

  async _getPc(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    return this._call(`${this.base}${path}?${qs}`, { headers: this._pcHeaders() });
  }

  async _postLuna(path, payload) {
    return this._call(`${this.lunaBase}${path}`, {
      method: 'POST',
      headers: this._appHeaders(),
      payload,
    });
  }

  _explainEmpty() {
    if (!this.loggedIn && !this.hasSignature) return '汽水接口返回空响应：还未登录（扫码或抓包粘贴 Cookie 均可）';
    if (!this.loggedIn) return '汽水接口返回空响应：Cookie 里没有登录态（sessionid），请重新扫码或抓包';
    return '汽水接口返回空响应：Cookie 可能已过期，请重新扫码登录（搜索类接口还需要 X-Helios / X-Medusa）';
  }

  /** 凭证体检：能拿到昵称就说明会话有效（网页扫码会话与抓包 Cookie 都支持） */
  async probe() {
    if (!this.cookie) throw new Error('还没填汽水 Cookie');
    const body = await this._getPc('/luna/pc/me', { aid: AID });
    if (!body) throw new Error(this._explainEmpty());
    // 网页会话的 me 响应结构不定，直接全局找 nickname 字段最稳
    const text = JSON.stringify(body);
    const name = (text.match(/"nickname"\s*:\s*"([^"]{1,64})"/) || [])[1] || '';
    if (!name) throw new Error('接口有响应但读不到账号信息，凭证可能不完整');
    const vip = /"is_vip"\s*:\s*(?:true|1)/.test(text) || /"vip_level"\s*:\s*[1-9]/.test(text);
    return { name: String(name), vip };
  }

  /** 统一成和其它音源一致的资料结构，供保存 Cookie 后的回显使用 */
  async profile() {
    const info = await this.probe();
    return { nickname: info.name, vip: info.vip };
  }

  async search(keywords, { limit = 30, offset = 0 } = {}) {
    const kw = String(keywords || '').trim();
    if (!kw) throw new Error('请输入要搜索的歌曲、歌手或专辑');
    const body = await this._getPc('/luna/pc/search/track', this._params({
      q: kw,
      cursor: Math.max(0, Number(offset) || 0),
      search_method: 'input',
      search_id: '',
      debug_params: '',
      from_search_id: '',
      search_scene: '',
    }));
    if (!body) throw new Error(this._explainEmpty());
    const songs = extractSearchTracks(body);
    if (!songs.length) throw new Error('汽水没有搜到结果，换个关键词试试');
    return songs.slice(0, Math.min(50, Math.max(1, limit)));
  }

  async playlists() {
    if (!this.loggedIn) throw new Error('汽水音乐需要先填 Cookie（含 sessionid）');
    const body = await this._getPc('/luna/pc/me/playlist', { aid: AID, iid: IID, version_code: VERSION_CODE });
    if (!body) throw new Error(this._explainEmpty());
    return extractPlaylists(body);
  }

  async playlistSongs(id) {
    const pid = String(id || '').trim();
    if (!pid) throw new Error('缺少歌单 id');
    const songs = [];
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this._postLuna('/luna/playlist/detail', {
        playlist_id: pid,
        count: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!body) throw new Error(this._explainEmpty());
      const batch = extractPlaylistTracks(body);
      for (const s of batch) if (!songs.some((x) => x.id === s.id)) songs.push(s);
      const next = body.next_cursor || body.nextCursor || '';
      if (!next || next === cursor || !batch.length) break;
      cursor = next;
    }
    return songs;
  }

  /** 探测音频是否真的带 CENC 加密盒（有 play_auth 不代表音频一定加密） */
  async _looksEncrypted(url) {
    try {
      const r = await this.send(url, {
        headers: { 'User-Agent': PC_UA, Range: 'bytes=0-8191' },
      });
      const buf = r.buffer || Buffer.from('');
      if (!buf.length) return false;
      const head = buf.toString('latin1');
      return head.includes('pssh') || head.includes('sinf') || head.includes('tenc');
    } catch (_) {
      return false; // 探测失败不阻断，交给播放环节自己报错
    }
  }

  /**
   * web 网关的播放信息接口
   * POST /luna/media-player —— 只要登录 Cookie，不需要 X-Helios / X-Medusa。
   * 返回 player_infos[0].video_model（JSON 字符串）里的多档音源，
   * 登录态给 3 档（highest/higher/medium）且时长完整；未登录只给 1 档试听片段。
   */
  async mediaPlayer(id) {
    const tid = String(id || '').trim();
    if (!tid) throw new Error('缺少歌曲 id');
    const body = await this._postWeb('/luna/media-player', {
      media_id: tid,
      media_type: 'track',
      queue_type: '',
      enable_refresh_api: false,
      enable_dash: true,
    });
    if (!body) return null;

    const code = Number(body.status_code) || 0;
    if (code) {
      const info = body.status_info || {};
      const msg = String(info.status_msg || info.status_desc || '').trim();
      if (code === 1000005) throw new Error('汽水没有这首歌的播放信息（可能已下架或版权受限）');
      throw new Error(`汽水播放接口返回 ${code}${msg ? `：${msg}` : ''}`);
    }

    const info = (Array.isArray(body.player_infos) ? body.player_infos : [])[0];
    if (!info) return null;
    let model = info.video_model;
    if (typeof model === 'string') {
      try { model = JSON.parse(model); } catch (_) { model = null; }
    }
    if (!model || typeof model !== 'object') return null;

    const gears = (Array.isArray(model.video_list) ? model.video_list : [])
      .filter((v) => v && (v.main_url || v.backup_url))
      .map((v) => {
        const meta = v.video_meta || {};
        const enc = v.encrypt_info || {};
        return {
          url: String(v.main_url || v.backup_url),
          br: Number(meta.real_bitrate || meta.bitrate) || 0,
          size: Number(meta.size) || 0,
          encrypted: !!enc.encrypt,
          spadeA: String(enc.spade_a || ''),
        };
      })
      .sort((a, b) => b.br - a.br);
    if (!gears.length) return null;

    const best = gears[0];
    const duration = Number(model.video_duration) || 0;
    return {
      url: best.url,
      br: best.br,
      size: best.size,
      duration,
      encrypted: best.encrypted,
      spadeA: best.spadeA,
      // 只有一档 + 时长被截短 ⇒ 拿的是试听片段（未登录或非会员）
      trial: gears.length <= 1 && duration > 0 && duration < 65,
      gears: gears.length,
    };
  }

  /** 下载加密音源到内存并解密（不落盘）；返回可直接喂给音箱的明文 m4a */
  async fetchDecrypted(id, { maxBytes = 48 * 1024 * 1024 } = {}) {
    const picked = await this.songUrl(id);
    if (!picked || !picked.encrypted) return null;
    const r = await this.send(picked.url, {
      headers: { 'User-Agent': WEB_UA, Referer: 'https://www.qishui.com/' },
      timeout: 30000,
    });
    if (r.status !== 200 || !r.buffer || !r.buffer.length) {
      throw new Error(`下载汽水音源失败（HTTP ${r.status}）`);
    }
    if (r.buffer.length > maxBytes) throw new Error('汽水音源体积异常，已放弃');
    const out = decryptAudioBuffer(r.buffer, picked.decryptKey);
    return { buffer: out.buffer, contentType: out.content_type || 'audio/mp4', ext: out.extension || '.m4a' };
  }

  async songUrl(id) {
    const tid = String(id || '').trim();
    if (!tid) throw new Error('缺少歌曲 id');

    const cached = this._readPlayerCache(tid);
    if (cached) return cached;

    // 首选：web 网关 media-player（登录 Cookie 即可，完整音源）
    let webError = '';
    let mp = null;
    try {
      mp = await this.mediaPlayer(tid);
    } catch (err) {
      webError = err.message;
    }

    if (mp && mp.url) {
      let decryptKey = '';
      if (mp.encrypted) {
        if (!mp.spadeA) throw new Error('这首歌是加密音源，但接口没有返回 spade_a，暂时无法解密');
        decryptKey = resolveAudioKey({ spade_a: mp.spadeA });
      }
      const picked = {
        url: mp.url,
        br: mp.br,
        trial: mp.trial,
        duration: mp.duration,
        encrypted: !!mp.encrypted,
        decryptKey,
      };
      this._cachePlayer(tid, picked);
      return picked;
    }

    // 兜底：PC 客户端接口（需要签名头，成功则说明凭证里有可用签名）
    let body = null;
    let firstError = '';
    try {
      body = await this._getPc('/luna/pc/track_v2', { track_id: tid, media_type: 'track', queue_type: '' });
    } catch (err) {
      firstError = err.message;
    }

    let found = body ? findAudio(body) : { url: '', br: 0, spade: '' };
    let trial = false;

    if (!found.url) {
      // PC 接口没给流时退回 H5：多数曲目只有片段，但至少能出声
      const h5 = await this._postLuna('/luna/h5/seo_track', { track_id: tid, device_platform: 'web' }).catch(() => null);
      const alt = h5 ? findAudio(h5) : { url: '', br: 0, spade: '' };
      if (alt.url) {
        found = alt;
        trial = true;
      }
    }

    if (!found.url) {
      if (webError) throw new Error(webError);
      if (firstError) throw new Error(firstError);
      if (!body) throw new Error(this._explainEmpty());
      throw new Error('这首歌没有可用的播放地址（可能是版权受限或需要汽水会员），换一首试试');
    }

    if (found.spade) {
      const encrypted = await this._looksEncrypted(found.url);
      if (encrypted) {
        throw new Error('这首歌是加密音源（play_auth），当前版本还解不开，换一首非会员曲目试试');
      }
    }

    return { url: found.url, br: found.br, trial, encrypted: false, decryptKey: '' };
  }
}

module.exports = {
  QishuiMusic,
  PC_BASE,
  LUNA_BASE,
  FEED_BASE,
  // 供自检使用
  __test: {
    findAudio,
    collectAudio,
    unwrapTrack,
    mapSong,
    coverUrl,
    extractSearchTracks,
    extractPlaylistTracks,
    extractPlaylists,
    extractFeedTracks,
  },
};
