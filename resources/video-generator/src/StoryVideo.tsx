import { AbsoluteFill, Sequence, useVideoConfig, Video, staticFile, delayRender, continueRender } from "remotion";
import { Scene } from "./components/Scene";
import { Telop } from "./components/Telop";
import { useEffect, useState } from "react";
import { z } from "zod";

/** Remotion の inputProps スキーマ */
export const storyVideoSchema = z.object({
  scenes: z.array(
    z.object({
      id: z.number(),
      part: z.string(),
      image: z.string(),
      text: z.string(),
      motion: z.enum([
        "zoomIn",
        "zoomOut",
        "panLeft",
        "panRight",
        "panUp",
        "panDown",
      ]),
      audio: z.string(),
      durationSec: z.number(),
      pageSwitchTimes: z.array(z.number()).optional(),
      video: z.string().optional(),
      videoStartSec: z.number().optional(),
      soundEffects: z.array(z.object({
        file: z.string(),
        insertAtSec: z.number(),
        muteDurationSec: z.number(),
        sfxStartSec: z.number(),
        sfxEndSec: z.number(),
        fadeOut: z.boolean(),
      })).optional(),
    })
  ),
});

type StoryVideoProps = z.infer<typeof storyVideoSchema>;

// 人物映像オーバーレイの設定
// 動画ファイルは固定名 videos/overlay.mov（毎回中身を差し替える運用）
const PERSON_OVERLAY = {
  src: "videos/overlay.mov",
  // 縦長映像（9:16）想定。高さで指定
  height: "35%",
  aspectRatio: "9 / 16",
  right: 0,
  top: 0,
};

export const StoryVideo: React.FC<StoryVideoProps> = ({ scenes }) => {
  const { fps } = useVideoConfig();

  // overlay.mov の存在チェック（無い場合はスキップ）
  const [handle] = useState(() => delayRender("Check overlay.mov"));
  const [overlayExists, setOverlayExists] = useState(false);

  useEffect(() => {
    fetch(staticFile(PERSON_OVERLAY.src), { method: "HEAD" })
      .then((r) => {
        setOverlayExists(r.ok);
        continueRender(handle);
      })
      .catch(() => {
        setOverlayExists(false);
        continueRender(handle);
      });
  }, [handle]);

  // 各シーンの開始フレームを計算
  let currentFrame = 0;
  const sceneTimings = scenes.map((scene) => {
    const startFrame = currentFrame;
    const durationInFrames = Math.ceil(scene.durationSec * fps);
    currentFrame += durationInFrames;
    return { ...scene, startFrame, durationInFrames };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {sceneTimings.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.startFrame}
          durationInFrames={scene.durationInFrames}
        >
          {/* 画像 + Ken Burns */}
          <Scene scene={scene} />
          {/* テロップ */}
          <Telop text={scene.text} pageSwitchTimes={scene.pageSwitchTimes} manualPages={(scene as any).manualPages} />
        </Sequence>
      ))}

      {/* 人物映像オーバーレイ（右上）— overlay.mov が存在する時だけ描画 */}
      {overlayExists && (
        <Video
          src={staticFile(PERSON_OVERLAY.src)}
          volume={0}
          style={{
            position: "absolute",
            right: PERSON_OVERLAY.right,
            top: PERSON_OVERLAY.top,
            height: PERSON_OVERLAY.height,
            aspectRatio: PERSON_OVERLAY.aspectRatio,
          }}
        />
      )}
    </AbsoluteFill>
  );
};
