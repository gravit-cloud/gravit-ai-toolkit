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
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";
import { isTrueLike, parseFrontmatter } from "./frontmatter.mjs";
import {
  assertInside,
  assertRealInside,
  assertRegistryName,
} from "./path-safety.mjs";

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

function renderedOwner(skillRoots, absoluteTarget) {
  return skillRoots
    .filter((entry) => (
      absoluteTarget === entry.sourceDirectory ||
      nestedWithin(entry.sourceDirectory, absoluteTarget)
    ))
    .sort((left, right) => right.sourceDirectory.length - left.sourceDirectory.length)[0];
}

function fenceMarker(line) {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  return { character: match[2][0], length: match[2].length, rest: match[3] };
}

function escapedAt(markdown, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function markdownWhitespace(character) {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function closingBracket(markdown, start) {
  let depth = 1;
  for (let index = start + 1; index < markdown.length; index += 1) {
    if (markdown[index] === "\\") {
      index += 1;
    } else if (markdown[index] === "[") {
      depth += 1;
    } else if (markdown[index] === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function closingTitle(markdown, start, opener) {
  const closer = opener === "(" ? ")" : opener;
  for (let index = start + 1; index < markdown.length; index += 1) {
    if (markdown[index] === "\\") index += 1;
    else if (markdown[index] === closer) return index + 1;
  }
  return undefined;
}

function inlineLink(markdown, labelStart) {
  const labelEnd = closingBracket(markdown, labelStart);
  if (labelEnd === undefined || markdown[labelEnd + 1] !== "(") return undefined;
  let cursor = labelEnd + 2;
  while (markdownWhitespace(markdown[cursor])) cursor += 1;

  let replacementStart = cursor;
  let destinationStart = cursor;
  let destinationEnd;
  let replacementEnd;
  if (markdown[cursor] === "<") {
    replacementStart = cursor;
    destinationStart = cursor + 1;
    cursor += 1;
    while (cursor < markdown.length && markdown[cursor] !== "\n" && markdown[cursor] !== "\r") {
      if (markdown[cursor] === "\\") cursor += 2;
      else if (markdown[cursor] === ">") break;
      else cursor += 1;
    }
    if (markdown[cursor] !== ">") return undefined;
    destinationEnd = cursor;
    replacementEnd = cursor + 1;
    cursor += 1;
  } else {
    let depth = 0;
    while (cursor < markdown.length) {
      if (markdown[cursor] === "\\") {
        cursor += 2;
      } else if (markdown[cursor] === "(") {
        depth += 1;
        cursor += 1;
      } else if (markdown[cursor] === ")") {
        if (depth === 0) break;
        depth -= 1;
        cursor += 1;
      } else if (markdownWhitespace(markdown[cursor]) && depth === 0) {
        break;
      } else {
        cursor += 1;
      }
    }
    destinationEnd = cursor;
    replacementEnd = cursor;
  }
  if (destinationStart === destinationEnd) return undefined;

  while (markdownWhitespace(markdown[cursor])) cursor += 1;
  if (markdown[cursor] !== ")") {
    if (!["\"", "'", "("].includes(markdown[cursor])) return undefined;
    cursor = closingTitle(markdown, cursor, markdown[cursor]);
    if (cursor === undefined) return undefined;
    while (markdownWhitespace(markdown[cursor])) cursor += 1;
    if (markdown[cursor] !== ")") return undefined;
  }

  return {
    destination: markdown.slice(destinationStart, destinationEnd),
    end: cursor + 1,
    replacementEnd,
    replacementStart,
    wrapped: replacementStart !== destinationStart,
  };
}

function fencedCodeRanges(markdown) {
  const ranges = [];
  let fence;
  for (let start = 0; start < markdown.length;) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline + 1;
    const line = markdown.slice(start, newline === -1 ? end : newline).replace(/\r$/, "");
    const marker = fenceMarker(line);
    if (fence) {
      if (
        marker &&
        marker.character === fence.character &&
        marker.length >= fence.length &&
        marker.rest.trim() === ""
      ) {
        ranges.push({ start: fence.start, end });
        fence = undefined;
      }
    } else if (marker) {
      fence = { ...marker, start };
    }
    start = end;
  }
  if (fence) ranges.push({ start: fence.start, end: markdown.length });
  return ranges;
}

function backtickRunEnd(markdown, start) {
  let end = start + 1;
  while (markdown[end] === "`") end += 1;
  return end;
}

function markdownCodeRanges(markdown) {
  const fenced = fencedCodeRanges(markdown);
  const inline = [];
  let fenceIndex = 0;
  for (let index = 0; index < markdown.length;) {
    while (fenced[fenceIndex] && fenced[fenceIndex].end <= index) fenceIndex += 1;
    const nextFence = fenced[fenceIndex];
    if (nextFence && nextFence.start <= index) {
      index = nextFence.end;
      continue;
    }
    if (markdown[index] !== "`" || escapedAt(markdown, index)) {
      index += 1;
      continue;
    }

    const openerEnd = backtickRunEnd(markdown, index);
    const openerLength = openerEnd - index;
    const searchEnd = nextFence ? nextFence.start : markdown.length;
    let cursor = openerEnd;
    let closingEnd;
    while (cursor < searchEnd) {
      const candidate = markdown.indexOf("`", cursor);
      if (candidate === -1 || candidate >= searchEnd) break;
      const candidateEnd = backtickRunEnd(markdown, candidate);
      if (candidateEnd - candidate === openerLength) {
        closingEnd = candidateEnd;
        break;
      }
      cursor = candidateEnd;
    }
    if (closingEnd === undefined) {
      index = openerEnd;
    } else {
      inline.push({ start: index, end: closingEnd });
      index = closingEnd;
    }
  }
  return [...fenced, ...inline].sort((left, right) => left.start - right.start);
}

function rewriteMarkdownLinks(markdown, rewriteDestination) {
  const codeRanges = markdownCodeRanges(markdown);
  let codeRangeIndex = 0;
  let result = "";
  let copiedThrough = 0;
  for (let index = 0; index < markdown.length;) {
    while (codeRanges[codeRangeIndex] && codeRanges[codeRangeIndex].end <= index) {
      codeRangeIndex += 1;
    }
    const codeRange = codeRanges[codeRangeIndex];
    if (codeRange && codeRange.start <= index) {
      index = codeRange.end;
      continue;
    }
    if (markdown[index] !== "[" || escapedAt(markdown, index)) {
      index += 1;
      continue;
    }

    const link = inlineLink(markdown, index);
    if (!link || (codeRange && codeRange.start < link.end)) {
      index += 1;
      continue;
    }
    const replacement = rewriteDestination(link.destination, link.wrapped);
    if (replacement !== undefined) {
      result += markdown.slice(copiedThrough, link.replacementStart) + replacement;
      copiedThrough = link.replacementEnd;
    }
    index = link.end;
  }
  return result + markdown.slice(copiedThrough);
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

function rewriteLinks({ markdown, sourceSkillFile, destinationSkillFile, skills, destinationRoot }) {
  const skillRoots = skills.map((skill) => ({
    skill,
    sourceDirectory: realpathSync(skill.sourceDirectory),
  }));
  const source = renderedOwner(skillRoots, realpathSync(sourceSkillFile));
  return rewriteMarkdownLinks(markdown, (rawTarget, wrapped) => {
    if (!rawTarget || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(rawTarget)) return undefined;
    const hashIndex = rawTarget.indexOf("#");
    const rawTargetPath = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
    const anchor = hashIndex === -1 ? "" : rawTarget.slice(hashIndex);
    if (!rawTargetPath) return undefined;
    const targetPath = unescapeMarkdownDestination(rawTargetPath);
    if (absoluteLinkTarget(rawTargetPath, targetPath)) return undefined;

    const absoluteTarget = resolve(dirname(sourceSkillFile), targetPath);
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
    let rewritten = relative(dirname(destinationSkillFile), mappedTarget).replaceAll("\\", "/");
    if (!rewritten.startsWith(".")) rewritten = "./" + rewritten;
    rewritten += anchor;
    if (wrapped || /[ \t]/.test(rewritten)) return "<" + rewritten + ">";
    if (/\\[()]/.test(rawTargetPath)) rewritten = rewritten.replace(/[()]/g, "\\$&");
    return rewritten;
  });
}

export function renderSkills({ skills, destinationRoot, target }) {
  if (!["claude", "codex"].includes(target)) {
    throw new Error("unsupported skill target: " + target);
  }
  for (const skill of skills) assertRegistryName(skill.name, "skill name");

  mkdirSync(destinationRoot, { recursive: true });
  const rendered = [];

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
