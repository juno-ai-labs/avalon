# Implementation plan

Approved 2026-09-14: implement push and HTTPS links together using existing
session, intent, queue and navigation primitives. Build code before the signed-Mac
spike; verify installed behavior before release. Publish and check the site
association before the desktop release. Push is enabled for everyone from launch.

The implementation is described in [Apple push](../../../push-notifications.md).
Use per-intent/device receipts rather than device-wide timestamps; preserve
existing non-UUID intent IDs. Use an explicit native response callback and a
24-hour APNs expiration, as selected by the product owner. Do not introduce
additional coordination services, device limits, or speculative iOS behavior.

Run focused tests, lint and typecheck, inspect settings in Electron, then record
signed-Mac acceptance separately. Do not mark completed from compilation alone.
