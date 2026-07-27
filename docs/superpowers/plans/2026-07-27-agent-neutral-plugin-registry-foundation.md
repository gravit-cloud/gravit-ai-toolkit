# Agent-neutral Plugin Registry Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and test the deterministic registry foundation, safe source staging, neutral skill inventory, and separate Claude/Codex skill projections without replacing the current production sync yet.

**Architecture:** Introduce focused ESM modules under `scripts/lib/` and drive them through a new `scripts/build-registry.mjs` entry point. The first vertical slice consumes only local, skill-only fixtures; it proves catalog validation, safe skill discovery, non-overlapping rendering, deterministic hashing, and atomic output before the full component cutover in Plan 2.

**Tech Stack:** Node.js 24, ESM, built-in `node:test` and `node:assert/strict`, Ajv 8.17.1, existing giget 3.3.1.

## Global Constraints

- Keep `.claude-plugin/marketplace.json` and `scripts/sync-plugins.mjs` as the production path until Plan 2 performs the atomic cutover.
- All external GitHub sources require `repo`, human-readable `ref`, and an immutable lowercase 40-character SHA.
- Node.js 24 is the CI runtime.
- Generated JSON is UTF-8, two-space indented, key-stable, and ends with one newline.
- Test and validation commands must not require credentials or live cloud services.
- Never execute scripts, hooks, package installers, or binaries from a staged upstream source.
- Every resolved source and output path must remain inside its explicitly supplied root.
- Skill names must be unique across every recursively discoverable `SKILL.md` in one target projection.
- A parent skill render must exclude every independently selected descendant skill root.
- Codex rendering removes true-like `disable-model-invocation` values; Claude rendering preserves source frontmatter.
- No task may edit current generated plugin trees under `plugins/`.

---

## File Structure

- Create `scripts/lib/frontmatter.mjs`: parse the frontmatter fields required for component identity.
- Create `scripts/lib/path-safety.mjs`: safe path resolution, recursive walks, and boundary checks.
- Create `scripts/lib/skills.mjs`: skill discovery, overlap-aware copying, target transformation, and link rewriting.
- Create `scripts/lib/json.mjs`: stable JSON serialization and reads/writes.
- Create `scripts/lib/hash.mjs`: SHA-256 content and deterministic tree hashes.
- Create `scripts/lib/atomic-output.mjs`: stage and replace complete output trees without partial writes.
- Create `scripts/lib/catalog.mjs`: Ajv-backed catalog loading and semantic checks.
- Create `scripts/lib/source-loader.mjs`: safe local source copies and injected GitHub fetches.
- Create `scripts/lib/targets/claude.mjs`: render the Claude skill projection and manifest.
- Create `scripts/lib/targets/codex.mjs`: render the Codex skill projection and manifest.
- Create `scripts/lib/bundle-builder.mjs`: assemble a skill-only neutral bundle.
- Create `scripts/build-registry.mjs`: explicit non-production builder CLI used by fixture integration tests.
- Create `registry/schemas/catalog.schema.json`: schema for curated registry input.
- Create `registry/schemas/agent-plugin.schema.json`: initial neutral skill-bundle schema.
- Create `test/fixtures/skill-only-source/**`: overlapping skill source used by unit tests.
- Create `test/fixtures/skill-only-catalog.json`: local fixture catalog.
- Create `test/unit/*.test.mjs` and `test/integration/foundation-build.test.mjs`: regression and deterministic-build coverage.
- Modify `package.json` and `package-lock.json`: add the test script and pinned Ajv.

