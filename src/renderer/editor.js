// メイン編集画面（タブ切り替え + webview管理）
var api = window.api;

const params = new URLSearchParams(location.search);
const projectId = params.get("id");
const projectTitle = params.get("title");

document.getElementById("proj-title").textContent = projectTitle ? `編集中: ${projectTitle}` : "編集中";

const toastEl = document.getElementById("toast");
const loadingEl = document.getElementById("loading");
const loadingTextEl = document.getElementById("loading-text");
const loadingDetailEl = document.getElementById("loading-detail");
let toastTimer;
function showToast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("error", !!isError);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3000);
}
function showLoading(text, detail) {
  loadingTextEl.textContent = text || "処理中...";
  loadingDetailEl.textContent = detail || "";
  loadingEl.classList.add("show");
}
function hideLoading() {
  loadingEl.classList.remove("show");
}

// タブ切り替え
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    const targetId = `tab-${tab.dataset.tab}`;
    document.getElementById(targetId).classList.add("active");
  });
});

// 戻る
document.getElementById("btn-back").addEventListener("click", async () => {
  if (!confirm("プロジェクトを閉じてサーバーを停止します。よろしいですか？")) return;
  await api.servers.stop();
  location.href = "index.html";
});

// 納品書き出し
document.getElementById("btn-export").addEventListener("click", async () => {
  if (!confirm("現在の作業内容を納品zipとして書き出します。\n修正済みの画像・音声・テロップ等の素材一式が出力されます。\n（エンコードしている場合はMP4も含まれます）\n\n続けますか？")) return;

  showLoading("納品データを書き出し中...", "ファイル数によっては数分かかります。閉じずにお待ちください。");
  try {
    const r = await api.project.export(projectId);
    hideLoading();
    if (r.canceled) return;
    if (!r.ok) { showToast(r.error, true); return; }
    // 完了通知はメインプロセス側のダイアログで表示される
  } catch (e) {
    hideLoading();
    showToast(e.message || "エラーが発生しました", true);
  }
});

// 終了時にサーバー停止
window.addEventListener("beforeunload", () => {
  // ページ遷移時にサーバーを止めない（タブ切り替えで誤って止まるのを防ぐため、btn-back のみで停止）
});
