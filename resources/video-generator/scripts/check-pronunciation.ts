/**
 * 読み間違いチェックスクリプト
 *
 * 生成済み音声をWhisperで文字起こしし、元テキストと比較して
 * 読み間違いの可能性がある箇所を検出する。
 *
 * Mac (Apple Silicon): MLX Whisper（ローカル実行、無料）
 * Windows: OpenAI Whisper API（クラウド実行）
 *
 * Usage:
 *   npx tsx scripts/check-pronunciation.ts --project <作品フォルダパス> [--scenes 1,2,3]
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

// .env 読み込み
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
}

// キーサーバーからAPIキーを取得
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

interface RawScene {
  id: number;
  part: string;
  partSceneNumber: number;
  text: string;
}

const isMac = process.platform === "darwin";

/**
 * MLX Whisperでローカル文字起こし（Mac専用）
 */
// MLX Whisper の Python パスを検索
const MLX_PYTHON = (() => {
  const candidates = [
    "/tmp/whisper-env/bin/python3",
    path.join(os.homedir(), ".venv/whisper/bin/python3"),
    "python3",
  ];
  for (const p of candidates) {
    try {
      execSync(`${p} -c "import mlx_whisper"`, { stdio: "ignore" });
      return p;
    } catch {}
  }
  return null;
})();

function transcribeWithMLX(audioPath: string): string {
  if (!MLX_PYTHON) return "";
  try {
    const result = execSync(
      `${MLX_PYTHON} -c "
import mlx_whisper, json, sys
result = mlx_whisper.transcribe('${audioPath}', language='ja', path_or_hf_repo='mlx-community/whisper-large-v3-turbo')
print(result['text'])
"`,
      { encoding: "utf-8", timeout: 120000 }
    );
    return result.trim();
  } catch (err: any) {
    console.error(`  MLX Whisper エラー: ${err.message}`);
    return "";
  }
}

/**
 * OpenAI Whisper APIで文字起こし（Windows/フォールバック）
 */
async function transcribeWithAPI(
  audioPath: string,
  apiKey: string
): Promise<string> {
  const { FormData, File } = await import("node:buffer")
    .then(() => globalThis)
    .catch(() => globalThis);

  const audioData = fs.readFileSync(audioPath);
  const blob = new Blob([audioData], { type: "audio/mpeg" });

  const formData = new FormData();
  formData.append("file", blob, path.basename(audioPath));
  formData.append("model", "whisper-1");
  formData.append("language", "ja");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    }
  );

  if (!response.ok) {
    const err = await response.text();
    console.error(`  Whisper API エラー: ${response.status} ${err.slice(0, 200)}`);
    return "";
  }

  const json = (await response.json()) as { text: string };
  return json.text;
}

const GEMINI_COMPARE_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

/**
 * Gemini APIで元テキストと文字起こし結果を比較し、読み間違いのみを検出
 * 表記揺れ（漢字/カタカナ/ひらがな、数字表記、句読点の違い）は無視する
 */
