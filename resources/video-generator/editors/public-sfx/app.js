"use strict";

// ───────── 定数 ─────────
const FADE_OUT_SEC = 0.3;

// ───────── 状態 ─────────
const state = {
  scenes: [],
  selectedSceneId: null,
  currentScene: null,
  partFilter: "all",

  // シーン音声の波形/再生
  sceneWS: null,
  sceneRegions: null,
  selectedRangeRegion: null,  // 選択範囲（無音化区間）

  // 効果音の波形/再生
  sfxWS: null,
  sfxRegions: null,
  sfxUsageRegion: null,       // 使用区間
  sfxFiles: [],
  selectedSfxPath: "",        // "sfx/xxx.mp3" 相対パス
  sfxDurationSec: 0,

  fadeOut: false,
  mixSources: [],              // 再生中のAudioBufferSourceNode配列
  mixCtx: null,
};

// 編集中SFX設定（保存対象）
function getSfxConfig() {
  if (!state.selectedRangeRegion || !state.sfxUsageRegion || !state.selectedSfxPath) return null;
  const insertAtSec = state.selectedRangeRegion.start;
  const muteDurationSec = state.selectedRangeRegion.end - state.selectedRangeRegion.start;
  const sfxStartSec = state.sfxUsageRegion.start;
  const sfxEndSec = state.sfxUsageRegion.end;
  return {
    file: state.selectedSfxPath,
    insertAtSec,
    muteDurationSec,
    sfxStartSec,
    sfxEndSec,
    fadeOut: state.fadeOut,
  };
}

// ───────── DOM ─────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ───────── 初期化 ─────────
async function init() {
  // パートフィルタ
  $$(".part-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".part-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.partFilter = btn.dataset.part;
      renderSceneList();
    });
  });

  await loadScenes();
  await loadSfxFiles();

  // ハッシュからシーン指定
  const match = location.hash.match(/^#scene\/(\d+)$/);
  if (match) {
    const id = parseInt(match[1], 10);
    if (state.scenes.find((s) => s.id === id)) {
      selectScene(id);
    }
  }

  // イベント
  $("#sfx-upload").addEventListener("change", onUploadSfx);
  $("#sfx-existing").addEventListener("change", onSelectExisting);
  $("#fade-out").addEventListener("change", (e) => { state.fadeOut = e.target.checked; });
  $("#play-scene").addEventListener("click", () => state.sceneWS?.play());
  $("#restart-scene").addEventListener("click", () => {
    if (!state.sceneWS) return;
    state.sceneWS.setTime(0);
    state.sceneWS.play();
  });
  $("#pause-scene").addEventListener("click", () => state.sceneWS?.pause());
  $("#play-sfx").addEventListener("click", () => state.sfxWS?.play());
  $("#restart-sfx").addEventListener("click", () => {
    if (!state.sfxWS) return;
    state.sfxWS.setTime(0);
    state.sfxWS.play();
  });
  $("#pause-sfx").addEventListener("click", () => state.sfxWS?.pause());
  $("#preview-mix").addEventListener("click", playMix);
  $("#pause-mix").addEventListener("click", stopMix);
  $("#save-sfx").addEventListener("click", saveSfx);
  $("#remove-sfx").addEventListener("click", removeSfx);
}

// ───────── API ─────────
async function loadScenes() {
  const r = await fetch("/api/scenes");
  state.scenes = await r.json();
  renderSceneList();
}

async function loadSceneDetail(id) {
  const r = await fetch(`/api/scenes/${id}`);
  state.currentScene = await r.json();
}

async function loadSfxFiles() {
  const r = await fetch("/api/sfx-files");
  state.sfxFiles = await r.json();
  renderSfxDropdown();
}

async function uploadSfx(file) {
  const r = await fetch("/api/upload-sfx", {
    method: "POST",
    headers: {
      "X-Filename": encodeURIComponent(file.name),
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!r.ok) throw new Error("Upload failed");
  return r.json();
}

async function saveSceneSfx(id, soundEffects) {
  const r = await fetch(`/api/scenes/${id}/sfx`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ soundEffects }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || "Save failed");
  }
  return r.json();
}

