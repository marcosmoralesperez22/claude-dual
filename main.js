'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BaseWindow,
  WebContentsView,
  Menu,
  Tray,
  ipcMain,
  shell,
  session,
  nativeImage,
  dialog,
  screen,
  clipboard,
} = require('electron');

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const SIDEBAR_WIDTH = 72;
const CLAUDE_URL = 'https://claude.ai/';
const BG_COLOR = '#1e1b2e';

const PALETTE = ['#f0845c', '#6c7cf0', '#3fb68b', '#e5b84a', '#c86bd6', '#4ab3e5', '#e5566b', '#8a8f98'];

// Dominios que se cargan dentro de la app. Todo lo demás se abre en el navegador del sistema.
const BASE_ALLOWED_HOSTS = [
  'claude.ai',
  'claude.com',
  'anthropic.com',
  'accounts.google.com',
  'accounts.youtube.com',
  'appleid.apple.com',
];

// Permisos web que se conceden solo a claude.ai (micrófono para el modo voz, portapapeles, avisos).
const ALLOWED_PERMISSIONS = new Set([
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'fullscreen',
]);

const ICON_PATH = path.join(__dirname, 'assets', IS_WIN ? 'icon.ico' : 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray.png');

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof defaultConfig>} */
let config;
/** @type {BaseWindow | null} */
let win = null;
/** @type {WebContentsView | null} */
let sidebar = null;
/** @type {Map<string, WebContentsView>} */
const views = new Map();
/** @type {Tray | null} */
let tray = null;
let overlay = false;
let quitting = false;

// ---------------------------------------------------------------------------
// Configuración (userData/accounts.json)
// ---------------------------------------------------------------------------

const configPath = () => path.join(app.getPath('userData'), 'accounts.json');

function defaultConfig() {
  return {
    version: 1,
    nextId: 3,
    activeId: 'cuenta1',
    accounts: [
      { id: 'cuenta1', name: 'Personal', color: PALETTE[0], initial: 'P' },
      { id: 'cuenta2', name: 'Trabajo', color: PALETTE[1], initial: 'T' },
    ],
    extraAllowedHosts: [],
    trayHintShown: false,
    window: { width: 1280, height: 860, maximized: false },
  };
}

// Divide en caracteres visibles (un emoji compuesto cuenta como uno).
const segmenter = new Intl.Segmenter();
const graphemes = (s) => [...segmenter.segment(s)].map((x) => x.segment);

function cleanAccountFields(data, fallback) {
  const src = data && typeof data === 'object' ? data : {};
  const name = String(src.name ?? '').trim().slice(0, 40) || fallback.name;
  const color = /^#[0-9a-f]{6}$/i.test(String(src.color)) ? String(src.color).toLowerCase() : fallback.color;
  const initialRaw = graphemes(String(src.initial ?? '').trim()).slice(0, 2).join('');
  const initial = (initialRaw || graphemes(name)[0] || '?').toUpperCase();
  return { name, color, initial };
}

function loadConfig() {
  const file = configPath();
  const base = defaultConfig();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Archivo corrupto: se guarda una copia y se empieza de cero.
      try {
        fs.copyFileSync(file, `${file}.corrupto-${Date.now()}`);
      } catch {}
      console.error('No se pudo leer accounts.json, se usa la configuración por defecto:', err.message);
    }
    return base;
  }

  const seen = new Set();
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
    .filter((a) => a && /^[a-z0-9_-]{1,40}$/i.test(String(a.id)) && !seen.has(a.id) && seen.add(a.id))
    .map((a, i) => ({
      id: String(a.id),
      ...cleanAccountFields(a, { name: `Cuenta ${i + 1}`, color: PALETTE[i % PALETTE.length] }),
    }));
  if (accounts.length === 0) return base;

  const maxN = Math.max(0, ...accounts.map((a) => Number(/^cuenta(\d+)$/.exec(a.id)?.[1] ?? 0)));
  return {
    ...base,
    nextId: Math.max(Number(raw.nextId) || 0, maxN + 1),
    activeId: accounts.some((a) => a.id === raw.activeId) ? raw.activeId : accounts[0].id,
    accounts,
    extraAllowedHosts: (Array.isArray(raw.extraAllowedHosts) ? raw.extraAllowedHosts : [])
      .map((h) => String(h).trim().toLowerCase())
      .filter((h) => /^[a-z0-9.-]+$/.test(h)),
    trayHintShown: Boolean(raw.trayHintShown),
    window: { ...base.window, ...(raw.window && typeof raw.window === 'object' ? raw.window : {}) },
  };
}

