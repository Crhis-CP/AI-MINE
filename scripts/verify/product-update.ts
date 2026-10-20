import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { validateReleaseNote } from "../../packages/backend/src/site/meta.ts";

/** Check the reader note and its source fragments before a release can reach production. */
export function checkProductUpdate(root: string, changed: string[], previousManifest: string | null = null): string[] {
  const problems: string[] = [];
  const filename = path.join(root, "industry/release-note.json");
  if (!existsSync(filename)) return ["Missing industry/release-note.json release manifest"];
  try {
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    validateReleaseNote(manifest.note);
    if (!Array.isArray(manifest.fragments) || !manifest.fragments.length) throw new Error("Release note must cite its product fragments");
    const changedFragments = changed.filter((file) => /^changes\/.+\.md$/.test(file) && existsSync(path.join(root, file)));
    for (const file of new Set([...manifest.fragments, ...changedFragments])) {
      if (typeof file !== "string" || !/^changes\/[A-Za-z0-9-]+\.md$/.test(file)) throw new Error("Invalid product fragment path");
      const text = readFileSync(path.join(root, file), "utf8");
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (!header) throw new Error(`${file}: missing product metadata`);
      const fragment = parse(header[1]);
      if (!Array.isArray(fragment.highlights) || !fragment.highlights.length || !fragment.highlights.every((v: unknown) => typeof v === "string" && v.trim()))
        throw new Error(`${file}: highlights must be nonempty reader sentences`);
      validateReleaseNote({
        kind: fragment.type,
        title: fragment.title,
        body: fragment.highlights,
        ...(fragment.version === undefined ? {} : { version: fragment.version }),
      });
      if (!["读者", "运营", "读者和运营"].includes(fragment.audience)) throw new Error(`${file}: invalid audience`);
    }
    const userRoutesChanged = changed.some((file) => /^apps\/web\/app\/(routes|components)\//.test(file) || /^changes\/.+\.md$/.test(file));
    const noteChanged =
      changed.includes("industry/release-note.json") &&
      (!previousManifest || JSON.stringify(JSON.parse(previousManifest).note) !== JSON.stringify(manifest.note));
    if (userRoutesChanged && !noteChanged) problems.push("Reader-facing routes changed without updating the release note or its product fragments");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}
