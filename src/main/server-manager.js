// 内部サーバー（音声・画像エディタ、Remotion Studio）の起動・停止
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { app } = require("electron");

const settings = require("./settings");

let procs = [];

/**
 * 既存の競合プロセス・ポートを掃除する
 * 別フォルダから起動した Remotion・エディタが残っていると衝突するため、
 * 起動前に強制的に排除する
 */
function cleanupConflictingProcesses() {
  if (process.platform === "win32") {
    // Windows: 各ポートを使用しているプロセスのPIDを netstat で取得し taskkill で終了
    const ports = [3000, 3456, 3457, 3459];
    for (const port of ports) {
      try {
        const out = execSync(`netstat -ano -p TCP`, { encoding: "utf8" });
        const lines = out.split(/\r?\n/);
        const pids = new Set();
        for (const line of lines) {
          // 例: "  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   12345"
          const m = line.match(new RegExp(`[:\\.]${port}\\b.*?(\\d+)\\s*$`));
          if (m) pids.add(m[1]);
        }
        for (const pid of pids) {
          try { execSync(`taskkill /F /PID ${pid} /T`, { stdio: "ignore" }); } catch {}
        }
      } catch {}
    }
    // 念のため Video Editor の子プロセス（node.exe / remotion.exe / esbuild.exe）も殺す
    // ※自分自身（Video Editor.exe）は殺さない
    const killNames = ["remotion.exe", "esbuild.exe"];
    for (const name of killNames) {
      try { execSync(`taskkill /F /IM "${name}" /T`, { stdio: "ignore" }); } catch {}
    }
  } else {
    // Mac/Linux
    const cleanupCmds = [
      `pkill -9 -f "remotion.*studio" 2>/dev/null`,
      `pkill -9 -f "audio-server.ts" 2>/dev/null`,
      `pkill -9 -f "image-server.ts" 2>/dev/null`,
      `pkill -9 -f "sfx-server.ts" 2>/dev/null`,
      `pkill -9 -f "editor-server.ts" 2>/dev/null`,
      `lsof -ti:3000 -ti:3456 -ti:3457 -ti:3459 2>/dev/null | xargs kill -9 2>/dev/null`,
    ];
    for (const cmd of cleanupCmds) {
      try { execSync(cmd, { stdio: "ignore" }); } catch {}
    }
  }
}

// バンドルされた video-generator フォルダのパスを取得
function getVideoGeneratorPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "video-generator");
  }
  // 開発時：resources/video-generator を見る
  return path.join(__dirname, "..", "..", "resources", "video-generator");
}

// バンドルされた node を取得（Electronのnodeを流用）
function getNodePath() {
  // Electron実行ファイル自体をnodeとして使う
  return process.execPath;
}

// 環境変数を作成（プロキシ情報・ffmpegパスを渡す）
function buildEnv(projectDir) {
  const proxyUrl = settings.get("proxyUrl");
  const proxyToken = settings.get("proxyToken");
  const env = { ...process.env };
  if (proxyUrl) env.PROXY_URL = proxyUrl;
  if (proxyToken) env.PROXY_TOKEN = proxyToken;
  env.PROJECT_DIR = projectDir;
  env.ELECTRON_RUN_AS_NODE = "1"; // Electron実行ファイルをnodeとして動かす

  // ffmpeg / ffprobe の絶対パスを通す（バンドル済みバイナリを使用）
  try {
    const ffmpegStatic = require("ffmpeg-static");
    const ffprobeStatic = require("ffprobe-static");
    if (ffmpegStatic) env.FFMPEG_BIN = resolveBundledBin(ffmpegStatic);
    if (ffprobeStatic && ffprobeStatic.path) env.FFPROBE_BIN = resolveBundledBin(ffprobeStatic.path);
  } catch (e) {
    console.error("ffmpeg-static / ffprobe-static の読み込み失敗:", e.message);
  }

  // ゴミ箱機能の設定
  if (settings.get("autoBackup") === false) env.AUTO_BACKUP = "0";

  return env;
}