### Task 1: Establish the Node test harness and frontmatter parser

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/lib/frontmatter.mjs`
- Create: `test/unit/frontmatter.test.mjs`

**Interfaces:**

- Produces: `parseFrontmatter(markdown: string): { attributes: Record<string, string>, body: string, raw: string }`
- Produces: `isTrueLike(value: unknown): boolean`

- [ ] **Step 1: Add the test command and pinned schema validator**

Run:

~~~bash
npm install --save-dev --save-exact ajv@8.17.1
~~~

Then set these exact scripts in `package.json`:

~~~json
{
  "scripts": {
    "test": "node --test",
    "test:unit": "node --test test/unit",
    "test:integration": "node --test test/integration"
  }
}
~~~

Preserve the existing scripts alongside these three entries.

- [ ] **Step 2: Write the failing parser tests**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { isTrueLike, parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";

test("parseFrontmatter returns identity fields and body", () => {
  const parsed = parseFrontmatter([
    "---",
    "name: child",
    "description: Child skill",
    "disable-model-invocation: ON",
    "---",
    "",
    "# Child",
    "",
  ].join("\n"));

  assert.deepEqual(parsed.attributes, {
    name: "child",
    description: "Child skill",
    "disable-model-invocation": "ON",
  });
  assert.equal(parsed.body, "# Child\n");
});

test("parseFrontmatter rejects a skill without a closed header", () => {
  assert.throws(
    () => parseFrontmatter("---\nname: broken\n"),
    /frontmatter must start and end with ---/,
  );
});

test("isTrueLike accepts every Claude boolean spelling that means true", () => {
  for (const value of ["true", "TRUE", "yes", "ON", "1", true]) {
    assert.equal(isTrueLike(value), true);
  }
  for (const value of ["false", "no", "off", "0", false, undefined]) {
    assert.equal(isTrueLike(value), false);
  }
});
~~~

- [ ] **Step 3: Run the tests and verify the missing module failure**

Run: `node --test test/unit/frontmatter.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/lib/frontmatter.mjs`.

- [ ] **Step 4: Implement the parser**

~~~js
const TRUE_LIKE = new Set(["true", "yes", "on", "1"]);

export function isTrueLike(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return TRUE_LIKE.has(value.trim().toLowerCase());
}

export function parseFrontmatter(markdown) {
  const match = String(markdown).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error("frontmatter must start and end with ---");
  }

  const attributes = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    attributes[field[1]] = field[2].trim().replace(/^["']|["']$/g, "");
  }

  return {
    attributes,
    body: String(markdown).slice(match[0].length),
    raw: match[0],
  };
}
~~~

- [ ] **Step 5: Run the focused and complete test suites**

Run: `node --test test/unit/frontmatter.test.mjs && npm test`

Expected: both commands exit 0; three focused tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add package.json package-lock.json scripts/lib/frontmatter.mjs test/unit/frontmatter.test.mjs
git commit -m "test(registry): add node test harness"
~~~

### Task 2: Discover standalone skills without confusing internal modules

**Files:**

- Create: `test/fixtures/skill-only-source/skills/parent/SKILL.md`
- Create: `test/fixtures/skill-only-source/skills/parent/guide.md`
- Create: `test/fixtures/skill-only-source/skills/parent/phases/SKILL.md`
- Create: `test/fixtures/skill-only-source/skills/parent/child/SKILL.md`
- Create: `test/fixtures/skill-only-source/skills/parent/child/reference.md`
- Create: `scripts/lib/path-safety.mjs`
- Create: `scripts/lib/skills.mjs`
- Create: `test/unit/skills-discovery.test.mjs`

**Interfaces:**

- Consumes: `parseFrontmatter(markdown)`
- Produces: `assertInside(root: string, candidate: string, label: string): string`
- Produces: `assertRealInside(root: string, candidate: string, label: string): string`
- Produces: `walkFiles(root: string): string[]`, sorted absolute file paths
- Produces: `declaredSkillPaths(value): string[] | undefined`
- Produces: `discoverSkills({ sourceRoot, declaredSkills }): SkillRecord[]`
- `SkillRecord`: `{ id, name, description, sourceDirectory, relativeDirectory }`

- [ ] **Step 1: Create the exact overlapping fixture**

Parent `SKILL.md`:

~~~markdown
---
name: parent
description: Parent orchestrator
disable-model-invocation: true
---

# Parent

Read [the child](./child/SKILL.md) and [the guide](./guide.md).
~~~

Child `SKILL.md`:

~~~markdown
---
name: child
description: Independently invokable child
---

# Child

Read [the reference](./reference.md).
~~~

Internal `phases/SKILL.md`:

~~~markdown
# Internal phase

This file has no frontmatter and remains a parent resource.
~~~

Use `# Parent guide` for `guide.md` and `# Child reference` for `reference.md`.

- [ ] **Step 2: Write the failing discovery tests**

~~~js
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
~~~

- [ ] **Step 3: Run the test and verify the missing export failure**

Run: `node --test test/unit/skills-discovery.test.mjs`

Expected: FAIL because `scripts/lib/skills.mjs` does not exist.

- [ ] **Step 4: Implement path safety**

~~~js
import { readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function assertInside(root, candidate, label) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const nested = relative(absoluteRoot, absoluteCandidate);
  if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) {
    return absoluteCandidate;
  }
  throw new Error(label + " escapes source root: " + candidate);
}

export function assertRealInside(root, candidate, label) {
  return assertInside(realpathSync(root), realpathSync(candidate), label);
}

export function walkFiles(root, result = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("symbolic links are not allowed in staged components: " + path);
    }
    if (entry.isDirectory()) walkFiles(path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
~~~

- [ ] **Step 5: Implement deterministic discovery**

~~~js
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";
import { assertInside } from "./path-safety.mjs";

function standaloneSkill(directory) {
  const skillFile = resolve(directory, "SKILL.md");
  if (!existsSync(skillFile)) return undefined;
  const markdown = readFileSync(skillFile, "utf8");
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return undefined;
  const { attributes } = parseFrontmatter(markdown);
  if (!attributes.name || !attributes.description) {
    throw new Error(skillFile + ": standalone skills require name and description");
  }
  return {
    id: attributes.name,
    name: attributes.name,
    description: attributes.description,
    sourceDirectory: directory,
  };
}

function recurse(directory, result) {
  const skill = standaloneSkill(directory);
  if (skill) result.push(skill);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    recurse(resolve(directory, entry.name), result);
  }
}

export function declaredSkillPaths(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    Object.values(value).every((entry) => typeof entry === "string")
  ) {
    return Object.values(value);
  }
  throw new Error("declared skills must be a path, path array, or name-to-path object");
}

