'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { MediaServer } = require('../src/mediaServer');
const { MiAccount, MinaService } = require('../src/mina');
const { NeteaseMusic, QQMusic, providerFor } = require('../src/music');
const {
  QQ_DOMAIN,
  NETEASE_DOMAIN,
  QQ_PRIORITY,
  NETEASE_PRIORITY,
  buildCookieHeader,
  normalizeCookie,
  qqAuth,
  neteaseAuth,
} = require('../src/musicCookie');
const {
  compareVersions,
  isNewer,
  normalizeRepo,
  pickAsset,
  checkUpdate,
  downloadAsset,
} = require('../src/updater');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const ok = (name, extra) => { results.push({ ok: true, name }); console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); };
const fail = (name, err) => { results.push({ ok: false, name }); console.log(`  ✗ ${name} — ${(err && err.message) || err}`); };

function checkSyntax() {
  const files = ['main.js', 'preload.js'];
  for (const dir of ['src', 'renderer', 'scripts']) {
    const p = path.join(ROOT, dir);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p)) if (f.endsWith('.js')) files.push(`${dir}/${f}`);
  }
  const bad = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    } catch (err) {
      bad.push(`${f}: ${String(err.stderr || err.message).split('\n')[0]}`);
    }
  }
  if (bad.length) throw new Error(bad.join('；'));
  ok('所有 js 文件语法正确', `${files.length} 个文件`);
}

async function checkMina() {
  const calls = [];
  const device = { deviceID: 'dev-l05b', name: '小爱音箱Play', hardware: 'L05B', presence: 'online' };

  const transport = async (url, opts = {}) => {
    calls.push({ url, opts });
    const u = new URL(url);
    if (u.pathname === '/sts') {
      return { status: 200, body: '', cookies: { serviceToken: 'STOKEN' } };
    }
    if (u.pathname === '/pass/serviceLogin') {
      return {
        status: 200,
        body: '&&&START&&&{"code":0,"userId":2592545123,"passToken":"PT","nonce":1359368446494794752,"ssecurity":"SSEC","location":"https://api2.mina.mi.com/sts?d=D1&ticket=0&nonce=abc","cUserId":"C1"}',
        cookies: {},
      };
    }
    if (u.pathname === '/admin/v2/device_list') {
      return { status: 200, body: JSON.stringify({ code: 0, data: [device] }), cookies: {} };
    }
    if (u.pathname === '/remote/ubus') {
      const msg = JSON.parse(opts.form.message || '{}');
      return {
        status: 200,
        body: JSON.stringify({ code: 0, data: { code: 0, info: JSON.stringify({ status: 2, volume: 40, echo: msg.method }) } }),
        cookies: {},
      };
    }
    return { status: 200, body: '{"code":0}', cookies: {} };
  };

  const account = new MiAccount({ token: { userId: 1, passToken: 'PT' }, transport });
  const mina = new MinaService(account, { minaBase: 'https://api2.mina.mi.com' });

  const devices = await mina.devices();
  if (!devices.length || devices[0].hardware !== 'L05B') throw new Error('设备列表解析失败');

  const sts = calls.find((c) => c.url.includes('clientSign='));
  const expect = crypto.createHash('sha1').update('nonce=1359368446494794752&SSEC').digest('base64');
  if (!sts) throw new Error('未发起换票请求');
  if (!sts.url.includes(encodeURIComponent(expect))) throw new Error('大整数 nonce 精度丢失，clientSign 错误');
  if (!account.token.micoapi || account.token.micoapi.serviceToken !== 'STOKEN') throw new Error('未拿到 serviceToken');
  ok('登录换票', '19 位 nonce 保精度 · serviceToken 已获取');

  const listCall = calls.find((c) => c.url.includes('/admin/v2/device_list'));
  if (!listCall.url.includes('requestId=app_ios_')) throw new Error('device_list 缺少 requestId');
  if (listCall.opts.cookies.serviceToken !== 'STOKEN') throw new Error('device_list 未带 serviceToken');
  ok('设备列表', 'requestId 与登录 cookie 正确');

  const ubusForms = () => calls.filter((c) => c.url.includes('/remote/ubus')).map((c) => c.opts.form);

  await mina.playUrl(device.deviceID, 'http://127.0.0.1:8931/media/a/song.mp3', 'L05B');
  const first = ubusForms()[0];
  if (first.method !== 'player_play_music') throw new Error('L05B 未走 player_play_music');
  const music = JSON.parse(JSON.parse(first.message).music);
  if (music.payload.audio_items[0].stream.url !== 'http://127.0.0.1:8931/media/a/song.mp3') throw new Error('播放地址未写入 payload');
  ok('L05B 播放 URL', 'player_play_music 载荷正确');

  await mina.playUrl(device.deviceID, 'https://example.com/a.mp3', 'LX01');
  const second = ubusForms()[1];
  if (second.method !== 'player_play_url' || JSON.parse(second.message).type !== 2) throw new Error('普通型号未走 player_play_url');
  ok('普通型号播放 URL', 'player_play_url(type=2)');

  await mina.setVolume(device.deviceID, 66);
  await mina.pause(device.deviceID);
  await mina.textToSpeech(device.deviceID, '测试');
  const forms = ubusForms();
  const vol = forms.find((f) => f.method === 'player_set_volume');
  const pause = forms.find((f) => f.method === 'player_play_operation');
  const tts = forms.find((f) => f.method === 'text_to_speech');
  if (!vol || JSON.parse(vol.message).volume !== 66) throw new Error('音量指令错误');
  if (!pause || JSON.parse(pause.message).action !== 'pause') throw new Error('暂停指令错误');
  if (!tts || JSON.parse(tts.message).text !== '测试') throw new Error('TTS 指令错误');
  ok('音量 / 暂停 / 播报指令', 'ubus 参数正确');

  const st = await mina.status(device.deviceID);
  if (st.status !== 2) throw new Error('播放状态解析失败');
  ok('播放状态解析', 'status=2 volume=40');

  let relogin = 0;
  const authTransport = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/remote/ubus' && relogin === 0) {
      relogin += 1;
      return { status: 401, body: '', cookies: {} };
    }
    return transport(url, opts);
  };
  const acc2 = new MiAccount({ token: { userId: 1, passToken: 'PT', micoapi: { serviceToken: 'OLD' } }, transport: authTransport });
  const mina2 = new MinaService(acc2, { minaBase: 'https://api2.mina.mi.com' });
  const okPause = await mina2.pause('dev-l05b');
  if (!okPause || relogin !== 1) throw new Error('401 后未自动重登');
  ok('401 自动重登', '重新换取 serviceToken 后重试成功');
}

