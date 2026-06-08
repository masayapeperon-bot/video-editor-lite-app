/**
 * 画像差し替えエディタ — フロントエンド
 * 取り込んだ画像を1376×768にリサイズ（cover/中央クロップ）してサーバーに送信
 */

const API = "";
const TARGET_W = 1376;
const TARGET_H = 768;

let scenes = [];
let modelImages = [];
let currentIdx = 0;
let previewBase64 = null; // 差し替え候補画像のbase64（PNG）
let previewFilename = "";

async function init() {
  const [scenesRes, modelsRes] = await Promise.all([
    fetch(`${API}/api/scenes`),
    fetch(`${API}/api/model-images`),
  ]);
  scenes = await scenesRes.json();
  modelImages = await modelsRes.json();

  const select = document.getElementById("model-select");
  for (const m of modelImages) {
    const opt = document.createElement("option");
    opt.value = m.name;
    opt.textContent = m.name;
    select.appendChild(opt);
  }

  document.getElementById("stats").textContent = `${scenes.length}シーン`;

  const hash = location.hash.match(/^#scene\/(\d+)$/);
  if (hash) {
    const id = Number(hash[1]);
    const idx = scenes.findIndex((s) => s.id === id);
    if (idx !== -1) currentIdx = idx;
  }

  setupEvents();
  showScene();
}

function setupEvents() {
  document.getElementById("btn-prev").addEventListener("click", () => {
    if (currentIdx > 0) { currentIdx--; showScene(); }
  });
  document.getElementById("btn-next").addEventListener("click", () => {
    if (currentIdx < scenes.length - 1) { currentIdx++; showScene(); }
  });

  document.getElementById("model-select").addEventListener("change", (e) => {
    const name = e.target.value;
    const img = document.getElementById("model-image");
    if (name) {
      img.src = `${API}/api/model-images/${encodeURIComponent(name)}`;
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }
  });

  // ファイル選択
  const fileInput = document.getElementById("file-input");
  document.getElementById("btn-pick-file").addEventListener("click", () => {
    fileInput.click();
  });
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
    fileInput.value = "";
  });

  // ドラッグ＆ドロップ
  const dropZone = document.getElementById("drop-zone");
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) handleFile(file);
  });

  // 差し替え / キャンセル / ダウンロード
  document.getElementById("btn-commit").addEventListener("click", commitUpload);
  document.getElementById("btn-cancel").addEventListener("click", resetPreview);
  document.getElementById("btn-download").addEventListener("click", downloadCurrent);

  // キーボード（input/textareaにフォーカスがない時のみ）
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowLeft" && currentIdx > 0) { currentIdx--; showScene(); }
    if (e.key === "ArrowRight" && currentIdx < scenes.length - 1) { currentIdx++; showScene(); }
  });

  window.addEventListener("hashchange", () => {
    const hash = location.hash.match(/^#scene\/(\d+)$/);
    if (hash) {
      const id = Number(hash[1]);
      const idx = scenes.findIndex((s) => s.id === id);
      if (idx !== -1) { currentIdx = idx; showScene(); }
    }
  });
}

function showScene() {
  const scene = scenes[currentIdx];
  if (!scene) return;

  document.getElementById("scene-label").textContent =
    `シーン #${String(scene.id).padStart(3, "0")} (${scene.part}-${scene.partSceneNumber})`;
  document.getElementById("scene-text").textContent = scene.text;

  const img = document.getElementById("main-image");
  const noImg = document.getElementById("no-image");
  if (scene.hasImage) {
    img.src = `${API}/api/scenes/${scene.id}/image?t=${Date.now()}`;
    img.classList.remove("hidden");
    noImg.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    noImg.classList.remove("hidden");
  }

  resetPreview();
}

function resetPreview() {
  previewBase64 = null;
  previewFilename = "";
  document.getElementById("preview-box").classList.add("hidden");
  document.getElementById("upload-box").classList.remove("hidden");
}

/**
 * 取り込んだファイルを 1376×768 にリサイズ（cover/中央クロップ）してプレビュー表示
 */
async function handleFile(file) {
  try {
    const dataUrl = await readAsDataUrl(file);
    const img = await loadImage(dataUrl);
    const resizedDataUrl = resizeToTarget(img);

    previewBase64 = resizedDataUrl.split(",")[1];
    previewFilename = file.name;

    document.getElementById("preview-image").src = resizedDataUrl;
    document.getElementById("preview-filename").textContent =
      `元ファイル: ${file.name}（${img.width}×${img.height} → ${TARGET_W}×${TARGET_H}）`;
    document.getElementById("upload-box").classList.add("hidden");
    document.getElementById("preview-box").classList.remove("hidden");
  } catch (e) {
    alert(`画像の読み込みに失敗しました: ${e.message}`);
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("読み込み失敗"));
    r.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("画像形式が不正です"));
    i.src = dataUrl;
  });
}

/**
 * 16:9 にトリミング（cover）して 1376×768 のPNGを返す
 */
function resizeToTarget(img) {
  const canvas = document.createElement("canvas");
  canvas.width = TARGET_W;
  canvas.height = TARGET_H;
  const ctx = canvas.getContext("2d");

  const srcRatio = img.width / img.height;
  const dstRatio = TARGET_W / TARGET_H;
  let sx, sy, sw, sh;
  if (srcRatio > dstRatio) {
    // 元画像が横長すぎる → 左右をカット
    sh = img.height;
    sw = sh * dstRatio;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {
    // 元画像が縦長 → 上下をカット
    sw = img.width;
    sh = sw / dstRatio;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, TARGET_W, TARGET_H);
  return canvas.toDataURL("image/png");
}

async function downloadCurrent() {
  const scene = scenes[currentIdx];
  if (!scene?.hasImage) {
    alert("ダウンロード可能な画像がありません");
    return;
  }
  try {
    const res = await fetch(`${API}/api/scenes/${scene.id}/image?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = scene.imageName || `${scene.part}_scene_${String(scene.partSceneNumber).padStart(2, "0")}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(`ダウンロード失敗: ${e.message}`);
  }
}

async function commitUpload() {
  if (!previewBase64) return;
  const scene = scenes[currentIdx];
  if (!scene) return;

  const btn = document.getElementById("btn-commit");
  const origText = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '差し替え中...<span class="loading"></span>';

  try {
    const res = await fetch(`${API}/api/scenes/${scene.id}/upload-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: previewBase64,
        sourceName: previewFilename,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(`エラー: ${err.error}`);
      return;
    }

    // 左側のメイン画像を更新
    document.getElementById("main-image").src =
      `${API}/api/scenes/${scene.id}/image?t=${Date.now()}`;

    // 親（Remotion）に更新通知
    if (window.parent !== window) {
      window.parent.postMessage({ type: "editor-updated", sceneId: scene.id }, "*");
    }

    resetPreview();
    alert("画像を差し替えました");
  } catch (e) {
    alert(`エラー: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

init();
