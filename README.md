<div align="center">

<img src="docs/icon.png" width="128" alt="Xiao Ai Speaker 图标" />

# Xiao Ai Speaker

**Windows 桌面端的小爱音箱遥控器 · Electron + JavaScript**

[![Release](https://img.shields.io/github/v/release/nieshilin/xiaoai-speaker-controller?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC&logo=github)](https://github.com/nieshilin/xiaoai-speaker-controller/releases)
[![Platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%2010%2F11-blue?logo=windows)](https://github.com/nieshilin/xiaoai-speaker-controller)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

走小米 **MiNA 云端通道**下发指令，音箱无需开端口、无需 token；
支持**网易云音乐 / QQ 音乐 / 汽水音乐在线搜索播放**、**本地音乐局域网推流**、**语音播报**，
并通过 **GitHub Releases 自动检查更新**。

[下载安装包](https://github.com/nieshilin/xiaoai-speaker-controller/releases) · [功能特性](#-功能特性) · [快速开始](#-快速开始) · [常见问题](#-常见问题)

> [!IMPORTANT]
> **汽水音乐相关接口可能随时失效。** 推荐流、播放地址、歌单等能力来自汽水音乐网页端**非官方私有接口**，官方随时可能调整签名、鉴权或接口结构，导致相关功能报错、返回空结果或只能播试听片段。这类失效属于上游变更，不保证能及时修复；遇到时请**改用 QQ 音乐 / 网易云音源**，或打开「关于」检查更新。请勿把汽水音乐当作唯一音源依赖。

</div>

---

## 📸 界面预览

| 设备总览 | 在线音乐 |
| :---: | :---: |
| ![设备总览](docs/screenshots/device.png) | ![在线音乐](docs/screenshots/music.png) |
| **语音播报** | **关于 / 检查更新** |
| ![语音播报](docs/screenshots/voice.png) | ![关于应用](docs/screenshots/about.png) |

## ✨ 功能特性

### 🔐 小米账号
- **扫码登录**：米家 App 扫码确认即可，全程不输密码；登录态（passToken）保存在本机，之后启动**自动续期**，无需重复登录
- **多设备支持**：账号下所有小爱音箱自动出现在下拉框，一键切换

### 🎵 在线音乐（三音源）
- **网易云音乐 / QQ 音乐 / 汽水音乐**任意切换搜索，点歌曲直接让音箱播放
- **内嵌登录窗口**：点「登录账号」弹出内置浏览器，扫码 / 账密登录后**自动提取 Cookie**（含 QQ 音乐 `qm_keyst` 播放凭证的自动唤醒），也可手动粘贴 Cookie
- **音源本地代理**：歌曲不直接把平台 CDN 直链丢给音箱，而是经内置媒体服务 `/proxy/<音源>/<id>` 中转——电脑带正确 UA / Referer 取流，规避音箱拉不到 CDN、vkey 失效、UA 拦截等问题；下发前还会**探测直链可用性**，杜绝死链
- VIP / 版权歌曲自动识别：播放失败时提示里直接给出原因，并提醒检查账号是否已登录、必要时重新登录、确认账号有对应的 VIP 权益
- **汽水音乐**（v2.7.0 更新）：**扫码登录即可播放完整音源**——点「扫码登录」弹出二维码，用汽水音乐 App（抖音账号通用）扫一扫，登录状态自动保存，**不需要抓包、不需要签名头**
  - 完整音源是 AES-CTR 加密的 MP4：程序在**内存里解密**后经本地代理直接喂给音箱，不写任何临时文件，不额外占磁盘
  - 只有「搜索汽水」这一项仍需要客户端签名头（`X-Helios` / `X-Medusa`），播放、推荐、歌单都不需要
  - ⚠️ **稳定性提醒**：这些接口都不是官方开放 API，**可能随时失效**（改签名 / 改鉴权 / 改结构 / 封接口）。失效时通常会表现为「推荐为空」「取不到播放地址」或只能播试听，建议改用 QQ 音乐 / 网易云，并关注版本更新

### 🥤 汽水音乐独立界面（v2.6.0 新增）
- 侧边栏新增 **「汽水」** 页，为「主要听汽水推荐」的用法专门设计：打开就是**推荐流**，聚焦式大封面展示（类汽水 App 播放页）+「接下来」列表，不用先搜索
- **免登录也能看**：推荐流不登录也能拉取，打开页面就有内容；登录后按账号口味推荐
- **换一批 / 加载更多**：不断刷新推荐；聚焦曲支持「上一首 / 播放 / 下一首」快速切换，也可「播放全部」整单连播；点「接下来」列表任意一首直接切歌
- **完整音源（v2.7.0）**：登录后走汽水网页网关的播放接口，返回 3 档码率（最高约 260kbps）的完整曲目；音源是加密的，程序在内存里解密后直接代理给音箱，**不落盘**
- **同名曲兜底**：万一某首歌汽水确实拿不到（下架 / 版权限制），自动在 QQ 音乐 / 网易云里找**同名同歌手**的曲目播放（曲名归一化 + 歌手比对，避免放错歌），侧栏可一键开关
- 侧栏集成 **现在播放**（队列进度条）、**我的歌单**、**搜索汽水**（搜索接口需要签名头，未配置时会给出明确提示）

### 📃 平台歌单（v2.4.3 新增）
- **直接读取账号歌单**：登录网易云 / QQ 音乐 / 汽水音乐后点「刷新歌单」，把你在平台上收藏/自建的全部歌单拉进来（含「我喜欢」等系统歌单），不用在本地重复整理
- **整单连播**：「播放全部」从第一首开始按顺序推给音箱，播完一首自动切下一首；不可播放的歌曲自动跳过并记入日志，也可从任意一首「从这里连播」
- **暂停不跳歌**：连播中点暂停，队列会停在当前这首等你继续，不会自己切下一首；只有「停止连播」才结束整条队列，日志里能看到当前是第几首

### 💽 本地音乐
- 内置 HTTP 媒体服务（支持 `Range` 206 分段），把本地 mp3 / flac / wav / m4a / ogg 等推流给音箱
- 播放列表 + 上一首 / 下一首

### 🗣️ 语音播报（TTS）
- **本机试听**：渲染进程直接调用 Chromium 内置 `speechSynthesis`（Windows SAPI 系统语音），**断网也能用**，可选中文语音
- **音箱播报**：把文字合成为 mp3（自动分段、自动重试），经本地服务推给音箱出声；L05B / L05C / LX04 等型号自动走音频通道，支持云端 TTS 的型号优先走云端

### 🎛️ 播放控制
- 播放 / 暂停 / 停止 / 状态查询 / 音量滑块（自动回读设备音量：点「刷新状态」立即对齐，连上音箱后每 8 秒轮询一次，切回窗口时也会刷新；手机 APP 或语音改过音量，界面会自动跟上）
- 播放任意网络音频地址
- **型号自适应**：L05B/L05C/LX04/LX05 等自动改用 `player_play_music` 下发，其余走 `player_play_url`

### 🔄 版本更新
- 启动自动检查 GitHub Releases（**公开仓库匿名访问，无需 Token**），发现新版右上角亮红点
- 关于面板内查看更新说明、下载安装包（重定向跟随 + 实时进度），或一键打开发布页

## 🚀 快速开始

### 方式一：下载安装包（推荐）

到 [Releases](https://github.com/nieshilin/xiaoai-speaker-controller/releases) 下载 `XiaoAiSpeakerControl Setup x.x.x.exe`，双击安装即可。

### 方式二：源码运行

```powershell
git clone https://github.com/nieshilin/xiaoai-speaker-controller.git
cd xiaoai-speaker-controller
npm install
npm start
```

> 国内网络如 Electron 二进制下载失败：`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"` 后再 `npm install`

### 使用步骤

1. 首次使用点 **「扫码登录」**，用米家 App 扫码并确认
2. 下拉框选择音箱，左下角状态灯变绿
3. 在 **「汽水」** 页直接播放推荐的歌（点「接下来」列表或「播放这首」），或在 **「音乐」** 页搜索歌曲
4. 播放**本地文件**时，音箱通过 `http://<电脑IP>:8931` 拉流；首次失败请在 Windows 防火墙放行本程序的 **「专用网络」** 入站

### 开发与测试

```powershell
npm start        # 启动
npm run check    # 离线自检（56 项）
npm run e2e      # 端到端 UI 测试（36 项，模拟小米云端）
npm run icon     # 重新生成应用图标（build/icon.ico）
npm run dist     # 打包 Windows 安装包（输出 release/）
```

## 🧱 项目结构

```
main.js                Electron 主进程：窗口、IPC、账号与音源编排、更新检查
preload.js             contextBridge 桥接（渲染层只暴露 window.api）
src/mina.js            小米账号扫码登录 + passToken 续期 + MiNA ubus 指令
src/music.js           音源注册表 + 网易云 / QQ 音乐：搜索、取播放地址、登录态判定
src/qishui.js          汽水音乐：推荐流、web 网关取流、试听识别、内存解密播放
src/qishui/            汽水扫码登录：官方安全组件（bdms）+ Passport 扫码流程（源自 GPL-3.0 项目，见下方声明）
src/qishui/decryptor.js 汽水加密音源解密：spade_a → AES-128 key、MP4 cenc 逐样本解密（源自 MIT 项目，见下方声明）
src/musicCookie.js     Cookie 域名过滤 / 择优 / 规范化校验
src/mediaServer.js     本地媒体服务：文件推流 + 音源代理（Range 206）
src/speech.js          语音合成：分段、重试、mp3 落盘
src/updater.js         GitHub Releases 版本比较 / 资源挑选 / 安装包下载
src/store.js           本机配置读写
renderer/              界面（侧边导航四视图 + 关于弹窗）
scripts/selfcheck.js   离线自检
scripts/e2e.js         端到端测试
scripts/fakeCloud.js   模拟小米云端 / 音乐平台 / GitHub API
scripts/make-icon.js   应用图标生成
```

## ❓ 常见问题

<details>
<summary><b>音箱不出声，日志提示「音箱未进入播放态」</b></summary>

音箱和电脑必须在**同一局域网**，且 Windows 防火墙需放行本程序的**专用网络**入站（8931 端口）。日志里能看到音箱是否来拉流。
</details>

<details>
<summary><b>在线歌曲播放失败 / 提示需要会员</b></summary>

版权 / VIP 歌曲需要登录对应平台账号：点「登录账号」在内嵌窗口登录，或「粘贴 Cookie」手动保存（网易云需含 <code>MUSIC_U</code>，QQ 音乐需含 <code>uin</code> 和 <code>qm_keyst</code>）。QQ 音乐会员曲目还需要账号本身有会员权益。

汽水音乐推荐用**扫码登录**：切到「汽水音乐」→ 点「扫码登录」→ 用汽水音乐 App 扫二维码，登录状态自动保存，下次启动无需重登。二维码约 2 分钟有效，过期会自动刷新；如果汽水弹出「安全验证」，在弹出的窗口里按提示完成即可。

备用方案（仅当「搜索汽水」提示缺签名头时）：在汽水音乐电脑版播放一首歌时用 Reqable / Fiddler 抓包，找发往 <code>api.qishui.com</code> 的请求，把请求头里的 <code>Cookie</code> 粘进「粘贴 Cookie」，再补 <code>x-helios</code> / <code>x-medusa</code>。这组签名头是客户端每次请求现算的，通常几小时到几天就会过期；**播放和推荐不依赖它**。
</details>

<details>
<summary><b>汽水音乐突然不推荐了 / 只播 30 秒试听 / 提示取不到音源</b></summary>

**先说明：汽水音乐相关接口是非官方网页私有接口，随时可能失效。**

官方调整签名（<code>X-Ladon</code> / <code>X-Argus</code> / <code>X-Helios</code>）、鉴权头、接口路径或返回结构后，推荐流会变空、播放地址会 404/403，或只返回试听档（单码率且时长 &lt; 65 秒）。

应对顺序：
1. 先在「汽水」页重新「扫码登录」——二维码 Cookie 过期也会导致空结果；
2. 打开「同名曲兜底」（默认开启），取不到时自动用 QQ / 网易云同名同歌手曲目播放；
3. 直接把音源切到 **QQ 音乐 / 网易云**，这两条链路稳定得多；
4. 打开「关于」→ 检查更新，看是否已有适配新接口的版本。

如果是上游彻底改了协议，可能需要等新版本，**这类变更不保证能及时修复**。
</details>

<details>
<summary><b>语音播报没声音</b></summary>

音箱播报会把文字合成为 mp3 经本地服务推送，同样依赖局域网与防火墙放行；L05B 等型号不支持小米云端 TTS，程序已自动改走音频通道。可以用「本机试听」先在电脑上听效果（走 Windows 系统语音，断网可用）。
</details>

<details>
<summary><b>检查更新提示仓库不存在</b></summary>

更新检查走 GitHub 公开接口，仓库必须为公开仓库。可在关于面板里修改「更新源」（格式 <code>owner/repo</code>）。
</details>

<details>
<summary><b>扫码换 serviceToken 失败（401）</b></summary>

小米返回的 <code>nonce</code> 是 19 位大整数，<code>JSON.parse</code> 会丢精度导致签名错误；<code>src/mina.js</code> 已做保精度处理并在自检里加了回归用例，改动时不要去掉。
</details>

<details>
<summary><b>登录态失效了</b></summary>

重新扫码即可。小米 passToken 长期有效，一般很少遇到。
</details>

## ⭐ Star History

如果这个项目对你有帮助，欢迎点个 Star！

---

<div align="center">

**音乐音源由网易云音乐 / QQ 音乐 / 汽水音乐提供，本工具仅作播放控制，请支持正版。**

<sub>汽水扫码登录模块（<code>src/qishui/</code>）移植自 [Mineradio-Qishui-QR-Login](https://github.com/Wx2yZx/Mineradio-Qishui-QR-Login)（GPL-3.0），该目录及其资产遵循 GPL-3.0 分发。</sub>
<sub>汽水加密音源解密模块（<code>src/qishui/decryptor.js</code>）移植自 [guowenye/qishui-api](https://github.com/guowenye/qishui-api)（MIT），算法与 MP4 解析逻辑版权归原作者所有。</sub>

Made with ❤️ by [nieshilin](https://github.com/nieshilin) · 博客 [xiaonie.me](https://www.xiaonie.me/) · License [MIT](LICENSE)

</div>
