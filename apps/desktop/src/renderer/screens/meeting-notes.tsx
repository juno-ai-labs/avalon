import clsx from 'clsx';
import {
  AudioLines,
  Copy,
  Globe2,
  LoaderCircle,
  Lock,
  Mic,
  NotebookPen,
  Square,
  WandSparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { UpdateNoteRequest } from '@avalon/contracts';
import { Button, IconButton, InlineError } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import type { NoteDetail, NoteTranscriptSegment } from '../lib/types';
import { useRealtimeDictation } from '../lib/use-realtime-dictation';

export const MEETING_TRANSCRIPTION_SEGMENT_MS = 5 * 60 * 1_000;
export const MEETING_NOTES_INTERVAL_MS = 5 * 60 * 1_000;
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function noteIdFromSearch(search: string, createId: () => string = () => crypto.randomUUID()): string {
  const value = new URLSearchParams(search).get('noteId');
  return value && NOTE_ID_PATTERN.test(value) ? value : createId();
}

function currentNoteId(): string {
  return noteIdFromSearch(window.location.search);
}

function defaultMeetingTitle(): string {
  return `Meeting notes — ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date())}`;
}

export function appendMeetingSegment(committed: string, segment: string): string {
  const next = segment.trim();
  if (!next) return committed;
  return committed.trim() ? `${committed.trimEnd()}\n\n${next}` : next;
}

export function meetingRecordedMs(recordedBeforeActiveMs: number, activeStartedAtMs: number | null, nowMs: number): number {
  return recordedBeforeActiveMs + (
    activeStartedAtMs === null ? 0 : Math.max(0, nowMs - activeStartedAtMs)
  );
}

export function mergeSavedMeetingSegmentDuration(
  recordedBeforeActiveMs: number,
  segmentEndOffsetMs: number,
  activeStartedAtMs: number | null,
): number {
  // While recording, recordedBeforeActiveMs is the immutable duration from
  // earlier recording sessions. The active clock contributes this session's
  // elapsed time, so folding segment boundaries into the base would count the
  // same active span again at every five-minute commit.
  return activeStartedAtMs === null
    ? Math.max(recordedBeforeActiveMs, segmentEndOffsetMs)
    : recordedBeforeActiveMs;
}

function formatElapsed(durationMs: number, started: boolean): string {
  if (!started) return 'Not recording';
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function transcriptText(segments: NoteTranscriptSegment[], interim = ''): string {
  return appendMeetingSegment(segments.map((segment) => segment.text).join('\n\n'), interim);
}

export function MeetingNotesScreen(): React.JSX.Element {
  const { api, session } = useAppSession();
  const noteId = useMemo(currentNoteId, []);
  const initialTitle = useMemo(defaultMeetingTitle, []);
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [title, setTitle] = useState(initialTitle);
  const [segments, setSegments] = useState<NoteTranscriptSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [notes, setNotes] = useState('');
  const [startedAt, setStartedAt] = useState<string | undefined>();
  const [recordedMs, setRecordedMs] = useState(0);
  const [generatedAt, setGeneratedAt] = useState<string | undefined>();
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notesPending, setNotesPending] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [visibilityPending, setVisibilityPending] = useState(false);
  const [notesError, setNotesError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const noteRef = useRef<NoteDetail | null>(null);
  const segmentsRef = useRef<NoteTranscriptSegment[]>([]);
  const segmentRef = useRef('');
  const recordedMsRef = useRef(0);
  const recordingIntentRef = useRef(false);
  const activeRecordingStartedAtRef = useRef<number | null>(null);
  const currentSegmentStartedOffsetRef = useRef(0);
  const segmentBoundaryOffsetRef = useRef<number | null>(null);
  const previousDictationStateRef = useRef<string>('idle');
  const generationInFlightRef = useRef(false);
  const generationQueuedRef = useRef(false);
  const persistenceTailRef = useRef<Promise<void>>(Promise.resolve());
  const notesBodyRef = useRef<HTMLDivElement | null>(null);
  const transcriptBodyRef = useRef<HTMLDivElement | null>(null);
  const autoStartRequestedRef = useRef(false);
  const readOnly = Boolean(note && note.ownerUserId !== session?.user.id);

  const hydrateNote = useCallback((next: NoteDetail): void => {
    noteRef.current = next;
    segmentsRef.current = next.segments;
    recordedMsRef.current = next.recordedMs;
    setNote(next);
    setTitle(next.title);
    setSegments(next.segments);
    setNotes(next.liveNotes);
    setRecordedMs(next.recordedMs);
    setStartedAt(next.startedAt ?? undefined);
    setGeneratedAt(next.generatedAt ?? undefined);
  }, []);

  const applyNotePatch = useCallback((next: NoteDetail, patch: UpdateNoteRequest): void => {
    const merged = { ...(noteRef.current ?? next) };
    merged.lastActivityAt = next.lastActivityAt;
    merged.updatedAt = next.updatedAt;
    if (patch.title !== undefined) merged.title = next.title;
    if (patch.manualNotes !== undefined) merged.manualNotes = next.manualNotes;
    if (patch.scope !== undefined) merged.scope = next.scope;
    if (patch.recordingStatus !== undefined) merged.recordingStatus = next.recordingStatus;
    if (patch.recordedMs !== undefined) {
      merged.recordedMs = next.recordedMs;
      recordedMsRef.current = next.recordedMs;
      setRecordedMs(next.recordedMs);
    }
    if ('startedAt' in patch) {
      merged.startedAt = next.startedAt;
      setStartedAt(next.startedAt ?? undefined);
    }
    if ('endedAt' in patch) merged.endedAt = next.endedAt;
    noteRef.current = merged;
    setNote(merged);
  }, []);

  const applyGeneratedNote = useCallback((next: NoteDetail): void => {
    const current = noteRef.current;
    const merged = current ? {
      ...next,
      title: current.title,
      manualNotes: current.manualNotes,
      scope: current.scope,
      recordingStatus: current.recordingStatus,
      recordedMs: current.recordedMs,
      startedAt: current.startedAt,
      endedAt: current.endedAt,
    } : next;
    noteRef.current = merged;
    segmentsRef.current = next.segments;
    setNote(merged);
    setSegments(next.segments);
    setNotes(next.liveNotes);
    setGeneratedAt(next.generatedAt ?? undefined);
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    let active = true;
    setLoading(true);
    setSaveError(undefined);
    void api.createNote(noteId, initialTitle).then((created) => {
      if (active) hydrateNote(created);
    }).catch((error: unknown) => {
      if (active) setSaveError(error instanceof Error ? error.message : 'Avalon could not open this note.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, hydrateNote, initialTitle, noteId]);

  useEffect(() => {
    const current = noteRef.current;
    const nextTitle = title.trim();
    if (!api || !current || readOnly || !nextTitle || nextTitle === current.title) return undefined;
    const timer = window.setTimeout(() => {
      setSavePending(true);
      setSaveError(undefined);
      const patch = { title: nextTitle };
      void api.updateNote(noteId, patch).then((next) => applyNotePatch(next, patch)).catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : 'Avalon could not rename this note.');
      }).finally(() => setSavePending(false));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [api, applyNotePatch, noteId, readOnly, title]);

  const currentRecordedMs = useCallback((): number => {
    return meetingRecordedMs(recordedMsRef.current, activeRecordingStartedAtRef.current, Date.now());
  }, []);

  const onLiveTranscript = useCallback((segment: string) => {
    segmentRef.current = segment;
    setInterim(segment);
  }, []);
  const dictation = useRealtimeDictation(api ?? undefined, onLiveTranscript, {
    includeSystemAudio: true,
    useSystemDefaultMicrophone: true,
  });

  const commitSegment = useCallback(async (
    finalizedText?: string,
    offsets?: { endOffsetMs: number; startOffsetMs: number },
  ): Promise<void> => {
    if (!api || !noteRef.current || readOnly) return;
    const text = (finalizedText ?? segmentRef.current).trim();
    if (finalizedText === undefined) {
      segmentRef.current = '';
      setInterim('');
    }
    if (!text) return;
    const clientSegmentId = crypto.randomUUID();
    const startOffsetMs = offsets?.startOffsetMs ?? currentSegmentStartedOffsetRef.current;
    const endOffsetMs = Math.max(
      startOffsetMs,
      offsets?.endOffsetMs ?? segmentBoundaryOffsetRef.current ?? currentRecordedMs(),
    );
    const capturedAt = new Date().toISOString();
    const optimistic: NoteTranscriptSegment = {
      id: clientSegmentId,
      noteId,
      sequenceNumber: (segmentsRef.current.at(-1)?.sequenceNumber ?? 0) + 1,
      startOffsetMs,
      endOffsetMs,
      capturedAt,
      speakerLabel: null,
      text,
      createdAt: capturedAt,
    };
    segmentsRef.current = [...segmentsRef.current, optimistic];
    setSegments(segmentsRef.current);
    setSavePending(true);
    const operation = persistenceTailRef.current.catch(() => undefined).then(async () => {
      const saved = await api.appendNoteTranscriptSegment(noteId, {
        clientSegmentId,
        startOffsetMs,
        endOffsetMs,
        capturedAt,
        text,
      });
      segmentsRef.current = segmentsRef.current
        .filter((segment) => segment.id !== clientSegmentId && segment.id !== saved.id)
        .concat(saved)
        .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
      const nextRecordedMs = mergeSavedMeetingSegmentDuration(
        recordedMsRef.current,
        saved.endOffsetMs,
        activeRecordingStartedAtRef.current,
      );
      if (nextRecordedMs !== recordedMsRef.current) {
        recordedMsRef.current = nextRecordedMs;
        setRecordedMs(nextRecordedMs);
      }
      setSegments(segmentsRef.current);
      setSaveError(undefined);
    }).catch((error: unknown) => {
      setSaveError(error instanceof Error ? error.message : 'Avalon could not save part of this transcript.');
      throw error;
    }).finally(() => setSavePending(false));
    persistenceTailRef.current = operation;
    await operation;
  }, [api, currentRecordedMs, noteId, readOnly]);

  const stopRecordingClock = useCallback((): number => {
    const activeStartedAt = activeRecordingStartedAtRef.current;
    if (activeStartedAt !== null) {
      recordedMsRef.current += Math.max(0, Date.now() - activeStartedAt);
      activeRecordingStartedAtRef.current = null;
      setRecordedMs(recordedMsRef.current);
    }
    return recordedMsRef.current;
  }, []);

  const generateNotes = useCallback(async (): Promise<void> => {
    if (!api || !noteRef.current || readOnly) return;
    if (generationInFlightRef.current) {
      generationQueuedRef.current = true;
      return;
    }
    generationInFlightRef.current = true;
    setNotesPending(true);
    setNotesError(undefined);
    try {
      await persistenceTailRef.current;
      const updated = await api.generateNoteNotes(noteId);
      applyGeneratedNote(updated);
    } catch (error) {
      setNotesError(error instanceof Error ? error.message : 'Avalon could not update the live notes.');
    } finally {
      generationInFlightRef.current = false;
      setNotesPending(false);
      if (generationQueuedRef.current) {
        generationQueuedRef.current = false;
        void generateNotes();
      }
    }
  }, [api, applyGeneratedNote, noteId, readOnly]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (dictation.state !== 'listening' || !recordingIntentRef.current) return undefined;
    const timer = window.setTimeout(() => {
      if (!recordingIntentRef.current) return;
      const startOffsetMs = currentSegmentStartedOffsetRef.current;
      const boundaryOffsetMs = currentRecordedMs();
      segmentBoundaryOffsetRef.current = boundaryOffsetMs;
      currentSegmentStartedOffsetRef.current = boundaryOffsetMs;
      void dictation.commit().then(async (finalizedTranscript) => {
        await commitSegment(finalizedTranscript, {
          endOffsetMs: boundaryOffsetMs,
          startOffsetMs,
        });
        await generateNotes();
      }).catch(() => {
        if (segmentBoundaryOffsetRef.current === boundaryOffsetMs) {
          currentSegmentStartedOffsetRef.current = startOffsetMs;
        }
      }).finally(() => {
        if (segmentBoundaryOffsetRef.current === boundaryOffsetMs) {
          segmentBoundaryOffsetRef.current = null;
        }
      });
    }, MEETING_TRANSCRIPTION_SEGMENT_MS);
    return () => window.clearTimeout(timer);
  }, [commitSegment, currentRecordedMs, dictation.commit, dictation.state, generateNotes]);

  useEffect(() => {
    const previous = previousDictationStateRef.current;
    previousDictationStateRef.current = dictation.state;
    if (dictation.state === 'error') {
      recordingIntentRef.current = false;
      const finalRecordedMs = stopRecordingClock();
      setRecording(false);
      void commitSegment().finally(() => {
        segmentBoundaryOffsetRef.current = null;
        if (api && noteRef.current) {
          const patch = {
            recordingStatus: 'complete',
            recordedMs: finalRecordedMs,
            endedAt: new Date().toISOString(),
          } as const;
          void api.updateNote(noteId, patch).then((next) => applyNotePatch(next, patch)).catch(() => undefined);
        }
        void generateNotes();
      });
      return;
    }
    if (dictation.state !== 'idle' || previous === 'idle') return;
    void commitSegment().finally(() => {
      segmentBoundaryOffsetRef.current = null;
      void generateNotes();
    });
  }, [api, applyNotePatch, commitSegment, dictation.state, generateNotes, noteId, stopRecordingClock]);

  useEffect(() => () => {
    recordingIntentRef.current = false;
    void dictation.stop();
  }, [dictation.stop]);

  const startRecording = useCallback(async (): Promise<void> => {
    if (!api || !noteRef.current || readOnly || recordingIntentRef.current) return;
    recordingIntentRef.current = true;
    segmentBoundaryOffsetRef.current = null;
    activeRecordingStartedAtRef.current = Date.now();
    currentSegmentStartedOffsetRef.current = recordedMsRef.current;
    setRecording(true);
    const nextStartedAt = startedAt ?? new Date().toISOString();
    setStartedAt(nextStartedAt);
    setSavePending(true);
    try {
      const patch = {
        recordingStatus: 'recording',
        recordedMs: recordedMsRef.current,
        startedAt: nextStartedAt,
        endedAt: null,
      } as const;
      const [next] = await Promise.all([
        api.updateNote(noteId, patch),
        // Start capture alongside the status update so the window begins
        // listening even when the meeting has not started producing audio yet.
        dictation.start(),
      ]);
      applyNotePatch(next, patch);
    } catch (error) {
      recordingIntentRef.current = false;
      stopRecordingClock();
      setRecording(false);
      await dictation.stop().catch(() => undefined);
      setSaveError(error instanceof Error ? error.message : 'Avalon could not start this recording.');
    } finally {
      setSavePending(false);
    }
  }, [api, applyNotePatch, dictation.start, dictation.stop, noteId, readOnly, startedAt, stopRecordingClock]);

  useEffect(() => {
    if (
      autoStartRequestedRef.current
      || loading
      || !note
      || readOnly
      || note.recordingStatus !== 'idle'
    ) return;
    autoStartRequestedRef.current = true;
    void startRecording();
  }, [loading, note, readOnly, startRecording]);

  const stopRecording = async (): Promise<void> => {
    if (!api || !noteRef.current || readOnly) return;
    recordingIntentRef.current = false;
    const finalRecordedMs = stopRecordingClock();
    setRecording(false);
    setSavePending(true);
    const patch = {
      recordingStatus: 'complete',
      recordedMs: finalRecordedMs,
      endedAt: new Date().toISOString(),
    } as const;
    void api.updateNote(noteId, patch).then((next) => applyNotePatch(next, patch)).catch((error: unknown) => {
      setSaveError(error instanceof Error ? error.message : 'Avalon could not finish saving this note.');
    }).finally(() => setSavePending(false));
    if (dictation.state === 'idle' || dictation.state === 'error') {
      await commitSegment();
      await generateNotes();
      return;
    }
    await dictation.stop();
  };

  const copy = async (value: string): Promise<void> => {
    if (value) await desktopBridge().copyText(value);
  };

  const changeVisibility = async (scope: 'personal' | 'workspace'): Promise<void> => {
    if (!api || !noteRef.current || readOnly || noteRef.current.scope === scope) return;
    setVisibilityPending(true);
    setSavePending(true);
    setSaveError(undefined);
    try {
      const patch = { scope };
      applyNotePatch(await api.updateNote(noteId, patch), patch);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Avalon could not update this note’s visibility.');
    } finally {
      setVisibilityPending(false);
      setSavePending(false);
    }
  };

  const transcript = transcriptText(segments, interim);
  useEffect(() => {
    const body = notesBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [notes, notesPending]);
  useEffect(() => {
    const body = transcriptBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [transcript]);

  const statusLabel = dictation.state === 'requesting'
    ? 'Requesting audio access…'
    : dictation.state === 'connecting'
      ? 'Connecting transcription…'
      : dictation.state === 'transcribing'
        ? 'Updating notes…'
        : recording
          ? 'Recording'
          : 'Ready';

  return (
    <div className="meeting-surface">
      <header className="meeting-titlebar window-drag">
        <div className="meeting-titlebar-copy window-no-drag">
          <span className={clsx('meeting-recording-dot', recording && 'is-active')} aria-hidden="true" />
          <span>{loading ? 'Opening note…' : statusLabel}</span>
          <span aria-label="Recording duration">{formatElapsed(
            meetingRecordedMs(
              recordedMs,
              recording ? activeRecordingStartedAtRef.current : null,
              now,
            ),
            Boolean(startedAt),
          )}</span>
        </div>
        <p>{readOnly ? 'Shared read-only note' : savePending ? 'Saving…' : 'Saved to Avalon'}</p>
      </header>

      <main className="meeting-layout">
        <section className="meeting-heading">
          <input
            aria-label="Note title"
            disabled={loading || !note || readOnly}
            id="meeting-title"
            maxLength={180}
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
          <div className="meeting-heading-meta">
            <p>{recording ? 'Listening to your microphone and computer audio' : 'Live meeting notes'}</p>
            <label className="meeting-visibility">
              {note?.scope === 'workspace' ? <Globe2 aria-hidden="true" size={13} /> : <Lock aria-hidden="true" size={13} />}
              <span className="sr-only">Note visibility</span>
              <select
                aria-label="Note visibility"
                disabled={loading || !note || readOnly || visibilityPending}
                onChange={(event) => void changeVisibility(event.target.value as 'personal' | 'workspace')}
                value={note?.scope ?? 'personal'}
              >
                <option value="personal">Private</option>
                <option value="workspace">Public to workspace</option>
              </select>
            </label>
          </div>
          {saveError && <InlineError>{saveError}</InlineError>}
        </section>

        <div className="meeting-stack">
          <section aria-labelledby="live-notes-heading" className="meeting-live-notes">
            <header>
              <span><NotebookPen aria-hidden="true" size={17} /><h2 id="live-notes-heading">AI summary</h2></span>
              <IconButton disabled={!notes || notesPending} label="Copy AI summary" onClick={() => void copy(notes)}>
                <Copy size={15} />
              </IconButton>
            </header>
            <div aria-live="polite" className="meeting-notes-body" ref={notesBodyRef}>
              {generatedAt && <p className="meeting-updated-at">Updated {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(generatedAt))}</p>}
              {notesError && <InlineError>{notesError}</InlineError>}
              {notes ? (
                <div className="meeting-generated-notes">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>
                </div>
              ) : (
                <div className="meeting-empty-state">
                  <WandSparkles aria-hidden="true" size={24} />
                  <strong>Your running summary will appear here</strong>
                  <p>Avalon updates it automatically every five minutes and once more when the recording ends.</p>
                </div>
              )}
              {notesPending && (
                <div className="meeting-summary-progress"><LoaderCircle className="spin" size={14} /> Updating summary…</div>
              )}
            </div>
          </section>

          <section aria-labelledby="live-transcript-heading" className="meeting-transcript-card">
            <header>
              <span><AudioLines aria-hidden="true" size={18} /><h2 id="live-transcript-heading">Live transcript</h2></span>
              <IconButton disabled={!transcript} label="Copy transcript" onClick={() => void copy(transcript)}>
                <Copy size={15} />
              </IconButton>
            </header>
            <div aria-live="polite" className="meeting-transcript-body" ref={transcriptBodyRef}>
              {transcript ? transcript.split(/\n{2,}/u).map((paragraph, index) => (
                <p key={`${index}-${paragraph.slice(0, 20)}`}>{paragraph}</p>
              )) : (
                <div className="meeting-empty-state">
                  <Mic aria-hidden="true" size={24} />
                  <strong>Your transcript will appear live</strong>
                  <p>Start recording and speak naturally. Avalon automatically captures you and the meeting.</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <footer className="meeting-controls">
        <div className="meeting-control-status">
          {dictation.error
            ? <span role="alert">{dictation.error}</span>
            : <span>Uses your current system audio input</span>}
        </div>
        {recording ? (
          <Button className="meeting-stop-button" onClick={() => void stopRecording()}>
            <Square fill="currentColor" size={12} /> Stop recording
          </Button>
        ) : (
          <Button
            className="meeting-start-button"
            disabled={loading || !note || readOnly || ['requesting', 'connecting', 'transcribing'].includes(dictation.state)}
            onClick={() => void startRecording()}
          >
            <span aria-hidden="true" className="meeting-start-dot" /> Start recording
          </Button>
        )}
        <span aria-hidden="true" />
      </footer>
    </div>
  );
}
