/**
 * 台本パーサー
 *
 * 台本テキストを空行で分割し、シーンブロック配列を生成する。
 * 各ブロックは画像生成プロンプトのシーン番号と1対1で対応する。
 *
 * Usage:
 *   npx tsx scripts/parse-script.ts --project <作品フォルダパス>
 *
 * 出力: <作品フォルダパス>/scenes_raw.json
 */

import * as fs from "fs";
import * as path from "path";

interface RawScene {
  id: number;
  part: string;
  partSceneNumber: number;
  text: string;
}

const PARTS = ["起", "承", "転", "結"];

function parseScript(scriptPath: string, partName: string): string[] {
  const content = fs.readFileSync(scriptPath, "utf-8");
  // 空行で分割
  const blocks = content
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  return blocks;
}

function findScriptFiles(projectDir: string): { part: string; path: string }[] {
  const files: { part: string; path: string }[] = [];
  for (const part of PARTS) {
    // 複数の命名パターンに対応
    const candidates = [
      `台本_${part}.md`,
      `台本　${part}.md`,   // 全角スペース + .md
      `台本_${part}`,       // 拡張子なし
      `台本　${part}`,      // 全角スペース + 拡張子なし
    ];
    for (const name of candidates) {
      const filePath = path.join(projectDir, name);
      if (fs.existsSync(filePath)) {
        files.push({ part, path: filePath });
        break;
      }
    }
  }
  return files;
}

function main() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  if (projectIdx === -1 || !args[projectIdx + 1]) {
    console.error("Usage: npx tsx scripts/parse-script.ts --project <作品フォルダパス>");
    process.exit(1);
  }
  const projectDir = args[projectIdx + 1];

  if (!fs.existsSync(projectDir)) {
    console.error(`フォルダが見つかりません: ${projectDir}`);
    process.exit(1);
  }

  // --parts オプション: 処理するパートを限定（例: --parts 起）
  const partsIdx = args.indexOf("--parts");
  const partsFilter = partsIdx !== -1 && args[partsIdx + 1]
    ? args[partsIdx + 1].split(",")
    : null;

  let scriptFiles = findScriptFiles(projectDir);
  if (partsFilter) {
    scriptFiles = scriptFiles.filter((f) => partsFilter.includes(f.part));
  }
  if (scriptFiles.length === 0) {
    console.error("台本ファイルが見つかりません（台本_起.md, 台本_承.md, ...）");
    process.exit(1);
  }

  const allScenes: RawScene[] = [];
  let globalId = 1;

  for (const { part, path: filePath } of scriptFiles) {
    const blocks = parseScript(filePath, part);
    console.log(`${part}パート: ${blocks.length} シーン`);

    for (let i = 0; i < blocks.length; i++) {
      allScenes.push({
        id: globalId++,
        part,
        partSceneNumber: i + 1,
        text: blocks[i],
      });
    }
  }

  const outputPath = path.join(projectDir, "scenes_raw.json");
  fs.writeFileSync(outputPath, JSON.stringify(allScenes, null, 2), "utf-8");
  console.log(`\n合計 ${allScenes.length} シーン → ${outputPath}`);
}

main();
