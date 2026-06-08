/**
 * 画像差し替えエディタ（Lite版） — バックエンドサーバー
 *
 * 外部で生成・修正した画像を取り込んでシーン画像を差し替える。
 * 画像生成APIは呼ばない（コストゼロ）。
 *
 * Usage:
 *   npx tsx image-server.ts --project <作品フォルダパス>
 *
 * ブラウザで http://localhost:3457 にアクセス
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { trashBeforeOverwrite } from "./trash-helper";

// ── 引数パース ──
const args = process.argv.slice(2);
const projectIdx = args.indexOf("--project");
if (projectIdx === -1 || !args[projectIdx + 1]) {
  console.error("Usage: npx tsx image-server.ts --project <作品フォルダパス>");
  process.exit(1);
}
const PROJECT_DIR = path.resolve(args[projectIdx + 1]);
const IMAGES_DIR = path.join(PROJECT_DIR, "画像", "生成画像");
const MODEL_IMAGES_DIR = path.join(PROJECT_DIR, "画像", "モデル画像");
const SCENES_RAW_PATH = path.join(PROJECT_DIR, "scenes_raw.json");

const PORT = 3457;
const PUBLIC_DIR = path.join(typeof __dirname !== "undefined" ? __dirname : import.meta.dirname, "public-image");
const EDIT_LOG_PATH = path.join(PROJECT_DIR, "edit_log.json");

// Remotion の public/images/ パス（差し替え時に自動コピー）
const REMOTION_IMAGES_DIR = path.resolve(
  typeof __dirname !== "undefined" ? __dirname : import.meta.dirname, "..", "public", "images"
);

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

/** パート別サブフォルダから画像を検索 */
function findSceneImage(part: string, sceneNum: number): string | null {
  const partDir = path.join(IMAGES_DIR, part);
  if (!fs.existsSync(partDir)) return null;
  const prefix = `${part}_scene_${String(sceneNum).padStart(2, "0")}_`;
  const files = fs.readdirSync(partDir);
  const match = files.find((f) => f.startsWith(prefix) && /\.(png|jpg|jpeg|webp)$/i.test(f));
  return match ? path.join(partDir, match) : null;
}

/** モデル画像一覧を取得（外注さんが作業時の参考表示用） */
function listModelImages(): { name: string; path: string }[] {
  if (!fs.existsSync(MODEL_IMAGES_DIR)) return [];
  const results: { name: string; path: string }[] = [];
  const scan = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scan(path.join(dir, entry.name));
      } else if (/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) {
        results.push({
          name: entry.name,
          path: path.join(dir, entry.name),
        });
      }
    }
  };
  scan(MODEL_IMAGES_DIR);
  return results;
}

function syncToRemotion(srcFile: string, filename: string) {
  try {
    if (fs.existsSync(REMOTION_IMAGES_DIR)) {
      const destFile = path.join(REMOTION_IMAGES_DIR, filename);
      fs.copyFileSync(srcFile, destFile);
      console.log(`  → Remotion同期: ${filename}`);
    }
  } catch (e: any) {
    console.warn(`  Remotion同期失敗: ${e.message}`);
  }
}

