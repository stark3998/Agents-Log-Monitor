'use strict';

// VS Code (and other tools) set ELECTRON_RUN_AS_NODE=1 which disables all Electron APIs.
// Detect this and relaunch without it so the tray works correctly.
if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawn } = require('child_process');
  const path = require('path');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(process.execPath, [path.join(__dirname, '..')], {
    env, stdio: 'inherit', detached: true,
  }).unref();
  process.exit(0);
}

const { app, Tray, Menu, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4317;
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

let tray = null;
let serverProc = null;
let running = false;
let quitting = false;

// ── Server lifecycle ──────────────────────────────────────────────────────────

function startServer() {
  if (serverProc) return;
  running = false;
  rebuildMenu();

  const [cmd, args] = app.isPackaged
    ? ['node', [path.join(process.resourcesPath, 'server.js')]]
    : ['npx', ['ts-node', path.join(ROOT, 'src', 'server.ts')]];

  serverProc = spawn(cmd, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  serverProc.stdout.on('data', chunk => {
    if (chunk.toString().includes('listening')) {
      running = true;
      rebuildMenu();
    }
  });

  serverProc.on('exit', code => {
    serverProc = null;
    running = false;
    rebuildMenu();
    if (!quitting) setTimeout(startServer, 2000); // auto-restart on crash
  });
}

function stopServer() {
  if (!serverProc) return;
  quitting = true;
  serverProc.kill();
  serverProc = null;
  running = false;
  rebuildMenu();
}

function restartServer() {
  quitting = true;
  if (serverProc) serverProc.kill();
  serverProc = null;
  running = false;
  quitting = false;
  setTimeout(startServer, 500);
}

// ── Tray menu ─────────────────────────────────────────────────────────────────

function rebuildMenu() {
  if (!tray) return;

  const autoLaunch = app.getLoginItemSettings().openAtLogin;
  const statusLabel = running
    ? '● Running  —  port 4317'
    : serverProc ? '◌ Starting…' : '○ Stopped';

  const template = [
    { label: 'Agent Monitor', enabled: false },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    {
      label: 'Open in Browser',
      enabled: running,
      click: () => shell.openExternal(`http://127.0.0.1:${PORT}`),
    },
    { type: 'separator' },
    running || serverProc
      ? {
          label: 'Stop Server',
          click: () => { stopServer(); },
        }
      : {
          label: 'Start Server',
          click: () => { quitting = false; startServer(); },
        },
    {
      label: 'Restart',
      enabled: !!(running || serverProc),
      click: () => restartServer(),
    },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: autoLaunch,
      click: () => {
        app.setLoginItemSettings({
          openAtLogin: !autoLaunch,
          name: 'Agent Monitor',
        });
        rebuildMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        if (serverProc) serverProc.kill();
        app.quit();
      },
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// ── App bootstrap ─────────────────────────────────────────────────────────────

app.setName('Agent Monitor');
app.setAppUserModelId('com.agent-monitor');

// Only one instance at a time
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  // If someone opens a second instance, open the browser instead
  if (running) shell.openExternal(`http://127.0.0.1:${PORT}`);
});

app.on('window-all-closed', () => { /* stay alive in tray */ });

app.on('before-quit', () => {
  quitting = true;
  if (serverProc) serverProc.kill();
});

app.whenReady().then(() => {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  tray = new Tray(iconPath);
  tray.setToolTip('Agent Monitor — click to open');

  // Left-click: open browser if running, else show menu
  tray.on('click', () => {
    if (running) {
      shell.openExternal(`http://127.0.0.1:${PORT}`);
    } else {
      tray.popUpContextMenu();
    }
  });

  tray.on('right-click', () => tray.popUpContextMenu());

  rebuildMenu();
  startServer();
});
