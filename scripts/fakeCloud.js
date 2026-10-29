'use strict';

const http = require('http');

const DEVICE = { deviceID: 'dev-l05b', name: '小爱音箱Play', hardware: 'L05B', presence: 'online' };

function startFakeCloud({ port = 0, host = '127.0.0.1' } = {}) {
  const seen = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, `http://${host}`);
      const p = url.pathname;
      const json = (obj, headers = {}) => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      const base = `http://${host}:${server.address().port}`;

      if (p === '/longPolling/loginUrl') {
        return json({ lp: `${base}/lp`, qr: `${base}/qr.png`, timeout: 300 });
      }
      if (p === '/qr.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
      }
      if (p === '/lp') {
        return json({
          code: 0,
          userId: 2592545123,
          passToken: 'FAKE_PASS_TOKEN',
          nonce: '1359368446494794752',
          ssecurity: 'FAKE_SSECURITY',
          location: `${base}/sts?d=DEVICE1&ticket=0`,
        });
      }
      if (p === '/sts') {
        return json({}, { 'set-cookie': ['serviceToken=FAKE_SERVICE_TOKEN; Path=/'] });
      }
      if (p === '/pass/serviceLogin') {
        return json({
          code: 0,
          userId: 2592545123,
          passToken: 'FAKE_PASS_TOKEN',
          nonce: '1359368446494794752',
          ssecurity: 'FAKE_SSECURITY',
          location: `${base}/sts?d=DEVICE1&ticket=0`,
        });
      }
      if (p === '/admin/v2/device_list') {
        return json({ code: 0, data: [DEVICE] });
      }
      if (p === '/remote/ubus') {
        const form = new URLSearchParams(body);
        const method = form.get('method');
        const message = form.get('message') || '{}';
        seen.push({ method, message });
        let info = null;
        if (method === 'player_get_play_status') info = JSON.stringify({ status: 2, volume: 40 });
        return json({ code: 0, data: info ? { code: 0, info } : { code: 0 } });
      }
      if (p === '/api/cloudsearch/pc') {
        return json({
          result: {
            songs: [
              { id: 1, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美', picUrl: '' }, dt: 269000, fee: 0 },
              { id: 2, name: '稻香', ar: [{ name: '周杰伦' }], al: { name: '魔杰座', picUrl: '' }, dt: 223000, fee: 0 },
            ],
          },
        });
      }
      if (p === '/api/song/enhance/player/url/v1') {
        const ids = new URLSearchParams(body).get('ids') || '';
        const id = Number(ids.replace(/[^\d]/g, '')) || 1;
        return json({ data: [{ id, url: `${base}/audio/${id}.mp3`, br: 320000 }] });
      }
      if (p === '/api/song/enhance/player/url') {
        const ids = new URLSearchParams(body).get('ids') || '';
        const id = Number(ids.replace(/[^\d]/g, '')) || 1;
        return json({ data: [{ id, url: `${base}/audio/${id}.mp3`, br: 320000 }] });
      }

      if (p === '/soso/fcgi-bin/client_search_cp') {
        return json({
          code: 0,
          data: {
            song: {
              list: [
                { songmid: 'qq-mid-1', songname: '晴天', singer: [{ name: '周杰伦' }], albumname: '叶惠美', albummid: '', interval: 269 },
                { songmid: 'qq-mid-2', songname: '稻香', singer: [{ name: '周杰伦' }], albumname: '魔杰座', albummid: '', interval: 223 },
              ],
            },
          },
        });
      }
      if (p === '/v8/fcg-bin/fcg_play_single_song.fcg') {
        const songmid = new URL('http://x' + req.url).searchParams.get('songmid') || 'qq-mid-1';
        return json({ code: 0, data: [{ songmid, file: { media_mid: songmid, size_320mp3: 1024, size_128mp3: 1024, size_96aac: 1024 } }] });
      }
      if (p === '/cgi-bin/musicu.fcg') {
        const payload = JSON.parse(body || '{}');
        const param = (payload.req_0 || {}).param || {};
        const mid = (param.songmid || ['qq-mid-1'])[0];
        seen.push({ method: 'qq_vkey', message: JSON.stringify(param) });
        return json({
          req_0: { code: 0, data: { sip: ['http://aqqmusic.tc.qq.com/'], midurlinfo: [{ songmid: mid, purl: `M500${mid}.mp3?vkey=FAKE`, result: 0 }] } },
        });
      }
      if (p === '/lyric/fcgi-bin/fcg_query_lyric_new.fcg') {
        return json({ retcode: 0, lyric: '[00:00.00]晴天' });
      }
      if (p === '/repos/e2e/demo/releases') {
        return json([{
          tag_name: 'v9.9.9',
          name: 'v9.9.9 关于页与更新检查',
          body: '- 新增关于应用界面\n- 新增版本更新检查',
          published_at: '2026-10-29T10:00:00Z',
          html_url: 'https://github.com/e2e/demo/releases/tag/v9.9.9',
          draft: false,
          prerelease: false,
          assets: [{
            name: 'XiaoAiSpeakerControl Setup 9.9.9.exe',
            size: 4096,
            url: `${base}/asset/setup`,
            browser_download_url: `${base}/asset/setup`,
          }],
        }]);
      }
      if (p === '/asset/setup') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '4096' });
        return res.end(Buffer.alloc(4096, 0x4d));
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        base: `http://${host}:${actual}`,
        seen,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startFakeCloud, DEVICE };
