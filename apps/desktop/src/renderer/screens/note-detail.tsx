import { useQuery } from '@tanstack/react-query';
import { AudioLines, Globe2, Lock, NotebookText, RefreshCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { MarkdownBody } from '../components/workstream-blocks';
import { Button, EmptyState, LoadingState } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import {
  currentSurfaceEntrypoint,
  noteNavigation,
  reportTelemetryProductIntent,
  telemetryCountBucket,
  telemetryJourneyDuration,
  telemetryVisibility,
} from '../lib/telemetry';

function noteBody(liveNotes: string, manualNotes: string): string {
  return liveNotes.trim() || manualNotes.trim();
}

export function NoteDetailScreen(): React.JSX.Element {
  const { api } = useAppSession();
  const { id } = useParams<{ id: string }>();
  const note = useQuery({
    queryKey: ['note', id],
    queryFn: ({ signal }) => api!.getNote(id!, signal),
    enabled: Boolean(api && id),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const reportedNoteId = useRef<string | null>(null);
  useEffect(() => {
    const detail = note.data;
    if (!detail || reportedNoteId.current === detail.id) return;
    reportedNoteId.current = detail.id;
    reportTelemetryProductIntent({
      kind: 'note_opened_v2',
      noteId: detail.id,
      visibility: telemetryVisibility(detail.scope),
      entrypoint: currentSurfaceEntrypoint(),
      navigation: noteNavigation(detail.id),
      recordingState: detail.recordingStatus,
      hasSummary: Boolean(noteBody(detail.liveNotes, detail.manualNotes)),
      hasTranscript: detail.segments.length > 0,
      duration: telemetryJourneyDuration(detail.recordedMs),
      segmentCount: telemetryCountBucket(detail.segments.length),
    });
  }, [note.data]);

  if (note.isLoading || !note.error && !note.data) return <LoadingState label="Opening note…" />;
  if (note.error || !note.data) {
    return (
      <div className="note-detail-state screen-with-titlebar">
        <div className="screen-drag-strip window-drag" />
        <EmptyState
          action={<Button onClick={() => void note.refetch()}><RefreshCcw size={14} /> Try again</Button>}
          description={note.error instanceof Error ? note.error.message : 'This note is no longer available.'}
          title="Note could not be opened"
        />
      </div>
    );
  }

  const body = noteBody(note.data.liveNotes, note.data.manualNotes);
  const transcript = note.data.segments.map((segment) => segment.text).join('\n\n');
  return (
    <div className="note-detail-screen">
      <section className="note-detail-main">
        <header className="workstream-header window-drag">
          <div className="workstream-header-left window-no-drag">
            <span className="header-origin-icon"><NotebookText aria-hidden="true" size={14} /></span>
            <div className="workstream-title-block">
              <div className="workstream-title-line"><h1>{note.data.title}</h1></div>
              <div className="workstream-subtitle">
                <span>
                  {note.data.scope === 'workspace'
                    ? <><Globe2 aria-hidden="true" size={10} /> Public to workspace</>
                    : <><Lock aria-hidden="true" size={10} /> Private</>}
                </span>
                <span>{note.data.recordingStatus === 'recording' ? 'Recording' : 'Note'}</span>
              </div>
            </div>
          </div>
        </header>
        <div className="note-detail-scroll">
          <article className="note-detail-article">
            {body ? (
              <MarkdownBody>{body}</MarkdownBody>
            ) : (
              <div className="note-detail-empty">
                <NotebookText aria-hidden="true" size={22} />
                <strong>{note.data.recordingStatus === 'recording' ? 'Control Tower is preparing your briefing' : 'No summary yet'}</strong>
                <p>{note.data.recordingStatus === 'recording'
                  ? 'Control Tower updates as the conversation develops.'
                  : 'Rally’s final meeting summary will appear here.'}</p>
              </div>
            )}
          </article>
        </div>
      </section>

      <aside aria-label="Raw transcript" className="note-transcript-rail">
        <header>
          <span><AudioLines aria-hidden="true" size={14} /><h2>Transcript</h2></span>
          {note.data.recordingStatus === 'recording' && <small>Live</small>}
        </header>
        <div className="note-transcript-scroll">
          {transcript ? note.data.segments.map((segment) => (
            <p key={segment.id}>{segment.text}</p>
          )) : (
            <div className="note-transcript-empty">
              <AudioLines aria-hidden="true" size={20} />
              <span>No transcript yet</span>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
