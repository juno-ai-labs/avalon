# Automated code review

Avalon's automated code review workflow runs three independent Cline reviewers
against pull requests using models served by Azure AI Foundry. It is deliberately
Azure-only: the OpenCode and Cline jobs backed by OpenRouter in Monad are not
part of Avalon.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `.github/workflows/azure-ai-reviewers.yml` | Triggers reviews, validates Azure configuration, isolates the pull-request checkout, runs Cline, and posts each review. |
| `scripts/azure-reviewer-workflow.test.mjs` | Guards the selected job set, triggers, credentials, permissions, step order, checkout isolation, and fixed review-output path. |

## How it works

The workflow starts when a pull request is opened, reopened, or marked ready for
review. Draft pull requests are excluded from this automatic path. A repository
owner, member, or collaborator can request a fresh review of the current head by
commenting `/cline review`; an acknowledgment job reacts to that comment with
eyes while the reviewers run.

Three jobs run independently and post separate comments:

| Job | Azure deployment/model identifier |
| --- | --- |
| `review-deepseek-cline` | `DeepSeek-V4-Pro` |
| `review-grok-43-azure-cline` | `grok-4.3` |
| `review-kimi-cline` | `Kimi-K2.6` |

Each reviewer validates and normalizes the configured Azure endpoint, installs
the pinned Cline CLI, and authenticates before any pull-request files exist in
the workspace. It then checks the pull-request head out under `pr-head/`, one
level below Cline's workspace root. Cline reads the PR metadata and diff through
`gh`, reads surrounding source under `pr-head/`, and writes only its final
review to `$GITHUB_WORKSPACE/cline-review.md`. A fixed shell step outside the
agent loop scans that file for credentials and posts it.

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
- Cline is installed and authenticated before checkout. After checkout, no step
  installs dependencies, runs tests, invokes a formatter, or otherwise executes
  repository code.
- The checkout stays at `pr-head/` with persisted credentials disabled, while
  `cline --cwd` stays at `$GITHUB_WORKSPACE`. Cline discovers rules, hooks,
  skills, and plugins from its workspace root; pointing it at the checkout would
  grant untrusted pull-request files instruction authority and code execution.
- Checkout `path`, Cline's `--cwd`, and the post step's absolute
  `cline-review.md` path move together or not at all. The output remains
  outside the checkout so the branch cannot pre-plant or symlink the review.
- The post step tests for a symlink before any file read and refuses a review
  containing either the Azure key or workflow token.
- `checks: read`, `statuses: read`, and `actions: read` stay together.
  A plain `gh pr view` traverses the head commit's check rollup into Actions;
  removing one scope makes the metadata read fail while the diff read continues,
  producing a deceptively normal review without the PR description.

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
- A missing or empty review file is reported as a warning and nothing is posted.
  A symlink or a review body containing a credential fails closed.
- Checkout and `gh pr diff` resolve the pull-request head separately. A push
  between those operations can pair an older tree with a newer diff; rerunning
  the reviewer repairs the stale review.

## Testing

`pnpm test:scripts` runs
`scripts/azure-reviewer-workflow.test.mjs`. The test treats the three selected
jobs and their security-sensitive step ordering as a contract. Run the repository
quality gates after any workflow change:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:scripts
```

The model calls and review posting require a real pull request. A comment-triggered
run reads the workflow definition from the base branch, so changes to this
workflow must first be exercised through a `pull_request` event such as
`ready_for_review`.

## Security and trust model

Pull-request text and every file under `pr-head/` are untrusted review material.
The checkout isolation prevents those files from becoming Cline workspace rules,
hooks, or plugins, and the workflow never executes repository code.

Cline currently runs with `--auto-approve true`; its
`CLINE_COMMAND_PERMISSIONS` value documents the intended read-only command set
but is not an enforcement boundary. The review process holds `GH_TOKEN` so it
can read PR data, and Cline authentication persists the provider key under its
home directory even though that key is absent from the review step's environment.
The trusted-author comment gate, isolated workspace, fixed posting step, and
credential scan are therefore all required. If Cline gains enforceable
read-only approval, adopt it rather than weakening these compensating controls.

## Operations

Configure the repository or organization with:

- an Actions secret named `AZURE_AI_API_KEY`;
- an Actions variable named `AZURE_AI_API_ENDPOINT`.

The endpoint can be an Azure resource root or
`/api/projects/<project>` endpoint. The workflow appends `/openai/v1` and
passes the API key as a Bearer token through Cline's generic OpenAI-compatible
provider. Do not switch to Cline's Azure provider: it appends an `api-version`
query parameter that this Foundry route does not accept.

Use the Actions run for installation, endpoint-validation, and provider errors.
If a posted review says it had to retry `gh pr view` with explicit JSON fields,
one of the three read scopes has drifted.

## Changelog

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
