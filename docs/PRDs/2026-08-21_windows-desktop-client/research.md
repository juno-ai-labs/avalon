# Research: Windows code signing and distribution

> Read 2026-08-21. The Windows signing landscape changed materially in 2023,
> 2024, and 2026; every claim below carries that read date and should be
> re-verified against the sources before being relied on much later.

## Why this document exists

The PRD's signing decision (key design decision 2) rests on three external
facts that are each recent reversals of long-standing advice. This records
them with sources, so the decision is auditable and so nobody re-litigates it
from a pre-2024 mental model.

## The three facts

### 1. Traditional certificates now require physical hardware (June 2023)

CA/Browser Forum rules effective 2023-06-01 require the private key of any
publicly trusted OV or EV code-signing certificate to live on certified
hardware (FIPS 140-2 Level 2 / Common Criteria EAL 4+ token or HSM). A
certificate can no longer be a file in a GitHub secret, which is how the macOS
pipeline consumes `CSC_LINK`. A traditional certificate therefore implies
either a cloud-HSM subscription from the CA (at added cost) or a human with a
USB token in the release path.

- https://www.ssl.com/faqs/which-code-signing-certificate-do-i-need-ev-ov/
- https://my-ssl.com/learn/code-signing-certificates-explained

### 2. EV certificates lost their SmartScreen privilege (March 2024)

EV certificates used to bypass SmartScreen's "Windows protected your PC"
warning instantly — the only reason they were worth 2–3× the OV price for
consumer software. Microsoft removed that distinction in March 2024; EV and OV
now build per-file-hash reputation identically, through download volume. Paying
the EV premium for SmartScreen is no longer justified, and any advice
recommending it predates the change.

Consequence for Avalon regardless of certificate choice: **the first
downloaders of every new release see the SmartScreen warning**, because
reputation attaches to the file hash and each release is a new hash. The PRD
handles this with disclosure on the download page, not with spend.

- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings

### 3. Microsoft's signing service is the recommended non-Store path (2026)

Azure Artifact Signing (renamed from "Trusted Signing" — both names circulate)
is Microsoft's own recommendation for apps distributed outside the Microsoft
Store: ~$9.99/month, keys held in Microsoft's HSM, no hardware token, CI
authentication via Entra environment credentials. Available to organizations
in the USA, Canada, EU, and UK. electron-builder supports it natively via
`win.azureSignOptions` in the 26.x line the repository already pins
(26.15.3); `signtoolOptions` and `azureSignOptions` are mutually exclusive.

- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- https://azure.microsoft.com/en-us/products/artifact-signing
- https://www.electron.build/code-signing-win

## The eligibility risk

During its public preview, Trusted Signing required three or more years of
verifiable business history. The requirement no longer appears in the
documentation (sign-up has since opened to individuals in the US/Canada), but
Microsoft Q&A threads from 2026 still show organizations failing identity
validation with requests to "prove business is older than 3 years". Juno AI
Labs is a recent incorporation, so this is the one external dependency that
can invalidate the signing plan — hence rollout phase 1 submits validation
before any pipeline work depends on it, and the fallback (OV certificate,
manual signing step) is named in the PRD rather than improvised later.

Validation mechanics as documented: submitted documents must be issued within
the past 12 months, remain valid for at least two more months, and match the
organization's legal details exactly; plan for business days to weeks.

- https://learn.microsoft.com/en-us/answers/questions/5532414/trusted-signing-identity-verification-failed-provi
- https://learn.microsoft.com/en-us/answers/questions/2110155/need-help-with-identity-validation-for-azure-trust
- https://learn.microsoft.com/en-us/azure/artifact-signing/faq

## Certificate validity churn (for the fallback path only)

Effective 2026-03-01, CA/Browser Forum rules cap publicly trusted code-signing
certificates at 458 days validity, so the OV fallback also implies annual
reissue ceremony. One more reason the managed service is the default.

- https://sslinsights.com/best-code-signing-certificate-windows-applications/

## What was not researched

WASAPI loopback capture (the Windows equivalent of the Core Audio tap) was
deliberately not investigated: meeting recording on Windows is rejected by
non-goal 1, and recording a half-researched path here would invite building
against it.
