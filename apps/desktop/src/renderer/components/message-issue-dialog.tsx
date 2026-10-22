import type { CreateMessageIssue, MessageIssueTarget } from '@rally/contracts/message-issues';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { createPortal } from 'react-dom';
import type { RallyApi } from '../lib/api';
import { ComposerInput } from './composer-input';
import { Button, Modal } from './primitives';

const MessageIssueContext = createContext<((messageId: string, blockId?: string) => void) | null>(null);
export const useReportMessageIssue = () => useContext(MessageIssueContext);

type IssueApi = Pick<RallyApi, 'createMessageIssue' | 'getTranscriptionSocketTicket' | 'prefetchTranscriptionSocketTicket'>;

/** One dialog per feed, outside virtualized rows so scrolling cannot discard a report. */
export function MessageIssueProvider({ api, target, children }: PropsWithChildren<{
  api: IssueApi | null | undefined;
  target: MessageIssueTarget;
}>): React.JSX.Element {
  const targetKey = JSON.stringify(target);
  const [report, setReport] = useState<Omit<CreateMessageIssue, 'description'> | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  // A streaming feed rerenders often; a stable context callback keeps every
  // settled message from rerendering just because a new token arrived.
  const openReport = useCallback((messageId: string, blockId?: string) => setReport({
    id: crypto.randomUUID(), target: targetRef.current, messageId, ...(blockId ? { blockId } : {}),
  }), []);
  useEffect(() => setReport(null), [targetKey]);
  return <MessageIssueContext.Provider value={api ? openReport : null}>
    {children}
    {api && report && <MessageIssueDialog api={api} key={report.id} onClose={() => setReport(null)} report={report} />}
  </MessageIssueContext.Provider>;
}

export function MessageIssueDialog({ api, report, onClose }: {
  api: IssueApi;
  report: Omit<CreateMessageIssue, 'description'>;
  onClose: () => void;
}): React.JSX.Element {
  const [description, setDescription] = useState('');
  const [submitContainer, setSubmitContainer] = useState<HTMLSpanElement | null>(null);
  const submitted = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submit = (): void => {
    const text = description.trim();
    if (!text || submitted.current) return;
    submitted.current = true;
    // Reporting is best effort: delivery never holds the conversation open.
    void api.createMessageIssue({ ...report, description: text }).catch(() => undefined);
    onClose();
  };
  return <Modal
    restoreFocus
    description="Let us know what you expected so we can improve Rally."
    footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <span ref={setSubmitContainer} />
    </>}
    onOpenChange={(open) => { if (!open) onClose(); }}
    open
    title="Something go wrong?"
  >
    <div className="has-message-capsule">
      <ComposerInput
        api={api}
        ariaLabel="Describe the issue"
        attachments={[]}
        autoFocus
        fileInputRef={fileInputRef}
        layout="message-capsule"
        onOpenAttachment={() => undefined}
        onRemoveAttachment={() => undefined}
        onRetryAttachment={() => undefined}
        onSubmit={submit}
        onValueChange={setDescription}
        placeholder="What happened, and what did you expect?"
        shouldSubmitOnEnter={() => false}
        renderSubmit={({ disabled, pending, onClick }) => submitContainer && createPortal(
          <Button aria-busy={pending || undefined} className="button-primary" disabled={disabled} onClick={onClick}>Send</Button>,
          submitContainer,
        )}
        submitDisabled={!description.trim()}
        submitLabel="Send"
        uploading={false}
        value={description}
      />
    </div>
  </Modal>;
}
