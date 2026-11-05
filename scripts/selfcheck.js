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
  const walk = (dir, prefix) => {
    const p = path.join(ROOT, dir);
    if (!fs.existsSync(p)) return;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'auth-assets') continue;
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.js')) {
        files.push(`${prefix}${entry.name}`);
      }
    }
  };
  walk('src', 'src/');
  walk('renderer', 'renderer/');
  walk('scripts', 'scripts/');
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
      return { status: 200, headers: { 'content-type': 'image/png' }, buffer: Buffer.alloc(512, 7), body: '', cookies: {} };
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

  // 小米偶发返回 HTML/JSON（风控、接口调整），必须报出真实内容而不是塞给 <img> 变成空白
  const badAcc = new MiAccount({
    transport: async (url) => {
      const u = new URL(url);
      if (u.pathname === '/longPolling/loginUrl') {
        return { status: 200, body: JSON.stringify({ lp: 'https://x/lp', qr: 'https://x/qr', timeout: 300 }), cookies: {} };
      }
      return { status: 200, headers: { 'content-type': 'text/html' }, buffer: Buffer.from('<html>captcha</html>'), body: '', cookies: {} };
    },
  });
  await badAcc.qrStart('micoapi');
  let rejected = '';
  try { await badAcc.qrImage('https://x/qr'); } catch (e) { rejected = e.message; }
  if (!/而不是图片/.test(rejected)) throw new Error(`非图片二维码返回未被拦截：${rejected || '没有报错'}`);
  ok('二维码非图片返回被拦截', rejected.slice(0, 40));

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
    // issue #3：单行 input 会把多行 Cookie 的换行吞成空格，必须逐对提取
    const MU = 'A'.repeat(32);
    const rows = ['_iuqxldmzr_=32', '_ntes_nuid=xyz789', '__csrf=csrfTOKEN01', 'MUSIC_U=' + MU, 'JSESSIONID-WYYY=jsess1'];
    for (const sep of ['; ', '\n', ' ']) {
      const r = normalizeCookie('netease', rows.join(sep));
      if (!r.ok || !r.cookie.includes('MUSIC_U=' + MU)) throw new Error(`Cookie 分隔符 "${sep.replace('\n', '\\n')}" 粘贴解析失败`);
    }

    if (!qqAuth('uin=o0123456789; qm_keyst=ABCDEFGH').hasPlayback) throw new Error('qqAuth 未识别播放凭证');
    if (qqAuth('uin=o0123456789; p_skey=x').hasPlayback) throw new Error('只有 p_skey 时不应判定可播放');
    if (!qqAuth('uin=o0123456789; p_skey=x').hasAccount) throw new Error('qqAuth 未识别「账号已登录」中间态');
    if (!neteaseAuth('MUSIC_U=' + 'y'.repeat(40)).hasLogin) throw new Error('neteaseAuth 判定失败');
    ok('Cookie 抓取与校验', '域过滤 / 择优 / 优先级 / 粘贴规范化');
  } catch (err) {
    fail('Cookie 抓取与校验', err);
  }
}

function checkVolumeSync() {
  const { normalizeVolume, needsUiSync } = require('../src/volumeSync');
  const cases = [
    [42, 42],
    ['55', 55],
    [' 60 % ', 60],
    [{ volume: 33 }, 33],
    [0, 0],
    [100, 100],
  ];
  const bad = cases.filter(([raw, want]) => normalizeVolume(raw) !== want);
  const nulls = [-1, 101, '', null, undefined, 'abc', {}, NaN].filter((raw) => normalizeVolume(raw) !== null);
  if (!bad.length && !nulls.length) ok('设备音量归一化（数字 / 字符串 / 对象 / 越界值）');
  else fail('设备音量归一化', new Error(JSON.stringify({ bad, nulls })));

  const decide = needsUiSync(40, 55) && !needsUiSync(55, 55) && !needsUiSync(55, -1) && needsUiSync(NaN, 30);
  if (decide) ok('界面音量是否需要同步的判定');
  else fail('界面音量是否需要同步的判定', new Error('判定结果异常'));

  const renderer = fs.readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const wired = renderer.includes('syncVolumeFromDevice')
    && renderer.includes('startStatusPolling')
    && /label\.textContent = String\(n\)/.test(renderer)
    && /case 'status'[\s\S]{0,400}normalizeVolume/.test(main);
  if (wired) ok('刷新状态 / 轮询把设备音量回写到滑块（issue #2）');
  else fail('音量回写链路', new Error('渲染层或主进程未接入音量同步'));
}

