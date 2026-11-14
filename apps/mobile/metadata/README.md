# English (US) release copy

These are manual paste sources for App Store Connect. EAS Metadata reads
`../store.config.json`; it does not synchronize this file or upload screenshots.
Keep `apple.version` in that config equal to `version` in `../app.config.ts` when
preparing each release, then run `npx --yes eas-cli@latest metadata:lint` from
`apps/mobile`.

## TestFlight test information

Rally puts your shared canvases on your iPhone and iPad. Open a list, plan, or tool, pin it for quick access, and use the conversation to make changes. You can also start a new canvas and pick up work from your computer.

This beta uses your Rally account and live organization data. Changes you make are shared with everyone who has access to the canvas. An internet connection is required.

Feedback email: help@rallywith.ai

Marketing URL: https://rallywith.ai/

Privacy policy: https://rallywith.ai/trust/privacy/

## What to Test

Pass release-specific notes as the submission workflow's `changelog` input.
Use this checklist as a starting point:

Try the canvases you use every day:

- Sign in and open a canvas. Its finished work should open first; an empty canvas opens the conversation.
- Pin a few canvases, switch between them, then reorder or remove pins in the sidebar.
- Open a conversation, write a message, and attach a photo or file. Check that the keyboard leaves the input visible.
- Start a new canvas and return to it later.
- Leave the app and come back. Check that your canvases refresh and your selected tab stays in place.
- Enable notifications in Settings and diagnostics, then open a canvas from a notification.
- On iPhone Duo, open and close the phone while viewing a canvas or writing a message. Your place and draft should stay intact.

Please report blank screens, sign-in problems, covered controls, or lost drafts through TestFlight feedback. Include the steps that led to the problem. These are live canvases, so use one you are comfortable editing.

## Beta App Review notes

Paste these into TestFlight's review notes. Enter the real review contact and a
dedicated sample-account login in App Store Connect's separate fields; never
commit credentials here.

Rally is a canvas app for shared lists, plans, documents, and small tools. Each canvas also has a conversation for requesting changes.

Sign in with the dedicated review account supplied in App Store Connect. Sign-in opens the system authentication browser and returns to Rally when complete. The review account should contain sample canvases and have permission to create and edit them.

From Home, open a populated canvas to view its content. Tap the conversation button to edit it. The sidebar lets you pin canvases, change their order, and switch organizations. A canvas without content opens its conversation.

Notifications are optional and are enabled from Settings and diagnostics. Camera, photo, and microphone access is requested only when using the corresponding conversation feature. The app requires an internet connection.

## Screenshots

Follow [App Store screenshots](../../../docs/app-store-screenshots.md) for capture
commands, iPhone/iPad/Duo sizes, image checks, and upload instructions.

Upload the images under `screenshots/en-US` manually to the matching App Store
version's iPhone and iPad slots. These are real native captures of the shared
grocery canvas, with no private conversation or third-party editorial content.
Apple's [current screenshot specification](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
requires a medium Dynamic Island iPhone image (1206 × 2622 is accepted) and a
13-inch iPad image (2064 × 2752 is accepted). Recheck the specification when
recapturing; do not upscale images from a smaller device to fill another slot.

TestFlight itself does not require screenshots. Its public invitation uses images
from the latest approved App Store version, so preparing these assets does not
make them appear on a first-beta invitation.
