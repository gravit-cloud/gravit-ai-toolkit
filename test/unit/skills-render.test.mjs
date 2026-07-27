import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  const renderedParent = readFileSync(resolve(codexRoot, "parent/SKILL.md"), "utf8");
  assert.match(renderedParent, /\[the child\]\(\.\.\/child\/SKILL\.md\)/);
  assert.match(renderedParent, /\[the guide\]\(\.\/guide\.md\)/);
  assert.match(
    readFileSync(resolve(codexRoot, "child/SKILL.md"), "utf8"),
    /\[the reference\]\(\.\/reference\.md\)/,
  );
});

test("Codex removes every true-like disable-model-invocation spelling", (context) => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "registry-skills-"));
  context.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const values = [
    "true",
    "yes",
    "on",
    "1",
    '"true"',
    '"yes"',
    '"on"',
    '"1"',
    "'true'",
    "'yes'",
    "'on'",
    "'1'",
    "TrUe",
    "  yes  ",
    '"  on  "',
    "' 1 '",
  ];

  for (const [index, value] of values.entries()) {
    const name = "skill-" + index;
    const sourceDirectory = resolve(temporaryRoot, "source", name);
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      resolve(sourceDirectory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test skill\ndisable-model-invocation: ${value}\n---\n\n# Test\n`,
    );

    const destinationRoot = resolve(temporaryRoot, "codex");
    renderSkills({
      skills: [{ id: name, name, sourceDirectory }],
      destinationRoot,
      target: "codex",
    });

    const rendered = readFileSync(resolve(destinationRoot, name, "SKILL.md"), "utf8");
    assert.doesNotMatch(rendered, /disable-model-invocation/);
    assert.match(rendered, /description: Test skill/);
    assert.match(rendered, /# Test/);
  }
});

test("rendering fails when an existing local link has no rendered owner", (context) => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "registry-skills-"));
  context.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const sourceDirectory = resolve(temporaryRoot, "source", "parent");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(resolve(temporaryRoot, "source", "shared.md"), "# Excluded resource\n");
  writeFileSync(
    resolve(sourceDirectory, "SKILL.md"),
    "---\nname: parent\ndescription: Parent\n---\n\nRead [the shared resource](../shared.md).\n",
  );

  assert.throws(
    () => renderSkills({
      skills: [{ id: "parent", name: "parent", sourceDirectory }],
      destinationRoot: resolve(temporaryRoot, "codex"),
      target: "codex",
    }),
    /unmapped local skill link/,
  );
});

test("rendering rejects an existing link target that escapes through a symlink", (context) => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "registry-skills-"));
  context.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const sourceDirectory = resolve(temporaryRoot, "source", "parent");
  const excludedFile = resolve(temporaryRoot, "source", "excluded.md");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(excludedFile, "# Excluded resource\n");
  symlinkSync(excludedFile, resolve(sourceDirectory, "resource.md"));
  writeFileSync(
    resolve(sourceDirectory, "SKILL.md"),
    "---\nname: parent\ndescription: Parent\n---\n\nRead [the resource](./resource.md).\n",
  );

  assert.throws(
    () => renderSkills({
      skills: [{ id: "parent", name: "parent", sourceDirectory }],
      destinationRoot: resolve(temporaryRoot, "codex"),
      target: "codex",
    }),
    /unmapped local skill link/,
  );
});

test("rendering leaves absolute and root-relative links unchanged", (context) => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "registry-skills-"));
  context.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const sourceDirectory = resolve(temporaryRoot, "source", "parent");
  const markdown = [
    "---",
    "name: parent",
    "description: Parent",
    "---",
    "",
    "[root](/etc/passwd)",
    "[network](//etc/passwd)",
    String.raw`[windows-drive](C:\Windows\System32\drivers\etc\hosts)`,
    String.raw`[windows-root](\Windows\System32\drivers\etc\hosts)`,
    "",
  ].join("\n");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(resolve(sourceDirectory, "SKILL.md"), markdown);

  const destinationRoot = resolve(temporaryRoot, "codex");
  renderSkills({
    skills: [{ id: "parent", name: "parent", sourceDirectory }],
    destinationRoot,
    target: "codex",
  });

  assert.equal(readFileSync(resolve(destinationRoot, "parent", "SKILL.md"), "utf8"), markdown);
});