export function discoverSkills({ sourceRoot, declaredSkills }) {
  const absoluteRoot = resolve(sourceRoot);
  const result = [];
  const configuredPaths = declaredSkillPaths(declaredSkills);
  if (configuredPaths) {
    for (const configuredPath of configuredPaths) {
      const directory = assertInside(
        absoluteRoot,
        resolve(absoluteRoot, configuredPath),
        "declared skill",
      );
      const skill = standaloneSkill(directory);
      if (skill) result.push(skill);
      else recurse(directory, result);
    }
  } else {
    const defaultRoot = resolve(absoluteRoot, "skills");
    if (existsSync(defaultRoot)) recurse(defaultRoot, result);
  }

  const sourceDirectories = new Set();
  const names = new Set();
  return result
    .filter((skill) => {
      if (sourceDirectories.has(skill.sourceDirectory)) return false;
      sourceDirectories.add(skill.sourceDirectory);
      return true;
    })
    .map((skill) => ({
      ...skill,
      relativeDirectory: relative(absoluteRoot, skill.sourceDirectory).replaceAll("\\", "/"),
    }))
    .sort((left, right) => left.sourceDirectory.localeCompare(right.sourceDirectory))
    .map((skill) => {
      if (names.has(skill.name)) throw new Error("duplicate skill name: " + skill.name);
      names.add(skill.name);
      return skill;
    });
}
~~~

Remove the unused `basename` import before saving the file.

- [ ] **Step 6: Run tests**

Run: `node --test test/unit/skills-discovery.test.mjs && npm test`

Expected: all tests pass.

- [ ] **Step 7: Commit**

~~~bash
git add scripts/lib/path-safety.mjs scripts/lib/skills.mjs test/fixtures/skill-only-source test/unit/skills-discovery.test.mjs
git commit -m "feat(registry): discover standalone skills safely"
~~~

### Task 3: Render non-overlapping Claude and Codex skill trees

**Files:**

- Modify: `scripts/lib/skills.mjs`
- Create: `test/unit/skills-render.test.mjs`

**Interfaces:**

- Consumes: `SkillRecord[]`
- Produces: `renderSkills({ skills, destinationRoot, target }): RenderedSkill[]`
- `RenderedSkill`: `{ id, name, directory, skillFile }`

- [ ] **Step 1: Write the failing regression test**

~~~js
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
      .map((path) => parseFrontmatter(readFileSync(path, "utf8")).attributes.name);
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
~~~

- [ ] **Step 2: Verify the missing renderer failure**

Run: `node --test test/unit/skills-render.test.mjs`

Expected: FAIL because `renderSkills` is not exported.

- [ ] **Step 3: Implement overlap-aware rendering**

Add these imports to `skills.mjs`:

~~~js
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isTrueLike, parseFrontmatter } from "./frontmatter.mjs";
~~~

Keep only one import per Node module. Then add:

~~~js
function nestedWithin(parent, candidate) {
  const nested = relative(parent, candidate);
  return nested !== "" && !nested.startsWith("..") && !isAbsolute(nested);
}

function codexMarkdown(markdown) {
  const { attributes } = parseFrontmatter(markdown);
  if (!isTrueLike(attributes["disable-model-invocation"])) return markdown;
  return markdown.replace(
    /^disable-model-invocation:\s*(?:true|yes|on|1)\s*\r?\n/im,
    "",
  );
}

export function renderSkills({ skills, destinationRoot, target }) {
  if (!["claude", "codex"].includes(target)) {
    throw new Error("unsupported skill target: " + target);
  }
  mkdirSync(destinationRoot, { recursive: true });
  const rendered = [];

  for (const skill of skills) {
    const destination = resolve(destinationRoot, skill.name);
    const descendantRoots = skills
      .filter((candidate) => nestedWithin(skill.sourceDirectory, candidate.sourceDirectory))
      .map((candidate) => candidate.sourceDirectory);

    cpSync(skill.sourceDirectory, destination, {
      recursive: true,
      filter(source) {
        return !descendantRoots.some(
          (descendant) => source === descendant || nestedWithin(descendant, source),
        );
      },
    });

    const skillFile = resolve(destination, "SKILL.md");
    if (target === "codex") {
      writeFileSync(skillFile, codexMarkdown(readFileSync(skillFile, "utf8")));
    }
    rendered.push({ id: skill.id, name: skill.name, directory: destination, skillFile });
  }

  return rendered;
}
~~~

- [ ] **Step 4: Run the focused regression and complete tests**

Run: `node --test test/unit/skills-render.test.mjs && npm test`

Expected: the rendered recursive names are exactly `child` and `parent` for both targets.

- [ ] **Step 5: Commit**

~~~bash
git add scripts/lib/skills.mjs test/unit/skills-render.test.mjs
git commit -m "fix(registry): render nested skills once"
~~~

### Task 4: Rewrite local links from source topology to target topology

**Files:**

- Modify: `scripts/lib/skills.mjs`
- Modify: `test/unit/skills-render.test.mjs`

**Interfaces:**

- Consumes: the complete `SkillRecord[]` mapping.
- Produces: target-relative Markdown links that resolve after flattening.
- Failure contract: a relative link whose source target exists but is excluded from all rendered skills throws `unmapped local skill link`.

