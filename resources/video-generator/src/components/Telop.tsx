import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

const MAX = 24; // 1行の最大文字数
const MAX_LINES = 3; // 1ページの最大行数
const PAGE_MAX = MAX * MAX_LINES; // 1ページの最大文字数

interface TelopProps {
  text: string;
  pageSwitchTimes?: number[];
  /** 手動分割: [["1行目","2行目"],["次ページ1行目"]] 形式。指定時は自動分割を使わない */
  manualPages?: string[][];
}

/**
 * テキストを文単位で分割する（。！？」の境界で区切る）
 */
function splitSentences(text: string): string[] {
  const result: string[] = [];
  let buf = "";
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if (text[i] === "「") depth++;
    if (text[i] === "」") depth--;

    const isEnd =
      (text[i] === "」" && depth === 0) ||
      ("。！？".includes(text[i]) && depth === 0);

    // 閉じカッコなしで次の「が来る場合（例: 「…覚えたわ。「パパに…」）
    // 。の後に「が続くなら、depth に関係なく文の区切りとする
    const isUnmatchedEnd =
      "。！？".includes(text[i]) && depth > 0 && i < text.length - 1 && text[i + 1] === "「";

    if ((isEnd || isUnmatchedEnd) && i < text.length - 1) {
      if (isUnmatchedEnd) depth = 0; // depth をリセット
      result.push(buf);
      buf = "";
    }
  }
  if (buf) result.push(buf);
  return result;
}

/**
 * 分割位置のスコアを計算する（小さいほど良い）
 */
function splitScore(text: string, pos: number, idealPos: number): number {
  const prev = text[pos - 1];
  const next = text[pos];
  let priority = 10;
  if (prev === "」") priority = 1;
  else if (next === "「") priority = 2;
  else if ("。！？".includes(prev)) priority = 3;
  else if (prev === "、") priority = 4;
  return priority * 100 + Math.abs(pos - idealPos);
}

/**
 * ページテキストを複数行に分割する
 * 各行が MAX 文字以下になる位置で分割する
 */
function splitPageLines(text: string): string[] {
  if (text.length <= MAX) return [text];

  // 安全策: 3行(MAX*3)を超える場合は強制的にMAX文字ずつ分割
  if (text.length > MAX * MAX_LINES) {
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += MAX) {
      lines.push(text.slice(i, i + MAX));
    }
    return lines;
  }

  if (text.length <= MAX * 2) {
    // 2行に収まる場合
    const minPos = text.length - MAX;
    const maxPos = MAX;
    const mid = Math.floor(text.length / 2);
    let bestPos = mid, bestScore = Infinity;
    for (let i = Math.max(1, minPos); i <= Math.min(text.length - 1, maxPos); i++) {
      const score = splitScore(text, i, mid);
      if (score < bestScore) { bestScore = score; bestPos = i; }
    }
    return [text.slice(0, bestPos), text.slice(bestPos)];
  }

  // 3行に分割: 1行目を切り出し、残りを必ず2行に分割
  // 1行目: 最大MAX文字、かつ残りが MAX*2 以下になるよう制約
  const minFirst = Math.max(1, text.length - MAX * 2); // 残りが2行に収まる最小の1行目長
  const maxFirst = MAX;
  const targetFirst = Math.floor(text.length / 3);
  let bestPos = Math.max(minFirst, Math.min(targetFirst, maxFirst));
  let bestScore = Infinity;
  for (let i = minFirst; i <= Math.min(text.length - 1, maxFirst); i++) {
    const score = splitScore(text, i, targetFirst);
    if (score < bestScore) { bestScore = score; bestPos = i; }
  }
  const firstLine = text.slice(0, bestPos);
  const rest = text.slice(bestPos);
  // 残りは必ず MAX*2 以下なので2行に分割される
  const restLines = splitPageLines(rest);
  return [firstLine, ...restLines];
}

/**
 * 長いテキストを複数ページに分割する
 * 各ページは最大3行、各行は最大24文字
 */
function splitIntoPages(text: string): string[][] {
  const flat = text.replace(/\n/g, "");
  if (flat.length <= MAX) return [[flat]];

  // 1. 文単位で分割
  const sentences = splitSentences(flat);

  // 2. 文をページに詰める（1ページ最大48文字）
  const chunks: string[] = [];
  let current = "";

  for (const s of sentences) {
    if (s.length > PAGE_MAX) {
      // 長い文: まず current を確定
      if (current) { chunks.push(current); current = ""; }
      // 「、」で分割して詰める
      let part = "";
      for (let i = 0; i < s.length; i++) {
        part += s[i];
        if (s[i] === "、" && part.length >= MAX && i < s.length - 1) {
          if (current && current.length + part.length <= PAGE_MAX) {
            current += part;
          } else {
            if (current) chunks.push(current);
            current = part;
          }
          part = "";
        }
      }
      if (part) {
        if (current && current.length + part.length <= PAGE_MAX) {
          current += part;
        } else {
          if (current) chunks.push(current);
          current = part;
        }
      }
    } else if (current.length + s.length <= PAGE_MAX) {
      current += s;
    } else {
      if (current) chunks.push(current);
      current = s;
    }
  }
  if (current) chunks.push(current);

  // 3. 各チャンクを2行に分割
  return chunks.map((c) => splitPageLines(c));
}

/**
 * 下部テロップ — 半透明黒帯 + 白文字（縁取り付き）
 * テキストが長い場合は時間で分割して順番に表示
 */
export const Telop: React.FC<TelopProps> = ({ text, pageSwitchTimes, manualPages }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const pages = manualPages && manualPages.length > 0 ? manualPages : splitIntoPages(text);
  const totalPages = pages.length;

  let currentPageIndex: number;
  if (pageSwitchTimes && pageSwitchTimes.length > 0) {
    // 音声タイムスタンプベースのページ切替
    const currentSec = frame / fps;
    currentPageIndex = 0;
    for (let i = 0; i < pageSwitchTimes.length; i++) {
      if (currentSec >= pageSwitchTimes[i]) currentPageIndex = i + 1;
    }
    currentPageIndex = Math.min(currentPageIndex, totalPages - 1);
  } else {
    // フォールバック: 均等分割
    const framesPerPage = Math.floor(durationInFrames / totalPages);
    currentPageIndex = Math.min(
      Math.floor(frame / framesPerPage),
      totalPages - 1
    );
  }
  const currentPage = pages[currentPageIndex];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          backgroundColor: "rgba(0, 0, 0, 0.75)",
          padding: "32px 60px",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: 200,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          {currentPage.map((line, i) => (
            <p
              key={`${currentPageIndex}-${i}`}
              style={{
                color: "#ffffff",
                fontSize: 64,
                fontFamily:
                  '"Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif',
                fontWeight: 900,
                lineHeight: 1.4,
                textAlign: "center",
                margin: 0,
                textShadow:
                  "3px 3px 0px #000, -3px -3px 0px #000, 3px -3px 0px #000, -3px 3px 0px #000, 0px 3px 0px #000, 0px -3px 0px #000, 3px 0px 0px #000, -3px 0px 0px #000, 4px 4px 4px rgba(0,0,0,0.5)",
                letterSpacing: "0.05em",
                whiteSpace: "nowrap",
              }}
            >
              {line}
            </p>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
