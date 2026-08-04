import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, win32 } from "node:path";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { parse as parseMarkdown, postprocess, preprocess } from "micromark";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";
import { isTrueLike, parseFrontmatter } from "./frontmatter.mjs";
import {
  assertInside,
  assertRealInside,
  assertRegistryName,
  pathIsInside,
  walkFiles,
} from "./path-safety.mjs";
import { compareCodePoints } from "./ordering.mjs";
import { assertHostSkillName, skillComponentId } from "./skill-identity.mjs";

const INTERNAL_SKILL_RESOURCE_NAME = "SKILL.resource.md";

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
  const ids = new Set();
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
      const id = skillComponentId(skill.name);
      if (ids.has(id)) throw new Error("duplicate skill component id: " + id);
      ids.add(id);
      return { ...skill, id };
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

function pruneEmptyRenderedDirectories(directory, preserveRoot = true) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) pruneEmptyRenderedDirectories(path, false);
  }
  if (!preserveRoot && readdirSync(directory).length === 0) rmdirSync(directory);
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

function mappedOwner(mappings, field, absoluteTarget) {
  return mappings
    .filter((entry) => pathIsInside(entry[field], absoluteTarget))
    .sort((left, right) => right[field].length - left[field].length)[0];
}

function normalizedResourceMappings(resourceMappings) {
  if (!Array.isArray(resourceMappings)) {
    throw new Error("skill resource mappings must be an array");
  }
  return resourceMappings.map((mapping) => {
    if (
      !mapping
      || typeof mapping !== "object"
      || Array.isArray(mapping)
      || typeof mapping.sourcePath !== "string"
      || typeof mapping.destinationPath !== "string"
    ) {
      throw new Error("skill resource mapping requires sourcePath and destinationPath");
    }
    for (const [label, path] of [
      ["source", mapping.sourcePath],
      ["destination", mapping.destinationPath],
    ]) {
      if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
        throw new Error("skill resource mapping " + label + " must be a real path: " + path);
      }
    }
    return {
      sourcePath: realpathSync(mapping.sourcePath),
      // Keep the lexical destination spelling so relative links remain inside
      // the rendered tree even on systems where /tmp aliases /private/tmp.
      destinationPath: resolve(mapping.destinationPath),
    };
  });
}

const LINK_DESTINATION_TYPES = new Set([
  "definitionDestinationString",
  "resourceDestinationString",
]);
const LINK_ESCAPE_TYPES = new Set(["characterEscape", "characterReference"]);

function markdownBodyOffset(markdown) {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return 0;
  try {
    return parseFrontmatter(markdown).raw.length;
  } catch {
    return 0;
  }
}

function markdownLinkDestinations(markdown) {
  const bodyOffset = markdownBodyOffset(markdown);
  const body = markdown.slice(bodyOffset);
  const bomOffset = body.startsWith("\uFEFF") ? 1 : 0;
  const parsedBody = body.slice(bomOffset);
  const events = postprocess(
    parseMarkdown().document().write(preprocess()(parsedBody, "utf8", true)),
  );
  const escapes = events
    .filter(([kind, token]) => kind === "exit" && LINK_ESCAPE_TYPES.has(token.type))
    .map(([, token]) => ({
      end: token.end.offset,
      start: token.start.offset,
      type: token.type,
    }));
  return events
    .filter(([kind, token]) => kind === "exit" && LINK_DESTINATION_TYPES.has(token.type))
    .map(([, token]) => ({
      end: bodyOffset + bomOffset + token.end.offset,
      escapes: escapes
        .filter((escape) => (
          escape.start >= token.start.offset && escape.end <= token.end.offset
        ))
        .map((escape) => ({
          ...escape,
          end: escape.end - token.start.offset,
          start: escape.start - token.start.offset,
        })),
      start: bodyOffset + bomOffset + token.start.offset,
      wrapped: parsedBody[token.start.offset - 1] === "<",
    }))
    .sort((left, right) => right.start - left.start);
}

function rewriteMarkdownLinks(markdown, rewriteDestination) {
  let result = markdown;
  for (const destination of markdownLinkDestinations(markdown)) {
    const rawTarget = markdown.slice(destination.start, destination.end);
    const replacement = rewriteDestination(rawTarget, destination);
    if (replacement !== undefined) {
      result = result.slice(0, destination.start) + replacement + result.slice(destination.end);
    }
  }
  return result;
}

function decodeCharacterReference(reference) {
  const value = reference.slice(1, -1);
  if (/^#x/i.test(value)) {
    return decodeNumericCharacterReference(value.slice(2), 16);
  }
  if (value.startsWith("#")) {
    return decodeNumericCharacterReference(value.slice(1), 10);
  }
  return decodeNamedCharacterReference(value) || reference;
}

