# Automated code review

Avalon's automated code review workflow runs three independent Cline reviewers
against pull requests using models served by Azure AI Foundry. It is deliberately
Azure-only: the OpenCode and Cline jobs backed by OpenRouter in Monad are not
part of Avalon.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `.github/workflows/azure-ai-reviewers.yml` | Triggers reviews, validates Azure configuration, gathers bounded pull-request context, runs Cline without tools, and posts each review. |
| `scripts/azure-reviewer-workflow.test.mjs` | Guards the selected models, triggers, credentials, permissions, context boundary, tool denial, and fixed review-output path. |

## How it works

The trusted base-branch workflow starts through `pull_request_target` when a
pull request is opened, reopened, or marked ready for review. Draft pull
requests are excluded from this automatic path. A repository owner, member, or
collaborator can request a fresh review of the current head by commenting
`/cline review`; an acknowledgment job reacts to that comment with eyes while
the reviewers run.

One matrix job runs three independent executions and posts separate comments:

| Matrix reviewer | Azure deployment/model identifier |
| --- | --- |
| `deepseek` | `DeepSeek-V4-Pro` |
| `grok-43-azure` | `grok-4.3` |
| `kimi` | `Kimi-K2.6` |

Each reviewer validates and normalizes the configured Azure endpoint. A trusted
shell step uses `gh` to write explicit PR metadata fields and the diff into a
bounded context file before Cline starts. Cline receives that file through
redirected stdin, runs in an empty temporary directory with
`--auto-approve false`, and receives no GitHub token. Because stdin and stdout
are non-TTY streams, Cline denies every tool request. Its completed
`run_result.text` is extracted from NDJSON into a fixed temporary path. A later
shell step scans that file for credentials and posts it.

The workflow intentionally does not run on `synchronize`. New commits do not
spend three more model calls automatically; use the comment command when the
updated head is ready.

## Invariants

- Every model call uses `AZURE_AI_API_KEY` and `AZURE_AI_API_ENDPOINT`.
  OpenRouter credentials, providers, and reviewer jobs do not belong in this
  workflow; adding one would silently broaden both cost and configuration.
- The automatic trigger rejects drafts. The comment trigger accepts only pull
  request comments from owners, members, or collaborators, because it runs in
  the base repository's privileged context.
- The automatic trigger is `pull_request_target`, so GitHub loads the workflow
  definition from the trusted base branch. Do not change it to `pull_request`:
  a same-repository PR could then modify the job that receives Azure credentials.
- The workflow never checks out the PR. A trusted step reads metadata and the
  diff with `gh`, asks only for explicit JSON fields, and fails if that input is
  larger than 600,000 bytes.
- Cline runs with redirected stdin and stdout, `CLINE_TOOL_APPROVAL_MODE` set to
  `terminal`, and `--auto-approve false`. Those settings move every tool call
  through the non-TTY approval path, which denies it. Do not replace them with
  an allowlist or automatic approval.
- The Cline step receives neither `GH_TOKEN` nor an untrusted checkout. It runs
  in an empty `$RUNNER_TEMP` directory and can review only the context supplied
  on stdin. The provider key remains available to Cline's own authenticated
  model client, but not to model-controlled commands because no command or file
  tool can execute.
- Raw PR content is copied between files and into a quoted-heredoc prompt; it is
  never interpolated into a shell command. Cline's NDJSON goes to a file rather
  than the workflow log, and only the completed `run_result.text` is published.
- The post step tests for a symlink before any file read and refuses a review
  containing either the Azure key or workflow token or exceeding the safe
  comment-size budget.

## Boundary

This module owns asynchronous pull-request review comments. It does not gate
merge, rerun Avalon's quality checks, modify pull-request code, or configure
Azure itself. Avalon's ordinary correctness gates remain in
`.github/workflows/ci.yml`.

The workflow depends on GitHub-hosted Ubuntu runners, GitHub CLI, npm, Cline,
GitHub's pull-request refs, and an Azure AI Foundry OpenAI-compatible endpoint.
It is repository-scoped rather than regional product infrastructure; Avalon's
Global and EU runtime boundary does not apply.

## Failure modes and limits

- Each reviewer times out after 25 minutes. The acknowledgment job times out
  after two minutes.
- A newer run of the same reviewer for the same pull request cancels its older
  run. Because command detection uses substring matching, quoting `/cline
  review` in an ordinary comment also starts reviewers and can cancel work in
  progress.
