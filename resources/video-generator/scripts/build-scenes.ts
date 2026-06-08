/**
 * シーンJSONビルダー
 *
 * scenes_raw.json + 生成画像 + 音声ファイルを統合し、
 * Remotion 用の scenes.json を生成する。
 *
 * Usage:
 *   npx tsx scripts/build-scenes.ts --project <作品フォルダパス> --images <画像フォルダパス>
 *
 * 画像フォルダ内のファイル命名規則:
 *   {パート}_scene_{番号}_{説明}.png
 *   例: 起_scene_01_冒頭フック_—_あかりが絵日記を差し出す.png
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

// FFmpeg パス解決（WinGet インストール対応）
const FFMPEG_BIN = (() => {
  try { execSync("ffprobe -version", { stdio: "ignore" }); return ""; }
  catch {
    const wingetDir = path.join(os.homedir(), "AppData/Local/Microsoft/WinGet/Packages");
    if (fs.existsSync(wingetDir)) {
      for (const d of fs.readdirSync(wingetDir)) {
        if (d.startsWith("Gyan.FFmpeg")) {
          const bin = path.join(wingetDir, d);
          const sub = fs.readdirSync(bin).find(f => f.startsWith("ffmpeg-"));
          if (sub) return path.join(bin, sub, "bin") + path.sep;
        }
      }
    }
    return "";
  }
})();

import type { MotionType, SceneData } from "../src/types";

interface RawScene {
  id: number;
  part: string;
  partSceneNumber: number;
  text: string;
}

/** Ken Burns モーションをシーンごとに自動割り当て（バリエーション付き） */
const MOTION_CYCLE: MotionType[] = [
  "zoomIn",
  "panLeft",
  "zoomOut",
  "panRight",
  "panUp",
  "zoomIn",
  "panDown",
  "zoomOut",
];

function getMotion(index: number): MotionType {
  return MOTION_CYCLE[index % MOTION_CYCLE.length];
}

