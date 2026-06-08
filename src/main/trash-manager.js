// 修正時の自動退避（ゴミ箱）管理
// 画像・音声ファイルが上書きされる前に .trash/ に退避する
//
// 注意：実際の退避処理は image-server / audio-server 側で行う必要がある（書き込み時にフック）
// ここではゴミ箱のクリーンアップと一覧取得のみ担当
const fs = require("fs");
const path = require("path");

const settings = require("./settings");

function trashDir(projectDir) {
  return path.join(projectDir, ".trash");
}

/**
 * 期限切れのゴミ箱ファイルを全プロジェクトから削除
 */
function purgeExpired() {
  const days = settings.get("trashRetentionDays") || 7;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = settings.getRecentProjects();

  let deleted = 0;
  for (const p of recent) {
    const dir = trashDir(p.workDir);
    if (!fs.existsSync(dir)) continue;

    walkAndDelete(dir, cutoff, (filePath) => {
      try {
        fs.unlinkSync(filePath);
        deleted++;
      } catch (e) {
        console.error(`ゴミ箱削除失敗: ${filePath}`, e.message);
      }
    });
  }
  return { deleted };
}

function walkAndDelete(dir, cutoffMs, onDelete) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndDelete(full, cutoffMs, onDelete);
      // 空ディレクトリは削除
      try {
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } catch {}
    } else {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoffMs) onDelete(full);
    }
  }
}

/**
 * 特定プロジェクトのゴミ箱内容を一覧表示
 */
function list(projectId) {
  const recent = settings.findRecentProject(projectId);
  if (!recent) return [];
  const dir = trashDir(recent.workDir);
  if (!fs.existsSync(dir)) return [];

  const items = [];
  walk(dir, dir, items);
  return items;
}

function walk(baseDir, currentDir, results) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(baseDir, full, results);
    } else {
      const stat = fs.statSync(full);
      results.push({
        id: path.relative(baseDir, full),
        name: entry.name,
        size: stat.size,
        deletedAt: stat.mtimeMs,
      });
    }
  }
}

/**
 * ゴミ箱から元の場所に復元
 * fileId は trashDir からの相対パス（例: "画像/生成画像/起/scene_001.png"）
 */
function restore(projectId, fileId) {
  const recent = settings.findRecentProject(projectId);
  if (!recent) throw new Error("プロジェクトが見つかりません");

  const src = path.join(trashDir(recent.workDir), fileId);
  const dest = path.join(recent.workDir, fileId);
  if (!fs.existsSync(src)) throw new Error(`ゴミ箱にファイルがありません: ${fileId}`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return { ok: true, restored: fileId };
}

module.exports = {
  purgeExpired,
  list,
  restore,
  trashDir,
};
