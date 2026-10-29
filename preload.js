'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  cloudResume: () => ipcRenderer.invoke('cloud:resume'),
  cloudQrStart: () => ipcRenderer.invoke('cloud:qrStart'),
  cloudQrWait: () => ipcRenderer.invoke('cloud:qrWait'),
  cloudLogout: () => ipcRenderer.invoke('cloud:logout'),
  cloudSelect: (opts) => ipcRenderer.invoke('cloud:select', opts),
  onQr: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('cloud:qr', handler);
    return () => ipcRenderer.removeListener('cloud:qr', handler);
  },

  action: (action, value) => ipcRenderer.invoke('player:action', { action, value }),

  search: (keywords, provider) => ipcRenderer.invoke('music:search', { keywords, provider }),
  playSong: (song) => ipcRenderer.invoke('music:play', song),
  musicState: () => ipcRenderer.invoke('music:state'),
  setProvider: (provider) => ipcRenderer.invoke('music:provider', { provider }),
  musicLogin: (provider) => ipcRenderer.invoke('music:login', { provider }),
  musicLogout: (provider) => ipcRenderer.invoke('music:logout', { provider }),
  setMusicCookie: (provider, cookie) => ipcRenderer.invoke('music:cookie', { provider, cookie }),

  pickFiles: () => ipcRenderer.invoke('media:pick'),
  mediaStatus: () => ipcRenderer.invoke('media:status'),
  playLocal: (item) => ipcRenderer.invoke('media:playLocal', item),

  appInfo: () => ipcRenderer.invoke('app:info'),
  openRepo: () => ipcRenderer.invoke('app:openRepo'),
  openBlog: () => ipcRenderer.invoke('app:openBlog'),
  createShortcut: () => ipcRenderer.invoke('app:createShortcut'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  saveUpdateConfig: (patch) => ipcRenderer.invoke('update:config', patch),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  openRelease: () => ipcRenderer.invoke('update:openRelease'),
  onUpdateProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
  onUpdateAvailable: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },

  onLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on('log', handler);
    return () => ipcRenderer.removeListener('log', handler);
  },
});
