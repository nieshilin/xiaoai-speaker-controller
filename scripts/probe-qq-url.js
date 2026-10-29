'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');
const { QQMusic } = require('../src/music');

const cfg = JSON.parse(fs.readFileSync(process.argv[2] ||
  'C:/Users/Administrator/AppData/Roaming/xiaomi-speaker-controller/config.json', 'utf8'));

(async () => {
  const q = new QQMusic({ cookie: cfg.qqCookie || '' });
  console.log('uin =', q.uin, '| key =', q.key ? q.key.slice(0, 8) + '...' : '(none)', '| loggedIn =', q.loggedIn);
  const songs = await q.search('晴天 周杰伦', { limit: 3 });
  const song = songs[0];
  console.log('song:', song.name, '-', song.artist, '| vip:', song.vip);

  for (let attempt = 0; attempt < 2; attempt++) {
    const picked = await q.songUrl(song.id);
    const url = picked.url;
    console.log(`\n[${attempt + 1}] br=${picked.br} trial=${picked.trial}`);
    console.log('url:', url);
    for (const scheme of ['https', 'http']) {
      const u = url.replace(/^http:/, scheme + ':');
      const head = await probe(u);
      console.log(`  ${scheme.toUpperCase()} → ${head.status || head.error} | ct=${head.ct} | len=${head.len} | range=${head.range}`);
    }
    if (picked.br <= 128000) break;
  }
})().catch((e) => { console.error('PROBE_FAIL', e.message); process.exit(1); });

function probe(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'GET', headers: { Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 }, (res) => {
      const len = res.headers['content-length'];
      let n = 0;
      res.on('data', (d) => { n += d.length; });
      res.on('end', () => resolve({
        status: res.statusCode,
        ct: res.headers['content-type'] || '',
        len: len || `got ${n}B`,
        range: res.headers['content-range'] || '',
      }));
      res.resume();
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}
