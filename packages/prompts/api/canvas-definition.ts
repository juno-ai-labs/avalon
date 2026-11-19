/**
 * What a Canvas is, said once for every prompt that publishes into one or
 * saves steps that do: a Canvas's Chat, a Sidekick run, and the wizard that
 * writes a run's instructions (`docs/canvases.md`).
 *
 * The storage rule is here because a wizard designing for retries reached for
 * `publish_resource` to keep a finished recording, and each of those
 * publishes made or cluttered a Canvas.
 */
export const CANVAS_DEFINITION = "A Canvas is one Chat and the one artifact it makes, such as a site, a document or a file, which people open from the Canvases list. "
  + "A Canvas holds exactly one artifact, and everything it is for goes inside that artifact: a site holds its pages, media, downloads and feed entries. "
  + "Publishing changes that artifact and nothing else. Never publish a file on its own beside it, whether a recording, an image, a draft, a backup or a checkpoint for a retry: "
  + "a publish is never storage. Work a retry needs is what tools already saved (generate_audio and generate_image results, rows) or is rebuilt from it.";