async function checkQrLogin() {
  const calls = [];
  const transport = async (url, opts = {}) => {
    calls.push({ url, opts });
    const u = new URL(url);
    if (u.pathname === '/longPolling/loginUrl') {
      return { status: 200, body: JSON.stringify({ lp: 'https://account.xiaomi.com/lp/1', qr: 'https://account.xiaomi.com/qr/1.png', timeout: 300 }), cookies: {} };
    }
    if (u.pathname === '/qr/1.png') {
      return { status: 200, headers: { 'content-type': 'image/png' }, buffer: Buffer.from('PNGDATA'), body: '', cookies: {} };
    }
    if (u.pathname === '/lp/1') {
      return { status: 200, body: '&&&START&&&{"code":0,"userId":42,"passToken":"PT","nonce":1234567890123456789,"ssecurity":"SSEC","location":"https://api2.mina.mi.com/sts?d=D1&ticket=0"}', cookies: {} };
    }
    if (u.pathname === '/sts') {
      return { status: 200, body: '', cookies: { serviceToken: 'STOKEN-QR' } };
    }
    if (u.pathname === '/pass/serviceLogin') {
      return { status: 200, body: '&&&START&&&{"code":0,"userId":42,"nonce":555,"ssecurity":"SSEC2","location":"https://api2.mina.mi.com/sts?d=D1&ticket=0"}', cookies: {} };
    }
    return { status: 200, body: '{"code":0}', cookies: {} };
  };

  const account = new MiAccount({ transport });
  const start = await account.qrStart('micoapi');
  const image = await account.qrImage(start.qr);
  if (!image.startsWith('data:image/png;base64,')) throw new Error('二维码未转成 data URL');
  ok('获取登录二维码', `${image.length} 字节`);

  const token = await account.qrWait({ deadlineMs: 5000 });
  if (!token.micoapi || token.micoapi.serviceToken !== 'STOKEN-QR') throw new Error('扫码后未拿到 serviceToken');
  if (String(token.userId) !== '42') throw new Error('userId 未补齐');
  ok('扫码 → 换票', 'userId 已补齐，serviceToken 已获取');
}