function saveConfig() {
  const file = configPath();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('No se pudo guardar accounts.json:', err.message);
  }
}

function saveWindowBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  config.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
  saveConfig();
}

const getAccount = (id) => config.accounts.find((a) => a.id === id);

// ---------------------------------------------------------------------------
// Navegación y seguridad
// ---------------------------------------------------------------------------

function hostMatches(host, list) {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hostMatches(u.hostname, [...BASE_ALLOWED_HOSTS, ...config.extraAllowedHosts]);
  } catch {
    return false;
  }
}

function isClaudeOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hostMatches(u.hostname, ['claude.ai', 'claude.com']);
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.toString());
  } catch {}
}

// User-Agent de Chrome sin las marcas "Electron/x" ni el nombre de la app:
// algunos proveedores (p. ej. Google) bloquean el inicio de sesión en navegadores integrados.
function cleanUserAgent() {
  const platform = /\(([^)]+)\)/.exec(app.userAgentFallback)?.[1] ?? 'Windows NT 10.0; Win64; x64';
  const chromeMajor = process.versions.chrome.split('.')[0];
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}

const preparedSessions = new Set();

function prepareSession(partition) {
  if (preparedSessions.has(partition)) return;
  preparedSessions.add(partition);
  const ses = session.fromPartition(partition);

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isClaudeOrigin(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && isClaudeOrigin(origin));
}

function windowOpenOptions(partition) {
  return {
    width: 520,
    height: 720,
    autoHideMenuBar: true,
    icon: ICON_PATH,
    backgroundColor: '#ffffff',
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
}

// Reglas comunes a las vistas de cuenta y a sus ventanas emergentes (login de Google, etc.).
function hardenContents(wc, partition) {
  wc.on('will-navigate', (event) => {
    if (!isAllowedUrl(event.url)) {
      event.preventDefault();
      openExternal(event.url);
    }
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || isAllowedUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: windowOpenOptions(partition) };
    }
    openExternal(url);
    return { action: 'deny' };
  });

  wc.on('did-create-window', (child) => hardenContents(child.webContents, partition));
  wc.on('context-menu', (_e, params) => showEditContextMenu(wc, params));
}

