/**
 * 音声レビュー＆修正エディタ — メインアプリケーション
 */

const API = "";
let scenes = [];
let currentFilter = "all";
let currentScene = null;
let currentAudio = null; // HTMLAudioElement for inline playback
let previewAudioData = null; // base64 from regenerate
let waveformViewer = null;

// ── 初期化 ──
async function init() {
  await loadScenes();
  setupFilters();
  setupDetailPanel();
}

// ── シーン一覧 ──
async function loadScenes() {
  const res = await fetch(`${API}/api/scenes`);
  scenes = await res.json();
  renderSceneList();
  updateStats();
}

function updateStats() {
  const total = scenes.length;
  const withAudio = scenes.filter((s) => s.hasAudio).length;
  document.getElementById("stats").textContent =
    `${total}シーン | 音声: ${withAudio}`;
}

function renderSceneList() {
  const container = document.getElementById("scene-list");
  const filtered = scenes.filter((s) => {
    if (currentFilter === "all") return true;
    if (["起", "承", "転", "結"].includes(currentFilter)) return s.part === currentFilter;
    return true;
  });

  container.innerHTML = filtered
    .map(
      (s) => `
    <div class="scene-row" data-id="${s.id}">
      <span class="scene-id">#${String(s.id).padStart(3, "0")}</span>
      <span class="scene-part ${s.part}">${s.part}</span>
      <span class="scene-text">${escapeHtml(s.text.replace(/\n/g, " "))}</span>
      <div class="scene-player">
        ${
          s.hasAudio
            ? `<button class="play-btn" data-id="${s.id}" title="再生">&#9654;</button>`
            : `<span class="no-audio">音声なし</span>`
        }
      </div>
    </div>
  `
    )
    .join("");

  // イベント設定
  container.querySelectorAll(".play-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlay(Number(btn.dataset.id));
    });
  });

  container.querySelectorAll(".scene-row").forEach((row) => {
    row.addEventListener("click", () => {
      openDetail(Number(row.dataset.id));
    });
  });
}

// ── インライン再生 ──
function togglePlay(id) {
  const btn = document.querySelector(`.play-btn[data-id="${id}"]`);
  if (currentAudio && currentAudio._sceneId === id) {
    if (currentAudio.paused) {
      currentAudio.play();
      btn.classList.add("playing");
      btn.innerHTML = "&#9724;";
    } else {
      currentAudio.pause();
      btn.classList.remove("playing");
      btn.innerHTML = "&#9654;";
    }
    return;
  }

  // 別のシーンが再生中なら停止
  stopCurrentAudio();

  currentAudio = new Audio(`${API}/api/scenes/${id}/audio`);
  currentAudio._sceneId = id;
  currentAudio.play();
  btn.classList.add("playing");
  btn.innerHTML = "&#9724;";

  currentAudio.addEventListener("ended", () => {
    btn.classList.remove("playing");
    btn.innerHTML = "&#9654;";
    currentAudio = null;
  });
}

function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    const oldBtn = document.querySelector(`.play-btn[data-id="${currentAudio._sceneId}"]`);
    if (oldBtn) {
      oldBtn.classList.remove("playing");
      oldBtn.innerHTML = "&#9654;";
    }
    currentAudio = null;
  }
}

// ── フィルター ──
function setupFilters() {
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      renderSceneList();
    });
  });
}

// ── 詳細パネル ──
function setupDetailPanel() {
  document.getElementById("detail-close").addEventListener("click", closeDetail);
  document.getElementById("detail-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeDetail();
  });

  // タブ切り替え
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");

      // 波形タブに切り替えたら波形をロード
      if (btn.dataset.tab === "timing" && currentScene && !waveformViewer) {
        loadWaveform(currentScene.id);
      }
      // イントネーションタブに切り替えたら部分差し替えをセットアップ
      if (btn.dataset.tab === "intonation" && currentScene && !spliceWaveform) {
        setupSplice();
      }
    });
  });

  // 発音辞書追加
  document.getElementById("pron-add-btn").addEventListener("click", addPronunciation);

  // プレビュー再生成
  document.getElementById("btn-preview").addEventListener("click", previewRegenerate);
  document.getElementById("btn-commit").addEventListener("click", commitRegenerate);
  document.getElementById("btn-play-current").addEventListener("click", () => {
    if (currentScene) togglePlay(currentScene.id);
  });

  // イントネーション
  ["stability", "similarity", "style"].forEach((param) => {
    const slider = document.getElementById(`slider-${param}`);
    const val = document.getElementById(`val-${param}`);
    slider.addEventListener("input", () => {
      val.textContent = Number(slider.value).toFixed(2);
    });
  });

  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("slider-stability").value = btn.dataset.stability;
      document.getElementById("val-stability").textContent = Number(btn.dataset.stability).toFixed(2);
      document.getElementById("slider-style").value = btn.dataset.style;
      document.getElementById("val-style").textContent = Number(btn.dataset.style).toFixed(2);
    });
  });

  document.getElementById("btn-intonation-preview").addEventListener("click", previewIntonation);
  document.getElementById("btn-intonation-commit").addEventListener("click", commitIntonation);

  // 部分差し替え波形操作
  document.getElementById("splice-play").addEventListener("click", () => {
    if (spliceWaveform) spliceWaveform.play();
  });
  document.getElementById("splice-stop").addEventListener("click", () => {
    if (spliceWaveform) spliceWaveform.stop();
  });

  // 波形操作
  document.getElementById("btn-play-timing").addEventListener("click", () => {
    if (waveformViewer) waveformViewer.play();
  });
  document.getElementById("btn-stop-timing").addEventListener("click", () => {
    if (waveformViewer) waveformViewer.stop();
  });
  document.getElementById("btn-insert-silence").addEventListener("click", insertSilence);

  // 波形クリックでシーク
  document.getElementById("waveform-canvas").addEventListener("click", (e) => {
    if (!waveformViewer) return;
    const rect = e.target.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    waveformViewer.seekTo(fraction);
  });

  // Escで閉じる
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });
}

async function openDetail(id) {
  const res = await fetch(`${API}/api/scenes/${id}`);
  currentScene = await res.json();
  previewAudioData = null;
  waveformViewer = null;
  spliceWaveform = null;
  spliceSelection = null;
  splicePreviewData = null;

  document.getElementById("detail-title").textContent =
    `シーン #${String(id).padStart(3, "0")} (${currentScene.part}-${currentScene.partSceneNumber})`;

  // テキスト表示
  document.getElementById("original-text").textContent = currentScene.text;
  document.getElementById("tts-text").textContent = currentScene.ttsText;
  // overrides に保存済みの手動編集があればそれを復元、なければ自動変換テキストを使用
  const savedOverride = currentScene.overrides?.textOverride;
  document.getElementById("text-override").value = savedOverride || currentScene.ttsText;

  // 発音辞書
  renderPronunciation(currentScene.pronunciation);

  // ボタン状態リセット
  document.getElementById("btn-commit").disabled = true;
  document.getElementById("btn-intonation-commit").disabled = true;
  document.getElementById("preview-player").classList.add("hidden");
  document.getElementById("intonation-preview-player").classList.add("hidden");

  // タブを読み修正に戻す
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
  document.querySelector('[data-tab="pronunciation"]').classList.add("active");
  document.getElementById("tab-pronunciation").classList.add("active");

  document.getElementById("detail-overlay").classList.remove("hidden");
}