- [ ] **Step 1: Add link assertions to the renderer test**

~~~js
const renderedParent = readFileSync(resolve(codexRoot, "parent/SKILL.md"), "utf8");
assert.match(renderedParent, /\[the child\]\(\.\.\/child\/SKILL\.md\)/);
assert.match(renderedParent, /\[the guide\]\(\.\/guide\.md\)/);
assert.match(
  readFileSync(resolve(codexRoot, "child/SKILL.md"), "utf8"),
  /\[the reference\]\(\.\/reference\.md\)/,
);
~~~

- [ ] **Step 2: Run the test to show the child link still points inside the parent**

Run: `node --test test/unit/skills-render.test.mjs`

Expected: FAIL because the output still contains `./child/SKILL.md`.

- [ ] **Step 3: Add generic link rewriting**

Add `dirname` to the `node:path` import, then add:

~~~js
function renderedOwner(skills, absoluteTarget) {
  return skills
    .filter((skill) => (
      absoluteTarget === skill.sourceDirectory ||
      nestedWithin(skill.sourceDirectory, absoluteTarget)
    ))
    .sort((left, right) => right.sourceDirectory.length - left.sourceDirectory.length)[0];
}

function rewriteLinks({ markdown, sourceSkillFile, destinationSkillFile, skills, destinationRoot }) {
  return markdown.replace(/\[([^\]]+)]\(([^)]+)\)/g, (whole, label, rawTarget) => {
    const target = rawTarget.trim().replace(/^<|>$/g, "");
    if (!target || /^(https?:|mailto:|#)/.test(target)) return whole;
    const hashIndex = target.indexOf("#");
    const targetPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const anchor = hashIndex === -1 ? "" : target.slice(hashIndex);
    if (!targetPath || targetPath.includes(" ")) return whole;

    const absoluteTarget = resolve(dirname(sourceSkillFile), targetPath);
    const owner = renderedOwner(skills, absoluteTarget);
    if (!owner) return whole;

    const mappedTarget = resolve(
      destinationRoot,
      owner.name,
      relative(owner.sourceDirectory, absoluteTarget),
    );
    let rewritten = relative(dirname(destinationSkillFile), mappedTarget).replaceAll("\\", "/");
    if (!rewritten.startsWith(".")) rewritten = "./" + rewritten;
    return "[" + label + "](" + rewritten + anchor + ")";
  });
}
~~~

Inside `renderSkills`, transform every rendered `SKILL.md` after all copies finish:

~~~js
for (const output of rendered) {
  const source = skills.find((skill) => skill.name === output.name);
  let markdown = readFileSync(output.skillFile, "utf8");
  markdown = rewriteLinks({
    markdown,
    sourceSkillFile: resolve(source.sourceDirectory, "SKILL.md"),
    destinationSkillFile: output.skillFile,
    skills,
    destinationRoot,
  });
  if (target === "codex") markdown = codexMarkdown(markdown);
  writeFileSync(output.skillFile, markdown);
}
~~~

Remove the earlier one-file Codex write inside the copy loop so each file is transformed once.

- [ ] **Step 4: Run all unit tests**

Run: `npm run test:unit`

Expected: all tests pass and no repository-specific link exception exists.

- [ ] **Step 5: Commit**

~~~bash
git add scripts/lib/skills.mjs test/unit/skills-render.test.mjs
git commit -m "feat(registry): rewrite projected skill links"
~~~

### Task 5: Validate the neutral catalog with JSON Schema

**Files:**

- Create: `registry/schemas/catalog.schema.json`
- Create: `registry/schemas/agent-plugin.schema.json`
- Create: `scripts/lib/catalog.mjs`
- Create: `test/fixtures/skill-only-catalog.json`
- Create: `test/unit/catalog.test.mjs`

**Interfaces:**

- Produces: `loadCatalog({ repositoryRoot, catalogPath }): Catalog`
- Produces: `validateCatalog(catalog): void`
- Catalog plugins expose `name`, `description`, `category`, `distributionVersion`, `source`, `targets`, and `policies`.

- [ ] **Step 1: Write the catalog schema**

Use this exact required core:

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gravit.cloud/schemas/plugin-catalog-v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "name", "plugins"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "name": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*$" },
    "plugins": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/plugin" }
    }
  },
  "$defs": {
    "plugin": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "name",
        "description",
        "category",
        "distributionVersion",
        "source",
        "targets",
        "policies"
      ],
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*$" },
        "description": { "type": "string", "minLength": 1 },
        "category": { "enum": ["cloud", "development", "productivity", "seo"] },
        "distributionVersion": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"
        },
        "source": {
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["type", "path"],
              "properties": {
                "type": { "const": "local" },
                "path": { "type": "string", "pattern": "^test/fixtures/" },
                "root": { "type": "string", "default": "." }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["type", "repo", "ref", "sha"],
              "properties": {
                "type": { "const": "github" },
                "repo": { "type": "string", "pattern": "^[^/]+/[^/]+$" },
                "ref": { "type": "string", "minLength": 1 },
                "sha": { "type": "string", "pattern": "^[a-f0-9]{40}$" },
                "root": { "type": "string", "default": "." }
              }
            }
          ]
        },
        "targets": {
          "type": "array",
          "uniqueItems": true,
          "items": { "enum": ["claude", "codex"] }
        },
        "policies": {
          "type": "object",
          "additionalProperties": false,
          "required": ["default", "skills"],
          "properties": {
            "default": { "enum": ["transform-or-fail"] },
            "skills": { "enum": ["preserve", "transform"] }
          }
        }
      }
    }
  }
}
~~~

