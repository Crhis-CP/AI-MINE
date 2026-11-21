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
  /** The release line the storyboard card shows under the heading, found by these words (the copy may be rewritten). */
  line?: RegExp;
  /** Where the scene's subject lives on the site. */
  to?: string;
}

export interface Script {
  /** Names the film in the dialog (“{title} · 演示”) and on the poster. */
  title: Phrase;
  scenes: Scene[];
}

export const scriptMs = (script: Script) => script.scenes.reduce((sum, scene) => sum + scene.ms, 0);
