---
name: context7-doc-validation
description: Validate code changes against current upstream documentation via Context7 MCP tools. Use when user asks to validate against docs, check documentation compliance, or verify code against upstream specs. Supports depth scaling.
---

# Context7 Doc Validation

Validate code changes against current upstream documentation via Context7 MCP tools.

## Input

- **Files**: $ARGUMENTS (default: all changed files in the working tree)
- **Depth**: standard (quick | standard | thorough)

## Technology mapping

| File pattern | Technology | Context7 query |
|---|---|---|
| `*.tf` | terraform | `hashicorp terraform` |
| `ansible/**/*.yaml` | ansible | `ansible` |
| `cloud-init.yaml` | cloud-init | `canonical cloud-init` |
| `Dockerfile*`, `docker-*` | docker | `docker` |
| `*nginx*` | nginx | `nginx` |
| `*.sh` | shell | manual review (no Context7) |
| `Makefile` | make | manual review (no Context7) |
| `package.json`, `*.ts` | nodejs | `node.js` |

## Workflow

### Phase 1: Identify changes

1. Run `git diff --name-only HEAD` and `git diff --cached --name-only` to get all changed files.
2. Classify each file using the technology mapping above.
3. Read each changed file and extract the specific changed constructs (resources, modules, directives, tasks).

### Phase 2: Fetch docs

For each technology that has a Context7 query:

1. Call `resolve-library-id` with a specific query (e.g. "Terraform azurerm provider network security group").
2. Call `query-docs` with the library ID and a targeted question about the changed construct.
3. Respect the rate limit from Depth Scaling below.

### Phase 3: Validation

Compare the code changes against the fetched documentation:

- **Syntax**: attribute names, block structure correct?
- **Required vs. optional**: required attributes present? deprecated features used?
- **Defaults**: correctly assumed or need to be set explicitly?
- **Best practices**: deviations from official recommendations?

### Phase 4: Report

Create a validation report with:
- Status per file/construct: **pass** | **finding** | **skipped**
- Detail and doc reference for each finding
- Concrete correction suggestion

If no findings: confirm the change as docs-compliant.

## Output

For each finding:

- File and construct
- Status: pass | finding | skipped
- Detail
- Doc reference
- Correction suggestion (if needed)

Summary: total checks, passed, findings, skipped.

## Depth Scaling

| Aspect | quick | standard | thorough |
|--------|-------|----------|----------|
| Queries/tech | 1 | 3 | 5 |
| Construct depth | top-level only | changed blocks | full file context |
| Adjacent files | no | no | directly related |

## Failure Handling

- **Library not found**: mark as `skipped`, recommend manual doc check.
- **Irrelevant results**: refine query (max 3 attempts), then `skipped`.
- **Rate limit**: remainder as `skipped`.
- **Docs outdated/unclear**: finding with caveat, recommend manual review.

## After Validation

If corrections were made, run the repo lint gates:

```bash
make fmt
make validate
```
