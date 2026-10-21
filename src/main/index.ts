import { app, BrowserWindow, dialog, net, protocol } from "electron";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { startServer, type ServerHandle } from "./server";
import { guardWindow, setupWebTabs } from "./web";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

// Lets tests run against a throwaway profile instead of the real data.
if (process.env.GAPP_USER_DATA_DIR) app.setPath("userData", process.env.GAPP_USER_DATA_DIR);

// Bun inlines `__dirname` at bundle time, so resolve build output from the app
// root instead (works both unpackaged and inside the packaged asar).
const distDir = join(app.getAppPath(), "dist");

// In production the renderer is served from a custom privileged scheme instead
// of file:// so it gets a real origin (needed for CORS against the Bun server).
const APP_SCHEME = "app";
const APP_HOST = "gapp";
const rendererOrigin = devServerUrl ? new URL(devServerUrl).origin : `${APP_SCHEME}://${APP_HOST}`;

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let server: ServerHandle | undefined;
let mainWindow: BrowserWindow | undefined;

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

function createWindow(serverUrl: string) {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(distDir, "electron/preload.cjs"),
      additionalArguments: [`--gapp-server-url=${serverUrl}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Web tabs are <webview> guests (locked down in web.ts).
      webviewTag: true,
      // Agent runs stream into the window while it's in the background.
      backgroundThrottling: false,
      // Tests render without a visible window (always painted, nothing pops up).
      offscreen: process.env.GAPP_OFFSCREEN === "1",
    },
  });

  win.once("ready-to-show", () => {
    if (process.env.GAPP_OFFSCREEN !== "1") win.show();
  });

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  guardWindow(win, rendererOrigin);

  if (devServerUrl) {
    win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadURL(`${APP_SCHEME}://${APP_HOST}/`);
  }
}

app.whenReady().then(async () => {
  if (!devServerUrl) registerAppProtocol();
  setupWebTabs(() => mainWindow);

  try {
    server = await startServer(rendererOrigin);
  } catch (err) {
    dialog.showErrorBox("gApp", `Failed to start the backend server:\n\n${err}`);
    app.exit(1);
    return;
  }

  createWindow(server.url);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) createWindow(server.url);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => server?.stop());
