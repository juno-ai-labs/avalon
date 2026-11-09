# Automated code review

Rally's automated code review workflow runs two independent Cline reviewers,
GPT-5.6 Sol and GPT-5.6 Terra, against pull requests using models served by Azure
AI Foundry. DeepSeek, Grok, and Kimi remain configured but disabled for all
triggers. It is an Azure-only extraction of Monad's proven reviewer workflow: OpenCode and
OpenRouter-backed jobs are intentionally absent.

**The workflow is not running.** It is checked in as
`.github/workflows/azure-ai-reviewers.yml.disabled`, a name GitHub Actions does
not load, so no pull request is reviewed by it; the reason it was switched off
was not recorded. Everything below describes the workflow as it runs once the
file is renamed back to `azure-ai-reviewers.yml`.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `.github/workflows/azure-ai-reviewers.yml.disabled` | Triggers reviews, configures the five Azure models, isolates a PR checkout below Cline's workspace root, runs the Monad Cline harness, and posts each fixed-path review. |

## How it works

The workflow starts through `pull_request` when a pull request is opened,
reopened, or marked ready for review. Each enabled reviewer excludes drafts from
that automatic path. DeepSeek, Grok, and Kimi have an unconditional false job
gate, including for trusted comment requests. A repository owner, member, or
collaborator can request a fresh review by commenting `/cline review`; a small
acknowledgment job reacts with eyes while the reviewers run.

The workflow contains five separate Azure Cline jobs. The first three were
copied from `juno-ai-labs/monad` at commit
`8eac60499845f00afaa2db6dd41b1578c169436b`; the two GPT-5.6 jobs are Rally
copies of that same shape:

| Job | Azure deployment/model identifier | Status | Job / prompt budget |
| --- | --- | --- | --- |
| `review-deepseek-cline` | `DeepSeek-V4-Pro` | Disabled | 30 / 15 minutes |
| `review-grok-46-azure-cline` | `grok-4.6` | Disabled | 30 / 15 minutes |
| `review-kimi-cline` | `Kimi-K2.6` | Disabled | 30 / 15 minutes |
| `review-gpt-56-sol-cline` | `gpt-5.6-sol` | Enabled | 60 / 15 minutes |
| `review-gpt-56-terra-cline` | `gpt-5.6-terra` | Enabled | 60 / 60 minutes |

The two GPT-5.6 deployments run as separate jobs rather than one, for the same
reason the other three do: a reviewer's value is an independent read of the
diff, and one job posts one review.

Each job validates the Azure endpoint, installs and authenticates Cline 3.0.47,
then checks out the PR head under `$GITHUB_WORKSPACE/pr-head`. Installation
happens before checkout. Cline runs from the parent workspace with
`--auto-approve true` and receives its complete review request as one
positional prompt argument, exactly as in Monad. It uses `gh` to read PR
metadata and the diff and can inspect the checkout for surrounding code. The
model writes `$GITHUB_WORKSPACE/cline-review.md`; a fixed later step checks the
path and scans it for credentials before posting it.

The workflow intentionally does not run on `synchronize`. New commits do not
start another review round automatically; use the comment command when the
updated head is ready.

## Invariants

- Only GPT-5.6 Sol and GPT-5.6 Terra may run. DeepSeek V4 Pro, Grok 4.6,
  and Kimi K2.6 retain their harness definitions behind an unconditional false
  job gate, so neither automatic nor comment-triggered runs spend their budget.
  Grok 4.6 replaced Monad's imported Grok 4.3 job; the five jobs otherwise retain
  the same duplicated harness shape.
  OpenRouter credentials, providers, and jobs do not belong here.
- The automatic trigger is `pull_request`, and every reviewer explicitly
  rejects drafts. The comment trigger accepts only pull request comments from
  owners, members, or collaborators.
- Cline receives the prompt as the positional `"$PROMPT"` argument. JSON mode,
  prompt-file stdin redirection, and prompt piping are not part of this harness.
- `npm install -g cline@3.0.47` and authentication happen before the PR is
  checked out. No installer, build, or test command follows the checkout.
- The PR checkout stays at `pr-head/`, one level below the
  `$GITHUB_WORKSPACE` directory passed to `cline --cwd`. The clear step
  removes Cline rule, hook, plugin, and deliverable paths from that parent root.
- `CLINE_COMMAND_PERMISSIONS` records the intended read-only `gh` commands,
  but `--auto-approve true` means it is not an enforcement boundary. Keep this
  behavior aligned with Monad rather than independently redesigning it here.
- The fixed post step rejects a symlink at `cline-review.md`, refuses a review
  containing the Azure key or workflow token, and posts only that fixed path.

## Boundary

This module owns asynchronous pull-request review comments. It does not gate
merge, rerun Rally's quality checks, modify pull-request code, or configure
Azure itself. Rally's ordinary correctness gates remain in
`.github/workflows/ci.yml`.