function showEditContextMenu(wc, params) {
  const { editFlags } = params;
  const template = [];

  if (params.misspelledWord) {
    for (const s of params.dictionarySuggestions.slice(0, 5)) {
      template.push({ label: s, click: () => wc.replaceMisspelling(s) });
    }
    if (template.length) template.push({ type: 'separator' });
  }
  if (params.linkURL) {
    template.push(
      { label: 'Abrir enlace en el navegador', click: () => openExternal(params.linkURL) },
      { label: 'Copiar dirección del enlace', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    );
  }
  if (params.isEditable) {
    template.push(
      { label: 'Deshacer', role: 'undo', enabled: editFlags.canUndo },
      { label: 'Rehacer', role: 'redo', enabled: editFlags.canRedo },
      { type: 'separator' },
      { label: 'Cortar', role: 'cut', enabled: editFlags.canCut },
      { label: 'Copiar', role: 'copy', enabled: editFlags.canCopy },
      { label: 'Pegar', role: 'paste', enabled: editFlags.canPaste },
      { label: 'Seleccionar todo', role: 'selectAll', enabled: editFlags.canSelectAll }
    );
  } else if (params.selectionText) {
    template.push({ label: 'Copiar', role: 'copy' });
  }
  if (template.length && template.at(-1).type === 'separator') template.pop();
  if (template.length) Menu.buildFromTemplate(template).popup({ window: win ?? undefined });
}

// ---------------------------------------------------------------------------
// Atajos de teclado (funcionan con el foco en cualquier vista)
// ---------------------------------------------------------------------------

function handleShortcut(input) {
  if (input.type !== 'keyDown') return false;
  const mod = IS_MAC ? input.meta : input.control;

  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(input.code);
  if (mod && !input.alt && !input.shift && digit) {
    const acc = config.accounts[Number(digit[1]) - 1];
    if (acc) setActive(acc.id);
    return true;
  }
  if ((mod && !input.alt && input.code === 'KeyR') || input.key === 'F5') {
    reloadActive(input.shift);
    return true;
  }
  if (input.control && input.key === 'Tab') {
    cycleAccount(input.shift ? -1 : 1);
    return true;
  }
  const active = views.get(config.activeId)?.webContents;
  if (mod && !input.alt && active) {
    if (input.key === '+' || input.key === '=') return zoom(active, 0.5);
    if (input.key === '-') return zoom(active, -0.5);
    if (input.code === 'Digit0' || input.code === 'Numpad0') return zoom(active, null);
    if (input.shift && input.code === 'KeyI') {
      active.openDevTools({ mode: 'detach' });
      return true;
    }
  }
  return false;
}

function zoom(wc, delta) {
  wc.setZoomLevel(delta === null ? 0 : Math.min(5, Math.max(-5, wc.getZoomLevel() + delta)));
  return true;
}

function attachShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (handleShortcut(input)) event.preventDefault();
  });
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  sidebar.setBounds(overlay ? { x: 0, y: 0, width, height } : { x: 0, y: 0, width: SIDEBAR_WIDTH, height });
  const bounds = { x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, width - SIDEBAR_WIDTH), height };
  for (const view of views.values()) view.setBounds(bounds);
}

function createAccountView(account) {
  const partition = `persist:${account.id}`;
  prepareSession(partition);

  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  view.setBackgroundColor(BG_COLOR);
  view.setVisible(false);
  // Índice 0: las vistas de cuenta siempre quedan por debajo de la barra lateral.
  win.contentView.addChildView(view, 0);
  views.set(account.id, view);

  const wc = view.webContents;
  hardenContents(wc, partition);
  attachShortcuts(wc);
  wc.on('page-title-updated', () => broadcastState());
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && !wc.isDestroyed()) setTimeout(() => !wc.isDestroyed() && wc.reload(), 1500);
  });
  wc.loadURL(CLAUDE_URL);

  layout();
  return view;
}

function destroyAccountView(id) {
  const view = views.get(id);
  if (!view) return;
  views.delete(id);
  win.contentView.removeChildView(view);
  view.webContents.close();
}

function setActive(id) {
  const account = getAccount(id);
  if (!account || !views.has(id)) return;
  config.activeId = id;
  for (const [vid, view] of views) view.setVisible(vid === id);
  win.setTitle(`Claude Dual — ${account.name}`);
  if (!overlay) views.get(id).webContents.focus();
  saveConfig();
  broadcastState();
}

function cycleAccount(step) {
  const n = config.accounts.length;
  const i = config.accounts.findIndex((a) => a.id === config.activeId);
  setActive(config.accounts[(i + step + n) % n].id);
}

function reloadActive(ignoreCache = false) {
  const wc = views.get(config.activeId)?.webContents;
  if (!wc) return;
  if (ignoreCache) wc.reloadIgnoringCache();
  else wc.reload();
}

function setOverlay(on) {
  overlay = Boolean(on);
  layout();
  if (overlay) sidebar.webContents.focus();
  else views.get(config.activeId)?.webContents.focus();
}

// ---------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------

function publicState() {
  return {
    activeId: config.activeId,
    modKey: IS_MAC ? '⌘' : 'Ctrl',
    palette: PALETTE,
    accounts: config.accounts.map((a) => ({ ...a })),
  };
}