function checkQueueGuards() {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8');
  const pauseGuard = /if \(playQueue\.paused\)[\s\S]{0,140}?continue;/.test(main);
  const stopGuard = (main.match(/if \(playQueue\.stopFlag\) break;/g) || []).length >= 2;
  const pausedLabel = renderer.includes('已暂停 · ');
  const pauseNotWarned = /st\.status !== 1 && st\.status !== 2/.test(main);
  if (pauseGuard && stopGuard && pausedLabel && pauseNotWarned) {
    ok('连播：暂停不跳歌 / 停止后不再下发 / 暂停不误报未播放');
  } else {
    fail('连播保护', new Error(JSON.stringify({ pauseGuard, stopGuard, pausedLabel, pauseNotWarned })));
  }
}

/** 汽水扫码登录：离线验证桥接层的 Cookie 落库与状态判定（不发起网络请求） */
async function checkQishuiLogin() {
  const { createQishuiQrLoginBridge, hasLoginCookie } = require('../src/qishui/qishuiLogin');
  const os = require('os');
  const cfgFile = path.join(os.tmpdir(), `xiaoai-qishui-login-test-${process.pid}.json`);
  try { fs.unlinkSync(cfgFile); } catch (_) { /* 首次运行不存在 */ }

  const bridge = createQishuiQrLoginBridge({ configFile: cfgFile });
  const empty = bridge.getStatus();
  if (empty.loggedIn || empty.cookieReady) throw new Error('空配置不应判定为已登录');

  const cookie = 'sessionid=abc123; sessionid_ss=def456; sid_tt=ghi789';
  bridge.setCookie(cookie);
  const after = bridge.getStatus();
  if (bridge.getCookie() !== cookie) throw new Error('setCookie 未写回配置');
  if (!after.loggedIn || !after.cookieReady) throw new Error('写入 sessionid 后未判定为已登录');
  if (!fs.existsSync(cfgFile)) throw new Error('配置未落盘');

  // 缺登录字段的 Cookie 不能算已登录（避免半截 Cookie 误判）
  bridge.setCookie('msToken=xyz; ttwid=1');
  if (bridge.getStatus().loggedIn) throw new Error('无 sessionid 的 Cookie 被误判为已登录');
  bridge.setCookie('');
  if (bridge.getStatus().loggedIn) throw new Error('清空后仍判定为已登录');

  const plain = hasLoginCookie('foo=1');
  if (plain) throw new Error('hasLoginCookie 判定过宽');
  ok('汽水扫码登录桥：Cookie 落库 / 登录态判定 / 清除');

  // 并发查询必须单飞：二次验证窗口打开期间重复查询会重渲染验证组件，导致窗口闪现即关
  const cfgFile2 = path.join(os.tmpdir(), `xiaoai-qishui-singleflight-${process.pid}.json`);
  try { fs.unlinkSync(cfgFile2); } catch (_) { /* 首次运行不存在 */ }
  let authCalls = 0;
  const slowAuth = {
    configure() {},
    async getQrCode() {
      return { message: 'success', data: { token: 'TK-SF', qrcode: 'data:image/png;base64,AAAA' } };
    },
    async checkQrConnect() {
      authCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { message: 'success', data: { error_code: 0, status: '2', confirmed: false } };
    },
    async clear() {},
  };
  const sfBridge = createQishuiQrLoginBridge({ configFile: cfgFile2, auth: slowAuth });
  await sfBridge.createQrCode();
  const sfResults = await Promise.all([
    sfBridge.checkQrConnect('TK-SF'),
    sfBridge.checkQrConnect('TK-SF'),
    sfBridge.checkQrConnect('TK-SF'),
  ]);
  if (authCalls !== 1) throw new Error(`并发扫码查询未单飞：底层被调用 ${authCalls} 次`);
  if (!sfResults.every((r) => r && r.data && String(r.data.status) === '2')) throw new Error('单飞结果未被复用');
  ok('汽水扫码登录桥：并发查询单飞（避免二次验证窗口被重复触发）');

  // 二次验证互斥：窗口只允许一个验证流程
  const authSrc = fs.readFileSync(path.join(ROOT, 'src', 'qishui', 'qishuiAuth.js'), 'utf8');
  if (!/verifyInFlight/.test(authSrc) || !/runSecondVerify/.test(authSrc)) {
    throw new Error('qishuiAuth 缺少二次验证互斥（verifyInFlight）');
  }
  ok('汽水二次验证：同一时间只允许一个验证窗口');

  // 主进程与界面接线：IPC 通道、扫码入口、二维码弹窗
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const wired = /ipcMain\.handle\('qishui:qr'/.test(mainSrc)
    && /ipcMain\.handle\('qishui:qrCheck'/.test(mainSrc)
    && /qishuiAuth\(\)\.setCookie/.test(mainSrc)
    && preloadSrc.includes("ipcRenderer.invoke('qishui:qr')")
    && /async function openQishuiQr/.test(rendererSrc)
    && /startQrPolling/.test(rendererSrc)
    && /setTimeout\(tick/.test(rendererSrc)
    && /QISHUI_MFA_CANCELLED/.test(mainSrc)
    && /r\.cancelled/.test(rendererSrc)
    && /id="qishuiQrModal"/.test(htmlSrc)
    && /id="qishuiQrImg"/.test(htmlSrc);
  if (!wired) throw new Error('汽水扫码登录接线不完整');
  ok('汽水扫码登录接线：IPC / 预加载 / 弹窗 / 串行轮询');

  try { fs.unlinkSync(cfgFile); } catch (_) { /* 清理失败不影响结果 */ }
  try { fs.unlinkSync(cfgFile2); } catch (_) { /* 清理失败不影响结果 */ }
}

async function checkQishui() {
  const { QishuiMusic, __test } = require('../src/qishui');
  const { extractSearchTracks, extractPlaylistTracks, extractPlaylists, extractFeedTracks, findAudio } = __test;

  // 1. 搜索响应：result_groups[].data[] 里混着 track 与 playlist
  const searchBody = {
    result_groups: [
      {
        data: [
          { type: 'track', track: { id: '111', name: '座位', duration: 245670, artists: [{ name: '姚晓棠' }], album: { name: '专辑', url_cover: { urls: ['https://p3/x.jpg'] } }, playable_range: { start: 167808, duration: 44160 } } },
          { type: 'playlist', playlist: { id: '999', title: '精选' } },
          { type: 'track', entity: { track_wrapper: { track: { id: '222', name: '完整版', duration: 200000, artists: [{ simple_display_name: 'A' }], playable_range: { duration: 200000 } } } } },
        ],
      },
    ],
  };
  const songs = extractSearchTracks(searchBody);
  const okSearch = songs.length === 2
    && songs[0].id === '111' && songs[0].artists === '姚晓棠' && songs[0].vip === true
    && songs[1].id === '222' && songs[1].vip === false && songs[1].cover === '';
  if (okSearch) ok('汽水搜索响应解析（track / entity 包装 / 试听限制识别）');
  else fail('汽水搜索响应解析', new Error(JSON.stringify(songs)));

  // 2. 歌单列表与歌单详情
  const pls = extractPlaylists({ playlists: [{ id: 7, title: '我的收藏', count_tracks: 3 }] });
  const plTracks = extractPlaylistTracks({ media_resources: [{ entity: { track_wrapper: { track: { id: '333', name: 'X', duration: 100000 } } } }] });
  if (pls.length === 1 && pls[0].id === '7' && pls[0].count === 3 && plTracks.length === 1 && plTracks[0].id === '333') {
    ok('汽水歌单列表 / 歌单详情解析');
  } else {
    fail('汽水歌单解析', new Error(JSON.stringify({ pls, plTracks })));
  }

  // 3. 取流：多档码率里挑最高，并识别 play_auth
  const trackBody = {
    track: {
      audio_info: {
        video_list: [
          { main_url: 'https://cdn/low.m4a?x=1', br: 68000 },
          { main_url: 'https://cdn/high.m4a?x=1', br: 260000 },
        ],
      },
    },
  };
  const picked = findAudio(trackBody);
  const withAuth = findAudio({ ...trackBody, play_auth: { spade_a: 'AAA' } });
  if (picked.url === 'https://cdn/high.m4a?x=1' && picked.br === 260000 && withAuth.spade) {
    ok('汽水取流挑选最高码率 / 识别加密标记');
  } else {
    fail('汽水取流解析', new Error(JSON.stringify({ picked, withAuth })));
  }

  // 4. web 网关 media-player：登录态给多档，挑最高码率并能解出 AES key
  const model = (gears, duration) => JSON.stringify({
    video_duration: duration,
    video_list: gears.map((g) => ({
      main_url: g.url,
      backup_url: '',
      video_meta: { real_bitrate: g.br, size: g.size || 1000 },
      encrypt_info: { encrypt: true, spade_a: g.spade },
    })),
  });
  const mediaBody = {
    player_infos: [{
      video_model: model([
        { url: 'https://cdn/mid.m4a', br: 132000, spade: 'nLwS+16xEPlYtRL6WIEUzF+AD/lAtDrkQaML8lm4I+hwlDidnQ==' },
        { url: 'https://cdn/best.m4a', br: 260000, spade: 'kLwe9mKwHsxjsBj+ZrEq/FSLBMZMvwT1SLoY6km6NfZ4gTCAgA==' },
      ], 210),
    }],
  };
  const mpSend = async () => ({ status: 200, buffer: Buffer.from(JSON.stringify(mediaBody)) });
  const mp = new QishuiMusic({ cookie: 'sessionid=abc1234567890', send: mpSend });
  let best = null;
  try { best = await mp.songUrl('123'); } catch (err) { best = { error: err.message }; }
  const bestOk = best && best.url === 'https://cdn/best.m4a'
    && best.br === 260000
    && best.encrypted === true
    && best.decryptKey === '54e0eeefd7f845ea960b02388888c33a'
    && best.trial === false;
  if (bestOk) ok('汽水 media-player：最高码率 / 加密识别 / spade_a 解出 AES key');
  else fail('汽水 media-player 解析', new Error(JSON.stringify(best)));

  // 5. 只有单档且时长被截短 ⇒ 判为试听片段（未登录时的典型响应）
  const trialSend = async () => ({
    status: 200,
    buffer: Buffer.from(JSON.stringify({
      player_infos: [{ video_model: model([{ url: 'https://cdn/trial.m4a', br: 132000, spade: 'nLwS+16xEPlYtRL6WIEUzF+AD/lAtDrkQaML8lm4I+hwlDidnQ==' }], 30) }],
    })),
  });
  const trialQ = new QishuiMusic({ cookie: '', send: trialSend });
  let trialPick = null;
  try { trialPick = await trialQ.songUrl('124'); } catch (err) { trialPick = { error: err.message }; }
  if (trialPick && trialPick.trial === true && trialPick.br === 132000) ok('汽水 media-player：单档短时长识别为试听片段');
  else fail('汽水试听片段识别', new Error(JSON.stringify(trialPick)));

  // 6. spade_a 固定向量：算法移植后仍能解出正确 key
  const { resolveAudioKey } = require('../src/qishui/decryptor');
  const vectors = [
    ['kLwe9mKwHsxjsBj+ZrEq/FSLBMZMvwT1SLoY6km6NfZ4gTCAgA==', '54e0eeefd7f845ea960b02388888c33a'],
    ['nLwS+16xEPlYtRL6WIEUzF+AD/lAtDrkQaML8lm4I+hwlDidnQ==', '11547106382d45269b76b8b02992a79f'],
  ];
  const vectorOk = vectors.every(([spade, want]) => resolveAudioKey({ spade_a: spade }) === want);
  let badKey = '';
  try { resolveAudioKey({ spade_a: Buffer.from('not-a-real-spade').toString('base64') }); } catch (err) { badKey = err.message; }
  if (vectorOk && /无效|不能为空/.test(badKey)) ok('汽水 spade_a → AES-128 key（固定向量校验）');
  else fail('spade_a 解密', new Error(JSON.stringify({ vectorOk, badKey })));


  // 7. 空响应（Cookie 过期）要给可操作的提示，不能只说「失败」
  const emptySend = async () => ({ status: 200, buffer: Buffer.from('') });
  const noKeys = new QishuiMusic({ cookie: '', send: emptySend });
  let msg = '';
  try { await noKeys.search('测试'); } catch (err) { msg = err.message; }
  const hintOk = /还未登录|X-Helios/.test(msg);

  const withKeys = new QishuiMusic({ cookie: 'sessionid=abc1234567890', helios: 'h', medusa: 'm', send: emptySend });
  let msg2 = '';
  try { await withKeys.search('测试'); } catch (err) { msg2 = err.message; }
  const hintOk2 = /过期|重新抓包/.test(msg2);

  if (hintOk && hintOk2) ok('汽水空响应给出签名头 / 过期提示');
  else fail('汽水空响应提示', new Error(JSON.stringify({ msg, msg2 })));

  // 5. 登录态与就绪判定
  const ready = new QishuiMusic({ cookie: 'sessionid=abc', helios: 'h', medusa: 'm' });
  const cookieOnly = new QishuiMusic({ cookie: 'sessionid=abc' });
  if (ready.ready && ready.loggedIn && !cookieOnly.ready && !new QishuiMusic({}).loggedIn) {
    ok('汽水「Cookie + 签名头」就绪判定');
  } else {
    fail('汽水就绪判定', new Error(JSON.stringify({ ready: ready.ready, cookieOnly: cookieOnly.ready })));
  }

  // 6. 主进程接线：音源注册、凭证存储、代理解析
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const wired = /qishui:\s*'qishuiCookie'/.test(mainSrc)
    && mainSrc.includes("registerResolver('qishui'")
    && mainSrc.includes("ipcMain.handle('music:keys'")
    && /case 'qishui'|name === 'qishui'/.test(mainSrc);
  if (wired) ok('汽水音源在主进程完成接线（存储 / IPC / 媒体代理）');
  else fail('汽水主进程接线', new Error('缺少存储键、music:keys 或代理注册'));

  // 7. 推荐流：items 解析 / VIP 只认 label_info / 封面补模板后缀
  const feedSongs = extractFeedTracks({
    items: [
      {
        type: 'track',
        entity: {
          track_wrapper: {
            track: {
              id: '444', name: '推荐曲', duration: 200000,
              artists: [{ name: '歌手A' }],
              stats: { count_collected: 12345 },
              label_info: { only_vip_playable: true },
              album: { name: '专', url_cover: { uri: 'tos/x', urls: ['https://p3.test/img/'], template_prefix: 'tplv-abc' } },
            },
          },
        },
      },
      {
        type: 'track',
        entity: {
          track_wrapper: {
            track: { id: '445', name: '免费曲', duration: 200000, playable_range: { duration: 40000 } },
          },
        },
      },
    ],
  });
  const feedOk = feedSongs.length === 2
    && feedSongs[0].vip === true
    && feedSongs[0].hot === 12345
    && feedSongs[0].cover === 'https://p3.test/img/tos/x~tplv-abc-image.jpg'
    && feedSongs[1].vip === false;
  if (feedOk) ok('汽水推荐流解析（VIP 标记 / 热度 / 封面模板）');
  else fail('汽水推荐流解析', new Error(JSON.stringify(feedSongs)));

  // 8. feed() 走 api5-lq 的 POST 网关，并能透出 status_code 错误
  const feedPayload = {
    items: [
      { type: 'track', entity: { track_wrapper: { track: { id: '551', name: 'A', duration: 100000 } } } },
      { type: 'track', entity: { track_wrapper: { track: { id: '552', name: 'B', duration: 100000 } } } },
    ],
    has_more: true,
  };
  const feedInst = new QishuiMusic({
    send: async (url, opts) => {
      if (!/api5-lq\.qishui\.com\/luna\/pc\/feed\/song-tab/.test(url)) throw new Error(`推荐流应走 web 网关：${url}`);
      if (opts.method !== 'POST') throw new Error('推荐流应为 POST');
      if (!/device_platform=web/.test(url)) throw new Error('推荐流缺 web 公共参数');
      return { status: 200, buffer: Buffer.from(JSON.stringify(feedPayload)) };
    },
  });
  try {
    const res = await feedInst.feed({ count: 10 });
    const resOk = res.songs.length === 2 && res.hasMore === true && res.nextCursor === 2;
    if (resOk) ok('汽水 feed()：web 网关 POST / 游标推进');
    else fail('汽水 feed() 解析', new Error(JSON.stringify(res)));
  } catch (err) {
    fail('汽水 feed() 解析', err);
  }

  const errInst = new QishuiMusic({
    send: async () => ({ status: 200, buffer: Buffer.from(JSON.stringify({ status_code: 1000006, status_info: { status_msg: '当前设备无法访问' } })) }),
  });
  let feedErrMsg = '';
  try { await errInst.feed(); } catch (err) { feedErrMsg = err.message; }
  if (/当前设备无法访问/.test(feedErrMsg)) ok('汽水 feed() 错误信息透出');
  else fail('汽水 feed() 错误透出', new Error(feedErrMsg || '未抛错'));

  // 9. 汽水独立界面接线：IPC / 预加载 / 页面 / 兜底匹配
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  const qsWired = mainSrc.includes("ipcMain.handle('qishui:feed'")
    && mainSrc.includes("ipcMain.handle('qishui:fallback'")
    && mainSrc.includes('QISHUI_FALLBACK_KEY')
    && mainSrc.includes('function findSameSong')
    && mainSrc.includes('function fallbackEnabled')
    && preloadSrc.includes("invoke('qishui:feed'")
    && preloadSrc.includes("invoke('qishui:fallback'")
    && htmlSrc.includes('id="qsStage"')
    && htmlSrc.includes('id="qsFallback"')
    && rendererSrc.includes('async function loadQishuiFeed')
    && rendererSrc.includes('function qsPlayAll');
  if (qsWired) ok('汽水独立界面接线（推荐流 IPC / 兜底开关 / 页面渲染）');
  else fail('汽水独立界面接线', new Error('缺少 qishui:feed / qishui:fallback 或页面元素'));
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

    // 解密音源：resolver 直接返回内存缓冲，不写磁盘，Range / 缓存都要正常
    let resolveCalls = 0;
    const plain = crypto.randomBytes(8192);
    ms.registerResolver('encrypted', async () => {
      resolveCalls += 1;
      return { buffer: plain, contentType: 'audio/mp4' };
    });
    const bufUrl = ms.proxyUrl('encrypted', 'track-1', '127.0.0.1');
    const bufGet = (headers = {}) => new Promise((resolve, reject) => {
      const req = http.get(bufUrl, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.setTimeout(4000, () => req.destroy(new Error('缓冲代理超时')));
    });

    const whole = await bufGet();
    const piece = await bufGet({ Range: 'bytes=1000-1999' });
    const cached = await bufGet();
    const bufOk = whole.status === 200
      && whole.body.equals(plain)
      && whole.headers['content-type'] === 'audio/mp4'
      && whole.headers['accept-ranges'] === 'bytes'
      && piece.status === 206
      && piece.body.equals(plain.subarray(1000, 2000))
      && /^bytes 1000-1999\/8192$/.test(piece.headers['content-range'])
      && cached.status === 200
      && resolveCalls === 1;
    if (bufOk) ok('内存解密音源代理（不落盘 · Range · 缓存命中）', `resolver 调用 ${resolveCalls} 次`);
    else fail('内存缓冲代理', new Error(JSON.stringify({ status: whole.status, piece: piece.status, resolveCalls })));

    // 过期缓存要能被主动清扫，而不是等下一次请求才顺手删
    const key = [...ms.buffers.keys()][0];
    ms.buffers.get(key).at = Date.now() - 16 * 60 * 1000;
    const freed = ms.sweepBuffers();
    if (freed === plain.length && ms.buffers.size === 0) {
      ok('过期解密缓存自动清扫（不依赖下一次请求）', `释放 ${freed} 字节`);
    } else {
      fail('过期缓存清扫', new Error(JSON.stringify({ freed, size: ms.buffers.size })));
    }

    // 停止连播要能立刻把内存里的解密音频还回去
    await bufGet();
    const beforeClear = ms.buffers.size;
    const cleared = ms.clearBuffers('自检');
    if (beforeClear === 1 && cleared === plain.length && ms.buffers.size === 0) {
      ok('停止连播立即释放解密缓存', `释放 ${(cleared / 1024).toFixed(0)}KB`);
    } else {
      fail('立即释放缓存', new Error(JSON.stringify({ beforeClear, cleared, size: ms.buffers.size })));
    }
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
  console.log('Xiao Ai Speaker · 自检\n');
  console.log('[1/9] 语法');
  try { checkSyntax(); } catch (err) { fail('语法检查', err); }
  console.log('[2/9] MiNA 云端通道');
  try { await checkMina(); } catch (err) { fail('MiNA 云端通道', err); }
  try { await checkQrLogin(); } catch (err) { fail('扫码登录', err); }
  console.log('[3/9] 在线音乐（网易云）');
  await checkMusic();
  console.log('[4/9] 在线音乐（QQ 音乐）');
  await checkQQMusic();
  checkProviders();
  checkCookieTools();
  console.log('[5/9] 在线音乐（汽水音乐）');
  try { await checkQishui(); } catch (err) { fail('汽水音乐', err); }
  try { await checkQishuiLogin(); } catch (err) { fail('汽水扫码登录', err); }
  console.log('[6/9] 音量同步（issue #2）');
  try { checkVolumeSync(); } catch (err) { fail('音量同步', err); }
  console.log('[7/9] 连播队列保护');
  try { checkQueueGuards(); } catch (err) { fail('连播队列保护', err); }
  console.log('[8/9] 本地媒体服务');
  await checkMediaServer();
  console.log('[9/9] 版本更新');
  try { await checkUpdater(); } catch (err) { fail('版本更新', err); }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - bad.length} 通过 / ${bad.length} 失败`);
  process.exit(bad.length ? 1 : 0);
})();
