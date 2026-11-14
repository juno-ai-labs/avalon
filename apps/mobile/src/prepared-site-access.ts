import { useEffect, useRef, useState } from 'react';
import { trustedArtifact, type NativeArtifact, type PreparedCanvas } from './protocol';

/** Retry removes consumed access before asking Home for its replacement. */
export function usePreparedSiteAccess(canvas: PreparedCanvas, sessions: Record<string, NativeArtifact>, open: (canvas: PreparedCanvas) => Promise<NativeArtifact | null>, domain: string) {
  const currentSessions = useRef(sessions);
  currentSessions.current = sessions;
  const [access, setAccess] = useState<NativeArtifact | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = () => { setAccess(null); setFailed(false); setAttempt((value) => value + 1); };
  useEffect(() => {
    let active = true;
    setFailed(false);
    // A preparation finishing later must not cancel an opening already in flight.
    const session = attempt === 0 ? currentSessions.current[canvas.canvasId] : null;
    void (session ? Promise.resolve({ ...session, version: canvas.version }) : open(canvas)).then((artifact) => {
      if (!active) return;
      if (artifact && trustedArtifact(artifact, domain)) setAccess(artifact);
      else { setAccess(null); setFailed(true); }
    });
    return () => { active = false; };
  }, [canvas.canvasId, canvas.resourceId, canvas.version, open, domain, attempt]);
  return { access, failed, attempt, retry };
}