function closeDetail() {
  document.getElementById("detail-overlay").classList.add("hidden");
  if (waveformViewer) {
    waveformViewer.stop();
    waveformViewer = null;
  }
  if (spliceWaveform) {
    spliceWaveform.stop();
    spliceWaveform = null;
  }
  currentScene = null;
}

// ── 発音辞書UI ──
function renderPronunciation(pron) {
  const container = document.getElementById("pron-list");
  const entries = Object.entries(pron);
  if (entries.length === 0) {
    container.innerHTML = '<span style="color:#666;font-size:12px">登録なし</span>';
    return;
  }
  container.innerHTML = entries
    .map(
      ([k, v]) =>
        `<span class="pron-entry">${escapeHtml(k)} → ${escapeHtml(v)} <button class="delete-pron" data-key="${escapeHtml(k)}">&times;</button></span>`
    )
    .join("");

  container.querySelectorAll(".delete-pron").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`${API}/api/pronunciation/${encodeURIComponent(btn.dataset.key)}`, {
        method: "DELETE",
      });
      const res = await fetch(`${API}/api/scenes/${currentScene.id}`);
      currentScene = await res.json();
      renderPronunciation(currentScene.pronunciation);
      document.getElementById("tts-text").textContent = currentScene.ttsText;
      document.getElementById("text-override").value = currentScene.ttsText;
    });
  });
}

