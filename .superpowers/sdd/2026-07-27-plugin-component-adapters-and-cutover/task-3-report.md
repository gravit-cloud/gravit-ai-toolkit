# Task 3 report: normalize hooks and translate host root variables

## Outcome

- Added `normalizeHooks(record)` for path and inline records, wrapped `{ hooks }`
  documents, and direct event maps.
- Added `renderHooks({ config, target })` for truthful Claude and Codex root
  references without mutating the normalized configuration.
- Preserved group metadata, command-hook metadata, and unknown non-command hook
  payloads through deterministic deep clones.
- Added fail-closed validation for record, source, event-map, event-array, group,
  group-`hooks`, and hook-entry shapes. Command hooks require a non-empty string
  command; missing `hooks` arrays are never defaulted away.
- Restricted rendering to `claude` and `codex`.

## Root translation contract

- Exact unescaped `${CLAUDE_PLUGIN_ROOT}` and `${PLUGIN_ROOT}` references render as
  `${CLAUDE_PLUGIN_ROOT}` for Claude and `${PLUGIN_ROOT}` for Codex, independent of
  which host spelling appeared in the source.
- Partial names such as `${CLAUDE_PLUGIN_ROOT_SUFFIX}` and `${PLUGIN_ROOTED}` are
  unchanged.
- Unbraced `$CLAUDE_PLUGIN_ROOT` and `$PLUGIN_ROOT` forms are unchanged.
- A braced reference preceded by an odd run of backslashes is treated as escaped
  and left unchanged. An even run does not escape the reference, so it is rendered
  for the target while the backslashes remain intact.

## Absolute-path and execution safety

- Command validation uses a small argv-like scanner. It recognizes whitespace,
  single/double quotes, backslash escapes, and unquoted shell token boundaries;
  it does not invoke or emulate a shell.
- Newline, tab, null, DEL, other ASCII controls, unterminated quotes, and trailing
  escapes fail closed.
- Every scanned token and `key=value` value is checked, rather than only the first
  whitespace token. The gate rejects POSIX absolute paths, Windows drive-absolute
  and drive-relative forms, rooted/UNC/device/native namespace forms, and `file:`
  URLs, including quoted arguments and `node /absolute/script` forms.
- Unquoted `;`, `&`, `|`, `<`, `>`, parentheses, and backticks split scanner tokens.
  This closes no-whitespace forms such as `node x;/tmp/run`, `node x&&/tmp/run`,
  `node x||/tmp/run`, pipes, redirections, command substitution, and backticks.
  Quoted and escaped literals remain argument content.
- Plugin-root paths, relative commands and paths, ordinary flags, and HTTP(S) URLs
  remain supported. HTTP query strings are not mistaken for option assignments.
- A real executable `bin/helper` fixture that would create a sentinel file proves
  normalization does not run hook commands.
- Prototype-like own keys and non-plain trusted hook structures fail closed.

## TDD evidence

RED:

- Initial `node --test test/unit/hooks.test.mjs` failed with
  `ERR_MODULE_NOT_FOUND` for `scripts/lib/hooks.mjs`.
- The expanded shape/security suite produced seven behavior failures against the
  minimal implementation for escaping, malformed shapes, command payloads,
  prototype keys, absolute paths, controls, and renderer revalidation.
- An HTTP URL containing `?next=/tmp/file` reproduced an over-conservative false
  positive before full-token URL handling was added.
- The no-whitespace operator regression reproduced a real bypass:
  `node x;/tmp/run.mjs` was accepted before shell token boundaries were added.

GREEN:

- Focused: `node --test test/unit/hooks.test.mjs` — 12 passed, 0 failed.
- Full: `npm test` — 156 passed, 0 failed.
- Offline validation: `npm run validate` — `Validation passed (6 Codex plugins).`
- Syntax: `node --check scripts/lib/hooks.mjs` and
  `node --check test/unit/hooks.test.mjs` exited 0.
- Diff hygiene: `git diff --check` exited 0.

## Self-review, scope, and deviations

- Standards review against `AGENTS.md`: no findings. The change uses Node ESM,
  built-in tests, existing JSON utilities, repository formatting, and no generated
  plugin edits.
- Spec review against Task 3, its brief, and the registry design: no missing or
  extra target behavior found. The implementation intentionally exceeds the
  illustrative sample's first-token path check to satisfy the task's fail-closed
  security requirements.
- The scanner boundary is deliberately not a general shell policy or Task 4 trust
  engine. It only tokenizes enough syntax to expose absolute path-bearing command
  segments without executing them.
- Node 24 was not installed or exposed by a local version manager. Verification ran
  on the available Node `v26.5.0`.
- Production catalogs, generated marketplaces/plugins, registry files, source
  bundles, sync code, and `progress.md` remain untouched.