async function compareTexts(
  original: string,
  transcribed: string,
  geminiApiKey: string
): Promise<{ hasDiff: boolean; details: string }> {
  const prompt = `以下の2つのテキストを比較し、「読み間違い」のみを検出してください。

【重要な前提】
文字起こしはWhisperによるもので、漢字の選択が不正確なことがあります。
比較の際は「発音（読み）が同じかどうか」だけに注目してください。
漢字の違いは一切無視してください。

【無視すべき差異（これらは読み間違いではない）】
- 漢字の選択の違い（Whisperの漢字変換ミス。例：甲高い vs 神高い、返って vs 帰って、血の気 vs 血の毛）
- 漢字/カタカナ/ひらがなの表記の違い（例：麻耶 vs マヤ、凪 vs ナギ、友たち vs 友達）
- 数字の表記の違い（例：1人 vs 一人、500万 vs 五百万）
- 句読点・記号の有無や違い（「」。、！？…など）
- 語尾の微妙な違い（例：〜ですよ vs 〜ですよね）
- 助詞の微妙な違い

【読み間違いとして報告すべきもの】
- 発音自体が明らかに違う（例：「ママ友会（ままともかい）」が「ママ誘拐（ままゆうかい）」になっている）
- 単語が抜けている（文の意味が変わるレベル）
- 余計な単語が追加されている（文の意味が変わるレベル）

【判断の基準】
両方の文を声に出して読んだとき、同じ発音になるなら読み間違いではない。
文字起こしの漢字はWhisperが推測したものであり、実際の発音と一致しないことが多い。
「甲高い」と「神高い」は両方「かんだかい」と読めるので、これは読み間違いではない。

元テキスト:
${original}

文字起こし結果:
${transcribed}

読み間違いがある場合のみ、以下のJSON形式で出力してください。ない場合は {} を返してください。
{"issues": [{"original": "元の語句", "heard": "聞こえた語句", "type": "misread/missing/extra"}]}`;

  try {
    const response = await fetch(`${GEMINI_COMPARE_URL}?key=${geminiApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
    });

    if (!response.ok) {
      // Gemini APIが使えない場合はフォールバック（単純比較）
      return simpleFallbackCompare(original, transcribed);
    }

    const json = (await response.json()) as any;
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { hasDiff: false, details: "" };

    const result = JSON.parse(jsonMatch[0]);
    if (!result.issues || result.issues.length === 0) {
      return { hasDiff: false, details: "" };
    }

    const details = result.issues
      .map((i: any) => `    「${i.original}」→「${i.heard}」(${i.type})`)
      .join("\n");
    return {
      hasDiff: true,
      details: `  元テキスト: ${original.replace(/\n/g, " ")}\n  文字起こし: ${transcribed}\n  問題箇所:\n${details}`,
    };
  } catch {
    return simpleFallbackCompare(original, transcribed);
  }
}

/** Gemini APIが使えない場合のフォールバック比較 */
function simpleFallbackCompare(
  original: string,
  transcribed: string
): { hasDiff: boolean; details: string } {
  const normalize = (t: string) =>
    t.replace(/[\s\n「」。、！？…―─—–\-\(\)（）・]/g, "").toLowerCase();
  const normOrig = normalize(original);
  const normTrans = normalize(transcribed);
  if (normOrig === normTrans) return { hasDiff: false, details: "" };
  return {
    hasDiff: true,
    details: `  元テキスト: ${original.replace(/\n/g, " ")}\n  文字起こし: ${transcribed}`,
  };
}

async function main() {
  // キーサーバーからAPIキーを取得
  if (!process.env.OPENAI_API_KEY && process.env.KEY_SERVER_URL) {
    await loadKeysFromServer();
  }

  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  if (projectIdx === -1 || !args[projectIdx + 1]) {
    console.error(
      "Usage: npx tsx scripts/check-pronunciation.ts --project <作品フォルダパス> [--scenes 1,2,3]"
    );
    process.exit(1);
  }
  const projectDir = args[projectIdx + 1];

  const scenesIdx = args.indexOf("--scenes");
  const scenesFilter =
    scenesIdx !== -1 && args[scenesIdx + 1]
      ? args[scenesIdx + 1].split(",").map(Number)
      : null;

  const scenesPath = path.join(projectDir, "scenes_raw.json");
  if (!fs.existsSync(scenesPath)) {
    console.error("scenes_raw.json が見つかりません。");
    process.exit(1);
  }

  let scenes: RawScene[] = JSON.parse(fs.readFileSync(scenesPath, "utf-8"));
  if (scenesFilter) {
    scenes = scenes.filter((s) => scenesFilter.includes(s.id));
  }

  const audioDir = path.join(projectDir, "audio");

  // 実行環境の判定
  const useMLX = isMac && MLX_PYTHON !== null;
  if (isMac && !useMLX) {
    console.log("MLX Whisper が未インストールです。Whisper APIを使用します。");
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!useMLX && !openaiKey) {
    console.error("OPENAI_API_KEY が設定されていません。");
    process.exit(1);
  }

  const geminiKey = process.env.GEMINI_API_KEY || "";

  console.log(`読み間違いチェック開始`);
  console.log(`方式: ${useMLX ? "MLX Whisper（ローカル）" : "Whisper API（クラウド）"}`);
  console.log(`対象: ${scenes.length} シーン\n`);

  const issues: Array<{ sceneId: number; details: string }> = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const pad = String(scene.id).padStart(3, "0");
    const audioPath = path.join(audioDir, `scene_${pad}.mp3`);

    if (!fs.existsSync(audioPath)) {
      console.log(`[${i + 1}/${scenes.length}] scene_${pad} — 音声なし、スキップ`);
      continue;
    }

    process.stdout.write(`[${i + 1}/${scenes.length}] scene_${pad}...`);

    let transcribed: string;
    if (useMLX) {
      transcribed = transcribeWithMLX(audioPath);
    } else {
      transcribed = await transcribeWithAPI(audioPath, openaiKey!);
      // APIレート制限対策
      if (i < scenes.length - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (!transcribed) {
      console.log(" 文字起こし失敗");
      continue;
    }

    const result = await compareTexts(scene.text, transcribed, geminiKey);
    if (result.hasDiff) {
      console.log(" ⚠ 差異あり");
      console.log(result.details);
      issues.push({ sceneId: scene.id, details: result.details });
    } else {
      console.log(" ✓ OK");
    }
  }

  console.log(`\n--- チェック完了 ---`);
  if (issues.length === 0) {
    console.log("読み間違いの可能性がある箇所はありませんでした。");
  } else {
    console.log(`⚠ ${issues.length} シーンで差異を検出:\n`);
    for (const issue of issues) {
      console.log(`シーン ${issue.sceneId}:`);
      console.log(issue.details);
      console.log();
    }
  }

  // 結果をファイルに保存
  const reportPath = path.join(projectDir, "pronunciation_check.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ checkedAt: new Date().toISOString(), issues }, null, 2),
    "utf-8"
  );
  console.log(`結果を保存: ${reportPath}`);
}

main();
