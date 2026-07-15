---
name: deep-change-review
description: Run a comprehensive, structured review of current code changes using parallel sub-agents. Use when user asks to review changes, do a code review, or mentions "deep review". Supports depth scaling (quick, standard, thorough).
---

# Deep Change Review

Run a comprehensive, structured review of the current code changes using parallel Claude Code sub-agents.

## Input

- **Scope**: $ARGUMENTS (default: working tree vs HEAD)
- **Depth**: standard (quick | standard | thorough)

## Technology classification

Classify each changed file:

| File pattern | Technology |
|---|---|
| `*.tf` | terraform |
| `ansible/**` | ansible |
| `cloud-init.yaml`, `cloud-init*` | cloud-init |
| `Dockerfile*`, `docker-compose*` | docker |
| `*nginx*` | nginx |
| `*.sh` | shell |
| `Makefile` | make |
| `package.json`, `*.ts`, `*.js` | nodejs |
| `*.yml`, `*.yaml` | yaml |
| `*.md` | markdown |

## Workflow

### Phase 1: Gather changes

1. Run `git diff --name-only HEAD` and `git diff --cached --name-only` to get all changed files.
2. Classify each file using the table above.
3. Respect the max files limit from Depth Scaling. If exceeded, focus on the most critical files (terraform > ansible > shell > others).
4. Run `git diff --stat HEAD` for an overview.

### Phase 2: Launch parallel sub-agents

Start the following sub-agents **in parallel** using the Agent tool.

For **quick** depth: only Sub-Agent 2 (Security) and Sub-Agent 4 (Testing).
For **standard** and **thorough**: all four.

#### Sub-Agent 1: Docs Validation

**subagent_type:** Explore

Check changed code against current upstream documentation:
1. For each technology, use Context7 MCP tools: `resolve-library-id` then `query-docs`.
2. Context7 library mapping: terraform → `hashicorp terraform`, ansible → `ansible`, cloud-init → `canonical cloud-init`, docker → `docker`, nginx → `nginx`, nodejs → `node.js`.
3. Validate: syntax, required attributes, deprecated features, best practices.
4. Rate limit: see Depth Scaling for max queries per technology.

Focus: docs validation ONLY.

#### Sub-Agent 2: Security Review

**subagent_type:** general-purpose

Check for:
1. Secret exposure (hardcoded secrets, tokens, API keys)
2. Permission issues (overly broad file permissions)
3. Injection risks (command injection in Shell, template injection in Jinja2/HCL)
4. Network security (open ports, missing firewall rules)
5. Dependency risks (unpinned versions)
6. Azure-specific (managed identity vs. credentials, Key Vault, NSG rules)
7. OWASP Top 10
8. Violations of CLAUDE.md "Security and secret handling" and "Ansible security conventions" sections

Focus: security ONLY.

#### Sub-Agent 3: Architecture Conformity

**subagent_type:** Explore

Read CLAUDE.md for project conventions. Check:
1. Naming conventions (files, resources, variables, env vars)
2. Code style (HCL formatting, Ansible FQCN, shell strict mode)
3. Architecture fit (Terraform → Cloud-Init → Ansible layering)
4. DRY principle
5. Makefile integration (new scripts need `.PHONY` targets)
6. Idempotency (Ansible `changed_when`, shell safe-to-rerun)
7. Error handling patterns per CLAUDE.md

Focus: architecture/conformity ONLY.

#### Sub-Agent 4: Test and Validation

**subagent_type:** general-purpose

1. Run the relevant lint gates directly:
   - `terraform -chdir=terraform/src fmt -check` (if .tf files changed)
   - `terraform -chdir=terraform/src validate` (if .tf files changed)
   - `checkov -d terraform/src --quiet` (if .tf files changed)
   - `ansible-lint ansible/playbook.yaml` (if Ansible files changed)
   - `checkov -d ansible/ --framework ansible --quiet` (if Ansible files changed)
   - `bash -n <script>` for each changed .sh file
2. Recommend manual/automated tests.
3. Identify regression risks.

Focus: tests and validation ONLY.

### Phase 3: Consolidation

1. Collect all sub-agent results.
2. Deduplicate findings.
3. Prioritize: critical > high > medium > low > info > nitpick.

### Phase 4: Verdict

- **approve**: No findings >= medium.
- **request-changes**: At least one finding >= medium.
- **blocker**: At least one critical finding.

## Output

Produce the consolidated report:

1. Executive summary (max 3 sentences)
2. Verdict (approve / request-changes / blocker)
3. Findings sorted by severity: dimension, category, file:line, description, recommendation
4. Lint results
5. Test recommendations
6. Statistics (findings by severity and dimension)

## Depth Scaling

| Aspect | quick | standard | thorough |
|--------|-------|----------|----------|
| Sub-agents | 2 (security + test) | 4 (all) | 4 (all, extended) |
| Docs queries/tech | 1 | 3 | 5 |
| Architecture depth | naming only | naming + style | full CLAUDE.md |
| Adjacent files | no | directly related | 2 levels |
| Max files | 10 | 30 | unlimited |
