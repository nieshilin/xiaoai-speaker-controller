'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DEFAULT_REPO = 'nieshilin/xiaoai-speaker-controller';
const DEFAULT_API = 'https://api.github.com';
const UA = 'XiaoAiSpeakerControl-Updater';

function parseVersion(input) {
  const raw = String(input || '').trim().replace(/^v/i, '');
  const dash = raw.indexOf('-');
  const core = dash >= 0 ? raw.slice(0, dash) : raw;
  const pre = dash >= 0 ? raw.slice(dash + 1) : '';
  const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums: nums.slice(0, 3), pre };
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (va.nums[i] > vb.nums[i]) return 1;
    if (va.nums[i] < vb.nums[i]) return -1;
  }
  if (va.pre === vb.pre) return 0;
  if (!va.pre) return 1;
  if (!vb.pre) return -1;
  return va.pre > vb.pre ? 1 : -1;
}

function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

function normalizeRepo(repo) {
  const text = String(repo || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(text)) throw new Error('仓库格式应为 owner/repo');
  return text;
}

function versionOfTag(tag) {
  const raw = String(tag || '').trim().replace(/^v/i, '');
  return /^\d+(\.\d+)*([-.+].*)?$/.test(raw) ? raw : '';
}

function githubHeaders(token) {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function request(target, { token = '', headers = {}, timeout = 15000, authHosts = ['github.com'] } = {}) {
  return new Promise((resolve, reject) => {
    const send = (url, depth) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_) {
        reject(new Error(`无效的请求地址：${url}`));
        return;
      }
      const mod = parsed.protocol === 'http:' ? http : https;
      const reqHeaders = { ...githubHeaders(token), ...headers };
      const allowAuth = authHosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
      if (token && !allowAuth) delete reqHeaders.Authorization;
      const req = mod.request(parsed, { method: 'GET', headers: reqHeaders }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && depth < 6) {
          res.resume();
          send(new URL(res.headers.location, parsed).href, depth + 1);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (_) {
            json = null;
          }
          resolve({ status, headers: res.headers, body, json });
        });
      });
      req.on('error', reject);
      req.setTimeout(timeout, () => req.destroy(new Error('请求 GitHub 超时，请检查网络')));
      req.end();
    };
    send(target, 0);
  });
}

function describeError(status, body, repo) {
  if (status === 404) return `仓库 ${repo} 不存在，或私有仓库缺少有效 Token`;
  if (status === 401) return 'GitHub Token 无效或已过期';
  if (status === 403) {
    const text = String(body || '');
    if (/rate limit/i.test(text)) return 'GitHub API 访问频率超限，请稍后再试或填写 Token';
    return '无权访问该仓库（403），请确认 Token 权限';
  }
  if (status === 0) return '无法连接 GitHub';
  return `GitHub 返回 HTTP ${status}`;
}

function pickAsset(assets) {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => a && a.name);
  const score = (name) => {
    const n = String(name).toLowerCase();
    if (/setup.*\.exe$/.test(n)) return 100;
    if (/\.exe$/.test(n)) return 80;
    if (/\.msi$/.test(n)) return 60;
    if (/\.zip$/.test(n)) return 40;
    if (/\.(dmg|pkg)$/.test(n)) return 30;
    return 0;
  };
  const best = list
    .map((a) => ({ ...a, score: score(a.name) }))
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  return {
    name: best.name,
    size: Number(best.size) || 0,
    downloadUrl: best.url || best.browser_download_url || '',
    pageUrl: best.browser_download_url || best.url || '',
  };
}

async function listReleases({ repo, token, apiBase }) {
  const base = String(apiBase || DEFAULT_API).replace(/\/+$/, '');
  const authHosts = ['github.com', new URL(base).hostname];
  const res = await request(`${base}/repos/${repo}/releases?per_page=20`, { token, authHosts });
  if (res.status !== 200) {
    const err = new Error(describeError(res.status, res.body, repo));
    err.status = res.status;
    throw err;
  }
  return Array.isArray(res.json) ? res.json : [];
}

async function listTags({ repo, token, apiBase }) {
  const base = String(apiBase || DEFAULT_API).replace(/\/+$/, '');
  const authHosts = ['github.com', new URL(base).hostname];
  const res = await request(`${base}/repos/${repo}/tags?per_page=40`, { token, authHosts });
  if (res.status !== 200) {
    const err = new Error(describeError(res.status, res.body, repo));
    err.status = res.status;
    throw err;
  }
  return Array.isArray(res.json) ? res.json : [];
}

