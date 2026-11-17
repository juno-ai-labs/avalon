# Licensing

Copyright (c) 2026 Juno AI Labs Inc.

Rally is dual licensed. You may use the code in this repository under either:

1. **The GNU Affero General Public License, version 3 only** (`AGPL-3.0-only`).
   The full text is in [`LICENSE`](LICENSE). In short: you may use, change and
   host it, but if you let people use a modified version over a network, you
   must offer them the complete source of that version under the same license.
2. **A commercial license from Juno AI Labs Inc.** This is for anyone who wants
   to use, change, embed or host Rally without the AGPL's obligations, for
   example to keep changes private or ship it inside a closed product. Write to
   help@rallywith.ai with "Commercial license" in the subject.

The SPDX expression for first-party code is
`AGPL-3.0-only OR LicenseRef-Rally-Commercial`.

## What this does not cover

- **Trademarks.** Neither license grants any right to the names Rally, Juno AI
  Labs or Juno Labs, the Rally mark, or other brand assets, including those in
  [`assets/brand/`](assets/brand/). A fork or hosted copy must use its own name
  and mark.
- **Third-party code and assets.** Files that carry their own license stay under
  that license:
  - [`apps/mobile/modules/rally-crash-reporter/`](apps/mobile/modules/rally-crash-reporter/LICENSE):
    MIT, derived from Expo.
  - `packages/ui/src/fonts/`: Geist Mono, under the SIL Open Font License in
    [`OFL.txt`](packages/ui/src/fonts/OFL.txt) beside it.
  - `apps/site/src/fonts/`: Geist, Geist Mono and Instrument Serif, under the
    SIL Open Font License texts in [`apps/site/public/fonts/`](apps/site/public/fonts/).
  - `.agents/skills/rally-motion/kit/fonts/`: Geist Mono, Inter and Inter Tight,
    under the SIL Open Font License texts beside them.
  - `patches/`: changes to upstream packages, each under the license of the
    package it patches.
  - All dependencies installed by the package manager.

## Keeping the tree consistent

- Every first-party `package.json` sets
  `"license": "AGPL-3.0-only OR LicenseRef-Rally-Commercial"`. A new package
  copies that line and adds no `LICENSE` file of its own.
- Code, fonts or other assets copied in from elsewhere need a license that is
  compatible with the AGPL and that does not stop Juno from offering the
  commercial license, so GPL or AGPL code Juno does not own cannot come in. Keep
  the license file beside what you copied, and add the path to the list above in
  the same change.

## Contributing

Juno AI Labs Inc can only offer the commercial license if it holds the rights to
every contribution, so outside contributors agree to the
[Contributor License Agreement](CLA.md) before a pull request is merged.
[`docs/pull-requests.md`](docs/pull-requests.md#contributor-license-agreement)
says who needs to and how.