test("rendering parses rich inline links and skips code", (context) => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "registry-skills-"));
  context.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const parentDirectory = resolve(temporaryRoot, "source", "parent");
  const childDirectory = resolve(parentDirectory, "child");
  mkdirSync(childDirectory, { recursive: true });
  writeFileSync(
    resolve(parentDirectory, "SKILL.md"),
    [
      "---",
      "name: parent",
      "description: Parent",
      "---",
      "",
      '[angle](<./child/guide with spaces.md#section> "Angle title")',
      '[nested](./child/nested(topic).md "Nested title")',
      String.raw`[escaped](./child/escaped\(topic\).md 'Escaped title')`,
      "`[inline](./child/SKILL.md)`",
      "`multiline code",
      "[multiline-code](./child/SKILL.md)`",
      "\\`[odd-backslash](./child/SKILL.md)\\`",
      "\\\\`[even-backslashes](./child/SKILL.md)`",
      "``shorter ` and longer ``` [exact-run-code](./child/SKILL.md)``",
      "[after-exact-run](./child/SKILL.md)",
      "[multiline-link](",
      "  ./child/SKILL.md",
      '  "Multiline title")',
      "```md",
      "[fenced](./child/SKILL.md)",
      "```",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(childDirectory, "SKILL.md"),
    "---\nname: child\ndescription: Child\n---\n",
  );
  writeFileSync(resolve(childDirectory, "guide with spaces.md"), "# Guide\n");
  writeFileSync(resolve(childDirectory, "nested(topic).md"), "# Nested\n");
  writeFileSync(resolve(childDirectory, "escaped(topic).md"), "# Escaped\n");

  const destinationRoot = resolve(temporaryRoot, "codex");
  renderSkills({
    skills: [
      { id: "parent", name: "parent", sourceDirectory: parentDirectory },
      { id: "child", name: "child", sourceDirectory: childDirectory },
    ],
    destinationRoot,
    target: "codex",
  });

  const rendered = readFileSync(resolve(destinationRoot, "parent", "SKILL.md"), "utf8");
  assert.match(rendered, /\[angle\]\(<\.\.\/child\/guide with spaces\.md#section> "Angle title"\)/);
  assert.match(rendered, /\[nested\]\(\.\.\/child\/nested\(topic\)\.md "Nested title"\)/);
  assert.match(
    rendered,
    /\[escaped\]\(\.\.\/child\/escaped\\\(topic\\\)\.md 'Escaped title'\)/,
  );
  assert.match(rendered, /`\[inline\]\(\.\/child\/SKILL\.md\)`/);
  assert.match(
    rendered,
    /`multiline code\n\[multiline-code\]\(\.\/child\/SKILL\.md\)`/,
  );
  assert.match(rendered, /\\`\[odd-backslash\]\(\.\.\/child\/SKILL\.md\)\\`/);
  assert.match(rendered, /\\\\`\[even-backslashes\]\(\.\/child\/SKILL\.md\)`/);
  assert.match(
    rendered,
    /``shorter ` and longer ``` \[exact-run-code\]\(\.\/child\/SKILL\.md\)``/,
  );
  assert.match(rendered, /\[after-exact-run\]\(\.\.\/child\/SKILL\.md\)/);
  assert.match(
    rendered,
    /\[multiline-link\]\(\n  \.\.\/child\/SKILL\.md\n  "Multiline title"\)/,
  );
  assert.match(rendered, /```md\n\[fenced\]\(\.\/child\/SKILL\.md\)\n```/);
});

test("rejects Windows-style skill names before creating a target tree", (context) => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "registry-skills-"));
  context.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const sourceDirectory = resolve(temporaryRoot, "source", "safe");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(
    resolve(sourceDirectory, "SKILL.md"),
    "---\nname: safe\ndescription: Safe source\n---\n",
  );

  for (const name of [String.raw`..\..\escaped`, String.raw`C:\escaped`]) {
    const destinationRoot = resolve(temporaryRoot, "target-" + name.length);
    assert.throws(
      () => renderSkills({
        skills: [{ id: name, name, sourceDirectory }],
        destinationRoot,
        target: "codex",
      }),
      /skill name must match \^\[a-z0-9\]/,
    );
    assert.equal(existsSync(destinationRoot), false);
  }
});
