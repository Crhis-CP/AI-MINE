import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { validateChangelog, validateReleaseNote } from "../../packages/backend/src/site/meta.ts";

/** Check the reader note and its source fragments before a release can reach production. */
export function checkProductUpdate(root: string, changed: string[], previousManifest: string | null = null): string[] {
  const problems: string[] = [];
  const filename = path.join(root, "industry/release-note.json");
  if (!existsSync(filename)) return ["Missing industry/release-note.json release manifest"];
  try {
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    validateReleaseNote(manifest.note);
    if (manifest.announcement !== undefined) validateReleaseNote(manifest.announcement);
    for (const file of ["industry/changelog.json", "industry/changelog-copy-edits.json"]) {
      if (!existsSync(path.join(root, file))) continue;
      const data = JSON.parse(readFileSync(path.join(root, file), "utf8"));
      const notes = file.endsWith("copy-edits.json")
        ? data.map((edit: { copy: object }) => ({ kind: "优化", ...edit.copy }))
        : validateChangelog(data).releases;
      for (const { kind, version, title, body } of notes) {
        validateReleaseNote({ kind, title, body, ...(version === undefined ? {} : { version }) });
        if (title === "例行维护") throw new Error(`${file}: 纯维护记录不进入读者日志`);
      }
    }
    if (!Array.isArray(manifest.fragments) || !manifest.fragments.length) throw new Error("Release note must cite its product fragments");
    const changedFragments = changed.filter((file) => /^changes\/.+\.md$/.test(file) && existsSync(path.join(root, file)));
    let readerFragmentChanged = false;
    for (const file of new Set([...manifest.fragments, ...changedFragments])) {
      if (typeof file !== "string" || !/^changes\/[A-Za-z0-9-]+\.md$/.test(file)) throw new Error("Invalid product fragment path");
      const text = readFileSync(path.join(root, file), "utf8");
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (!header) throw new Error(`${file}: missing product metadata`);
      const fragment = parse(header[1]);
      if (!Array.isArray(fragment.highlights) || !fragment.highlights.length || !fragment.highlights.every((v: unknown) => typeof v === "string" && v.trim()))
        throw new Error(`${file}: highlights must be nonempty reader sentences`);
      if (!["读者", "运营", "读者和运营"].includes(fragment.audience)) throw new Error(`${file}: invalid audience`);
      if (manifest.fragments.includes(file) && fragment.audience !== "读者") throw new Error(`${file}: 公开更新清单只能引用读者片段，运营说明留在内部交付记录`);
      const note = {
        kind: fragment.type,
        title: fragment.title,
        body: fragment.highlights,
        ...(fragment.version === undefined ? {} : { version: fragment.version }),
      };
      if (fragment.audience === "读者") validateReleaseNote(note);
      else {
        validateChangelog({ latestVersion: "2026-01-01", releases: [{ ...note, date: "2026-01-01" }] });
        if ([...fragment.title].length > 24) throw new Error(`${file}: title exceeds 24 characters`);
      }
      if (fragment.audience !== "运营" && changedFragments.includes(file)) readerFragmentChanged = true;
    }
    const userRoutesChanged =
      readerFragmentChanged ||
      changed.some((file) => /^apps\/web\/app\/(routes|components)\//.test(file) && !/^apps\/web\/app\/routes\/admin(?:\/|-login\.)/.test(file));
    const noteChanged =
      changed.includes("industry/release-note.json") &&
      (!previousManifest || JSON.stringify(JSON.parse(previousManifest).note) !== JSON.stringify(manifest.note));
    if (userRoutesChanged && !noteChanged) problems.push("Reader-facing routes changed without updating the release note or its product fragments");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}
