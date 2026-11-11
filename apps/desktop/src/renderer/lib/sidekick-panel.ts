import { createContext, useContext } from 'react';
import { useSearchParams } from 'react-router-dom';

/** A panel changes runs locally, keeping its Canvas's route and history intact. */
export const SidekickPanelContext = createContext<{
  runId: string | null;
  openRun: (runId: string | null) => void;
} | null>(null);

export function useSidekickRun(): { runId: string | null; openRun: (runId: string | null) => void } {
  const panel = useContext(SidekickPanelContext);
  const [search, setSearch] = useSearchParams();
  return panel ?? {
    runId: search.get('run'),
    openRun: (runId) => setSearch(runId ? { run: runId } : {}, { replace: runId === null }),
  };
}
