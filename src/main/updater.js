// アップデート通知
// - Windows: 自動アップデート（electron-updaterの標準動作）
// - Mac: 通知のみ（GitHub Releasesを開いて手動でダウンロード）
//        未署名アプリだと自動アップデートの最後の再起動でGatekeeperに弾かれる事故が
//        ランダムに起こるため、手動再ダウンロードを安全策として採用
const { autoUpdater } = require("electron-updater");
const { dialog, shell } = require("electron");

const RELEASE_PAGE = "https://github.com/masayapeperon-bot/video-editor-app/releases/latest";

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function check(mainWindow) {
  autoUpdater.on("update-available", async (info) => {
    if (!mainWindow) return;

    if (process.platform === "darwin") {
      // Mac: 手動再DL方式
      const result = await dialog.showMessageBox(mainWindow, {
        type: "info",
        buttons: ["ダウンロードページを開く", "後で"],
        defaultId: 0,
        cancelId: 1,
        title: "新しいバージョンがあります",
        message: `新しいバージョン ${info.version} が公開されました`,
        detail: "「ダウンロードページを開く」を押して、新しいDMGファイルをダウンロードし、Applicationsの古いVideo Editorを置き換えてください。\n\n（次回起動時もこの通知が出ますので、お時間のあるときに更新でOK）",
      });
      if (result.response === 0) {
        shell.openExternal(RELEASE_PAGE);
      }
      return;
    }

    // Windows: 自動アップデート
    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["自動更新", "手動で更新（ブラウザを開く）", "後で"],
      defaultId: 0,
      cancelId: 2,
      title: "アップデートがあります",
      message: `新しいバージョン ${info.version} が利用可能です`,
      detail: "「自動更新」：ダウンロード後、自動でインストールされます（数分かかります）\n「手動で更新」：ブラウザでダウンロードページを開きます",
    });
    if (result.response === 0) {
      // ダウンロード開始通知
      dialog.showMessageBox(mainWindow, {
        type: "info",
        buttons: ["OK"],
        title: "ダウンロード中",
        message: "アップデートをダウンロードしています",
        detail: "ダウンロードには数分かかります。完了したら通知が出ます。\n（このダイアログは閉じてOK）",
      });
      try {
        await autoUpdater.downloadUpdate();
      } catch (e) {
        dialog.showMessageBox(mainWindow, {
          type: "error",
          buttons: ["ブラウザでダウンロードページを開く", "閉じる"],
          defaultId: 0,
          cancelId: 1,
          title: "自動更新に失敗しました",
          message: "自動ダウンロードに失敗しました",
          detail: `エラー：${e.message}\n\n「ブラウザでダウンロードページを開く」を選んで手動でダウンロードしてください。`,
        }).then((r) => {
          if (r.response === 0) shell.openExternal(RELEASE_PAGE);
        });
      }
    } else if (result.response === 1) {
      // 手動更新：ブラウザを開く
      shell.openExternal(RELEASE_PAGE);
    }
  });

  // 以下、自動DL/インストール後の処理（Windowsのみ動作）
  autoUpdater.on("download-progress", (progress) => {
    if (!mainWindow) return;
    // ウィンドウタイトルに進捗を表示（控えめなフィードバック）
    mainWindow.setTitle(`動画編集アプリ - 更新DL中 ${progress.percent.toFixed(0)}%`);
  });

  autoUpdater.on("update-downloaded", async () => {
    if (!mainWindow) return;
    mainWindow.setTitle("動画編集アプリ");
    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["今すぐ再起動", "後で"],
      defaultId: 0,
      cancelId: 1,
      title: "アップデート準備完了",
      message: "更新を適用するには再起動が必要です",
    });
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("update error:", err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        buttons: ["ブラウザでダウンロードページを開く", "閉じる"],
        defaultId: 0,
        cancelId: 1,
        title: "アップデートエラー",
        message: "自動アップデートに失敗しました",
        detail: `エラー：${err.message}\n\n「ブラウザでダウンロードページを開く」を選んで手動でダウンロードしてください。`,
      }).then((r) => {
        if (r.response === 0) shell.openExternal(RELEASE_PAGE);
      });
    }
  });

  // チェック実行（GitHub Releases から）
  autoUpdater.checkForUpdates().catch((e) => {
    console.error("checkForUpdates error:", e.message);
  });
}

module.exports = { check };
