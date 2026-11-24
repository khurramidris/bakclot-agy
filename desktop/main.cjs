// Backlot desktop: a window around the same studio that runs online, with its own database, your own keys and, for
// RunPod, an automatic tunnel. This file only deals with windows and menus; lib/stack.cjs starts the services.

const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { logger } = require('./lib/util.cjs');
const settingsLib = require('./lib/settings.cjs');
const stackLib = require('./lib/stack.cjs');
const keytest = require('./lib/keytest.cjs');

const SMOKE = process.env.BACKLOT_SMOKE; // automated check: demo mode, screenshot, exit
if (process.env.BACKLOT_DATA_DIR) app.setPath('userData', process.env.BACKLOT_DATA_DIR);
// An AppImage can't ship Chromium's setuid sandbox helper, and Ubuntu 24.04+ blocks the other sandbox, so it wouldn't open at all.
if (process.env.BACKLOT_NO_SANDBOX || (process.platform === 'linux' && process.env.APPIMAGE)) app.commandLine.appendSwitch('no-sandbox');
if (SMOKE) { app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-dev-shm-usage'); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu'); } // headless test machines have no GPU and a locked-down /dev/shm

// embedded-postgres registers its own exit hook that can throw once we have already stopped it cleanly: log, don't crash.
process.on('unhandledRejection', (e) => { try { log.write('app', `unhandled rejection: ${e && e.message}`); } catch { /* logger not ready */ } });

const dataDir = app.getPath('userData');
const log = logger(path.join(dataDir, 'logs', 'backlot.log'));
const logFn = (tag, msg) => log.write(tag, msg);
const settings = settingsLib.create({ dir: dataDir, safeStorage });
let stack = null, splash = null, mainWin = null, settingsWin = null, quitting = false;

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { const w = mainWin || splash; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });

const ui = (f) => path.join(__dirname, 'ui', f);
const webPrefs = { preload: path.join(__dirname, 'ui', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false };
const BG = '#0F0F0F';
const ICON = path.join(__dirname, 'build', 'icon.png');

function say(message, step) { logFn('app', message); if (splash && !splash.isDestroyed()) splash.webContents.send('status', { message, step }); }

function showSplash() {
  if (splash && !splash.isDestroyed()) { splash.show(); return Promise.resolve(); }
  splash = new BrowserWindow({ width: 520, height: 500, resizable: false, minimizable: false, maximizable: false, show: false, backgroundColor: BG, title: 'Backlot', icon: ICON, autoHideMenuBar: true, webPreferences: webPrefs });
  splash.on('closed', () => { splash = null; if (!mainWin && !settingsWin && !quitting) app.quit(); });
  const loaded = splash.loadFile(ui('splash.html'));
  splash.once('ready-to-show', () => splash && splash.show());
  return loaded;
}

function showSettings({ first = false } = {}) {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 760, height: 860, minWidth: 640, minHeight: 600, backgroundColor: BG, title: first ? 'Welcome to Backlot' : 'Backlot settings',
    parent: mainWin && !first ? mainWin : undefined, autoHideMenuBar: true, webPreferences: webPrefs,
  });
  settingsWin.loadFile(ui('settings.html'), { query: { first: first ? '1' : '' } });
  settingsWin.on('closed', () => { settingsWin = null; if (!mainWin && !quitting && !(splash && !splash.isDestroyed())) app.quit(); });
}

function openMain(url) {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.loadURL(url); mainWin.show(); return; }
  mainWin = new BrowserWindow({ width: 1360, height: 900, minWidth: 1000, minHeight: 640, backgroundColor: BG, title: 'Backlot', icon: ICON, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('closed', () => { mainWin = null; });
  // Links to other websites open in the normal browser, never inside the studio window.
  const local = (u) => { try { const x = new URL(u); return x.hostname === '127.0.0.1'; } catch { return false; } };
  mainWin.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u) && !local(u)) shell.openExternal(u); return { action: 'deny' }; });
  mainWin.webContents.on('will-navigate', (e, u) => { if (!local(u)) { e.preventDefault(); if (/^https?:/.test(u)) shell.openExternal(u); } });
  mainWin.loadURL(url);
}

