'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { startFakeCloud } = require('./fakeCloud');

const ROOT = path.resolve(__dirname, '..');
const DOWNLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoai-e2e-downloads-'));

(async () => {
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch (_) { /* 无残留 */ }
  await new Promise((r) => setTimeout(r, 800));

  const fake = await startFakeCloud();
  console.log(`模拟小米云端已就绪 ${fake.base}\n`);

  const env = {
    ...process.env,
    XIAOMI_ACCOUNT_BASE: fake.base,
    XIAOMI_MINA_BASE: fake.base,
    NETEASE_BASE: fake.base,
    QQ_SEARCH_BASE: fake.base,
    QQ_API_BASE: fake.base,
    NETEASE_LOGIN_URL: `${fake.base}/login-stub`,
    GITHUB_API_BASE: fake.base,
    UPDATE_REPO: 'e2e/demo',
    GITHUB_TOKEN: 'e2e-token',
    UPDATE_DOWNLOAD_DIR: DOWNLOAD_DIR,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electron, ['.', '--e2e'], { cwd: ROOT, env, stdio: 'inherit' });

  const timer = setTimeout(() => {
    console.error('\nE2E 超时（90s），强制结束');
    try { child.kill(); } catch (_) { /* ignore */ }
    fake.close();
    process.exit(1);
  }, 90000);

  child.on('exit', async (code) => {
    clearTimeout(timer);
    console.log(`\n模拟云端收到指令：${fake.seen.map((s) => s.method).join(', ')}`);
    await fake.close();
    try { fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    process.exit(code === 0 ? 0 : 1);
  });
})();
