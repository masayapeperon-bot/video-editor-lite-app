/** Ken Burns モーション種類 */
export type MotionType =
  | "zoomIn"
  | "zoomOut"
  | "panLeft"
  | "panRight"
  | "panUp"
  | "panDown";

/** シーン内に差し込む効果音1件のデータ */
export interface SoundEffectData {
  /** 効果音ファイルの相対パス（例: "sfx/explosion.mp3"） */
  file: string;
  /** シーン音声の何秒目に差し込むか（シーン先頭からの秒数） */
  insertAtSec: number;
  /** シーン音声を無音化する長さ（秒）。差し替えの実効長と同じ */
  muteDurationSec: number;
  /** 効果音ファイルの内、使用する開始位置（秒） */
  sfxStartSec: number;
  /** 効果音ファイルの内、使用する終了位置（秒）。sfxEndSec - sfxStartSec が実際に流れる長さ */
  sfxEndSec: number;
  /** 末尾フェードアウト（true=0.3秒のフェード）*/
  fadeOut: boolean;
}

/** 1シーンのデータ */
export interface SceneData {
  /** シーン番号（1始まり） */
  id: number;
  /** パート名（起・承・転・結） */
  part: string;
  /** 画像ファイルの絶対パス */
  image: string;
  /** テロップに表示するテキスト */
  text: string;
  /** Ken Burns エフェクト設定 */
  motion: MotionType;
  /** 音声ファイルの絶対パス */
  audio: string;
  /** 音声の長さ（秒） */
  durationSec: number;
  /** テロップページ切替時刻（秒、シーン先頭からの相対時刻）。音声タイムスタンプベース。 */
  pageSwitchTimes?: number[];
  /** 差し替え動画ファイル（指定時は画像+Ken Burnsの代わりに動画を表示） */
  video?: string;
  /** 差し替え動画の再生開始位置（秒）。複数シーンが1本の動画を分担する場合に使用 */
  videoStartSec?: number;
  /** 差し替え動画の音量（0〜1、デフォルト1） */
  videoVolume?: number;
  /** 差し替え動画の再生速度（デフォルト1） */
  videoPlaybackRate?: number;
  /** 効果音差し替え（1シーンに複数可能だが基本的に1件） */
  soundEffects?: SoundEffectData[];
}

/** 動画全体の設定 */
export interface VideoConfig {
  /** 動画タイトル */
  title: string;
  /** FPS */
  fps: number;
  /** 幅 */
  width: number;
  /** 高さ */
  height: number;
  /** シーン一覧 */
  scenes: SceneData[];
}
