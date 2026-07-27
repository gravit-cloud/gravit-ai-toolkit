import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isTrueLike, parseFrontmatter } from "./frontmatter.mjs";
import { assertInside, assertRealInside } from "./path-safety.mjs";

function rejectSymbolicLink(path) {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("symbolic links are not allowed in staged components: " + path);
  }
}

function standaloneSkill(directory) {
  const skillFile = resolve(directory, "SKILL.md");
  if (!existsSync(skillFile)) return undefined;
  rejectSymbolicLink(skillFile);
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
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("symbolic links are not allowed in staged components: " + path);
    }
    if (entry.isDirectory()) recurse(path, result);
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
      const realDirectory = assertRealInside(absoluteRoot, directory, "declared skill");
      rejectSymbolicLink(directory);
      const skill = standaloneSkill(realDirectory);
      if (skill) result.push(skill);
      else recurse(realDirectory, result);
    }
  } else {
    const defaultRoot = resolve(absoluteRoot, "skills");
    if (existsSync(defaultRoot)) {
      const realDefaultRoot = assertRealInside(absoluteRoot, defaultRoot, "default skill");
      rejectSymbolicLink(defaultRoot);
      recurse(realDefaultRoot, result);
    }
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

function nestedWithin(parent, candidate) {
  const nested = relative(parent, candidate);
  return nested !== "" && !nested.startsWith("..") && !isAbsolute(nested);
}

function codexMarkdown(markdown) {
  const { attributes, raw } = parseFrontmatter(markdown);
  if (!isTrueLike(attributes["disable-model-invocation"])) return markdown;
  return raw.replace(/^disable-model-invocation:.*\r?\n/im, "") + markdown.slice(raw.length);
}

function renderedOwner(skills, absoluteTarget) {
  return skills
    .filter((skill) => (
      absoluteTarget === skill.sourceDirectory ||
      nestedWithin(skill.sourceDirectory, absoluteTarget)
    ))
    .sort((left, right) => right.sourceDirectory.length - left.sourceDirectory.length)[0];
}

function rewriteLinks({ markdown, sourceSkillFile, destinationSkillFile, skills, destinationRoot }) {
  const source = renderedOwner(skills, sourceSkillFile);
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, rawTarget) => {
    const target = rawTarget.trim().replace(/^<|>$/g, "");
    if (!target || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) return whole;
    const hashIndex = target.indexOf("#");
    const targetPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const anchor = hashIndex === -1 ? "" : target.slice(hashIndex);
    if (!targetPath || targetPath.includes(" ")) return whole;

    const absoluteTarget = resolve(dirname(sourceSkillFile), targetPath);
    const owner = renderedOwner(skills, absoluteTarget);
    if (!owner) {
      if (existsSync(absoluteTarget)) {
        throw new Error("unmapped local skill link: " + targetPath);
      }
      return whole;
    }
    if (owner === source) return whole;

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
    rendered.push({ id: skill.id, name: skill.name, directory: destination, skillFile });
  }

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

  return rendered;
}
