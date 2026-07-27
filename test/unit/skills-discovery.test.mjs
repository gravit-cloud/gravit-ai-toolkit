import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { discoverSkills } from "../../scripts/lib/skills.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, "../fixtures/skill-only-source");

test("discovers parent and frontmatter child but not an internal SKILL.md", () => {
  const skills = discoverSkills({ sourceRoot });
  assert.deepEqual(
    skills.map(({ name, relativeDirectory }) => ({ name, relativeDirectory })),
    [
      { name: "parent", relativeDirectory: "skills/parent" },
      { name: "child", relativeDirectory: "skills/parent/child" },
    ],
  );
});

test("honors declared skill paths and rejects paths outside the source", () => {
  assert.deepEqual(
    discoverSkills({
      sourceRoot,
      declaredSkills: "./skills/parent/child",
    }).map((skill) => skill.name),
    ["child"],
  );

  assert.deepEqual(
    discoverSkills({
      sourceRoot,
      declaredSkills: { primary: "./skills/parent", child: "./skills/parent/child" },
    }).map((skill) => skill.name),
    ["parent", "child"],
  );

  assert.throws(
    () => discoverSkills({ sourceRoot, declaredSkills: ["../outside"] }),
    /declared skill escapes source root/,
  );
});