async function addPronunciation() {
  const key = document.getElementById("pron-key").value.trim();
  const value = document.getElementById("pron-value").value.trim();
  if (!key || !value) return;

  await fetch(`${API}/api/pronunciation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });

  document.getElementById("pron-key").value = "";
  document.getElementById("pron-value").value = "";

  // 再取得
  const res = await fetch(`${API}/api/scenes/${currentScene.id}`);
  currentScene = await res.json();
  renderPronunciation(currentScene.pronunciation);
  document.getElementById("tts-text").textContent = currentScene.ttsText;
  document.getElementById("text-override").value = currentScene.ttsText;
}

// ── 読み修正プレビュー ──
async function previewRegenerate() {
  if (!currentScene) return;
  const btn = document.getElementById("btn-preview");
  const origText = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '生成中...<span class="loading"></span>';

  try {
    const textOverride = document.getElementById("text-override").value.trim();
    const res = await fetch(`${API}/api/scenes/${currentScene.id}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textOverride: textOverride || undefined }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(`エラー: ${err.error}`);
      return;
    }

    previewAudioData = await res.json();
    const audio = document.getElementById("preview-audio");
    audio.src = `data:audio/mpeg;base64,${previewAudioData.audioBase64}`;
    document.getElementById("preview-player").classList.remove("hidden");
    document.getElementById("btn-commit").disabled = false;
    audio.play();
  } catch (e) {
    alert(`エラー: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function commitRegenerate() {
  if (!previewAudioData || !currentScene) return;
  const btn = document.getElementById("btn-commit");
  btn.disabled = true;

  const textOverride = document.getElementById("text-override").value.trim();
  await fetch(`${API}/api/scenes/${currentScene.id}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audioBase64: previewAudioData.audioBase64,
      alignment: previewAudioData.alignment,
      textOverride: textOverride || undefined,
    }),
  });

  await loadScenes();
  alert("音声を差し替えました");
  if (window.parent !== window) {
    window.parent.postMessage({ type: "editor-updated" }, "*");
  }
  btn.disabled = true;
}

// ── イントネーションプレビュー ──
let intonationAudioData = null;

async function previewIntonation() {
  if (!currentScene) return;
  const btn = document.getElementById("btn-intonation-preview");
  const origText = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '生成中...<span class="loading"></span>';

  try {
    const voiceSettings = {
      stability: Number(document.getElementById("slider-stability").value),
      similarity_boost: Number(document.getElementById("slider-similarity").value),
      style: Number(document.getElementById("slider-style").value),
      use_speaker_boost: true,
    };

    const res = await fetch(`${API}/api/scenes/${currentScene.id}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceSettings }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(`エラー: ${err.error}`);
      return;
    }

    intonationAudioData = await res.json();
    const audio = document.getElementById("intonation-audio");
    audio.src = `data:audio/mpeg;base64,${intonationAudioData.audioBase64}`;
    document.getElementById("intonation-preview-player").classList.remove("hidden");
    document.getElementById("btn-intonation-commit").disabled = false;
    audio.play();
  } catch (e) {
    alert(`エラー: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function commitIntonation() {
  if (!intonationAudioData || !currentScene) return;
  const btn = document.getElementById("btn-intonation-commit");
  btn.disabled = true;

  const voiceSettings = {
    stability: Number(document.getElementById("slider-stability").value),
    similarity_boost: Number(document.getElementById("slider-similarity").value),
    style: Number(document.getElementById("slider-style").value),
    use_speaker_boost: true,
  };

  await fetch(`${API}/api/scenes/${currentScene.id}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audioBase64: intonationAudioData.audioBase64,
      alignment: intonationAudioData.alignment,
      voiceSettings,
    }),
  });

  await loadScenes();
  alert("音声を差し替えました");
  if (window.parent !== window) {
    window.parent.postMessage({ type: "editor-updated" }, "*");
  }
  btn.disabled = true;
}

// ── 波形 ──
async function loadWaveform(id) {
  const canvas = document.getElementById("waveform-canvas");
  waveformViewer = new WaveformViewer(canvas, `${API}/api/scenes/${id}/audio`);
  waveformViewer.onPositionChange = (current, total) => {
    document.getElementById("timing-position").textContent =
      `${formatTime(current)} / ${formatTime(total)}`;
  };
  await waveformViewer.load();
  renderSilences();
}

function renderSilences() {
  if (!waveformViewer) return;
  const container = document.getElementById("silence-items");
  const silences = waveformViewer.silences;

  if (silences.length === 0) {
    container.innerHTML = '<span style="color:#666;font-size:12px">無音区間なし</span>';
    return;
  }

  container.innerHTML = silences
    .map(
      (s, i) => `
    <div class="silence-item">
      <span>${formatTime(s.startSec)} - ${formatTime(s.endSec)} (${s.durationMs}ms)</span>
      <button onclick="adjustSilence(${i}, 100)">+100ms</button>
      <button onclick="adjustSilence(${i}, -100)">-100ms</button>
      <button onclick="removeSilence(${i})">削除</button>
    </div>
  `
    )
    .join("");
}

async function insertSilence() {
  if (!waveformViewer || !currentScene) return;
  const timestampMs = Math.round(waveformViewer.getCurrentTime() * 1000);
  const durationMs = Number(document.getElementById("silence-duration").value);

  const res = await fetch(`${API}/api/scenes/${currentScene.id}/insert-silence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestampMs, durationMs }),
  });

  if (res.ok) {
    await loadWaveform(currentScene.id);
    showTimingNotification("無音を挿入しました");
  }
}

