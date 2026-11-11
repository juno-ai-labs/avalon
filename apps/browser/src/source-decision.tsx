import { ChevronRight } from "lucide-react";
import { RallyMark } from "@rally/ui/components/primitives";
import { SourceDecisionResultSchema, type SourceDecisionResult } from "@rally/contracts/browser-session";
import { useEffect, useState } from "react";

import {
  SOURCE_DECISION_LINK_MISSING, sourceDecisionAsk, sourceDecisionFailure, sourceDecisionWords, type SourceDecisionAsk,
  type SourceDecisionFailure,
} from "./source-decision-words";
import { browserRequest } from "./transport";

/**
 * The decision the address carried when this page first drew, read once and
 * then dropped from the address and from history: the fragment is a signed
 * answer, and a shared screen or a synced history should not keep it. Held in
 * document memory only, as an email sign-in proof is. Read by the page, never
 * as the module loads: every other page of the client imports this file too,
 * and their fragments are theirs.
 */
let ask: SourceDecisionAsk | null | undefined;
function readAsk(): SourceDecisionAsk | null {
  if (ask === undefined) {
    ask = sourceDecisionAsk(location.hash);
    if (location.hash) history.replaceState(null, "", location.pathname);
  }
  return ask;
}

/** One post per document, however often the page mounts: the answer is recorded once. */
let posted: Promise<SourceDecisionResult> | null = null;
function post(): Promise<SourceDecisionResult> | null {
  const decision = readAsk();
  if (!decision) return null;
  posted ??= browserRequest(decision.region, "/source-requests/decision", SourceDecisionResultSchema, decision.link);
  return posted;
}

/**
 * Where an emailed Approve or Decline for a Sidekick source request lands.
 * Opening the link is the answer: the page posts the signed decision as it
 * loads, with no sign-in and no second click, and then says how the request
 * stands. A link opened again reads back the same answer. See
 * `docs/browser-client.md#answering-a-source-request-from-email`.
 */
export function SourceDecision(): React.JSX.Element {
  const [result, setResult] = useState<SourceDecisionResult | null>(null);
  const [failure, setFailure] = useState<SourceDecisionFailure | null>(() => readAsk() ? null : SOURCE_DECISION_LINK_MISSING);
  useEffect(() => {
    let active = true;
    post()?.then((answer) => { if (active) setResult(answer); },
      (cause: unknown) => { if (active) setFailure(sourceDecisionFailure(cause)); });
    return () => { active = false; };
  }, []);
  const words = result ? sourceDecisionWords(result) : null;
  return <main className="onboarding-shell signin-shell entry">
    <section className="signin-card entry-card" aria-busy={!words && !failure}>
      <a className="entry-mark" href="/" aria-label="Rally"><RallyMark className="signin-mark" /></a>
      <h1>{words?.title ?? failure?.title ?? "Recording your answer…"}</h1>
      <p className="entry-lead" role="status">{words?.message ?? failure?.message ?? "One moment."}</p>
      {words?.detail ? <p className="entry-lead">{words.detail}</p> : null}
      {words || failure
        ? <div className="signin-choice-list"><a className="signin-choice" href="/"><span className="signin-choice-name">Open Rally</span><ChevronRight aria-hidden="true" size={16} /></a></div>
        : null}
    </section>
  </main>;
}
