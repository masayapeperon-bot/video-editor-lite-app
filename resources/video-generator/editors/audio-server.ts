/**
 * 音声レビュー＆修正エディタ — バックエンドサーバー
 *
 * Usage:
 *   npx tsx server.ts --project <作品フォルダパス>
 *
 * ブラウザで http://localhost:3456 にアクセス
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { trashBeforeOverwrite } from "./trash-helper";

// ── ffmpeg / ffprobe パス解決（Windows で PATH が通っていない場合の自動検出） ──
function findFfmpegBin(): { ffmpeg: string; ffprobe: string } {
  // 環境変数で明示指定されていれば最優先（Electron経由のケース）
  // パスに空白が含まれる可能性があるためダブルクォートで囲む（execSync のシェル展開対策）
  if (process.env.FFMPEG_BIN && process.env.FFPROBE_BIN) {
    return {
      ffmpeg: `"${process.env.FFMPEG_BIN}"`,
      ffprobe: `"${process.env.FFPROBE_BIN}"`,
    };
  }

  // デフォルト（PATHが通っている場合）
  let ffmpeg = "ffmpeg";
  let ffprobe = "ffprobe";

  // PATH で見つかるか確認
  try {
    execSync(`${ffprobe} -version`, { stdio: "ignore" });
    return { ffmpeg, ffprobe };
  } catch {
    // 見つからない → Windows の一般的なインストール先を探索
  }

  if (process.platform === "win32") {
    const searchDirs = [
      // winget install 先
      path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages"),
      // 手動インストール先
      "C:\\ffmpeg",
      "C:\\Program Files\\ffmpeg",
      "C:\\Program Files (x86)\\ffmpeg",
      path.join(os.homedir(), "ffmpeg"),
      path.join(os.homedir(), "Downloads", "ffmpeg"),
    ];

    // fs で再帰的に ffprobe.exe を探す
    function findExeRecursive(dir: string, name: string, depth: number): string | null {
      if (depth < 0) return null;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isFile() && e.name.toLowerCase() === name) return full;
          if (e.isDirectory() && depth > 0) {
            const found = findExeRecursive(full, name, depth - 1);
            if (found) return found;
          }
        }
      } catch { /* アクセス拒否など */ }
      return null;
    }

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const found = findExeRecursive(dir, "ffprobe.exe", 5);
      if (found) {
        const binDir = path.dirname(found);
        ffprobe = path.join(binDir, "ffprobe.exe");
        ffmpeg = path.join(binDir, "ffmpeg.exe");
        if (fs.existsSync(ffprobe) && fs.existsSync(ffmpeg)) {
          console.log(`✓ ffmpeg を検出: ${binDir}`);
          return { ffmpeg: `"${ffmpeg}"`, ffprobe: `"${ffprobe}"` };
        }
      }
    }

    console.error("⚠ ffmpeg/ffprobe が見つかりません。音声編集機能が制限されます。");
    console.error("  インストール: winget install Gyan.FFmpeg");
    console.error("  インストール後、コマンドプロンプトとエディタを再起動してください。");
  }

  return { ffmpeg, ffprobe };
}

const FFMPEG_BIN = findFfmpegBin();
const FFMPEG = FFMPEG_BIN.ffmpeg;
const FFPROBE = FFMPEG_BIN.ffprobe;

// ── 引数パース ──
const args = process.argv.slice(2);
const projectIdx = args.indexOf("--project");
if (projectIdx === -1 || !args[projectIdx + 1]) {
  console.error("Usage: npx tsx server.ts --project <作品フォルダパス>");
  process.exit(1);
}
const PROJECT_DIR = path.resolve(args[projectIdx + 1]);
const AUDIO_DIR = path.join(PROJECT_DIR, "audio");
const SCENES_RAW_PATH = path.join(PROJECT_DIR, "scenes_raw.json");
const SCENES_JSON_PATH = path.join(PROJECT_DIR, "scenes.json");
const PRONUNCIATION_PATH = path.join(PROJECT_DIR, "pronunciation.json");
const REVIEW_PATH = path.join(PROJECT_DIR, "audio_review.json");
const OVERRIDES_PATH = path.join(PROJECT_DIR, "audio_overrides.json");
const EDIT_LOG_PATH = path.join(PROJECT_DIR, "edit_log.json");

/** 編集ログを追記 */
function appendEditLog(entry: { scene?: number; type: string; [key: string]: any }) {
  let log: any[] = [];
  try {
    if (fs.existsSync(EDIT_LOG_PATH)) {
      log = JSON.parse(fs.readFileSync(EDIT_LOG_PATH, "utf-8"));
    }
  } catch {}
  log.push({ timestamp: new Date().toISOString(), ...entry });
  fs.writeFileSync(EDIT_LOG_PATH, JSON.stringify(log, null, 2), "utf-8");
}

// Remotion の src/scenes.json パス
const REMOTION_SCENES_JSON = path.resolve(
  typeof __dirname !== "undefined" ? __dirname : import.meta.dirname, "..", "src", "scenes.json"
);
// Remotion の public/scenes.json パス（--public-dir 未使用時のフォールバック）
const REMOTION_PUBLIC_SCENES_JSON = path.resolve(
  typeof __dirname !== "undefined" ? __dirname : import.meta.dirname, "..", "public", "scenes.json"
);

