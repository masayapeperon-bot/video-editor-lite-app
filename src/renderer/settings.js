// 設定画面
var api = window.api;

const toastEl = document.getElementById("toast");
let toastTimer;
function showToast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("error", !!isError);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

const defaults = {
  proxyUrl: "https://video-key-server.roudoku.workers.dev",
  proxyToken: "",
  workDir: "",
  trashRetentionDays: 7,
  autoBackup: true,
};

async function load() {
  const all = await api.settings.all();
  document.getElementById("proxyUrl").value = all.proxyUrl ?? defaults.proxyUrl;
  document.getElementById("proxyToken").value = all.proxyToken ?? "";
  document.getElementById("workDir").value = all.workDir ?? "";
  document.getElementById("trashRetentionDays").value = all.trashRetentionDays ?? defaults.trashRetentionDays;
  document.getElementById("autoBackup").checked = all.autoBackup !== false;
}

async function save() {
  await api.settings.set("proxyUrl", document.getElementById("proxyUrl").value.trim());
  await api.settings.set("proxyToken", document.getElementById("proxyToken").value.trim());
  await api.settings.set("workDir", document.getElementById("workDir").value.trim());
  const days = Math.max(1, Math.min(60, parseInt(document.getElementById("trashRetentionDays").value, 10) || 7));
  await api.settings.set("trashRetentionDays", days);
  await api.settings.set("autoBackup", document.getElementById("autoBackup").checked);
  showToast("保存しました");
}

async function reset() {
  if (!confirm("設定を標準に戻しますか？（アクセストークンも消えます）")) return;
  for (const [k, v] of Object.entries(defaults)) {
    await api.settings.set(k, v);
  }
  await load();
  showToast("初期化しました");
}

document.getElementById("btn-save").addEventListener("click", save);
document.getElementById("btn-reset").addEventListener("click", reset);
document.getElementById("btn-back").addEventListener("click", () => {
  location.href = "index.html";
});

load();
