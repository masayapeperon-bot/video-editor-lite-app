/**
 * シーン差し替えツール
 *
 * scenes.json の指定シーンをKling動画（1本）に差し替える。
 * 複数シーンが1本の動画を時間分割で担当するよう videoStartSec を自動計算する。
 *
 * Usage:
 *   npx tsx scripts/replace-scenes.ts --project <作品フォルダパス> --scenes 1-3 --video <動画ファイルパス>
 *   npx tsx scripts/replace-scenes.ts --project <作品フォルダパス> --scenes 1,2,3 --video <動画ファイルパス>
 *
 * 例：
 *   シーン1〜3（合計15秒）を kling.mp4 に差し替える場合：
 *   → シーン1: videoStartSec=0, シーン2: videoStartSec=5.2, シーン3: videoStartSec=10.1
 */

import * as fs from "fs";
import * as path from "path";
import type { SceneData } from "../src/types";

/** "1-3" または "1,2,3" 形式のシーン指定を数値配列に変換 */
function parseSceneIds(scenesArg: string): number[] {
  if (scenesArg.includes("-")) {
    const parts = scenesArg.split("-").map(Number);
    const [start, end] = parts;
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }
  return scenesArg.split(",").map(Number);
}

function main() {
  const args = process.argv.slice(2);

  const projectIdx = args.indexOf("--project");
  const scenesIdx = args.indexOf("--scenes");
  const videoIdx = args.indexOf("--video");

  if (projectIdx === -1 || !args[projectIdx + 1] ||
      scenesIdx === -1 || !args[scenesIdx + 1] ||
      videoIdx === -1 || !args[videoIdx + 1]) {
    console.error(
      "Usage: npx tsx scripts/replace-scenes.ts --project <パス> --scenes 1-3 --video <動画ファイルパス>"
    );
    process.exit(1);
  }

  const projectDir = args[projectIdx + 1];
  const sceneIds = parseSceneIds(args[scenesIdx + 1]).sort((a, b) => a - b);
  const videoSrc = args[videoIdx + 1];

  // scenes.json を読み込む
  const scenesPath = path.join(projectDir, "scenes.json");
  if (!fs.existsSync(scenesPath)) {
    console.error("scenes.json が見つかりません。先に build-scenes.ts を実行してください。");
    process.exit(1);
  }

  if (!fs.existsSync(videoSrc)) {
    console.error(`動画ファイルが見つかりません: ${videoSrc}`);
    process.exit(1);
  }

  // videos フォルダへコピー（まだそこにない場合）
  const videosDir = path.join(projectDir, "videos");
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }

  const videoFileName = path.basename(videoSrc);
  const destPath = path.join(videosDir, videoFileName);
  if (path.resolve(videoSrc) !== path.resolve(destPath) && !fs.existsSync(destPath)) {
    fs.copyFileSync(videoSrc, destPath);
    console.log(`動画ファイルをコピーしました: ${destPath}`);
  }

  const scenes: SceneData[] = JSON.parse(fs.readFileSync(scenesPath, "utf-8"));

  // 対象シーンに videoStartSec を設定
  let videoStartSec = 0;
  for (const sceneId of sceneIds) {
    const idx = scenes.findIndex(s => s.id === sceneId);
    if (idx === -1) {
      console.warn(`  [!] シーン ${sceneId} が見つかりません。スキップします`);
      continue;
    }
    const scene = scenes[idx];
    scenes[idx] = {
      ...scene,
      video: `videos/${videoFileName}`,
      videoStartSec,
    };
    console.log(`  シーン ${sceneId}: videoStartSec=${videoStartSec.toFixed(2)}s (${scene.durationSec.toFixed(2)}s 担当)`);
    videoStartSec += scene.durationSec;
  }

  fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2), "utf-8");

  console.log(`\n✓ scenes.json を更新しました`);
  console.log(`  対象シーン: ${sceneIds.join(", ")}`);
  console.log(`  動画ファイル: ${videoFileName}`);
  console.log(`  動画合計使用時間: ${videoStartSec.toFixed(2)}s`);
  console.log(`\n次のステップ: Remotionでレンダリングを実行してください`);
  console.log(`  npx remotion render StoryVideo --props "{...}" out/StoryVideo.mp4`);
}

main();
