// テスト用レイアウト（検討中）
// 左70%: AI画像エリア / 右30%: 人物映像エリア（首から下）
// テロップは画面全幅（人物エリアにも被せる）
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { Scene } from "./components/Scene";
import { Telop } from "./components/Telop";
import { z } from "zod";

export const storyVideoSplitSchema = z.object({
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
    })
  ),
});

type StoryVideoSplitProps = z.infer<typeof storyVideoSplitSchema>;

export const StoryVideoSplit: React.FC<StoryVideoSplitProps> = ({ scenes }) => {
  const { fps } = useVideoConfig();

  let currentFrame = 0;
  const sceneTimings = scenes.map((scene) => {
    const startFrame = currentFrame;
    const durationInFrames = Math.ceil(scene.durationSec * fps);
    currentFrame += durationInFrames;
    return { ...scene, startFrame, durationInFrames };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* 左: AI画像エリア (左70% × 上70%) — 画像アスペクト比16:9にぴったり合わせて上端ピッタリに */}
      <div style={{ position: "absolute", left: 0, top: 0, width: "70%", height: "70%", overflow: "hidden", backgroundColor: "#000" }}>
        {sceneTimings.map((scene) => (
          <Sequence
            key={`scene-${scene.id}`}
            from={scene.startFrame}
            durationInFrames={scene.durationInFrames}
          >
            <Scene scene={scene} fitMode="contain" />
          </Sequence>
        ))}
      </div>

      {/* 右: 人物映像エリア (30%) — 黒で空けておく（後から別アプリで動画を合成する用） */}
      <div style={{
        position: "absolute",
        right: 0,
        top: 0,
        width: "30%",
        height: "100%",
        backgroundColor: "#000",
      }} />

      {/* テロップ: 画面全幅で人物エリアにも被せる */}
      {sceneTimings.map((scene) => (
        <Sequence
          key={`telop-${scene.id}`}
          from={scene.startFrame}
          durationInFrames={scene.durationInFrames}
        >
          <Telop text={scene.text} pageSwitchTimes={scene.pageSwitchTimes} manualPages={(scene as any).manualPages} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