The workflow depends on GitHub-hosted Ubuntu runners, GitHub CLI, npm, Cline,
GitHub pull-request refs, and an Azure AI Foundry OpenAI-compatible endpoint. It
is repository-scoped rather than regional product infrastructure; Rally's
configured deployments runtime boundary does not apply.

## Failure modes and limits

- Sol has a 60-minute job timeout and a 15-minute prompt budget. Terra has a
  60-minute job timeout and a 60-minute prompt budget, explicitly requested after
  the reviewer audit. Terra's prompt gives each sub-agent a 15-minute budget.
  Setup and posting share that job ceiling; the prompt is
  advisory, not a separate timer. Disabled jobs retain their 30/15-minute values.
  The acknowledgment job times out after two minutes.
- A newer run of the same reviewer for the same pull request cancels its older
  run. Because command detection uses substring matching, quoting
  `/cline review` in an ordinary comment also starts reviewers.
- Missing credentials or an endpoint outside
  `*.services.ai.azure.com` and `*.openai.azure.com` fails before Cline is
  installed. Resource roots and Foundry project endpoints are accepted, with an
  optional `/openai/v1/chat/completions` suffix stripped.
- A missing or empty review file produces a warning and no comment. A symlink or
  a review body containing either available credential fails closed.
- The five jobs intentionally duplicate their setup and prompt. A change copied
  from a newer Monad workflow must be applied to every applicable Azure job.

## Testing