/** 音声ファイルの長さを取得（秒） */
function getAudioDuration(audioPath: string): number {
  // WAV: ヘッダーから直接計算
  if (audioPath.endsWith(".wav")) {
    try {
      const buf = fs.readFileSync(audioPath);
      const dataSize = buf.readUInt32LE(40);
      const sampleRate = buf.readUInt32LE(24);
      const bitsPerSample = buf.readUInt16LE(34);
      const numChannels = buf.readUInt16LE(22);
      return dataSize / (sampleRate * numChannels * (bitsPerSample / 8));
    } catch {
      return -1;
    }
  }
  // MP3: ffprobe
  try {
    const result = execSync(
      `${FFMPEG_BIN}ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
      { encoding: "utf-8" }
    );
    return parseFloat(result.trim());
  } catch {
    console.warn(`  ffprobe 使用不可、テキスト長から推定します`);
    return -1;
  }
}

/** 画像フォルダから パート+シーン番号 → ファイルパス のマップを作成
 *  フラット構造（生成画像/）とパート別サブフォルダ構造（生成画像/起/）の両方に対応
 */
function buildImageMap(imageDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(imageDir)) return map;

  function scanDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        scanDir(path.join(dir, entry.name));
      } else {
        const file = entry.name;
        const match = file.match(/^(.+?)_scene_(\d+)_.+\.(png|jpg|jpeg|webp)$/);
        if (match) {
          const part = match[1];
          const num = parseInt(match[2], 10);
          const key = `${part}_${num}`;
          map.set(key, path.resolve(dir, file));
        }
      }
    }
  }

  scanDir(imageDir);
  return map;
}

function main() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  if (projectIdx === -1 || !args[projectIdx + 1]) {
    console.error(
      "Usage: npx tsx scripts/build-scenes.ts --project <作品フォルダパス> --images <画像フォルダパス>"
    );
    process.exit(1);
  }
  const projectDir = args[projectIdx + 1];

  const imagesIdx = args.indexOf("--images");
  // デフォルト: 作品フォルダ内の 画像/生成画像/
  const imageDir = imagesIdx !== -1 && args[imagesIdx + 1]
    ? args[imagesIdx + 1]
    : path.join(projectDir, "画像", "生成画像");

  const scenesRawPath = path.join(projectDir, "scenes_raw.json");
  if (!fs.existsSync(scenesRawPath)) {
    console.error("scenes_raw.json が見つかりません。先に parse-script.ts を実行してください。");
    process.exit(1);
  }

  const rawScenes: RawScene[] = JSON.parse(fs.readFileSync(scenesRawPath, "utf-8"));
  const imageMap = buildImageMap(imageDir);
  const audioDir = path.join(projectDir, "audio");
  const videoDir = path.join(projectDir, "videos");

  // 既存の scenes.json からエディタの手動編集を引き継ぐ
  const outputPath = path.join(projectDir, "scenes.json");
  const existingEdits = new Map<number, { manualPages?: string[][]; pageSwitchTimes?: number[]; soundEffects?: any[] }>();
  if (fs.existsSync(outputPath)) {
    try {
      const existing: any[] = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      for (const s of existing) {
        const edits: any = {};
        if (s.manualPages) edits.manualPages = s.manualPages;
        if (s.pageSwitchTimes) edits.pageSwitchTimes = s.pageSwitchTimes;
        if (s.soundEffects) edits.soundEffects = s.soundEffects;
        if (Object.keys(edits).length > 0) {
          existingEdits.set(s.id, edits);
        }
      }
      if (existingEdits.size > 0) {
        console.log(`既存の手動編集を引き継ぎ: ${existingEdits.size}シーン`);
      }
    } catch {}
  }

  console.log(`画像フォルダ: ${imageDir} (${imageMap.size} ファイル)`);
  console.log(`音声フォルダ: ${audioDir}`);
  console.log(`シーン数: ${rawScenes.length}`);

  const scenes: SceneData[] = [];
  let missingImages = 0;
  let missingAudio = 0;

  for (const raw of rawScenes) {
    const imageKey = `${raw.part}_${raw.partSceneNumber}`;
    const imagePath = imageMap.get(imageKey) ?? "";
    if (!imagePath) {
      console.warn(`  [!] 画像なし: ${imageKey}`);
      missingImages++;
    }

    // wav または mp3 を探す
    const audioBase = `scene_${String(raw.id).padStart(3, "0")}`;
    let audioPath = path.join(audioDir, `${audioBase}.wav`);
    let audioExists = fs.existsSync(audioPath);
    if (!audioExists) {
      audioPath = path.join(audioDir, `${audioBase}.mp3`);
      audioExists = fs.existsSync(audioPath);
    }
    if (!audioExists) {
      missingAudio++;
    }

    // 音声の長さを取得
    let durationSec: number;
    if (audioExists) {
      durationSec = getAudioDuration(audioPath);
      if (durationSec < 0) {
        // ffprobe なし: テキスト長から推定
        durationSec = raw.text.length * 0.15;
      }
    } else {
      // 音声なし: テキスト長から推定（プレビュー用）
      durationSec = raw.text.length * 0.15;
    }

    // 音声後に0.5秒の余白を追加、最低2秒（元値: 1.0秒）
    durationSec = Math.max(durationSec + 0.5, 2);

    // 差し替え動画を探す（videos/scene_001.mp4）
    const videoPath = path.join(videoDir, `scene_${String(raw.id).padStart(3, "0")}.mp4`);
    const videoExists = fs.existsSync(videoPath);

    // Remotion staticFile 用: ファイル名のみ格納
    const imageFilename = imagePath ? path.basename(imagePath) : "";
    const audioFilename = audioExists ? path.basename(audioPath) : "";
    const videoFilename = videoExists ? path.basename(videoPath) : "";

    // タイミングファイルからページ切替時刻を読み込む
    // テキストが1ページ（72文字=24文字×3行）に収まる場合はページ切替不要
    const MAX_CHARS_PER_LINE = 24;
    const MAX_LINES_PER_PAGE = 3;
    const PAGE_MAX_CHARS = MAX_CHARS_PER_LINE * MAX_LINES_PER_PAGE;
    const flatTextLen = raw.text.replace(/\n/g, "").length;

    const pad = String(raw.id).padStart(3, "0");
    const timingPath = path.join(audioDir, `scene_${pad}_timing.json`);
    let pageSwitchTimes: number[] | undefined;
    if (flatTextLen > PAGE_MAX_CHARS && fs.existsSync(timingPath)) {
      try {
        const timing = JSON.parse(fs.readFileSync(timingPath, "utf-8"));
        if (Array.isArray(timing.pageSwitchTimes) && timing.pageSwitchTimes.length > 0) {
          pageSwitchTimes = timing.pageSwitchTimes;
        }
      } catch {}
    }

    // 既存の手動編集を引き継ぐ（エディタで修正済みのテロップ分割・タイミング・効果音）
    const existingEdit = existingEdits.get(raw.id);
    const finalPST = existingEdit?.pageSwitchTimes ?? pageSwitchTimes;
    const finalManualPages = existingEdit?.manualPages;
    const finalSoundEffects = existingEdit?.soundEffects;

    scenes.push({
      id: raw.id,
      part: raw.part,
      image: imageFilename ? `images/${imageFilename}` : "",
      text: raw.text,
      motion: getMotion(raw.id - 1),
      audio: audioFilename ? `audio/${audioFilename}` : "",
      durationSec,
      ...(finalPST ? { pageSwitchTimes: finalPST } : {}),
      ...(finalManualPages ? { manualPages: finalManualPages } : {}),
      ...(videoFilename ? { video: `videos/${videoFilename}` } : {}),
      ...(finalSoundEffects && finalSoundEffects.length > 0 ? { soundEffects: finalSoundEffects } : {}),
    });
  }

  fs.writeFileSync(outputPath, JSON.stringify(scenes, null, 2), "utf-8");

  console.log(`\n✓ scenes.json 生成完了: ${outputPath}`);
  if (missingImages > 0) console.warn(`  ⚠ 画像未対応: ${missingImages} シーン`);
  if (missingAudio > 0) console.warn(`  ⚠ 音声未生成: ${missingAudio} シーン`);

  // images シンボリックリンク作成（--public-dir 用）
  const imagesLink = path.join(projectDir, "images");
  try {
    if (!fs.existsSync(imagesLink)) {
      fs.symlinkSync(imageDir, imagesLink);
      console.log(`✓ images シンボリックリンク作成: ${imagesLink} → ${imageDir}`);
    }
  } catch (e: any) {
    // Windows等でシンボリックリンク作成に失敗した場合は警告のみ
    console.warn(`  ⚠ images シンボリックリンク作成失敗: ${e.message}`);
  }
}

main();
