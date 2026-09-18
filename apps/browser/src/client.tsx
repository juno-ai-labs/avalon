import { useMemo } from "react";
import type { BrowserSession } from "@rally/contracts/browser-session";
import { cookieClientSession } from "./session";
import { createRoot } from "react-dom/client";
import { BrowserEntry } from "./entry";
import "./styles.css";
import BrowserConversation from "../../desktop/src/renderer/screens/browser-conversation";
function BrowserCollaboration({ region, session }: { region: string; session: BrowserSession }) {
  const collaborationSession = useMemo(() => cookieClientSession(region, session), [region, session]);
  return <BrowserConversation session={collaborationSession} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Browser root is missing");
createRoot(root).render(<BrowserEntry renderCollaboration={(region, session) => <BrowserCollaboration key={`${region}:${session.user.id}:${session.workspace?.id}`} region={region} session={session} />} />);
