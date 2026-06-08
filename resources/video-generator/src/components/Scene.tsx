import React, { useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { AbsoluteFill, Img, Sequence, Video, staticFile, useCurrentFrame, useVideoConfig, Audio, interpolate, getRemotionEnvironment } from "remotion";
import type { MotionType, SceneData } from "../types";

const SFX_FADE_OUT_SEC = 0.3;

/**
 * Ken Burns エフェクトを計算する
 * 各シーンの表示中にゆっくりとズーム・パンするCSS transformを返す
 */
function getKenBurnsStyle(
  motion: MotionType,
  progress: number // 0〜1
): React.CSSProperties {
  switch (motion) {
    case "zoomIn": {
      const scale = interpolate(progress, [0, 1], [1.0, 1.3]);
      return { transform: `scale(${scale})` };
    }
    case "zoomOut": {
      const scale = interpolate(progress, [0, 1], [1.3, 1.0]);
      return { transform: `scale(${scale})` };
    }
    case "panLeft": {
      const x = interpolate(progress, [0, 1], [5, -5]);
      return { transform: `scale(1.2) translateX(${x}%)` };
    }
    case "panRight": {
      const x = interpolate(progress, [0, 1], [-5, 5]);
      return { transform: `scale(1.2) translateX(${x}%)` };
    }
    case "panUp": {
      const y = interpolate(progress, [0, 1], [5, -5]);
      return { transform: `scale(1.2) translateY(${y}%)` };
    }
    case "panDown": {
      const y = interpolate(progress, [0, 1], [-5, 5]);
      return { transform: `scale(1.2) translateY(${y}%)` };
    }
  }
}

interface SceneProps {
  scene: SceneData;
  fitMode?: "cover" | "contain";
}

export const Scene: React.FC<SceneProps> = ({ scene, fitMode = "cover" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const totalFrames = Math.ceil(scene.durationSec * fps);
  const progress = frame / totalFrames;
  const [editorOpen, setEditorOpen] = useState<"audio" | "image" | "telop" | "encode" | "sfx" | null>(null);

  const kenBurnsStyle = getKenBurnsStyle(scene.motion, Math.min(progress, 1));

  const openAudioEditor = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditorOpen("audio");
  }, []);

  const openImageEditor = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditorOpen("image");
  }, []);

  const openTelopEditor = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditorOpen("telop");
  }, []);

  const openEncodePanel = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditorOpen("encode");
  }, []);

  const openSfxEditor = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditorOpen("sfx");
  }, []);

  const closeEditor = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditorOpen(null);
  }, []);

  const isStudio = getRemotionEnvironment().isStudio;

  const imageSrc = (() => {
    if (!scene.image) return "";
    const base = staticFile(scene.image);
    if (!isStudio || typeof window === "undefined") return base;
    const v = window.localStorage?.getItem(`imageVersion_${scene.id}`);
    return v ? `${base}?v=${v}` : base;
  })();

  return (
    <AbsoluteFill>
      {/* 差し替え動画 or 画像 + Ken Burns */}
      <AbsoluteFill style={{ overflow: "hidden" }}>
        {scene.video ? (
          <Video
            src={staticFile(scene.video)}
            startFrom={scene.videoStartSec !== undefined ? Math.round(scene.videoStartSec * fps) : 0}
            volume={scene.videoVolume !== undefined ? scene.videoVolume : 1}
            playbackRate={scene.videoPlaybackRate !== undefined ? scene.videoPlaybackRate : 1}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          scene.image && (
            <Img
              src={imageSrc}
              style={{
                width: "100%",
                height: "100%",
                objectFit: fitMode,
                ...kenBurnsStyle,
              }}
            />
          )
        )}
      </AbsoluteFill>

      {/* 音声（効果音区間は無音化） */}
      {scene.audio && (
        <Audio
          src={staticFile(scene.audio)}
          volume={(f) => {
            const sfxList = scene.soundEffects;
            if (!sfxList || sfxList.length === 0) return 1;
            const t = f / fps;
            for (const sfx of sfxList) {
              if (t >= sfx.insertAtSec && t < sfx.insertAtSec + sfx.muteDurationSec) return 0;
            }
            return 1;
          }}
        />
      )}

      {/* 効果音オーバーレイ */}
      {(scene.soundEffects ?? []).map((sfx, i) => {
        const insertFrame = Math.round(sfx.insertAtSec * fps);
        const sfxDurationSec = Math.max(0, sfx.sfxEndSec - sfx.sfxStartSec);
        const sfxDurationFrames = Math.max(1, Math.round(sfxDurationSec * fps));
        const startFromFrame = Math.max(0, Math.round(sfx.sfxStartSec * fps));
        const fadeFrames = Math.max(1, Math.round(SFX_FADE_OUT_SEC * fps));
        return (
          <Sequence
            key={`sfx-${i}-${sfx.file}`}
            from={insertFrame}
            durationInFrames={sfxDurationFrames}
          >
            <Audio
              src={staticFile(sfx.file)}
              startFrom={startFromFrame}
              endAt={startFromFrame + sfxDurationFrames}
              volume={(f) => {
                if (!sfx.fadeOut) return 1;
                const fadeStart = sfxDurationFrames - fadeFrames;
                if (f < fadeStart) return 1;
                return Math.max(0, 1 - (f - fadeStart) / fadeFrames);
              }}
            />
          </Sequence>
        );
      })}

      {/* Studio プレビュー時のみ: シーン番号 + 音声エディタボタン */}
      {isStudio && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            display: "flex",
            gap: 8,
            alignItems: "center",
            zIndex: 10,
          }}
        >
          <span
            style={{
              background: "rgba(0,0,0,0.6)",
              color: "#fff",
              padding: "4px 10px",
              borderRadius: 4,
              fontSize: 14,
              fontFamily: "monospace",
            }}
          >
            #{String(scene.id).padStart(3, "0")}
          </span>
          <button
            onClick={openAudioEditor}
            style={{
              background: "rgba(15,52,96,0.8)",
              color: "#89c2d9",
              padding: "4px 10px",
              borderRadius: 4,
              fontSize: 13,
              border: "none",
              cursor: "pointer",
              fontFamily: "sans-serif",
            }}
          >
            音声を編集
          </button>
          <button
            onClick={openImageEditor}
            style={{
              background: "rgba(75,30,15,0.8)",
              color: "#d9a589",
              padding: "4px 10px",
              borderRadius: 4,
              fontSize: 13,
              border: "none",
              cursor: "pointer",
              fontFamily: "sans-serif",
            }}
          >
            画像差し替え
          </button>
          <button
            onClick={openTelopEditor}
            style={{
              background: "rgba(30,75,15,0.8)",
              color: "#a5d989",
              padding: "4px 10px",
              borderRadius: 4,
              fontSize: 13,
              border: "none",
              cursor: "pointer",
              fontFamily: "sans-serif",
            }}
          >
            字幕を編集
          </button>
          <button
            onClick={openSfxEditor}
            style={{
              background: "rgba(75,60,15,0.8)",
              color: "#d9c989",
              padding: "4px 10px",
              borderRadius: 4,
              fontSize: 13,
              border: "none",
              cursor: "pointer",
              fontFamily: "sans-serif",
            }}
          >
            効果音を編集
          </button>
          <button
            onClick={openEncodePanel}
            style={{
              background: "rgba(80,15,75,0.8)",
              color: "#d989d5",
              padding: "4px 10px",
              borderRadius: 4,
              fontSize: 13,
              border: "none",
              cursor: "pointer",
              fontFamily: "sans-serif",
            }}
          >
            エンコード
          </button>
        </div>
      )}

      {/* エディタ iframe オーバーレイ（Portalでbodyに直接描画） */}
      {isStudio && editorOpen !== null && createPortal(
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            zIndex: 99999,
            display: "flex",
            background: "rgba(0,0,0,0.5)",
          }}
        >
          {/* 左側: クリックで閉じる */}
          <div
            onClick={closeEditor}
            style={{
              width: "35%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <div style={{
              color: "#888",
              fontSize: 14,
              textAlign: "center",
              fontFamily: "sans-serif",
            }}>
              クリックで閉じる
            </div>
          </div>

          {/* 右側: エディタ */}
          <div style={{
            width: "65%",
            height: "100%",
            position: "relative",
            background: "#1a1a2e",
            borderLeft: "2px solid #333",
          }}>
            <button
              onClick={closeEditor}
              style={{
                position: "absolute",
                top: 8,
                right: 12,
                zIndex: 100000,
                background: "rgba(233,69,96,0.8)",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                padding: "6px 14px",
                fontSize: 14,
                cursor: "pointer",
                fontFamily: "sans-serif",
              }}
            >
              閉じる
            </button>
            <iframe
              src={
                editorOpen === "audio"
                  ? `http://localhost:3456/#scene/${scene.id}`
                  : editorOpen === "image"
                    ? `http://localhost:3457/#scene/${scene.id}`
                    : editorOpen === "telop"
                      ? `http://localhost:3456/telop/#scene/${scene.id}`
                      : editorOpen === "sfx"
                        ? `http://localhost:3459/#scene/${scene.id}`
                        : `http://localhost:3456/encode/`
              }
              style={{
                width: "100%",
                height: "100%",
                border: "none",
              }}
            />
          </div>
        </div>,
        document.body
      )}
    </AbsoluteFill>
  );
};