The production schema is deliberately expanded in Plan 2 before the real catalog is introduced.

- [ ] **Step 2: Write the initial neutral manifest schema**

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gravit.cloud/schemas/agent-plugin-v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "name", "distributionVersion", "components", "targets"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "name": { "type": "string" },
    "distributionVersion": { "type": "string" },
    "components": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "type", "path", "digest"],
        "properties": {
          "id": { "type": "string" },
          "type": { "const": "skill" },
          "path": { "type": "string" },
          "digest": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
        }
      }
    },
    "targets": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["status", "path"],
        "properties": {
          "status": { "enum": ["preserved", "transformed"] },
          "path": { "type": "string" }
        }
      }
    }
  }
}
~~~

- [ ] **Step 3: Create the fixture catalog**

~~~json
{
  "schemaVersion": 1,
  "name": "fixture-marketplace",
  "plugins": [
    {
      "name": "nested-skills",
      "description": "Nested skill rendering fixture",
      "category": "development",
      "distributionVersion": "1.0.0-gravit.1",
      "source": {
        "type": "local",
        "path": "test/fixtures/skill-only-source",
        "root": "."
      },
      "targets": ["claude", "codex"],
      "policies": {
        "default": "transform-or-fail",
        "skills": "transform"
      }
    }
  ]
}
~~~

- [ ] **Step 4: Write failing schema tests**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, validateCatalog } from "../../scripts/lib/catalog.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("loads the checked-in fixture catalog", () => {
  const catalog = loadCatalog({
    repositoryRoot,
    catalogPath: "test/fixtures/skill-only-catalog.json",
  });
  assert.equal(catalog.plugins[0].name, "nested-skills");
});

test("rejects duplicate plugin names after schema validation", () => {
  const catalog = loadCatalog({
    repositoryRoot,
    catalogPath: "test/fixtures/skill-only-catalog.json",
  });
  catalog.plugins.push(structuredClone(catalog.plugins[0]));
  assert.throws(() => validateCatalog(catalog), /duplicate plugin name: nested-skills/);
});
~~~

- [ ] **Step 5: Run the tests and verify the missing module failure**

Run: `node --test test/unit/catalog.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 6: Implement catalog loading**

~~~js
import Ajv from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const schemaUrl = new URL("../../registry/schemas/catalog.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

export function validateCatalog(catalog) {
  if (!validateSchema(catalog)) {
    const details = validateSchema.errors
      .map((error) => error.instancePath + " " + error.message)
      .join("; ");
    throw new Error("invalid registry catalog: " + details);
  }
  const names = new Set();
  for (const plugin of catalog.plugins) {
    if (names.has(plugin.name)) throw new Error("duplicate plugin name: " + plugin.name);
    names.add(plugin.name);
  }
}

export function loadCatalog({ repositoryRoot, catalogPath }) {
  const absolutePath = resolve(repositoryRoot, catalogPath);
  const catalog = JSON.parse(readFileSync(absolutePath, "utf8"));
  validateCatalog(catalog);
  return catalog;
}
~~~

- [ ] **Step 7: Run all tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 8: Commit**

~~~bash
git add registry/schemas scripts/lib/catalog.mjs test/fixtures/skill-only-catalog.json test/unit/catalog.test.mjs
git commit -m "feat(registry): validate neutral catalogs"
~~~

### Task 6: Add stable JSON, tree hashing, and atomic output

**Files:**

- Create: `scripts/lib/json.mjs`
- Create: `scripts/lib/hash.mjs`
- Create: `scripts/lib/atomic-output.mjs`
- Create: `test/unit/artifacts.test.mjs`

**Interfaces:**

- Produces: `stableJson(value): string`
- Produces: `writeJson(filePath, value): void`
- Produces: `sha256(value: string | Buffer): string`
- Produces: `treeHash(root): string`
- Produces: `withAtomicOutput({ finalRoot, build }): void`

- [ ] **Step 1: Write failing artifact tests**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stableJson } from "../../scripts/lib/json.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";
import { withAtomicOutput } from "../../scripts/lib/atomic-output.mjs";

test("stableJson sorts object keys recursively", () => {
  assert.equal(stableJson({ z: 1, a: { y: 2, b: 3 } }), '{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n');
});

test("treeHash is independent of file creation order", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-hash-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, "b.txt"), "two\n");
  writeFileSync(resolve(root, "a.txt"), "one\n");
  const first = treeHash(root);
  rmSync(resolve(root, "a.txt"));
  writeFileSync(resolve(root, "a.txt"), "one\n");
  assert.equal(treeHash(root), first);
});

test("withAtomicOutput preserves the old tree when build throws", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  withAtomicOutput({
    finalRoot,
    build(stage) {
      writeFileSync(resolve(stage, "state.txt"), "old\n");
    },
  });
  assert.throws(() => withAtomicOutput({
    finalRoot,
    build(stage) {
      writeFileSync(resolve(stage, "state.txt"), "new\n");
      throw new Error("synthetic failure");
    },
  }), /synthetic failure/);
  assert.equal(readFileSync(resolve(finalRoot, "state.txt"), "utf8"), "old\n");
});

test("withAtomicOutput never deletes a pre-existing sibling backup path", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  const foreignBackup = resolve(parent, "output.backup");
  mkdirSync(foreignBackup);
  writeFileSync(resolve(foreignBackup, "owned-by-user.txt"), "keep\n");
  withAtomicOutput({
    finalRoot,
    build(stage) {
      writeFileSync(resolve(stage, "state.txt"), "new\n");
    },
  });
  assert.equal(readFileSync(resolve(foreignBackup, "owned-by-user.txt"), "utf8"), "keep\n");
});
~~~

- [ ] **Step 2: Verify missing module failures**

Run: `node --test test/unit/artifacts.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement stable JSON**

