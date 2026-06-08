// Electron メインプロセス
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const projectManager = require("./project-manager");
const serverManager = require("./server-manager");
const settings = require("./settings");
const trashManager = require("./trash-manager");
const updater = require("./updater");

const isDev = process.argv.includes("--dev");

let mainWindow = null;
let currentProject = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
    backgroundColor: "#1a1a2e",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => mainWindow.show());

  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.on("closed", () => {
    serverManager.stopAll();
    mainWindow = null;
  });
}

// ── アプリ起動 ──
app.whenReady().then(async () => {
  createWindow();

  // 自動アップデートチェック（本番のみ）
  if (!isDev) {
    setTimeout(() => updater.check(mainWindow), 3000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  serverManager.stopAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  serverManager.stopAll();
});

// ──────────────────────────────────────────────────────────────
// IPC ハンドラ
// ──────────────────────────────────────────────────────────────

// プロジェクト一覧取得
ipcMain.handle("project:list", () => settings.getRecentProjects());

// プロジェクトを開く（zip or フォルダ）
ipcMain.handle("project:open-dialog", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "プロジェクトを開く",
    properties: ["openFile", "openDirectory"],
    filters: [{ name: "zip ファイル", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("project:load", async (_e, sourcePath) => {
  try {
    const project = await projectManager.loadProject(sourcePath);
    currentProject = project;
    settings.addRecentProject(project);
    return { ok: true, project };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("project:open-recent", async (_e, projectId) => {
  try {
    const project = await projectManager.openRecent(projectId);
    currentProject = project;
    return { ok: true, project };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("project:remove-recent", (_e, projectId) => {
  settings.removeRecentProject(projectId);
  return { ok: true };
});

ipcMain.handle("project:export", async (_e, projectId) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "納品データを保存",
      defaultPath: path.join(os.homedir(), "Desktop", "納品データ.zip"),
      filters: [{ name: "zip ファイル", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const outPath = await projectManager.exportDelivery(projectId, result.filePath);

    // 完成通知ダイアログ：ファイル位置を表示し、Finderで開く選択肢を提供
    const choice = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "納品データの書き出しが完了しました",
      message: "✅ 書き出し完了",
      detail: `保存先：\n${outPath}\n\n依頼者にこのzipファイルを送ってください。`,
      buttons: ["Finderで開く", "OK"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) shell.showItemInFolder(outPath);

    return { ok: true, path: outPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// サーバー起動・停止
ipcMain.handle("servers:start", async (_e, projectId) => {
  try {
    const ports = await serverManager.startAll(projectId);
    return { ok: true, ports };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("servers:stop", async () => {
  serverManager.stopAll();
  return { ok: true };
});

// 設定
ipcMain.handle("settings:get", (_e, key) => settings.get(key));
ipcMain.handle("settings:set", (_e, key, value) => settings.set(key, value));
ipcMain.handle("settings:all", () => settings.getAll());

// ゴミ箱
ipcMain.handle("trash:purge-expired", () => trashManager.purgeExpired());
ipcMain.handle("trash:list", (_e, projectId) => trashManager.list(projectId));
ipcMain.handle("trash:restore", (_e, projectId, fileId) => trashManager.restore(projectId, fileId));

// 外部リンクを開く
ipcMain.handle("shell:open-path", (_e, p) => shell.showItemInFolder(p));
ipcMain.handle("shell:open-external", (_e, url) => shell.openExternal(url));
