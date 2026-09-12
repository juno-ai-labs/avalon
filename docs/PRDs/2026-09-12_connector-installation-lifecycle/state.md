- [x] planned
- [x] in progress
- [ ] completed

Implementation is in `codex/ashby-installation-lifecycle`, with the phased work
and remaining acceptance gates tracked in [plan.md](plan.md).

User clarifications: no tool confirmations, for any tool; connect buttons are
**Connect for me** and **Connect for workspace** (administrator-only); Ashby uses
`ashby.rallywith.ai` on a dedicated connector Worker. Existing Granola subscription
URLs stay valid. PR creation and review are authorized. Deployment and merge are not authorized.

No Ashby test account is available. Live OAuth, tool execution, webhook delivery,
provider recovery/cutover, and confidential-event audience acceptance remain
outstanding. Workspace automation admission remains restricted until that review;
this work is not launch-complete. The maintenance route is implemented using the existing Ace `demos` credential
named by the user. No route has been deployed and no operator maintenance has
been run. The user asked for clarification after naming that identity; the code
is prepared for review without taking an external operational action.

Automated implementation gates pass: full tests including real workerd, lint,
typecheck, scripts, desktop release invariants, docs check, site build, and
Global/EU/Ashby dry-run builds. Native Electron and public support visuals were
inspected. Mutation evidence and exact live acceptance gaps are in plan.md.
The dedicated Worker isolates Ashby ingress; provider management and hosted MCP
remain regional API work, so the main API bundle has not been reduced.