async function checkMusic() {
  const seen = { cookie: '', urls: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      seen.cookie = String(req.headers.cookie || '');
      seen.urls.push(req.url);
      const json = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (req.url === '/api/cloudsearch/pc') {
        if (form.get('s') !== '晴天') return json({ result: { songs: [] } });
        return json({
          result: {
            songs: [
              { id: 1, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美', picUrl: 'http://p/1.jpg' }, dt: 269000, fee: 8 },
              { id: 2, name: '稻香', ar: [{ name: '周杰伦' }], al: { name: '魔杰座', picUrl: '' }, dt: 223000, fee: 0 },
            ],
          },
        });
      }

      if (req.url === '/api/song/enhance/player/url/v1') {
        const ids = form.get('ids') || '';
        const level = form.get('level') || '';
        if (ids === '[1]') return json({ data: [{ id: 1, url: null, code: 404 }] });
        if (ids === '[2]') return json({ data: [{ id: 2, url: 'http://m800.music.126.net/2.mp3', br: 320000, level }] });
        if (ids === '[3]') {
          return level === 'exhigh'
            ? json({ data: [{ id: 3, url: 'http://m800.music.126.net/3-trial.mp3', br: 320000, freeTrialInfo: { start: 0, end: 30 } }] })
            : json({ data: [{ id: 3, url: null, code: 404 }] });
        }
        return json({ data: [{ id: Number(ids.replace(/[^\d]/g, '')), url: null, code: 404 }] });
      }

      if (req.url === '/api/song/enhance/player/url') {
        if (form.get('ids') === '[1]') return json({ data: [{ id: 1, url: 'http://m801.music.126.net/1.mp3', br: 320000 }] });
        return json({ data: [{ id: 0, url: null, code: 404 }] });
      }

      if (req.url.startsWith('/api/song/lyric')) return json({ lrc: { lyric: '[00:00.00]晴天' } });
      res.writeHead(404);
      res.end('{}');
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const music = new NeteaseMusic({ base, cookie: 'MUSIC_U=abcdef' });

    const songs = await music.search('晴天');
    if (songs.length !== 2) throw new Error('搜索结果数量不对');
    if (songs[0].artists !== '周杰伦' || songs[0].album !== '叶惠美' || songs[0].duration !== 269000) throw new Error('搜索结果字段映射错误');
    if (!seen.cookie.includes('MUSIC_U=abcdef') || !seen.cookie.includes('os=pc')) throw new Error('Cookie 未透传给网易云');
    ok('在线搜索', `${songs.length} 首 · Cookie 已透传`);

    try {
      await music.search('   ');
      fail('空关键词拦截', new Error('空关键词未被拦截'));
    } catch (err) {
      ok('空关键词拦截', err.message);
    }

    const r1 = await music.songUrl(1);
    if (!r1.url.includes('1.mp3') || r1.level !== 'legacy') throw new Error('旧接口回退失败：' + JSON.stringify(r1));
    ok('取播放地址回退', 'v1 无音源 → 旧接口成功');

    const r2 = await music.songUrl(2);
    if (r2.br !== 320000 || r2.trial) throw new Error('正常音源解析错误');
    ok('取播放地址', '320kbps 非试听');

    const r3 = await music.songUrl(3);
    if (!r3.trial) throw new Error('试听标记丢失');
    ok('试听片段识别', 'freeTrialInfo → trial=true');

    try {
      await music.songUrl(9);
      fail('无音源提示', new Error('无音源时未报错'));
    } catch (err) {
      if (!/会员|登录/.test(err.message)) throw err;
      ok('无音源提示', err.message);
    }

    const lyric = await music.lyric(2);
    if (!lyric.includes('晴天')) throw new Error('歌词解析失败');
    ok('歌词获取', 'LRC 文本已返回');
  } catch (err) {
    fail('在线音乐', err);
  }

  await new Promise((r) => server.close(r));
}

async function checkQQMusic() {
  const seen = { cookie: '', authst: [], files: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.cookie = String(req.headers.cookie || '');
      const json = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (req.url.startsWith('/soso/fcgi-bin/client_search_cp')) {
        const q = new URL('http://x' + req.url).searchParams;
        if (q.get('w') !== '晴天') return json({ code: 0, data: { song: { list: [] } } });
        return json({
          code: 0,
          data: {
            song: {
              list: [
                { songmid: 'mid1', songname: '晴天', singer: [{ name: '周杰伦' }], albumname: '叶惠美', albummid: 'alb1', interval: 269, pay: { play_1073: 1 } },
                { songmid: 'mid2', songname: '稻香', singer: [{ name: '周杰伦' }], albumname: '魔杰座', albummid: '', interval: 223 },
              ],
            },
          },
        });
      }

      if (req.url.startsWith('/v8/fcg-bin/fcg_play_single_song.fcg')) {
        const songmid = new URL('http://x' + req.url).searchParams.get('songmid');
        const files = songmid === 'mid2'
          ? { media_mid: 'media2', size_320mp3: 0, size_128mp3: 4294285, size_96aac: 3272671 }
          : { media_mid: 'media1', size_320mp3: 10792943, size_128mp3: 4317292, size_96aac: 3283546 };
        return json({ code: 0, data: [{ songmid, file: files }] });
      }

      if (req.url.startsWith('/cgi-bin/musicu.fcg')) {
        const payload = JSON.parse(body);
        const mid = payload.req_0.param.songmid[0];
        const filenames = payload.req_0.param.filename || [];
        seen.files.push(filenames);
        seen.authst.push(payload.comm.authst || '');
        const sip = ['http://ws.stream.qqmusic.qq.com/', 'http://aqqmusic.tc.qq.com/'];
        const infos = filenames.map((file) => {
          if (mid === 'mid1' && !file.startsWith('M500')) {
            return { songmid: mid, purl: '', result: 104003, filename: file };
          }
          if (mid === 'mid1') {
            return { songmid: mid, purl: `${file}?vkey=V1&guid=9`, result: 0, filename: file };
          }
          return { songmid: mid, purl: '', result: 104003, filename: file };
        });
        return json({ req_0: { code: 0, data: { sip, midurlinfo: infos } } });
      }

      if (req.url.startsWith('/lyric/fcgi-bin/fcg_query_lyric_new.fcg')) {
        return json({ retcode: 0, lyric: '[00:00.00]晴天' });
      }
      res.writeHead(404);
      res.end('{}');
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const anon = new QQMusic({ base, apiBase: base, probe: false });
    const songs = await anon.search('晴天');
    if (songs.length !== 2) throw new Error('搜索结果数量不对');
    if (songs[0].id !== 'mid1' || songs[0].artists !== '周杰伦' || songs[0].album !== '叶惠美') throw new Error('字段映射错误');
    if (songs[0].duration !== 269000 || !songs[0].vip) throw new Error('时长或 VIP 标记错误');
    ok('QQ 音乐搜索', `${songs.length} 首 · VIP 标记正确`);

    const fallback = await anon.songUrl('mid1');
    if (fallback.level !== '128k' || !fallback.url.startsWith('http://aqqmusic.tc.qq.com/')) throw new Error('音质回退或域名选择错误：' + JSON.stringify(fallback));
    ok('QQ 取址与音质回退', '320k 无权限 → 128k，sip 跳过 ws 域名');

    try {
      await anon.songUrl('mid2');
      fail('QQ 无权限提示', new Error('无音源时未报错'));
    } catch (err) {
      if (!/会员/.test(err.message)) throw err;
      ok('QQ 无权限提示', err.message);
    }

    const login = new QQMusic({ base, apiBase: base, cookie: 'uin=o123456789; qm_keyst=KEY0123456789ABCDEF', probe: false });
    if (!login.loggedIn || login.uin !== '123456789' || login.key !== 'KEY0123456789ABCDEF') throw new Error('QQ Cookie 解析错误');
    seen.authst.length = 0;
    await login.songUrl('mid1');
    if (!seen.authst.includes('KEY0123456789ABCDEF')) throw new Error('登录后请求未携带 authst');
    if (!seen.cookie.includes('qm_keyst=KEY0123456789ABCDEF')) throw new Error('登录后请求未携带 Cookie');
    ok('QQ 登录态透传', 'authst + Cookie 已带入 vkey 请求');

    const lyric = await anon.lyric('mid1');
    if (!lyric.includes('晴天')) throw new Error('歌词解析失败');
    ok('QQ 歌词获取', 'LRC 文本已返回');
  } catch (err) {
    fail('QQ 音乐', err);
  }

  await new Promise((r) => server.close(r));
}

function checkCookieTools() {
  try {
    const cookies = [
      { name: 'qm_keyst', value: 'OLDKEY', domain: '.qq.com', path: '/', secure: true },
      { name: 'qm_keyst', value: 'NEWKEY', domain: 'y.qq.com', path: '/', secure: true, hostOnly: true },
      { name: 'uin', value: 'o0123456789', domain: '.qq.com', path: '/' },
      { name: '__csrf', value: 'csrf-token', domain: 'y.qq.com', path: '/' },
      { name: 'MUSIC_U', value: 'u'.repeat(40), domain: '.music.163.com', path: '/' },
      { name: 'MUSIC_U', value: 'expired', domain: '.music.163.com', path: '/', expirationDate: 1 },
    ];
    const qq = buildCookieHeader(cookies, { match: QQ_DOMAIN, priority: QQ_PRIORITY });
    if (!qq.includes('qm_keyst=NEWKEY')) throw new Error('同名字段未择优（应取 y.qq.com 上的新 key）');
    if (qq.includes('OLDKEY')) throw new Error('同名字段重复输出');
    if (qq.indexOf('uin=') > qq.indexOf('qm_keyst=')) throw new Error('输出顺序未按优先级');
    if (!QQ_DOMAIN.test('y.qq.com') || QQ_DOMAIN.test('notqq.com')) throw new Error('QQ 域匹配错误');
    if (!QQ_DOMAIN.test('u.y.qq.com') || QQ_DOMAIN.test('qq.com.evil.cn')) throw new Error('QQ 域匹配错误（子域/伪域）');

    const ne = buildCookieHeader(cookies, { match: NETEASE_DOMAIN, priority: NETEASE_PRIORITY });
    if (!ne.includes('MUSIC_U=' + 'u'.repeat(40))) throw new Error('网易云 cookie 未取到有效 MUSIC_U');
    if (ne.includes('expired')) throw new Error('过期 cookie 未被过滤');

    const pasted = normalizeCookie('qq', 'Cookie: uin=o0123456789;\r\nqm_keyst=ABCDEFGH; p_skey=zzz');
    if (!pasted.ok || !pasted.cookie.startsWith('uin=o0123456789')) throw new Error('粘贴内容未规范化');
    if (normalizeCookie('qq', 'uin=o0123456789; skey=1').ok) throw new Error('缺少 qm_keyst 时应报错');
    if (normalizeCookie('qq', 'qm_keyst=ABCDEFGH').ok) throw new Error('缺少 uin 时应报错');
    if (!normalizeCookie('netease', 'MUSIC_U=' + 'x'.repeat(40)).ok) throw new Error('网易云合法 Cookie 被拒绝');
    if (normalizeCookie('netease', 'foo=bar').ok) throw new Error('网易云缺 MUSIC_U 时应报错');

    if (!qqAuth('uin=o0123456789; qm_keyst=ABCDEFGH').hasPlayback) throw new Error('qqAuth 未识别播放凭证');
    if (qqAuth('uin=o0123456789; p_skey=x').hasPlayback) throw new Error('只有 p_skey 时不应判定可播放');
    if (!qqAuth('uin=o0123456789; p_skey=x').hasAccount) throw new Error('qqAuth 未识别「账号已登录」中间态');
    if (!neteaseAuth('MUSIC_U=' + 'y'.repeat(40)).hasLogin) throw new Error('neteaseAuth 判定失败');
    ok('Cookie 抓取与校验', '域过滤 / 择优 / 优先级 / 粘贴规范化');
  } catch (err) {
    fail('Cookie 抓取与校验', err);
  }
}

function checkProviders() {
  try {
    const n = providerFor('netease', { cookie: '' });
    const q = providerFor('qq', { cookie: 'p_uin=o98765; qqmusic_key=ABCDEFGH12345678' });
    if (n.loggedIn) throw new Error('网易云无 Cookie 却判定已登录');
    if (!q.loggedIn || q.uin !== '98765') throw new Error('qqmusic_key 或 p_uin 未被识别');
    if (providerFor('netease', { cookie: 'MUSIC_U=' + 'a'.repeat(40) }).loggedIn !== true) throw new Error('MUSIC_U 未被识别');
    if (providerFor('qq', { cookie: 'uin=123' }).loggedIn) throw new Error('缺少 key 却判定已登录');
    let rejected = false;
    try { providerFor('kugou', {}); } catch (_) { rejected = true; }
    if (!rejected) throw new Error('未知音源未被拒绝');
    ok('音源工厂与登录态判定', 'netease / qq 双通道');
  } catch (err) {
    fail('音源工厂', err);
  }
}

async function checkMediaServer() {
  const ms = new MediaServer({ port: 18931 });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoai-media-'));
  const file = path.join(tmpDir, 'sample.mp3');
  const data = crypto.randomBytes(4096);
  fs.writeFileSync(file, data);

  try {
    await ms.start();
    const id = ms.addFile(file);
    const url = ms.urlFor(id, '127.0.0.1');

    const get = (headers = {}) =>
      new Promise((resolve, reject) => {
        const req = http.get(url, { headers }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.setTimeout(4000, () => req.destroy(new Error('请求超时')));
      });

    const full = await get();
    if (full.status !== 200) throw new Error('整体请求状态 ' + full.status);
    if (!full.body.equals(data)) throw new Error('整体内容不一致');
    if (full.headers['accept-ranges'] !== 'bytes') throw new Error('缺少 Accept-Ranges');
    ok('整体下载', `${full.body.length} 字节 · ${full.headers['content-type']}`);

    const part = await get({ Range: 'bytes=100-199' });
    if (part.status !== 206) throw new Error('Range 请求未返回 206：' + part.status);
    if (part.body.length !== 100 || !part.body.equals(data.subarray(100, 200))) throw new Error('Range 内容错误');
    if (!/^bytes 100-199\/4096$/.test(part.headers['content-range'])) throw new Error('Content-Range 错误');
    ok('Range 请求', '206 · bytes 100-199/4096');

    const bad = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${ms.port}/media/deadbeef/..%2f..%2fetc%2fpasswd`, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', () => resolve(0));
    });
    if (bad !== 404) throw new Error('未知 id 应返回 404，实际 ' + bad);
    ok('未注册路径返回 404');

    const txt = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(txt, 'x');
    let rejected = false;
    try { ms.addFile(txt); } catch (_) { rejected = true; }
    if (!rejected) throw new Error('非音频扩展名应被拒绝');
    ok('非音频扩展名被拒绝');

    ms.registerResolver('demo', async () => ({ url, br: 320000 }));
    const px = ms.proxyUrl('demo', 'song-1', '127.0.0.1');
    const proxied = await new Promise((resolve, reject) => {
      const req = http.get(px, { headers: { Range: 'bytes=0-99' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.setTimeout(4000, () => req.destroy(new Error('代理请求超时')));
    });
    if (proxied.status !== 206) throw new Error('代理未透传 Range：' + proxied.status);
    if (!proxied.body.equals(data.subarray(0, 100))) throw new Error('代理内容不一致');
    if (proxied.headers['content-type'] !== 'audio/mpeg') throw new Error('代理未透传 Content-Type');
    ok('在线音源代理', '206 · Range 透传 · 音箱只访问本机');

    ms.registerResolver('broken', async () => { throw new Error('取址失败'); });
    const failStatus = await new Promise((resolve) => {
      http.get(ms.proxyUrl('broken', 'x', '127.0.0.1'), (res) => { res.resume(); resolve(res.statusCode); })
        .on('error', () => resolve(0));
    });
    if (failStatus !== 502) throw new Error('取址失败应返回 502，实际 ' + failStatus);
    ok('代理取址失败返回 502');
  } catch (err) {
    fail('媒体服务', err);
  } finally {
    ms.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

function startGithubMock() {
  const payload = crypto.randomBytes(96);
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push({ path: url.pathname, auth: req.headers.authorization || '' });
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === '/repos/demo/app/releases') {
      return json(200, [{
        tag_name: 'v9.9.9',
        name: 'v9.9.9 关于页与更新检查',
        body: '## 更新内容\n- 新增关于应用界面\n- 新增版本更新检查',
        published_at: '2026-10-29T10:00:00Z',
        html_url: 'https://github.com/demo/app/releases/tag/v9.9.9',
        draft: false,
        prerelease: false,
        assets: [
          { name: 'notes.txt', size: 12, url: `${base}/blob/text`, browser_download_url: `${base}/blob/text` },
          { name: 'XiaoAiSpeakerControl Setup 9.9.9.exe', size: payload.length, url: `${base}/asset/setup`, browser_download_url: `${base}/asset/setup` },
        ],
      }]);
    }
    if (url.pathname === '/repos/demo/old/releases') {
      return json(200, [{ tag_name: 'v1.0.0', name: 'v1.0.0', draft: false, prerelease: false, published_at: '2025-01-01T00:00:00Z', assets: [], body: '' }]);
    }
    if (url.pathname === '/repos/demo/pre/releases') {
      return json(200, [{ tag_name: 'v5.0.0', name: 'v5.0.0', draft: false, prerelease: true, assets: [], body: '' }]);
    }
    if (url.pathname === '/repos/demo/pre/tags') return json(200, [{ name: 'v1.2.0' }, { name: 'v1.10.0' }]);
    if (url.pathname === '/repos/demo/limited/releases') return json(403, { message: 'API rate limit exceeded for 127.0.0.1' });
    if (url.pathname === '/asset/setup') {
      res.writeHead(302, { location: `${base}/blob/setup` });
      return res.end();
    }
    if (url.pathname === '/blob/setup') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) });
      return res.end(payload);
    }
    return json(404, { message: 'Not Found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}`, seen, payload });
    });
  });
}