function broadcastState() {
  if (sidebar && !sidebar.webContents.isDestroyed()) sidebar.webContents.send('state', publicState());
  updateTrayMenu();
}

function addAccount(data) {
  const n = config.accounts.length;
  const id = `cuenta${config.nextId++}`;
  const account = { id, ...cleanAccountFields(data, { name: `Cuenta ${n + 1}`, color: PALETTE[n % PALETTE.length] }) };
  config.accounts.push(account);
  createAccountView(account);
  setActive(id);
  return id;
}

function updateAccount(id, data) {
  const account = getAccount(id);
  if (!account) return false;
  Object.assign(account, cleanAccountFields(data, account));
  if (id === config.activeId) win.setTitle(`Claude Dual — ${account.name}`);
  saveConfig();
  broadcastState();
  return true;
}

function moveAccount(id, step) {
  const i = config.accounts.findIndex((a) => a.id === id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= config.accounts.length) return;
  [config.accounts[i], config.accounts[j]] = [config.accounts[j], config.accounts[i]];
  saveConfig();
  broadcastState();
}

async function removeAccount(id) {
  const account = getAccount(id);
  if (!account) return false;
  if (config.accounts.length <= 1) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'No se puede eliminar la única cuenta.',
      detail: 'Añade otra cuenta antes de eliminar esta.',
    });
    return false;
  }

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Eliminar', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    message: `¿Eliminar la cuenta «${account.name}»?`,
    detail:
      'Se cerrará la sesión y se borrarán los datos que Claude Dual guarda para esta cuenta (cookies, caché, almacenamiento). ' +
      'Tu cuenta de claude.ai no se ve afectada.',
  });
  if (response !== 0) return false;

  const index = config.accounts.findIndex((a) => a.id === id);
  config.accounts.splice(index, 1);
  destroyAccountView(id);

  const ses = session.fromPartition(`persist:${id}`);
  await ses.clearStorageData().catch(() => {});
  await ses.clearCache().catch(() => {});

  if (config.activeId === id) {
    setActive(config.accounts[Math.min(index, config.accounts.length - 1)].id);
  } else {
    saveConfig();
    broadcastState();
  }
  return true;
}

function showAccountMenu(id) {
  const i = config.accounts.findIndex((a) => a.id === id);
  if (i < 0) return;
  Menu.buildFromTemplate([
    { label: 'Editar nombre, color e inicial…', click: () => sidebar.webContents.send('edit:open', { mode: 'edit', id }) },
    { label: 'Recargar', click: () => views.get(id)?.webContents.reload() },
    { type: 'separator' },
    { label: 'Mover arriba', enabled: i > 0, click: () => moveAccount(id, -1) },
    { label: 'Mover abajo', enabled: i < config.accounts.length - 1, click: () => moveAccount(id, 1) },
    { type: 'separator' },
    { label: 'Eliminar cuenta…', enabled: config.accounts.length > 1, click: () => removeAccount(id) },
  ]).popup({ window: win });
}

// ---------------------------------------------------------------------------
// IPC con la barra lateral (solo se aceptan mensajes de su webContents)
// ---------------------------------------------------------------------------

function registerIpc() {
  const fromSidebar = (e) => sidebar && e.sender === sidebar.webContents;

  ipcMain.handle('state:get', (e) => (fromSidebar(e) ? publicState() : null));
  ipcMain.on('account:switch', (e, id) => fromSidebar(e) && setActive(String(id)));
  ipcMain.on('account:menu', (e, id) => fromSidebar(e) && showAccountMenu(String(id)));
  ipcMain.on('overlay:set', (e, on) => fromSidebar(e) && setOverlay(on));
  ipcMain.on('view:reload', (e) => fromSidebar(e) && reloadActive());
  ipcMain.handle('account:add', (e, data) => (fromSidebar(e) ? addAccount(data) : null));
  ipcMain.handle('account:update', (e, id, data) => (fromSidebar(e) ? updateAccount(String(id), data) : false));
  ipcMain.handle('account:remove', (e, id) => (fromSidebar(e) ? removeAccount(String(id)) : false));
}

