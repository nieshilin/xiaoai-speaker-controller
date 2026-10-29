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
    row.textContent = line;
    box.appendChild(row);
    while (box.childElementCount > 600) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  let toastTimer = null;
  function toast(msg, type) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show${type ? ' ' + type : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
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

  async function run(label, fn) {
    try {
      return await fn();
    } catch (err) {
      addLog(`✗ ${label}失败：${friendly(err)}`, 'err');
      toast(`${label}失败`, 'err');
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
    const r = await run('播放', () => api.playSong({ id: song.id, name: `${song.name} - ${song.artists}`, provider: state.provider }));
    if (r && r.trial) toast('这是试听片段，填 Cookie 可播完整版', 'err');
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
  async function onVolumeInput() {
    const v = Number($('#volume').value);
    $('#volumeVal').textContent = String(v);
    paintRange();
    if (!state.connected) return;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => {
      api.action('volume', v).catch((err) => addLog(`✗ 设置音量失败：${friendly(err)}`, 'err'));
    }, 220);
  }

  async function simpleAction(action, label) {
    const r = await run(label, () => api.action(action));
    if (!r) return;
    if (action === 'status') {
      const st = r.status || {};
      addLog(`播放状态：status=${st.status} 音量=${st.volume}`, 'ok');
      toast(`状态 ${st.status === 2 ? '在播' : '待机'} · 音量 ${st.volume}`);
      return;
    }
    toast(`${label}已下发`, 'ok');
  }

  function applyMusicState(st) {
    if (!st || !st.providers) return;
    state.music = st.providers;
    if (st.current) state.provider = st.current;

    for (const btn of document.querySelectorAll('#segProvider .seg-btn')) {
      btn.classList.toggle('active', btn.dataset.provider === state.provider);
    }
    const info = state.music[state.provider] || { label: '音源', loggedIn: false };
    $('#musicTag').textContent = info.loggedIn ? '已登录' : '未登录';
    $('#btnMusicLogin').textContent = info.loggedIn ? '切换账号' : '登录账号';
    $('#btnMusicLogout').classList.toggle('hidden', !info.loggedIn);
    $('#musicCookie').placeholder = state.provider === 'qq'
      ? '粘贴浏览器里的 Cookie（含 uin 与 qm_keyst）'
      : '粘贴浏览器里的 Cookie（含 MUSIC_U）';
    $('#cookieHint').innerHTML = state.provider === 'qq'
      ? '取法：浏览器打开 y.qq.com 并登录 → F12 → 网络(Network) → 点任一请求 → 复制请求头里 Cookie 整行 → 粘贴保存。需含 <b>uin</b> 与 <b>qm_keyst</b>。'
      : '取法：浏览器打开 music.163.com 并登录 → F12 → 应用(Application) → Cookies → 复制全部 → 粘贴保存。需含 <b>MUSIC_U</b>。';
  }

  async function switchProvider(name) {
    if (name === state.provider) return;
    const st = await run('切换音源', () => api.setProvider(name));
    if (!st) return;
    applyMusicState(st);
    state.songs = [];
    $('#songList').innerHTML = `<li class="empty">已切换到${(st.providers[name] || {}).label || name}，输入关键词搜索。</li>`;
  }

  async function musicLogin() {
    const btn = $('#btnMusicLogin');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '等待登录…';
    addLog('已打开登录窗口，扫码或账号密码登录均可，登录成功后窗口会自动关闭');
    const st = await run('登录账号', () => api.musicLogin(state.provider));
    btn.disabled = false;
    btn.textContent = label;
    if (!st) return;
    applyMusicState(st);
    toast('登录成功', 'ok');
  }

  async function musicLogout() {
    const st = await run('退出登录', () => api.musicLogout(state.provider));
    if (st) {
      applyMusicState(st);
      toast('已退出登录', 'ok');
    }
  }

  async function saveCookie() {
    const cookie = $('#musicCookie').value.trim();
    const r = await run('保存 Cookie', () => api.setMusicCookie(state.provider, cookie));
    if (!r) return;
    $('#musicCookie').value = '';
    applyMusicState(r);
    toast(r.hasCookie ? 'Cookie 已保存' : 'Cookie 已清除', 'ok');
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
    $('#infoMedia').textContent = info.mediaPort ? `0.0.0.0:${info.mediaPort}` : '未启动';
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
    $('#btnMusicLogout').onclick = musicLogout;
    $('#btnCookiePanel').onclick = () => {
      const hint = $('#cookieHint');
      const willOpen = $('#cookiePanel').classList.contains('hidden');
      $('#cookiePanel').classList.toggle('hidden');
      hint.classList.toggle('hidden', !willOpen);
    };
    $('#btnCookieSave').onclick = saveCookie;
    $('#musicCookie').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCookie(); });

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
