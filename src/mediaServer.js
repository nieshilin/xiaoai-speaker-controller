'use strict';

/**
 * 本地媒体服务器
 * ------------------------------------------------------------------
 * 音箱只能播放「它能访问到的 URL」，所以本地音乐文件不能直接传路径，
 * 需要在电脑上起一个 HTTP 服务，把文件通过局域网 URL 暴露给音箱：
 *   http://<电脑局域网 IP>:<端口>/media/<id>/<文件名>
 * 支持 Range 请求（音箱拖进度、部分解码需要 206 响应）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.ape': 'audio/x-ape',
  '.wma': 'audio/x-ms-wma',
};

const AUDIO_EXT = Object.keys(MIME);

class MediaServer {
  constructor({ port = 8931, onLog } = {}) {
    this.basePort = port;
    this.port = 0;
    this.server = null;
    this.files = new Map(); // id -> { path, name, size }
    this.resolvers = new Map(); // provider -> async (id) => { url, br }
    this.resolved = new Map(); // `${provider}:${id}` -> { url, br, at }
    this.onLog = typeof onLog === 'function' ? onLog : () => {};
  }

  registerResolver(provider, fn) {
    this.resolvers.set(provider, fn);
  }

  proxyUrl(provider, id, host) {
    return `http://${host}:${this.port}/proxy/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`;
  }

  log(msg) {
    try { this.onLog(msg); } catch (_) { /* ignore */ }
  }

  /** 启动服务，端口被占用则顺延尝试 */
  async start() {
    if (this.server) return this.port;
    for (let i = 0; i < 10; i++) {
      const port = this.basePort + i;
      const ok = await new Promise((resolve) => {
        const srv = http.createServer((req, res) => this._handle(req, res));
        srv.once('error', () => { resolve(null); });
        srv.listen(port, '0.0.0.0', () => resolve(srv));
      });
      if (ok) {
        this.server = ok;
        this.port = port;
        this.log(`本地媒体服务已启动：0.0.0.0:${port}`);
        return port;
      }
    }
    throw new Error(`无法监听 ${this.basePort}~${this.basePort + 9} 端口，可能被占用或被防火墙拦截`);
  }

  /** 注册一个本地音频文件，返回可访问的媒体 id */
  addFile(filePath) {
    const abs = path.resolve(filePath);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error(`不是文件：${abs}`);
    const ext = path.extname(abs).toLowerCase();
    if (!MIME[ext]) throw new Error(`不支持的音频格式：${ext || '未知'}（支持 ${AUDIO_EXT.join(' ')}）`);
    const id = crypto.createHash('md5').update(abs).digest('hex').slice(0, 12);
    this.files.set(id, { path: abs, name: path.basename(abs), size: stat.size, mtime: stat.mtimeMs });
    return id;
  }

  /** 生成对外的播放地址 */
  urlFor(id, host) {
    const f = this.files.get(id);
    if (!f) throw new Error('媒体未注册');
    return `http://${host}:${this.port}/media/${id}/${encodeURIComponent(f.name)}`;
  }

  _handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const px = /^\/proxy\/([a-z0-9_-]+)\/(.+)$/i.exec(url.pathname);
    if (px) {
      this._proxy(req, res, px[1], decodeURIComponent(px[2]));
      return;
    }
    const m = /^\/media\/([0-9a-f]{8,32})\/(.*)$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const file = this.files.get(m[1]);
    if (!file || !fs.existsSync(file.path)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Media Not Found');
      return;
    }

    let size = 0;
    try { size = fs.statSync(file.path).size; } catch (_) { /* ignore */ }

    const type = MIME[path.extname(file.path).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const rm = /bytes=(\d*)-(\d*)/.exec(range);
      let start = rm && rm[1] ? parseInt(rm[1], 10) : 0;
      let end = rm && rm[2] ? parseInt(rm[2], 10) : size - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(file.path, { start, end });
      stream.on('error', () => res.end());
      stream.pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file.path);
    stream.on('error', () => res.end());
    stream.pipe(res);
  }

  async _proxy(req, res, provider, id) {
    const resolver = this.resolvers.get(provider);
    if (!resolver) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unknown Provider');
      return;
    }

    const key = `${provider}:${id}`;
    let hit = this.resolved.get(key);
    if (!hit || Date.now() - hit.at > 10 * 60 * 1000) {
      try {
        const picked = await resolver(id);
        if (!picked || !picked.url) throw new Error('未取到播放地址');
        hit = { url: picked.url, br: picked.br || 0, at: Date.now() };
        this.resolved.set(key, hit);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Resolve Failed: ${err.message}`);
        return;
      }
    }

    const target = new URL(hit.url);
    const lib = target.protocol === 'http:' ? http : require('https');
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
      Referer: 'https://y.qq.com/',
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = lib.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
    }, (r) => {
      if (r.statusCode >= 400) {
        this.resolved.delete(key);
        r.resume();
        res.writeHead(r.statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Upstream ${r.statusCode}`);
        return;
      }
      const out = {
        'Content-Type': r.headers['content-type'] || 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      if (r.headers['content-length']) out['Content-Length'] = r.headers['content-length'];
      if (r.headers['content-range']) out['Content-Range'] = r.headers['content-range'];
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    });

    upstream.setTimeout(20000, () => upstream.destroy(new Error('上游超时')));
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Upstream Error: ${err.message}`);
      } else {
        res.end();
      }
    });
    upstream.end();
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch (_) { /* ignore */ }
      this.server = null;
    }
  }
}

module.exports = { MediaServer, AUDIO_EXT, MIME };