No automated test covers this workflow. Run the repository quality gates
after any change to it:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:scripts
```

The model calls and review posting require a real pull request. The
`pull_request` path reads the workflow from the PR ref; the `issue_comment`
path reads the current default-branch workflow.

## Security and trust model

Pull-request metadata, diffs, and checked-out files are untrusted model input.
The PR lands below Cline's workspace root so branch-provided `AGENTS.md`,
rules, hooks, and plugins are not auto-discovered from the root. The checkout
also uses `persist-credentials: false`, and no repository installer, build, or
test runs after untrusted files appear.

This is Monad's operational boundary, not a tool-denial sandbox. Cline runs with
automatic approval and the review step receives `GH_TOKEN` for read commands;
provider settings also exist on disk after authentication. The prompt instructs
the model not to change the checkout or issue GitHub writes. Publication is
separated into a fixed post step that reads only
`$GITHUB_WORKSPACE/cline-review.md` and rejects symlinks and credential
contents.

## Operations

Configure the repository or organization with:

- an Actions secret named `AZURE_AI_API_KEY`;
- an Actions variable named `AZURE_AI_API_ENDPOINT`.

The endpoint can be an Azure resource root or `/api/projects/<project>`
endpoint. The workflow appends `/openai/v1` and passes the API key as a Bearer
token through Cline's generic OpenAI-compatible provider. Do not switch to
Cline's Azure provider: it appends an `api-version` query parameter that this
Foundry route does not accept.

Use the Actions run for checkout, installation, endpoint-validation, provider,
and model errors.

## Changelog

### 2026-09-08 — Disable three reviewers and adjust Sol's and Terra's budgets

**What changed:** DeepSeek, Kimi, and Grok are disabled at the job gate for both
automatic and trusted comment triggers. Sol remains enabled. Terra's job timeout
and reviewer-facing prompt budget are both 60 minutes, and its review prompt
now instructs it to give each sub-agent a 15-minute budget. Sol's GitHub
Actions timeout is 60 minutes while its prompt still says 15 minutes. Tests pin
the enabled set and each budget; the workflow contract tests pin Sol's two
values independently.

**Why:** The latest-50-PR audit found substantial review noise and unreliable
Grok delivery. The team requested those three lanes stop running and explicitly
chose a longer Terra budget after its repeated 30-minute timeouts, together
with an explicit budget for delegated reviews within Terra's 60-minute overall
budget. The team requested additional execution time for Sol without telling
the model about that additional budget.

**Considered and rejected:** Keeping the three lanes available through the
comment command would not satisfy disabling them from running. Removing their
harness definitions would make a future deliberate re-enable harder to review.
Increasing every reviewer's timeout would exceed the requested scope. Reducing
Terra's overall budget to make room for its sub-agents would also reduce the
time available to coordinate and synthesize the reviews. Updating Sol's prompt
to 60 minutes would contradict the requested separation between the runner
ceiling and model-facing budget.

**Consequences:** New review rounds run only Sol and Terra once this workflow is
in the ref used by the trigger. Already-running jobs and old workflow reruns keep
their original configuration. Re-enabling a lane requires changing its gate and
the enabled-set test; Terra's larger budget is not a claim that its reliability
problem is fixed. The sub-agent budget is a prompt instruction, not an enforced
timer. Sol can continue until the 60-minute job ceiling, including setup and
publication, while still being instructed to finish its review within 15
minutes.

### 2026-09-01 — Reviewer job and prompt budgets separated

**What changed:** All five Azure Cline reviewer jobs now have a 30-minute GitHub
Actions timeout, while every reviewer prompt says it has 15 minutes. The
workflow contract test pins both values for every reviewer.

**Why:** The requested operating contract gives the workflow a larger execution
ceiling than the time the models are told to spend reviewing.

**Considered and rejected:** Giving the job and reviewer the same 30-minute
budget, or retaining the former 25-minute job ceiling and 20-minute prompt.
Neither preserves the requested deliberate separation.

**Consequences:** A reviewer is instructed to finish within 15 minutes, but
GitHub Actions can keep the job alive for setup, authentication, checkout,
publication, and any overrun until the 30-minute ceiling.

### 2026-08-13 — GPT-5.6 Sol and GPT-5.6 Terra added as reviewers

**What changed:** Two more Azure Cline reviewers, `review-gpt-56-sol-cline`
(`gpt-5.6-sol`) and `review-gpt-56-terra-cline` (`gpt-5.6-terra`), joined the
three existing jobs. Both are copies of `review-grok-43-azure-cline` differing
only in the deployment identifier, the authentication step's name, and the model
named in the prompt's closing line. The workflow contract test's job-to-model map
grew to five entries, and its per-model regex now escapes every dot in an
identifier rather than only the first.

**Why:** More independent reads of a diff catch more; these two deployments were
already available on the same Foundry resource, so adding them cost no new
credential or endpoint.

**Considered and rejected:** Collapsing the two GPT-5.6 deployments into one job
that runs both, and — more broadly — factoring the five near-identical jobs into
a matrix or a reusable workflow. A job posts one review, so a shared job would
have to serialize two model calls and merge their output, losing the independence
that makes a second reviewer worth running. The matrix was tried and reverted
once already (see the 2026-08-12 entries); this document's invariant is to keep
the Azure jobs aligned with Monad's duplicated shape rather than re-deriving one
here, and that outweighs the duplication these two jobs add.

**Consequences:** A pull request now spends five model calls per review round
instead of three, and five jobs — not three — must be updated in step when a
fix is copied from Monad. The endpoint-validation, checkout, clear, and post
steps are duplicated five times; every one of them is load-bearing security, so a
change to any must reach all five.

### 2026-08-12 — Monad's proven Azure Cline harness restored

**What changed:** The matrix-based JSON reviewer was replaced with the three
Azure Cline jobs from Monad commit
`8eac60499845f00afaa2db6dd41b1578c169436b`. Each job now uses Monad's
positional prompt, isolated `pr-head/` checkout, automatic approval, read-intent
command configuration, and fixed review-file posting step. Non-Azure Monad jobs
were omitted.

**Why:** A live post-merge `/cline review` showed that Cline 3.0.47 rejected
both regular-file redirection and `cat | cline` in JSON mode on GitHub-hosted
runners. Monad's positional-prompt workflow is already proven in production,
and the requested resolution was to use that implementation directly.

**Considered and rejected:** Further adapting or hardening the copied harness in
Rally. Independent changes had already diverged from the working source and
failed live; keeping the Azure subset aligned with Monad removes that
experimentation.

**Consequences:** Rally again checks out PR source and runs Cline with automatic
approval, matching Monad's documented boundary. The workflow uses
`pull_request` rather than `pull_request_target`, and the three jobs remain
duplicated. Future fixes should be copied from the corresponding Monad Azure
jobs, while OpenRouter and OpenCode reviewers remain excluded.

### 2026-08-12 — Reviewer prompts moved to a true stdin pipe

**What changed:** The prompt file is now sent through `cat | cline` with
`pipefail` enabled, and the workflow contract test requires that pipe while
rejecting regular-file stdin redirection.

**Why:** Cline 3.0.47's JSON mode distinguishes a pipe from a regular file on
stdin. Redirecting the prompt file with `<` made all three reviewers exit before
calling their models with "JSON output mode requires a prompt argument or piped
stdin."

**Considered and rejected:** Passing the prompt as a command-line argument.
Reviewer input is allowed to reach 600,000 bytes, which exceeds Linux's
per-argument limit on GitHub-hosted runners. A pipe handles the bounded input
without shell interpolation or a second size ceiling.

**Consequences:** The model and tool-security boundaries are unchanged: Cline
still receives only the bounded prompt, no GitHub token, no checkout, and no
automatic tool approval. Future changes must keep the prompt on a genuine pipe
unless the pinned CLI's input contract changes and the full input-size budget is
preserved another way.

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

**What changed:** Rally gained the DeepSeek V4 Pro, Grok 4.3, and Kimi K2.6
Cline review jobs, their manual comment trigger, and their checkout and posting
hardening.

**Why:** Rally needed Monad's automated review coverage but only for the models
Monad connects through Azure AI Foundry.

**Considered and rejected:** Copying Monad's workflow unchanged. That would also
bring OpenCode and Cline jobs backed by OpenRouter, along with repository setup
for reviewers that execute the checked-out project, despite the requested
Azure-only boundary.

**Consequences:** Rally supports `/cline review` and deliberately does not
support `/opencode review`. Adding another reviewer requires an Azure-hosted
deployment and an update to the workflow contract test. The three duplicated
endpoint-validation blocks must remain equivalent.