async function removeSilence(index) {
  if (!waveformViewer || !currentScene) return;
  const silence = waveformViewer.silences[index];
  if (!silence) return;

  const res = await fetch(`${API}/api/scenes/${currentScene.id}/remove-silence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startMs: Math.round(silence.startSec * 1000),
      endMs: Math.round(silence.endSec * 1000),
    }),
  });

  if (res.ok) {
    await loadWaveform(currentScene.id);
    showTimingNotification("無音を削除しました");
  }
}

async function adjustSilence(index, deltaMs) {
  if (!waveformViewer || !currentScene) return;
  const silence = waveformViewer.silences[index];
  if (!silence) return;

  if (deltaMs > 0) {
    // 無音を延長 = 無音の終了位置に無音を挿入
    await fetch(`${API}/api/scenes/${currentScene.id}/insert-silence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestampMs: Math.round(silence.endSec * 1000),
        durationMs: deltaMs,
      }),
    });
  } else {
    // 無音を短縮 = 無音の一部を除去
    const removeMs = Math.min(Math.abs(deltaMs), silence.durationMs - 50);
    if (removeMs <= 0) return;
    await fetch(`${API}/api/scenes/${currentScene.id}/remove-silence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startMs: Math.round(silence.startSec * 1000),
        endMs: Math.round(silence.startSec * 1000 + removeMs),
      }),
    });
  }

  await loadWaveform(currentScene.id);
  showTimingNotification(deltaMs > 0 ? "無音を延長しました" : "無音を短縮しました");
}

let timingDirty = false; // 間の調整が行われたかどうか

/** 間の調整後の通知表示（リロードはしない） */
function showTimingNotification(message) {
  timingDirty = true;

  // 既存の通知を削除
  const old = document.getElementById("timing-notification");
  if (old) old.remove();

  const el = document.createElement("div");
  el.id = "timing-notification";
  el.style.cssText = "position:fixed;top:16px;right:16px;background:#1b4332;color:#95d5b2;padding:10px 18px;border-radius:6px;font-size:13px;z-index:9999;border:1px solid #2d6a4f;transition:opacity 0.3s;";
  el.textContent = "✓ " + message + "（テロップも自動調整済み）";
  document.body.appendChild(el);

  // 確定ボタンを表示
  const commitBtn = document.getElementById("btn-timing-commit");
  if (commitBtn) commitBtn.style.display = "inline-block";

  // 3秒後にフェードアウト
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

/** 間の調整を確定してRemotionに反映 */
function commitTimingChanges() {
  if (!timingDirty) return;
  timingDirty = false;
  const commitBtn = document.getElementById("btn-timing-commit");
  if (commitBtn) commitBtn.style.display = "none";

  if (window.parent !== window) {
    window.parent.postMessage({ type: "editor-updated" }, "*");
  }
}

// ── 部分イントネーション差し替え ──
let spliceWaveform = null;
let spliceSelection = null; // { startIdx, endIdx, startMs, endMs, text }
let splicePreviewData = null;
let spliceAlignmentData = null; // alignment from scene detail

// イントネーションタブが開かれた時に波形とテキストをセットアップ
async function setupSplice() {
  if (!currentScene || !currentScene.hasAudio) return;

  // 波形
  const canvas = document.getElementById("splice-waveform");
  spliceWaveform = new WaveformViewer(canvas, `${API}/api/scenes/${currentScene.id}/audio`);
  spliceWaveform.onPositionChange = (current, total) => {
    document.getElementById("splice-position").textContent =
      `${formatTime(current)} / ${formatTime(total)}`;
  };

  // テキストを文字単位で表示（選択可能に）
  const textContainer = document.getElementById("splice-text");
  const flatText = currentScene.text.replace(/\n/g, "");
  textContainer.innerHTML = flatText
    .split("")
    .map((ch, i) => `<span class="char" data-idx="${i}">${escapeHtml(ch)}</span>`)
    .join("");

  // アライメントデータを取得（タイミングファイルから）
  try {
    const timingRes = await fetch(`${API}/api/scenes/${currentScene.id}/timing`);
    if (timingRes.ok) {
      spliceAlignmentData = await timingRes.json();
    }
  } catch {}

  await spliceWaveform.load();

  // テキスト選択イベント
  setupTextSelection(textContainer, flatText);

  // 波形でのドラッグ選択
  setupWaveformDragSelect(canvas);

  // リセット
  spliceSelection = null;
  splicePreviewData = null;
  document.getElementById("splice-selected-range").classList.add("hidden");
  document.getElementById("splice-preview-player").classList.add("hidden");
  document.getElementById("btn-splice-preview").disabled = true;
  document.getElementById("btn-splice-commit").disabled = true;
}

function setupTextSelection(container, flatText) {
  let isSelecting = false;
  let startIdx = -1;

  container.addEventListener("mousedown", (e) => {
    const char = e.target.closest(".char");
    if (!char) return;
    isSelecting = true;
    startIdx = Number(char.dataset.idx);
    clearCharHighlights(container);
    char.classList.add("selected");
  });

  container.addEventListener("mousemove", (e) => {
    if (!isSelecting) return;
    const char = e.target.closest(".char");
    if (!char) return;
    const endIdx = Number(char.dataset.idx);
    clearCharHighlights(container);
    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);
    container.querySelectorAll(".char").forEach((ch) => {
      const idx = Number(ch.dataset.idx);
      if (idx >= lo && idx <= hi) ch.classList.add("selected");
    });
  });

  container.addEventListener("mouseup", (e) => {
    if (!isSelecting) return;
    isSelecting = false;
    const char = e.target.closest(".char");
    if (!char) return;
    const endIdx = Number(char.dataset.idx);
    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);
    const selectedText = flatText.slice(lo, hi + 1);

    if (selectedText.length === 0) return;

    // 時間範囲を推定（文字位置の比率から）
    const duration = spliceWaveform ? spliceWaveform.duration : 0;
    const startMs = Math.round((lo / flatText.length) * duration * 1000);
    const endMs = Math.round(((hi + 1) / flatText.length) * duration * 1000);

    spliceSelection = { startIdx: lo, endIdx: hi, startMs, endMs, text: selectedText };
    showSpliceSelection();
  });
}

function setupWaveformDragSelect(canvas) {
  let isDragging = false;
  let dragStartFraction = 0;

  canvas.addEventListener("mousedown", (e) => {
    if (!spliceWaveform) return;
    const rect = canvas.getBoundingClientRect();
    dragStartFraction = (e.clientX - rect.left) / rect.width;
    isDragging = true;
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!isDragging || !spliceWaveform) return;
    const rect = canvas.getBoundingClientRect();
    const currentFraction = (e.clientX - rect.left) / rect.width;
    const lo = Math.min(dragStartFraction, currentFraction);
    const hi = Math.max(dragStartFraction, currentFraction);

    // 波形に選択範囲を描画
    spliceWaveform.draw();
    const ctx = spliceWaveform.ctx;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    ctx.fillStyle = "rgba(233, 165, 69, 0.25)";
    ctx.fillRect(lo * cw, 0, (hi - lo) * cw, ch);
  });

  canvas.addEventListener("mouseup", (e) => {
    if (!isDragging || !spliceWaveform) return;
    isDragging = false;
    const rect = canvas.getBoundingClientRect();
    const endFraction = (e.clientX - rect.left) / rect.width;
    const lo = Math.min(dragStartFraction, endFraction);
    const hi = Math.max(dragStartFraction, endFraction);

    if (hi - lo < 0.01) return; // 範囲が小さすぎる

    const duration = spliceWaveform.duration;
    const startMs = Math.round(lo * duration * 1000);
    const endMs = Math.round(hi * duration * 1000);

    // テキスト範囲を推定
    const flatText = currentScene.text.replace(/\n/g, "");
    const startIdx = Math.round(lo * flatText.length);
    const endIdx = Math.min(Math.round(hi * flatText.length), flatText.length - 1);
    const selectedText = flatText.slice(startIdx, endIdx + 1);

    // テキスト上のハイライトも更新
    const container = document.getElementById("splice-text");
    clearCharHighlights(container);
    container.querySelectorAll(".char").forEach((ch) => {
      const idx = Number(ch.dataset.idx);
      if (idx >= startIdx && idx <= endIdx) ch.classList.add("selected");
    });

    spliceSelection = { startIdx, endIdx, startMs, endMs, text: selectedText };
    showSpliceSelection();
  });
}

function clearCharHighlights(container) {
  container.querySelectorAll(".char.selected, .char.in-range").forEach((ch) => {
    ch.classList.remove("selected", "in-range");
  });
}

function showSpliceSelection() {
  if (!spliceSelection) return;
  document.getElementById("splice-range-text").textContent = spliceSelection.text;
  document.getElementById("splice-range-time").textContent =
    `(${formatTime(spliceSelection.startMs / 1000)} - ${formatTime(spliceSelection.endMs / 1000)})`;
  document.getElementById("splice-selected-range").classList.remove("hidden");
  document.getElementById("btn-splice-preview").disabled = false;
  document.getElementById("splice-selection-info").textContent =
    `選択中: ${spliceSelection.text.length}文字`;
}

// 部分プレビュー
document.getElementById("btn-splice-preview")?.addEventListener("click", async () => {
  if (!spliceSelection || !currentScene) return;
  const btn = document.getElementById("btn-splice-preview");
  const origText = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '生成中...<span class="loading"></span>';

  try {
    const pron = currentScene.pronunciation || {};
    // 選択テキストに発音置換を適用（簡易版 — サーバーで処理するのが理想だが、ここではそのまま送る）
    const voiceSettings = {
      stability: Number(document.getElementById("slider-splice-stability").value),
      similarity_boost: 0.75,
      style: Number(document.getElementById("slider-splice-style").value),
      use_speaker_boost: true,
    };

    const res = await fetch(`${API}/api/scenes/${currentScene.id}/splice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startMs: spliceSelection.startMs,
        endMs: spliceSelection.endMs,
        text: spliceSelection.text,
        voiceSettings,
        preview: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(`エラー: ${err.error}`);
      return;
    }

    splicePreviewData = await res.json();
    const audio = document.getElementById("splice-audio");
    audio.src = `data:audio/mpeg;base64,${splicePreviewData.audioBase64}`;
    document.getElementById("splice-preview-player").classList.remove("hidden");
    document.getElementById("btn-splice-commit").disabled = false;
    audio.play();
  } catch (e) {
    alert(`エラー: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
});

// 部分確定
document.getElementById("btn-splice-commit")?.addEventListener("click", async () => {
  if (!splicePreviewData || !spliceSelection || !currentScene) return;
  const btn = document.getElementById("btn-splice-commit");
  btn.disabled = true;

  const voiceSettings = {
    stability: Number(document.getElementById("slider-splice-stability").value),
    similarity_boost: 0.75,
    style: Number(document.getElementById("slider-splice-style").value),
    use_speaker_boost: true,
  };

  const res = await fetch(`${API}/api/scenes/${currentScene.id}/splice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startMs: spliceSelection.startMs,
      endMs: spliceSelection.endMs,
      text: spliceSelection.text,
      voiceSettings,
      preview: false,
    }),
  });

  if (res.ok) {
    await loadScenes();
    // 波形を再読み込み
    await setupSplice();
    alert("選択範囲の音声を差し替えました");
    if (window.parent !== window) {
      window.parent.postMessage({ type: "editor-updated" }, "*");
    }
  }
  btn.disabled = true;
});

// スライダー値表示の更新
["splice-stability", "splice-style"].forEach((param) => {
  const slider = document.getElementById(`slider-${param}`);
  const val = document.getElementById(`val-${param}`);
  if (slider && val) {
    slider.addEventListener("input", () => {
      val.textContent = Number(slider.value).toFixed(2);
    });
  }
});

// ── ユーティリティ ──
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── URLハッシュでシーン直接ジャンプ ──
function handleHash() {
  const hash = location.hash;
  const match = hash.match(/^#scene\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    // シーンが読み込まれるのを待つ
    const tryOpen = () => {
      if (scenes.length > 0) {
        openDetail(id);
      } else {
        setTimeout(tryOpen, 200);
      }
    };
    tryOpen();
  }
}

window.addEventListener("hashchange", handleHash);

// ── 起動 ──
init().then(() => handleHash());