- Missing credentials or an endpoint outside
  `*.services.ai.azure.com` and `*.openai.azure.com` fails before Cline is
  installed. Resource roots and Foundry project endpoints are accepted, with an
  optional `/openai/v1/chat/completions` suffix stripped during normalization.
  A project path must contain exactly one non-empty segment.
- PR metadata and diff larger than 600,000 bytes fail before the model call.
  This avoids accidental truncation and forces oversized changes to be split.
- A missing or empty review file is reported as a warning and nothing is posted.
  A symlink, an oversized review, or a review body containing a credential fails
  closed.
- Diff-only review cannot inspect unchanged callers, declarations, or tests.
  Findings that depend on missing surrounding source must be reported as
  uncertain; a human reviewer or a narrower PR supplies the missing context.

## Testing

`pnpm test:scripts` runs
`scripts/azure-reviewer-workflow.test.mjs`. The test treats the three selected
matrix entries and their security-sensitive context, approval, and token
boundaries as a contract. Run the repository quality gates after any workflow
change:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:scripts
```

The model calls and review posting require a real pull request. Both trigger
paths read the workflow definition from the base branch, so a newly added or
changed workflow cannot execute itself from its own PR. Its first live review
run occurs only after the change is merged and a later PR is opened, reopened,
marked ready, or receives the trusted comment command.

## Security and trust model

Pull-request metadata and diffs are untrusted review material. Only a fixed shell
step holding `GH_TOKEN` retrieves them, and it writes them as inert file content.
Cline then runs without that token, without a repository checkout, and with all
tools subject to a non-interactive approval path that denies them. Prompt
injection can influence the prose review, but it cannot invoke a shell, read the
persisted provider settings, inspect runner files, or call GitHub.

The post step is outside the model loop and treats the generated Markdown only
as data. The fixed path, symlink check, size limit, and credential scan are
defense in depth. Any future need for surrounding source must preserve the same
property: untrusted PR content cannot gain a tool-capable process that also has
access to credentials.

## Operations

Configure the repository or organization with:

- an Actions secret named `AZURE_AI_API_KEY`;
- an Actions variable named `AZURE_AI_API_ENDPOINT`.

The endpoint can be an Azure resource root or
`/api/projects/<project>` endpoint. The workflow appends `/openai/v1` and
passes the API key as a Bearer token through Cline's generic OpenAI-compatible
provider. Do not switch to Cline's Azure provider: it appends an `api-version`
query parameter that this Foundry route does not accept.

Use the Actions run for context-size, installation, endpoint-validation, and
provider errors.

## Changelog

### 2026-08-12 — Tool execution removed from the reviewer boundary

**What changed:** PR metadata and diffs are now gathered by a trusted step and
passed to Cline through stdin. Cline runs without a checkout or GitHub token,
with automatic approval disabled and non-TTY approval denial enforced. The
three duplicated jobs became one model matrix so the boundary has one owner.
The automatic path uses `pull_request_target` so the workflow definition also
comes from the trusted base branch.

**Why:** Untrusted PR text can prompt-inject a model. Under Cline's automatic
approval mode, that gave the model arbitrary shell execution in a process that
could reach the workflow token and persisted Azure credentials; checkout and
output-path isolation did not close that exfiltration path.

**Considered and rejected:** Keeping automatic approval with
`CLINE_COMMAND_PERMISSIONS`. The pinned Cline version treats that setting as
policy intent while automatic approval permits commands outside the list. A
read-only checkout was also rejected because Cline's file and command tools
would still expose runner state unless every tool was denied.

**Consequences:** Reviewers operate on bounded metadata and diffs rather than
surrounding source. The loss of context is explicit and preferable to combining
untrusted instructions, arbitrary tools, and credentials. New models should be
matrix entries, not copied jobs with independently drifting security controls.

### 2026-08-12 — Azure-only Cline reviewers imported from Monad

**What changed:** Avalon gained the DeepSeek V4 Pro, Grok 4.3, and Kimi K2.6
Cline review jobs, their manual comment trigger, and their checkout and posting
hardening.

**Why:** Avalon needed Monad's automated review coverage but only for the models
Monad connects through Azure AI Foundry.

**Considered and rejected:** Copying Monad's workflow unchanged. That would also
bring OpenCode and Cline jobs backed by OpenRouter, along with repository setup
for reviewers that execute the checked-out project, despite the requested
Azure-only boundary.

**Consequences:** Avalon supports `/cline review` and deliberately does not
support `/opencode review`. Adding another reviewer requires an Azure-hosted
deployment and an update to the workflow contract test. The three duplicated
endpoint-validation blocks must remain equivalent.