async function fetchLatest({ repo, token = '', apiBase = DEFAULT_API, allowPrerelease = false } = {}) {
  const releases = await listReleases({ repo, token, apiBase });
  const usable = releases.filter((r) => r && !r.draft && (allowPrerelease || !r.prerelease));
  const scored = usable
    .map((r) => ({ release: r, version: versionOfTag(r.tag_name) }))
    .filter((r) => r.version)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (scored.length) {
    const { release, version } = scored[0];
    return {
      version,
      tag: release.tag_name,
      name: release.name || release.tag_name,
      notes: String(release.body || '').trim(),
      url: release.html_url || '',
      publishedAt: release.published_at || release.created_at || '',
      prerelease: !!release.prerelease,
      asset: pickAsset(release.assets),
      source: 'release',
    };
  }

  const tags = await listTags({ repo, token, apiBase });
  const best = tags
    .map((t) => ({ tag: t.name, version: versionOfTag(t.name) }))
    .filter((t) => t.version)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!best) throw new Error('该仓库还没有发布版本（Release 或 Tag）');
  return {
    version: best.version,
    tag: best.tag,
    name: best.tag,
    notes: '',
    url: `https://github.com/${repo}/releases`,
    publishedAt: '',
    prerelease: false,
    asset: null,
    source: 'tag',
  };
}

async function checkUpdate({
  repo = DEFAULT_REPO,
  token = '',
  current = '0.0.0',
  apiBase = DEFAULT_API,
  allowPrerelease = false,
} = {}) {
  const name = normalizeRepo(repo);
  const latest = await fetchLatest({ repo: name, token, apiBase, allowPrerelease });
  const currentVersion = String(current || '0.0.0').replace(/^v/i, '');
  return {
    ok: true,
    repo: name,
    current: currentVersion,
    latest: latest.version,
    hasUpdate: isNewer(latest.version, currentVersion),
    release: latest,
    asset: latest.asset,
    checkedAt: Date.now(),
  };
}

function downloadAsset(asset, { token = '', destDir, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!asset || !asset.downloadUrl) {
      reject(new Error('该版本没有可下载的安装包'));
      return;
    }
    const dir = destDir || process.cwd();
    fs.mkdirSync(dir, { recursive: true });
    const safeName = String(asset.name || 'update.exe').replace(/[\\/:*?"<>|]/g, '_');
    const file = path.join(dir, safeName);
    const part = `${file}.part`;

    const send = (target, depth, withToken) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch (_) {
        reject(new Error('下载地址无效'));
        return;
      }
      const mod = parsed.protocol === 'http:' ? http : https;
      const headers = { 'User-Agent': UA, Accept: 'application/octet-stream' };
      if (withToken && token) headers.Authorization = `Bearer ${token}`;
      const req = mod.get(parsed, { headers }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && depth < 6) {
          res.resume();
          send(new URL(res.headers.location, parsed).href, depth + 1, false);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`下载失败：HTTP ${status}`));
          return;
        }
        const total = Number(res.headers['content-length']) || asset.size || 0;
        let received = 0;
        let lastTick = 0;
        const out = fs.createWriteStream(part);
        res.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (typeof onProgress === 'function' && (now - lastTick > 250 || received === total)) {
            lastTick = now;
            onProgress({ received, total, percent: total ? Math.min(100, Math.round((received / total) * 1000) / 10) : 0 });
          }
        });
        res.pipe(out);
        out.on('error', reject);
        out.on('finish', () => {
          out.close(() => {
            try {
              fs.renameSync(part, file);
              resolve({ file, size: received });
            } catch (err) {
              reject(err);
            }
          });
        });
        res.on('error', (err) => {
          out.destroy();
          reject(err);
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
    };

    const isGithub = /(^|\.)github\.com$/i.test(new URL(asset.downloadUrl).hostname);
    send(asset.downloadUrl, 0, isGithub);
  });
}

module.exports = {
  DEFAULT_REPO,
  DEFAULT_API,
  UA,
  parseVersion,
  compareVersions,
  isNewer,
  normalizeRepo,
  versionOfTag,
  pickAsset,
  fetchLatest,
  checkUpdate,
  downloadAsset,
};
