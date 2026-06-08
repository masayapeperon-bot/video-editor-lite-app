import { Composition, getRemotionEnvironment, staticFile } from "remotion";
import { StoryVideo, storyVideoSchema } from "./StoryVideo";
import { StoryVideoSplit, storyVideoSplitSchema } from "./StoryVideo.split";

// エディタからの更新通知でリロード
// シーンIDが渡された場合はそのシーンの画像バージョンをlocalStorageに記録し、
// Scene側で ?v=... を付けてブラウザキャッシュを回避する
if (typeof window !== "undefined" && getRemotionEnvironment().isStudio) {
  window.addEventListener("message", (e) => {
    if (e.data?.type === "editor-updated") {
      if (typeof e.data.sceneId === "number") {
        try {
          window.localStorage.setItem(`imageVersion_${e.data.sceneId}`, String(Date.now()));
        } catch {}
      }
      window.location.reload();
    }
  });
}

const parts = ["起", "承", "転", "結"];
const partIds: Record<string, string> = { "起": "Ki", "承": "Sho", "転": "Ten", "結": "Ketsu" };

const calcDuration = (s: any[]) =>
  s.reduce((sum: number, sc: any) => sum + Math.ceil(sc.durationSec * 30), 0);

const fetchScenes = async () => {
  const resp = await fetch(staticFile("scenes.json"));
  return (await resp.json()) as any[];
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* 全体（エンコード用） */}
      <Composition
        id="StoryVideo"
        component={StoryVideo}
        fps={30}
        width={1920}
        height={1080}
        schema={storyVideoSchema}
        defaultProps={{ scenes: [] }}
        calculateMetadata={async () => {
          const scenes = await fetchScenes();
          return {
            durationInFrames: calcDuration(scenes),
            props: { scenes },
          };
        }}
      />
      {/* パートごと（プレビュー・個別エンコード用） */}
      {parts.map((part) => (
        <Composition
          key={part}
          id={`Part-${partIds[part]}`}
          component={StoryVideo}
          fps={30}
          width={1920}
          height={1080}
          schema={storyVideoSchema}
          defaultProps={{ scenes: [] }}
          calculateMetadata={async () => {
            const scenes = await fetchScenes();
            const filtered = scenes.filter((s: any) => s.part === part);
            return {
              durationInFrames: calcDuration(filtered),
              props: { scenes: filtered },
            };
          }}
        />
      ))}

      {/* === Split レイアウト（テスト用・左70%画像 + 右30%人物エリア） === */}
      <Composition
        id="StoryVideo-Split"
        component={StoryVideoSplit}
        fps={30}
        width={1920}
        height={1080}
        schema={storyVideoSplitSchema}
        defaultProps={{ scenes: [] }}
        calculateMetadata={async () => {
          const scenes = await fetchScenes();
          return {
            durationInFrames: calcDuration(scenes),
            props: { scenes },
          };
        }}
      />
      {parts.map((part) => (
        <Composition
          key={`split-${part}`}
          id={`Part-${partIds[part]}-Split`}
          component={StoryVideoSplit}
          fps={30}
          width={1920}
          height={1080}
          schema={storyVideoSplitSchema}
          defaultProps={{ scenes: [] }}
          calculateMetadata={async () => {
            const scenes = await fetchScenes();
            const filtered = scenes.filter((s: any) => s.part === part);
            return {
              durationInFrames: calcDuration(filtered),
              props: { scenes: filtered },
            };
          }}
        />
      ))}
    </>
  );
};
