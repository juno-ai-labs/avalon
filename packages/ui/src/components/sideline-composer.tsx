import { ErrorNotice } from './primitives';
import {
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_TOO_LONG_MESSAGE,
  type SidelineCatalog,
  type SidelineDestination,
} from "@rally/contracts";
import { useMemo, useState } from "react";
import { Plus, RefreshCw, Search, Send, Trash2 } from "lucide-react";

export type SidelineCardState = "idle" | "sending" | "sent" | "failed" | "unknown";

export interface SidelineCardModel {
  id: string;
  idempotencyKey: string;
  representedUserId: string;
  workstreamId: string;
  substreamId: string;
  message: string;
  state: SidelineCardState;
  result?: string;
  /**
   * The names the card chose under, kept so a notice can say what went away
   * when a refreshed catalog no longer lists the choice.
   */
  representedName?: string;
  destinationLabel?: string;
}

export interface SearchSelectOption {
  value: string;
  label: string;
  group?: string;
}

/** Browser-safe searchable choice primitive shared by compact Rally hosts. */
export function SearchSelect(props: {
  label: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  options: SearchSelectOption[];
  onChange: (value: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? props.options.filter((option) => (
          option.value === props.value
          || `${option.group ?? ""} ${option.label}`.toLocaleLowerCase().includes(needle)
        ))
      : props.options;
  }, [props.options, props.value, query]);
  const groups = [...new Set(options.map((option) => option.group).filter((group): group is string => Boolean(group)))];
  const ungrouped = options.filter((option) => !option.group);
  return (
    <label>
      <span>{props.label}</span>
      <span className="sideline-search-field">
        <Search aria-hidden="true" size={14} />
        <input
          type="search"
          aria-label={`Search ${props.label}`}
          value={query}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
      </span>
      <select
        aria-label={props.label}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="">Select…</option>
        {ungrouped.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        {groups.map((group) => (
          <optgroup key={group} label={group}>
            {options.filter((option) => option.group === group).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function destinationKey(destination: Pick<SidelineDestination, "workstreamId" | "substreamId">): string {
  return `${destination.workstreamId}:${destination.substreamId}`;
}

export function SidelineComposer(props: {
  catalog: SidelineCatalog | null;
  workspaceName: string;
  operatorName: string;
  cards: SidelineCardModel[];
  status: "loading" | "ready" | "empty" | "denied" | "offline" | "error";
  statusMessage?: string;
  onAdd: () => void;
  onRemove: (cardId: string) => void;
  onChange: (cardId: string, patch: Partial<SidelineCardModel>) => void;
  onSend: (cardId: string) => void;
  onRetryCatalog: () => void;
  onOpenInRally: (cardId: string) => void;
}): React.JSX.Element {
  const catalogReady = props.status === "ready";
  return (
    <main className="sideline-shell">
      <header className="sideline-header">
        <div>
          <div className="sideline-kicker">Sideline</div>
          <h1>{props.catalog?.workspace.name ?? props.workspaceName}</h1>
          <p>{`Signed in as ${props.catalog?.operator.name ?? props.operatorName}`}</p>
        </div>
        <div className="sideline-header-actions">
          <span className="sideline-marker">Messaging</span>
          <span className="sideline-audit-copy">Sending as another participant is audited.</span>
        </div>
      </header>

      {props.status !== "ready" && (
        <section className={`sideline-notice sideline-notice-${props.status}`} role="status">
          <span>{props.statusMessage ?? (props.status === "loading" ? "Loading eligible participants…" : "Sideline is unavailable.")}</span>
          {(props.status === "error" || props.status === "offline") && (
            <button className="button button-secondary" type="button" onClick={props.onRetryCatalog}>
              <RefreshCw size={15} /> Retry
            </button>
          )}
        </section>
      )}

      <section className="sideline-cards" aria-label="Messages">
        {props.cards.map((card, index) => {
          const participant = props.catalog?.participants.find((item) => item.userId === card.representedUserId);
          const destinations = participant?.destinations ?? [];
          const selectedDestination = destinations.find((item) => (
            item.workstreamId === card.workstreamId && item.substreamId === card.substreamId
          ));
          const messageTooLong = card.message.length > MESSAGE_MAX_CHARACTERS;
          // A refreshed catalog can drop a choice this card already made: the
          // participant left a Channel or Breakout, or stopped being one this
          // operator may act as. Keep the choice and say why it cannot send; the
          // notice arrives after a background read, so it is a live status.
          const unsent = card.state !== "sent";
          const participantGone = unsent && Boolean(props.catalog && card.representedUserId && !participant);
          const destinationGone = unsent && Boolean(participant && card.workstreamId && !selectedDestination);
          const noticeId = participantGone || destinationGone ? `${card.id}-gone` : undefined;
          const representedName = participant?.name ?? card.representedName ?? "This participant";
          const destinationLabel = selectedDestination?.label ?? card.destinationLabel;
          const canSend = catalogReady && card.state !== "sending" && Boolean(
            participant && selectedDestination && card.message.trim() && !messageTooLong,
          );
          return (
            <article className="sideline-card" key={card.id}>
              <div className="sideline-card-heading">
                <h2>Message {index + 1}</h2>
                {props.cards.length > 1 && (
                  <button className="sideline-icon-button" type="button" aria-label={`Remove message ${index + 1}`} onClick={() => props.onRemove(card.id)}>
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              <div className="sideline-fields">
                <SearchSelect
                  label="Participant"
                  value={card.representedUserId}
                  placeholder="Search participants…"
                  disabled={!catalogReady || card.state === "sending"}
                  options={props.catalog?.participants.map((item) => ({ value: item.userId, label: item.name })) ?? []}
                  onChange={(value) => props.onChange(card.id, {
                      representedUserId: value,
                      representedName: props.catalog?.participants.find((item) => item.userId === value)?.name,
                      workstreamId: "",
                      substreamId: "0",
                      destinationLabel: undefined,
                      state: "idle",
                      result: undefined,
                    })}
                />
                {participantGone && (
                  <p id={noticeId} className="sideline-field-message sideline-field-message-warning" role="status">
                    {`You can no longer send as ${representedName}. Choose another participant.`}
                  </p>
                )}
                <SearchSelect
                  label="Destination"
                  value={card.workstreamId ? `${card.workstreamId}:${card.substreamId}` : ""}
                  placeholder="Search destinations…"
                  disabled={!catalogReady || !participant || card.state === "sending"}
                  options={destinations.map((item) => ({
                    value: destinationKey(item),
                    label: item.label,
                    group: item.workstreamLabel,
                  }))}
                  onChange={(value) => {
                      const destination = destinations.find((item) => destinationKey(item) === value);
                      props.onChange(card.id, destination ? {
                        workstreamId: destination.workstreamId,
                        substreamId: destination.substreamId,
                        destinationLabel: destination.label,
                        state: "idle",
                        result: undefined,
                      } : { workstreamId: "", substreamId: "0", destinationLabel: undefined });
                    }}
                />
                {destinationGone && (
                  <p id={noticeId} className="sideline-field-message sideline-field-message-warning" role="status">
                    {`${representedName} is no longer in ${destinationLabel ?? "this destination"}. Choose another destination.`}
                  </p>
                )}
                {participant && destinations.length === 0 && !destinationGone && (
                  <p className="sideline-field-message sideline-field-message-warning">
                    This participant has no eligible destination.
                  </p>
                )}
                <label className="sideline-message-field">
                  <span>Message</span>
                  <textarea
                    rows={5}
                    value={card.message}
                    disabled={card.state === "sending"}
                    placeholder="Write a message"
                    onChange={(event) => props.onChange(card.id, { message: event.target.value, state: "idle", result: undefined })}
                  />
                </label>
                {messageTooLong && (
                  <ErrorNotice>{MESSAGE_TOO_LONG_MESSAGE}</ErrorNotice>
                )}
              </div>
              <div className="sideline-summary">
                Sending as <strong>{participant?.name ?? card.representedName ?? "participant"}</strong> to <strong>{destinationLabel ?? "destination"}</strong>
              </div>
              <div className="sideline-card-footer">
                <div className={`sideline-result sideline-result-${card.state}`} aria-live="polite">
                  {card.state === "sending" ? "Sending…" : card.result}
                </div>
                <div className="sideline-card-actions">
                  {card.state === "sent" && (
                    <button className="button button-secondary" type="button" onClick={() => props.onOpenInRally(card.id)}>Open in Rally</button>
                  )}
                  <button className="button button-primary" type="button" disabled={!canSend} aria-describedby={noticeId} onClick={() => props.onSend(card.id)}>
                    <Send size={15} /> Send
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </section>
      <button className="button button-secondary sideline-add" type="button" onClick={props.onAdd}>
        <Plus size={16} /> Add card
      </button>
    </main>
  );
}
