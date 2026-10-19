# Implementation verification

Verified locally on 2026-10-19. Website and live-site picking are native-only,
following the requester's scope correction. The public serving Worker is unchanged.

## Real Electron checks

- The panel's Comment mode control remains visible immediately left of Expand,
  including the narrow rail. Its SVG is Tabler `pointer-collaboration`; the
  picking cursor uses the same SVG.
- Hover outlines the nearest Markdown item. Option grows to the list and then
  its section. A narrow window wraps the selection and its outline together.
- Click pins immediately. Double-click replaces that click's block pin with a
  word, preserving earlier pins. Exact quotes retain Markdown punctuation.
  Enter commits a comment; Escape exits picking and preserves existing pins.
- A CSV rectangle produces a table with its headers. Its cells remain highlighted
  after commenting. Image dragging previews the region, uploads a PNG crop,
  and sends an annotation-only message. Reopening its feed excerpt restores the
  saved version and region.
- Static HTML remains opaque (`location.origin === 'null'`). A hostile file's
  own script stays blocked while the trusted picker outlines and pins its button.
  The outline's rectangle matches the button's rectangle.
- Native live-site picking returns rendered HTML and an actual cropped PNG.
  Page-created globals cannot access the isolated picker state. The floating
  comment is visible beside the pin over a captured still; Enter resumes picking.
- Pop-out pins transfer to the original composer and clear only after its ACK.
  Multiple commented Markdown pins were sent without message text, persisted,
  and reopened from the feed.

## Automated checks

- Repository lint, typecheck and documentation checks pass.
- Full-suite run: all 3,577 desktop tests and all 3,700 API Node tests pass;
  the other package suites pass as well. The runtime lane recorded 1,738 passing
  tests and one outdated stored-schema-error expectation. After correcting the
  expectation and preserving HTTP 500 for a stored-contract defect, the complete
  affected `message-to-output-pipeline.test.ts` file passes all 51 tests. The full
  command was not rerun again after that focused repair.
- Additional focused checks cover source/code offsets, sheet parsing and saved
  ranges, annotation admission, original-image replay, and annotation-only thread
  creation. Malformed socket receipts name their rejected fields.
- The panel-focus race and the socket-receipt test each passed 20 consecutive
  reproductions after their fixes. Integration mutation proofs dropped a version
  check, draft check, canonical structured-content write, opening annotation
  write and command receipt; each corresponding test failed, then passed with
  production behavior restored.
- The production annotation projection passed all six decision evaluations on
  `google/gemini-3.8-flash`: exact, several, truncated, older-version, converted
  spreadsheet and rendered HTML selections. These evaluate editing decisions,
  not complete agent tool execution. Local message admission was exercised, but
  end-to-end agent edits were not verified with the local inference environment.

## Open product values

Both shared annotation character guards remain `Infinity` (`LIMIT UNSET`), as
requested by the PRD. Context uses its proposed 200 characters on each side.

## Browser disabled controls

HTML-file and live-website previews keep the Comment icon immediately before
Expand, disabled with “Website comments require the Rally Mac app.” Available
file kinds retain their enabled control. Headed Chrome verification covered
hover, keyboard focus, an ignored disabled click and enabled Markdown picking.
Screenshots: `/tmp/annotation-browser-html-disabled.png` and
`/tmp/annotation-browser-site-disabled.png`. The two affected component files
pass all 43 tests; the shared icon controls and primitives pass 48 tests.
Repository lint and full typecheck pass after this adjustment.

## Readable website quotes

Website comment cards, chips, saved-message excerpts and unavailable-preview
fallbacks display the locator's visible text, or “Selected area” without text.
HTML remains in the annotation payload for model context and restoration.
The source-picker and live-site component files pass 45 tests, including saved
website labels and the no-text fallback. A headed Chrome fixture exercising the
real live-site card with a supplied native-picker result confirmed “Start free”
in both the card and chip and no HTML in either. Screenshot:
`/tmp/annotation-comment-readable.png`. A fresh native run could not sign in
because the local API was unavailable; that native transport was not rechecked
for this display-only adjustment.

## PR readiness checks

Fresh final-tree runs pass repository lint, full typecheck and documentation
checks, 7 annotation contract tests, 104 renderer tests, 26 API Node tests and
71 real workerd tests across artifact annotations, conversation creation and
the full message-to-output pipeline. The earlier full-repository result above
remains recorded separately; this final verification is scoped.
