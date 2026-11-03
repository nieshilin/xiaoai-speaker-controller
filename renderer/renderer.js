'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    connected: false,
    devices: [],
    songs: [],
    playlist: [],
    current: -1,
    playingSong: null,
    provider: 'netease',
    music: {},
  };

  function addLog(line, cls) {
    const box = $('#log');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    const row = document.createElement('div');
    if (cls) row.className = cls;
    const text = String(line);
    row.textContent = /^\[\d{2}:\d{2}:\d{2}\]/.test(text) ? text : `[${new Date().toTimeString().slice(0, 8)}] ${text}`;
    box.appendChild(row);
    while (box.childElementCount > 600) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  let toastTimer = null;
  function toast(msg, type, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show${type ? ' ' + type : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, ms || (type === 'err' ? 4200 : 2600));
  }

  function setStatus(kind, text) {
    const dot = $('#statusDot');
    dot.className = 'dot' + (kind ? ' ' + kind : '');
    $('#statusText').textContent = text;
  }

  function lockControls(locked) {
    for (const id of ['btnResume', 'btnPause', 'btnStop', 'btnStatus', 'btnTts', 'btnPlayUrl']) {
      $(`#${id}`).disabled = locked;
    }
  }

  function friendly(err) {
    return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  const LOGIN_HINT = '请检查音乐账号是否已登录，建议重新登录，并确认该账号有对应的 VIP 权益';

  async function run(label, fn, opts) {
    try {
      return await fn();
    } catch (err) {
      const why = friendly(err);
      addLog(`✗ ${label}失败：${why}`, 'err');
      const hint = opts && opts.hint ? opts.hint : '';
      if (hint) addLog(`提示：${hint}`, 'err');
      // 提示里带上具体原因（如版权限制），避免只看到「播放失败」不知道为什么
      const reason = why.length > 72 ? why.slice(0, 72) + '…' : why;
      toast(hint ? `${label}失败：${reason}\n${hint}` : `${label}失败：${reason}`, 'err', hint ? 6000 : 4200);
      return null;
    }
  }

  async function resumeCloud() {
    setStatus('busy', '恢复登录态…');
    try {
      const r = await api.cloudResume();
      if (r && r.devices && r.devices.length) {
        addLog(`已用保存的登录态恢复连接（userId ${r.userId}），找到 ${r.devices.length} 台设备`);
        await applyDevices(r.devices);
        return;
      }
      setStatus('', '未连接');
    } catch (err) {
      setStatus('', '未连接');
      addLog(`自动恢复登录失败：${friendly(err)}`);
      addLog('可以点「扫码登录」重新绑定小米账号');
    }
  }

  async function applyDevices(devices) {
    state.devices = devices || [];
    const sel = $('#deviceSelect');
    sel.innerHTML = '';
    $('#btnLogout').disabled = false;
    $('#accountTag').textContent = '已登录';

    if (!state.devices.length) {
      sel.innerHTML = '<option value="">账号下没有可控制的小爱音箱</option>';
      sel.disabled = true;
      setStatus('', '未连接');
      toast('登录成功，但账号下没有小爱音箱', 'err');
      return;
    }

    for (const d of state.devices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name} · ${d.hardware || d.model || '未知型号'}${d.online ? '' : '（离线）'}`;
      opt.dataset.name = d.name;
      opt.dataset.hardware = d.hardware || '';
      sel.appendChild(opt);
    }
    sel.disabled = false;
    await selectDevice();
  }

  async function selectDevice() {
    const sel = $('#deviceSelect');
    const opt = sel.selectedOptions[0];
    if (!opt || !opt.value) return;
    const r = await run('切换音箱', () => api.cloudSelect({
      id: opt.value,
      name: opt.dataset.name,
      hardware: opt.dataset.hardware,
    }));
    if (!r) return;
    state.connected = true;
    lockControls(false);
    $('#nowDevice').textContent = r.name || opt.dataset.name || '小爱音箱';
    $('#nowDeviceSub').textContent = `${opt.dataset.hardware || '未知型号'} · ${opt.value}`;
    setStatus('on', `已连接 · ${r.name}`);
    toast(`已连接 ${r.name}`, 'ok');
    // 连上后立刻对齐一次设备真实音量，之后每 8 秒轮询同步（手机 APP 改动也能反映到界面）
    startStatusPolling();
    pollStatus();
  }

  async function qrLogin() {
    $('#qrBox').classList.remove('hidden');
    $('#qrImg').src = '';
    $('#btnQrLogin').disabled = true;
    setStatus('busy', '等待扫码…');

    const started = await run('获取登录二维码', () => api.cloudQrStart());
    if (!started) {
      $('#qrBox').classList.add('hidden');
      $('#btnQrLogin').disabled = false;
      setStatus('', '未连接');
      return;
    }
    $('#qrImg').src = started.image;
    addLog('已生成登录二维码（5 分钟内有效）');

    const off = api.onQr((payload) => {
      if (payload && payload.image) $('#qrImg').src = payload.image;
    });

    const res = await run('扫码登录', () => api.cloudQrWait());
    off();
    $('#btnQrLogin').disabled = false;
    $('#qrBox').classList.add('hidden');

    if (!res) {
      setStatus('', '未连接');
      return;
    }
    toast('登录成功', 'ok');
    await applyDevices(res.devices);
  }

  async function logout() {
    stopStatusPolling();
    await run('退出登录', () => api.cloudLogout());
    state.connected = false;
    state.devices = [];
    lockControls(true);
    $('#deviceSelect').innerHTML = '<option value="">登录后自动读取设备</option>';
    $('#deviceSelect').disabled = true;
    $('#btnLogout').disabled = true;
    $('#accountTag').textContent = '未登录';
    setStatus('', '未连接');
  }

  function renderSongs(songs) {
    const list = $('#songList');
    list.innerHTML = '';
    state.songs = songs || [];
    if (!state.songs.length) {
      list.innerHTML = '<li class="empty">没有搜到歌曲，换个关键词试试。</li>';
      return;
    }
    for (const s of state.songs) {
      const li = document.createElement('li');
      li.className = 'song';
      const num = document.createElement('span');
      num.className = 'song-index';
      num.textContent = String(state.songs.indexOf(s) + 1);
      const main = document.createElement('div');
      main.className = 'song-main';
      const title = document.createElement('div');
      title.className = 'song-title';
      title.textContent = s.name;
      if (s.vip) {
        const vip = document.createElement('span');
        vip.className = 'vip';
        vip.textContent = 'VIP';
        title.appendChild(document.createTextNode(' '));
        title.appendChild(vip);
      }
      const sub = document.createElement('div');
      sub.className = 'song-sub';
      sub.textContent = [s.artists, s.album].filter(Boolean).join(' · ');
      main.appendChild(title);
      main.appendChild(sub);
      const play = document.createElement('button');
      play.className = 'btn ghost sm';
      play.textContent = '播放';
      play.onclick = (e) => {
        e.stopPropagation();
        playSong(s);
      };
      li.appendChild(num);
      li.appendChild(main);
      li.appendChild(play);
      li.onclick = () => playSong(s);
      list.appendChild(li);
    }
  }

  async function search() {
    const kw = $('#q').value.trim();
    if (!kw) { toast('先输入关键词'); return; }
    const btn = $('#btnSearch');
    btn.disabled = true;
    btn.textContent = '搜索中';
    const songs = await run('搜索', () => api.search(kw, state.provider));
    btn.disabled = false;
    btn.textContent = '搜索';
    if (songs) renderSongs(songs);
  }

  async function playSong(song) {
    if (!state.connected) { toast('先扫码登录并选择音箱', 'err'); return; }
    state.playingSong = song;
    toast(`正在播放：${song.name}`);
    $('#playerTag').textContent = `播放中 · ${song.name}`;
    const r = await run('播放', () => api.playSong({ id: song.id, name: `${song.name} - ${song.artists}`, provider: song.provider || state.provider }), { hint: LOGIN_HINT });
    if (r && r.trial) {
      toast(state.provider === 'qishui'
        ? '只拿到试听片段：扫码登录汽水音乐（VIP 账号）后可播完整版'
        : '这是试听片段，填 Cookie 可播完整版', 'err');
    }
  }

  function renderPlaylist() {
    const list = $('#playlist');
    list.innerHTML = '';
    if (!state.playlist.length) {
      list.innerHTML = '<li class="empty">还没有添加音乐。点「选择文件」加入本地音频，程序会通过内置 HTTP 服务推给音箱。</li>';
      return;
    }
    state.playlist.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'track' + (idx === state.current ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = `${(item.size / 1024 / 1024).toFixed(1)} MB`;
      li.appendChild(name);
      li.appendChild(size);
      li.onclick = () => playLocal(idx);
      list.appendChild(li);
    });
  }

  async function pickFiles() {
    const items = await run('选择文件', () => api.pickFiles());
    if (!items || !items.length) return;
    state.playlist.push(...items);
    renderPlaylist();
    toast(`已加入 ${items.length} 个文件`, 'ok');
  }

  async function playLocal(idx) {
    if (!state.connected) { toast('先扫码登录并选择音箱', 'err'); return; }
    if (idx < 0 || idx >= state.playlist.length) return;
    state.current = idx;
    renderPlaylist();
    const item = state.playlist[idx];
    await run('播放本地文件', () => api.playLocal({ id: item.id, name: item.name }));
  }

  function step(delta) {
    if (!state.playlist.length) { toast('列表是空的'); return; }
    const next = (state.current + delta + state.playlist.length) % state.playlist.length;
    playLocal(next);
  }

  let volumeTimer = null;
  let volumeTouch = 0;      // 用户最后一次拖动滑块的时刻，期间不覆盖界面
  let statusTimer = null;

  // 把音量写进滑块/数字，返回界面是否真的发生了变化
  function paintVolume(value) {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return false;
    const n = Math.max(0, Math.min(100, Math.round(raw)));
    const el = $('#volume');
    const changed = Number(el.value) !== n;
    el.value = String(n);
    const label = $('#volumeVal');
    if (label.textContent !== String(n)) label.textContent = String(n);
    paintRange();
    return changed;
  }

  // 设备端（手机 APP、语音指令）改了音量后，把界面拉回真实值
  function syncVolumeFromDevice(value, opts) {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) return false;
    if (Date.now() - volumeTouch < 1500) return false; // 正在拖动，别抢用户的输入
    const changed = paintVolume(raw);
    if (changed && opts && opts.log) {
      addLog(`检测到设备音量已变为 ${Math.round(raw)}，界面已同步`, 'ok');
    }
    return changed;
  }

  async function onVolumeInput() {
    const v = Number($('#volume').value);
    volumeTouch = Date.now();
    $('#volumeVal').textContent = String(v);
    paintRange();
    if (!state.connected) return;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => {
      volumeTouch = Date.now();
      api.action('volume', v).catch((err) => addLog(`✗ 设置音量失败：${friendly(err)}`, 'err'));
    }, 220);
  }

  // 轮询设备状态：手机 APP 改音量后不用手动点「刷新状态」也能同步
  async function pollStatus() {
    if (!state.connected || document.hidden) return;
    try {
      const r = await api.action('status');
      const st = (r && r.status) || {};
      const v = r && r.volume !== undefined ? r.volume : st.volume;
      syncVolumeFromDevice(v, { log: true });
    } catch (_) {
      /* 轮询失败静默处理，避免刷日志 */
    }
  }

  function startStatusPolling() {
    stopStatusPolling();
    statusTimer = setInterval(pollStatus, 8000);
  }

  function stopStatusPolling() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
  }

  async function simpleAction(action, label) {
    const r = await run(label, () => api.action(action));
    if (!r) return;
    if (action === 'status') {
      const st = r.status || {};
      const v = r.volume !== undefined ? r.volume : st.volume;
      const changed = syncVolumeFromDevice(v, { log: true });
      addLog(`播放状态：status=${st.status} 音量=${v !== undefined && v !== null ? v : '未知'}`, 'ok');
      const shown = Number($('#volume').value);
      toast(`状态 ${st.status === 2 ? '在播' : '待机'} · 音量 ${Number.isFinite(Number(v)) ? shown : '未知'}${changed ? '（已同步）' : ''}`);
      return;
    }
    toast(`${label}已下发`, 'ok');
  }

  const MUSIC_UI = {
    netease: {
      placeholder: '粘贴浏览器里的 Cookie（含 MUSIC_U）',
      hint: '取法：浏览器打开 music.163.com 并登录 → F12 → 应用(Application) → Cookies → 复制全部 → 粘贴保存。需含 <b>MUSIC_U</b>。',
    },
    qq: {
      placeholder: '粘贴浏览器里的 Cookie（含 uin 与 qm_keyst）',
      hint: '取法：浏览器打开 y.qq.com 并登录 → F12 → 网络(Network) → 点任一请求 → 复制请求头里 Cookie 整行 → 粘贴保存。需含 <b>uin</b> 与 <b>qm_keyst</b>。',
    },
    qishui: {
      placeholder: '可选：粘贴汽水 Cookie 整行（含 sessionid）',
      hint: '推荐直接用「扫码登录」：点登录按钮 → 汽水音乐 App 扫一扫，自动保存登录状态，<b>完整音源不需要抓包</b>。<br>下面的粘贴框是备用方案；只有「搜索汽水」这类 PC 接口仍需要 <b>x-helios</b> / <b>x-medusa</b>，播放和推荐都不需要。',
    },
  };

  function applyMusicState(st) {
    if (!st || !st.providers) return;
    state.music = st.providers;
    if (st.current) state.provider = st.current;

    for (const btn of document.querySelectorAll('#segProvider .seg-btn')) {
      btn.classList.toggle('active', btn.dataset.provider === state.provider);
    }
    const info = state.music[state.provider] || { label: '音源', loggedIn: false };
    const isQishui = state.provider === 'qishui';

    $('#musicTag').textContent = isQishui
      ? (info.ready ? '已就绪' : info.loggedIn ? '已登录' : '未登录')
      : (info.loggedIn ? '已登录' : '未登录');
    if ($('#plProvider')) $('#plProvider').textContent = info.label || '音源';

    // 汽水走扫码登录，按钮文案单独处理
    $('#btnMusicLogin').classList.remove('hidden');
    $('#btnMusicLogin').textContent = isQishui
      ? (info.loggedIn ? '重新扫码' : '扫码登录')
      : (info.loggedIn ? '切换账号' : '登录账号');
    $('#btnMusicLogout').classList.toggle('hidden', isQishui ? !(info.loggedIn || info.signed) : !info.loggedIn);

    const ui = MUSIC_UI[state.provider] || MUSIC_UI.netease;
    $('#musicCookie').placeholder = ui.placeholder;
    $('#cookieHint').innerHTML = ui.hint;

    // 汽水专属的三个输入框：已保存的字段只做提示，留空表示不修改
    const keysPanel = $('#qishuiKeysPanel');
    if (keysPanel) keysPanel.classList.toggle('hidden', !isQishui || $('#cookiePanel').classList.contains('hidden'));
    if (isQishui) {
      $('#qishuiHelios').placeholder = info.hasHelios ? 'X-Helios（已保存，留空不改）' : 'X-Helios 请求头';
      $('#qishuiMedusa').placeholder = info.hasMedusa ? 'X-Medusa（已保存，留空不改）' : 'X-Medusa 请求头';
      $('#qishuiDevice').placeholder = info.deviceId ? info.deviceId : 'device_id（URL 里的 device_id 或 fp）';
    }

    paintQishuiHeader();
  }

  /** 汽水独立界面的登录态 / 兜底开关回显 */
  function paintQishuiHeader() {
    const info = state.music.qishui || {};
    const badge = $('#qsLoginBadge');
    if (badge) {
      const text = info.ready
        ? '已登录 · 完整音源'
        : info.loggedIn
          ? '已登录 · 缺签名头'
          : '未登录 · 推荐仍可看';
      badge.textContent = text;
      if (text.includes('已登录 · 完整音源') || text.includes('未登录')) badge.classList.remove('warn');
      else badge.classList.add('warn');
    }
    const box = $('#qsFallback');
    if (box) box.checked = info.fallback !== false;
    const tag = $('#qsFallbackTag');
    if (tag) tag.textContent = info.fallback !== false ? '同名曲兜底：开' : '同名曲兜底：关';
  }

  async function switchProvider(name) {
    if (name === state.provider) return;
    closeQishuiQr();
    const st = await run('切换音源', () => api.setProvider(name));
    if (!st) return;
    applyMusicState(st);
    state.songs = [];
    $('#songList').innerHTML = `<li class="empty">已切换到${(st.providers[name] || {}).label || name}，输入关键词搜索。</li>`;
    // 歌单随音源切换重新读取
    pl.list = [];
    pl.id = null;
    pl.songs = [];
    pl.loadedFor = '';
    renderPlSelect();
    renderPlSongs();
  }

  /* ---------- 汽水音乐扫码登录 ---------- */

  const qr = { timer: null, token: '', refreshing: false };

  function setQrStatus(text, kind) {
    const el = $('#qishuiQrStatus');
    if (!el) return;
    el.textContent = text;
    el.className = `qr-status${kind ? ' ' + kind : ''}`;
  }

  function stopQrPolling() {
    if (qr.timer) { clearInterval(qr.timer); qr.timer = null; }
  }

  function closeQishuiQr() {
    stopQrPolling();
    qr.token = '';
    qr.refreshing = false;
    const modal = $('#qishuiQrModal');
    if (modal) modal.classList.add('hidden');
    const img = $('#qishuiQrImg');
    if (img) img.classList.remove('ready');
  }

  async function refreshQishuiQr() {
    if (qr.refreshing) return;
    qr.refreshing = true;
    stopQrPolling();
    const img = $('#qishuiQrImg');
    setQrStatus('正在生成二维码…');
    if (img) img.classList.remove('ready');
    try {
      const r = await api.qishuiQr();
      if (!r || !r.qrcode) throw new Error('二维码内容为空，请重试');
      qr.token = r.token || '';
      if (img) {
        img.src = r.qrcode;
        img.classList.add('ready');
      }
      setQrStatus('等待扫码…');
      startQrPolling();
    } catch (err) {
      const why = friendly(err);
      addLog(`✗ 生成汽水二维码失败：${why}`, 'err');
      setQrStatus(`生成失败：${why}`, 'err');
    } finally {
      qr.refreshing = false;
    }
  }

  function startQrPolling() {
    stopQrPolling();
    // 串行轮询：上一次请求（可能正阻塞在二次验证窗口）返回后才发下一次，
    // 否则并发请求会让验证窗口被反复重渲染并立即关闭。
    const tick = async () => {
      qr.timer = null;
      const token = qr.token;
      if (!token) return;
      let r = null;
      let errText = '';
      try {
        r = await api.qishuiQrCheck(token);
      } catch (err) {
        errText = friendly(err);
      }
      if (token !== qr.token) return; // 二维码已刷新，旧结果丢弃
      if (errText) {
        // 用户在验证窗口点了取消/关闭：不要立刻重新弹窗，等用户主动刷新
        if (/二次验证|验证未完成|安全验证/.test(errText)) {
          addLog(`汽水二次验证未完成：${errText}`, 'err');
          setQrStatus('未完成安全验证，点「刷新二维码」重新来一次', 'err');
          return;
        }
        addLog(`✗ 查询汽水扫码状态失败：${errText}`, 'err');
        setQrStatus(`查询状态失败：${errText}`, 'err');
      }
      if (r && r.cancelled) {
        addLog('汽水二次验证未完成（窗口被关闭）', 'err');
        setQrStatus('未完成安全验证，点「刷新二维码」重新来一次', 'err');
        return;
      }
      if (r && r.confirmed) {
        stopQrPolling();
        closeQishuiQr();
        applyMusicState(r);
        toast('汽水音乐登录成功', 'ok');
        pl.loadedFor = '';
        // 只刷新汽水自己的歌单；「音乐」页通用歌单仅在当前音源就是汽水时刷新，
        // 避免当前选着网易云/QQ（未登录）时弹出误导性的登录报错
        if (state.provider === 'qishui') loadPlatformPlaylists(true);
        loadQsPlaylists(true).catch(() => {});
        return;
      }
      if (r && r.expired) {
        setQrStatus('二维码已过期，正在刷新…', 'err');
        setTimeout(refreshQishuiQr, 700);
        return;
      }
      if (r && (r.status === '2' || r.status === 'scanned' || r.status === 'confirmed')) {
        setQrStatus('已扫码，请在手机上确认；若弹出安全验证窗口，请在该窗口内完成', 'ok');
      }
      qr.timer = setTimeout(tick, 2000);
    };
    qr.timer = setTimeout(tick, 0);
  }

  async function openQishuiQr() {
    $('#qishuiQrModal').classList.remove('hidden');
    await refreshQishuiQr();
  }

  async function musicLogin() {
    if (state.provider === 'qishui') {
      await openQishuiQr();
      return;
    }
    const btn = $('#btnMusicLogin');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '等待登录…';
    addLog(`已打开${(state.music[state.provider] || {}).label || '音源'}登录窗口，扫码或账号密码登录均可，登录成功后窗口会自动关闭`);
    const st = await run('登录账号', () => api.musicLogin(state.provider));
    btn.disabled = false;
    btn.textContent = label;
    if (!st) return;
    applyMusicState(st);
    toast('登录成功', 'ok');
    pl.loadedFor = '';
    loadPlatformPlaylists(true);
  }

  async function musicLogout() {
    const st = await run('退出登录', () => api.musicLogout(state.provider));
    if (state.provider === 'qishui') closeQishuiQr();
    if (st) {
      applyMusicState(st);
      toast('已退出登录', 'ok');
    }
  }

  async function saveCookie() {
    const cookie = $('#musicCookie').value.trim();

    if (state.provider === 'qishui') {
      const keys = {};
      const helios = $('#qishuiHelios').value.trim();
      const medusa = $('#qishuiMedusa').value.trim();
      const deviceId = $('#qishuiDevice').value.trim();
      if (helios) keys.helios = helios;
      if (medusa) keys.medusa = medusa;
      if (deviceId) keys.deviceId = deviceId;

      if (!cookie && !Object.keys(keys).length) {
        toast('先填 Cookie 或签名头再保存', 'err');
        return;
      }

      let latest = null;
      if (Object.keys(keys).length) {
        latest = await run('保存汽水签名头', () => api.setMusicKeys(keys));
        if (!latest) return;
        $('#qishuiHelios').value = '';
        $('#qishuiMedusa').value = '';
        applyMusicState(latest);
      }

      if (!cookie) {
        toast('签名头已保存', 'ok');
        return;
      }

      const info = state.music.qishui || {};
      if (!info.ready && !(keys.helios || info.hasHelios)) {
        // 有 Cookie 就能播完整音源；签名头只有搜索用得上，提示但不拦
        addLog('汽水音乐：Cookie 已保存，播放/推荐已可用；「搜索汽水」还需要 X-Helios / X-Medusa', 'info');
      }
    }

    const r = await run('保存 Cookie', () => api.setMusicCookie(state.provider, cookie));
    if (!r) return;
    $('#musicCookie').value = '';
    applyMusicState(r);
    toast(r.hasCookie
      ? (state.provider === 'qishui' && !(r.providers.qishui || {}).ready ? 'Cookie 已保存，还缺签名头' : 'Cookie 已保存')
      : 'Cookie 已清除', 'ok');
  }

  /* ---------- 平台歌单（读取账号里收藏的歌单） ---------- */

  const pl = { list: [], id: null, songs: [], loadedFor: '' };

  function currentPl() {
    return pl.list.find((p) => p.id === pl.id) || null;
  }

  function renderPlSelect() {
    const sel = $('#plSelect');
    sel.innerHTML = '';
    if (!pl.list.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '还没有读取到歌单';
      sel.appendChild(opt);
      sel.disabled = true;
      pl.id = null;
      return;
    }
    sel.disabled = false;
    for (const p of pl.list) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name}（${p.count} 首）`;
      sel.appendChild(opt);
    }
    sel.value = pl.id || pl.list[0].id;
    pl.id = sel.value;
  }

  function renderPlSongs() {
    const list = $('#plSongs');
    list.innerHTML = '';
    const cur = currentPl();
    if (!cur) {
      list.innerHTML = '<li class="empty">登录音乐账号后点「刷新歌单」，这里会列出你在平台上收藏的全部歌单。</li>';
      return;
    }
    if (!pl.songs.length) {
      list.innerHTML = '<li class="empty">这个歌单还没有歌曲，或全部无法读取。</li>';
      return;
    }
    pl.songs.forEach((s, idx) => {
      const li = document.createElement('li');
      li.className = 'song';
      const num = document.createElement('span');
      num.className = 'song-index';
      num.textContent = String(idx + 1);
      const main = document.createElement('div');
      main.className = 'song-main';
      const title = document.createElement('div');
      title.className = 'song-title';
      title.textContent = s.name;
      if (s.vip) {
        const vip = document.createElement('span');
        vip.className = 'vip';
        vip.textContent = 'VIP';
        title.appendChild(document.createTextNode(' '));
        title.appendChild(vip);
      }
      const sub = document.createElement('div');
      sub.className = 'song-sub';
      sub.textContent = [s.artists, s.album].filter(Boolean).join(' · ');
      main.appendChild(title);
      main.appendChild(sub);
      const play = document.createElement('button');
      play.className = 'btn ghost sm';
      play.textContent = '播放';
      play.onclick = (e) => { e.stopPropagation(); playSong(s); };
      const from = document.createElement('button');
      from.className = 'btn ghost sm';
      from.textContent = '从这里连播';
      from.title = '从这首开始连播整张歌单';
      from.onclick = (e) => { e.stopPropagation(); plPlayFrom(idx); };
      li.appendChild(num);
      li.appendChild(main);
      li.appendChild(from);
      li.appendChild(play);
      li.onclick = () => playSong(s);
      list.appendChild(li);
    });
  }

  async function loadPlSongs(id) {
    const cur = currentPl();
    $('#plSongs').innerHTML = '<li class="empty">正在读取歌单…</li>';
    const songs = await run('读取歌单歌曲', () => api.playlistSongs(state.provider, id), { hint: LOGIN_HINT });
    if (!songs) {
      pl.songs = [];
      $('#plSongs').innerHTML = '<li class="empty">读取失败，检查登录状态后重试。</li>';
      return;
    }
    pl.songs = songs.map((s) => ({ ...s, provider: state.provider }));
    renderPlSongs();
    if (cur) addLog(`${(state.music[state.provider] || {}).label || state.provider}「${cur.name}」共 ${pl.songs.length} 首`);
  }

  async function loadPlatformPlaylists(force) {
    const info = state.music[state.provider] || {};
    if (!info.loggedIn) {
      toast(`先登录${info.label || '音乐账号'}才能读取歌单`, 'err');
      addLog(`读取歌单失败：${info.label || '音乐账号'}未登录`);
      return;
    }
    if (!force && pl.loadedFor === state.provider && pl.list.length) return;
    const btn = $('#btnPlRefresh');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '读取中…';
    const list = await run('读取歌单', () => api.playlistList(state.provider), { hint: LOGIN_HINT });
    btn.disabled = false;
    btn.textContent = label;
    if (!list) return;
    pl.list = list;
    pl.loadedFor = state.provider;
    pl.id = list.length ? list[0].id : null;
    renderPlSelect();
    if (pl.id) await loadPlSongs(pl.id);
    else { pl.songs = []; renderPlSongs(); }
    toast(list.length ? `读到 ${list.length} 个歌单` : '账号里没有歌单', list.length ? 'ok' : 'err');
  }

  async function plPlayFrom(idx) {
    if (!pl.songs.length) { toast('先选择一个歌单'); return; }
    if (!state.connected) { toast('先扫码登录并选择音箱', 'err'); return; }
    const cur = currentPl();
    const title = cur ? cur.name : '歌单';
    const r = await run('播放歌单', () => api.queuePlay(title, pl.songs, idx), { hint: LOGIN_HINT });
    if (r) toast(`从第 ${idx + 1} 首开始连播「${title}」`, 'ok');
  }

  async function plPlayAll() {
    await plPlayFrom(0);
  }

  async function plStop() {
    const r = await run('停止连播', () => api.queueStop());
    if (r) toast('已停止连播', 'ok');
  }

  function applyQueueState(q) {
    if (!q) return;
    if (q.running && q.current) {
      const name = q.current.name || '';
      $('#playerTag').textContent = q.paused
        ? `已暂停 · ${name}`
        : `连播 ${q.index + 1}/${q.total} · ${name}`;
    } else if (!q.running && q.total) {
      $('#playerTag').textContent = '待机';
    }
    paintQishuiQueue(q);
  }

  /* ---------- 汽水音乐独立界面 ---------- */

  const qs = { songs: [], cursor: 0, hasMore: true, loading: false, seen: [], playing: '', focus: 0, pl: [], plSongs: [] };

  function fmtDuration(ms) {
    const total = Math.round((Number(ms) || 0) / 1000);
    if (!total) return '';
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /** 聚焦展示：左侧大封面 + 歌名/歌手/操作，右侧「接下来」文字列表（类汽水 App 播放页） */
  function qsFocusNode(song, index) {
    const total = qs.songs.length;
    const focus = document.createElement('div');
    focus.className = 'qs-focus';
    focus.dataset.id = song.id;

    const cover = document.createElement('div');
    cover.className = 'qs-focus-cover';
    if (song.cover) {
      const img = document.createElement('img');
      img.src = song.cover;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.remove(); cover.classList.add('noimg'); };
      cover.appendChild(img);
    } else {
      cover.classList.add('noimg');
    }
    if (song.vip) {
      const vip = document.createElement('span');
      vip.className = 'qs-vip';
      vip.textContent = 'VIP';
      cover.appendChild(vip);
    }
    focus.appendChild(cover);

    const meta = document.createElement('div');
    meta.className = 'qs-focus-meta';

    const name = document.createElement('div');
    name.className = 'qs-focus-name';
    name.textContent = song.name;

    const artist = document.createElement('div');
    artist.className = 'qs-focus-artist';
    artist.textContent = [song.artists, fmtDuration(song.duration)].filter(Boolean).join(' · ');

    const actions = document.createElement('div');
    actions.className = 'qs-focus-actions';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'btn ghost sm';
    prev.textContent = '‹ 上一首';
    prev.onclick = () => { qs.focus = (qs.focus - 1 + total) % total; renderQishuiStage(); };
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn primary';
    play.textContent = '▶ 播放这首';
    play.onclick = () => qsPlay(song);
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn ghost sm';
    next.textContent = '下一首 ›';
    next.onclick = () => { qs.focus = (qs.focus + 1) % total; renderQishuiStage(); };
    actions.appendChild(prev);
    actions.appendChild(play);
    actions.appendChild(next);

    const hint = document.createElement('div');
    hint.className = 'qs-focus-hint';
    hint.textContent = `推荐 ${index + 1} / ${total} · 点右侧列表可直接切歌`;

    meta.appendChild(name);
    meta.appendChild(artist);
    meta.appendChild(actions);
    meta.appendChild(hint);
    focus.appendChild(meta);
    return focus;
  }

  function qsUpNextNode() {
    const up = document.createElement('div');
    up.className = 'qs-upnext';
    const head = document.createElement('div');
    head.className = 'qs-upnext-head';
    head.textContent = '接下来';
    up.appendChild(head);
    const ul = document.createElement('ul');
    ul.className = 'qs-upnext-list';
    qs.songs.forEach((song, i) => {
      const li = document.createElement('li');
      li.className = 'qs-up-item';
      li.dataset.id = song.id;
      if (i === qs.focus) li.classList.add('focused');

      const num = document.createElement('span');
      num.className = 'qs-up-index';
      num.textContent = String(i + 1).padStart(2, '0');

      const main = document.createElement('div');
      main.className = 'qs-up-main';
      const title = document.createElement('div');
      title.className = 'qs-up-title';
      title.textContent = song.name;
      const sub = document.createElement('div');
      sub.className = 'qs-up-sub';
      sub.textContent = [song.artists, fmtDuration(song.duration)].filter(Boolean).join(' · ');
      main.appendChild(title);
      main.appendChild(sub);

      li.appendChild(num);
      li.appendChild(main);
      li.onclick = () => { qs.focus = i; renderQishuiStage(); qsPlay(song); };
      ul.appendChild(li);
    });
    if (qs.hasMore && qs.songs.length) {
      const li = document.createElement('li');
      li.className = 'qs-up-more';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost sm';
      btn.textContent = '加载更多';
      btn.onclick = () => loadQishuiFeed({ more: true });
      li.appendChild(btn);
      ul.appendChild(li);
    }
    up.appendChild(ul);
    return up;
  }

  function renderQishuiStage() {
    const stage = $('#qsStage');
    if (!stage) return;
    stage.innerHTML = '';
    if (!qs.songs.length) {
      const empty = document.createElement('div');
      empty.className = 'qs-stage-empty';
      empty.textContent = qs.loading ? '正在读取推荐…' : '还没读到推荐，点「换一批」再试一次。';
      stage.appendChild(empty);
    } else {
      if (qs.focus >= qs.songs.length) qs.focus = 0;
      stage.appendChild(qsFocusNode(qs.songs[qs.focus], qs.focus));
      stage.appendChild(qsUpNextNode());
    }
    const count = $('#qsCount');
    if (count) count.textContent = `${qs.songs.length} 首`;
    paintQsPlayMark();
  }

  function paintQsPlayMark() {
    const focus = document.querySelector('#qsStage .qs-focus');
    if (focus) focus.classList.toggle('playing', focus.dataset.id === String(qs.playing));
    for (const li of document.querySelectorAll('#qsStage .qs-up-item')) {
      li.classList.toggle('playing', li.dataset.id === String(qs.playing));
    }
  }

  async function loadQishuiFeed({ refresh = false, more = false, silent = false } = {}) {
    if (qs.loading) return;
    qs.loading = true;
    const refreshBtn = $('#btnQsRefresh');
    if (refresh) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '取推荐…';
    }
    if (!more && !refresh) renderQishuiStage();

    const res = await run('读取汽水推荐', () => api.qishuiFeed({
      cursor: more ? qs.cursor : 0,
      count: 10,
      refresh: refresh || !more,
      exclude: qs.seen.slice(-20),
    }));

    qs.loading = false;
    if (refresh) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '换一批';
    }
    if (!res) {
      renderQishuiStage();
      return;
    }

    const incoming = Array.isArray(res.songs) ? res.songs : [];
    if (!more) {
      qs.songs = [];
      qs.seen = [];
      qs.focus = 0;
    }
    for (const song of incoming) {
      if (!qs.songs.some((s) => s.id === song.id)) qs.songs.push(song);
      if (!qs.seen.includes(song.id)) qs.seen.push(song.id);
    }
    qs.seen = qs.seen.slice(-40);
    qs.cursor = Number(res.nextCursor) || qs.songs.length;
    qs.hasMore = res.hasMore !== false && incoming.length > 0;
    if (!more) qs.playing = qs.playing && qs.songs.some((s) => s.id === qs.playing) ? qs.playing : '';
    renderQishuiStage();
    if (refresh && !silent) toast(`换了一批，共 ${qs.songs.length} 首`, 'ok');
  }

  function paintQsNow(song, sub) {
    const box = $('#qsNow');
    if (!box) return;
    box.innerHTML = '';
    if (!song) {
      const span = document.createElement('span');
      span.className = 'qs-now-empty';
      span.textContent = '还没有开始播放';
      box.appendChild(span);
      return;
    }
    box.appendChild(document.createTextNode(song.name || ''));
    if (sub || song.artists) {
      const line = document.createElement('span');
      line.className = 'qs-now-sub';
      line.textContent = sub || song.artists;
      box.appendChild(line);
    }
  }

  function paintQishuiQueue(q) {
    if (!q) return;
    const tag = $('#qsPlayTag');
    const bar = $('#qsBar');
    if (q.running && q.current) {
      if (tag) tag.textContent = q.paused ? `已暂停 · ${q.index + 1}/${q.total}` : `连播 ${q.index + 1}/${q.total}`;
      paintQsNow(q.current, q.current.artists || '');
      if (bar) bar.style.width = `${Math.round(((q.index + 1) / Math.max(1, q.total)) * 100)}%`;
      qs.playing = String(q.current.id);
    } else if (q.total) {
      if (tag) tag.textContent = '待机';
      if (bar) bar.style.width = '0%';
    } else {
      if (tag) tag.textContent = '待机';
      if (bar) bar.style.width = '0%';
    }
    paintQsPlayMark();
  }

  async function qsPlay(song) {
    if (!state.connected) { toast('先扫码登录小米账号并选择音箱', 'err'); return; }
    qs.playing = song.id;
    paintQsPlayMark();
    paintQsNow(song, '正在解析音源…');
    $('#qsPlayTag').textContent = '解析中';
    const r = await run('播放', () => api.playSong({
      id: song.id,
      name: song.name,
      artists: song.artists || '',
      provider: 'qishui',
    }), { hint: LOGIN_HINT });
    if (!r) {
      qs.playing = '';
      paintQsPlayMark();
      paintQsNow(null);
      $('#qsPlayTag').textContent = '待机';
      const info = state.music.qishui || {};
      if (!info.loggedIn) addLog('提示：汽水未登录，扫「扫码登录」后再试，或在下方开启同名曲兜底', 'err');
      return;
    }
    if (r.matched) {
      $('#qsPlayTag').textContent = '播放中 · 同名曲';
      paintQsNow(song, `汽水无完整音源 → ${r.matched.label}：${r.matched.name}`);
      toast(`汽水没给完整音源，已用${r.matched.label}播放同名曲目`, 'ok', 4200);
    } else if (r.trial) {
      $('#qsPlayTag').textContent = '试听片段';
      paintQsNow(song, '只拿到试听片段：扫码登录汽水音乐（VIP 账号）后即为完整音源');
      toast('只拿到试听片段：请先扫码登录汽水音乐', 'err', 4200);
    } else {
      $('#qsPlayTag').textContent = `播放中 · ${Math.round((r.br || 0) / 1000)}kbps`;
      paintQsNow(song, song.artists || '');
      toast(`正在播放：${song.name}`, 'ok');
    }
  }

  async function qsPlayAll() {
    if (!qs.songs.length) { toast('等推荐加载出来再点', 'err'); return; }
    if (!state.connected) { toast('先扫码登录小米账号并选择音箱', 'err'); return; }
    const list = qs.songs.map((s) => ({ ...s, provider: 'qishui' }));
    const r = await run('播放全部', () => api.queuePlay('汽水推荐', list, 0), { hint: LOGIN_HINT });
    if (r) toast(`开始连播汽水推荐（${list.length} 首）`, 'ok');
  }

  async function qsStop() {
    const r = await run('停止连播', () => api.queueStop());
    if (r) toast('已停止连播', 'ok');
  }

  function renderQsMiniList(box, songs, emptyText) {
    if (!box) return;
    box.innerHTML = '';
    if (!songs || !songs.length) {
      box.innerHTML = `<li class="empty">${emptyText}</li>`;
      return;
    }
    songs.forEach((song, i) => {
      const li = document.createElement('li');
      li.className = 'song';
      const num = document.createElement('span');
      num.className = 'song-index';
      num.textContent = String(i + 1);
      const main = document.createElement('div');
      main.className = 'song-main';
      const title = document.createElement('div');
      title.className = 'song-title';
      title.textContent = song.name;
      const sub = document.createElement('div');
      sub.className = 'song-sub';
      sub.textContent = [song.artists, fmtDuration(song.duration)].filter(Boolean).join(' · ');
      main.appendChild(title);
      main.appendChild(sub);
      const play = document.createElement('button');
      play.className = 'btn ghost sm';
      play.textContent = '播放';
      play.onclick = (e) => { e.stopPropagation(); qsPlay(song); };
      li.appendChild(num);
      li.appendChild(main);
      li.appendChild(play);
      li.onclick = () => qsPlay(song);
      box.appendChild(li);
    });
  }

  async function loadQsPlaylists(force) {
    const info = state.music.qishui || {};
    if (!info.loggedIn) { toast('先扫码登录汽水音乐才能读歌单', 'err'); return; }
    if (!force && qs.pl.length) return;
    const btn = $('#btnQsPlLoad');
    btn.disabled = true;
    btn.textContent = '读取中…';
    const list = await run('读取汽水歌单', () => api.playlistList('qishui'), { hint: LOGIN_HINT });
    btn.disabled = false;
    btn.textContent = '读取';
    if (!list) return;
    qs.pl = list;
    const sel = $('#qsPlSelect');
    sel.innerHTML = '';
    if (!list.length) {
      sel.innerHTML = '<option value="">账号里还没有歌单</option>';
      renderQsMiniList($('#qsPlSongs'), [], '账号里还没有歌单。');
      return;
    }
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name}${p.count ? `（${p.count} 首）` : ''}`;
      sel.appendChild(opt);
    }
    await loadQsPlSongs(list[0].id);
  }

  async function loadQsPlSongs(id) {
    if (!id) return;
    renderQsMiniList($('#qsPlSongs'), [], '正在读取歌单…');
    const songs = await run('读取歌单歌曲', () => api.playlistSongs('qishui', id), { hint: LOGIN_HINT });
    if (!songs) { renderQsMiniList($('#qsPlSongs'), [], '读取失败，检查登录状态后重试。'); return; }
    qs.plSongs = songs;
    renderQsMiniList($('#qsPlSongs'), songs, '这个歌单是空的。');
  }

  async function qsSearch() {
    const kw = $('#qsQuery').value.trim();
    if (!kw) { toast('先输入关键词'); return; }
    // 汽水的搜索接口必须带签名头（登录后从客户端抓包），没就绪时直接说明，不打无效请求
    const info = state.music.qishui || {};
    if (!info.ready) {
      renderQsMiniList($('#qsSearchList'), [], '搜索需要登录汽水（必要时补 X-Helios / X-Medusa 签名头）后使用。');
      toast('汽水搜索需要登录后才能用，推荐流不受影响', 'err');
      return;
    }
    const btn = $('#btnQsSearch');
    btn.disabled = true;
    btn.textContent = '搜索中';
    const songs = await run('搜索汽水', () => api.search(kw, 'qishui'), { hint: LOGIN_HINT });
    btn.disabled = false;
    btn.textContent = '搜索';
    if (songs) renderQsMiniList($('#qsSearchList'), songs, '没有搜到，换个关键词试试。');
  }



  const about = { info: null, result: null, checking: false };

  function showView(name) {
    for (const btn of document.querySelectorAll('.rail-btn[data-view]')) {
      const on = btn.dataset.view === name;
      btn.classList.toggle('active', on);
      if (on) {
        $('#viewTitle').textContent = btn.dataset.title || '';
        $('#viewSub').textContent = btn.dataset.sub || '';
      }
    }
    for (const view of document.querySelectorAll('.view')) {
      view.classList.toggle('active', view.id === `view-${name}`);
    }
    if (name === 'music') loadPlatformPlaylists(false);
    if (name === 'qishui' && !qs.songs.length) loadQishuiFeed({ refresh: true, silent: true });
  }

  const speech = { voices: [] };

  function loadVoices() {
    if (typeof speechSynthesis === 'undefined') return;
    const all = speechSynthesis.getVoices() || [];
    speech.voices = all.filter((v) => /^zh/i.test(v.lang) || /Chinese|Huihui|Yaoyao|Kangkang|Xiaoxiao/i.test(v.name));
    const sel = $('#voiceSelect');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">自动选择中文语音</option>';
    for (const v of speech.voices) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name}（${v.lang}）`;
      sel.appendChild(opt);
    }
    if (prev) sel.value = prev;
    addLog(`本机可用语音 ${speech.voices.length} 个${speech.voices.length ? '：' + speech.voices.map((v) => v.name).join('、') : ''}`);
  }

  function speakLocal(text) {
    if (typeof speechSynthesis === 'undefined') {
      toast('当前系统不支持语音朗读', 'err');
      return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const chosen = speech.voices.find((v) => v.name === $('#voiceSelect').value);
    const fallback = speech.voices.find((v) => /zh/i.test(v.lang)) || speech.voices[0];
    const voice = chosen || fallback;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = 'zh-CN';
    }
    u.rate = 1;
    u.pitch = 1;
    speechSynthesis.speak(u);
    addLog(`本机朗读（${voice ? voice.name : '系统默认'}）：${text.slice(0, 24)}${text.length > 24 ? '…' : ''}`);
  }

  function paintRange() {
    const el = $('#volume');
    const min = Number(el.min || 0);
    const max = Number(el.max || 100);
    const pct = ((Number(el.value) - min) / (max - min)) * 100;
    el.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${pct}%, var(--line) ${pct}%)`;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtSize(bytes) {
    const size = Number(bytes) || 0;
    if (!size) return '大小未知';
    const mb = size / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  function setUpdateText(text, kind) {
    const el = $('#updateText');
    el.textContent = text;
    el.className = kind || '';
  }

  function setBadge(on) {
    $('#updateBadge').classList.toggle('hidden', !on);
    $('#version').classList.toggle('has-update', !!on);
    $('#version').title = on ? '发现新版本，点击查看更新内容' : '关于应用 / 检查更新';
  }

  function applyUpdateResult(r) {
    if (!r) return;
    about.result = r;
    const box = $('#updateResult');
    if (!r.ok) {
      box.classList.add('hidden');
      setBadge(false);
      setUpdateText(`检查失败：${r.error}`, 'err');
      return;
    }
    if (r.hasUpdate) {
      setUpdateText(`发现新版本 v${r.latest}（当前 v${r.current}）`, 'warn');
      setBadge(true);
      box.classList.remove('hidden');
      $('#updateLatest').textContent = `最新版本 v${r.latest}`;
      $('#updateDate').textContent = r.release && r.release.publishedAt
        ? `发布于 ${fmtDate(r.release.publishedAt)}`
        : '发布时间未知';
      $('#updateNotes').textContent = (r.release && r.release.notes) || '该版本没有填写更新说明。';
      $('#btnDownloadUpdate').textContent = r.asset ? `下载安装包（${fmtSize(r.asset.size)}）` : '前往发布页';
      $('#updateTip').textContent = r.asset
        ? '下载完成后会自动定位到安装包，关闭本程序再运行安装包即可升级。'
        : '该版本未附带安装包，将打开发布页。';
      return;
    }
    box.classList.add('hidden');
    setBadge(false);
    setUpdateText(`已是最新版本 v${r.current}`, 'ok');
  }

  async function openAbout() {
    $('#aboutModal').classList.remove('hidden');
    const info = await api.appInfo();
    about.info = info;
    $('#aboutVersion').textContent = 'v' + info.version;
    $('#aboutDesc').textContent = info.description || '小爱音箱控制台';
    $('#aboutCopyright').textContent = info.copyright || '';
    $('#infoVersion').textContent = 'v' + info.version;
    $('#infoElectron').textContent = info.electron;
    $('#infoChrome').textContent = info.chrome;
    $('#infoNode').textContent = info.node;
    $('#infoSystem').textContent = `${info.osVersion} · ${info.arch}`;
    $('#infoMedia').textContent = info.mediaPort
      ? `http://${info.mediaHost || '127.0.0.1'}:${info.mediaPort}/`
      : '未启动';
    $('#infoRepo').textContent = info.repo;
    $('#infoUserData').textContent = info.userData;
    $('#infoUserData').title = info.userData;
    $('#autoCheck').checked = info.autoCheck !== false;
    $('#repoInput').value = info.repo;
    const st = await api.updateState();
    if (st && st.checked) applyUpdateResult(st.checked);
    else if (!about.result) setUpdateText('尚未检查更新', '');
  }

  function closeAbout() {
    $('#aboutModal').classList.add('hidden');
  }

  async function checkUpdate() {
    if (about.checking) return;
    about.checking = true;
    const btn = $('#btnCheckUpdate');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中…';
    setUpdateText('正在连接 GitHub 检查更新…', '');
    try {
      applyUpdateResult(await api.checkUpdate());
    } catch (err) {
      setUpdateText(`检查失败：${err.message}`, 'err');
    } finally {
      about.checking = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function downloadUpdate() {
    const btn = $('#btnDownloadUpdate');
    btn.disabled = true;
    $('#updateProgress').classList.remove('hidden');
    $('#updateProgressBar').style.width = '0%';
    $('#updateTip').textContent = '正在下载安装包…';
    try {
      const r = await api.downloadUpdate();
      if (r && r.file) {
        $('#updateProgressBar').style.width = '100%';
        $('#updateTip').textContent = `安装包已保存：${r.file}`;
        toast('安装包已下载', 'ok');
      } else if (r && r.opened) {
        $('#updateTip').textContent = '已在浏览器打开发布页';
      }
    } catch (err) {
      $('#updateProgress').classList.add('hidden');
      $('#updateTip').textContent = `下载失败：${err.message}`;
      toast('下载失败', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function saveUpdateConfig() {
    const patch = { repo: $('#repoInput').value.trim(), autoCheck: $('#autoCheck').checked };
    try {
      const info = await api.saveUpdateConfig(patch);
      about.info = info;
      $('#infoRepo').textContent = info.repo;
      about.result = null;
      $('#updateResult').classList.add('hidden');
      setUpdateText('更新源已保存，点「检查更新」重新检查', 'ok');
      toast('更新源已保存', 'ok');
    } catch (err) {
      toast('保存失败：' + err.message, 'err');
    }
  }

  async function copyVersionInfo() {
    const info = about.info || await api.appInfo();
    const lines = [
      `${info.name} v${info.version}`,
      `Electron ${info.electron} / Chromium ${info.chrome} / Node ${info.node}`,
      `${info.osVersion} · ${info.arch}`,
      `更新源：${info.repo}`,
      `数据目录：${info.userData}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('版本信息已复制', 'ok');
    } catch (err) {
      toast('复制失败：' + err.message, 'err');
    }
  }

  async function init() {
    const cfg = await api.getConfig();
    $('#versionText').textContent = 'v' + cfg.appVersion;
    $('#volume').value = String(cfg.volume ?? 40);
    $('#volumeVal').textContent = String(cfg.volume ?? 40);
    paintRange();
    applyMusicState(cfg.music);

    api.onLog((line) => {
      const cls = /✗|失败|超时|⚠/.test(line) ? 'err' : /✓/.test(line) ? 'ok' : '';
      addLog(line, cls);
    });

    const ms = await run('媒体服务', () => api.mediaStatus());
    if (ms) {
      $('#mediaTag').textContent = `媒体服务 ${ms.host}:${ms.port}`;
      addLog(`本机媒体服务：${ms.url}`);
    } else {
      $('#mediaTag').textContent = '媒体服务不可用';
    }

    $('#btnQrLogin').onclick = qrLogin;
    $('#btnQrCancel').onclick = () => {
      $('#qrBox').classList.add('hidden');
      addLog('已收起登录二维码');
    };
    $('#btnLogout').onclick = logout;
    $('#deviceSelect').onchange = selectDevice;

    $('#btnSearch').onclick = search;
    $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });

    for (const btn of document.querySelectorAll('#segProvider .seg-btn')) {
      btn.onclick = () => switchProvider(btn.dataset.provider);
    }
    $('#btnMusicLogin').onclick = musicLogin;
    $('#btnQrClose').onclick = closeQishuiQr;
    $('#btnQrRefresh').onclick = refreshQishuiQr;
    $('#qishuiQrModal').addEventListener('click', (e) => {
      if (e.target && e.target.id === 'qishuiQrModal') closeQishuiQr();
    });
    $('#btnMusicLogout').onclick = musicLogout;
    $('#btnCookiePanel').onclick = () => {
      const hint = $('#cookieHint');
      const willOpen = $('#cookiePanel').classList.contains('hidden');
      $('#cookiePanel').classList.toggle('hidden');
      hint.classList.toggle('hidden', !willOpen);
      if ($('#qishuiKeysPanel')) {
        $('#qishuiKeysPanel').classList.toggle('hidden', !(willOpen && state.provider === 'qishui'));
      }
    };
    $('#btnCookieSave').onclick = saveCookie;
    $('#musicCookie').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCookie(); });
    for (const id of ['qishuiHelios', 'qishuiMedusa', 'qishuiDevice']) {
      const el = $('#' + id);
      if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCookie(); });
    }

    $('#btnPlRefresh').onclick = () => loadPlatformPlaylists(true);
    $('#btnPlPlayAll').onclick = plPlayAll;
    $('#btnPlStop').onclick = plStop;
    $('#plSelect').onchange = async () => {
      pl.id = $('#plSelect').value || null;
      if (pl.id) await loadPlSongs(pl.id);
    };
    api.onQueueProgress(applyQueueState);

    /* 汽水独立界面 */
    $('#btnQsRefresh').onclick = () => loadQishuiFeed({ refresh: true });
    $('#btnQsPlayAll').onclick = qsPlayAll;
    $('#btnQsStop').onclick = qsStop;
    $('#btnQsStop2').onclick = qsStop;
    $('#btnQsLogin').onclick = openQishuiQr;
    $('#btnQsSearch').onclick = qsSearch;
    $('#qsQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') qsSearch(); });
    $('#btnQsPlLoad').onclick = () => loadQsPlaylists(true);
    $('#qsPlSelect').onchange = () => loadQsPlSongs($('#qsPlSelect').value);
    $('#qsFallback').onchange = async (e) => {
      const st = await run('切换同名曲兜底', () => api.setQishuiFallback(!!e.target.checked));
      if (!st) { e.target.checked = !e.target.checked; return; }
      applyMusicState(st);
      toast(e.target.checked ? '已开启：汽水没音源时用 QQ/网易云同名曲目' : '已关闭跨音源兜底', 'ok');
    };

    $('#btnPick').onclick = pickFiles;
    $('#btnPrev').onclick = () => step(-1);
    $('#btnNext').onclick = () => step(1);

    $('#btnPlayUrl').onclick = async () => {
      const url = $('#url').value.trim();
      if (!url) { toast('先填播放地址'); return; }
      await run('播放地址', () => api.action('playUrl', url));
    };
    $('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnPlayUrl').click(); });
    $('#btnResume').onclick = () => simpleAction('resume', '继续播放');
    $('#btnPause').onclick = () => simpleAction('pause', '暂停');
    $('#btnStop').onclick = () => simpleAction('stop', '停止');
    $('#btnStatus').onclick = () => simpleAction('status', '查询状态');
    $('#volume').addEventListener('input', onVolumeInput);
    // 手指/鼠标按住滑块期间也不让轮询覆盖
    $('#volume').addEventListener('pointerdown', () => { volumeTouch = Date.now(); });

    // 从手机 APP 切回窗口时立刻对齐音量，不用等下一轮轮询
    window.addEventListener('focus', () => { if (state.connected) pollStatus(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.connected) pollStatus();
    });

    for (const btn of document.querySelectorAll('.rail-btn[data-view]')) {
      btn.onclick = () => showView(btn.dataset.view);
    }
    $('#btnStatusTop').onclick = () => simpleAction('status', '查询状态');

    $('#btnTts').onclick = async () => {
      const text = $('#tts').value.trim();
      if (!text) { toast('先写点要念的内容'); return; }
      const r = await run('语音播报', () => api.action('tts', text));
      if (r) toast('已让音箱播报', 'ok');
    };
    $('#btnTtsPreview').onclick = () => {
      const text = $('#tts').value.trim();
      if (!text) { toast('先写点要念的内容'); return; }
      speakLocal(text);
      toast('正在用本机语音朗读', 'ok');
    };
    $('#btnTtsStop').onclick = () => {
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
      toast('已停止朗读');
    };
    for (const chip of document.querySelectorAll('.chip-btn[data-tts]')) {
      chip.onclick = () => {
        $('#tts').value = chip.dataset.tts || '';
        $('#tts').focus();
      };
    }
    if (typeof speechSynthesis !== 'undefined') {
      loadVoices();
      speechSynthesis.onvoiceschanged = loadVoices;
    }

    $('#tts').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#btnTts').click();
    });

    $('#btnClearLog').onclick = () => { $('#log').innerHTML = ''; };

    $('#version').onclick = openAbout;
    $('#btnAbout').onclick = openAbout;
    $('#btnAboutClose').onclick = closeAbout;
    $('#aboutModal').addEventListener('click', (e) => {
      if (e.target && e.target.id === 'aboutModal') closeAbout();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#aboutModal').classList.contains('hidden')) closeAbout();
    });
    $('#btnCheckUpdate').onclick = checkUpdate;
    $('#btnDownloadUpdate').onclick = downloadUpdate;
    $('#btnOpenRelease').onclick = () => api.openRelease();
    $('#btnOpenRepo').onclick = () => api.openRepo();
    $('#btnCreateShortcut').onclick = async () => {
      try {
        const r = await api.createShortcut();
        toast(`已创建桌面图标（${r.files.length} 处）`, 'ok');
        addLog(`✓ 已创建快捷方式：${r.files.join('、')}`, 'ok');
      } catch (err) {
        toast('创建图标失败：' + err.message, 'err');
        addLog(`✗ 创建快捷方式失败：${err.message}`, 'err');
      }
    };
    $('#infoBlog').onclick = () => api.openBlog();
    $('#infoBlog').onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        api.openBlog();
      }
    };
    $('#btnCopyInfo').onclick = copyVersionInfo;
    $('#btnSaveUpdate').onclick = saveUpdateConfig;
    $('#autoCheck').onchange = () => api.saveUpdateConfig({ autoCheck: $('#autoCheck').checked });
    $('#repoInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveUpdateConfig(); });

    api.onUpdateProgress((p) => {
      const bar = $('#updateProgressBar');
      if (bar && p) bar.style.width = `${p.percent || 0}%`;
      if (p && p.total) $('#updateTip').textContent = `正在下载安装包… ${p.percent}%（${fmtSize(p.received)} / ${fmtSize(p.total)}）`;
    });
    api.onUpdateAvailable((p) => {
      setBadge(true);
      toast(`发现新版本 v${p.latest}，点右上角版本号查看`, 'ok');
    });

    if (cfg.hasCloudToken) resumeCloud();
  }

  init();
})();