function decodeMarkdownUriPath(rawPath, escapes) {
  let decoded = rawPath;
  for (const escape of [...escapes].sort((left, right) => right.start - left.start)) {
    const raw = rawPath.slice(escape.start, escape.end);
    const replacement = escape.type === "characterReference"
      ? decodeCharacterReference(raw)
      : raw.slice(1);
    decoded = decoded.slice(0, escape.start) + replacement + decoded.slice(escape.end);
  }
  try {
    return decodeURIComponent(decoded);
  } catch (error) {
    throw new Error("invalid percent encoding in local Markdown link: " + rawPath, {
      cause: error,
    });
  }
}

function linkSuffixStart(rawTarget, escapes) {
  for (let index = 0; index < rawTarget.length; index += 1) {
    if (rawTarget[index] !== "?" && rawTarget[index] !== "#") continue;
    if (escapes.some((escape) => escape.start <= index && index < escape.end)) continue;
    return index;
  }
  return rawTarget.length;
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

function localLink(rawTarget, destination) {
  if (!rawTarget || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(rawTarget)) return undefined;
  const suffixStart = linkSuffixStart(rawTarget, destination.escapes);
  const rawTargetPath = rawTarget.slice(0, suffixStart);
  const suffix = rawTarget.slice(suffixStart);
  if (!rawTargetPath) return undefined;
  const pathEscapes = destination.escapes.filter((escape) => escape.end <= suffixStart);
  const targetPath = decodeMarkdownUriPath(rawTargetPath, pathEscapes);
  if (/^[a-z][a-z\d+.-]*:/i.test(targetPath)) return undefined;
  if (absoluteLinkTarget(rawTargetPath, targetPath)) return undefined;
  return { pathEscapes, rawTargetPath, suffix, targetPath };
}

function rawPathSegments(link) {
  const slashOffsets = [];
  for (let index = 0; index < link.rawTargetPath.length; index += 1) {
    if (
      link.rawTargetPath[index] === "/"
      && !link.pathEscapes.some((escape) => escape.start <= index && index < escape.end)
    ) {
      slashOffsets.push(index);
    }
  }

  const segments = [];
  let start = 0;
  for (const end of [...slashOffsets, link.rawTargetPath.length]) {
    const raw = link.rawTargetPath.slice(start, end);
    const escapes = link.pathEscapes
      .filter((escape) => escape.start >= start && escape.end <= end)
      .map((escape) => ({
        ...escape,
        end: escape.end - start,
        start: escape.start - start,
      }));
    const decoded = decodeMarkdownUriPath(raw, escapes);
    if (decoded === "." || decoded === "") {
      // Path normalization discards these components.
    } else if (decoded === "..") {
      if (segments.length > 0 && segments.at(-1).decoded !== "..") segments.pop();
      else segments.push({ decoded, raw });
    } else {
      segments.push({ decoded, raw });
    }
    start = end + 1;
  }
  return segments;
}

function encodedPath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(
      /[!'()*]/g,
      (character) => "%" + character.codePointAt(0).toString(16).toUpperCase(),
    ))
    .join("/");
}

function renderedOwnerRelativePath(link, ownerRelativePath) {
  if (!ownerRelativePath) return "";
  const expected = ownerRelativePath.split("/");
  const available = rawPathSegments(link);
  const tail = available.slice(-expected.length);
  if (
    tail.length === expected.length
    && tail.every((segment, index) => segment.decoded === expected[index])
  ) {
    return tail.map((segment) => segment.raw).join("/");
  }
  return encodedPath(ownerRelativePath);
}

