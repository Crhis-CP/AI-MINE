// A changelog showcase as a short film the reader opens (TASK-0367, Owner 2026-11-21: “点开能看”, and later major updates
// the same way). A script is data: a list of scenes, each of a known kind with its length. The page draws every scene
// still, as the storyboard (also what screen readers, reduced motion and browsers without WebGL get); the play button
// loads the player and Three.js only then, and plays the same scenes from the same real figures.
import type { Phrase } from "../../../i18n";

export type SceneKind = "title" | "feed" | "trend" | "count" | "sideBySide" | "outro";

export interface Scene {
  kind: SceneKind;
  ms: number;
  /** The scene's heading in the film and on its storyboard card. */
  heading: Phrase;
  /**
   * What changed, in the reader's words, under the heading of its storyboard card. A scene's change lives here, with the
   * scene, not in the entry's own lines, which keep to the 1–3 the changelog standard allows for what the film does not show.
   */
  text?: Phrase;
  /** Where the scene's subject lives on the site. */
  to?: string;
}

export interface Script {
  /** Names the film in the dialog (“{title} · 演示”) and on the poster. */
  title: Phrase;
  scenes: Scene[];
}

export const scriptMs = (script: Script) => script.scenes.reduce((sum, scene) => sum + scene.ms, 0);