/** コピー先がシンボリックリンクでコピー元と同じ実体を指す場合はスキップ（macOS対策） */
function safeCopyIfNeeded(src: string, dest: string): boolean {
  try {
    if (!fs.existsSync(path.dirname(dest))) return false;
    // シンボリックリンクの場合、リンク先を解決して比較
    const destStat = fs.lstatSync(dest);
    if (destStat.isSymbolicLink()) {
      const linkTarget = fs.realpathSync(dest);
      const srcReal = fs.realpathSync(src);
      if (linkTarget === srcReal) {
        // 同じファイルへのリンク → コピー不要
        return false;
      }
    }
  } catch {
    // dest が存在しない場合などはそのままコピーを試みる
  }
  try {
    fs.copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

const PORT = 3456;
const PUBLIC_DIR = path.join(typeof __dirname !== "undefined" ? __dirname : import.meta.dirname, "public-audio");

// Remotion の public/audio/ パス（commit時に自動コピー）
const REMOTION_AUDIO_DIR = path.resolve(
  typeof __dirname !== "undefined" ? __dirname : import.meta.dirname, "..", "public", "audio"
);

// ── .env 読み込み ──
const envPath = path.resolve(typeof __dirname !== "undefined" ? __dirname : import.meta.dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
}

// ── キーサーバー対応 ──
async function loadKeysFromServer(): Promise<void> {
  const serverUrl = process.env.KEY_SERVER_URL;
  const serverToken = process.env.KEY_SERVER_TOKEN;
  if (!serverUrl || !serverToken) return;
  try {
    const res = await fetch(serverUrl, {
      headers: { Authorization: `Bearer ${serverToken}` },
    });
    if (!res.ok) return;
    const keys = (await res.json()) as Record<string, string>;
    for (const [k, v] of Object.entries(keys)) {
      if (v) process.env[k] = v;
    }
  } catch {}
}

// ── ElevenLabs API ──
const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1";
const MODEL_ID = "eleven_v3";
const DEFAULT_VOICE_ID = "oAlEJuW30knHWhA6cF0e";
const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.5,
  use_speaker_boost: true,
};

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

async function generateWithTimestamps(
  text: string,
  voiceId: string,
  apiKey: string,
  voiceSettings?: Record<string, number | boolean>
): Promise<{ audioBase64: string; alignment: Alignment }> {
  // プロキシ経由 or 直接呼び出し
  const proxyUrl = process.env.PROXY_URL;
  const proxyToken = process.env.PROXY_TOKEN;
  const useProxy = !!(proxyUrl && proxyToken);
  const url = useProxy
    ? `${proxyUrl}/proxy/elevenlabs/tts/${voiceId}`
    : `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/with-timestamps`;
  const authHeaders: Record<string, string> = useProxy
    ? { "Authorization": `Bearer ${proxyToken}` }
    : { "xi-api-key": apiKey };
  const response = await fetch(
    url,
    {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: voiceSettings ?? DEFAULT_VOICE_SETTINGS,
      }),
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} ${error}`);
  }
  const json = (await response.json()) as {
    audio_base64: string;
    alignment: Alignment;
  };
  return { audioBase64: json.audio_base64, alignment: json.alignment };
}

// ── ヘルパー ──
interface RawScene {
  id: number;
  part: string;
  partSceneNumber: number;
  text: string;
}

function loadScenesRaw(): RawScene[] {
  if (!fs.existsSync(SCENES_RAW_PATH)) return [];
  return JSON.parse(fs.readFileSync(SCENES_RAW_PATH, "utf-8"));
}

function loadReview(): Record<string, { status: string; notes?: string; reviewedAt?: string }> {
  if (!fs.existsSync(REVIEW_PATH)) return {};
  return JSON.parse(fs.readFileSync(REVIEW_PATH, "utf-8"));
}

function saveReview(data: Record<string, any>) {
  fs.writeFileSync(REVIEW_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function loadPronunciation(): Record<string, string> {
  if (!fs.existsSync(PRONUNCIATION_PATH)) return {};
  return JSON.parse(fs.readFileSync(PRONUNCIATION_PATH, "utf-8"));
}

function savePronunciation(data: Record<string, string>) {
  fs.writeFileSync(PRONUNCIATION_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function loadOverrides(): Record<string, any> {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf-8"));
}

function saveOverrides(data: Record<string, any>) {
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// ── Remotion public/audio/ への自動コピー ──
function syncToRemotion(srcFile: string, filename: string) {
  try {
    if (fs.existsSync(REMOTION_AUDIO_DIR)) {
      const destFile = path.join(REMOTION_AUDIO_DIR, filename);
      fs.copyFileSync(srcFile, destFile);
      console.log(`  → Remotion同期: ${filename}`);
    }
  } catch (e: any) {
    console.warn(`  Remotion同期失敗: ${e.message}`);
  }
}

// ── 1秒超の無音カット（generate-audio.ts と同等） ──

function trimLongSilencesInPlace(inputPath: string, outputPath: string, maxSilenceMs: number): void {
  const maxSilenceSec = maxSilenceMs / 1000;
  try {
    const detectResult = execSync(
      `${FFMPEG} -i "${inputPath}" -af "silencedetect=noise=-40dB:d=${maxSilenceSec}" -f null - 2>&1`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    const silences: Array<{ start: number; end: number }> = [];
    let currentStart = -1;
    for (const line of detectResult.split("\n")) {
      const startMatch = line.match(/silence_start:\s*([\d.]+)/);
      const endMatch = line.match(/silence_end:\s*([\d.]+)/);
      if (startMatch) currentStart = parseFloat(startMatch[1]);
      if (endMatch && currentStart >= 0) {
        silences.push({ start: currentStart, end: parseFloat(endMatch[1]) });
        currentStart = -1;
      }
    }

    if (silences.length === 0) {
      fs.copyFileSync(inputPath, outputPath);
      return;
    }

    const totalDuration = parseFloat(
      execSync(`${FFPROBE} -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`, { encoding: "utf-8" }).trim()
    );

    const keepSegments: Array<{ start: number; end: number }> = [];
    let pos = 0;
    for (const s of silences) {
      if (s.end - s.start > maxSilenceSec) {
        keepSegments.push({ start: pos, end: s.start + maxSilenceSec });
        pos = s.end;
      }
    }
    keepSegments.push({ start: pos, end: totalDuration });

    if (keepSegments.length <= 1 && keepSegments[0].start === 0) {
      fs.copyFileSync(inputPath, outputPath);
      return;
    }

    const filterParts: string[] = [];
    const concatInputs: string[] = [];
    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      filterParts.push(`[0]atrim=${seg.start.toFixed(3)}:${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[s${i}]`);
      concatInputs.push(`[s${i}]`);
    }
    const filterComplex = `${filterParts.join(";")};${concatInputs.join("")}concat=n=${keepSegments.length}:v=0:a=1`;

    execSync(
      `${FFMPEG} -y -i "${inputPath}" -filter_complex "${filterComplex}" -q:a 2 "${outputPath}"`,
      { stdio: "ignore" }
    );

    const newDur = parseFloat(
      execSync(`${FFPROBE} -v error -show_entries format=duration -of csv=p=0 "${outputPath}"`, { encoding: "utf-8" }).trim()
    );
    console.log(`  無音カット: ${silences.length}箇所 (${totalDuration.toFixed(1)}s → ${newDur.toFixed(1)}s)`);
  } catch (e: any) {
    console.warn(`  無音カット失敗（スキップ）: ${e.message}`);
    if (!fs.existsSync(outputPath)) {
      fs.copyFileSync(inputPath, outputPath);
    }
  }
}

// ── scenes.json 自動更新 ──

/** 音声ファイルの長さを取得（秒） */
function getAudioDuration(audioPath: string): number {
  try {
    const result = execSync(
      `${FFPROBE} -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
      { encoding: "utf-8" }
    );
    return parseFloat(result.trim());
  } catch {
    return -1;
  }
}

/**
 * scenes.json の特定シーンの durationSec と pageSwitchTimes を更新し、
 * Remotion の src/scenes.json にもコピーする
 */
