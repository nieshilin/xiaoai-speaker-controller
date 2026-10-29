'use strict';

/**
 * 极简 JSON 配置存储（写入 userData 目录，原子写避免半截文件）
 */

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir, name = 'config.json') {
    this.file = path.join(dir, name);
    this.data = {};
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
      }
    } catch (_) {
      this.data = {};
    }
    return this.data;
  }

  get(key, fallback) {
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    this.data[key] = value;
    this._flush();
    return value;
  }

  setAll(patch) {
    Object.assign(this.data, patch || {});
    this._flush();
    return this.data;
  }

  _flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (_) {
      /* 配置写失败不影响主流程 */
    }
  }
}

module.exports = { Store };
