// レンダラー → メインプロセスの安全な橋渡し
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  project: {
    list: () => ipcRenderer.invoke("project:list"),
    openDialog: () => ipcRenderer.invoke("project:open-dialog"),
    load: (sourcePath) => ipcRenderer.invoke("project:load", sourcePath),
    openRecent: (projectId) => ipcRenderer.invoke("project:open-recent", projectId),
    removeRecent: (projectId) => ipcRenderer.invoke("project:remove-recent", projectId),
    export: (projectId) => ipcRenderer.invoke("project:export", projectId),
  },
  servers: {
    start: (projectId) => ipcRenderer.invoke("servers:start", projectId),
    stop: () => ipcRenderer.invoke("servers:stop"),
  },
  settings: {
    get: (key) => ipcRenderer.invoke("settings:get", key),
    set: (key, value) => ipcRenderer.invoke("settings:set", key, value),
    all: () => ipcRenderer.invoke("settings:all"),
  },
  trash: {
    purgeExpired: () => ipcRenderer.invoke("trash:purge-expired"),
    list: (projectId) => ipcRenderer.invoke("trash:list", projectId),
    restore: (projectId, fileId) => ipcRenderer.invoke("trash:restore", projectId, fileId),
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke("shell:open-path", p),
    openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  },
  onUpdateStatus: (cb) => {
    ipcRenderer.on("update:status", (_e, status) => cb(status));
  },
});
