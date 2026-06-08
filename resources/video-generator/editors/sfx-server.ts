/**
 * 効果音差し替えエディタサーバー
 *
 * Usage:
 *   npx tsx editors/sfx-server.ts --project <作品フォルダパス>
 *
 * Port: 3458
 *
 * シーン音声の一部区間を、ローカルの効果音ファイルに完全差し替えする
 * エディタを提供する。波形上で範囲指定 → 効果音ファイル読み込み →
 * 使用区間調整 → フェードアウト設定 → scenes.json に保存。
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";

const PORT = 3459;
const HOST = "127.0.0.1";

// ── 引数 ──
const args = process.argv.slice(2);
const projectIdx = args.indexOf("--project");
if (projectIdx === -1 || !args[projectIdx + 1]) {
  console.error("Usage: npx tsx editors/sfx-server.ts --project <作品フォルダパス>");
  process.exit(1);
}
const PROJECT_DIR = path.resolve(args[projectIdx + 1]);
const AUDIO_DIR = path.join(PROJECT_DIR, "audio");
const SFX_DIR = path.join(PROJECT_DIR, "sfx");
const SCENES_JSON_PATH = path.join(PROJECT_DIR, "scenes.json");
const HERE = typeof __dirname !== "undefined" ? __dirname : (import.meta as any).dirname;
const STATIC_DIR = path.join(HERE, "public-sfx");

if (!fs.existsSync(SCENES_JSON_PATH)) {
  console.error(`scenes.json が見つかりません: ${SCENES_JSON_PATH}`);
  process.exit(1);
}

// sfx ディレクトリは存在しない場合に作成
if (!fs.existsSync(SFX_DIR)) {
  fs.mkdirSync(SFX_DIR, { recursive: true });
}

// ── ユーティリティ ──
function readScenes(): any[] {
  return JSON.parse(fs.readFileSync(SCENES_JSON_PATH, "utf-8"));
}

function writeScenes(scenes: any[]): void {
  fs.writeFileSync(SCENES_JSON_PATH, JSON.stringify(scenes, null, 2), "utf-8");
}

function safeFilename(name: string): string {
  // パス区切り除去・特殊文字を簡易置換
  return name.replace(/[\/\\\0:*?"<>|]/g, "_").slice(0, 200);
}

function uniqueFilename(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}_${i}${ext}`;
    i++;
  }
  return candidate;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".ogg": return "audio/ogg";
    case ".m4a": return "audio/mp4";
    case ".flac": return "audio/flac";
    default: return "application/octet-stream";
  }
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Filename",
};

function jsonResponse(res: http.ServerResponse, status: number, data: any) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString("utf-8"));
}

function serveFile(res: http.ServerResponse, filePath: string) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, CORS_HEADERS);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      ...CORS_HEADERS,
    });
    res.end(data);
  });
}

// ── ハンドラ ──
async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  try {
    // ── API ──
    // シーン一覧
    if (pathname === "/api/scenes" && req.method === "GET") {
      const scenes = readScenes();
      const list = scenes.map((s) => ({
        id: s.id,
        part: s.part,
        text: s.text,
        durationSec: s.durationSec,
        hasAudio: !!s.audio,
        sfxCount: Array.isArray(s.soundEffects) ? s.soundEffects.length : 0,
      }));
      return jsonResponse(res, 200, list);
    }

    // シーン詳細
    const sceneMatch = pathname.match(/^\/api\/scenes\/(\d+)$/);
    if (sceneMatch && req.method === "GET") {
      const id = parseInt(sceneMatch[1], 10);
      const scenes = readScenes();
      const s = scenes.find((x) => x.id === id);
      if (!s) return jsonResponse(res, 404, { error: "Scene not found" });
      return jsonResponse(res, 200, {
        id: s.id,
        part: s.part,
        text: s.text,
        audio: s.audio,
        durationSec: s.durationSec,
        pageSwitchTimes: s.pageSwitchTimes ?? null,
        manualPages: s.manualPages ?? null,
        soundEffects: s.soundEffects ?? [],
      });
    }

    // シーンのSFX設定を保存（配列で完全置き換え）
    const sfxSaveMatch = pathname.match(/^\/api\/scenes\/(\d+)\/sfx$/);
    if (sfxSaveMatch && req.method === "PUT") {
      const id = parseInt(sfxSaveMatch[1], 10);
      const body = await readJsonBody(req);
      const sfxList = Array.isArray(body.soundEffects) ? body.soundEffects : [];

      const scenes = readScenes();
      const idx = scenes.findIndex((x) => x.id === id);
      if (idx === -1) return jsonResponse(res, 404, { error: "Scene not found" });

      if (sfxList.length === 0) {
        delete scenes[idx].soundEffects;
      } else {
        // 簡易バリデーション
        for (const sfx of sfxList) {
          if (typeof sfx.file !== "string" || !sfx.file) {
            return jsonResponse(res, 400, { error: "file is required" });
          }
          if (typeof sfx.insertAtSec !== "number" || sfx.insertAtSec < 0) {
            return jsonResponse(res, 400, { error: "invalid insertAtSec" });
          }
          if (typeof sfx.muteDurationSec !== "number" || sfx.muteDurationSec <= 0) {
            return jsonResponse(res, 400, { error: "invalid muteDurationSec" });
          }
          if (typeof sfx.sfxStartSec !== "number" || sfx.sfxStartSec < 0) {
            return jsonResponse(res, 400, { error: "invalid sfxStartSec" });
          }
          if (typeof sfx.sfxEndSec !== "number" || sfx.sfxEndSec <= sfx.sfxStartSec) {
            return jsonResponse(res, 400, { error: "invalid sfxEndSec" });
          }
          sfx.fadeOut = !!sfx.fadeOut;
        }
        scenes[idx].soundEffects = sfxList;
      }
      writeScenes(scenes);
      return jsonResponse(res, 200, { ok: true });
    }

    // 効果音ファイル一覧（再利用用）
    if (pathname === "/api/sfx-files" && req.method === "GET") {
      const entries = fs.existsSync(SFX_DIR)
        ? fs.readdirSync(SFX_DIR).filter((f) => /\.(mp3|wav|ogg|m4a|flac)$/i.test(f))
        : [];
      return jsonResponse(res, 200, entries.map((name) => ({
        name,
        path: `sfx/${name}`,
      })));
    }

    // 効果音ファイルアップロード
    if (pathname === "/api/upload-sfx" && req.method === "POST") {
      const rawName = (req.headers["x-filename"] as string | undefined) || "sfx.mp3";
      const safe = safeFilename(decodeURIComponent(rawName));
      const finalName = uniqueFilename(SFX_DIR, safe);
      const buf = await readBody(req);
      fs.writeFileSync(path.join(SFX_DIR, finalName), buf);
      return jsonResponse(res, 200, {
        name: finalName,
        path: `sfx/${finalName}`,
      });
    }

    // 効果音ファイル削除
    const sfxDeleteMatch = pathname.match(/^\/api\/sfx-files\/(.+)$/);
    if (sfxDeleteMatch && req.method === "DELETE") {
      const name = decodeURIComponent(sfxDeleteMatch[1]);
      const safe = safeFilename(name);
      const fullPath = path.join(SFX_DIR, safe);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        return jsonResponse(res, 200, { ok: true });
      }
      return jsonResponse(res, 404, { error: "Not found" });
    }

    // ── 静的：音声・効果音ファイル配信 ──
    if (pathname.startsWith("/audio/")) {
      const filename = decodeURIComponent(pathname.slice("/audio/".length));
      const fullPath = path.join(AUDIO_DIR, filename);
      if (fullPath.startsWith(AUDIO_DIR) && fs.existsSync(fullPath)) {
        return serveFile(res, fullPath);
      }
      res.writeHead(404, CORS_HEADERS);
      return res.end("Not Found");
    }

    if (pathname.startsWith("/sfx/")) {
      const filename = decodeURIComponent(pathname.slice("/sfx/".length));
      const fullPath = path.join(SFX_DIR, filename);
      if (fullPath.startsWith(SFX_DIR) && fs.existsSync(fullPath)) {
        return serveFile(res, fullPath);
      }
      res.writeHead(404, CORS_HEADERS);
      return res.end("Not Found");
    }

    // ── 静的：フロントエンドファイル配信 ──
    let staticPath = pathname === "/" ? "/index.html" : pathname;
    const fullPath = path.join(STATIC_DIR, staticPath);
    if (fullPath.startsWith(STATIC_DIR) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return serveFile(res, fullPath);
    }

    // フォールバック（SPA）
    const indexPath = path.join(STATIC_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      return serveFile(res, indexPath);
    }
    res.writeHead(404, CORS_HEADERS);
    res.end("Not Found");
  } catch (e: any) {
    console.error("[sfx-server] error:", e);
    return jsonResponse(res, 500, { error: e?.message ?? "Internal Server Error" });
  }
}

const server = http.createServer(handle);
server.listen(PORT, HOST, () => {
  console.log(`[sfx-server] http://${HOST}:${PORT}`);
  console.log(`[sfx-server] project: ${PROJECT_DIR}`);
  console.log(`[sfx-server] sfx dir: ${SFX_DIR}`);
});
