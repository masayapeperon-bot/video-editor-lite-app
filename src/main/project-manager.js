// プロジェクトの読み込み・展開・納品書き出しを担当
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { app } = require("electron");
const extract = require("extract-zip");
const archiver = require("archiver");

const settings = require("./settings");

// 作業フォルダの取得（未設定ならデフォルト）
function getWorkRoot() {
  const custom = settings.get("workDir");
  if (custom && fs.existsSync(custom)) return custom;
  const def = path.join(app.getPath("userData"), "projects");
  if (!fs.existsSync(def)) fs.mkdirSync(def, { recursive: true });
  return def;
}

// プロジェクトIDをパスから安定的に生成（同じworkDirなら同じID）
function generateProjectId(workDir) {
  const hash = crypto.createHash("sha1").update(workDir).digest("hex").slice(0, 12);
  return `proj_${hash}`;
}

/**
 * zip または フォルダから プロジェクトを読み込んで作業フォルダに展開する
 */
async function loadProject(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`指定パスが存在しません: ${sourcePath}`);
  }

  const stat = fs.statSync(sourcePath);
  let title;
  let workDir;

  if (stat.isFile() && sourcePath.toLowerCase().endsWith(".zip")) {
    // zipの場合：展開（workDirはzipのファイル名から決定）
    title = path.basename(sourcePath, ".zip");
    workDir = path.join(getWorkRoot(), title);

    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });

    await extract(sourcePath, { dir: workDir });

    // zipの中が一段ネストしている場合（作品名/ファイル群）は中身を持ち上げる
    const entries = fs.readdirSync(workDir);
    if (entries.length === 1 && fs.statSync(path.join(workDir, entries[0])).isDirectory()) {
      const inner = path.join(workDir, entries[0]);
      // タイトルは内側のフォルダ名を優先
      title = entries[0];
      // 中身を一つ上に持ち上げ
      for (const f of fs.readdirSync(inner)) {
        fs.renameSync(path.join(inner, f), path.join(workDir, f));
      }
      fs.rmdirSync(inner);
    }
  } else if (stat.isDirectory()) {
    // フォルダの場合：そのまま参照（コピーしない）
    title = path.basename(sourcePath);
    workDir = sourcePath;
  } else {
    throw new Error("zipファイルまたはフォルダを指定してください");
  }

  // 整合性チェック
  validateProject(workDir);

  // プロジェクトIDは workDir から安定生成
  const projectId = generateProjectId(workDir);
  const project = {
    id: projectId,
    title,
    workDir,
    sourcePath,
    loadedAt: new Date().toISOString(),
  };

  // 作業フォルダに .gdrive_path を作らない（Google Drive連携は廃止）
  // 代わりにメタファイルを記録
  const metaPath = path.join(workDir, ".project-meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(project, null, 2));

  return project;
}

function validateProject(workDir) {
  // scenes_raw.json または scenes.json があればOK（最低限）
  const candidates = ["scenes.json", "scenes_raw.json"];
  if (!candidates.some((f) => fs.existsSync(path.join(workDir, f)))) {
    throw new Error("scenes.json または scenes_raw.json が見つかりません。正しい作品フォルダを指定してください。");
  }
}

async function openRecent(projectId) {
  const recent = settings.findRecentProject(projectId);
  if (!recent) throw new Error("プロジェクトが見つかりません");
  if (!fs.existsSync(recent.workDir)) {
    throw new Error(`作業フォルダが存在しません: ${recent.workDir}\n配布元から再度受け取ってください`);
  }
  return {
    id: recent.id,
    title: recent.title,
    workDir: recent.workDir,
    sourcePath: recent.sourcePath,
    loadedAt: new Date().toISOString(),
  };
}

/**
 * 納品zipを書き出す（output/MP4 + 全素材一式）
 *
 * Mac/Linux: システム標準の zip コマンドを使用（macOSアーカイブユーティリティで開ける）
 * Windows: archiver ライブラリでフォールバック
 */
async function exportDelivery(projectId, outPath) {
  const recent = settings.findRecentProject(projectId);
  if (!recent) throw new Error("プロジェクトが見つかりません");
  const workDir = recent.workDir;
  if (!fs.existsSync(workDir)) throw new Error(`作業フォルダがありません: ${workDir}`);

  // 既存のzipは削除（zip コマンドは追記モードのため）
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  const parent = path.dirname(workDir);
  const basename = path.basename(workDir);

  if (process.platform === "darwin" || process.platform === "linux") {
    // システム標準 zip コマンドを使用 → 文字化け・互換性問題なし
    const excludePatterns = [
      `${basename}/.trash/*`,
      `${basename}/.trash`,
      `${basename}/.project-meta.json`,
      `${basename}/.gdrive_path`,
      `${basename}/node_modules/*`,
      `${basename}/_run*.log`,
      `${basename}/_run*.err`,
      `${basename}/audio/*.bak`,
    ];

    // execFileSync で引数を配列渡し → シェル展開・特殊文字エスケープ問題を回避
    const { execFileSync } = require("child_process");
    const args = ["-r", outPath, basename];
    for (const p of excludePatterns) args.push("-x", p);

    try {
      execFileSync("zip", args, {
        cwd: parent,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 500,
      });
      return outPath;
    } catch (e) {
      // zip 失敗時：残った一時ファイルを掃除し、エラー詳細をユーザーに見せる
      try {
        const outDir = path.dirname(outPath);
        for (const f of fs.readdirSync(outDir)) {
          if (f.startsWith("zi") && !f.endsWith(".zip")) {
            try { fs.unlinkSync(path.join(outDir, f)); } catch {}
          }
        }
      } catch {}
      const stderr = e.stderr ? e.stderr.toString().slice(0, 500) : "";
      const stdout = e.stdout ? e.stdout.toString().slice(0, 200) : "";
      throw new Error(`zip コマンド失敗 (exit ${e.status}):\n${stderr || stdout || e.message}`);
    }
  }

  // Windows フォールバック: archiver
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => resolve(outPath));
    archive.on("error", reject);
    archive.pipe(output);

    const ignore = [
      ".project-meta.json",
      ".trash/**",
      ".trash",
      ".gdrive_path",
      "node_modules/**",
      "_run.log",
      "_run.err",
      "_run_*.log",
      "_run_*.err",
      "audio/*.bak",
    ];

    archive.glob("**/*", {
      cwd: workDir,
      dot: false,
      ignore,
    }, { prefix: basename });

    archive.finalize();
  });
}

module.exports = {
  loadProject,
  openRecent,
  exportDelivery,
  getWorkRoot,
};