~~~js
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
  );
}

export function stableJson(value) {
  return JSON.stringify(sortValue(value), null, 2) + "\n";
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, stableJson(value));
}
~~~

- [ ] **Step 4: Implement deterministic hashes**

~~~js
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walkFiles } from "./path-safety.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function treeHash(root) {
  const lines = walkFiles(root).map((filePath) => {
    const path = relative(root, filePath).replaceAll("\\", "/");
    return path + "\0" + sha256(readFileSync(filePath));
  });
  return sha256(lines.join("\n"));
}
~~~

- [ ] **Step 5: Implement atomic directory replacement**

~~~js
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export function withAtomicOutput({ finalRoot, build }) {
  const parent = dirname(resolve(finalRoot));
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(resolve(parent, "." + basename(finalRoot) + ".stage-"));
  const backupRoot = mkdtempSync(resolve(parent, "." + basename(finalRoot) + ".backup-"));
  const backup = resolve(backupRoot, "previous");
  try {
    build(stage);
    if (existsSync(finalRoot)) renameSync(finalRoot, backup);
    try {
      renameSync(stage, finalRoot);
      rmSync(backupRoot, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(backup) && !existsSync(finalRoot)) renameSync(backup, finalRoot);
      throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
}
~~~

- [ ] **Step 6: Run tests**

Run: `node --test test/unit/artifacts.test.mjs && npm test`

Expected: all tests pass.

- [ ] **Step 7: Commit**

~~~bash
git add scripts/lib/json.mjs scripts/lib/hash.mjs scripts/lib/atomic-output.mjs test/unit/artifacts.test.mjs
git commit -m "feat(registry): add deterministic artifact primitives"
~~~

### Task 7: Stage complete local and GitHub source roots safely

**Files:**

- Create: `scripts/lib/source-loader.mjs`
- Create: `test/unit/source-loader.test.mjs`

**Interfaces:**

- Produces: `stageSource({ plugin, repositoryRoot, destinationRoot, fetchGitHub }): string`
- `fetchGitHub({ repo, sha, destination }): void` downloads the repository root and never executes it.

- [ ] **Step 1: Write failing local and injected-GitHub tests**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageSource } from "../../scripts/lib/source-loader.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = resolve(repositoryRoot, "test/fixtures/skill-only-source");

test("stages a complete local source", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  const sourceRoot = stageSource({
    plugin: {
      name: "local",
      source: { type: "local", path: "test/fixtures/skill-only-source", root: "." },
    },
    repositoryRoot,
    destinationRoot,
  });
  assert.equal(existsSync(resolve(sourceRoot, "skills/parent/SKILL.md")), true);
});

test("GitHub staging fetches the repository root at the SHA", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  const calls = [];
  stageSource({
    plugin: {
      name: "remote",
      source: {
        type: "github",
        repo: "owner/repository",
        ref: "v1.0.0",
        sha: "0123456789abcdef0123456789abcdef01234567",
        root: ".",
      },
    },
    repositoryRoot,
    destinationRoot,
    fetchGitHub(input) {
      calls.push(input);
      cpSync(fixture, input.destination, { recursive: true });
    },
  });
  assert.deepEqual(calls.map(({ repo, sha }) => ({ repo, sha })), [{
    repo: "owner/repository",
    sha: "0123456789abcdef0123456789abcdef01234567",
  }]);
});

