// Checks the four README languages stay in step (brief workflow 5): the same second-level structure, the
// same relative links (each pointing at a file that exists), the language switch in each, and a source-commit
// note in every translation that names a real commit. Read-only; prints problems and exits 1 on any.
//
// Usage: node scripts/readme-check.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const FILES = ["README.md", "README.zh-CN.md", "README.es.md", "README.fr.md"];
const problems: string[] = [];

const text = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const headings = (s: string) => s.split("\n").filter((l) => l.startsWith("## ")).length;
const relativeLinks = (s: string) =>
  [...s.matchAll(/(?:\]\(|(?:src|srcset|href)=")([^)"#\s]+)/g)]
    .map((m) => m[1]!)
    .filter((l) => !/^(?:https?:|mailto:|\/)/.test(l) && !/^README(?:\.[\w-]+)?\.md$/.test(l))
    .sort();

const source = text("README.md");
for (const file of FILES) {
  if (!existsSync(path.join(ROOT, file))) {
    problems.push(`${file}: missing`);
    continue;
  }
  const s = text(file);
  if (/ai ?hot/i.test(s)) problems.push(`${file}: names the upstream project`);
  for (const other of FILES) if (other !== file && !s.includes(`href="${other}"`)) problems.push(`${file}: language switch lacks ${other}`);
  if (headings(s) !== headings(source)) problems.push(`${file}: ${headings(s)} sections, the source has ${headings(source)}`);
  const links = relativeLinks(s);
  if (JSON.stringify(links) !== JSON.stringify(relativeLinks(source))) problems.push(`${file}: relative links differ from the source`);
  for (const link of new Set(links)) if (!existsSync(path.join(ROOT, link))) problems.push(`${file}: link target ${link} does not exist`);
  if (file !== "README.md") {
    const commit = /<!-- readme-translation: README\.md @ ([0-9a-f]{7,40}) -->/.exec(s)?.[1];
    if (!commit) problems.push(`${file}: no source-commit note`);
    else
      try {
        execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: ROOT, stdio: "ignore" });
      } catch {
        problems.push(`${file}: source commit ${commit} not found`);
      }
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`README languages in step: ${FILES.join(", ")}`);
