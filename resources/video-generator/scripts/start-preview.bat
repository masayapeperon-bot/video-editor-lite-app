@echo off
REM Remotion Studio + エディタを一括起動するスクリプト（Windows版）
REM
REM Usage:
REM   video-generator\scripts\start-preview.bat <作品フォルダのパス>

setlocal enabledelayedexpansion

if "%~1"=="" (
    echo Usage: video-generator\scripts\start-preview.bat ^<作品フォルダのパス^>
    exit /b 1
)

set "PROJECT_DIR=%~f1"
set "SCRIPT_DIR=%~dp0"
set "VG_DIR=%SCRIPT_DIR%.."
set "WORK=%TEMP%\remotion-workspace"

echo プロジェクト: %PROJECT_DIR%
echo video-generator: %VG_DIR%

REM ffmpeg が PATH に無い場合、WinGet インストール先を自動検出して PATH に追加
where ffprobe >nul 2>nul
if errorlevel 1 (
    echo ffmpeg を探索中...
    for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do (
        for /d %%S in ("%%D\ffmpeg-*") do (
            if exist "%%S\bin\ffprobe.exe" (
                set "PATH=%%S\bin;!PATH!"
                echo ✓ ffmpeg を検出: %%S\bin
                goto :ffmpeg_found
            )
        )
    )
    REM 一般的なインストール先も確認
    for %%P in ("C:\ffmpeg\bin" "C:\Program Files\ffmpeg\bin" "%USERPROFILE%\ffmpeg\bin") do (
        if exist "%%~P\ffprobe.exe" (
            set "PATH=%%~P;!PATH!"
            echo ✓ ffmpeg を検出: %%~P
            goto :ffmpeg_found
        )
    )
    echo ⚠ ffmpeg が見つかりません。音声編集でエラーが出る可能性があります。
    echo   インストール: winget install Gyan.FFmpeg
)
:ffmpeg_found

REM images ジャンクション作成（なければ）
if not exist "%PROJECT_DIR%\images" (
    mklink /J "%PROJECT_DIR%\images" "%PROJECT_DIR%\画像\生成画像"
    echo ✓ images ジャンクション作成
)

REM ワークスペース作成
echo ワークスペース準備中...
if exist "%WORK%" rmdir /s /q "%WORK%"
mkdir "%WORK%\public\images"
copy "%VG_DIR%\package.json" "%WORK%\" >nul
copy "%VG_DIR%\package-lock.json" "%WORK%\" >nul
copy "%VG_DIR%\tsconfig.json" "%WORK%\" >nul
xcopy "%VG_DIR%\src" "%WORK%\src\" /e /i /q >nul
xcopy "%VG_DIR%\editors" "%WORK%\editors\" /e /i /q >nul
cd /d "%WORK%" && npm install --silent 2>nul
echo ✓ ワークスペース準備完了

REM .env をコピー
copy "%VG_DIR%\.env" "%WORK%\.env" >nul 2>nul

REM scenes.json をコピー（Windowsではシンボリックリンクに制約があるためコピー）
copy "%PROJECT_DIR%\scenes.json" "%WORK%\src\scenes.json" >nul
copy "%PROJECT_DIR%\scenes.json" "%WORK%\public\scenes.json" >nul

REM 音声フォルダをジャンクション
if exist "%PROJECT_DIR%\audio" (
    mklink /J "%WORK%\public\audio" "%PROJECT_DIR%\audio"
)

REM 動画フォルダをジャンクション（存在する場合）
if exist "%PROJECT_DIR%\videos" (
    mklink /J "%WORK%\public\videos" "%PROJECT_DIR%\videos"
)

REM 画像: パート別サブフォルダからフラットにコピー（ジャンクションはファイル単位不可のため）
for %%P in (起 承 転 結) do (
    if exist "%PROJECT_DIR%\画像\生成画像\%%P" (
        for %%F in ("%PROJECT_DIR%\画像\生成画像\%%P\*") do (
            if not exist "%WORK%\public\images\%%~nxF" (
                mklink /H "%WORK%\public\images\%%~nxF" "%%F" >nul 2>nul || copy "%%F" "%WORK%\public\images\" >nul
            )
        )
    )
)

REM 既存プロセスを停止
taskkill /f /fi "WINDOWTITLE eq audio-server*" 2>nul
taskkill /f /fi "WINDOWTITLE eq image-server*" 2>nul
taskkill /f /fi "WINDOWTITLE eq remotion-studio*" 2>nul
timeout /t 1 /nobreak >nul

REM 音声・字幕エディタ（port 3456）
start "audio-server" /d "%WORK%" cmd /c "node node_modules\tsx\dist\cli.mjs editors\audio-server.ts --project "%PROJECT_DIR%""

REM 画像エディタ（port 3457）
start "image-server" /d "%WORK%" cmd /c "node node_modules\tsx\dist\cli.mjs editors\image-server.ts --project "%PROJECT_DIR%""

REM エディタの起動を待つ
timeout /t 3 /nobreak >nul

REM Remotion Studio
start "remotion-studio" /d "%WORK%" cmd /c "node node_modules\@remotion\cli\remotion-cli.js studio"

echo.
echo ==========================================
echo   音声・字幕エディタ: http://localhost:3456
echo   画像エディタ:       http://localhost:3457
echo   Remotion Studio:    http://localhost:3000
echo ==========================================
echo.

REM ブラウザ自動起動（Google Chrome）
timeout /t 5 /nobreak >nul
start "" "chrome" "http://localhost:3000"

echo 各ウィンドウを閉じると停止します
pause
