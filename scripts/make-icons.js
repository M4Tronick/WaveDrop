// Rasterises assets/icon.svg into the PNGs used for the window, tray and installer.
// Run with: npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const assets = path.join(__dirname, '..', 'assets');
const sources = {
  'icon.svg': { 'icon.png': 512, 'tray.png': 16, 'tray@1.5x.png': 24, 'tray@2x.png': 32 },
  // iOS needs a square, opaque 1024px icon (the system rounds the corners).
  'icon-ios.svg': { '../ios/Resources/AppIcon.png': 1024 },
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  for (const [file, outputs] of Object.entries(sources)) {
  const src = `data:image/svg+xml;base64,${fs.readFileSync(path.join(assets, file)).toString('base64')}`;
  for (const [name, size] of Object.entries(outputs)) {
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, ${size}, ${size});
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = ${JSON.stringify(src)};
    })`);
    fs.writeFileSync(path.join(assets, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote', name);
  }
  }
  app.quit();
});
