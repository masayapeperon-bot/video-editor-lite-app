/**
 * ElevenLabs 音声生成スクリプト（統合生成版）
 *
 * 全シーンのテキストを1リクエストで送信し、タイムスタンプを使って
 * シーンごとに切り出す。これにより全シーンで音質が統一される。
 *
 * Usage:
 *   npx tsx scripts/generate-audio.ts --project <作品フォルダパス> [--voice <voice_id>] [--parts 起,承]
 *
 * 環境変数 (.env から自動読み込み):
 *   ELEVENLABS_API_KEY — ElevenLabs API キー
 *
 * 出力: <作品フォルダパス>/audio/scene_001.mp3, scene_002.mp3, ...
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as os from "os";

// FFmpeg パス解決（WinGet インストール対応）
const FFMPEG_BIN = (() => {
  try { execSync("ffmpeg -version", { stdio: "ignore" }); return ""; }
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

// .env 読み込み
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
}

// キーサーバーから APIキーを取得（ELEVENLABS_API_KEY が未設定の場合）
async function loadKeysFromServer(): Promise<void> {
  const serverUrl = process.env.KEY_SERVER_URL;
  const serverToken = process.env.KEY_SERVER_TOKEN;
  if (!serverUrl || !serverToken) return;
  try {
    const res = await fetch(serverUrl, {
      headers: { Authorization: `Bearer ${serverToken}` },
    });
    if (!res.ok) {
      console.error(`鍵サーバーへの接続に失敗しました: ${res.status}`);
      process.exit(1);
    }
    const keys = await res.json() as Record<string, string>;
    for (const [k, v] of Object.entries(keys)) {
      if (v) process.env[k] = v;
    }
  } catch (e) {
    console.error(`鍵サーバーへの接続エラー: ${e}`);
    process.exit(1);
  }
}

if (!process.env.ELEVENLABS_API_KEY && process.env.KEY_SERVER_URL) {
  // main() より前に同期的に解決できないため、main() 内で await する
  // ここではフラグだけ立てる
  (process.env as Record<string,string>)["_USE_KEY_SERVER"] = "1";
}

interface RawScene {
  id: number;
  part: string;
  partSceneNumber: number;
  text: string;
}

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1";
const MODEL_ID = "eleven_v3";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

/**
 * Gemini APIで台本テキストをスキャンし、読み間違えやすい語句を検出する
 * 返却: { "漢字語句": "ひらがな読み" } のマップ
 */
