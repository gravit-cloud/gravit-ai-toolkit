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