function updateScenesJson(
  sceneId: number,
  alignment?: Alignment,
  pageSwitchTimes?: number[],
  /** 間の調整: 挿入/削除した位置(秒)と変化量(秒、挿入は正、削除は負) */
  silenceEdit?: { atSec: number; deltaSec: number }
) {
  if (!fs.existsSync(SCENES_JSON_PATH)) return;

  const scenes = JSON.parse(fs.readFileSync(SCENES_JSON_PATH, "utf-8"));
  const scene = scenes.find((s: any) => s.id === sceneId);
  if (!scene) return;

  // 音声ファイルから新しいdurationを取得
  const pad = String(sceneId).padStart(3, "0");
  const audioFile = path.join(AUDIO_DIR, `scene_${pad}.mp3`);
  const oldDurationSec = scene.durationSec || 0;
  if (fs.existsSync(audioFile)) {
    const duration = getAudioDuration(audioFile);
    if (duration > 0) {
      scene.durationSec = Math.max(duration + 0.5, 2);
    }
  }

  // pageSwitchTimes を更新
  if (pageSwitchTimes && pageSwitchTimes.length > 0) {
    // 明示的に提供された場合はそのまま使う
    scene.pageSwitchTimes = pageSwitchTimes;
  } else if (silenceEdit && Array.isArray(scene.pageSwitchTimes)) {
    // 間の調整: 挿入/削除位置以降のpageSwitchTimesをオフセット
    scene.pageSwitchTimes = scene.pageSwitchTimes.map((t: number) => {
      if (t > silenceEdit.atSec) {
        return Math.max(0, Math.round((t + silenceEdit.deltaSec) * 1000) / 1000);
      }
      return t;
    });
    console.log(`  → pageSwitchTimes オフセット調整: delta=${silenceEdit.deltaSec}s at ${silenceEdit.atSec}s`);
  } else if (alignment) {
    // タイミングファイルから読み込み
    const timingPath = path.join(AUDIO_DIR, `scene_${pad}_timing.json`);
    if (fs.existsSync(timingPath)) {
      try {
        const timing = JSON.parse(fs.readFileSync(timingPath, "utf-8"));
        if (Array.isArray(timing.pageSwitchTimes)) {
          scene.pageSwitchTimes = timing.pageSwitchTimes;
        }
      } catch {}
    }
  }

  // durationSecが変わった場合、pageSwitchTimesを比率で自動調整
  if (
    oldDurationSec > 0 &&
    scene.durationSec > 0 &&
    Math.abs(oldDurationSec - scene.durationSec) > 0.05 &&
    Array.isArray(scene.pageSwitchTimes) &&
    scene.pageSwitchTimes.length > 0 &&
    !pageSwitchTimes &&
    !silenceEdit
  ) {
    const ratio = scene.durationSec / oldDurationSec;
    scene.pageSwitchTimes = scene.pageSwitchTimes.map((t: number) =>
      Math.round(t * ratio * 1000) / 1000
    );
    console.log(`  → pageSwitchTimes 比率自動調整: ratio=${ratio.toFixed(3)} (${oldDurationSec.toFixed(2)}s → ${scene.durationSec.toFixed(2)}s)`);
  }

  // scenes.json を保存
  fs.writeFileSync(SCENES_JSON_PATH, JSON.stringify(scenes, null, 2), "utf-8");
  console.log(`  → scenes.json 更新: シーン${sceneId} durationSec=${scene.durationSec}`);

  // Remotion の scenes.json にも同期（シンボリックリンクの場合はスキップ）
  try {
    if (safeCopyIfNeeded(SCENES_JSON_PATH, REMOTION_SCENES_JSON)) {
      console.log(`  → Remotion scenes.json 同期`);
    }
    safeCopyIfNeeded(SCENES_JSON_PATH, REMOTION_PUBLIC_SCENES_JSON);
    const tmpScenesJson = "/tmp/remotion-workspace/src/scenes.json";
    if (safeCopyIfNeeded(SCENES_JSON_PATH, tmpScenesJson)) {
      console.log(`  → Remotion workspace scenes.json 同期`);
    }
  } catch (e: any) {
    console.warn(`  Remotion scenes.json同期失敗: ${e.message}`);
  }
}

// ── テロップ自動分割（Telop.tsx と同一ロジック） ──
const TELOP_MAX = 24;
const TELOP_MAX_LINES = 3;
const TELOP_PAGE_MAX = TELOP_MAX * TELOP_MAX_LINES;

function telopSplitSentences(text: string): string[] {
  const result: string[] = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if (text[i] === "「") depth++;
    if (text[i] === "」") depth--;
    const isEnd = (text[i] === "」" && depth === 0) || ("。！？".includes(text[i]) && depth === 0);
    const isUnmatchedEnd = "。！？".includes(text[i]) && depth > 0 && i < text.length - 1 && text[i + 1] === "「";
    if ((isEnd || isUnmatchedEnd) && i < text.length - 1) {
      if (isUnmatchedEnd) depth = 0;
      result.push(buf); buf = "";
    }
  }
  if (buf) result.push(buf);
  return result;
}

function telopSplitScore(text: string, pos: number, idealPos: number): number {
  const prev = text[pos - 1];
  let priority = 10;
  if (prev === "」") priority = 1;
  else if (text[pos] === "「") priority = 2;
  else if ("。！？".includes(prev)) priority = 3;
  else if (prev === "、") priority = 4;
  return priority * 100 + Math.abs(pos - idealPos);
}

function telopSplitPageLines(text: string): string[] {
  if (text.length <= TELOP_MAX) return [text];
  if (text.length > TELOP_MAX * TELOP_MAX_LINES) {
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += TELOP_MAX) lines.push(text.slice(i, i + TELOP_MAX));
    return lines;
  }
  if (text.length <= TELOP_MAX * 2) {
    const minPos = text.length - TELOP_MAX, maxPos = TELOP_MAX;
    const mid = Math.floor(text.length / 2);
    let bestPos = mid, bestScore = Infinity;
    for (let i = Math.max(1, minPos); i <= Math.min(text.length - 1, maxPos); i++) {
      const s = telopSplitScore(text, i, mid);
      if (s < bestScore) { bestScore = s; bestPos = i; }
    }
    return [text.slice(0, bestPos), text.slice(bestPos)];
  }
  const minFirst = Math.max(1, text.length - TELOP_MAX * 2);
  const maxFirst = TELOP_MAX;
  const target = Math.floor(text.length / 3);
  let bestPos = Math.max(minFirst, Math.min(target, maxFirst)), bestScore = Infinity;
  for (let i = minFirst; i <= Math.min(text.length - 1, maxFirst); i++) {
    const s = telopSplitScore(text, i, target);
    if (s < bestScore) { bestScore = s; bestPos = i; }
  }
  return [text.slice(0, bestPos), ...telopSplitPageLines(text.slice(bestPos))];
}

function autoSplitPages(text: string): string[][] {
  const flat = text.replace(/\n/g, "");
  if (flat.length <= TELOP_MAX) return [[flat]];
  const sentences = telopSplitSentences(flat);
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (s.length > TELOP_PAGE_MAX) {
      if (current) { chunks.push(current); current = ""; }
      let part = "";
      for (let i = 0; i < s.length; i++) {
        part += s[i];
        if (s[i] === "、" && part.length >= TELOP_MAX && i < s.length - 1) {
          if (current && current.length + part.length <= TELOP_PAGE_MAX) current += part;
          else { if (current) chunks.push(current); current = part; }
          part = "";
        }
      }
      if (part) {
        if (current && current.length + part.length <= TELOP_PAGE_MAX) current += part;
        else { if (current) chunks.push(current); current = part; }
      }
    } else if (current.length + s.length <= TELOP_PAGE_MAX) {
      current += s;
    } else {
      if (current) chunks.push(current);
      current = s;
    }
  }
  if (current) chunks.push(current);
  return chunks.map(c => telopSplitPageLines(c));
}

