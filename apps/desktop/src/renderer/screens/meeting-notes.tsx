import clsx from 'clsx';
import { IconAirTrafficControl, IconWaveSine } from '@tabler/icons-react';
import {
  Copy,
  Globe2,
  LoaderCircle,
  Lock,
  Mic,
  Pause,
  Play,
  Square,
  WandSparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONTROL_TOWER_REFRESH_SECONDS, type UpdateNoteRequest } from '@rally/contracts';
import type {
  DesktopMediaPermissionStatus,
  DesktopMeetingAudioPermissions,
  MeetingAudioPermissionKind,
} from '../../common/desktop';
import { Button, IconButton, InlineError, Modal } from '../components/primitives';
import { MarkdownBody } from '../components/workstream-blocks';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import {
  reportTelemetryProductIntent,
  telemetryCountBucket,
  telemetryJourneyDuration,
  telemetryVisibility,
} from '../lib/telemetry';
import type { NoteDetail, NoteTranscriptSegment } from '../lib/types';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { useRealtimeDictation } from '../lib/use-realtime-dictation';

/**
 * The cadence this screen keeps when the service has not told it one.
 *
 * Control Tower is only useful while the conversation it describes is still
 * happening, so one timer commits the transcript segment and asks for the next
 * briefing — in that order, because the commit is what makes the last minute of
 * speech visible to the refresh that follows it. One constant rather than two:
 * a separate notes interval would be a second cadence for a loop that has one.
 *
 * The real cadence is served by the `control-tower-refresh-seconds` flag and
 * read below; this is the fallback for a device that could not ask, and it
 * matches the flag's checked-in default so both answers agree.
 */
export const DEFAULT_MEETING_NOTES_INTERVAL_MS = CONTROL_TOWER_REFRESH_SECONDS.default * 1_000;

/**
 * How long the cadence request may hold the first segment timer before this
 * meeting settles on the default and records on that. A meeting must never wait
 * on a feature flag; it must also not start one cadence and finish on another.
 */
export const MEETING_CADENCE_REQUEST_TIMEOUT_MS = 5_000;
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function noteIdFromSearch(search: string, createId: () => string = () => crypto.randomUUID()): string {
  const value = new URLSearchParams(search).get('noteId');
  return value && NOTE_ID_PATTERN.test(value) ? value : createId();
}

function currentNoteId(): string {
  return noteIdFromSearch(window.location.search);
}

