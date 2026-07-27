const TRUE_LIKE = new Set(["true", "yes", "on", "1"]);

export function isTrueLike(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return TRUE_LIKE.has(value.trim().toLowerCase());
}

export function parseFrontmatter(markdown) {
  const match = String(markdown).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n){0,2}/);
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
