import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { AppErrorBoundary } from "@rally/ui/components/app-error-boundary";
import { reportJavascriptError } from "../../desktop/src/renderer/lib/telemetry";
import { installTheme, watchSystemAppearance } from '@rally/ui/lib/theme';
import { lazy, Suspense, useMemo } from "react";
import type { BrowserSession } from "@rally/contracts/browser-session";
import type { Region } from "@rally/contracts/regions";
import { cookieClientSession } from "./session";
import { createRoot } from "react-dom/client";
import { BrowserBoot, BrowserEntry } from "./entry";
import { ConnectionComplete } from "./connection-complete";
import { installNotificationOpen } from "./notification-open";
import "./styles.css";
import '@rally/ui/styles/app.css';
// The signed-in application is a separate loading boundary; email entry must
// not download the collaboration renderer before a person authenticates.
// eslint-disable-next-line rally/no-dynamic-import
const BrowserShell = lazy(() => import('./shell'));
function BrowserCollaboration({ region, session, onSignOut, onRevalidate }: { region: string; session: BrowserSession; onSignOut: () => void; onRevalidate: () => void }) {
  const collaborationSession = useMemo(() => cookieClientSession(region, session), [region, session]);
  return <Suspense fallback={<BrowserBoot />}><BrowserShell region={region as Region} session={collaborationSession} onSignOut={onSignOut} onRevalidate={onRevalidate} /></Suspense>;
}

installNotificationOpen();
installTheme();
watchSystemAppearance();

// The access class is in the key so a promotion, or a member made a guest,
// remounts the shell: its caches hold what the old relationship could read.
const root = document.getElementById("root");
if (!root) throw new Error("Browser root is missing");
createRoot(root).render(<ErrorNoticeProvider><AppErrorBoundary onError={(error) => reportJavascriptError(error, "react_boundary")}>
  {location.pathname === "/connections/complete"
    ? <ConnectionComplete />
    : <BrowserEntry renderCollaboration={(region, session, onSignOut, onRevalidate) => <BrowserCollaboration onSignOut={onSignOut} onRevalidate={onRevalidate} key={`${region}:${session.user.id}:${session.workspace?.id}:${session.workspace?.accessClass ?? "member"}`} region={region} session={session} />} />}
</AppErrorBoundary></ErrorNoticeProvider>);
