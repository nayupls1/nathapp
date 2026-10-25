import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { startServer, type ServerHandle } from "./server";
import { guardWindow, setupWebTabs } from "./web";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

// Chromium finds the keyring only on desktops it knows (GNOME, KDE…). Elsewhere
// (Hyprland, Sway…) it would keep the keys of cookies and safeStorage under a
// hardcoded password. Without a Secret Service, encryption is reported as
// unavailable (see secretsKey.ts). KDE's KWallet is found on its own.
if (process.platform === "linux" && !app.commandLine.hasSwitch("password-store") && !/kde/i.test(process.env.XDG_CURRENT_DESKTOP ?? "")) {
  app.commandLine.appendSwitch("password-store", "gnome-libsecret");
}

// Lets tests run against a throwaway profile instead of the real data.
if (process.env.NATHAPP_USER_DATA_DIR) app.setPath("userData", process.env.NATHAPP_USER_DATA_DIR);
else moveLegacyUserData();

/**
 * NathApp used to be called gApp: its data (tabs, apps, sessions, the
 * secrets key) moves over from the old folder on the first start.
 */
function moveLegacyUserData() {
  const legacy = join(app.getPath("appData"), "gApp");
  const current = app.getPath("userData");
  if (legacy === current || !existsSync(legacy) || existsSync(join(current, "data"))) return;
  try {
    for (const entry of readdirSync(legacy)) {
      if (!existsSync(join(current, entry))) renameSync(join(legacy, entry), join(current, entry));
    }
  } catch (err) {
    console.error("Couldn't move the data from the gApp folder:", err);
  }
}

// Bun inlines `__dirname` at bundle time, so resolve build output from the app
// root instead (works both unpackaged and inside the packaged asar).
const distDir = join(app.getAppPath(), "dist");

// In production the renderer is served from a custom privileged scheme instead
// of file:// so it gets a real origin (needed for CORS against the Bun server).
const APP_SCHEME = "app";
const APP_HOST = "nathapp";
const rendererOrigin = devServerUrl ? new URL(devServerUrl).origin : `${APP_SCHEME}://${APP_HOST}`;

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let server: ServerHandle | undefined;
let mainWindow: BrowserWindow | undefined;
let web: ReturnType<typeof setupWebTabs> | undefined;

// Safe mode: the renderer leaves out the theme and site customizations, so
// whatever broke the UI can be undone in History.
const safeMode = process.argv.includes("--safe-mode") || process.env.NATHAPP_SAFE_MODE === "1";

function relaunch(safe: boolean) {
  const args = process.argv.slice(1).filter((a) => a !== "--safe-mode");
  app.relaunch({ args: safe ? [...args, "--safe-mode"] : args });
  app.quit();
}

ipcMain.on("nathapp:relaunch", (event, safe: unknown) => {
  if (event.sender === mainWindow?.webContents) relaunch(safe === true);
});

function registerAppProtocol() {
  const root = join(distDir, "renderer");
  protocol.handle(APP_SCHEME, (req) => {
    const { pathname } = new URL(req.url);
    const file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root + sep)) return new Response("Forbidden", { status: 403 });
    const target = pathname === "/" || !/\.[a-z0-9]+$/i.test(pathname) ? join(root, "index.html") : file;
    return net.fetch(pathToFileURL(target).toString());
  });
}

function createWindow(server: ServerHandle) {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(distDir, "electron/preload.cjs"),
      additionalArguments: [`--nathapp-server-url=${server.url}`, `--nathapp-token=${server.token}`, ...(safeMode ? ["--nathapp-safe-mode=1"] : []), ...(process.env.NATHAPP_OFFSCREEN === "1" ? ["--nathapp-offscreen=1"] : [])],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Web tabs are <webview> guests (locked down in web.ts).
      webviewTag: true,
      // Agent runs stream into the window while it's in the background.
      backgroundThrottling: false,
      // Tests render without a visible window (always painted, nothing pops up).
      offscreen: process.env.NATHAPP_OFFSCREEN === "1",
    },
  });

  win.once("ready-to-show", () => {
    if (process.env.NATHAPP_OFFSCREEN !== "1") win.show();
  });

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  guardWindow(win, rendererOrigin, (input) => web?.windowInput(input) ?? false);
  // Works even when the UI itself is unusable.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.control && input.alt && input.shift && input.key.toLowerCase() === "s") {
      event.preventDefault();
      relaunch(true);
    }
  });

  if (devServerUrl) {
    win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadURL(`${APP_SCHEME}://${APP_HOST}/`);
  }
}

app.whenReady().then(async () => {
  if (!devServerUrl) registerAppProtocol();
  web = setupWebTabs(() => mainWindow);

  try {
    server = await startServer(rendererOrigin);
  } catch (err) {
    dialog.showErrorBox("NathApp", `Failed to start the backend server:\n\n${err}`);
    app.exit(1);
    return;
  }

  createWindow(server);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) createWindow(server);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => server?.stop());