function rewriteLinks({
  markdown,
  sourceMarkdownFile,
  destinationMarkdownFile,
  skills,
  destinationRoot,
  internalResources,
  resourceMappings,
}) {
  const skillRoots = skills.map((skill) => ({
    skill,
    sourceDirectory: realpathSync(skill.sourceDirectory),
  }));
  const source = renderedOwner(skillRoots, realpathSync(sourceMarkdownFile));
  return rewriteMarkdownLinks(markdown, (rawTarget, destination) => {
    const link = localLink(rawTarget, destination);
    if (!link) return undefined;
    const { suffix, targetPath } = link;

    const absoluteTarget = resolve(dirname(sourceMarkdownFile), targetPath);
    const exists = existsSync(absoluteTarget);
    const ownershipTarget = exists ? realpathSync(absoluteTarget) : absoluteTarget;
    const internalResource = internalResources.find(
      ({ sourcePath }) => sourcePath === ownershipTarget,
    );
    if (internalResource) {
      let rewritten = relative(
        dirname(destinationMarkdownFile),
        internalResource.destinationPath,
      ).replaceAll("\\", "/");
      rewritten = encodedPath(rewritten);
      if (!rewritten.startsWith(".")) rewritten = "./" + rewritten;
      rewritten += suffix;
      if (!destination.wrapped && /[ \t]/.test(rewritten)) return "<" + rewritten + ">";
      return rewritten;
    }
    const owner = renderedOwner(skillRoots, ownershipTarget);
    if (!owner) {
      const mapped = exists
        ? mappedOwner(resourceMappings, "sourcePath", ownershipTarget)
        : undefined;
      if (mapped) {
        const mappedTarget = assertInside(
          mapped.destinationPath,
          resolve(mapped.destinationPath, relative(mapped.sourcePath, ownershipTarget)),
          "rendered resource link target",
        );
        if (!existsSync(mappedTarget)) {
          throw new Error("unresolved mapped skill link: " + targetPath);
        }
        assertRealInside(mapped.destinationPath, mappedTarget, "rendered resource link target");
        let rewritten = relative(dirname(destinationMarkdownFile), mappedTarget)
          .replaceAll("\\", "/");
        rewritten = encodedPath(rewritten);
        if (!rewritten.startsWith(".")) rewritten = "./" + rewritten;
        return rewritten + suffix;
      }
      if (exists) throw new Error("unmapped local skill link: " + targetPath);
      return undefined;
    }
    if (owner === source) return undefined;

    const ownerDestination = assertInside(
      destinationRoot,
      resolve(destinationRoot, owner.skill.name),
      "rendered skill destination",
    );
    assertInside(
      ownerDestination,
      resolve(
        ownerDestination,
        relative(owner.sourceDirectory, ownershipTarget),
      ),
      "rendered skill link target",
    );
    const ownerRelativePath = relative(owner.sourceDirectory, ownershipTarget)
      .replaceAll("\\", "/");
    const ownerDestinationPath = relative(dirname(destinationMarkdownFile), ownerDestination)
      .replaceAll("\\", "/");
    let rewritten = [
      ownerDestinationPath,
      renderedOwnerRelativePath(link, ownerRelativePath),
    ].filter(Boolean).join("/");
    if (!rewritten.startsWith(".")) rewritten = "./" + rewritten;
    rewritten += suffix;
    if (!destination.wrapped && /[ \t]/.test(rewritten)) return "<" + rewritten + ">";
    return rewritten;
  });
}

function rewriteInternalSkillReferences({ markdown, sourceMarkdownFile, skills, internalResources }) {
  const skillRoots = skills.map((skill) => ({
    skill,
    sourceDirectory: realpathSync(skill.sourceDirectory),
  }));
  const owner = renderedOwner(skillRoots, realpathSync(sourceMarkdownFile));
  const pathPattern = /(?<![A-Za-z0-9._~%+\/-])(?:(?:\.{1,2}|[A-Za-z0-9._~%+-]+)\/)+SKILL\.md/g;
  return markdown.replace(pathPattern, (rawPath) => {
    const directSource = resolve(dirname(sourceMarkdownFile), rawPath);
    let matches = internalResources.filter(({ sourcePath }) => sourcePath === directSource);
    if (matches.length === 0 && owner) {
      matches = internalResources.filter(({ sourcePath }) => {
        if (!nestedWithin(owner.sourceDirectory, sourcePath)) return false;
        const ownerRelative = relative(owner.sourceDirectory, sourcePath).replaceAll("\\", "/");
        return rawPath === ownerRelative || rawPath.endsWith("/" + ownerRelative);
      });
    }
    if (matches.length > 1) {
      throw new Error(
        "ambiguous internal SKILL.md reference: " + sourceMarkdownFile + " -> " + rawPath,
      );
    }
    if (matches.length === 0) return rawPath;
    return rawPath.slice(0, -"SKILL.md".length) + INTERNAL_SKILL_RESOURCE_NAME;
  });
}

function validateLocalMarkdownLinks(destinationRoot, resourceMappings) {
  for (const filePath of walkFiles(destinationRoot)) {
    if (![".md", ".markdown"].includes(extname(filePath).toLowerCase())) continue;
    const markdown = readFileSync(filePath, "utf8");
    for (const destination of markdownLinkDestinations(markdown)) {
      const rawTarget = markdown.slice(destination.start, destination.end);
      const link = localLink(rawTarget, destination);
      if (!link) continue;
      const absoluteTarget = resolve(dirname(filePath), link.targetPath);
      if (!existsSync(absoluteTarget)) {
        throw new Error(
          "unresolved local Markdown link: " + filePath + " -> " + link.targetPath,
        );
      }
      if (pathIsInside(destinationRoot, absoluteTarget)) {
        assertRealInside(
          destinationRoot,
          absoluteTarget,
          "rendered local Markdown link",
        );
        continue;
      }
      const mapped = mappedOwner(resourceMappings, "destinationPath", absoluteTarget);
      if (!mapped) {
        throw new Error(
          "rendered local Markdown link escapes mapped outputs: "
            + filePath + " -> " + link.targetPath,
        );
      }
      assertRealInside(
        mapped.destinationPath,
        absoluteTarget,
        "rendered local Markdown resource link",
      );
    }
  }
}

