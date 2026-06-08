/**
 * 発音辞書生成スクリプト
 *
 * 登場人物リスト_簡易版.md から「名前（よみがな）」を抽出し、
 * pronunciation.json を生成する。
 *
 * Usage:
 *   npx tsx scripts/generate-pronunciation.ts --project <作品フォルダパス>
 */

import * as fs from "fs";
import * as path from "path";

function main() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  if (projectIdx === -1 || !args[projectIdx + 1]) {
    console.error("Usage: npx tsx scripts/generate-pronunciation.ts --project <作品フォルダパス>");
    process.exit(1);
  }
  const projectDir = args[projectIdx + 1];

  const listPath = path.join(projectDir, "登場人物リスト_簡易版.md");
  if (!fs.existsSync(listPath)) {
    console.error("登場人物リスト_簡易版.md が見つかりません");
    process.exit(1);
  }

  const content = fs.readFileSync(listPath, "utf-8");
  const pronunciationMap: Record<string, string> = {};

  // 「姓 名（せい めい）」のパターンを抽出
  // 例: 梶原 剛（かじわら つよし）
  const pattern = /([^\s（）「」、。\n]+[\s　][^\s（）「」、。\n]+|[^\s（）「」、。\n]+)（([ぁ-んァ-ン]+[\s　][ぁ-んァ-ン]+|[ぁ-んァ-ン]+)）/g;
  const matches = content.matchAll(pattern);

  for (const match of matches) {
    const full = match[0];
    const parenIdx = full.indexOf("（");
    const kanji = full.slice(0, parenIdx).trim();
    const reading = full.slice(parenIdx + 1, full.length - 1).trim();

    // 姓名をスペースで分割して個別に登録
    const kanjiParts = kanji.split(/[\s　]+/);
    const readingParts = reading.split(/[\s　]+/);

    if (kanjiParts.length === readingParts.length) {
      for (let i = 0; i < kanjiParts.length; i++) {
        const k = kanjiParts[i];
        const r = readingParts[i];
        // 漢字を含み、記号・英数字を含まないものだけ登録
        if (k && r && /[\u4E00-\u9FFF]/.test(k) && /^[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]+$/.test(k)) {
          pronunciationMap[k] = r;
        }
      }
    } else {
      // 分割できない場合はそのまま登録
      if (/[^\u3040-\u309F]/.test(kanji)) {
        pronunciationMap[kanji] = reading;
      }
    }
  }

  const outputPath = path.join(projectDir, "pronunciation.json");
  fs.writeFileSync(outputPath, JSON.stringify(pronunciationMap, null, 2), "utf-8");

  console.log(`pronunciation.json を生成しました: ${outputPath}`);
  console.log(`登録件数: ${Object.keys(pronunciationMap).length}件`);
  for (const [k, v] of Object.entries(pronunciationMap)) {
    console.log(`  ${k} → ${v}`);
  }
}

main();
