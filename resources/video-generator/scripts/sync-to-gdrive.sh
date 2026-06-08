#!/bin/bash
# ローカルの作業結果をGoogle Driveに書き戻すスクリプト
#
# Usage:
#   bash video-generator/scripts/sync-to-gdrive.sh
#
# start-preview.sh で作成されたローカルコピー（/tmp/remotion-project）の
# 変更をGoogle Driveのプロジェクトフォルダに書き戻す。

set -e

LOCAL_PROJECT="/tmp/remotion-project"

# ローカルコピーの存在確認
if [ ! -d "$LOCAL_PROJECT" ]; then
  echo "エラー: ローカルコピーが見つかりません（$LOCAL_PROJECT）"
  echo "start-preview.sh を先に実行してください。"
  exit 1
fi

# Google Driveパスの読み込み
GDRIVE_PATH_FILE="$LOCAL_PROJECT/.gdrive_path"
if [ ! -f "$GDRIVE_PATH_FILE" ]; then
  echo "エラー: Google Driveパスが記録されていません"
  exit 1
fi
GDRIVE_PROJECT="$(cat "$GDRIVE_PATH_FILE")"

if [ ! -d "$GDRIVE_PROJECT" ]; then
  echo "エラー: Google Driveのフォルダが見つかりません: $GDRIVE_PROJECT"
  exit 1
fi

echo "Google Driveに書き戻し中..."
echo "  ローカル: $LOCAL_PROJECT"
echo "  Google Drive: $GDRIVE_PROJECT"

# JSONファイル
JSON_COUNT=0
for f in scenes.json pronunciation.json audio_review.json audio_overrides.json edit_log.json; do
  if [ -f "$LOCAL_PROJECT/$f" ]; then
    cp "$LOCAL_PROJECT/$f" "$GDRIVE_PROJECT/"
    JSON_COUNT=$((JSON_COUNT+1))
  fi
done
echo "  設定ファイル: ${JSON_COUNT}件"

# 画像（パート別）
IMG_COUNT=0
for part in 起 承 転 結; do
  if [ -d "$LOCAL_PROJECT/画像/生成画像/$part" ]; then
    mkdir -p "$GDRIVE_PROJECT/画像/生成画像/$part"
    for img in "$LOCAL_PROJECT/画像/生成画像/$part/"*.{png,jpg,jpeg,webp}; do
      if [ -f "$img" ]; then
        cp "$img" "$GDRIVE_PROJECT/画像/生成画像/$part/"
        IMG_COUNT=$((IMG_COUNT+1))
      fi
    done
  fi
done
echo "  画像: ${IMG_COUNT}枚"

# 音声
if [ -d "$LOCAL_PROJECT/audio" ]; then
  mkdir -p "$GDRIVE_PROJECT/audio"
  cp -r "$LOCAL_PROJECT/audio/." "$GDRIVE_PROJECT/audio/"
  AUDIO_COUNT=$(find "$LOCAL_PROJECT/audio" -type f 2>/dev/null | wc -l | tr -d ' ')
  echo "  音声: ${AUDIO_COUNT}ファイル"
fi

echo ""
echo "✓ Google Driveへの書き戻し完了"
