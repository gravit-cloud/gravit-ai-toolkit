import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, win32 } from "node:path";
import { parse as parseMarkdown, postprocess, preprocess } from "micromark";
import { isTrueLike, parseFrontmatter } from "./frontmatter.mjs";
import {
  assertInside,
  assertRealInside,
  assertRegistryName,
  walkFiles,
} from "./path-safety.mjs";
import { compareCodePoints } from "./ordering.mjs";

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
      recurse(realDirectory, result);
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
    .sort((left, right) => compareCodePoints(left.sourceDirectory, right.sourceDirectory))
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

function projectedSourceFiles(directory, excludedRoots, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (
      excludedRoots.some(
        (excluded) => path === excluded || nestedWithin(excluded, path),
      )
    ) {
      continue;
    }
    if (entry.isDirectory()) projectedSourceFiles(path, excludedRoots, result);
    else if (entry.isFile()) result.push(path);
  }
  return result.sort(compareCodePoints);
}

function codexMarkdown(markdown) {
  const { attributes, raw } = parseFrontmatter(markdown);
  if (!isTrueLike(attributes["disable-model-invocation"])) return markdown;
  return raw.replace(/^disable-model-invocation:.*\r?\n/im, "") + markdown.slice(raw.length);
}

function renderedOwner(skillRoots, absoluteTarget) {
  return skillRoots
    .filter((entry) => (
      absoluteTarget === entry.sourceDirectory ||
      nestedWithin(entry.sourceDirectory, absoluteTarget)
    ))
    .sort((left, right) => right.sourceDirectory.length - left.sourceDirectory.length)[0];
}

const LINK_DESTINATION_TYPES = new Set([
  "definitionDestinationString",
  "resourceDestinationString",
]);

function markdownLinkDestinations(markdown) {
  const events = postprocess(
    parseMarkdown().document().write(preprocess()(markdown, "utf8", true)),
  );
  return events
    .filter(([kind, token]) => kind === "exit" && LINK_DESTINATION_TYPES.has(token.type))
    .map(([, token]) => ({
      end: token.end.offset,
      start: token.start.offset,
      wrapped: markdown[token.start.offset - 1] === "<",
    }))
    .sort((left, right) => right.start - left.start);
}

function rewriteMarkdownLinks(markdown, rewriteDestination) {
  let result = markdown;
  for (const destination of markdownLinkDestinations(markdown)) {
    const rawTarget = markdown.slice(destination.start, destination.end);
    const replacement = rewriteDestination(rawTarget, destination.wrapped);
    if (replacement !== undefined) {
      result = result.slice(0, destination.start) + replacement + result.slice(destination.end);
    }
  }
  return result;
}

