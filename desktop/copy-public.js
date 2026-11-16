// Copies the game client (../public) into ./app so electron-builder can package it.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'public');
const dst = path.join(__dirname, 'app');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log('Copied game client to', dst);