// ---------------------------------------------------------------------------
// Ventana, menú y bandeja
// ---------------------------------------------------------------------------

function initialBounds() {
  const w = config.window;
  const bounds = { width: Math.max(600, w.width || 1280), height: Math.max(400, w.height || 860) };
  if (Number.isFinite(w.x) && Number.isFinite(w.y)) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      w.x + 100 > a.x && w.x < a.x + a.width - 100 && w.y >= a.y - 10 && w.y < a.y + a.height - 100
    );
    if (visible) Object.assign(bounds, { x: w.x, y: w.y });
  }
  return bounds;
}

function createWindow() {
  win = new BaseWindow({
    ...initialBounds(),
    minWidth: 600,
    minHeight: 400,
    title: 'Claude Dual',
    icon: ICON_PATH,
    backgroundColor: BG_COLOR,
    autoHideMenuBar: true,
  });
  if (!IS_MAC) win.setMenu(null);
  if (config.window.maximized) win.maximize();

  sidebar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  sidebar.setBackgroundColor('#00000000');
  win.contentView.addChildView(sidebar);
  const swc = sidebar.webContents;
  swc.on('will-navigate', (e) => e.preventDefault());
  swc.setWindowOpenHandler(() => ({ action: 'deny' }));
  attachShortcuts(swc);
  swc.loadFile(path.join(__dirname, 'src', 'index.html'));

  for (const account of config.accounts) createAccountView(account);
  setActive(config.activeId);

  for (const ev of ['resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, layout);
  }
  layout();

  win.on('close', (e) => {
    saveWindowBounds();
    if (quitting) return;
    // Cerrar la ventana la oculta en la bandeja; para salir: menú de la bandeja.
    e.preventDefault();
    win.hide();
    if (IS_WIN && tray && !config.trayHintShown) {
      tray.displayBalloon({
        iconType: 'info',
        title: 'Claude Dual sigue abierto',
        content: 'La app sigue en la bandeja del sistema. Usa su menú para mostrarla o salir.',
      });
      config.trayHintShown = true;
      saveConfig();
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  views.get(config.activeId)?.webContents.focus();
}

function quitApp() {
  quitting = true;
  app.quit();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Mostrar Claude Dual', click: showWindow },
      { type: 'separator' },
      ...config.accounts.map((a, i) => ({
        label: `${a.name}${i < 9 ? `\t${IS_MAC ? '⌘' : 'Ctrl+'}${i + 1}` : ''}`,
        type: 'radio',
        checked: a.id === config.activeId,
        click: () => {
          setActive(a.id);
          showWindow();
        },
      })),
      { type: 'separator' },
      { label: 'Salir', click: quitApp },
    ])
  );
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON_PATH));
  tray.setToolTip('Claude Dual');
  tray.on('click', showWindow);
  updateTrayMenu();
}

function createAppMenu() {
  // En macOS el menú de aplicación es necesario para copiar/pegar con ⌘C/⌘V.
  // En Windows/Linux la ventana no muestra menú: los atajos se gestionan en before-input-event.
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'Cuentas',
        submenu: [
          { label: 'Nueva cuenta…', click: () => sidebar?.webContents.send('edit:open', { mode: 'add' }) },
          { label: 'Recargar', click: () => reloadActive() },
        ],
      },
      { role: 'windowMenu' },
    ])
  );
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.userAgentFallback = cleanUserAgent();
  if (IS_WIN) app.setAppUserModelId('com.marcosmorales.claudedual');

  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    saveWindowBounds();
  });
  app.on('window-all-closed', () => {
    if (quitting || !IS_MAC) app.quit();
  });

  // Ninguna webContents puede adjuntar <webview>.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    config = loadConfig();
    saveConfig();
    registerIpc();
    createAppMenu();
    createWindow();
    createTray();
  });
}
