import { AppErrorBoundary } from "@rally/ui/components/app-error-boundary";
import { reportJavascriptError } from "../../desktop/src/renderer/lib/telemetry";
import { installTheme, watchSystemAppearance } from '@rally/ui/lib/theme';
import { lazy, Suspense, useMemo } from "react";
import type { BrowserSession } from "@rally/contracts/browser-session";
import type { Region } from "@rally/contracts/regions";
import { browserShellFor, cookieClientSession } from "./session";
import { createRoot } from "react-dom/client";
import { BrowserEntry } from "./entry";
import "./styles.css";
import '@rally/ui/styles/app.css';
// The signed-in application is a separate loading boundary; email entry must
// not download the collaboration renderer before a person authenticates.
// eslint-disable-next-line rally/no-dynamic-import
const BrowserWorkspace = lazy(() => import('./workspace'));
function BrowserCollaboration({ region, session, onSignOut, onRevalidate }: { region: string; session: BrowserSession; onSignOut: () => void; onRevalidate: () => void }) {
  const collaborationSession = useMemo(() => cookieClientSession(region, session), [region, session]);
  return <Suspense fallback={<p role="status">Opening Rally…</p>}><BrowserWorkspace shell={browserShellFor(session)} region={region as Region} session={collaborationSession} onSignOut={onSignOut} onRevalidate={onRevalidate} /></Suspense>;
}

installTheme();
watchSystemAppearance();

const root = document.getElementById("root");
if (!root) throw new Error("Browser root is missing");
createRoot(root).render(<AppErrorBoundary onError={(error) => reportJavascriptError(error, "react_boundary")}><BrowserEntry renderCollaboration={(region, session, onSignOut, onRevalidate) => <BrowserCollaboration onSignOut={onSignOut} onRevalidate={onRevalidate} key={`${region}:${session.user.id}:${session.workspace?.id}:${browserShellFor(session)}`} region={region} session={session} />} /></AppErrorBoundary>);
