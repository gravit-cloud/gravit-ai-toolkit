import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { skillComponentId } from "../../scripts/lib/skill-identity.mjs";
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

test("recursively inventories declared roots and deduplicates overlapping declarations", () => {
  assert.deepEqual(
    discoverSkills({
      sourceRoot,
      declaredSkills: "./skills/parent",
    }).map(({ name, relativeDirectory }) => ({ name, relativeDirectory })),
    [
      { name: "parent", relativeDirectory: "skills/parent" },
      { name: "child", relativeDirectory: "skills/parent/child" },
    ],
  );

  assert.deepEqual(
    discoverSkills({
      sourceRoot,
      declaredSkills: ["./skills/parent", "./skills/parent/child"],
    }).map((skill) => skill.name),
    ["parent", "child"],
  );
});

test("orders discovered source paths by code point instead of locale collation", (context) => {
  const root = mkdtempSync(join(tmpdir(), "skills-ordering-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [directory, name] of [["a", "lower-path"], ["B", "upper-path"]]) {
    mkdirSync(join(root, "skills", directory), { recursive: true });
    writeFileSync(
      join(root, "skills", directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Ordering fixture\n---\n`,
    );
  }

  assert.deepEqual(
    discoverSkills({ sourceRoot: root }).map((skill) => skill.name),
    ["upper-path", "lower-path"],
  );
});

test("maps only the prototype host name and rejects component-id collisions", (context) => {
  assert.equal(skillComponentId("ordinary"), "ordinary");
  const prototypeId = skillComponentId("prototype");
  assert.match(prototypeId, /^skill-prototype-[a-f0-9]{12}$/);
  assert.throws(() => skillComponentId("constructor"), /prototype registry name/);

  const root = mkdtempSync(join(tmpdir(), "skills-identity-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [directory, name] of [
    ["prototype", "prototype"],
    ["collision", prototypeId],
  ]) {
    mkdirSync(join(root, "skills", directory), { recursive: true });
    writeFileSync(
      join(root, "skills", directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Identity fixture\n---\n`,
    );
  }

  assert.throws(
    () => discoverSkills({ sourceRoot: root }),
    new RegExp("duplicate skill component id: " + prototypeId),
  );
});

test("rejects a declared symlink root that resolves outside the source", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-discovery-"));
  const source = join(root, "source");
  const outside = join(root, "outside");
  mkdirSync(join(source, "skills"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), "---\nname: outside\ndescription: Outside\n---\n");
  symlinkSync(outside, join(source, "skills", "link"));

  try {
    assert.throws(
      () => discoverSkills({ sourceRoot: source, declaredSkills: "skills/link" }),
      /declared skill escapes source root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects symlinks nested below discovery roots", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-discovery-"));
  const skills = join(root, "skills");
  mkdirSync(join(skills, "parent"), { recursive: true });
  writeFileSync(join(skills, "parent", "SKILL.md"), "---\nname: parent\ndescription: Parent\n---\n");
  symlinkSync(join(skills, "parent"), join(skills, "linked-parent"));

  try {
    assert.throws(
      () => discoverSkills({ sourceRoot: root }),
      /symbolic links are not allowed in staged components/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