// ───────── サイドバー描画 ─────────
function renderSceneList() {
  const ul = $("#scenes-ul");
  ul.innerHTML = "";
  const filtered = state.partFilter === "all"
    ? state.scenes
    : state.scenes.filter((s) => s.part === state.partFilter);
  for (const s of filtered) {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    if (state.selectedSceneId === s.id) li.classList.add("selected");
    const snippet = (s.text || "").replace(/\n/g, " ").slice(0, 40);
    li.innerHTML = `
      <span class="scene-id">#${String(s.id).padStart(3, "0")}</span>
      <span class="scene-part">${escapeHtml(s.part)}</span>
      <span class="scene-snippet">${escapeHtml(snippet)}</span>
      ${s.sfxCount > 0 ? `<span class="sfx-badge">SFX${s.sfxCount}</span>` : ""}
    `;
    li.addEventListener("click", () => selectScene(s.id));
    ul.appendChild(li);
  }
}

function renderSfxDropdown() {
  const sel = $("#sfx-existing");
  sel.innerHTML = `<option value="">— 既存ファイルから選択 —</option>`;
  for (const f of state.sfxFiles) {
    const opt = document.createElement("option");
    opt.value = f.path;
    opt.textContent = f.name;
    sel.appendChild(opt);
  }
}

// ───────── シーン選択 ─────────
async function selectScene(id) {
  state.selectedSceneId = id;
  location.hash = `#scene/${id}`;
  renderSceneList();
  stopMix();

  // 既存波形の破棄
  if (state.sceneWS) { state.sceneWS.destroy(); state.sceneWS = null; }
  if (state.sfxWS) { state.sfxWS.destroy(); state.sfxWS = null; }
  state.selectedRangeRegion = null;
  state.sfxUsageRegion = null;
  state.selectedSfxPath = "";
  state.fadeOut = false;
  $("#fade-out").checked = false;
  $("#sfx-existing").value = "";
  $("#sfx-name").textContent = "";
  $("#sfx-block").style.display = "none";
  $("#action-block").style.display = "none";
  $("#save-status").textContent = "";
  $("#save-status").className = "status-text";

  await loadSceneDetail(id);

  $("#placeholder").style.display = "none";
  $("#editor-body").style.display = "block";
  $("#detail-id").textContent = `#${String(state.currentScene.id).padStart(3, "0")}`;
  $("#detail-part").textContent = state.currentScene.part;
  $("#detail-text").textContent = state.currentScene.text;

  // シーン波形を描画
  await renderSceneWave();
  renderTelopMarkers();

  // 既存の効果音がある場合は復元
  if (state.currentScene.soundEffects && state.currentScene.soundEffects.length > 0) {
    const sfx = state.currentScene.soundEffects[0];
    await restoreExistingSfx(sfx);
  }
}

// ───────── シーン波形 ─────────
async function renderSceneWave() {
  const audioUrl = `/audio/${baseName(state.currentScene.audio)}`;
  const regions = WaveSurfer.Regions.create();
  const ws = WaveSurfer.create({
    container: "#scene-wave",
    waveColor: "#5a8acb",
    progressColor: "#89c2d9",
    cursorColor: "#fff",
    height: 96,
    barWidth: 2,
    barRadius: 1,
    barGap: 1,
    url: audioUrl,
    plugins: [regions],
  });
  state.sceneWS = ws;
  state.sceneRegions = regions;

  await new Promise((resolve) => ws.on("ready", resolve));

  // ドラッグで範囲選択を有効化
  regions.enableDragSelection({
    color: "rgba(217,201,137,0.25)",
  });

  regions.on("region-created", (region) => {
    // 同時に1つだけ保持
    if (state.selectedRangeRegion && state.selectedRangeRegion !== region) {
      state.selectedRangeRegion.remove();
    }
    state.selectedRangeRegion = region;
    region.element.style.borderLeft = "2px solid #d9c989";
    region.element.style.borderRight = "2px solid #d9c989";
    onSceneRangeChanged();
  });
  regions.on("region-updated", (region) => {
    if (region === state.selectedRangeRegion) onSceneRangeChanged();
  });
  regions.on("region-removed", (region) => {
    if (region === state.selectedRangeRegion) {
      state.selectedRangeRegion = null;
      onSceneRangeChanged();
    }
  });
}

