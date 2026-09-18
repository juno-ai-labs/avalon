import { AppErrorBoundary } from "@rally/ui/components/app-error-boundary";
import { reportJavascriptError } from "../../desktop/src/renderer/lib/telemetry";
import { installTheme, watchSystemAppearance } from '@rally/ui/lib/theme';
import { lazy, Suspense, useMemo } from "react";
import type { BrowserSession } from "@rally/contracts/browser-session";
import { cookieClientSession } from "./session";
import { createRoot } from "react-dom/client";
import { BrowserEntry } from "./entry";
import "./styles.css";
import '@rally/ui/styles/app.css';
// The signed-in application is a separate loading boundary; email entry must
// not download the collaboration renderer before a person authenticates.
// eslint-disable-next-line rally/no-dynamic-import
const BrowserConversation = lazy(() => import('./conversation'));
function BrowserCollaboration({ region, session, onSignOut }: { region: string; session: BrowserSession; onSignOut: () => void }) {
  const collaborationSession = useMemo(() => cookieClientSession(region, session), [region, session]);
  return <Suspense fallback={<p role="status">Opening conversation…</p>}><BrowserConversation session={collaborationSession} onSignOut={onSignOut} /></Suspense>;
}

installTheme();
watchSystemAppearance();

const root = document.getElementById("root");
if (!root) throw new Error("Browser root is missing");
createRoot(root).render(<AppErrorBoundary onError={(error) => reportJavascriptError(error, "react_boundary")}><BrowserEntry renderCollaboration={(region, session, onSignOut) => <BrowserCollaboration onSignOut={onSignOut} key={`${region}:${session.user.id}:${session.workspace?.id}`} region={region} session={session} />} /></AppErrorBoundary>);