// ── MIME タイプ ──
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// ── HTTP ──
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch { reject(new Error("Invalid JSON")); }
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

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    // GET /api/scenes — シーン一覧（画像付き）
    if (pathname === "/api/scenes" && method === "GET") {
      const scenes = loadScenesRaw();
      const result = scenes.map((s) => {
        const imgPath = findSceneImage(s.part, s.partSceneNumber);
        return {
          id: s.id,
          part: s.part,
          partSceneNumber: s.partSceneNumber,
          text: s.text,
          hasImage: !!imgPath,
          imageName: imgPath ? path.basename(imgPath) : "",
        };
      });
      sendJson(res, result);
      return;
    }

    // GET /api/scenes/:id/image — シーン画像配信
    const imgMatch = pathname.match(/^\/api\/scenes\/(\d+)\/image$/);
    if (imgMatch && method === "GET") {
      const id = Number(imgMatch[1]);
      const scenes = loadScenesRaw();
      const scene = scenes.find((s) => s.id === id);
      if (!scene) { sendError(res, "Scene not found", 404); return; }
      const imgPath = findSceneImage(scene.part, scene.partSceneNumber);
      if (!imgPath) { sendError(res, "Image not found", 404); return; }
      const ext = path.extname(imgPath).toLowerCase();
      const stat = fs.statSync(imgPath);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": stat.size,
      });
      fs.createReadStream(imgPath).pipe(res);
      return;
    }

    // GET /api/model-images — モデル画像一覧（作業時の参考表示用）
    if (pathname === "/api/model-images" && method === "GET") {
      const models = listModelImages();
      sendJson(res, models.map((m) => ({ name: m.name })));
      return;
    }

    // GET /api/model-images/:name — モデル画像配信
    const modelMatch = pathname.match(/^\/api\/model-images\/(.+)$/);
    if (modelMatch && method === "GET") {
      const name = modelMatch[1];
      const models = listModelImages();
      const model = models.find((m) => m.name === name);
      if (!model) { sendError(res, "Model image not found", 404); return; }
      const ext = path.extname(model.path).toLowerCase();
      const stat = fs.statSync(model.path);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": stat.size,
      });
      fs.createReadStream(model.path).pipe(res);
      return;
    }

    // POST /api/scenes/:id/upload-image — 取り込んだ画像で差し替え
    // body: { imageBase64: string }  ※UI側でCanvasで1376×768にリサイズ済みPNGを渡す前提
    const uploadMatch = pathname.match(/^\/api\/scenes\/(\d+)\/upload-image$/);
    if (uploadMatch && method === "POST") {
      const id = Number(uploadMatch[1]);
      const scenes = loadScenesRaw();
      const scene = scenes.find((s) => s.id === id);
      if (!scene) { sendError(res, "Scene not found", 404); return; }

      const body = await parseBody(req);
      if (!body.imageBase64) { sendError(res, "imageBase64 is required"); return; }

      const imgPath = findSceneImage(scene.part, scene.partSceneNumber);
      if (!imgPath) { sendError(res, "Original image path not found", 404); return; }

      // 元ファイル名のまま上書き保存（拡張子も維持）
      trashBeforeOverwrite(imgPath, PROJECT_DIR);
      fs.writeFileSync(imgPath, Buffer.from(body.imageBase64, "base64"));
      syncToRemotion(imgPath, path.basename(imgPath));

      appendEditLog({
        scene: id,
        type: "image_upload",
        image: path.basename(imgPath),
        sourceName: body.sourceName || "",
      });

      console.log(`✓ 画像差し替え: scene ${id} → ${path.basename(imgPath)}`);
      sendJson(res, { ok: true });
      return;
    }

    // ── 静的ファイル配信 ──
    let filePath = pathname === "/" ? "/index.html" : pathname;
    const fullPath = path.join(PUBLIC_DIR, filePath);
    if (!fullPath.startsWith(PUBLIC_DIR)) { sendError(res, "Forbidden", 403); return; }
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
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
  console.log(`プロジェクト: ${PROJECT_DIR}`);
  console.log(`画像フォルダ: ${IMAGES_DIR}`);
  console.log(`モデル画像: ${MODEL_IMAGES_DIR}`);

  const scenes = loadScenesRaw();
  const withImages = scenes.filter((s) => findSceneImage(s.part, s.partSceneNumber)).length;
  console.log(`シーン数: ${scenes.length} (画像あり: ${withImages})`);

  const models = listModelImages();
  console.log(`モデル画像: ${models.length}枚`);

  server.listen(PORT, () => {
    console.log(`\n画像差し替えエディタ起動: http://localhost:${PORT}`);
  });
}

start();