async function boot({ restart = false } = {}) {
  await showSplash();
  splash.webContents.send('reset');
  try {
    const result = restart ? await stack.restart() : await stack.run({ onProblem: (m) => problem(m) });
    if (result.tunnelOk === false) dialog.showMessageBox({ type: 'warning', message: 'The public address is not answering yet', detail: 'Backlot started, but RunPod may not be able to reach this computer yet. This usually clears in under a minute. If renders fail with a download or upload error, use Tools → Restart studio.' }).catch(() => {});
    openMain(result.url);
    if (splash && !splash.isDestroyed()) splash.destroy();
    splash = null;
    buildMenu();
    return result;
  } catch (error) {
    const e = error instanceof Error ? error : new Error(`Backlot startup failed: ${String(error)}. Check the database messages in the logs.`);
    logFn('app', `start failed: ${e.stack || e.message}`);
    if (splash && !splash.isDestroyed()) splash.webContents.send('error', { message: e.message, tail: log.tail(14) });
    throw e;
  }
}

function problem(message) {
  logFn('app', `problem: ${message}`);
  dialog.showMessageBox({ type: 'warning', message: 'Backlot needs attention', detail: message }).catch(() => {});
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const go = (p) => () => { if (stack.state.url && mainWin) mainWin.loadURL(stack.state.url + p); };
  const template = [
    ...(mac ? [{ label: 'Backlot', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'Cmd+,', click: () => showSettings() }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [...(mac ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => showSettings() }, { type: 'separator' }]), mac ? { role: 'close' } : { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    {
      label: 'Tools', submenu: [
        { label: 'Dashboard', click: go('/dashboard') },
        { label: 'Setup check', click: go('/setup') },
        { label: 'Admin: what each film cost', click: go('/admin') },
        { type: 'separator' },
        { label: 'Restart studio', click: () => boot({ restart: true }).catch(() => {}) },
        { label: 'Copy public address', click: () => clipboard.writeText(stack.state.publicUrl || stack.state.url) },
        { type: 'separator' },
        { label: 'Open films folder', click: () => shell.openPath(path.join(dataDir, 'files')) },
        { label: 'Open logs folder', click: () => shell.openPath(path.join(dataDir, 'logs')) },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Messages from the settings and start-up windows ──
ipcMain.handle('settings:get', () => ({ ...settings.forWindow(), isFirstRun: !settings.exists() }));
ipcMain.handle('settings:save', async (_e, patch) => {
  settings.save(patch);
  const s = settings.load();
  const miss = settings.missing(s);
  if (miss) return { ok: false, message: `Backlot still needs ${miss}.` };
  const wasRunning = !!(stack && stack.state.url);
  // Start the splash first, so closing this window never leaves the app with no window (which would quit it).
  const started = boot({ restart: wasRunning }).catch(() => {});
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  void started;
  return { ok: true };
});
ipcMain.handle('settings:test', (_e, kind, v) => keytest.test(kind, v || {}));
ipcMain.handle('app:openExternal', (_e, u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); });
ipcMain.handle('app:openLogs', () => shell.openPath(path.join(dataDir, 'logs')));
ipcMain.handle('app:openSettings', () => showSettings());
ipcMain.handle('app:retry', () => boot({ restart: !!(stack && stack.state.url) }).catch(() => {}));
ipcMain.handle('app:quit', () => app.quit());
ipcMain.handle('app:cancelSettings', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });

app.on('before-quit', async (e) => {
  if (quitting || !stack) return;
  quitting = true;
  e.preventDefault();
  try { await stack.stop(); } catch (err) { logFn('app', `stop failed: ${err.message}`); }
  log.close();
  app.exit(0);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { // macOS: clicking the Dock icon with no window open
  if (mainWin || splash || settingsWin || !stack) return;
  if (stack.state.url) openMain(stack.state.url); else boot().catch(() => {});
});

app.whenReady().then(async () => {
  const paths = stackLib.resolvePaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  logFn('app', `Backlot desktop ${app.getVersion()} (${process.platform}/${process.arch}), data in ${dataDir}`);
  if (!fs.existsSync(path.join(paths.engineDir, 'dist', 'index.js')) || !fs.existsSync(path.join(paths.webDir, 'index.html'))) {
    dialog.showErrorBox('Backlot is not built yet', 'Run "npm run prepare:app" in the desktop folder, then start again.');
    return app.exit(1);
  }
  stack = stackLib.create({ dataDir, paths, execPath: process.execPath, settings, log: logFn, say });
  if (SMOKE) return require('./lib/smoke-hook.cjs').run({ app, settings, boot, stack, getMain: () => mainWin, dataDir, logFn });
  if (!settings.exists()) { showSettings({ first: true }); return; }
  boot().catch(() => {});
});

