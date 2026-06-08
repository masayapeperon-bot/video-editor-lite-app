// アプリ設定（electron-store ラッパー）
const Store = require("electron-store");

const store = new Store({
  name: "settings",
  defaults: {
    proxyUrl: "https://video-key-server.roudoku.workers.dev",
    proxyToken: "",
    workDir: "",
    trashRetentionDays: 7,
    autoBackup: true,
    recentProjects: [],
  },
});

function get(key) {
  return store.get(key);
}

function set(key, value) {
  store.set(key, value);
}

function getAll() {
  return store.store;
}

function getRecentProjects() {
  return store.get("recentProjects", []);
}

function addRecentProject(project) {
  const list = store.get("recentProjects", []);
  const filtered = list.filter((p) => p.id !== project.id);
  filtered.unshift({
    id: project.id,
    title: project.title,
    workDir: project.workDir,
    sourcePath: project.sourcePath,
    lastOpenedAt: new Date().toISOString(),
  });
  // 最大20件保持
  store.set("recentProjects", filtered.slice(0, 20));
}

function removeRecentProject(projectId) {
  const list = store.get("recentProjects", []);
  store.set("recentProjects", list.filter((p) => p.id !== projectId));
}

function findRecentProject(projectId) {
  return store.get("recentProjects", []).find((p) => p.id === projectId);
}

module.exports = {
  get,
  set,
  getAll,
  getRecentProjects,
  addRecentProject,
  removeRecentProject,
  findRecentProject,
};
