#!/bin/bash
# Remotion Studio + エディタを一括起動するスクリプト
#
# Usage:
#   bash video-generator/scripts/start-preview.sh <作品フォルダのパス>
#
# Google Drive同期による画像巻き戻り・scenes.json破損を防ぐため、
# プロジェクトファイルをローカルにコピーしてから作業する。
# Google Driveへの書き戻しは sync-to-gdrive.sh で行う。

set -e

if [ -z "$1" ]; then
  echo "Usage: bash video-generator/scripts/start-preview.sh <作品フォルダのパス>"
  exit 1
fi

GDRIVE_PROJECT="$(cd "$1" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "プロジェクト（Google Drive）: $GDRIVE_PROJECT"
echo "video-generator: $VG_DIR"

# ── ローカルプロジェクトコピー作成（Google Drive同期の干渉を防止） ──
LOCAL_PROJECT="/tmp/remotion-project"

# ── 起動時セーフネット：前回の未同期データを自動で書き戻す ──
# 外注さんが「作業完了」を伝え忘れてシャットダウンした場合でも、
# 次回起動時にここで自動的にGoogle Driveへ書き戻すことで作業内容を保護する。
if [ -d "$LOCAL_PROJECT" ] && [ -f "$LOCAL_PROJECT/.gdrive_path" ]; then
  PREV_GDRIVE_PATH="$(cat "$LOCAL_PROJECT/.gdrive_path")"
  echo ""
  echo "⚠️  前回のローカル作業データが残っています:"
  echo "   ローカル: $LOCAL_PROJECT"
  echo "   Google Drive: $PREV_GDRIVE_PATH"
  echo ""
  echo "上書きする前に、未同期の変更をGoogle Driveに自動書き戻しします..."
  if bash "$SCRIPT_DIR/sync-to-gdrive.sh"; then
    echo "✓ 自動書き戻し完了。新規セットアップを続行します。"
  else
    echo ""
    echo "❌ 自動書き戻しに失敗しました。"
    echo "   前回のローカル作業データが失われる可能性があります。"
    echo "   手動で確認してから続行してください："
    echo "     bash video-generator/scripts/sync-to-gdrive.sh"
    echo ""
    read -p "それでも上書きして続行しますか？ (yes/no): " ans
    if [ "$ans" != "yes" ]; then
      echo "中断しました。"
      exit 1
    fi
  fi
fi

echo ""
echo "ローカルコピー作成中..."
rm -rf "$LOCAL_PROJECT"
mkdir -p "$LOCAL_PROJECT/画像/生成画像" "$LOCAL_PROJECT/画像/モデル画像"

# プロジェクトファイルをコピー
for f in scenes_raw.json scenes.json pronunciation.json audio_review.json audio_overrides.json edit_log.json; do
  cp "$GDRIVE_PROJECT/$f" "$LOCAL_PROJECT/" 2>/dev/null || true
done

# 画像コピー（パート別）
IMG_COUNT=0
for part in 起 承 転 結; do
  PART_DIR="$GDRIVE_PROJECT/画像/生成画像/$part"
  if [ -d "$PART_DIR" ]; then
    mkdir -p "$LOCAL_PROJECT/画像/生成画像/$part"
    # Google Driveのオンデマンド同期対策: 先にファイル一覧を取得
    ls "$PART_DIR/" >/dev/null 2>&1
    sleep 1
    for img in "$PART_DIR/"*.{png,jpg,jpeg,webp}; do
      if [ -f "$img" ]; then
        cp "$img" "$LOCAL_PROJECT/画像/生成画像/$part/"
        IMG_COUNT=$((IMG_COUNT+1))
      fi
    done
  fi
done
echo "  画像: ${IMG_COUNT}枚"

# モデル画像コピー
MODEL_COUNT=0
if [ -d "$GDRIVE_PROJECT/画像/モデル画像" ]; then
  for img in "$GDRIVE_PROJECT/画像/モデル画像/"*.{png,jpg,jpeg,webp}; do
    if [ -f "$img" ]; then
      cp "$img" "$LOCAL_PROJECT/画像/モデル画像/"
      MODEL_COUNT=$((MODEL_COUNT+1))
    fi
  done
fi
echo "  モデル画像: ${MODEL_COUNT}枚"

# 音声フォルダコピー
if [ -d "$GDRIVE_PROJECT/audio" ]; then
  cp -r "$GDRIVE_PROJECT/audio" "$LOCAL_PROJECT/audio"
  AUDIO_COUNT=$(find "$LOCAL_PROJECT/audio" -type f 2>/dev/null | wc -l | tr -d ' ')
  echo "  音声: ${AUDIO_COUNT}ファイル"
fi

# 動画フォルダコピー（存在する場合）
if [ -d "$GDRIVE_PROJECT/videos" ]; then
  cp -r "$GDRIVE_PROJECT/videos" "$LOCAL_PROJECT/videos"
fi

echo "✓ ローカルコピー完了"

# images シンボリックリンク作成（ローカルコピー内）
IS_WINDOWS=false
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
  IS_WINDOWS=true
fi

if [ ! -e "$LOCAL_PROJECT/images" ]; then
  if $IS_WINDOWS; then
    WIN_TARGET=$(cygpath -w "$LOCAL_PROJECT/画像/生成画像" 2>/dev/null || echo "$LOCAL_PROJECT/画像/生成画像" | sed 's|/|\\|g')
    WIN_LINK=$(cygpath -w "$LOCAL_PROJECT/images" 2>/dev/null || echo "$LOCAL_PROJECT/images" | sed 's|/|\\|g')
    cmd //c "mklink /J \"$WIN_LINK\" \"$WIN_TARGET\"" >/dev/null 2>&1 || true
  else
    ln -sfn "$LOCAL_PROJECT/画像/生成画像" "$LOCAL_PROJECT/images"
  fi