function renderTelopMarkers() {
  const el = $("#telop-overlay");
  const times = state.currentScene.pageSwitchTimes;
  if (!times || times.length === 0) {
    el.innerHTML = `<span>テロップ切替なし（全体1ページ）</span>`;
    return;
  }
  el.innerHTML = "";
  let prev = 0;
  for (let i = 0; i < times.length; i++) {
    const span = document.createElement("span");
    span.textContent = `P${i + 1}: ${prev.toFixed(2)}s〜${times[i].toFixed(2)}s`;
    el.appendChild(span);
    prev = times[i];
  }
  const last = document.createElement("span");
  last.textContent = `P${times.length + 1}: ${prev.toFixed(2)}s〜${state.currentScene.durationSec.toFixed(2)}s`;
  el.appendChild(last);
}

function onSceneRangeChanged() {
  if (!state.selectedRangeRegion) {
    $("#scene-range-info").textContent = "範囲未選択";
    $("#sfx-block").style.display = "none";
    $("#action-block").style.display = "none";
    return;
  }
  const r = state.selectedRangeRegion;
  $("#scene-range-info").textContent =
    `範囲: ${r.start.toFixed(3)}s 〜 ${r.end.toFixed(3)}s （差し替え長 ${(r.end - r.start).toFixed(3)}s）`;
  // 効果音が既に選択済みなら使用区間を再計算
  if (state.selectedSfxPath && state.sfxWS && state.sfxDurationSec > 0) {
    autoFitSfxUsage();
  }
}

// ───────── 効果音アップロード/選択 ─────────
async function onUploadSfx(e) {
  const file = e.target.files[0];
  if (!file) return;
  $("#sfx-name").textContent = `アップロード中…`;
  try {
    const result = await uploadSfx(file);
    await loadSfxFiles();
    $("#sfx-existing").value = result.path;
    await selectSfxFile(result.path);
  } catch (err) {
    $("#sfx-name").textContent = `アップロード失敗: ${err.message}`;
  } finally {
    e.target.value = "";
  }
}

async function onSelectExisting(e) {
  const path = e.target.value;
  if (!path) return;
  await selectSfxFile(path);
}