// ── 発音置換（generate-audio.ts から移植・簡略版） ──
function applyPronunciation(
  text: string,
  pronunciationMap: Record<string, string>
): string {
  const allRules = Object.entries(pronunciationMap).sort(
    (a, b) => b[0].length - a[0].length
  );

  let current = text;

  // 記号置換
  current = current.replace(/[「『』\n]+/g, "");
  current = current.replace(/[」]+/g, "。");
  current = current.replace(/[…―─—–\-]+/g, "、");

  // 連続句読点の整理
  current = current.replace(/[、。]{2,}/g, (m) => m[0]);
  current = current.replace(/、$/g, "");
  if (!/[。！？]$/.test(current)) current += "。";

  // 発音ルール適用
  for (const [from, to] of allRules) {
    current = current.split(from).join(to);
  }

  return current;
}

// ── MIME タイプ ──
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".png": "image/png",
};

// ── HTTP サーバー ──
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function sendJson(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, message: string, status = 400) {
  sendJson(res, { error: message }, status);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const method = req.method || "GET";
  const pathname = decodeURIComponent(url.pathname);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ── API ルーティング ──

    // GET /api/scenes — シーン一覧
    if (pathname === "/api/scenes" && method === "GET") {
      const scenes = loadScenesRaw();
      const review = loadReview();
      const result = scenes.map((s) => {
        const pad = String(s.id).padStart(3, "0");
        const audioFile = path.join(AUDIO_DIR, `scene_${pad}.mp3`);
        const hasAudio = fs.existsSync(audioFile);
        return {
          id: s.id,
          part: s.part,
          partSceneNumber: s.partSceneNumber,
          text: s.text,
          hasAudio,
          status: review[String(s.id)]?.status || "unreviewed",
          notes: review[String(s.id)]?.notes || "",
        };
      });
      sendJson(res, result);
      return;
    }

    // GET /api/scenes/:id/audio — 音声ファイル配信
    const audioMatch = pathname.match(/^\/api\/scenes\/(\d+)\/audio$/);
    if (audioMatch && method === "GET") {
      const id = audioMatch[1];
      const pad = String(Number(id)).padStart(3, "0");
      const audioFile = path.join(AUDIO_DIR, `scene_${pad}.mp3`);
      if (!fs.existsSync(audioFile)) {
        sendError(res, "Audio file not found", 404);
        return;
      }
      const stat = fs.statSync(audioFile);
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": stat.size,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(audioFile).pipe(res);
      return;
    }

    // GET /api/scenes/:id — シーン詳細
    const sceneDetailMatch = pathname.match(/^\/api\/scenes\/(\d+)$/);
    if (sceneDetailMatch && method === "GET") {
      const id = Number(sceneDetailMatch[1]);
      const scenes = loadScenesRaw();
      const scene = scenes.find((s) => s.id === id);
      if (!scene) {
        sendError(res, "Scene not found", 404);
        return;
      }
      const pron = loadPronunciation();
      const ttsText = applyPronunciation(scene.text, pron);
      const overrides = loadOverrides();
      const review = loadReview();
      const pad = String(id).padStart(3, "0");
      const hasAudio = fs.existsSync(path.join(AUDIO_DIR, `scene_${pad}.mp3`));
      sendJson(res, {
        ...scene,
        ttsText,
        hasAudio,
        pronunciation: pron,
        overrides: overrides[String(id)] || null,
        status: review[String(id)]?.status || "unreviewed",
        notes: review[String(id)]?.notes || "",
      });
      return;
    }

    // POST /api/scenes/:id/status — ステータス更新
    const statusMatch = pathname.match(/^\/api\/scenes\/(\d+)\/status$/);
    if (statusMatch && method === "POST") {
      const id = statusMatch[1];
      const body = await parseBody(req);
      const review = loadReview();
      review[id] = {
        status: body.status || "unreviewed",
        notes: body.notes || "",
        reviewedAt: new Date().toISOString(),
      };
      saveReview(review);
      sendJson(res, { ok: true });
      return;
    }

    // GET /api/pronunciation — 発音辞書取得
    if (pathname === "/api/pronunciation" && method === "GET") {
      sendJson(res, loadPronunciation());
      return;
    }

    // POST /api/pronunciation — 発音辞書更新
    if (pathname === "/api/pronunciation" && method === "POST") {
      const body = await parseBody(req);
      const pron = loadPronunciation();
      if (body.key && body.value) {
        pron[body.key] = body.value;
      }
      if (body.entries && typeof body.entries === "object") {
        Object.assign(pron, body.entries);
      }
      savePronunciation(pron);
      // 編集ログ
      if (body.key && body.value) {
        appendEditLog({ type: "pronunciation_add", key: body.key, value: body.value });
      }
      if (body.entries) {
        appendEditLog({ type: "pronunciation_add", entries: body.entries });
      }
      sendJson(res, pron);
      return;
    }

    // DELETE /api/pronunciation/:key — 発音辞書のエントリ削除
    const pronDeleteMatch = pathname.match(/^\/api\/pronunciation\/(.+)$/);
    if (pronDeleteMatch && method === "DELETE") {
      const key = pronDeleteMatch[1];
      const pron = loadPronunciation();
      delete pron[key];
      savePronunciation(pron);
      appendEditLog({ type: "pronunciation_delete", key });
      sendJson(res, pron);
      return;
    }

    // POST /api/scenes/:id/regenerate — 音声再生成（プレビュー）
    const regenMatch = pathname.match(/^\/api\/scenes\/(\d+)\/regenerate$/);
    if (regenMatch && method === "POST") {
      const id = Number(regenMatch[1]);
      const scenes = loadScenesRaw();
      const scene = scenes.find((s) => s.id === id);
      if (!scene) {
        sendError(res, "Scene not found", 404);
        return;
      }
      const apiKey = process.env.ELEVENLABS_API_KEY;
      const useProxy = !!(process.env.PROXY_URL && process.env.PROXY_TOKEN);
      if (!useProxy && !apiKey) {
        sendError(res, "ELEVENLABS_API_KEY not set", 500);
        return;
      }
      const body = await parseBody(req);
      const pron = loadPronunciation();
      const text = body.textOverride || applyPronunciation(scene.text, pron);
      const voiceSettings = body.voiceSettings || DEFAULT_VOICE_SETTINGS;
      const voiceId = body.voiceId || DEFAULT_VOICE_ID;

      const { audioBase64, alignment } = await generateWithTimestamps(
        text,
        voiceId,
        apiKey,
        voiceSettings
      );

      // ffmpeg でフェードアウト処理
      const tmpRaw = path.join(os.tmpdir(), `editor_raw_${id}.mp3`);
      const tmpOut = path.join(os.tmpdir(), `editor_out_${id}.mp3`);
      fs.writeFileSync(tmpRaw, Buffer.from(audioBase64, "base64"));

      try {
        const duration = parseFloat(
          execSync(
            `${FFPROBE} -v error -show_entries format=duration -of csv=p=0 "${tmpRaw}"`,
            { encoding: "utf-8" }
          ).trim()
        );
        const tmpFaded = path.join(os.tmpdir(), `editor_faded_${id}.mp3`);
        execSync(
          `${FFMPEG} -y -i "${tmpRaw}" -af "apad=pad_dur=0.3,afade=t=out:st=${(duration + 0.25).toFixed(3)}:d=0.05" -q:a 2 "${tmpFaded}"`,
          { stdio: "ignore" }
        );
        // 1秒を超える無音をカット（generate-audio.ts と同じ処理）
        trimLongSilencesInPlace(tmpFaded, tmpOut, 1000);
        const processedAudio = fs.readFileSync(tmpOut).toString("base64");
        fs.unlinkSync(tmpRaw);
        fs.unlinkSync(tmpFaded);
        fs.unlinkSync(tmpOut);

        sendJson(res, {
          audioBase64: processedAudio,
          alignment,
          ttsText: text,
          voiceSettings,
        });
      } catch (e: any) {
        if (fs.existsSync(tmpRaw)) fs.unlinkSync(tmpRaw);
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        sendError(res, `ffmpeg error: ${e.message}`, 500);
      }
      return;
    }

    // POST /api/scenes/:id/commit — 再生成した音声を確定
    const commitMatch = pathname.match(/^\/api\/scenes\/(\d+)\/commit$/);
    if (commitMatch && method === "POST") {
      const id = Number(commitMatch[1]);
      const pad = String(id).padStart(3, "0");
      const body = await parseBody(req);

      if (!body.audioBase64) {
        sendError(res, "audioBase64 is required");
        return;
      }

      const audioFile = path.join(AUDIO_DIR, `scene_${pad}.mp3`);

      // バックアップ
      if (fs.existsSync(audioFile)) {
        fs.copyFileSync(audioFile, audioFile + ".bak");
      }

      // ゴミ箱退避（Electron経由のみ）
      trashBeforeOverwrite(audioFile, PROJECT_DIR);

      // 書き込み
      fs.writeFileSync(audioFile, Buffer.from(body.audioBase64, "base64"));

      // Remotion の public/audio/ にもコピー
      syncToRemotion(audioFile, `scene_${pad}.mp3`);

      // タイミング情報があれば保存（pageSwitchTimesの比率調整はupdateScenesJsonで一括処理）
      if (body.alignment) {
        const timingPath = path.join(AUDIO_DIR, `scene_${pad}_timing.json`);
        const pst = body.pageSwitchTimes;
        fs.writeFileSync(
          timingPath,
          JSON.stringify({ pageSwitchTimes: pst || [] }),
          "utf-8"
        );
        syncToRemotion(timingPath, `scene_${pad}_timing.json`);
      }

      // オーバーライドを保存
      if (body.voiceSettings || body.textOverride) {
        const overrides = loadOverrides();
        overrides[String(id)] = {
          ...(body.textOverride ? { textOverride: body.textOverride } : {}),
          ...(body.voiceSettings ? { voiceSettings: body.voiceSettings } : {}),
        };
        saveOverrides(overrides);
      }

      // scenes.json を自動更新（durationSec + pageSwitchTimes）
      updateScenesJson(id, body.alignment, body.pageSwitchTimes);

      // 編集ログ
      const scenes = loadScenesRaw();
      const sceneForLog = scenes.find((s) => s.id === id);
      appendEditLog({
        scene: id,
        type: "audio_text_override",
        before: sceneForLog?.text || "",
        after: body.textOverride || "",
      });

      sendJson(res, { ok: true });
      return;
    }

    // POST /api/scenes/:id/splice — セグメント部分差し替え
    // 指定した時間範囲の音声を、新しいテキストで再生成した音声に差し替える
    const spliceMatch = pathname.match(/^\/api\/scenes\/(\d+)\/splice$/);
    if (spliceMatch && method === "POST") {
      const id = Number(spliceMatch[1]);
      const pad = String(id).padStart(3, "0");
      const audioFile = path.join(AUDIO_DIR, `scene_${pad}.mp3`);
      if (!fs.existsSync(audioFile)) {
        sendError(res, "Audio file not found", 404);
        return;
      }
      const apiKey = process.env.ELEVENLABS_API_KEY;
      const useProxy = !!(process.env.PROXY_URL && process.env.PROXY_TOKEN);
      if (!useProxy && !apiKey) {
        sendError(res, "ELEVENLABS_API_KEY not set", 500);
        return;
      }

      const body = await parseBody(req);
      const { startMs, endMs, text, voiceSettings, preview } = body;
      if (startMs == null || endMs == null || !text) {
        sendError(res, "startMs, endMs, text are required");
        return;
      }

      const startSec = startMs / 1000;
      const endSec = endMs / 1000;
      const crossfadeMs = body.crossfadeMs || 30;
      const crossfadeSec = crossfadeMs / 1000;

      try {
        // 1. 指定テキストで新しい音声を生成
        const settings = voiceSettings || DEFAULT_VOICE_SETTINGS;
        const voiceId = body.voiceId || DEFAULT_VOICE_ID;
        const { audioBase64, alignment } = await generateWithTimestamps(
          text, voiceId, apiKey, settings
        );

        // 2. 新音声を一時ファイルに保存しフェードアウト処理
        const tmpNew = path.join(os.tmpdir(), `editor_splice_new_${id}.mp3`);
        const tmpProcessed = path.join(os.tmpdir(), `editor_splice_proc_${id}.mp3`);
        fs.writeFileSync(tmpNew, Buffer.from(audioBase64, "base64"));

        const newDuration = parseFloat(
          execSync(
            `${FFPROBE} -v error -show_entries format=duration -of csv=p=0 "${tmpNew}"`,
            { encoding: "utf-8" }
          ).trim()
        );

        // 新音声にフェード処理
        execSync(
          `${FFMPEG} -y -i "${tmpNew}" -af "afade=t=in:d=${crossfadeSec},afade=t=out:st=${(newDuration - crossfadeSec).toFixed(3)}:d=${crossfadeSec}" -q:a 2 "${tmpProcessed}"`,
          { stdio: "ignore" }
        );

        // 3. 元音声を3分割して中間部を新音声に差し替え、結合
        const tmpOut = path.join(os.tmpdir(), `editor_splice_out_${id}.mp3`);
        // fadeout前半末尾 + fadein新音声先頭 + fadeout新音声末尾 + fadein後半先頭
        execSync(
          `${FFMPEG} -y -i "${audioFile}" -i "${tmpProcessed}" -filter_complex ` +
          `"[0]atrim=0:${startSec},asetpts=PTS-STARTPTS[a];` +
          `[1]asetpts=PTS-STARTPTS[b];` +
          `[0]atrim=${endSec},asetpts=PTS-STARTPTS[c];` +
          `[a][b][c]concat=n=3:v=0:a=1[out]" ` +
          `-map "[out]" -q:a 2 "${tmpOut}"`,
          { stdio: "ignore" }
        );

        // 1秒超の無音をカット
        const tmpTrimmed = path.join(os.tmpdir(), `editor_splice_trimmed_${id}.mp3`);
        trimLongSilencesInPlace(tmpOut, tmpTrimmed, 1000);
        const resultAudio = fs.readFileSync(tmpTrimmed).toString("base64");

        // クリーンアップ
        for (const f of [tmpNew, tmpProcessed, tmpOut, tmpTrimmed]) {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }

        if (preview) {
          // プレビューモード: 音声を返すだけで保存しない
          sendJson(res, {
            audioBase64: resultAudio,
            alignment,
            newDurationSec: newDuration,
            originalRangeMs: { startMs, endMs },
          });
        } else {
          // 確定モード: ファイルを差し替え
          fs.copyFileSync(audioFile, audioFile + ".bak");
          trashBeforeOverwrite(audioFile, PROJECT_DIR);
          fs.writeFileSync(audioFile, Buffer.from(resultAudio, "base64"));
          syncToRemotion(audioFile, `scene_${pad}.mp3`);
          // scenes.json を自動更新
          updateScenesJson(id);
          // 編集ログ
          appendEditLog({
            scene: id,
            type: "audio_splice",
            rangeMs: { startMs, endMs },
            newText: body.text || "",
          });
          sendJson(res, { ok: true, audioBase64: resultAudio });
        }
      } catch (e: any) {
        // クリーンアップ
        for (const suffix of ["new", "proc", "out"]) {
          const tmp = path.join(os.tmpdir(), `editor_splice_${suffix}_${id}.mp3`);
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        }
        sendError(res, `Splice error: ${e.message}`, 500);
      }
      return;
    }

    // POST /api/scenes/:id/insert-silence — 無音挿入
    const silenceMatch = pathname.match(/^\/api\/scenes\/(\d+)\/insert-silence$/);
    if (silenceMatch && method === "POST") {
      const id = Number(silenceMatch[1]);
      const pad = String(id).padStart(3, "0");
      const audioFile = path.join(AUDIO_DIR, `scene_${pad}.mp3`);
      if (!fs.existsSync(audioFile)) {
        sendError(res, "Audio file not found", 404);
        return;
      }

      const body = await parseBody(req);
      const timestampMs = body.timestampMs || 0;
      const durationMs = body.durationMs || 500;
      const timestampSec = timestampMs / 1000;
      const durationSec = durationMs / 1000;

      const tmpOut = path.join(os.tmpdir(), `editor_silence_${id}.mp3`);
      try {
        // 分割して無音を挿入し、結合
        execSync(
          `${FFMPEG} -y -i "${audioFile}" -filter_complex ` +
          `"[0]atrim=0:${timestampSec},asetpts=PTS-STARTPTS[a];` +
          `aevalsrc=0:d=${durationSec}[s];` +
          `[0]atrim=${timestampSec},asetpts=PTS-STARTPTS[b];` +
          `[a][s][b]concat=n=3:v=0:a=1" ` +
          `-q:a 2 "${tmpOut}"`,
          { stdio: "ignore" }
        );

        // バックアップ→差し替え
        fs.copyFileSync(audioFile, audioFile + ".bak");
        fs.copyFileSync(tmpOut, audioFile);
        fs.unlinkSync(tmpOut);

        // Remotion同期 + scenes.json更新（無音挿入: 正のdelta）
        syncToRemotion(audioFile, `scene_${pad}.mp3`);
        updateScenesJson(id, undefined, undefined, { atSec: timestampSec, deltaSec: durationSec });

        // 編集ログ
        appendEditLog({
          scene: id,
          type: "insert_silence",
          timestampMs,
          durationMs,
        });

        // 処理後の音声をbase64で返す
        const resultAudio = fs.readFileSync(audioFile).toString("base64");
        sendJson(res, { ok: true, audioBase64: resultAudio });
      } catch (e: any) {
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        sendError(res, `ffmpeg error: ${e.message}`, 500);
      }
      return;
    }

    // POST /api/scenes/:id/remove-silence — 無音除去
    const rmSilenceMatch = pathname.match(/^\/api\/scenes\/(\d+)\/remove-silence$/);
    if (rmSilenceMatch && method === "POST") {
      const id = Number(rmSilenceMatch[1]);
      const pad = String(id).padStart(3, "0");
      const audioFile = path.join(AUDIO_DIR, `scene_${pad}.mp3`);
      if (!fs.existsSync(audioFile)) {
        sendError(res, "Audio file not found", 404);
        return;
      }

      const body = await parseBody(req);
      const startMs = body.startMs || 0;
      const endMs = body.endMs || 0;
      const startSec = startMs / 1000;
      const endSec = endMs / 1000;

      const tmpOut = path.join(os.tmpdir(), `editor_rmsil_${id}.mp3`);
      try {
        execSync(
          `${FFMPEG} -y -i "${audioFile}" -filter_complex ` +
          `"[0]atrim=0:${startSec},asetpts=PTS-STARTPTS[a];` +
          `[0]atrim=${endSec},asetpts=PTS-STARTPTS[b];` +
          `[a][b]concat=n=2:v=0:a=1" ` +
          `-q:a 2 "${tmpOut}"`,
          { stdio: "ignore" }
        );

        fs.copyFileSync(audioFile, audioFile + ".bak");
        fs.copyFileSync(tmpOut, audioFile);
        fs.unlinkSync(tmpOut);

        // Remotion同期 + scenes.json更新（無音除去: 負のdelta）
        const removedSec = endSec - startSec;
        syncToRemotion(audioFile, `scene_${pad}.mp3`);
        updateScenesJson(id, undefined, undefined, { atSec: startSec, deltaSec: -removedSec });

        // 編集ログ
        appendEditLog({
          scene: id,
          type: "remove_silence",
          startMs,
          endMs,
          removedMs: endMs - startMs,
        });

        const resultAudio = fs.readFileSync(audioFile).toString("base64");
        sendJson(res, { ok: true, audioBase64: resultAudio });
      } catch (e: any) {
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        sendError(res, `ffmpeg error: ${e.message}`, 500);
      }
      return;
    }

    // ── エンコード API ──

    const VG_DIR = path.resolve(typeof __dirname !== "undefined" ? __dirname : import.meta.dirname, "..");
    const REMOTION_WORKSPACE = fs.existsSync("/tmp/remotion-workspace") ? "/tmp/remotion-workspace" : VG_DIR;
    const PART_IDS: Record<string, string> = { "起": "Part-Ki", "承": "Part-Sho", "転": "Part-Ten", "結": "Part-Ketsu" };

    // POST /api/encode — エンコード開始
    if (pathname === "/api/encode" && method === "POST") {
      const body = await parseBody(req);
      const target = body.target || "full"; // "full" | "起" | "承" | "転" | "結"
      const useSplit = body.useSplit === true; // 分割レイアウト（左70%画像+右30%黒）でエンコードする場合 true

      const baseCompositionId = target === "full" ? "StoryVideo" : PART_IDS[target];
      if (!baseCompositionId) {
        sendError(res, `Invalid target: ${target}`);
        return;
      }
      const compositionId = useSplit ? `${baseCompositionId}-Split` : baseCompositionId;

      const outputDir = path.join(PROJECT_DIR, "output");
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const suffix = useSplit ? "_split" : "";
      const outputFile = target === "full"
        ? path.join(outputDir, `完成版${suffix}.mp4`)
        : path.join(outputDir, `${target}${suffix}.mp4`);

      const jobId = `enc_${Date.now()}`;
      const logFile = path.join(os.tmpdir(), `${jobId}.log`);

      // エンコード前にシンボリックリンクを解決した実ファイルのみのpublic dirを作成
      // Remotion renderはシンボリックリンクを正しくコピーできないため
      const renderPublic = path.join(os.tmpdir(), "remotion-render-public");
      const { execSync: execSyncEnc } = await import("child_process");
      execSyncEnc(`rm -rf "${renderPublic}" && mkdir -p "${renderPublic}/images" "${renderPublic}/audio" "${renderPublic}/videos"`, { stdio: "ignore" });
      // scenes.json
      fs.copyFileSync(path.join(PROJECT_DIR, "scenes.json"), path.join(renderPublic, "scenes.json"));
      // audio
      for (const f of fs.readdirSync(path.join(PROJECT_DIR, "audio")).filter(f => f.endsWith(".mp3"))) {
        fs.copyFileSync(path.join(PROJECT_DIR, "audio", f), path.join(renderPublic, "audio", f));
      }
      // videos（mp4/mov/webm/m4v に対応）
      const videosDir = path.join(PROJECT_DIR, "videos");
      if (fs.existsSync(videosDir)) {
        for (const f of fs.readdirSync(videosDir).filter(f => /\.(mp4|mov|webm|m4v)$/i.test(f))) {
          fs.copyFileSync(path.join(videosDir, f), path.join(renderPublic, "videos", f));
        }
      }
      // images（サブフォルダからフラットに実ファイルコピー）
      const genImagesDir = path.join(PROJECT_DIR, "画像", "生成画像");
      if (fs.existsSync(genImagesDir)) {
        for (const part of ["起", "承", "転", "結"]) {
          const partDir = path.join(genImagesDir, part);
          if (fs.existsSync(partDir)) {
            for (const f of fs.readdirSync(partDir).filter(f => f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".mp4"))) {
              fs.copyFileSync(path.join(partDir, f), path.join(renderPublic, "images", f));
            }
          }
        }
      }
      // images直下のファイルもコピー（動画ファイル等）
      const imagesDir = path.join(PROJECT_DIR, "images");
      if (fs.existsSync(imagesDir)) {
        for (const f of fs.readdirSync(imagesDir).filter(f => !fs.statSync(path.join(imagesDir, f)).isDirectory())) {
          const dest = path.join(renderPublic, "images", f);
          if (!fs.existsSync(dest)) {
            fs.copyFileSync(path.join(imagesDir, f), dest);
          }
        }
      }
      console.log(`  → エンコード用public dir作成完了: ${renderPublic}`);

      // バックグラウンドでエンコード実行
      // 並列数：CPUコア数の半分（強いPCでは大幅高速化、弱いPCでもクラッシュしない安全値）
      // 環境変数 REMOTION_CONCURRENCY で上書き可能（例：REMOTION_CONCURRENCY=8）
      const cpuCount = os.cpus().length;
      const defaultConcurrency = Math.max(2, Math.floor(cpuCount / 2));
      const concurrency = process.env.REMOTION_CONCURRENCY
        ? Number(process.env.REMOTION_CONCURRENCY)
        : defaultConcurrency;
      console.log(`  → エンコード並列数: ${concurrency}（CPU ${cpuCount}コア）`);
      const cmd = `cd "${REMOTION_WORKSPACE}" && node node_modules/@remotion/cli/remotion-cli.js render ${compositionId} --public-dir "${renderPublic}" --output "${outputFile}" --concurrency ${concurrency} 2>&1 | tee "${logFile}"`;

      const { spawn } = await import("child_process");
      const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
      child.unref();

      // ジョブ情報を保存
      const encodeJobs = (global as any).__encodeJobs || {};
      encodeJobs[jobId] = { state: "running", pid: child.pid, logFile, outputFile, startTime: Date.now() };
      (global as any).__encodeJobs = encodeJobs;

      sendJson(res, { jobId, output: outputFile });
      return;
    }

    // GET /api/encode/:jobId — エンコード状態確認
    const encodeStatusMatch = pathname.match(/^\/api\/encode\/(.+)$/);
    if (encodeStatusMatch && method === "GET") {
      const jobId = encodeStatusMatch[1];
      const encodeJobs = (global as any).__encodeJobs || {};
      const job = encodeJobs[jobId];
      if (!job) { sendError(res, "Job not found", 404); return; }

      // ログからプログレスを読み取り
      let progress = 0;
      let message = "";
      try {
        if (fs.existsSync(job.logFile)) {
          const log = fs.readFileSync(job.logFile, "utf-8");
          // Remotion の進捗出力: "Rendered 120 out of 3600 frames"
          const matches = [...log.matchAll(/(\d+)\/(\d+)/g)];
          if (matches.length > 0) {
            const last = matches[matches.length - 1];
            const current = parseInt(last[1]);
            const total = parseInt(last[2]);
            if (total > 0) progress = Math.round((current / total) * 100);
            message = `${current}/${total} フレーム`;
          }
          // 完了チェック
          if (log.includes("Video rendered")) {
            job.state = "done";
            progress = 100;
            message = "エンコード完了";
          }
          // エラーチェック
          if (log.includes("Error") && !log.includes("Video rendered")) {
            const errLine = log.split("\n").find((l: string) => l.includes("Error"));
            if (errLine && !log.includes("Rendered")) {
              job.state = "error";
              message = errLine.slice(0, 100);
            }
          }
        }
      } catch {}

      // プロセスが終了しているか確認
      if (job.state === "running" && job.pid) {
        try {
          process.kill(job.pid, 0); // プロセス存在チェック
        } catch {
          // プロセスが存在しない = 終了済み
          if (fs.existsSync(job.outputFile) && fs.statSync(job.outputFile).size > 0) {
            job.state = "done";
            progress = 100;
            message = "エンコード完了";
          } else {
            job.state = "error";
            message = message || "エンコードが異常終了しました";
          }
        }
      }

      sendJson(res, { state: job.state, progress, message, output: job.outputFile });
      return;
    }

    // ── エンコードUI静的ファイル ──
    const encodeStaticMatch = pathname.match(/^\/encode(\/.*)?$/);
    if (encodeStaticMatch) {
      const encodePublic = path.join(typeof __dirname !== "undefined" ? __dirname : import.meta.dirname, "public-encode");
      let encodeFile = encodeStaticMatch[1] || "/index.html";
      if (encodeFile === "/") encodeFile = "/index.html";
      const encodePath = path.join(encodePublic, encodeFile);
      if (encodePath.startsWith(encodePublic) && fs.existsSync(encodePath) && fs.statSync(encodePath).isFile()) {
        const ext = path.extname(encodePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        fs.createReadStream(encodePath).pipe(res);
        return;
      }
    }

    // ── テロップ API ──

    // GET /api/telop/:id — 現在のテロップ分割を取得
    const telopGetMatch = pathname.match(/^\/api\/telop\/(\d+)$/);
    if (telopGetMatch && method === "GET") {
      const id = Number(telopGetMatch[1]);
      if (!fs.existsSync(SCENES_JSON_PATH)) {
        sendError(res, "scenes.json not found", 404);
        return;
      }
      const scenesJson = JSON.parse(fs.readFileSync(SCENES_JSON_PATH, "utf-8"));
      const scene = scenesJson.find((s: any) => s.id === id);
      if (!scene) { sendError(res, "Scene not found", 404); return; }

      // manualPages があればそれを返す、なければ自動分割
      const pst = scene.pageSwitchTimes || [];
      const dur = scene.durationSec || 0;
      if (scene.manualPages && scene.manualPages.length > 0) {
        sendJson(res, { pages: scene.manualPages, manual: true, pageSwitchTimes: pst, durationSec: dur });
      } else {
        const pages = autoSplitPages(scene.text);
        sendJson(res, { pages, manual: false, pageSwitchTimes: pst, durationSec: dur });
      }
      return;
    }

    // GET /api/telop/:id/auto — 自動分割を取得（リセット用）
    const telopAutoMatch = pathname.match(/^\/api\/telop\/(\d+)\/auto$/);
    if (telopAutoMatch && method === "GET") {
      const id = Number(telopAutoMatch[1]);
      const scenes = loadScenesRaw();
      const scene = scenes.find((s) => s.id === id);
      if (!scene) { sendError(res, "Scene not found", 404); return; }
      const pages = autoSplitPages(scene.text);
      sendJson(res, { pages });
      return;
    }

    // POST /api/telop/:id — テロップ分割を保存
    const telopPostMatch = pathname.match(/^\/api\/telop\/(\d+)$/);
    if (telopPostMatch && method === "POST") {
      const id = Number(telopPostMatch[1]);
      const body = await parseBody(req);
      if (!body.pages) { sendError(res, "pages is required"); return; }

      if (!fs.existsSync(SCENES_JSON_PATH)) {
        sendError(res, "scenes.json not found", 404);
        return;
      }
      const scenesJson = JSON.parse(fs.readFileSync(SCENES_JSON_PATH, "utf-8"));
      const scene = scenesJson.find((s: any) => s.id === id);
      if (!scene) { sendError(res, "Scene not found", 404); return; }

      // pageSwitchTimes を自動再計算
      // 元の自動分割を基準にする（pageSwitchTimesは自動分割に対して計算されたものであるため）
      const oldPST = scene.pageSwitchTimes ? [...scene.pageSwitchTimes] : [];
      const oldPages = autoSplitPages(scene.text || "");

      scene.manualPages = body.pages;

      if (body.pages.length > 1) {
        // 実際の音声ファイルから最新のdurationを取得
        const pad2 = String(id).padStart(3, "0");
        const audioPath = path.join(AUDIO_DIR, `scene_${pad2}.mp3`);
        let actualDuration = scene.durationSec || 10;
        if (fs.existsSync(audioPath)) {
          const d = getAudioDuration(audioPath);
          if (d > 0) actualDuration = d;
        }
        const effectiveDuration = Math.max(actualDuration - 0.3, 1);

        const allText = body.pages.map((p: string[]) => p.join("")).join("");
        const totalChars = allText.length;

        if (totalChars > 0) {
          // 新しいページ境界の文字位置から、文字比率で切り替え時刻を計算
          const newPST: number[] = [];
          let cumChars = 0;
          for (let i = 0; i < body.pages.length - 1; i++) {
            cumChars += body.pages[i].map((l: string) => l.length).reduce((a: number, b: number) => a + b, 0);
            const time = (cumChars / totalChars) * effectiveDuration;
            newPST.push(Math.round(time * 1000) / 1000);
          }

          scene.pageSwitchTimes = newPST;
          console.log(`  → pageSwitchTimes 自動更新: [${newPST.map(t => t.toFixed(3)).join(", ")}] (duration=${actualDuration.toFixed(2)}s)`);
        }
      } else {
        // 1ページのみの場合はpageSwitchTimes不要
        scene.pageSwitchTimes = [];
      }

      // 手動でpageSwitchTimesが指定されている場合は上書き
      if (Array.isArray(body.pageSwitchTimes)) {
        scene.pageSwitchTimes = body.pageSwitchTimes;
        console.log(`  → pageSwitchTimes 手動設定: [${body.pageSwitchTimes.map((t: number) => t.toFixed(3)).join(", ")}]`);
      }

      fs.writeFileSync(SCENES_JSON_PATH, JSON.stringify(scenesJson, null, 2), "utf-8");

      // Remotionにも同期（シンボリックリンクの場合はスキップ）
      try {
        safeCopyIfNeeded(SCENES_JSON_PATH, REMOTION_SCENES_JSON);
        safeCopyIfNeeded(SCENES_JSON_PATH, REMOTION_PUBLIC_SCENES_JSON);
        const tmpScenesJson = "/tmp/remotion-workspace/src/scenes.json";
        safeCopyIfNeeded(SCENES_JSON_PATH, tmpScenesJson);
      } catch {}

      // 編集ログ
      appendEditLog({
        scene: id,
        type: "telop_edit",
        pages: body.pages,
        pageSwitchTimes: scene.pageSwitchTimes,
      });

      console.log(`  → テロップ保存: シーン${id} (${body.pages.length}ページ)`);
      sendJson(res, { ok: true });
      return;
    }

    // ── テロップエディタ静的ファイル ──
    const telopStaticMatch = pathname.match(/^\/telop(\/.*)?$/);
    if (telopStaticMatch) {
      const telopPublic = path.join(typeof __dirname !== "undefined" ? __dirname : import.meta.dirname, "public-telop");
      let telopFile = telopStaticMatch[1] || "/index.html";
      if (telopFile === "/") telopFile = "/index.html";
      const telopPath = path.join(telopPublic, telopFile);
      if (telopPath.startsWith(telopPublic) && fs.existsSync(telopPath) && fs.statSync(telopPath).isFile()) {
        const ext = path.extname(telopPath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        fs.createReadStream(telopPath).pipe(res);
        return;
      }
    }

    // ── 静的ファイル配信 ──
    let filePath = pathname === "/" ? "/index.html" : pathname;
    const fullPath = path.join(PUBLIC_DIR, filePath);

    // ディレクトリトラバーサル防止
    if (!fullPath.startsWith(PUBLIC_DIR)) {
      sendError(res, "Forbidden", 403);
      return;
    }

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
      });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    sendError(res, "Not Found", 404);
  } catch (e: any) {
    console.error("Server error:", e);
    sendError(res, e.message || "Internal Server Error", 500);
  }
});

async function start() {
  // キーサーバーからAPIキーを取得
  if (process.env.KEY_SERVER_URL && !process.env.ELEVENLABS_API_KEY) {
    await loadKeysFromServer();
  }

  console.log(`プロジェクト: ${PROJECT_DIR}`);
  console.log(`音声フォルダ: ${AUDIO_DIR}`);

  const scenes = loadScenesRaw();
  console.log(`シーン数: ${scenes.length}`);

  const audioFiles = fs.existsSync(AUDIO_DIR)
    ? fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith(".mp3")).length
    : 0;
  console.log(`音声ファイル: ${audioFiles}`);

  server.listen(PORT, () => {
    console.log(`\n音声エディタ起動: http://localhost:${PORT}`);
  });
}

start();