async function checkUpdater() {
  if (compareVersions('1.10.0', '1.9.9') === 1 && compareVersions('2.0.0', '2.0.0-beta.1') === 1 && compareVersions('v2.1.0', '2.1.0') === 0) {
    ok('语义化版本比较（含预发布）');
  } else {
    fail('语义化版本比较（含预发布）', new Error('比较结果异常'));
  }

  if (normalizeRepo('https://github.com/demo/app.git/') === 'demo/app' && isNewer('2.1.1', '2.1.0') && !isNewer('2.1.0', '2.1.0')) {
    ok('仓库地址规范化与新版本判定');
  } else {
    fail('仓库地址规范化与新版本判定', new Error('规范化或判定异常'));
  }

  const mock = await startGithubMock();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoai-update-'));
  try {
    const found = await checkUpdate({ repo: 'demo/app', current: '2.1.0', apiBase: mock.base, token: 'ghp_mock' });
    const apiHit = mock.seen.find((s) => s.path === '/repos/demo/app/releases');
    const setupPicked = found.asset && /Setup 9\.9\.9\.exe$/.test(found.asset.name);
    if (found.hasUpdate && found.latest === '9.9.9' && setupPicked && apiHit && /^Bearer ghp_mock$/.test(apiHit.auth)) {
      ok('发现新版本 → 选中安装包并透传 Token', `v${found.current} → v${found.latest}`);
    } else {
      fail('发现新版本 → 选中安装包并透传 Token', new Error(JSON.stringify({ latest: found.latest, asset: found.asset, auth: apiHit && apiHit.auth })));
    }

    if (found.release.notes.includes('关于应用界面') && found.release.url.includes('releases/tag/v9.9.9')) {
      ok('解析更新说明与发布页地址');
    } else {
      fail('解析更新说明与发布页地址', new Error('说明或地址缺失'));
    }

    const older = await checkUpdate({ repo: 'demo/old', current: '2.1.0', apiBase: mock.base });
    if (older.ok && older.latest === '1.0.0' && older.hasUpdate === false) {
      ok('旧版本 → 不提示更新');
    } else {
      fail('旧版本 → 不提示更新', new Error(JSON.stringify(older)));
    }

    const pre = await checkUpdate({ repo: 'demo/pre', current: '1.0.0', apiBase: mock.base });
    if (pre.ok && pre.latest === '1.10.0' && pre.release.source === 'tag' && pre.hasUpdate) {
      ok('跳过预发布 → 回退到 Tags 取最高版本');
    } else {
      fail('跳过预发布 → 回退到 Tags 取最高版本', new Error(JSON.stringify({ latest: pre.latest, src: pre.release && pre.release.source })));
    }

    try {
      await checkUpdate({ repo: 'demo/limited', current: '2.1.0', apiBase: mock.base });
      fail('频率限制 → 友好错误', new Error('未抛出错误'));
    } catch (err) {
      if (/频率/.test(err.message)) ok('频率限制 → 友好错误');
      else fail('频率限制 → 友好错误', err);
    }

    try {
      await checkUpdate({ repo: 'demo/missing', current: '2.1.0', apiBase: mock.base });
      fail('仓库不存在 → 友好错误', new Error('未抛出错误'));
    } catch (err) {
      if (/不存在/.test(err.message)) ok('仓库不存在 → 友好错误');
      else fail('仓库不存在 → 友好错误', err);
    }

    const progress = [];
    const saved = await downloadAsset(found.asset, {
      destDir: tmpDir,
      onProgress: (p) => progress.push(p.percent),
    });
    const data = fs.readFileSync(saved.file);
    const blobHit = mock.seen.find((s) => s.path === '/blob/setup');
    if (data.equals(mock.payload) && progress.length > 0 && blobHit && !blobHit.auth) {
      ok('下载安装包（重定向 + 进度 + 不向对象存储泄漏 Token）', `${data.length} 字节`);
    } else {
      fail('下载安装包（重定向 + 进度 + 不向对象存储泄漏 Token）', new Error(`bytes=${data.length} progress=${progress.length} auth=${blobHit && blobHit.auth}`));
    }

    if (pickAsset([{ name: 'portable.exe', size: 1 }]).name === 'portable.exe' && pickAsset([]) === null) {
      ok('安装包挑选与空资源处理');
    } else {
      fail('安装包挑选与空资源处理', new Error('挑选结果异常'));
    }
  } finally {
    await new Promise((r) => mock.server.close(r));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

(async () => {
  console.log('小爱音箱控制台 · 自检\n');
  console.log('[1/6] 语法');
  try { checkSyntax(); } catch (err) { fail('语法检查', err); }
  console.log('[2/6] MiNA 云端通道');
  try { await checkMina(); } catch (err) { fail('MiNA 云端通道', err); }
  try { await checkQrLogin(); } catch (err) { fail('扫码登录', err); }
  console.log('[3/6] 在线音乐（网易云）');
  await checkMusic();
  console.log('[4/6] 在线音乐（QQ 音乐）');
  await checkQQMusic();
  checkProviders();
  checkCookieTools();
  console.log('[5/6] 本地媒体服务');
  await checkMediaServer();
  console.log('[6/6] 版本更新');
  try { await checkUpdater(); } catch (err) { fail('版本更新', err); }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - bad.length} 通过 / ${bad.length} 失败`);
  process.exit(bad.length ? 1 : 0);
})();
