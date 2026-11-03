'use strict';

const http = require('http');

module.exports = function runE2E(win, app) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 模拟「手机 APP 改了音量」：只改云端设备状态，界面保持不动
  function setDeviceVolume(v) {
    const base = process.env.XIAOMI_MINA_BASE;
    return new Promise((resolve) => {
      http.get(`${base}/__control?volume=${v}`, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', resolve);
    });
  }

  async function until(expr, timeout = 8000, step = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await js(`Boolean(${expr})`)) return true;
      await wait(step);
    }
    return false;
  }

  win.webContents.once('did-finish-load', async () => {
    // 音量轮询同步在 window 隐藏/最小化时会暂停（正常省电逻辑），
    // 测试开始前把窗口拉到前台并聚焦，避免人工操作窗口造成偶发失败
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch (_) { /* 窗口操作失败不影响用例 */ }
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

      // 用假 Cookie 让 QQ 音源进入「已登录」，供歌单与连播测试使用（云端为本地模拟）
      await js(`(() => {
        document.getElementById('btnCookiePanel').click();
        document.getElementById('musicCookie').value = 'uin=1000000001; qm_keyst=' + 'F'.repeat(60);
        document.getElementById('btnCookieSave').click();
        return true;
      })()`);
      const qqLoggedIn = await until(`document.getElementById('musicTag').textContent.trim() === '已登录'`, 8000);
      add('粘贴 Cookie → 音源显示已登录', qqLoggedIn, await js(`document.getElementById('musicTag').textContent`));

      // 平台歌单：读取 + 连播 + 暂停不跳下一首
      await js(`document.getElementById('btnPlRefresh').click(); true`);
      const plLoaded = await until(`document.querySelectorAll('#plSelect option').length >= 1 && document.querySelectorAll('#plSongs li.song').length >= 2`, 12000);
      const plCount = await js(`document.querySelectorAll('#plSelect option').length`);
      add('读取平台歌单 → 歌单与歌曲列表', plLoaded, `歌单 ${plCount} 个`);

      await js(`document.getElementById('btnPlPlayAll').click(); true`);
      const queueStarted = await until(`/▶ 歌单 1\\//.test(document.getElementById('log').textContent)`, 12000);
      add('播放全部 → 开始连播', queueStarted);

      await js(`document.getElementById('btnPause').click(); true`);
      await wait(1500);
      const pausedTag = await js(`document.getElementById('playerTag').textContent`);
      const tracksBefore = await js(`(document.getElementById('log').textContent.match(/▶ 歌单 /g) || []).length`);
      await wait(12000); // 起播缓冲 4s + 两轮状态轮询 6s，足够暴露「暂停后自动跳歌」
      const tracksAfter = await js(`(document.getElementById('log').textContent.match(/▶ 歌单 /g) || []).length`);
      add('连播中暂停 → 不自动播下一首',
        tracksBefore === tracksAfter && /已暂停/.test(pausedTag),
        `${pausedTag.trim()} · 曲目 ${tracksBefore}→${tracksAfter}`);

      await js(`document.getElementById('btnResume').click(); true`);
      await wait(800);
      await js(`document.getElementById('btnPlStop').click(); true`);
      const queueStopped = await until(`document.getElementById('log').textContent.includes('已停止歌单连播')`, 10000);
      add('停止连播 → 队列结束', queueStopped);

      // 汽水音乐：改成扫码登录入口（按钮可见且文案为扫码），凭证面板保留为备用
      await js(`document.querySelector('#segProvider .seg-btn[data-provider="qishui"]').click(); true`);
      const qsActive = await until(`document.querySelector('#segProvider .seg-btn[data-provider="qishui"]').classList.contains('active')`);
      const loginBtn = await js(`(() => {
        const b = document.getElementById('btnMusicLogin');
        return { hidden: b.classList.contains('hidden'), text: b.textContent.trim() };
      })()`);
      // 面板可能因为之前的用例已经打开，这里只负责确保它是打开状态
      await js(`(() => {
        const panel = document.getElementById('cookiePanel');
        if (panel.classList.contains('hidden')) document.getElementById('btnCookiePanel').click();
        return !panel.classList.contains('hidden');
      })()`);
      const keysShown = await until(`!document.getElementById('qishuiKeysPanel').classList.contains('hidden')`);
      const hintText = await js(`document.getElementById('cookieHint').textContent`);
      const qrUi = await js(`!!document.getElementById('qishuiQrModal')
        && !!document.getElementById('qishuiQrImg')
        && !!document.getElementById('btnQrRefresh')`);
      add('汽水音乐 → 显示扫码登录入口 / 保留凭证面板',
        qsActive && !loginBtn.hidden && /扫码/.test(loginBtn.text) && keysShown && qrUi,
        `按钮「${loginBtn.text}」${/扫码/.test(hintText) ? ' / 提示含扫码说明' : ''}`);

      // 扫码登录：点按钮 → 真实生成二维码（依赖网络）
      await js(`document.getElementById('btnMusicLogin').click(); true`);
      const qsQrShown = await until(`(() => {
        const m = document.getElementById('qishuiQrModal');
        const img = document.getElementById('qishuiQrImg');
        return !!m && !m.classList.contains('hidden') && !!img && String(img.src).startsWith('data:image');
      })()`, 30000);
      add('汽水扫码登录 → 二维码弹窗', qsQrShown,
        await js(`document.getElementById('qishuiQrStatus').textContent`));
      await js(`document.getElementById('btnQrRefresh').click(); true`);
      const qrRefreshed = await until(`String(document.getElementById('qishuiQrImg').src).startsWith('data:image')`, 30000);
      add('刷新二维码', qrRefreshed);
      await js(`document.getElementById('btnQrClose').click(); true`);
      const qrClosed = await until(`document.getElementById('qishuiQrModal').classList.contains('hidden')`);
      add('关闭二维码弹窗', qrClosed);

      await js(`document.querySelector('#segProvider .seg-btn[data-provider="netease"]').click(); true`);
      const backNetease = await until(`document.querySelector('#segProvider .seg-btn[data-provider="netease"]').classList.contains('active')`);
      add('切回网易云音乐', backNetease);

      // 汽水独立界面：推荐流 / 换一批 / 兜底开关
      await js(`document.querySelector('.rail-btn[data-view="qishui"]').click(); true`);
      const qsViewOn = await until(`document.getElementById('view-qishui').classList.contains('active')`);
      const qsItems = await until(`document.querySelectorAll('#qsStage .qs-up-item').length >= 6`, 20000);
      const qsFirst = await js(`(document.querySelector('#qsStage .qs-focus-name') || {}).textContent || ''`);
      const qsItemCount = await js(`document.querySelectorAll('#qsStage .qs-up-item').length`);
      add('汽水界面 → 推荐流聚焦展示', qsViewOn && qsItems, `${qsItemCount} 首 · ${qsFirst}`);

      const qsBadge = await js(`document.getElementById('qsLoginBadge').textContent`);
      const qsPills = await js(`document.getElementById('qsFallbackTag').textContent`);
      add('汽水界面 → 登录态与兜底徽标', /未登录|已登录/.test(qsBadge) && /兜底：[开关]/.test(qsPills), `${qsBadge} · ${qsPills}`);

      await js(`document.getElementById('btnQsRefresh').click(); true`);
      const qsRefreshed = await until(`(document.getElementById('log').textContent.match(/汽水推荐：取到 /g) || []).length >= 2`, 15000);
      add('换一批 → 重新拉取推荐流', qsRefreshed);

      await js(`(() => {
        const cb = document.getElementById('qsFallback');
        cb.checked = false;
        cb.dispatchEvent(new Event('change'));
        return true;
      })()`);
      const fbOff = await until(`document.getElementById('qsFallbackTag').textContent.includes('关')`, 6000);
      await js(`(() => {
        const cb = document.getElementById('qsFallback');
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
        return true;
      })()`);
      const fbOn = await until(`document.getElementById('qsFallbackTag').textContent.includes('开')`, 6000);
      add('同名曲兜底 → 开关保存并回显', fbOff && fbOn);

      await js(`document.querySelector('.rail-btn[data-view="device"]').click(); true`);
      await until(`document.getElementById('view-device').classList.contains('active')`);

      await js(`(() => {
        const v = document.getElementById('volume');
        v.value = '66';
        v.dispatchEvent(new Event('input'));
        return true;
      })()`);
      const volOk = await until(`document.getElementById('log').textContent.includes('设置音量 66')`);
      const volLabel = await js(`document.getElementById('volumeVal').textContent`);
      add('拖动音量 → 下发音量指令', volOk && volLabel === '66', `标签 ${volLabel}`);

      // issue #2：手机 APP 改音量后，界面必须同步
      await setDeviceVolume(67);
      await wait(1600); // 越过拖动保护区，模拟用户离开滑块后再刷新
      await js(`document.getElementById('btnStatusTop').click(); true`);
      const refreshSynced = await until(`document.getElementById('volume').value === '67'`, 6000);
      const refreshLabel = await js(`document.getElementById('volumeVal').textContent`);
      const refreshLog = await js(`document.getElementById('log').textContent.includes('界面已同步')`);
      add('手机端改音量 → 点刷新状态后界面同步（issue #2）',
        refreshSynced && refreshLabel === '67' && refreshLog,
        `滑块 ${await js(`document.getElementById('volume').value`)} · 标签 ${refreshLabel}`);

      // 不点刷新也应能自动同步（8 秒轮询）
      await setDeviceVolume(42);
      const pollSynced = await until(`document.getElementById('volume').value === '42'`, 15000, 300);
      add('手机端改音量 → 自动轮询同步到界面',
        pollSynced, `滑块 ${await js(`document.getElementById('volume').value`)}`);

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
