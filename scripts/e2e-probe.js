'use strict';

module.exports = function runE2E(win, app) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function until(expr, timeout = 8000, step = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await js(`Boolean(${expr})`)) return true;
      await wait(step);
    }
    return false;
  }

  win.webContents.once('did-finish-load', async () => {
    const checks = [];
    const add = (name, pass, extra) => {
      checks.push({ name, pass, extra });
      console.log(`  ${pass ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
    };

    try {
      await until(`typeof document.getElementById('btnQrLogin').onclick === 'function'`, 8000, 100);
      await js(`document.getElementById('btnQrLogin').click(); true`);
      const qrShown = await until(`document.getElementById('qrImg').src.startsWith('data:image/png')`);
      add('扫码登录 → 渲染二维码', qrShown, qrShown ? '' : await js(`document.getElementById('log').textContent`));

      const loggedIn = await until(`document.getElementById('statusText').textContent.includes('已连接')`);
      add('扫码完成 → 自动选中音箱', loggedIn, await js(`document.getElementById('statusText').textContent`));
      if (!loggedIn) throw new Error('登录后未连接音箱');

      const devText = await js(`document.getElementById('deviceSelect').selectedOptions[0].textContent`);
      add('设备下拉已填充', /小爱音箱Play/.test(devText), devText.trim());

      const unlocked = await js(`!document.getElementById('btnPause').disabled && !document.getElementById('btnPlayUrl').disabled`);
      add('控制按钮已解锁', unlocked);

      await js(`(() => {
        document.getElementById('q').value = '晴天';
        document.getElementById('btnSearch').click();
        return true;
      })()`);
      const searched = await until(`document.querySelectorAll('#songList li.song').length >= 2`);
      const firstSong = await js(`(document.querySelector('#songList li.song .song-title') || {}).textContent || ''`);
      add('搜索 → 渲染歌曲列表', searched, firstSong);

      await js(`document.querySelector('#songList li.song').click(); true`);
      const played = await until(`document.getElementById('log').textContent.includes('已让音箱播放')`);
      add('点击歌曲 → 云端下发播放', played);

      const tag0 = await js(`document.getElementById('musicTag').textContent.trim()`);
      add('音源登录状态标签', tag0 === '未登录' || tag0 === '已登录', tag0);

      await js(`document.querySelector('#segProvider .seg-btn[data-provider="qq"]').click(); true`);
      const switched = await until(`document.querySelector('#segProvider .seg-btn[data-provider="qq"]').classList.contains('active')`);
      add('切换音源 → QQ 音乐', switched);

      await js(`(() => {
        document.getElementById('q').value = '晴天';
        document.getElementById('btnSearch').click();
        return true;
      })()`);
      const qqList = await until(`document.querySelectorAll('#songList li.song').length >= 2`);
      const qqFirst = await js(`(document.querySelector('#songList li.song .song-title') || {}).textContent || ''`);
      add('QQ 音乐搜索 → 渲染列表', qqList, qqFirst);

      await js(`document.querySelector('#songList li.song').click(); true`);
      const qqPlayed = await until(`document.getElementById('log').textContent.includes('已让音箱播放')`);
      add('QQ 音乐 → 解析音源并下发', qqPlayed);

      await js(`document.querySelector('#segProvider .seg-btn[data-provider="netease"]').click(); true`);
      const backNetease = await until(`document.querySelector('#segProvider .seg-btn[data-provider="netease"]').classList.contains('active')`);
      add('切回网易云音乐', backNetease);

      await js(`(() => {
        const v = document.getElementById('volume');
        v.value = '66';
        v.dispatchEvent(new Event('input'));
        return true;
      })()`);
      const volOk = await until(`document.getElementById('log').textContent.includes('设置音量 66')`);
      const volLabel = await js(`document.getElementById('volumeVal').textContent`);
      add('拖动音量 → 下发音量指令', volOk && volLabel === '66', `标签 ${volLabel}`);

      await js(`(() => {
        document.getElementById('tts').value = '端到端测试播报';
        document.getElementById('btnTts').click();
        return true;
      })()`);
      const ttsOk = await until(`document.getElementById('log').textContent.includes('语音播报')`);
      add('播报按钮 → 下发 TTS', ttsOk);

      await js(`document.getElementById('btnStatus').click(); true`);
      const statusOk = await until(`document.getElementById('log').textContent.includes('播放状态')`);
      add('状态按钮 → 回填播放状态', statusOk);

      await js(`document.getElementById('version').click(); true`);
      const aboutOpen = await until(`!document.getElementById('aboutModal').classList.contains('hidden')`, 4000);
      add('版本号 → 打开关于应用', aboutOpen);

      const aboutVer = await js(`document.getElementById('infoVersion').textContent`);
      const aboutRt = await js(`document.getElementById('infoElectron').textContent + ' / ' + document.getElementById('infoNode').textContent`);
      add('关于页 → 版本与运行时信息', /^v\d+\.\d+\.\d+$/.test(aboutVer) && /\d+\.\d+/.test(aboutRt), `${aboutVer} · ${aboutRt}`);

      await js(`document.getElementById('btnCheckUpdate').click(); true`);
      const updateFound = await until(`document.getElementById('updateText').textContent.includes('发现新版本')`, 8000);
      add('检查更新 → 提示新版本', updateFound, await js(`document.getElementById('updateText').textContent`));

      await js(`document.getElementById('btnDownloadUpdate').click(); true`);
      const downloaded = await until(`document.getElementById('updateTip').textContent.includes('已保存')`, 12000);
      add('下载安装包 → 保存到本地', downloaded, await js(`document.getElementById('updateTip').textContent`));

      await js(`document.getElementById('btnAboutClose').click(); true`);
      const aboutClosed = await until(`document.getElementById('aboutModal').classList.contains('hidden')`, 3000);
      add('关闭关于面板', aboutClosed);

      const logText = await js(`document.getElementById('log').textContent`);
      const errors = await js(`Array.from(document.querySelectorAll('#log .err')).map((n) => n.textContent).join(' | ')`);
      add('日志无失败条目', !/✗/.test(logText), errors.slice(0, 120));

      await js(`document.getElementById('btnLogout').click(); true`);
      const off = await until(`document.getElementById('statusText').textContent.includes('未连接')`);
      add('退出登录 → 状态复位', off);
    } catch (err) {
      add('执行中断', false, err.message);
    }

    const failed = checks.filter((c) => !c.pass);
    console.log(`\nE2E 结果：${checks.length - failed.length} 通过 / ${failed.length} 失败`);
    console.log(failed.length ? 'E2E_FAIL' : 'E2E_OK');
    try { app.exit(failed.length ? 1 : 0); } catch (_) { process.exit(failed.length ? 1 : 0); }
  });
};
