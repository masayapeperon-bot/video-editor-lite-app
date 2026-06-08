// プロジェクト管理画面
var api = window.api;

const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const toastEl = document.getElementById("toast");

function showLoading(text) {
  loadingText.textContent = text || "読み込み中...";
  loading.classList.add("show");
}
function hideLoading() {
  loading.classList.remove("show");
}

let toastTimer;
function showToast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("error", !!isError);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3000);
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

async function renderRecent() {
  const list = await api.project.list();
  const container = document.getElementById("recent-list");
  const empty = document.getElementById("empty");
  if (!list.length) {
    container.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  container.innerHTML = list.map((p) => `
    <div class="project-card">
      <div class="project-info">
        <div class="project-title">${escapeHtml(p.title)}</div>
        <div class="project-meta">最終作業: ${fmtDate(p.lastOpenedAt)} ・ ${escapeHtml(p.workDir)}</div>
      </div>
      <div class="project-actions">
        <button class="btn btn-primary" data-act="open" data-id="${p.id}">開く</button>
        <button class="btn btn-success" data-act="export" data-id="${p.id}">納品データを書き出し</button>
        <button class="btn btn-danger" data-act="remove" data-id="${p.id}">一覧から削除</button>
      </div>
    </div>
  `).join("");

  container.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => handleAct(btn.dataset.act, btn.dataset.id));
  });
}

async function handleAct(act, id) {
  if (act === "open") {
    showLoading("プロジェクトを準備中...");
    const r = await api.project.openRecent(id);
    if (!r.ok) { hideLoading(); showToast(r.error, true); return; }
    await launchProject(r.project);
  } else if (act === "export") {
    showLoading("納品データを書き出し中...");
    try {
      const r = await api.project.export(id);
      hideLoading();
      if (r.canceled) return;
      if (!r.ok) { showToast(r.error, true); return; }
      // 完了通知はメインプロセス側のダイアログで表示される
    } catch (e) {
      hideLoading();
      showToast(e.message || "エラー", true);
    }
  } else if (act === "remove") {
    if (!confirm("この一覧から削除しますか？（実ファイルは消えません）")) return;
    await api.project.removeRecent(id);
    renderRecent();
  }
}

async function openZip() {
  const sourcePath = await api.project.openDialog();
  if (!sourcePath) return;
  showLoading("展開中...");
  const r = await api.project.load(sourcePath);
  if (!r.ok) { hideLoading(); showToast(r.error, true); return; }
  await launchProject(r.project);
}

async function launchProject(project) {
  showLoading(`サーバー起動中... (${project.title})`);
  const r = await api.servers.start(project.id);
  hideLoading();
  if (!r.ok) { showToast(r.error, true); return; }
  // 編集画面に遷移
  const url = `editor.html?id=${encodeURIComponent(project.id)}&title=${encodeURIComponent(project.title)}`;
  location.href = url;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

document.getElementById("btn-open-zip").addEventListener("click", openZip);
document.getElementById("btn-open-folder").addEventListener("click", openZip); // 両方 openDialog で対応
document.getElementById("btn-settings").addEventListener("click", () => {
  location.href = "settings.html";
});

// 起動時：ゴミ箱クリーンアップ + 一覧表示
(async function init() {
  await api.trash.purgeExpired().catch(() => {});
  renderRecent();
})();
