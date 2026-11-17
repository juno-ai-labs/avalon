# Licensing

Rally's first-party code is dual licensed under `AGPL-3.0-only` and a
commercial license from Juno AI Labs Inc. The public notice is
[`LICENSING.md`](../LICENSING.md), the AGPL text is [`LICENSE`](../LICENSE),
and outside contributors agree to [`CLA.md`](../CLA.md). This document holds
the rules for keeping the tree consistent with that.

## Why dual licensing

The AGPL lets anyone read, run and host Rally, but a hosted competitor has to
publish its changes, and companies that avoid AGPL code have to buy the
commercial license instead. The commercial license only works if Juno holds the
right to relicense every line, which is what the CLA is for.

## Rules

- **Every first-party `package.json`** sets
  `"license": "AGPL-3.0-only OR LicenseRef-Rally-Commercial"`. A new package
  copies that line. Do not add a per-package `LICENSE` file; the root one
  covers the tree.
- **Third-party code keeps its own license.** Copying in code, fonts or other
  assets from elsewhere is allowed only under a license compatible with the
  AGPL, and the file or folder carries that license next to it. Add the path to
  the "What this does not cover" list in `LICENSING.md` in the same change.
  Code under a license that would stop Juno selling the commercial license (GPL
  or AGPL code Juno does not own, for example) cannot come in at all.
- **Brand assets are not licensed.** The Rally name and mark are trademarks,
  outside both licenses. Keep new brand files under `assets/brand/`.
- **Outside pull requests need the CLA box checked** before merge. The box is in
  [`.github/pull_request_template.md`](../.github/pull_request_template.md), and
  [`pull-requests.md`](pull-requests.md#contributor-license-agreement) says who
  needs it. Nothing enforces this automatically; the reviewer checks it.

## Changelog

### 2026-11-17 — Dual license: AGPL-3.0-only or commercial

The tree had no license of its own (the root `package.json` said `ISC` by
default, and `packages/bind` carried MIT). It now carries the AGPL plus a
commercial option so others can host Rally only by sharing their changes, while
Juno can still sell closed use. The rejected options were source-available
licenses (BSL, FSL, Elastic) that ban hosted competitors outright: they would
block competitors more firmly but are not open source. Contributor agreement is
a document and a pull request checkbox rather than a CLA bot, to avoid running a
new service before outside contributions exist; move to a bot if checkboxes are
missed. The license choice should be reviewed by a lawyer.