function meetingEntrypoint(): 'sidebar' | 'menu_bar' | 'unknown' | null {
  const value = new URLSearchParams(window.location.search).get('meetingEntrypoint');
  return value === 'sidebar' || value === 'menu_bar' || value === 'unknown' ? value : null;
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

/**
 * How the refresh cadence is described to the person waiting for a briefing.
 * The number is served, so the copy cannot name one: promising a briefing every
 * minute on a five-minute cadence is worse than saying nothing.
 */
export function meetingRefreshCadenceLabel(intervalMs: number): string {
  const seconds = Math.max(1, Math.round(intervalMs / 1_000));
  if (seconds % 60 !== 0) return `every ${seconds} seconds`;
  const minutes = seconds / 60;
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
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
  // same active span again at every segment commit.
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

function permissionIsBlocked(status: DesktopMediaPermissionStatus | undefined): boolean {
  return status === 'denied' || status === 'restricted';
}

function recordingPermissionClass(permissions: DesktopMeetingAudioPermissions | undefined):
  'both_granted' | 'microphone_only' | 'system_only' | 'both_blocked' | 'unknown' {
  if (!permissions) return 'unknown';
  const microphone = !permissionIsBlocked(permissions.microphone);
  const system = !permissionIsBlocked(permissions.systemAudio);
  if (microphone && system) return 'both_granted';
  if (microphone) return 'microphone_only';
  if (system) return 'system_only';
  return 'both_blocked';
}

export function MeetingNotesScreen(): React.JSX.Element {
  const { api, session } = useAppSession();
  const clientFeatureFlags = useClientFeatureFlags(api);
  const meetingRecordingAvailable = clientFeatureFlags.data?.meetingRecordingEnabled === true;
  const noteId = useMemo(currentNoteId, []);
  const creationEntrypoint = useMemo(meetingEntrypoint, []);
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
  const [finalizing, setFinalizing] = useState(false);
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notesPending, setNotesPending] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [visibilityPending, setVisibilityPending] = useState(false);
  const [permissionPreparing, setPermissionPreparing] = useState(false);
  const [audioPermissions, setAudioPermissions] = useState<DesktopMeetingAudioPermissions>();
  const [notesError, setNotesError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  /** `null` until the cadence for this meeting settles; then never replaced. */
  const [refreshIntervalMs, setRefreshIntervalMs] = useState<number | null>(null);
  const noteRef = useRef<NoteDetail | null>(null);
  const segmentsRef = useRef<NoteTranscriptSegment[]>([]);
  const segmentRef = useRef('');
  const recordedMsRef = useRef(0);
  const recordingIntentRef = useRef(false);
  const activeRecordingStartedAtRef = useRef<number | null>(null);
  const currentSegmentStartedOffsetRef = useRef(0);
  const segmentBoundaryOffsetRef = useRef<number | null>(null);
  const finalizationInFlightRef = useRef<Promise<boolean> | undefined>(undefined);
  const transcriptionAudioSourceRef = useRef<
    'microphone_and_system' | 'microphone_only' | 'system_only' | 'unknown'
  >('unknown');
  const generationTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const liveGenerationRef = useRef<Promise<boolean> | null>(null);
  const persistenceTailRef = useRef<Promise<void>>(Promise.resolve());
  const notesBodyRef = useRef<HTMLDivElement | null>(null);
  const transcriptBodyRef = useRef<HTMLDivElement | null>(null);
  const autoStartRequestedRef = useRef(false);
  const pauseCountRef = useRef(0);
  const terminalTelemetryReportedRef = useRef(false);
  const recordingGuardRegisteredRef = useRef(false);
  const readOnly = Boolean(note && note.ownerUserId !== session?.user.id);

  const recordingWorkspaceId = session?.workspace?.id;
  const recordingWorkspaceRegion = session?.workspace?.region;
  const releaseRecordingGuard = useCallback(async (): Promise<void> => {
    if (!recordingWorkspaceId || !recordingWorkspaceRegion || !recordingGuardRegisteredRef.current) return;
    recordingGuardRegisteredRef.current = false;
    await desktopBridge().setMeetingRecordingState({
      region: recordingWorkspaceRegion,
      workspaceId: recordingWorkspaceId,
      recording: false,
    }).catch(() => undefined);
  }, [recordingWorkspaceId, recordingWorkspaceRegion]);

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
      if (active) {
        hydrateNote(created);
        if (creationEntrypoint) reportTelemetryProductIntent({
          kind: 'note_created',
          noteId: created.id,
          visibility: telemetryVisibility(created.scope),
          noteType: 'meeting_or_voice',
          entrypoint: creationEntrypoint,
        });
      }
    }).catch((error: unknown) => {
      if (active) setSaveError(error instanceof Error ? error.message : 'Rally could not open this note.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, creationEntrypoint, hydrateNote, initialTitle, noteId]);

  useEffect(() => {
    if (!api || refreshIntervalMs !== null) return undefined;
    const controller = new AbortController();
    // Asked once, when the screen opens, and never replaced: this window exists
    // for one meeting, and a cadence arriving later would re-arm the segment
    // timer mid-recording, moving a transcript boundary and leaving the
    // briefing describing a schedule that had already changed under it.
    //
    const settle = (intervalMs: number): void => {
      setRefreshIntervalMs((current) => current ?? intervalMs);
    };
    const timeout = window.setTimeout(
      () => {
        controller.abort();
        settle(DEFAULT_MEETING_NOTES_INTERVAL_MS);
      },
      MEETING_CADENCE_REQUEST_TIMEOUT_MS,
    );
    void api.clientFeatureFlags(controller.signal)
      .then((flags) => settle(flags.controlTowerRefreshSeconds * 1_000))
      .catch(() => settle(DEFAULT_MEETING_NOTES_INTERVAL_MS))
      .finally(() => window.clearTimeout(timeout));
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [api, refreshIntervalMs]);

  useEffect(() => {
    const current = noteRef.current;
    const nextTitle = title.trim();
    if (!api || !current || readOnly || !nextTitle || nextTitle === current.title) return undefined;
    const timer = window.setTimeout(() => {
      setSavePending(true);
      setSaveError(undefined);
      const patch = { title: nextTitle };
      void api.updateNote(noteId, patch).then((next) => applyNotePatch(next, patch)).catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : 'Rally could not rename this note.');
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
      setSaveError(error instanceof Error ? error.message : 'Rally could not save part of this transcript.');
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

  /** Resolves to whether the briefing was written; a failure resolves `false`. */
  const generateNotes = useCallback(
    (
      mode: 'live' | 'final' = 'live',
      transcriptStatus: 'complete' | 'partial' = mode === 'final' ? 'complete' : 'partial',
    ): Promise<boolean> => {
      if (!api || !noteRef.current || readOnly) return Promise.resolve(false);
      // A live briefing replaces the last one rather than adding to it, so a
      // refresh raised while one is still running has nothing of its own to
      // contribute: its segments are already durable, and the pass in flight —
      // or the next one — summarizes the transcript through its newest segment
      // either way. Coalescing rather than queueing is what keeps a pass slower
      // than the cadence from building a backlog of inferences that also has to
      // drain before finalization can start. A final pass never coalesces: it
      // is the one summary that must run over the completed transcript.
      if (mode === 'live' && liveGenerationRef.current) return liveGenerationRef.current;
      setNotesPending(true);
      setNotesError(undefined);
      const operation = generationTailRef.current.catch(() => undefined).then(async () => {
        // Wait for transcript persistence to settle, but still allow a live or
        // final summary of the segments that reached the server when the most
        // recent segment save failed.
        await persistenceTailRef.current.catch(() => undefined);
        // The cadence this meeting settled on travels with the request, so the
        // briefing is written for the schedule actually being kept rather than
        // for whatever the flag says at the moment the server reads it.
        const updated = await api.generateNoteNotes(noteId, mode, transcriptStatus, refreshIntervalMs === null
          ? undefined
          : Math.round(refreshIntervalMs / 1_000));
        applyGeneratedNote(updated);
        return true;
      }).catch((error: unknown) => {
        setNotesError(error instanceof Error
          ? error.message
          : mode === 'final'
            ? 'Rally could not create the final meeting summary.'
            : 'Rally could not update Control Tower.');
        return false;
      }).finally(() => {
        if (generationTailRef.current === operation) setNotesPending(false);
        if (liveGenerationRef.current === operation) liveGenerationRef.current = null;
      });
      generationTailRef.current = operation;
      if (mode === 'live') liveGenerationRef.current = operation;
      return operation;
    }, [api, applyGeneratedNote, noteId, readOnly, refreshIntervalMs]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    // No timer until this meeting has a cadence. Arming on the default and
    // re-arming on the served value would move the first segment boundary.
    if (refreshIntervalMs === null) return undefined;
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
        await generateNotes('live', 'partial');
      }).catch(() => {
        if (segmentBoundaryOffsetRef.current === boundaryOffsetMs) {
          currentSegmentStartedOffsetRef.current = startOffsetMs;
        }
      }).finally(() => {
        if (segmentBoundaryOffsetRef.current === boundaryOffsetMs) {
          segmentBoundaryOffsetRef.current = null;
        }
      });
    }, refreshIntervalMs);
    return () => window.clearTimeout(timer);
    // The timer re-arms because `dictation.state` leaves `listening` for the
    // commit and returns; a served cadence arriving mid-meeting re-arms it the
    // same way, at the new interval.
  }, [commitSegment, currentRecordedMs, dictation.commit, dictation.state, generateNotes, refreshIntervalMs]);

  const startRecording = useCallback(async (): Promise<void> => {
    if (!api || !noteRef.current || readOnly || recordingIntentRef.current || finalizationInFlightRef.current) return;
    recordingIntentRef.current = true;
    segmentBoundaryOffsetRef.current = null;
    setPermissionPreparing(true);
    setSavePending(true);
    setSaveError(undefined);
    let preparedPermissions: DesktopMeetingAudioPermissions | undefined;
    try {
      const bridge = desktopBridge();
      const permissions = await bridge.prepareMeetingAudioPermissions();
      preparedPermissions = permissions;
      setAudioPermissions(permissions);
      if (permissionIsBlocked(permissions.microphone) && permissionIsBlocked(permissions.systemAudio)) {
        throw new Error(
          'Microphone and computer audio access are blocked. Open System Settings, allow Rally, then retry recording.',
        );
      }
      if (!session?.workspace) throw new Error('Open a workspace before recording a meeting.');
      await bridge.setMeetingRecordingState({
        region: session.workspace.region,
        workspaceId: session.workspace.id,
        recording: true,
      });
      recordingGuardRegisteredRef.current = true;
      activeRecordingStartedAtRef.current = Date.now();
      currentSegmentStartedOffsetRef.current = recordedMsRef.current;
      setRecording(true);
      const nextStartedAt = startedAt ?? new Date().toISOString();
      setStartedAt(nextStartedAt);
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
      const audioSource = !permissionIsBlocked(permissions.microphone) && !permissionIsBlocked(permissions.systemAudio)
        ? 'microphone_and_system'
        : !permissionIsBlocked(permissions.microphone)
          ? 'microphone_only'
          : !permissionIsBlocked(permissions.systemAudio) ? 'system_only' : 'unknown';
      transcriptionAudioSourceRef.current = audioSource;
      reportTelemetryProductIntent({
        kind: 'transcription_state_changed',
        noteId,
        state: 'started',
        visibility: telemetryVisibility(next.scope),
        audioSource,
      });
      reportTelemetryProductIntent({
        kind: 'recording_start_completed',
        noteId,
        result: 'success',
        permissionClass: recordingPermissionClass(permissions),
        audioSource,
        entrypoint: creationEntrypoint ?? 'unknown',
      });
      void bridge.getMeetingAudioPermissions().then(setAudioPermissions).catch(() => undefined);
    } catch (error) {
      recordingIntentRef.current = false;
      stopRecordingClock();
      setRecording(false);
      await dictation.stop().catch(() => undefined);
      await releaseRecordingGuard();
      setSaveError(error instanceof Error ? error.message : 'Rally could not start this recording.');
      reportTelemetryProductIntent({
        kind: 'recording_start_completed',
        noteId,
        result: recordingPermissionClass(preparedPermissions) === 'both_blocked'
          ? 'permission_denied'
          : 'capture_failed',
        permissionClass: recordingPermissionClass(preparedPermissions),
        audioSource: 'unknown',
        entrypoint: creationEntrypoint ?? 'unknown',
      });
    } finally {
      setPermissionPreparing(false);
      setSavePending(false);
    }
  }, [api, applyNotePatch, creationEntrypoint, dictation.start, dictation.stop, noteId, readOnly, releaseRecordingGuard, session?.workspace, startedAt, stopRecordingClock]);

  useEffect(() => {
    if (readOnly) return undefined;
    const refreshPermissions = (): void => {
      void desktopBridge().getMeetingAudioPermissions().then(setAudioPermissions).catch(() => undefined);
    };
    window.addEventListener('focus', refreshPermissions);
    return () => window.removeEventListener('focus', refreshPermissions);
  }, [readOnly]);

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

  /**
   * Resolves to whether the meeting finished cleanly — the transcript closed,
   * the final summary written, and the note marked complete. Anything less
   * still finishes as much as it can, but the answer is `false`, because the
   * caller that closes this window has to know whether it would be closing over
   * an error nothing else reports.
   */
  const finalizeRecording = useCallback((): Promise<boolean> => {
    if (finalizationInFlightRef.current) return finalizationInFlightRef.current;
    if (!api || !noteRef.current || readOnly) return Promise.resolve(false);
    recordingIntentRef.current = false;
    const finalRecordedMs = stopRecordingClock();
    setRecording(false);
    setFinalizing(true);
    setSavePending(true);
    setSaveError(undefined);
    const operation = (async (): Promise<boolean> => {
      let complete = true;
      let transcriptStatus: 'complete' | 'partial' = dictation.state === 'error' ? 'partial' : 'complete';
      if (dictation.state === 'error') complete = false;
      if (dictation.state !== 'idle' && dictation.state !== 'error') {
        try {
          await dictation.stop();
        } catch (error) {
          // Keep the best partial transcript visible and persist it below. The
          // recording has already stopped, so retrying capture cannot recover
          // audio that the provider failed to finalize.
          complete = false;
          transcriptStatus = 'partial';
          setSaveError(error instanceof Error ? error.message : 'Rally could not finalize the transcript.');
        }
      }
      await releaseRecordingGuard();
      try {
        await commitSegment();
      } catch {
        // Earlier segments are already durable and still useful for the final
        // summary. Keep the visible save error, mark the transcript partial,
        // and finish the note instead of abandoning all finalization work.
        complete = false;
        transcriptStatus = 'partial';
      }
      segmentBoundaryOffsetRef.current = null;
      // A failed summary sets its own visible error and does not reject, so it
      // is only reported here — and it is the failure most worth keeping a
      // window open for, since nothing in the note screen can ask for the
      // summary again.
      const summarySucceeded = await generateNotes('final', transcriptStatus);
      if (!summarySucceeded) complete = false;
      const patch = {
        recordingStatus: 'complete',
        recordedMs: finalRecordedMs,
        endedAt: new Date().toISOString(),
      } as const;
      const completedNote = await api.updateNote(noteId, patch);
      applyNotePatch(completedNote, patch);
      reportTelemetryProductIntent({
        kind: 'transcription_state_changed',
        noteId,
        state: 'completed',
        visibility: telemetryVisibility(completedNote.scope),
        audioSource: transcriptionAudioSourceRef.current,
      });
      if (!terminalTelemetryReportedRef.current) {
        terminalTelemetryReportedRef.current = true;
        reportTelemetryProductIntent({
          kind: 'recording_terminal',
          noteId,
          result: transcriptStatus === 'partial'
            ? 'partial_transcript'
            : !summarySucceeded ? 'summary_failed' : complete ? 'complete' : 'capture_failed',
          duration: telemetryJourneyDuration(finalRecordedMs),
          segmentCount: telemetryCountBucket(segmentsRef.current.length),
          pauseCount: telemetryCountBucket(pauseCountRef.current),
          finalSummaryResult: summarySucceeded ? 'success' : 'failed',
          audioSource: transcriptionAudioSourceRef.current,
        });
      }
      return complete;
    })().catch((error: unknown) => {
      setSaveError(error instanceof Error ? error.message : 'Rally could not finish saving this note.');
      if (!terminalTelemetryReportedRef.current) {
        terminalTelemetryReportedRef.current = true;
        reportTelemetryProductIntent({
          kind: 'recording_terminal',
          noteId,
          result: 'persistence_failed',
          duration: telemetryJourneyDuration(finalRecordedMs),
          segmentCount: telemetryCountBucket(segmentsRef.current.length),
          pauseCount: telemetryCountBucket(pauseCountRef.current),
          finalSummaryResult: 'not_attempted',
          audioSource: transcriptionAudioSourceRef.current,
        });
      }
      throw error;
    }).finally(() => {
      finalizationInFlightRef.current = undefined;
      setFinalizing(false);
      setSavePending(false);
    });
    finalizationInFlightRef.current = operation;
    return operation;
  }, [api, applyNotePatch, commitSegment, dictation.state, dictation.stop, generateNotes, noteId, readOnly, releaseRecordingGuard, stopRecordingClock]);

  useEffect(() => {
    if (dictation.state !== 'error' || !recordingIntentRef.current) return;
    void finalizeRecording().catch(() => undefined);
  }, [dictation.state, finalizeRecording]);

  const finalizeAndClose = useCallback((): void => {
    const bridge = desktopBridge();
    const shouldFinalize = Boolean(finalizationInFlightRef.current)
      || recordingIntentRef.current
      || !['idle', 'error'].includes(dictation.state);
    const pending = shouldFinalize ? finalizeRecording() : Promise.resolve();
    // An explicit native close must not strand the window—or block app quit—
    // when the final network save fails. Incremental segments remain durable.
    void pending.catch(() => undefined).finally(() => bridge.closeMeetingNotes());
  }, [dictation.state, finalizeRecording]);

  // A recording can end on its own — a dictation error finalizes the meeting —
  // and the question stops applying with it. Leaving the dialog up would ask
  // about a recording that has already stopped, over a window whose only
  // remaining news might be the error that stopped it.
  useEffect(() => {
    if (!recording) setCloseConfirmationOpen(false);
  }, [recording]);

  useEffect(() => {
    const bridge = desktopBridge();
    return bridge.onMeetingCloseRequested((reason) => {
      // Until finalization lands, this window is the meeting: the transcript
      // tail, the final summary, and the note's completion all depend on it
      // staying up long enough to finish. A close the person performed on it
      // while that is true is worth one question. A quit is not asked, because
      // a window waiting on an answer is a window that vetoes the quit — and
      // finalization already runs on that path, so nothing is lost by it.
      if (reason === 'user' && recording) {
        setCloseConfirmationOpen(true);
        return;
      }
      finalizeAndClose();
    });
  }, [finalizeAndClose, recording]);

  useEffect(() => () => {
    recordingIntentRef.current = false;
    void dictation.stop().catch(() => undefined);
    void releaseRecordingGuard();
  }, [dictation.stop, releaseRecordingGuard]);

  const stopRecording = async (): Promise<void> => {
    // The meeting is over and the note is the artifact, so the window's job is
    // done: it closes and hands the main window to the note it just produced.
    // Only when the meeting actually finished, though — a failed transcript
    // close, segment save, or final summary leaves an error that this window is
    // the only place to read, and closing over it would strand the person with
    // a note that is quietly missing its summary. The native close path stays
    // as it was: it closes regardless, because a window that will not shut also
    // blocks app quit.
    if (!await finalizeRecording()) return;
    await desktopBridge().closeMeetingNotes(noteId).catch(() => undefined);
  };

  const pauseRecording = async (): Promise<void> => {
    if (!recording || finalizing || dictation.state !== 'listening') return;
    await dictation.pause();
    pauseCountRef.current += 1;
    stopRecordingClock();
    reportTelemetryProductIntent({
      kind: 'transcription_state_changed',
      noteId,
      state: 'paused',
      visibility: telemetryVisibility(noteRef.current?.scope ?? 'personal'),
      audioSource: transcriptionAudioSourceRef.current,
    });
  };

  const resumeRecording = async (): Promise<void> => {
    if (!recording || finalizing || dictation.state !== 'paused') return;
    await dictation.resume();
    activeRecordingStartedAtRef.current = Date.now();
    setNow(Date.now());
    reportTelemetryProductIntent({
      kind: 'transcription_state_changed',
      noteId,
      state: 'resumed',
      visibility: telemetryVisibility(noteRef.current?.scope ?? 'personal'),
      audioSource: transcriptionAudioSourceRef.current,
    });
  };

  const copy = async (value: string, contentType: 'note_summary' | 'note_transcript'): Promise<void> => {
    if (!value) return;
    await desktopBridge().copyText(value);
    reportTelemetryProductIntent({ kind: 'content_copied', contentType, resourceType: 'note', resourceId: noteId });
  };

  const changeVisibility = async (scope: 'personal' | 'workspace'): Promise<void> => {
    if (!api || !noteRef.current || readOnly || noteRef.current.scope === scope) return;
    setVisibilityPending(true);
    setSavePending(true);
    setSaveError(undefined);
    try {
      const patch = { scope };
      const updated = await api.updateNote(noteId, patch);
      applyNotePatch(updated, patch);
      reportTelemetryProductIntent({
        kind: 'note_action_completed',
        noteId,
        action: scope === 'workspace' ? 'make_public' : 'make_private',
        visibility: telemetryVisibility(updated.scope),
        recordingState: updated.recordingStatus,
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Rally could not update this note’s visibility.');
    } finally {
      setVisibilityPending(false);
      setSavePending(false);
    }
  };

  const transcript = transcriptText(segments, interim);
  const paused = dictation.state === 'paused';
  const permissionRecoveryTarget: MeetingAudioPermissionKind | undefined = permissionIsBlocked(audioPermissions?.microphone)
    || dictation.error?.includes('Microphone access is blocked')
    ? 'microphone'
    : permissionIsBlocked(audioPermissions?.systemAudio)
      || dictation.warning?.includes('Computer audio access is blocked')
      ? 'system-audio'
      : undefined;
  const openPermissionSettings = async (): Promise<void> => {
    if (!permissionRecoveryTarget) return;
    try {
      await desktopBridge().openMeetingAudioSettings(permissionRecoveryTarget);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Rally could not open System Settings.');
    }
  };
  useEffect(() => {
    const body = notesBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [notes, notesPending]);
  useEffect(() => {
    const body = transcriptBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [transcript]);

  const statusLabel = finalizing || dictation.state === 'finalizing'
    ? 'Finalizing transcript…'
    : permissionPreparing || dictation.state === 'requesting'
    ? 'Requesting audio access…'
    : dictation.state === 'connecting'
      ? 'Connecting transcription…'
      : dictation.state === 'transcribing'
        ? 'Updating notes…'
        : paused
          ? 'Paused'
        : recording
          ? 'Recording'
          : 'Ready';

  return (
    <div className="meeting-surface">
      <header className="meeting-titlebar window-drag">
        <div className="meeting-titlebar-copy window-no-drag">
          <span className={clsx('meeting-recording-dot', recording && !paused && 'is-active')} aria-hidden="true" />
          <span>{loading ? 'Opening note…' : statusLabel}</span>
          <span aria-label="Recording duration">{formatElapsed(
            meetingRecordedMs(
              recordedMs,
              recording && !paused ? activeRecordingStartedAtRef.current : null,
              now,
            ),
            Boolean(startedAt),
          )}</span>
        </div>
        <p>{readOnly ? 'Shared read-only note' : savePending ? 'Saving…' : 'Saved to Rally'}</p>
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
            <p>{finalizing
              ? 'Saving the final transcript and creating your meeting summary'
              : recording
                ? paused
                  ? 'Audio capture paused'
                  : dictation.warning ? 'Listening to your microphone' : 'Listening to your microphone and computer audio'
                : 'Live meeting notes'}</p>
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
              <span><IconAirTrafficControl aria-hidden="true" size={17} /><h2 id="live-notes-heading">Control Tower</h2></span>
              <IconButton disabled={!notes || notesPending} label="Copy Control Tower" onClick={() => void copy(notes, 'note_summary')}>
                <Copy size={15} />
              </IconButton>
            </header>
            <div aria-live="polite" className="meeting-notes-body" ref={notesBodyRef}>
              {generatedAt && <p className="meeting-updated-at">Updated {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(generatedAt))}</p>}
              {notesError && <InlineError>{notesError}</InlineError>}
              {notes ? (
                <MarkdownBody>{notes}</MarkdownBody>
              ) : (
                <div className="meeting-empty-state">
                  <WandSparkles aria-hidden="true" size={24} />
                  <strong>Your live meeting briefing will appear here</strong>
                  <p>
                    Control Tower keeps you current{' '}
                    {meetingRefreshCadenceLabel(refreshIntervalMs ?? DEFAULT_MEETING_NOTES_INTERVAL_MS)},
                    then creates a complete summary when recording ends.
                  </p>
                </div>
              )}
              {notesPending && (
                <div className="meeting-summary-progress"><LoaderCircle className="spin" size={14} /> Updating Control Tower…</div>
              )}
            </div>
          </section>

          <section aria-labelledby="live-transcript-heading" className="meeting-transcript-card">
            <header>
              <span><IconWaveSine aria-hidden="true" size={18} /><h2 id="live-transcript-heading">Live transcript</h2></span>
              <IconButton disabled={!transcript} label="Copy transcript" onClick={() => void copy(transcript, 'note_transcript')}>
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
                  <p>Rally starts with your default microphone and adds computer audio when the platform allows it.</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      {(meetingRecordingAvailable || recording || finalizing || dictation.error || dictation.warning || permissionRecoveryTarget) && <footer className="meeting-controls">
        <div className="meeting-control-status">
          {dictation.error
            ? <span role="alert">{dictation.error}</span>
            : dictation.warning
              ? <span className="meeting-control-warning" role="status">{dictation.warning}</span>
              : <span>Uses your default microphone and computer audio</span>}
          {permissionRecoveryTarget && (
            <button className="meeting-permission-settings" onClick={() => void openPermissionSettings()} type="button">
              Open System Settings
            </button>
          )}
        </div>
        {meetingRecordingAvailable && (recording || finalizing ? (
          <div className="meeting-recording-actions">
            {!finalizing && (
              <Button
                className="meeting-pause-button"
                disabled={!['listening', 'paused'].includes(dictation.state)}
                onClick={() => void (paused ? resumeRecording() : pauseRecording()).catch(() => undefined)}
              >
                {paused ? <Play fill="currentColor" size={12} /> : <Pause fill="currentColor" size={12} />}
                {paused ? 'Resume' : 'Pause'}
              </Button>
            )}
            <Button className="meeting-stop-button" disabled={finalizing} onClick={() => void stopRecording().catch(() => undefined)}>
              {finalizing ? <LoaderCircle className="spin" size={14} /> : <Square fill="currentColor" size={12} />}
              {finalizing ? 'Finalizing…' : 'End'}
            </Button>
          </div>
        ) : (
          <Button
            className="meeting-start-button"
            disabled={loading || !note || readOnly || finalizing || permissionPreparing || ['requesting', 'connecting', 'transcribing', 'finalizing'].includes(dictation.state)}
            onClick={() => void startRecording()}
          >
            <span aria-hidden="true" className="meeting-start-dot" /> {permissionRecoveryTarget ? 'Retry recording' : 'Start recording'}
          </Button>
        ))}
        <span aria-hidden="true" />
      </footer>}

      <Modal
        description="Closing this window ends the meeting. Rally saves the last of the transcript and writes the final summary before it goes."
        footer={(
          <>
            <Button onClick={() => setCloseConfirmationOpen(false)}>Keep recording</Button>
            <Button
              className="button-primary"
              onClick={() => {
                setCloseConfirmationOpen(false);
                finalizeAndClose();
              }}
            >
              <Square fill="currentColor" size={12} />
              End and close
            </Button>
          </>
        )}
        onOpenChange={(open) => setCloseConfirmationOpen(open)}
        open={closeConfirmationOpen}
        title="This meeting is still recording"
      />
    </div>
  );
}
