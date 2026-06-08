/**
 * 冒頭フック動画結合スクリプト
 *
 * Klingで生成したフック動画をRemotionレンダリング済み動画の頭に結合する。
 * 解像度・FPSをRemotionの設定（1920x1080、30fps）に統一して再エンコード。
 *
 * Usage:
 *   npx tsx scripts/concat-hook.ts --hook <hook動画パス> --main <Remotion出力動画パス> --output <最終出力パス>
 *
 * 例:
 *   npx tsx scripts/concat-hook.ts \
 *     --hook "../感動系/2.動画制作/兄妹元ヤクザうどん屋/hook.mp4" \
 *     --main "out/StoryVideo.mp4" \
 *     --output "out/final.mp4"
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

function getArg(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function main() {
  const args = process.argv.slice(2);

  const hookPath = getArg(args, "--hook");
  const mainPath = getArg(args, "--main");
  const outputPath = getArg(args, "--output");

  if (!hookPath || !mainPath || !outputPath) {
    console.error(
      "Usage: npx tsx scripts/concat-hook.ts --hook <hook.mp4> --main <main.mp4> --output <output.mp4>"
    );
    process.exit(1);
  }

  if (!fs.existsSync(hookPath)) {
    console.error(`フック動画が見つかりません: ${hookPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(mainPath)) {
    console.error(`メイン動画が見つかりません: ${mainPath}`);
    process.exit(1);
  }

  const tmpDir = os.tmpdir();
  const tmpHook = path.join(tmpDir, "hook_normalized.mp4");
  const tmpMain = path.join(tmpDir, "main_normalized.mp4");
  const concatList = path.join(tmpDir, "concat_list.txt");

  console.log("フック動画を正規化中...");
  execSync(
    `ffmpeg -y -i "${hookPath}" -vf "scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2" -r ${FPS} -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -ar 44100 -ac 2 "${tmpHook}" 2>/dev/null`
  );

  console.log("メイン動画を正規化中...");
  execSync(
    `ffmpeg -y -i "${mainPath}" -vf "scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2" -r ${FPS} -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -ar 44100 -ac 2 "${tmpMain}" 2>/dev/null`
  );

  console.log("結合中...");
  fs.writeFileSync(concatList, `file '${tmpHook}'\nfile '${tmpMain}'\n`);
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatList}" -c copy "${outputPath}" 2>/dev/null`
  );

  // 後片付け
  fs.unlinkSync(tmpHook);
  fs.unlinkSync(tmpMain);
  fs.unlinkSync(concatList);

  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n完了: ${outputPath} (${sizeMB} MB)`);
}

main();