// パッケージ化後はasar内に置けないのでresources側に展開される。パスを補正する。
function resolveBundledBin(p) {
  if (app.isPackaged && p.includes("app.asar")) {
    return p.replace("app.asar", "app.asar.unpacked");
  }
  return p;
}

// サブプロセス起動ヘルパー
function spawnNode(scriptPath, args, env, label, cwd) {
  const proc = spawn(getNodePath(), [scriptPath, ...args], {
    env,
    cwd: cwd || undefined,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => console.log(`[${label}]`, d.toString().trim()));
  proc.stderr.on("data", (d) => console.error(`[${label} ERR]`, d.toString().trim()));
  proc.on("exit", (code) => console.log(`[${label}] exited with code ${code}`));
  procs.push({ label, proc });
  return proc;
}

/**
 * プロジェクトに対して全てのサーバーを起動する
 * - 音声・字幕エディタ (3456)
 * - 画像エディタ (3457)
 * - Remotion Studio (3000)
 *
 * @param {string} projectId
 */
async function startAll(projectId) {
  // 既存プロセス停止（このアプリが起動したもの）
  stopAll();
  // 他フォルダから起動された競合プロセス・占有ポートを掃除
  cleanupConflictingProcesses();
  // 掃除が反映されるまで少し待つ
  await new Promise((r) => setTimeout(r, 1000));

  const recent = settings.findRecentProject(projectId);
  if (!recent) throw new Error("プロジェクトが見つかりません");
  const projectDir = recent.workDir;
  if (!fs.existsSync(projectDir)) throw new Error(`作業フォルダがありません: ${projectDir}`);

  const vgPath = getVideoGeneratorPath();
  if (!fs.existsSync(vgPath)) {
    throw new Error(`video-generatorが見つかりません: ${vgPath}`);
  }

  // scenes.json と images/ リンクをプロジェクトに作る（Remotion 用）
  await prepareRemotionLinks(projectDir, vgPath);

  const env = buildEnv(projectDir);

  // tsx は node_modules/.bin にある
  const tsxPath = path.join(vgPath, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxPath)) {
    throw new Error(`tsx が見つかりません: ${tsxPath}\nresources/video-generator/node_modules が同梱されているか確認してください`);
  }

  // 音声・字幕エディタ
  spawnNode(tsxPath, [
    path.join(vgPath, "editors", "audio-server.ts"),
    "--project", projectDir,
  ], env, "audio-server");

  // 画像エディタ
  spawnNode(tsxPath, [
    path.join(vgPath, "editors", "image-server.ts"),
    "--project", projectDir,
  ], env, "image-server");

  // 効果音エディタ
  spawnNode(tsxPath, [
    path.join(vgPath, "editors", "sfx-server.ts"),
    "--project", projectDir,
  ], env, "sfx-server");

  // Remotion Studio（バンドルされた朗読版のsrc/index.tsを使用するためcwd固定）
  // --browser=none でブラウザ自動起動を抑制（アプリ内webviewと重複するため）
  const remotionCli = path.join(vgPath, "node_modules", "@remotion", "cli", "remotion-cli.js");
  if (fs.existsSync(remotionCli)) {
    const remotionEnv = { ...env, REMOTION_PROJECT_DIR: projectDir, BROWSER: "none" };
    spawnNode(remotionCli, ["studio", "--browser=none"], remotionEnv, "remotion", vgPath);
  }

  // 起動完了まで少し待つ
  await new Promise((r) => setTimeout(r, 3000));

  return {
    audio: 3456,
    image: 3457,
    sfx: 3459,
    remotion: 3000,
  };
}

function stopAll() {
  for (const { label, proc } of procs) {
    try {
      if (process.platform === "win32") {
        // Windowsは proc.kill() だと子プロセス（Node.jsから起動したesbuild等）が残るため
        // taskkill /T で子プロセスツリーごと殺す
        try { execSync(`taskkill /F /PID ${proc.pid} /T`, { stdio: "ignore" }); } catch {}
      } else {
        proc.kill();
      }
      console.log(`[${label}] stopped`);
    } catch (e) {
      console.error(`[${label}] stop error:`, e.message);
    }
  }
  procs = [];
  // Windowsはポート占有確認用に念のため再クリーンアップ
  if (process.platform === "win32") {
    cleanupConflictingProcesses();
  }
}

