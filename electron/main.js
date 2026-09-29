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
const fs = require('fs');
const path = require('path');
const { parseEnv } = require('util');

// Packaged builds ship unpacked (asar: false) so the server can run from resources/app.
const ROOT = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
// Assigned in loadEnv() once the app name (and therefore userData) is final.
let PORT = 4317;
let ENV_FILE = null;

let tray = null;
let serverProc = null;
let running = false;
let quitting = false;
let logStream = null;
let adminLoginUrl = null;
let openedAdminLogin = false;

// ── Configuration (.env) ──────────────────────────────────────────────────────

/**
 * Same .env the server reads: AGENT_MONITOR_ENV_FILE if set (`none` disables), otherwise the repo root
 * in development or the user-data folder (%APPDATA%\Agent Monitor\.env) for the installed app.
 * Real environment variables win over the file; empty values are ignored.
 */
function loadEnv() {
  const configured = (process.env.AGENT_MONITOR_ENV_FILE || '').trim();
  if (/^(?:none|off|false|0)$/i.test(configured)) {
    ENV_FILE = null;
  } else if (configured) {
    ENV_FILE = path.resolve(configured);
  } else {
    ENV_FILE = path.join(app.isPackaged ? app.getPath('userData') : ROOT, '.env');
  }
  if (ENV_FILE && fs.existsSync(ENV_FILE)) {
    try {
      const parsed = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (key === 'AGENT_MONITOR_ENV_FILE' || value === '' || process.env[key] !== undefined) continue;
        process.env[key] = value;
      }
    } catch (err) {
      console.warn(`[env] could not read ${ENV_FILE}: ${err.message}`);
    }
  }
  PORT = Number(process.env.PORT) || 4317;
}

function childEnv(extra) {
  return {
    ...process.env,
    ...extra,
    PORT: String(PORT),
    // Point the server at the same file (or disable its own lookup) so both processes agree.
    AGENT_MONITOR_ENV_FILE: ENV_FILE || 'none',
  };
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

function serverCommand() {
  if (app.isPackaged) {
    // Run the compiled server on Electron's embedded Node (no system Node.js required).
    const dataDir = app.getPath('userData');
    return {
      cmd: process.execPath,
      args: [path.join(ROOT, 'dist', 'server.js')],
      shell: false,
      env: childEnv({
        ELECTRON_RUN_AS_NODE: '1',
        AGENT_MONITOR_DB: process.env.AGENT_MONITOR_DB || path.join(dataDir, 'agent-monitor.db'),
        AGENT_MONITOR_PUBLIC: path.join(ROOT, 'public'),
      }),
    };
  }
  return {
    cmd: 'npx',
    args: ['ts-node', path.join(ROOT, 'src', 'server.ts')],
    shell: process.platform === 'win32',
    env: childEnv({}),
  };
}

function openLog() {
  if (logStream) return logStream;
  try {
    const file = path.join(app.getPath('userData'), 'server.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    logStream = fs.createWriteStream(file, { flags: 'a' });
  } catch { logStream = null; }
  return logStream;
}

function openMonitorUrl() {
  if (adminLoginUrl && !openedAdminLogin) {
    openedAdminLogin = true;
    shell.openExternal(adminLoginUrl);
    return;
  }
  shell.openExternal(`http://127.0.0.1:${PORT}`);
}

function startServer() {
  if (serverProc) return;
  running = false;
  rebuildMenu();

  const { cmd, args, shell: useShell, env } = serverCommand();
  serverProc = spawn(cmd, args, {
    cwd: ROOT,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useShell,
  });

  const log = openLog();
  serverProc.stdout.on('data', chunk => {
    const text = chunk.toString();
    log?.write(chunk);
    const match = text.match(/AGENTGOV_ADMIN_LOGIN_URL=(\S+)/);
    if (match) {
      adminLoginUrl = match[1];
      openMonitorUrl();
    }
    if (text.includes('listening')) {
      running = true;
      rebuildMenu();
    }
  });
  serverProc.stderr.on('data', chunk => log?.write(chunk));

  serverProc.on('exit', () => {
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
  adminLoginUrl = null;
  openedAdminLogin = false;
  quitting = false;
  setTimeout(startServer, 500);
}

// ── Tray menu ─────────────────────────────────────────────────────────────────

function rebuildMenu() {
  if (!tray) return;

  const autoLaunch = app.getLoginItemSettings().openAtLogin;
  const statusLabel = running
    ? `● Running  —  port ${PORT}`
    : serverProc ? '◌ Starting…' : '○ Stopped';

  const template = [
    { label: 'Agent Monitor', enabled: false },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    {
      label: 'Open in Browser',
      enabled: running,
      click: () => openMonitorUrl(),
    },
    {
      label: 'Open Data Folder',
      click: () => shell.openPath(app.isPackaged ? app.getPath('userData') : ROOT),
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
loadEnv();

// Only one instance at a time
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  // If someone opens a second instance, open the browser instead
  if (running) openMonitorUrl();
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
      openMonitorUrl();
    } else {
      tray.popUpContextMenu();
    }
  });

  tray.on('right-click', () => tray.popUpContextMenu());

  rebuildMenu();
  startServer();
});
