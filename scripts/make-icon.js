'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build');
const SIZES = [512, 256, 128, 64, 48, 32, 16];

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff9a3d"/>
      <stop offset="1" stop-color="#ff5a00"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="48" y="32" width="416" height="448" rx="104" fill="url(#g)"/>
  <rect x="48" y="32" width="416" height="448" rx="104" fill="url(#glow)"/>
  <circle cx="256" cy="188" r="86" fill="#ffffff" opacity="0.97"/>
  <circle cx="256" cy="188" r="34" fill="#ff6a00"/>
  <circle cx="282" cy="164" r="12" fill="#ffffff" opacity="0.9"/>
  <rect x="148" y="330" width="216" height="38" rx="19" fill="#ffffff" opacity="0.95"/>
  <rect x="148" y="392" width="140" height="38" rx="19" fill="#ffffff" opacity="0.62"/>
</svg>`;

function page(n) {
  return `data:text/html;charset=utf8,${encodeURIComponent(
    `<!DOCTYPE html><html><head><style>*{margin:0;padding:0}body{width:${n}px;height:${n}px;background:transparent;overflow:hidden}svg{width:${n}px;height:${n}px;display:block}</style></head><body>${SVG}</body></html>`
  )}`;
}

function shoot(n) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: n,
      height: n,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true },
    });
    win.webContents.once('paint', () => {
      setTimeout(async () => {
        try {
          const img = win.webContents.capturePage();
          resolve(img);
        } catch (err) {
          reject(err);
        }
      }, 120);
    });
    win.loadURL(page(n)).catch(reject);
  });
}

function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];
  entries.forEach(([size, png], i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
    blobs.push(png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const entries = [];
    for (const size of SIZES) {
      const img = await shoot(size);
      const png = img.toPNG();
      fs.writeFileSync(path.join(OUT, `icon-${size}.png`), png);
      if (size === 512) fs.writeFileSync(path.join(OUT, 'icon.png'), png);
      if (size >= 16) entries.push([size, png]);
      console.log(`icon-${size}.png ${png.length} bytes`);
    }
    fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(entries.reverse()));
    console.log('ICO_SAVED ' + path.join(OUT, 'icon.ico'));
    app.exit(0);
  } catch (err) {
    console.error('ICON_FAIL ' + err.message);
    app.exit(1);
  }
});