// Remotion が読み込めるように scenes.json と images/ リンクを作る
// userDataにログを残し、何が失敗したか検証可能にする
async function prepareRemotionLinks(projectDir, vgPath) {
  const logFile = path.join(app.getPath("userData"), "remotion-links.log");
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(logFile, line); } catch {}
    console.log("[prepareRemotionLinks]", msg);
  };

  log(`projectDir=${projectDir}`);
  log(`vgPath=${vgPath}`);

  // public/ フォルダに各種リソースをリンク
  const publicDir = path.join(vgPath, "public");
  try {
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
    log(`publicDir prepared: ${publicDir}`);
  } catch (e) {
    log(`ERROR: publicDir 作成失敗: ${e.message}`);
    throw new Error(`バンドル内 public/ フォルダの作成に失敗しました: ${e.message}`);
  }

  // ファイル単位リンク
  const linkOne = (src, dest) => {
    if (!fs.existsSync(src)) { log(`skip (src missing): ${src}`); return; }
    try {
      if (fs.lstatSync(dest, { throwIfNoEntry: false })) fs.unlinkSync(dest);
    } catch {}
    try {
      if (process.platform === "win32") {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) fs.symlinkSync(src, dest, "junction");
        else fs.copyFileSync(src, dest);
      } else {
        fs.symlinkSync(src, dest);
      }
      log(`linked: ${dest}`);
    } catch (e) {
      log(`ERROR: link failed ${dest}: ${e.message}`);
    }
  };

  linkOne(path.join(projectDir, "scenes.json"), path.join(publicDir, "scenes.json"));
  linkOne(path.join(projectDir, "scenes.json"), path.join(vgPath, "src", "scenes.json"));
  linkOne(path.join(projectDir, "audio"), path.join(publicDir, "audio"));
  linkOne(path.join(projectDir, "videos"), path.join(publicDir, "videos"));
  // 効果音フォルダ（sfx-server が起動時に作成する）
  const sfxDir = path.join(projectDir, "sfx");
  try { if (!fs.existsSync(sfxDir)) fs.mkdirSync(sfxDir, { recursive: true }); } catch {}
  linkOne(sfxDir, path.join(publicDir, "sfx"));

  // 画像のフラット配置：起承転結フォルダ内の画像を public/images/ にリンク
  const imagesDir = path.join(publicDir, "images");
  try {
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
  } catch (e) {
    log(`ERROR: imagesDir 作成失敗: ${e.message}`);
  }

  let imageCount = 0;
  for (const part of ["起", "承", "転", "結"]) {
    const partDir = path.join(projectDir, "画像", "生成画像", part);
    if (!fs.existsSync(partDir)) { log(`skip part: ${part} (no dir)`); continue; }
    let entries;
    try { entries = fs.readdirSync(partDir); } catch (e) {
      log(`ERROR: readdir failed ${partDir}: ${e.message}`); continue;
    }
    for (const f of entries) {
      const src = path.join(partDir, f);
      const dest = path.join(imagesDir, f);
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        if (process.platform === "win32") fs.copyFileSync(src, dest);
        else fs.symlinkSync(src, dest);
        imageCount++;
      } catch (e) {
        log(`ERROR: image link failed ${dest}: ${e.message}`);
      }
    }
  }
  log(`画像リンク作成: ${imageCount}個`);

  // 検証：scenes.json リンクが実際に解決できるか
  const scenesLink = path.join(publicDir, "scenes.json");
  if (!fs.existsSync(scenesLink)) {
    log(`CRITICAL: scenes.json link not resolvable at ${scenesLink}`);
    throw new Error(`Remotion用のscenes.jsonリンクが作成できませんでした。\n詳細ログ: ${logFile}`);
  }
  log("OK: scenes.json link verified");
}

module.exports = {
  startAll,
  stopAll,
  getVideoGeneratorPath,
};
