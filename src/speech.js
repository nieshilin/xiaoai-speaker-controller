'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const TTS_BASE = process.env.SPEECH_BASE || 'https://fanyi.baidu.com';
const MAX_SEGMENT = 120;
const MAX_TOTAL = 1200;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitText(text, max = MAX_SEGMENT) {
  const clean = normalizeText(text).slice(0, MAX_TOTAL);
  if (!clean) return [];
  const parts = [];
  let rest = clean;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('；'),
      window.lastIndexOf('，'),
      window.lastIndexOf(' ')
    );
    const at = cut > max * 0.4 ? cut + 1 : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts.filter(Boolean);
}

function ttsUrl(text, { speed = 5 } = {}) {
  return `${TTS_BASE}/gettts?lan=zh&spd=${speed}&source=web&text=${encodeURIComponent(text)}`;
}

function looksLikeAudio(buf, type) {
  if (!buf || buf.length < 512) return false;
  if (/audio|mpeg|mp3/i.test(String(type || ''))) return true;
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return true;
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

function get(url, { timeout = 12000, depth = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      reject(new Error('语音合成地址无效'));
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(parsed, { headers: { 'User-Agent': UA, Referer: `${TTS_BASE}/` } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && depth < 3) {
        res.resume();
        get(new URL(res.headers.location, parsed).href, { timeout, depth: depth + 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (status !== 200) {
          reject(new Error(`语音合成服务返回 HTTP ${status}`));
          return;
        }
        if (!looksLikeAudio(buf, res.headers['content-type'])) {
          reject(new Error('语音合成服务未返回音频'));
          return;
        }
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('语音合成请求超时')));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWithRetry(url, { attempts = 4, timeout = 12000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await get(url, { timeout });
    } catch (err) {
      last = err;
      if (i < attempts - 1) await wait(350 + i * 450);
    }
  }
  throw last || new Error('语音合成失败');
}

async function synthesize(text, { dir, speed = 5 } = {}) {
  const segments = splitText(text);
  if (!segments.length) throw new Error('请输入要播报的文字');
  const buffers = [];
  for (const seg of segments) {
    buffers.push(await getWithRetry(ttsUrl(seg, { speed })));
  }
  const audio = Buffer.concat(buffers);
  const target = dir || path.join(require('os').tmpdir(), 'xiaoai-tts');
  fs.mkdirSync(target, { recursive: true });
  const hash = crypto.createHash('sha1').update(segments.join('|')).digest('hex').slice(0, 12);
  const file = path.join(target, `tts-${hash}.mp3`);
  fs.writeFileSync(file, audio);
  return { file, bytes: audio.length, segments: segments.length, text: segments.join('') };
}

module.exports = {
  TTS_BASE,
  MAX_SEGMENT,
  MAX_TOTAL,
  normalizeText,
  splitText,
  ttsUrl,
  get,
  getWithRetry,
  synthesize,
};
