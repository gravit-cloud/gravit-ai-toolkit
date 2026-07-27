import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills, renderSkills } from "../../scripts/lib/skills.mjs";
import { parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import { walkFiles } from "../../scripts/lib/path-safety.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, "../fixtures/skill-only-source");

test("parent and child render exactly once per target", (context) => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "registry-skills-"));
  context.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const skills = discoverSkills({ sourceRoot });

  const claudeRoot = resolve(temporaryRoot, "claude");
  const codexRoot = resolve(temporaryRoot, "codex");
  renderSkills({ skills, destinationRoot: claudeRoot, target: "claude" });
  renderSkills({ skills, destinationRoot: codexRoot, target: "codex" });

  for (const targetRoot of [claudeRoot, codexRoot]) {
    const names = walkFiles(targetRoot)
      .filter((path) => path.endsWith("/SKILL.md"))
      .map((path) => readFileSync(path, "utf8"))
      .filter((markdown) => markdown.startsWith("---\n") || markdown.startsWith("---\r\n"))
      .map((markdown) => parseFrontmatter(markdown).attributes.name);
    assert.deepEqual(names.sort(), ["child", "parent"]);
  }

  assert.match(
    readFileSync(resolve(claudeRoot, "parent/SKILL.md"), "utf8"),
    /disable-model-invocation: true/,
  );
  assert.doesNotMatch(
    readFileSync(resolve(codexRoot, "parent/SKILL.md"), "utf8"),
    /disable-model-invocation/,
  );
  assert.equal(
    readFileSync(resolve(claudeRoot, "parent/phases/SKILL.md"), "utf8"),
    "# Internal phase\n\nThis file has no frontmatter and remains a parent resource.\n",
  );
});