async function scanPronunciation(
  texts: string[],
  geminiApiKey: string
): Promise<Record<string, string>> {
  const combinedText = texts.join("\n---\n");
  const prompt = `以下は動画ナレーションの台本テキストです。
TTS（テキスト読み上げ）エンジンが読み間違える可能性のある語句を検出してください。

対象：
- 複数の読み方がある漢字（例：今日→きょう/こんにち、一日→いちにち/ついたち）
- 難読漢字（例：所謂→いわゆる、漸く→ようやく）
- 音読み/訓読みの判断が難しい語（例：甲高い→かんだかい）
- 当て字や特殊な読み（例：相殺→そうさい）

対象外：
- 人物名（別途処理済み）
- ひらがな・カタカナのみの語句
- 一般的で読み間違いの可能性が低い語句

文脈に基づいて正しい読みを判断し、JSON形式で出力してください。
出力は必ず以下のフォーマットのみ（説明や補足は不要）：

{"漢字語句": "ひらがな読み", "漢字語句2": "ひらがな読み2"}

読み間違いの可能性がある語句がない場合は {} を返してください。

台本テキスト：
${combinedText}`;

  const response = await fetch(`${GEMINI_API_URL}?key=${geminiApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`Gemini API error: ${response.status} - ${errBody.slice(0, 200)}`);
    return {};
  }

  const json = await response.json() as any;
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";

  // JSONを抽出（```json ... ``` で囲まれている場合も対応）
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    console.error("Gemini応答のJSON解析に失敗:", text);
    return {};
  }
}

// シーン間の区切り文字（TTS に無音ポーズを作らせる）
const SEPARATOR = "。";

// silenceremove の stop_duration（秒）。Telop同期シミュレーションと一致させること
const SILENCE_STOP_DURATION = 0.5;

// ---- Telop.tsx と同一のテキスト分割ロジック ----
const MAX_CHARS = 24;
const MAX_LINES = 3;
const PAGE_MAX_CHARS = MAX_CHARS * MAX_LINES;

function splitSentences(text: string): string[] {
  const result: string[] = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if (text[i] === "「") depth++;
    if (text[i] === "」") depth--;
    const isEnd =
      (text[i] === "」" && depth === 0) ||
      ("。！？".includes(text[i]) && depth === 0);
    if (isEnd && i < text.length - 1) { result.push(buf); buf = ""; }
  }
  if (buf) result.push(buf);
  return result;
}

function splitScoreAudio(text: string, pos: number, idealPos: number): number {
  const prev = text[pos - 1], next = text[pos];
  let priority = 10;
  if (prev === "」") priority = 1;
  else if (next === "「") priority = 2;
  else if ("。！？".includes(prev)) priority = 3;
  else if (prev === "、") priority = 4;
  return priority * 100 + Math.abs(pos - idealPos);
}

function splitPageLines(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  if (text.length <= MAX_CHARS * 2) {
    const minPos = text.length - MAX_CHARS;
    const maxPos = MAX_CHARS;
    const mid = Math.floor(text.length / 2);
    let bestPos = mid, bestScore = Infinity;
    for (let i = Math.max(1, minPos); i <= Math.min(text.length - 1, maxPos); i++) {
      const score = splitScoreAudio(text, i, mid);
      if (score < bestScore) { bestScore = score; bestPos = i; }
    }
    return [text.slice(0, bestPos), text.slice(bestPos)];
  }
  // 3行分割: 1行目を切り出し、残りを必ず2行に分割
  const minFirst = Math.max(1, text.length - MAX_CHARS * 2);
  const maxFirst = MAX_CHARS;
  const targetFirst = Math.floor(text.length / 3);
  let bestPos = Math.max(minFirst, Math.min(targetFirst, maxFirst));
  let bestScore = Infinity;
  for (let i = minFirst; i <= Math.min(text.length - 1, maxFirst); i++) {
    const score = splitScoreAudio(text, i, targetFirst);
    if (score < bestScore) { bestScore = score; bestPos = i; }
  }
  return [text.slice(0, bestPos), ...splitPageLines(text.slice(bestPos))];
}

function splitIntoPages(text: string): string[][] {
  const flat = text.replace(/\n/g, "");
  if (flat.length <= MAX_CHARS) return [[flat]];
  const sentences = splitSentences(flat);
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (s.length > PAGE_MAX_CHARS) {
      if (current) { chunks.push(current); current = ""; }
      let part = "";
      for (let i = 0; i < s.length; i++) {
        part += s[i];
        if (s[i] === "、" && part.length >= MAX_CHARS && i < s.length - 1) {
          if (current && current.length + part.length <= PAGE_MAX_CHARS) { current += part; }
          else { if (current) chunks.push(current); current = part; }
          part = "";
        }
      }
      if (part) {
        if (current && current.length + part.length <= PAGE_MAX_CHARS) { current += part; }
        else { if (current) chunks.push(current); current = part; }
      }
    } else if (current.length + s.length <= PAGE_MAX_CHARS) {
      current += s;
    } else {
      if (current) chunks.push(current);
      current = s;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => splitPageLines(c));
}

/**
 * silenceGaps を使って正確なページ切替時刻を計算する
 * （silenceremove シミュレーションの代替 — 実際の除去量を正確に計算）
 *
 * @param originalText - 表示用テキスト（scenes_raw.json のテキスト）
 * @param alignChars - シーン相対のalignment文字配列
 * @param alignStart - シーン相対の開始時刻（秒）
 * @param silenceGaps - 実際に処理される無音ギャップ（scene相対、SILENCE_STOP_DURATION 超）
 */
function computeExactPageSwitchTimes(
  originalText: string,
  apiText: string,
  alignChars: string[],
  alignStart: number[],
  silenceGaps: Array<{ gapStart: number; gapEnd: number }>,
  posMap?: number[]
): number[] {
  const flat = originalText.replace(/\n/g, "");
  const flatApi = apiText.replace(/\n/g, "");
  const pages = splitIntoPages(originalText);
  if (pages.length <= 1) return [];

  const pageTexts = pages.map(lines => lines.join(""));
  const pageSwitchTimes: number[] = [];
  let cumLen = 0;

  // 改行を除去した元テキスト用のposMapを構築
  // originalText から改行を除去した flat に対応する posMap
  let flatPosMap: number[] | undefined;
  if (posMap) {
    flatPosMap = [];
    const origWithNewlines = originalText;
    let flatIdx = 0;
    for (let i = 0; i < origWithNewlines.length; i++) {
      if (origWithNewlines[i] !== "\n") {
        flatPosMap.push(posMap[i]);
        flatIdx++;
      }
    }
  }

  for (let pi = 0; pi < pages.length - 1; pi++) {
    cumLen += pageTexts[pi].length;

    // posMapがある場合: 元テキストの境界位置を置換後テキストの位置に変換
    let apiCumLen: number;
    if (flatPosMap && cumLen - 1 < flatPosMap.length) {
      // 元テキストの cumLen-1 番目の文字が、置換後テキストのどこに対応するかを取得
      apiCumLen = flatPosMap[cumLen - 1] + 1; // +1 で境界文字の次の位置
    } else {
      apiCumLen = cumLen; // フォールバック
    }

    // 置換後テキストでの境界文字を取得
    const boundaryCharIdx = Math.min(apiCumLen - 1, flatApi.length - 1);
    const boundaryChar = flatApi[boundaryCharIdx];
    let ordinal = 0;
    for (let ci = 0; ci <= boundaryCharIdx; ci++) {
      if (flatApi[ci] === boundaryChar) ordinal++;
    }

    // alignment から ordinal 番目の boundaryChar を探す
    let found = 0, boundaryAlignIdx = -1;
    for (let ai = 0; ai < alignChars.length; ai++) {
      if (alignChars[ai] === boundaryChar) {
        found++;
        if (found === ordinal) { boundaryAlignIdx = ai; break; }
      }
    }

    // 次ページの最初の文字の開始時刻を取得
    // 境界文字と同じタイムスタンプはスキップ（ElevenLabsが読点と次文字に同タイムスタンプを返す問題への対処）
    let nextTime = -1;
    if (boundaryAlignIdx !== -1) {
      const boundaryTime = alignStart[boundaryAlignIdx];
      for (let ai = boundaryAlignIdx + 1; ai < alignChars.length; ai++) {
        if (alignChars[ai].trim() !== "" && alignStart[ai] > boundaryTime) {
          nextTime = alignStart[ai];
          break;
        }
      }
      // fallback: 同タイムスタンプしかない場合は次の非空白文字をそのまま使う
      if (nextTime === -1) {
        for (let ai = boundaryAlignIdx + 1; ai < alignChars.length; ai++) {
          if (alignChars[ai].trim() !== "") { nextTime = alignStart[ai]; break; }
        }
      }
    }
    if (nextTime === -1) {
      // フォールバック: 文字比率
      const totalDuration = alignStart[alignStart.length - 1];
      pageSwitchTimes.push((cumLen / flat.length) * totalDuration);
      continue;
    }

    // 正確な除去量計算: nextTime より前の silenceGaps の超過分を合計
    // 各ギャップは SILENCE_STOP_DURATION まで残し、残りを除去
    let removed = 0;
    for (const { gapStart, gapEnd } of silenceGaps) {
      if (gapStart >= nextTime) break;
      removed += (gapEnd - gapStart) - SILENCE_STOP_DURATION;
    }
    pageSwitchTimes.push(Math.max(0, nextTime - removed));
  }

  return pageSwitchTimes;
}

async function generateWithTimestamps(
  text: string,
  voiceId: string,
  apiKey: string,
  speed: number = 1.0
): Promise<{ audioBase64: string; alignment: Alignment }> {
  const response = await fetch(
    `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        speed,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.5,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} ${error}`);
  }

  const json = await response.json() as { audio_base64: string; alignment: Alignment };
  return { audioBase64: json.audio_base64, alignment: json.alignment };
}

/** alignment の characters 配列から、combined テキスト中の位置 → alignment インデックス のマップを作成 */
function buildCharIndexMap(combined: string, alignment: Alignment): Map<number, number> {
  const map = new Map<number, number>();
  let alignIdx = 0;
  for (let i = 0; i < combined.length && alignIdx < alignment.characters.length; i++) {
    // alignment は空白・改行をスキップする場合があるのでマッチングで進める
    if (alignment.characters[alignIdx] === combined[i]) {
      map.set(i, alignIdx);
      alignIdx++;
    }
  }
  return map;
}

/**
 * 音声ファイル内の長い無音区間を指定の最大長にカットする
 * @param inputPath 入力音声ファイル
 * @param outputPath 出力音声ファイル
 * @param maxSilenceMs 無音の最大長（ミリ秒）。これを超える無音はこの長さにカットされる
 */
function trimLongSilences(inputPath: string, outputPath: string, maxSilenceMs: number): void {
  const maxSilenceSec = maxSilenceMs / 1000;
  const threshold = 0.01; // 無音検出の閾値（-40dB相当）

  try {
    // silencedetectで無音区間を検出
    const detectResult = execSync(
      `${FFMPEG_BIN}ffmpeg -i "${inputPath}" -af "silencedetect=noise=-40dB:d=${maxSilenceSec}" -f null - 2>&1`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    // silence_start / silence_end をパース
    const silences: Array<{ start: number; end: number }> = [];
    const lines = detectResult.split("\n");
    let currentStart = -1;
    for (const line of lines) {
      const startMatch = line.match(/silence_start:\s*([\d.]+)/);
      const endMatch = line.match(/silence_end:\s*([\d.]+)/);
      if (startMatch) currentStart = parseFloat(startMatch[1]);
      if (endMatch && currentStart >= 0) {
        silences.push({ start: currentStart, end: parseFloat(endMatch[1]) });
        currentStart = -1;
      }
    }

    if (silences.length === 0) {
      // 長い無音がない場合はそのままコピー
      fs.copyFileSync(inputPath, outputPath);
      return;
    }

    // 各無音区間について、maxSilenceSec を超える部分をカットするフィルターを構築
    // aselect で「残す区間」を指定する方式
    const totalDuration = parseFloat(
      execSync(`${FFMPEG_BIN}ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`, { encoding: "utf-8" }).trim()
    );

    // 残す区間を計算: 無音のうち maxSilenceSec を超える部分を除外
    const keepSegments: Array<{ start: number; end: number }> = [];
    let pos = 0;
    for (const s of silences) {
      const silenceDur = s.end - s.start;
      if (silenceDur > maxSilenceSec) {
        // 無音の先頭 maxSilenceSec だけ残す
        keepSegments.push({ start: pos, end: s.start + maxSilenceSec });
        pos = s.end;
      }
    }
    keepSegments.push({ start: pos, end: totalDuration });

    if (keepSegments.length <= 1 && keepSegments[0].start === 0) {
      fs.copyFileSync(inputPath, outputPath);
      return;
    }

    // ffmpeg の concat フィルターで残す区間を結合
    const filterParts: string[] = [];
    const concatInputs: string[] = [];
    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      filterParts.push(`[0]atrim=${seg.start.toFixed(3)}:${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[s${i}]`);
      concatInputs.push(`[s${i}]`);
    }
    const filterComplex = `${filterParts.join(";")};${concatInputs.join("")}concat=n=${keepSegments.length}:v=0:a=1`;

    execSync(
      `${FFMPEG_BIN}ffmpeg -y -i "${inputPath}" -filter_complex "${filterComplex}" -q:a 2 "${outputPath}"`,
      { stdio: "ignore" }
    );

    const trimmedCount = silences.length;
    const originalDur = totalDuration;
    const newDur = parseFloat(
      execSync(`${FFMPEG_BIN}ffprobe -v error -show_entries format=duration -of csv=p=0 "${outputPath}"`, { encoding: "utf-8" }).trim()
    );
    console.log(`  無音カット: ${trimmedCount}箇所 (${originalDur.toFixed(1)}s → ${newDur.toFixed(1)}s)`);
  } catch (e: any) {
    // エラー時はそのままコピー
    console.warn(`  無音カット失敗（スキップ）: ${e.message}`);
    if (!fs.existsSync(outputPath)) {
      fs.copyFileSync(inputPath, outputPath);
    }
  }
}

async function main() {
  // キーサーバーから APIキーを取得（ELEVENLABS_API_KEY が .env に直書きされていない場合）
  if (process.env["_USE_KEY_SERVER"] === "1") {
    await loadKeysFromServer();
  }

  const args = process.argv.slice(2);

  const projectIdx = args.indexOf("--project");
  if (projectIdx === -1 || !args[projectIdx + 1]) {
    console.error("Usage: npx tsx scripts/generate-audio.ts --project <作品フォルダパス> [--voice <voice_id>] [--parts 起,承] [--scenes 1,2,3]");
    process.exit(1);
  }
  const projectDir = args[projectIdx + 1];

  const voiceIdx = args.indexOf("--voice");
  const voiceId = voiceIdx !== -1 && args[voiceIdx + 1]
    ? args[voiceIdx + 1]
    : "oAlEJuW30knHWhA6cF0e"; // デフォルト: itsuki

  const partsIdx = args.indexOf("--parts");
  const partsFilter = partsIdx !== -1 && args[partsIdx + 1]
    ? args[partsIdx + 1].split(",")
    : null;

  const scenesIdx = args.indexOf("--scenes");
  const scenesFilter = scenesIdx !== -1 && args[scenesIdx + 1]
    ? args[scenesIdx + 1].split(",").map(Number)
    : null;

  const speedIdx = args.indexOf("--speed");
  const speed = speedIdx !== -1 && args[speedIdx + 1]
    ? parseFloat(args[speedIdx + 1])
    : 1.0;

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error("環境変数 ELEVENLABS_API_KEY を設定してください（.env ファイルに記載可）");
    process.exit(1);
  }

  const scenesPath = path.join(projectDir, "scenes_raw.json");
  if (!fs.existsSync(scenesPath)) {
    console.error("scenes_raw.json が見つかりません。先に parse-script.ts を実行してください。");
    process.exit(1);
  }

  let scenes: RawScene[] = JSON.parse(fs.readFileSync(scenesPath, "utf-8"));

  // 人物名のひらがな自動変換は無効化（イントネーションが崩れるため）
  // 誤読が確認された名前は pronunciation.json に個別登録する
  const characterNameMap: Record<string, string> = {};

  // 発音辞書の読み込み
  const pronunciationPath = path.join(projectDir, "pronunciation.json");
  let pronunciationMap: Record<string, string> = {};
  if (fs.existsSync(pronunciationPath)) {
    pronunciationMap = JSON.parse(fs.readFileSync(pronunciationPath, "utf-8"));
    console.log(`発音辞書: ${Object.keys(pronunciationMap).length}件 読み込み`);
  }

  /**
   * テキストに発音置換を適用し、元テキスト→置換後テキストの位置マッピングも返す。
   * posMap[i] = 元テキストの位置 i に対応する、置換後テキストでの位置
   */
  function applyPronunciationWithMapping(
    text: string,
    scannedMap: Record<string, string> = {}
  ): { result: string; posMap: number[] } {
    // 全置換ルールを優先順にまとめる（長い語句から先に適用）
    const allRules: Array<[string, string]> = [];

    // 0. 記号置換ルール
    //    「 → 削除（余計な間を防ぐ）
    //    」。 → 、に変換（間を短縮）
    //    三点リーダー、ダッシュ等 → 、に変換
    //    改行 → 削除（ElevenLabsがポーズとして解釈するのを防ぐ）
    const symbolToPeriod = /[」]+/g;
    const symbolToComma = /[…―─—–\-]+/g;
    const symbolToDelete = /[「『』\n]+/g;

    // 1. 人物名
    const sortedNames = Object.entries(characterNameMap).sort((a, b) => b[0].length - a[0].length);
    allRules.push(...sortedNames);

    // 2. 事前スキャン
    const sortedScan = Object.entries(scannedMap).sort((a, b) => b[0].length - a[0].length);
    allRules.push(...sortedScan);

    // 3. 発音辞書
    for (const [from, to] of Object.entries(pronunciationMap)) {
      allRules.push([from, to]);
    }

    // まず記号を置換し、位置マッピングを構築
    let current = text;
    // posMap[i] = current の位置 i が、元の text の何文字目に由来するか
    let originMap: number[] = Array.from({ length: text.length }, (_, i) => i);

    // テキスト末尾の句読点位置を特定（末尾の「。」「！」「？」は変換せず保持）
    const trimmed = current.trimEnd();
    const lastCharIdx = trimmed.length - 1;
    const lastChar = trimmed[lastCharIdx];
    const preserveLastPunct = lastCharIdx >= 0 && /[。！？]/.test(lastChar);

    // 記号置換: 「 → 削除（先頭は残す）、」。…― 等 → 、（末尾の句点は除く）
    {
      let newStr = "";
      let newOriginMap: number[] = [];
      let isFirstChar = true;
      for (let i = 0; i < current.length; i++) {
        const ch = current[i];
        // 末尾の句点はそのまま保持
        if (preserveLastPunct && i === lastCharIdx) {
          newStr += ch;
          newOriginMap.push(originMap[i]);
          continue;
        }
        symbolToDelete.lastIndex = 0;
        if (symbolToDelete.test(ch)) {
          if (isFirstChar) {
            // テキスト先頭の「は残す（音割れ防止）
            newStr += ch;
            newOriginMap.push(originMap[i]);
            isFirstChar = false;
            continue;
          }
          // それ以外の「は削除
          symbolToDelete.lastIndex = 0;
          continue;
        }
        isFirstChar = false;
        symbolToPeriod.lastIndex = 0;
        if (symbolToPeriod.test(ch)) {
          // 」 → 。
          symbolToPeriod.lastIndex = 0;
          newStr += "。";
          newOriginMap.push(originMap[i]);
        } else if ((symbolToComma.lastIndex = 0, symbolToComma.test(ch))) {
          // …― 等 → 、
          symbolToComma.lastIndex = 0;
          newStr += "、";
          newOriginMap.push(originMap[i]);
        } else {
          newStr += ch;
          newOriginMap.push(originMap[i]);
        }
      }
      current = newStr;
      originMap = newOriginMap;
    }

    // 連続する読点を1つにまとめる（「、、」→「、」）+ 末尾の読点を除去
    {
      let newStr = "";
      let newOriginMap: number[] = [];
      for (let i = 0; i < current.length; i++) {
        if (current[i] === "、" && i > 0 && (current[i - 1] === "、" || current[i - 1] === "。")) {
          continue; // 連続する読点、または「。」直後の読点をスキップ
        }
        if (current[i] === "。" && i > 0 && current[i - 1] === "。") {
          continue; // 連続する句点をスキップ
        }
        newStr += current[i];
        newOriginMap.push(originMap[i]);
      }
      // 末尾の読点を除去し、。に置き換え（尻切れ防止）
      while (newStr.endsWith("、")) {
        newStr = newStr.slice(0, -1);
        newOriginMap.pop();
      }
      if (!newStr.endsWith("。") && !newStr.endsWith("！") && !newStr.endsWith("？")) {
        newStr += "。";
        newOriginMap.push(originMap.length > 0 ? originMap[originMap.length - 1] : 0);
      }
      current = newStr;
      originMap = newOriginMap;
    }

    // 文字列置換ルールを順番に適用
    for (const [from, to] of allRules) {
      let newStr = "";
      let newOriginMap: number[] = [];
      let searchStart = 0;
      while (true) {
        const idx = current.indexOf(from, searchStart);
        if (idx === -1) {
          // 残りをそのままコピー
          for (let i = searchStart; i < current.length; i++) {
            newStr += current[i];
            newOriginMap.push(originMap[i]);
          }
          break;
        }
        // マッチ前の部分をコピー
        for (let i = searchStart; i < idx; i++) {
          newStr += current[i];
          newOriginMap.push(originMap[i]);
        }
        // 置換後の文字を追加（各文字はマッチ開始位置に対応）
        for (let i = 0; i < to.length; i++) {
          newStr += to[i];
          newOriginMap.push(originMap[idx]);
        }
        searchStart = idx + from.length;
      }
      current = newStr;
      originMap = newOriginMap;
    }

    // posMap: 元テキストの位置 → 置換後テキストの位置
    const posMap: number[] = new Array(text.length).fill(-1);
    for (let apiIdx = 0; apiIdx < originMap.length; apiIdx++) {
      const origIdx = originMap[apiIdx];
      if (posMap[origIdx] === -1) {
        posMap[origIdx] = apiIdx;
      }
    }
    // 未マッピングの位置を補間（削除された文字は次の有効な位置を使う）
    for (let i = posMap.length - 2; i >= 0; i--) {
      if (posMap[i] === -1) {
        posMap[i] = posMap[i + 1] !== undefined ? posMap[i + 1] : current.length;
      }
    }

    return { result: current, posMap };
  }

  // 後方互換: 位置マッピング不要な場合
  function applyPronunciation(text: string, scannedMap: Record<string, string> = {}): string {
    return applyPronunciationWithMapping(text, scannedMap).result;
  }

  if (partsFilter) {
    scenes = scenes.filter((s) => partsFilter.includes(s.part));
    console.log(`パートフィルター: ${partsFilter.join(",")} (${scenes.length} シーン)`);
  }
  if (scenesFilter) {
    scenes = scenes.filter((s) => scenesFilter.includes(s.id));
    console.log(`シーンフィルター: ${scenesFilter.join(",")} (${scenes.length} シーン)`);
  }

  const audioDir = path.join(projectDir, "audio");
  fs.mkdirSync(audioDir, { recursive: true });

  // 既存ファイルを確認してスキップ対象を除外
  const scenesToGenerate = scenes.filter((s) => {
    const filename = `scene_${String(s.id).padStart(3, "0")}.mp3`;
    return !fs.existsSync(path.join(audioDir, filename));
  });

  if (scenesToGenerate.length === 0) {
    console.log("全シーン生成済みです。");
    return;
  }

  // 事前スキャン: Gemini APIで読み間違えやすい語句を検出
  const geminiApiKey = process.env.GEMINI_API_KEY;
  let scanMap: Record<string, string> = {};
  if (geminiApiKey) {
    console.log("発音スキャン: Gemini APIで読み間違えやすい語句を検出中...");
    const textsToScan = scenesToGenerate.map((s) => s.text);
    scanMap = await scanPronunciation(textsToScan, geminiApiKey);
    if (Object.keys(scanMap).length > 0) {
      console.log(`発音スキャン: ${Object.keys(scanMap).length}件 検出`);
      for (const [k, v] of Object.entries(scanMap)) {
        console.log(`  ${k} → ${v}`);
      }
    } else {
      console.log("発音スキャン: 読み間違いの可能性がある語句は検出されませんでした");
    }
  } else {
    console.log("発音スキャン: GEMINI_API_KEY が未設定のためスキップ");
  }

  console.log(`\nモデル: ${MODEL_ID}`);
  console.log(`ボイスID: ${voiceId}`);
  console.log(`生成対象: ${scenesToGenerate.length} シーン（1シーンずつ個別生成）\n`);

  for (let i = 0; i < scenesToGenerate.length; i++) {
    const scene = scenesToGenerate[i];
    const { result: text, posMap } = applyPronunciationWithMapping(scene.text, scanMap);
    const pad = String(scene.id).padStart(3, "0");
    console.log(`[${i + 1}/${scenesToGenerate.length}] scene_${pad}...`);
    console.log(`  送信テキスト: ${text}`);

    try {
      const { audioBase64, alignment } = await generateWithTimestamps(text, voiceId, apiKey, speed);

      // 一時ファイルに生音声を保存し、末尾に0.3秒フェードアウトを適用
      const tmpRaw = path.join(os.tmpdir(), `elevenlabs_raw_${scene.id}.mp3`);
      fs.writeFileSync(tmpRaw, Buffer.from(audioBase64, "base64"));

      const outputPath = path.join(audioDir, `scene_${pad}.mp3`);
      const duration = parseFloat(
        execSync(`${FFMPEG_BIN}ffprobe -v error -show_entries format=duration -of csv=p=0 "${tmpRaw}"`, { encoding: "utf-8" }).trim()
      );
      const fadeStart = Math.max(0, duration - 0.05);
      const tmpFaded = path.join(os.tmpdir(), `elevenlabs_faded_${scene.id}.mp3`);
      execSync(
        `${FFMPEG_BIN}ffmpeg -y -i "${tmpRaw}" -af "apad=pad_dur=0.3,afade=t=out:st=${(duration + 0.25).toFixed(3)}:d=0.05" -q:a 2 "${tmpFaded}"`, { stdio: "ignore" }
      );
      fs.unlinkSync(tmpRaw);

      // 1000msを超える無音を1000msにカット
      trimLongSilences(tmpFaded, outputPath, 1000);
      if (fs.existsSync(tmpFaded)) fs.unlinkSync(tmpFaded);

      // alignmentからpageSwitchTimesを計算（posMapで正確な位置マッピングを使用）
      const pageSwitchTimes = computeExactPageSwitchTimes(scene.text, text, alignment.characters, alignment.character_start_times_seconds, [], posMap);

      const timingPath = path.join(audioDir, `scene_${pad}_timing.json`);
      fs.writeFileSync(timingPath, JSON.stringify({ pageSwitchTimes }), "utf-8");

      const size = fs.statSync(outputPath).size;
      console.log(`  → scene_${pad}.mp3 (${(size / 1024).toFixed(0)} KB)`);

    } catch (err: any) {
      console.error(`  ✗ エラー: ${err.message}`);
    }

    // API レート制限対策
    if (i < scenesToGenerate.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log(`\n完了`);
  console.log(`出力先: ${audioDir}`);
}

main();