function unescapeMarkdownDestination(destination) {
  return destination.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function absoluteLinkTarget(rawTarget, targetPath) {
  return (
    rawTarget.startsWith("/") ||
    rawTarget.startsWith("\\") ||
    isAbsolute(targetPath) ||
    win32.isAbsolute(rawTarget) ||
    win32.isAbsolute(targetPath)
  );
}

function localLink(rawTarget) {
  if (!rawTarget || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(rawTarget)) return undefined;
  const hashIndex = rawTarget.indexOf("#");
  const rawTargetPath = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? "" : rawTarget.slice(hashIndex);
  if (!rawTargetPath) return undefined;
  const targetPath = unescapeMarkdownDestination(rawTargetPath);
  if (absoluteLinkTarget(rawTargetPath, targetPath)) return undefined;
  return { anchor, rawTargetPath, targetPath };
}

function rewriteLinks({ markdown, sourceMarkdownFile, destinationMarkdownFile, skills, destinationRoot }) {
  const skillRoots = skills.map((skill) => ({
    skill,
    sourceDirectory: realpathSync(skill.sourceDirectory),
  }));
  const source = renderedOwner(skillRoots, realpathSync(sourceMarkdownFile));
  return rewriteMarkdownLinks(markdown, (rawTarget, wrapped) => {
    const link = localLink(rawTarget);
    if (!link) return undefined;
    const { anchor, rawTargetPath, targetPath } = link;

    const absoluteTarget = resolve(dirname(sourceMarkdownFile), targetPath);
    const exists = existsSync(absoluteTarget);
    const ownershipTarget = exists ? realpathSync(absoluteTarget) : absoluteTarget;
    const owner = renderedOwner(skillRoots, ownershipTarget);
    if (!owner) {
      if (exists) throw new Error("unmapped local skill link: " + targetPath);
      return undefined;
    }
    if (owner === source) return undefined;

    const ownerDestination = assertInside(
      destinationRoot,
      resolve(destinationRoot, owner.skill.name),
      "rendered skill destination",
    );
    const mappedTarget = assertInside(
      ownerDestination,
      resolve(
        ownerDestination,
        relative(owner.sourceDirectory, ownershipTarget),
      ),
      "rendered skill link target",
    );
    let rewritten = relative(dirname(destinationMarkdownFile), mappedTarget).replaceAll("\\", "/");
    if (!rewritten.startsWith(".")) rewritten = "./" + rewritten;
    rewritten += anchor;
    if (!wrapped && /[ \t]/.test(rewritten)) return "<" + rewritten + ">";
    if (/\\[()]/.test(rawTargetPath)) rewritten = rewritten.replace(/[()]/g, "\\$&");
    return rewritten;
  });
}

function validateLocalMarkdownLinks(destinationRoot) {
  for (const filePath of walkFiles(destinationRoot)) {
    if (![".md", ".markdown"].includes(extname(filePath).toLowerCase())) continue;
    const markdown = readFileSync(filePath, "utf8");
    for (const destination of markdownLinkDestinations(markdown)) {
      const rawTarget = markdown.slice(destination.start, destination.end);
      const link = localLink(rawTarget);
      if (!link) continue;
      const absoluteTarget = assertInside(
        destinationRoot,
        resolve(dirname(filePath), link.targetPath),
        "rendered local Markdown link",
      );
      if (!existsSync(absoluteTarget)) {
        throw new Error(
          "unresolved local Markdown link: " + filePath + " -> " + link.targetPath,
        );
      }
      assertRealInside(
        destinationRoot,
        absoluteTarget,
        "rendered local Markdown link",
      );
    }
  }
}

function validateRenderedSkills(destinationRoot) {
  const names = new Set();
  for (const filePath of walkFiles(destinationRoot)) {
    if (basename(filePath) !== "SKILL.md") continue;
    const markdown = readFileSync(filePath, "utf8");
    if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) continue;
    const name = parseFrontmatter(markdown).attributes.name;
    if (names.has(name)) throw new Error("duplicate rendered skill name: " + name);
    names.add(name);
  }
}

export function renderSkills({ skills, destinationRoot, target }) {
  if (!["neutral", "claude", "codex"].includes(target)) {
    throw new Error("unsupported skill target: " + target);
  }
  for (const skill of skills) assertRegistryName(skill.name, "skill name");

  mkdirSync(destinationRoot, { recursive: true });
  const rendered = [];
  const copiedFiles = [];

  for (const skill of skills) {
    const destination = assertInside(
      destinationRoot,
      resolve(destinationRoot, skill.name),
      "rendered skill destination",
    );
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
    for (const sourceFile of projectedSourceFiles(skill.sourceDirectory, descendantRoots)) {
      copiedFiles.push({
        destinationFile: resolve(
          destination,
          relative(skill.sourceDirectory, sourceFile),
        ),
        sourceFile,
      });
    }

    const skillFile = resolve(destination, "SKILL.md");
    rendered.push({ id: skill.id, name: skill.name, directory: destination, skillFile });
  }

  const renderedSkillFiles = new Set(rendered.map((output) => output.skillFile));
  for (const { destinationFile, sourceFile } of copiedFiles) {
    if (![".md", ".markdown"].includes(extname(destinationFile).toLowerCase())) continue;
    let markdown = readFileSync(destinationFile, "utf8");
    markdown = rewriteLinks({
      markdown,
      sourceMarkdownFile: sourceFile,
      destinationMarkdownFile: destinationFile,
      skills,
      destinationRoot,
    });
    if (target === "codex" && renderedSkillFiles.has(destinationFile)) {
      markdown = codexMarkdown(markdown);
    }
    writeFileSync(destinationFile, markdown);
  }

  validateLocalMarkdownLinks(destinationRoot);
  validateRenderedSkills(destinationRoot);

  return rendered;
}
