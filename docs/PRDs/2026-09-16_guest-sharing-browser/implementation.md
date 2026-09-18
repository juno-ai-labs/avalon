# Implementation and release follow-through

Implementation is split across PRs #822–#825. The original PR #820 remains the
review history and backup. Current behavior belongs in the module documents:

- [Email sign-in](../../email-login.md) and [browser sessions](../../browser-sessions.md).
- [Scoped invitations](../../scope-invitations.md) and [authorization](../../authorization.md).
- [Browser client](../../browser-client.md) and [shared UI](../../shared-ui.md).

## Before production enablement

- Configure the browser hostname, Worker deployment and regional service binding.
- Set `BROWSER_APP_ORIGIN`, transactional sender, keys and `EMAIL_LOGIN_POLICY_JSON`.
- Decide email issuance/resend policy and retention before exposing public sign-in.
- Verify external mailbox delivery and a deployed stateful artifact.

The implementation has local and workerd evidence. It does not claim deployed
mailbox delivery or production rollout. PR descriptions carry validation results;
this document does not duplicate a session-by-session test journal.
