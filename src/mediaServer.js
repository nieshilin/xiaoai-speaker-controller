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

/** 内存缓冲上限：只放几首，播完就淘汰，避免占内存/磁盘 */
const MAX_BUFFER_BYTES = 96 * 1024 * 1024;
const MAX_BUFFER_ITEMS = 6;
const BUFFER_TTL_MS = 15 * 60 * 1000;
/** 每 60s 主动清扫一次过期的解密缓冲（不再等下一次请求才顺手清） */
const BUFFER_SWEEP_MS = 60 * 1000;

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
    this.resolvers = new Map(); // provider -> async (id) => { url, br } 或 { buffer, contentType }
    this.resolved = new Map(); // `${provider}:${id}` -> { url, br, at }
    this.buffers = new Map(); // `${provider}:${id}` -> { buffer, contentType, at }
    this.bufferTimer = null;
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
        this._startBufferSweeper();
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

    // 需要本地解密的音源（如汽水加密 MP4）：resolver 直接返回内存缓冲，命中缓存就不再重复下载
    const cached = this._readBuffer(key);
    if (cached) {
      this._serveBuffer(req, res, cached);
      return;
    }

    const hit = this.resolved.get(key);
    let source = hit && Date.now() - hit.at < 10 * 60 * 1000 ? hit : null;
    if (!source) {
      try {
        const picked = await resolver(id);
        if (!picked) throw new Error('未取到播放地址');
        if (picked.buffer) {
          this._serveBuffer(req, res, this._rememberBuffer(key, picked));
          return;
        }
        if (!picked.url) throw new Error('未取到播放地址');
        source = { url: picked.url, br: picked.br || 0, at: Date.now() };
        this.resolved.set(key, source);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Resolve Failed: ${err.message}`);
        return;
      }
    }

    const target = new URL(source.url);
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

  /** 启动/停止定时清扫：只在服务存活期间跑，避免定时器泄漏 */
  _startBufferSweeper() {
    if (this.bufferTimer) return;
    this.bufferTimer = setInterval(() => this.sweepBuffers(), BUFFER_SWEEP_MS);
    if (typeof this.bufferTimer.unref === 'function') this.bufferTimer.unref();
  }

  _stopBufferSweeper() {
    if (!this.bufferTimer) return;
    clearInterval(this.bufferTimer);
    this.bufferTimer = null;
  }

  /** 删除已过期（超过 TTL 未被请求）的解密缓冲，返回释放的字节数 */
  sweepBuffers() {
    const now = Date.now();
    let freed = 0;
    for (const [key, entry] of this.buffers) {
      if (now - entry.at > BUFFER_TTL_MS) {
        freed += entry.buffer.length;
        this.buffers.delete(key);
      }
    }
    if (freed > 0) {
      this.log(`已清理过期的解密缓存：${(freed / 1024 / 1024).toFixed(1)}MB（剩余 ${this.buffers.size} 首）`);
    }
    return freed;
  }

  /** 立刻释放全部解密缓冲（停止连播 / 退出时调用），返回释放的字节数 */
  clearBuffers(reason) {
    if (!this.buffers.size) return 0;
    let freed = 0;
    for (const entry of this.buffers.values()) freed += entry.buffer.length;
    const count = this.buffers.size;
    this.buffers.clear();
    this.log(`已释放解密缓存 ${count} 首 / ${(freed / 1024 / 1024).toFixed(1)}MB${reason ? `（${reason}）` : ''}`);
    return freed;
  }

  /** 内存缓冲：过期即丢弃，按数量与总字节数双限淘汰最旧的 */
  _readBuffer(key) {
    const hit = this.buffers.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > BUFFER_TTL_MS) {
      this.buffers.delete(key);
      return null;
    }
    hit.at = Date.now(); // 用过就续期，连播时同一首不会被反复淘汰
    return hit;
  }

  _rememberBuffer(key, picked) {
    const entry = {
      buffer: picked.buffer,
      contentType: picked.contentType || 'audio/mp4',
      at: Date.now(),
    };
    this.buffers.delete(key);
    this.buffers.set(key, entry);
    let total = 0;
    for (const [k, v] of this.buffers) total += v.buffer.length;
    while (this.buffers.size > MAX_BUFFER_ITEMS || total > MAX_BUFFER_BYTES) {
      const oldestKey = this.buffers.keys().next().value;
      if (oldestKey === key) break; // 刚放进去的先留着
      const removed = this.buffers.get(oldestKey);
      this.buffers.delete(oldestKey);
      total -= removed ? removed.buffer.length : 0;
    }
    this.log(`解密音源已载入内存：${Math.round(entry.buffer.length / 1024)}KB（当前缓存 ${this.buffers.size} 首）`);
    return entry;
  }

  /** 从内存缓冲响应，支持 Range（音箱会发 206 请求做拖动/分段解码） */
  _serveBuffer(req, res, entry) {
    const buf = entry.buffer;
    const size = buf.length;
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
        'Content-Type': entry.contentType,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      res.end(buf.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.contentType,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(buf);
  }

  stop() {
    this._stopBufferSweeper();
    this.clearBuffers('媒体服务停止');
    if (this.server) {
      try { this.server.close(); } catch (_) { /* ignore */ }
      this.server = null;
    }
  }
}

module.exports = { MediaServer, AUDIO_EXT, MIME };