test("rejects a local source symlink that escapes the repository", (context) => {
  const sandbox = mkdtempSync(resolve(tmpdir(), "registry-repository-"));
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(sandbox, { recursive: true, force: true }));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  mkdirSync(resolve(sandbox, "sources"));
  symlinkSync(fixture, resolve(sandbox, "sources/escaped"), "dir");
  assert.throws(() => stageSource({
    plugin: {
      name: "escaped",
      source: { type: "local", path: "sources/escaped", root: "." },
    },
    repositoryRoot: sandbox,
    destinationRoot,
  }), /local plugin source escapes source root/);
});
~~~

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `node --test test/unit/source-loader.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement source staging with an injectable fetcher**

~~~js
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertInside, assertRealInside } from "./path-safety.mjs";

function defaultFetchGitHub({ repo, sha, destination, repositoryRoot }) {
  const gigetCli = resolve(repositoryRoot, "node_modules/giget/dist/cli.mjs");
  const result = spawnSync(
    process.execPath,
    [gigetCli, "gh:" + repo + "#" + sha, destination, "--force"],
    { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    throw new Error("giget failed: " + (result.stderr || result.stdout || "").trim());
  }
}

export function stageSource({
  plugin,
  repositoryRoot,
  destinationRoot,
  fetchGitHub = defaultFetchGitHub,
}) {
  const stage = resolve(destinationRoot, plugin.name);
  mkdirSync(destinationRoot, { recursive: true });
  if (plugin.source.type === "local") {
    const localSource = assertInside(
      repositoryRoot,
      resolve(repositoryRoot, plugin.source.path),
      "local plugin source",
    );
    const safeLocalSource = assertRealInside(
      repositoryRoot,
      localSource,
      "local plugin source",
    );
    cpSync(safeLocalSource, stage, { recursive: true, dereference: false });
  } else {
    fetchGitHub({
      repo: plugin.source.repo,
      sha: plugin.source.sha,
      destination: stage,
      repositoryRoot,
    });
  }
  const configuredRoot = assertInside(
    stage,
    resolve(stage, plugin.source.root || "."),
    "plugin source root",
  );
  return assertRealInside(stage, configuredRoot, "plugin source root");
}
~~~

- [ ] **Step 4: Run all tests**

Run: `npm test`

Expected: all tests pass without network access because the GitHub test injects its fetcher.

- [ ] **Step 5: Commit**

~~~bash
git add scripts/lib/source-loader.mjs test/unit/source-loader.test.mjs
git commit -m "feat(registry): stage complete pinned sources"
~~~

### Task 8: Build a deterministic skill-only universal bundle

**Files:**

- Create: `scripts/lib/targets/claude.mjs`
- Create: `scripts/lib/targets/codex.mjs`
- Create: `scripts/lib/bundle-builder.mjs`
- Create: `scripts/build-registry.mjs`
- Create: `test/integration/foundation-build.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces: `renderClaudeTarget({ plugin, skills, bundleRoot }): TargetResult`
- Produces: `renderCodexTarget({ plugin, skills, bundleRoot }): TargetResult`
- Produces: `buildPluginBundle({ plugin, sourceRoot, bundleRoot }): BundleResult`
- Produces: `buildRegistry({ repositoryRoot, catalogPath, outputRoot, fetchGitHub }): RegistryResult`
- CLI example: `node scripts/build-registry.mjs --catalog test/fixtures/skill-only-catalog.json --output /tmp/gravit-registry-output`

- [ ] **Step 1: Write the failing deterministic integration test**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "../../scripts/build-registry.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("builds byte-identical universal bundles twice", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-build-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const first = resolve(parent, "first");
  const second = resolve(parent, "second");
  const input = {
    repositoryRoot,
    catalogPath: "test/fixtures/skill-only-catalog.json",
  };
  buildRegistry({ ...input, outputRoot: first });
  buildRegistry({ ...input, outputRoot: second });
  assert.equal(treeHash(first), treeHash(second));

  const bundle = resolve(first, "plugins/nested-skills");
  const neutral = JSON.parse(readFileSync(resolve(bundle, ".agent-plugin/plugin.json")));
  assert.deepEqual(neutral.components.map((component) => component.id), ["child", "parent"]);
  assert.equal(
    JSON.parse(readFileSync(
      resolve(bundle, "targets/codex/.codex-plugin/plugin.json"),
    )).interface.defaultPrompt.length,
    1,
  );
});
~~~

- [ ] **Step 2: Run the test and verify the missing builder failure**

Run: `node --test test/integration/foundation-build.test.mjs`

Expected: FAIL because `scripts/build-registry.mjs` does not exist.

- [ ] **Step 3: Implement the Claude target**

~~~js
import { resolve } from "node:path";
import { writeJson } from "../json.mjs";
import { renderSkills } from "../skills.mjs";

export function renderClaudeTarget({ plugin, skills, bundleRoot }) {
  const targetRoot = resolve(bundleRoot, "targets/claude");
  const skillsRoot = resolve(targetRoot, "skills");
  renderSkills({ skills, destinationRoot: skillsRoot, target: "claude" });
  writeJson(resolve(targetRoot, ".claude-plugin/plugin.json"), {
    name: plugin.name,
    version: plugin.distributionVersion,
    description: plugin.description,
    skills: "./skills/",
  });
  return { status: "transformed", path: "targets/claude" };
}
~~~

- [ ] **Step 4: Implement the Codex target**

~~~js
import { resolve } from "node:path";
import { writeJson } from "../json.mjs";
import { renderSkills } from "../skills.mjs";

const CATEGORY = {
  cloud: "Cloud",
  development: "Development",
  productivity: "Productivity",
  seo: "Productivity",
};