async function selectSfxFile(sfxPath) {
  state.selectedSfxPath = sfxPath;
  $("#sfx-name").textContent = sfxPath.replace(/^sfx\//, "");
  $("#sfx-block").style.display = "block";
  $("#action-block").style.display = "block";

  if (state.sfxWS) { state.sfxWS.destroy(); state.sfxWS = null; }

  const regions = WaveSurfer.Regions.create();
  const ws = WaveSurfer.create({
    container: "#sfx-wave",
    waveColor: "#c2a25a",
    progressColor: "#d9c989",
    cursorColor: "#fff",
    height: 96,
    barWidth: 2,
    barRadius: 1,
    barGap: 1,
    url: `/${sfxPath}`,
    plugins: [regions],
  });
  state.sfxWS = ws;
  state.sfxRegions = regions;

  await new Promise((resolve) => ws.on("ready", resolve));
  state.sfxDurationSec = ws.getDuration();
  autoFitSfxUsage();

  regions.on("region-updated", (region) => {
    if (region === state.sfxUsageRegion) onSfxUsageChanged();
  });
}

// シーン範囲長に合わせて効果音の使用区間を自動設定
// - 効果音 ≧ 範囲長 → 効果音先頭から「範囲長」分を使用
// - 効果音 < 範囲長 → 効果音全体を使用＋シーン範囲を効果音長に自動短縮
function autoFitSfxUsage() {
  if (!state.selectedRangeRegion || !state.sfxWS) return;
  const rangeLen = state.selectedRangeRegion.end - state.selectedRangeRegion.start;
  const sfxLen = state.sfxDurationSec;

  let usageStart, usageEnd, newMuteLen;
  if (sfxLen >= rangeLen) {
    usageStart = 0;
    usageEnd = rangeLen;
    newMuteLen = rangeLen;
  } else {
    usageStart = 0;
    usageEnd = sfxLen;
    newMuteLen = sfxLen;
    // シーン範囲を自動短縮
    const r = state.selectedRangeRegion;
    state.selectedRangeRegion.setOptions({
      start: r.start,
      end: r.start + sfxLen,
    });
  }

  // 既存リージョン削除→再作成（ドラッグハンドルで位置変更可）
  if (state.sfxUsageRegion) {
    state.sfxUsageRegion.remove();
  }
  state.sfxUsageRegion = state.sfxRegions.addRegion({
    start: usageStart,
    end: usageEnd,
    color: "rgba(217,201,137,0.3)",
    drag: true,
    resize: false,    // サイズはmuteと連動するのでリサイズ不可
  });
  state.sfxUsageRegion.element.style.borderLeft = "2px solid #d9c989";
  state.sfxUsageRegion.element.style.borderRight = "2px solid #d9c989";

  onSfxUsageChanged();
}

function onSfxUsageChanged() {
  if (!state.sfxUsageRegion) return;
  // 効果音側のドラッグでstartが変わったらendも同じ幅を維持（clamp）
  const r = state.sfxUsageRegion;
  const desiredLen = r.end - r.start;
  // 範囲外にはみ出さないようclamp
  let s = Math.max(0, r.start);
  let e = s + desiredLen;
  if (e > state.sfxDurationSec) {
    e = state.sfxDurationSec;
    s = Math.max(0, e - desiredLen);
  }
  if (s !== r.start || e !== r.end) {
    r.setOptions({ start: s, end: e });
  }
  $("#sfx-range-info").textContent =
    `効果音長: ${state.sfxDurationSec.toFixed(3)}s / 使用区間: ${s.toFixed(3)}s 〜 ${e.toFixed(3)}s （${(e - s).toFixed(3)}s）`;
}

// 既存効果音設定の復元
async function restoreExistingSfx(sfx) {
  // シーン範囲を復元
  state.selectedRangeRegion = state.sceneRegions.addRegion({
    start: sfx.insertAtSec,
    end: sfx.insertAtSec + sfx.muteDurationSec,
    color: "rgba(217,201,137,0.25)",
    drag: true,
    resize: true,
  });
  state.selectedRangeRegion.element.style.borderLeft = "2px solid #d9c989";
  state.selectedRangeRegion.element.style.borderRight = "2px solid #d9c989";
  onSceneRangeChanged();

  // 効果音波形を読み込み
  state.fadeOut = !!sfx.fadeOut;
  $("#fade-out").checked = state.fadeOut;
  $("#sfx-existing").value = sfx.file;

  state.selectedSfxPath = sfx.file;
  $("#sfx-name").textContent = sfx.file.replace(/^sfx\//, "");
  $("#sfx-block").style.display = "block";
  $("#action-block").style.display = "block";

  if (state.sfxWS) { state.sfxWS.destroy(); state.sfxWS = null; }
  const regions = WaveSurfer.Regions.create();
  const ws = WaveSurfer.create({
    container: "#sfx-wave",
    waveColor: "#c2a25a",
    progressColor: "#d9c989",
    cursorColor: "#fff",
    height: 96,
    barWidth: 2,
    barRadius: 1,
    barGap: 1,
    url: `/${sfx.file}`,
    plugins: [regions],
  });
  state.sfxWS = ws;
  state.sfxRegions = regions;
  await new Promise((resolve) => ws.on("ready", resolve));
  state.sfxDurationSec = ws.getDuration();

  state.sfxUsageRegion = state.sfxRegions.addRegion({
    start: sfx.sfxStartSec,
    end: sfx.sfxEndSec,
    color: "rgba(217,201,137,0.3)",
    drag: true,
    resize: false,
  });
  state.sfxUsageRegion.element.style.borderLeft = "2px solid #d9c989";
  state.sfxUsageRegion.element.style.borderRight = "2px solid #d9c989";

  regions.on("region-updated", (region) => {
    if (region === state.sfxUsageRegion) onSfxUsageChanged();
  });
  onSfxUsageChanged();
}

// ───────── ミックス再生 ─────────
async function playMix() {
  stopMix();
  const cfg = getSfxConfig();
  if (!cfg) {
    setStatus("範囲と効果音を設定してください", "error");
    return;
  }
  try {
    const ctx = new AudioContext();
    state.mixCtx = ctx;

    const sceneBuf = await fetchAudioBuffer(`/audio/${baseName(state.currentScene.audio)}`, ctx);
    const sfxBuf = await fetchAudioBuffer(`/${cfg.file}`, ctx);

    const now = ctx.currentTime;

    // シーン音声（ミュート区間はゲイン0）
    const sceneSrc = ctx.createBufferSource();
    sceneSrc.buffer = sceneBuf;
    const sceneGain = ctx.createGain();
    sceneGain.gain.setValueAtTime(1, now);
    sceneGain.gain.setValueAtTime(1, now + cfg.insertAtSec);
    sceneGain.gain.linearRampToValueAtTime(0, now + cfg.insertAtSec + 0.005);
    sceneGain.gain.setValueAtTime(0, now + cfg.insertAtSec + cfg.muteDurationSec - 0.005);
    sceneGain.gain.linearRampToValueAtTime(1, now + cfg.insertAtSec + cfg.muteDurationSec);
    sceneSrc.connect(sceneGain).connect(ctx.destination);

    // 効果音
    const sfxSrc = ctx.createBufferSource();
    sfxSrc.buffer = sfxBuf;
    const sfxGain = ctx.createGain();
    const playLen = cfg.sfxEndSec - cfg.sfxStartSec;
    const sfxStartAbs = now + cfg.insertAtSec;
    sfxGain.gain.setValueAtTime(1, sfxStartAbs);
    if (cfg.fadeOut) {
      const fadeBegin = sfxStartAbs + Math.max(0, playLen - FADE_OUT_SEC);
      sfxGain.gain.setValueAtTime(1, fadeBegin);
      sfxGain.gain.linearRampToValueAtTime(0, sfxStartAbs + playLen);
    }
    sfxSrc.connect(sfxGain).connect(ctx.destination);

    sceneSrc.start(now);
    sfxSrc.start(sfxStartAbs, cfg.sfxStartSec, playLen);

    state.mixSources = [sceneSrc, sfxSrc];
    setStatus("ミックス再生中…", "");
    sceneSrc.onended = () => {
      if (state.mixCtx === ctx) setStatus("再生終了", "");
    };
  } catch (err) {
    setStatus(`再生失敗: ${err.message}`, "error");
  }
}

function stopMix() {
  for (const src of state.mixSources) {
    try { src.stop(); } catch {}
  }
  state.mixSources = [];
  if (state.mixCtx) {
    try { state.mixCtx.close(); } catch {}
    state.mixCtx = null;
  }
}

async function fetchAudioBuffer(url, ctx) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed: ${url}`);
  const buf = await r.arrayBuffer();
  return ctx.decodeAudioData(buf);
}

// ───────── 保存 ─────────
async function saveSfx() {
  const cfg = getSfxConfig();
  if (!cfg) {
    setStatus("範囲と効果音を設定してください", "error");
    return;
  }
  try {
    await saveSceneSfx(state.selectedSceneId, [cfg]);
    setStatus("保存しました（Remotion Studioで反映されます）", "success");
    // サイドバーのバッジ更新
    const s = state.scenes.find((x) => x.id === state.selectedSceneId);
    if (s) s.sfxCount = 1;
    renderSceneList();
  } catch (err) {
    setStatus(`保存失敗: ${err.message}`, "error");
  }
}

async function removeSfx() {
  if (!confirm("この効果音を削除しますか？")) return;
  try {
    await saveSceneSfx(state.selectedSceneId, []);
    setStatus("削除しました", "success");
    const s = state.scenes.find((x) => x.id === state.selectedSceneId);
    if (s) s.sfxCount = 0;
    renderSceneList();
    // リセット
    if (state.selectedRangeRegion) { state.selectedRangeRegion.remove(); state.selectedRangeRegion = null; }
    if (state.sfxUsageRegion) { state.sfxUsageRegion.remove(); state.sfxUsageRegion = null; }
    if (state.sfxWS) { state.sfxWS.destroy(); state.sfxWS = null; }
    state.selectedSfxPath = "";
    $("#sfx-existing").value = "";
    $("#sfx-name").textContent = "";
    $("#sfx-block").style.display = "none";
    $("#action-block").style.display = "none";
  } catch (err) {
    setStatus(`削除失敗: ${err.message}`, "error");
  }
}

// ───────── ヘルパ ─────────
function setStatus(text, cls) {
  const el = $("#save-status");
  el.textContent = text;
  el.className = "status-text" + (cls ? " " + cls : "");
}

function baseName(p) {
  return p.split(/[\\/]/).pop();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 起動
init();
