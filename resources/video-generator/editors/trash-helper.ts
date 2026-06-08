/**
 * 修正時の自動退避ヘルパー
 *
 * 画像・音声ファイルを上書きする前に、古いファイルを .trash/ に退避する。
 *
 * - PROXY_URL が設定されていない（オーナー直接実行）→ 退避しない（Google Drive版管理に任せる）
 * - AUTO_BACKUP=0 が設定されている → 退避しない
 * - それ以外 → .trash/ にタイムスタンプ付きで退避
 */
import * as fs from "fs";
import * as path from "path";

export function trashBeforeOverwrite(filePath: string, projectDir: string): void {
  // 既存ファイルがなければ何もしない（新規作成時）
  if (!fs.existsSync(filePath)) return;

  // 自動退避が無効化されていれば何もしない
  if (process.env.AUTO_BACKUP === "0") return;

  // Electronアプリ経由でない（PROXY_URL未設定）場合はスキップ
  // ※オーナー直接実行ではGoogle Drive側で版管理されているため
  if (!process.env.PROXY_URL && process.env.SKIP_TRASH_WITHOUT_PROXY !== "0") return;

  try {
    const rel = path.relative(projectDir, filePath);
    // プロジェクト外のファイルは退避しない
    if (rel.startsWith("..") || path.isAbsolute(rel)) return;

    const trashRoot = path.join(projectDir, ".trash");
    const trashTarget = path.join(trashRoot, rel);
    fs.mkdirSync(path.dirname(trashTarget), { recursive: true });

    // 同名の退避ファイルがあればタイムスタンプを付ける
    let finalPath = trashTarget;
    if (fs.existsSync(trashTarget)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = path.dirname(trashTarget);
      const base = path.basename(trashTarget, path.extname(trashTarget));
      const ext = path.extname(trashTarget);
      finalPath = path.join(dir, `${base}__${ts}${ext}`);
    }

    fs.renameSync(filePath, finalPath);
  } catch (e: any) {
    console.error(`[trash] 退避失敗: ${filePath}`, e.message);
    // 退避失敗時も上書きは続行（ユーザー作業を止めない）
  }
}