function validateRenderedSkills(destinationRoot) {
  const names = new Set();
  const reservedNestedEntrypoints = [];
  for (const filePath of walkFiles(destinationRoot)) {
    if (basename(filePath) !== "SKILL.md") continue;
    const relativeDirectory = relative(destinationRoot, dirname(filePath)).replaceAll("\\", "/");
    if (relativeDirectory.includes("/")) reservedNestedEntrypoints.push(filePath);
    const markdown = readFileSync(filePath, "utf8");
    if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) continue;
    const name = parseFrontmatter(markdown).attributes.name;
    if (names.has(name)) throw new Error("duplicate rendered skill name: " + name);
    names.add(name);
  }
  if (reservedNestedEntrypoints.length > 0) {
    throw new Error(
      "reserved nested rendered SKILL.md: "
        + reservedNestedEntrypoints.sort(compareCodePoints).join(", "),
    );
  }
}

export function renderSkills({ skills, destinationRoot, target, resourceMappings = [] }) {
  if (!["neutral", "claude", "codex"].includes(target)) {
    throw new Error("unsupported skill target: " + target);
  }
  for (const skill of skills) {
    assertHostSkillName(skill.name);
    const expectedId = skillComponentId(skill.name);
    if (skill.id !== expectedId) {
      throw new Error(
        "skill component id must match host skill name: " + skill.name,
      );
    }
    assertRegistryName(skill.id, "skill component id");
  }
  const mappings = normalizedResourceMappings(resourceMappings);

  mkdirSync(destinationRoot, { recursive: true });
  const rendered = [];
  const copiedFiles = [];
  const internalResources = [];

  for (const skill of skills) {
    const destination = assertInside(
      destinationRoot,
      resolve(destinationRoot, skill.name),
      "rendered skill destination",
    );
    const descendantRoots = skills
      .filter((candidate) => nestedWithin(skill.sourceDirectory, candidate.sourceDirectory))
      .map((candidate) => candidate.sourceDirectory);

    const sourceFiles = projectedSourceFiles(skill.sourceDirectory, descendantRoots);
    const skillInternalResources = sourceFiles
      .filter((sourceFile) => {
        if (basename(sourceFile) !== "SKILL.md") return false;
        if (sourceFile === resolve(skill.sourceDirectory, "SKILL.md")) return false;
        const markdown = readFileSync(sourceFile, "utf8");
        return !markdown.startsWith("---\n") && !markdown.startsWith("---\r\n");
      })
      .map((sourcePath) => {
        const existingResource = resolve(dirname(sourcePath), INTERNAL_SKILL_RESOURCE_NAME);
        if (existsSync(existingResource)) {
          throw new Error("internal skill resource destination already exists: " + existingResource);
        }
        return {
          sourcePath: realpathSync(sourcePath),
          destinationPath: resolve(
            destination,
            dirname(relative(skill.sourceDirectory, sourcePath)),
            INTERNAL_SKILL_RESOURCE_NAME,
          ),
        };
      });
    internalResources.push(...skillInternalResources);

    cpSync(skill.sourceDirectory, destination, {
      recursive: true,
      filter(source) {
        return !descendantRoots.some(
          (descendant) => source === descendant || nestedWithin(descendant, source),
        );
      },
    });
    pruneEmptyRenderedDirectories(destination);
    for (const resource of skillInternalResources) {
      const copiedSkillPath = resolve(
        destination,
        relative(skill.sourceDirectory, resource.sourcePath),
      );
      renameSync(copiedSkillPath, resource.destinationPath);
    }
    for (const sourceFile of sourceFiles) {
      const internalResource = skillInternalResources.find(
        ({ sourcePath }) => sourcePath === sourceFile,
      );
      copiedFiles.push({
        destinationFile: internalResource?.destinationPath ?? resolve(
          destination, relative(skill.sourceDirectory, sourceFile),
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
      internalResources,
      resourceMappings: mappings,
    });
    markdown = rewriteInternalSkillReferences({
      markdown,
      sourceMarkdownFile: sourceFile,
      skills,
      internalResources,
    });
    if (target === "codex" && renderedSkillFiles.has(destinationFile)) {
      markdown = codexMarkdown(markdown);
    }
    writeFileSync(destinationFile, markdown);
  }

  validateLocalMarkdownLinks(destinationRoot, mappings);
  validateRenderedSkills(destinationRoot);

  return rendered;
}