export function renderCodexTarget({ plugin, skills, bundleRoot }) {
  const targetRoot = resolve(bundleRoot, "targets/codex");
  const skillsRoot = resolve(targetRoot, "skills");
  renderSkills({ skills, destinationRoot: skillsRoot, target: "codex" });
  writeJson(resolve(targetRoot, ".codex-plugin/plugin.json"), {
    name: plugin.name,
    version: plugin.distributionVersion,
    description: plugin.description,
    author: { name: "Gravit Cloud" },
    skills: "./skills/",
    interface: {
      displayName: plugin.name,
      shortDescription: plugin.description.slice(0, 110),
      longDescription: plugin.description,
      developerName: "Gravit Cloud",
      category: CATEGORY[plugin.category],
      capabilities: [],
      defaultPrompt: ["Use " + plugin.name + " to help with this task."],
    },
  });
  return { status: "transformed", path: "targets/codex" };
}
~~~

- [ ] **Step 5: Implement the skill-only bundle builder**

~~~js
import { cpSync, mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { treeHash } from "./hash.mjs";
import { writeJson } from "./json.mjs";
import { discoverSkills } from "./skills.mjs";
import { renderClaudeTarget } from "./targets/claude.mjs";
import { renderCodexTarget } from "./targets/codex.mjs";

export function buildPluginBundle({ plugin, sourceRoot, bundleRoot }) {
  mkdirSync(bundleRoot, { recursive: true });
  const skills = discoverSkills({ sourceRoot });
  const components = skills.map((skill) => {
    const destination = resolve(bundleRoot, "components/skills", skill.name);
    cpSync(skill.sourceDirectory, destination, { recursive: true });
    return {
      id: skill.name,
      type: "skill",
      path: relative(bundleRoot, destination).replaceAll("\\", "/"),
      digest: treeHash(destination),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const targets = {};
  if (plugin.targets.includes("claude")) {
    targets.claude = renderClaudeTarget({ plugin, skills, bundleRoot });
  }
  if (plugin.targets.includes("codex")) {
    targets.codex = renderCodexTarget({ plugin, skills, bundleRoot });
  }
  const manifest = {
    schemaVersion: 1,
    name: plugin.name,
    distributionVersion: plugin.distributionVersion,
    components,
    targets,
  };
  writeJson(resolve(bundleRoot, ".agent-plugin/plugin.json"), manifest);
  return manifest;
}
~~~

- [ ] **Step 6: Implement the fixture registry builder and CLI**

~~~js
#!/usr/bin/env node
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withAtomicOutput } from "./lib/atomic-output.mjs";
import { buildPluginBundle } from "./lib/bundle-builder.mjs";
import { loadCatalog } from "./lib/catalog.mjs";
import { stageSource } from "./lib/source-loader.mjs";

export function buildRegistry({
  repositoryRoot,
  catalogPath,
  outputRoot,
  fetchGitHub,
}) {
  const catalog = loadCatalog({ repositoryRoot, catalogPath });
  return withAtomicOutput({
    finalRoot: outputRoot,
    build(stage) {
      const sourceStage = resolve(stage, ".sources");
      for (const plugin of catalog.plugins) {
        const sourceRoot = stageSource({
          plugin,
          repositoryRoot,
          destinationRoot: sourceStage,
          fetchGitHub,
        });
        buildPluginBundle({
          plugin,
          sourceRoot,
          bundleRoot: resolve(stage, "plugins", plugin.name),
        });
      }
      rmSync(sourceStage, { recursive: true, force: true });
    },
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error("missing required argument " + name);
  }
  return process.argv[index + 1];
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  buildRegistry({
    repositoryRoot,
    catalogPath: argument("--catalog"),
    outputRoot: resolve(argument("--output")),
  });
}
~~~

Remove unused `mkdirSync` from the import before saving.

- [ ] **Step 7: Add the explicit foundation builder script**

Add to `package.json`:

~~~json
{
  "scripts": {
    "registry:build:foundation": "node scripts/build-registry.mjs --catalog test/fixtures/skill-only-catalog.json --output .tmp/registry-foundation"
  }
}
~~~

This is not `plugins:sync`; the production command remains untouched.

- [ ] **Step 8: Run focused, full, and deterministic checks**

Run:

~~~bash
npm test
npm run registry:build:foundation
node scripts/build-registry.mjs --catalog test/fixtures/skill-only-catalog.json --output .tmp/registry-foundation-second
diff -ru .tmp/registry-foundation .tmp/registry-foundation-second
git diff --exit-code -- .claude-plugin .agents plugins
~~~

Expected:

- all tests pass;
- `diff -ru` prints nothing and exits 0;
- current production marketplace and plugin trees remain unchanged.

- [ ] **Step 9: Commit**

~~~bash
git add package.json scripts/build-registry.mjs scripts/lib/bundle-builder.mjs scripts/lib/targets test/integration/foundation-build.test.mjs
git commit -m "feat(registry): build deterministic skill bundles"
~~~

## Plan 1 Completion Gate

Run:

~~~bash
npm ci
npm test
npm run validate
npm run registry:build:foundation
git diff --check
git status --short
~~~

Expected:

- existing repository validation still passes;
- the new foundation unit and integration tests pass;
- the fixture registry builds without network access;
- no current generated plugin tree changed;
- only intentionally committed foundation files differ from the plan starting point.

Do not begin the production catalog migration until this gate has been reviewed.
