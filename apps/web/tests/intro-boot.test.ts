// The opening animation's boot script (TASK-0628, TASK-0641): it decides alone, before any app script, whether the
// animation plays, and it releases the page's scroll lock by itself, so a page whose app never loads still scrolls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { INTRO_BOOT_SCRIPT } from "../app/components/shell/intro-boot.ts";

function run(path: string, seen: string | null, reduce = false) {
  const classes = new Set<string>();
  const timers: { fn: () => void; ms: number }[] = [];
  const context = {
    location: { pathname: path },
    localStorage: { getItem: () => seen },
    matchMedia: () => ({ matches: reduce }),
    navigator: { webdriver: false, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
    document: {
      documentElement: {
        classList: {
          add: (...names: string[]) => {
            for (const n of names) classes.add(n);
          },
          remove: (...names: string[]) => {
            for (const n of names) classes.delete(n);
          },
        },
      },
    },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    window: {} as Record<string, unknown>,
  };
  runInNewContext(INTRO_BOOT_SCRIPT, context);
  return { classes, timers, window: context.window };
}

test("a first visit to the home page plays, and the boot script itself unlocks scrolling after the CSS exit", () => {
  const { classes, timers } = run("/", null);
  assert.ok(classes.has("intro"));
  assert.equal(timers.length, 1);
  assert.ok(timers[0]!.ms >= 5450, "after the 4.6s CSS exit and its 0.85s animation");
  classes.add("intro-out");
  timers[0]!.fn();
  assert.equal(classes.size, 0, "no scroll lock is left even if no app script ever runs");
});

test("other pages, a second visit and reduced motion never play and leave nothing to undo", () => {
  for (const [path, seen, reduce] of [
    ["/all", null, false],
    ["/", "1", false],
    ["/", null, true],
  ] as const) {
    const { classes, timers } = run(path, seen, reduce);
    assert.equal(classes.size, 0, path);
    assert.equal(timers.length, 0, path);
  }
});