fi

# Google Driveパスを保存（sync-to-gdrive.sh が参照する）
echo "$GDRIVE_PROJECT" > "$LOCAL_PROJECT/.gdrive_path"

# ── Remotionワークスペース作成 ──
WORK="/tmp/remotion-workspace"
echo ""
echo "ワークスペース準備中..."
rm -rf "$WORK"
mkdir -p "$WORK/public"
cp "$VG_DIR/package.json" "$VG_DIR/package-lock.json" "$VG_DIR/tsconfig.json" "$WORK/"
cp -r "$VG_DIR/src" "$WORK/src"
cp -r "$VG_DIR/editors" "$WORK/editors"
cd "$WORK" && npm install --silent 2>&1 | tail -1
cd -
echo "✓ ワークスペース準備完了"

# .env をマージ（video-generator/.env + プロジェクトルート/.env）
# ルート側に KEY_SERVER_URL / KEY_SERVER_TOKEN が置かれているケースに対応
ROOT_DIR="$(cd "$VG_DIR/.." && pwd)"
: > "$WORK/.env"
if [ -f "$VG_DIR/.env" ]; then
  cat "$VG_DIR/.env" >> "$WORK/.env"
  printf '\n' >> "$WORK/.env"
fi
if [ -f "$ROOT_DIR/.env" ]; then
  cat "$ROOT_DIR/.env" >> "$WORK/.env"
  printf '\n' >> "$WORK/.env"
fi

# リンク作成ヘルパー（全てローカルパスを参照するためWindows問題なし）
make_link() {
  local target="$1" link="$2"
  if $IS_WINDOWS; then
    if [ -d "$target" ]; then
      [ -e "$link" ] && rm -rf "$link"
      local win_target win_link
      win_target=$(cygpath -w "$target" 2>/dev/null || echo "$target" | sed 's|/|\\|g')
      win_link=$(cygpath -w "$link" 2>/dev/null || echo "$link" | sed 's|/|\\|g')
      cmd //c "mklink /J \"$win_link\" \"$win_target\"" >/dev/null 2>&1 || cp -r "$target" "$link"
    else
      cp "$target" "$link"
    fi
  else
    ln -sf "$target" "$link"
  fi
}

# scenes.json をリンク（ローカルコピーから）
make_link "$LOCAL_PROJECT/scenes.json" "$WORK/src/scenes.json"
make_link "$LOCAL_PROJECT/scenes.json" "$WORK/public/scenes.json"

# 音声フォルダをリンク（ローカルコピーから）
if [ -d "$LOCAL_PROJECT/audio" ]; then
  make_link "$LOCAL_PROJECT/audio" "$WORK/public/audio"
fi

# 動画フォルダをリンク（ローカルコピーから）
if [ -d "$LOCAL_PROJECT/videos" ]; then
  make_link "$LOCAL_PROJECT/videos" "$WORK/public/videos"
fi

# 画像: パート別サブフォルダをフラットにリンク（ローカルコピーから）
mkdir -p "$WORK/public/images"
LINK_COUNT=0
for part in 起 承 転 結; do
  PART_DIR="$LOCAL_PROJECT/画像/生成画像/$part"
  if [ -d "$PART_DIR" ]; then
    for img in "$PART_DIR/"*; do
      if [ -f "$img" ]; then
        make_link "$img" "$WORK/public/images/$(basename "$img")"
        LINK_COUNT=$((LINK_COUNT+1))
      fi
    done
  fi
done
echo "✓ 画像リンク: ${LINK_COUNT}枚"

# 既存プロセスを停止
pkill -f "audio-server.ts.*--project" 2>/dev/null || true
pkill -f "image-server.ts.*--project" 2>/dev/null || true
pkill -f "remotion.*studio" 2>/dev/null || true
sleep 1

# 音声・字幕エディタ（port 3456）— ローカルコピーを参照
cd "$WORK" && node node_modules/tsx/dist/cli.mjs editors/audio-server.ts --project "$LOCAL_PROJECT" &
AUDIO_PID=$!

# 画像エディタ（port 3457）— ローカルコピーを参照
cd "$WORK" && node node_modules/tsx/dist/cli.mjs editors/image-server.ts --project "$LOCAL_PROJECT" &
IMAGE_PID=$!

# エディタの起動を待つ
sleep 3

# Remotion Studio
cd "$WORK" && node node_modules/@remotion/cli/remotion-cli.js studio &
REMOTION_PID=$!

echo ""
echo "=========================================="
echo "  音声・字幕エディタ: http://localhost:3456"
echo "  画像エディタ:       http://localhost:3457"
echo "  Remotion Studio:    http://localhost:3000"
echo "=========================================="
echo "  ※ ファイルはローカルで作業中"
echo "  ※ 作業完了時にClaude Codeへ「作業完了」と伝えてください"
echo "=========================================="
echo ""

# ブラウザ自動起動
sleep 2
if $IS_WINDOWS; then
  cmd //c start "" "http://localhost:3000" 2>/dev/null || true
elif [ "$(uname)" = "Darwin" ]; then
  open -a "Google Chrome" "http://localhost:3000"
elif command -v google-chrome &>/dev/null; then
  google-chrome "http://localhost:3000" &
elif command -v xdg-open &>/dev/null; then
  xdg-open "http://localhost:3000" &
fi
echo "Ctrl+C で全て停止"

# Ctrl+C で全プロセスを停止
trap "kill $AUDIO_PID $IMAGE_PID $REMOTION_PID 2>/dev/null; exit 0" INT TERM
wait
