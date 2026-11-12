import {
  IconCheck,
  IconCopy,
  IconLock,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { WorkspaceMember } from "../lib/types";
import { ARTIFACT_VISIBILITY_OPTIONS, CANVAS_VISIBILITY_OPTIONS } from "../lib/canvas-sharing";
import {
  Avatar,
  Badge,
  Button,
  ErrorNotice,
  IconButton,
  Modal,
} from "./primitives";
import { SidebarSearch } from "./sidebar-search";
import "./canvas-sharing-dialog.css";

type EditorAudience = "creator" | "participants" | "workspace";
type ArtifactAudience = "editors" | "participants" | "workspace" | "public";

/** Form state adapted to the shared Canvas audience contract by the host. */
export interface CanvasSharingSelection {
  editors: EditorAudience;
  editorIds: string[];
  artifacts: ArtifactAudience;
  artifactUserIds: string[];
}

interface CanvasSharingDialogProps {
  open: boolean;
  title: string;
  owner: WorkspaceMember;
  members: WorkspaceMember[];
  initialSelection: CanvasSharingSelection;
  artifactLink?: string;
  artifactLinkStatus?: "pending" | "error";
  onRetryArtifactLink?: () => void;
  onOpenChange: (open: boolean) => void;
  onSave: (selection: CanvasSharingSelection) => Promise<void> | void;
  currentUserId?: string;
  editorExtras?: ReactNode;
  editorNote?: string;
  beforeEditors?: ReactNode;
  saveFailure?: "save" | "changed" | "invitations" | "emails";
  onCopyLink: () => Promise<void>;
}

const EDITOR_OPTIONS = [
  { value: "creator", ...CANVAS_VISIBILITY_OPTIONS.creator, label: "Only you" },
  { value: "participants", ...CANVAS_VISIBILITY_OPTIONS.participants },
  { value: "workspace", ...CANVAS_VISIBILITY_OPTIONS.workspace },
] as const;
const ARTIFACT_OPTIONS = (["editors", "participants", "workspace", "public"] as const)
  .map((value) => ({ value, ...ARTIFACT_VISIBILITY_OPTIONS[value] }));

function AudienceTiles<T extends string>({
  title,
  description,
  icon: Icon,
  options,
  value,
  onChange,
  publicOptions = false,
  disabled = false,
}: {
  title: string;
  description: string;
  icon: typeof IconLock;
  options: readonly { value: T; label: string; icon: typeof IconLock }[];
  value: T;
  onChange: (value: T) => void;
  publicOptions?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const id = useId();
  return (
    <fieldset
      disabled={disabled}
      className="canvas-share-audience canvas-sharing-audience"
      aria-describedby={`${id}-description`}
    >
      <legend className="canvas-sharing-heading">
        <Icon aria-hidden="true" size={20} stroke={1.6} />
        {title}
      </legend>
      <p className="canvas-sharing-description" id={`${id}-description`}>
        {description}
      </p>
      <div
        className={`canvas-share-options${publicOptions ? " canvas-sharing-use-options" : ""}`}
      >
        {options.map(({ value: option, label, icon: OptionIcon }) => (
          <label className="action-tile canvas-share-option" key={option}>
            <input
              className="sr-only"
              type="radio"
              name={id}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <OptionIcon aria-hidden="true" size={24} stroke={1.6} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AudiencePeople({
  owner,
  members,
  chosen,
  onChange,
  label,
  includedIds = [],
  currentUserId = owner.id,
  disabled = false,
}: {
  owner: WorkspaceMember;
  members: WorkspaceMember[];
  chosen: string[];
  onChange: (ids: string[]) => void;
  label: string;
  includedIds?: string[];
  currentUserId?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const statusId = useId();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const selected = members.filter(
    (person) =>
      chosen.includes(person.id) &&
      person.id !== owner.id &&
      !includedIds.includes(person.id),
  );
  const needle = search.trim().toLocaleLowerCase();
  const candidates = members.filter(
    (person) =>
      person.id !== owner.id &&
      person.id !== currentUserId &&
      `${person.name} ${person.email}`.toLocaleLowerCase().includes(needle),
  );
  return (
    <div className="canvas-sharing-people" role="group" aria-label={label}>
      <div className="canvas-sharing-chips">
        <span className="canvas-sharing-person">
          <Avatar member={owner} size="small" />
          <span>{currentUserId === owner.id ? "You" : owner.name}</span>
          <Badge>Creator</Badge>
        </span>
        {selected.map((person) => (
          <span className="canvas-sharing-person" key={person.id}>
            <Avatar member={person} size="small" />
            <span>{person.name}</span>
            <IconButton
              label={`Remove ${person.name}`}
              disabled={disabled}
              showTooltip={false}
              onClick={() => onChange(chosen.filter((id) => id !== person.id))}
            >
              <IconX size={14} />
            </IconButton>
          </span>
        ))}
        <Button
          disabled={disabled}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <IconPlus aria-hidden="true" size={16} />
          Add people
        </Button>
      </div>
      {expanded && (
        <div className="canvas-share-people canvas-sharing-picker">
          <SidebarSearch
            mode="input"
            aria-label="Search people"
            placeholder="Search by name or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="member-action-list">
            {candidates.map((person) => (
              <label className="member-action-row" key={person.id}>
                <Avatar member={person} />
                <span>
                  <strong>{person.name}</strong>
                  <small>{person.email}</small>
                </span>
                {person.accessClass === "guest" && <Badge>Guest</Badge>}
                {person.status !== undefined && person.status !== "active" && (
                  <Badge id={`${statusId}-${person.id}`}>
                    {person.status === "invited"
                      ? "Invitation pending"
                      : "Suspended"}
                  </Badge>
                )}
                <input
                  className="choice-control"
                  type="checkbox"
                  disabled={
                    disabled ||
                    includedIds.includes(person.id) ||
                    (person.status !== undefined && person.status !== "active")
                  }
                  aria-label={person.name}
                  aria-describedby={
                    person.status !== undefined && person.status !== "active"
                      ? `${statusId}-${person.id}`
                      : undefined
                  }
                  checked={
                    (person.status === undefined ||
                      person.status === "active") &&
                    (includedIds.includes(person.id) ||
                      chosen.includes(person.id))
                  }
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...chosen, person.id]
                        : chosen.filter((id) => id !== person.id),
                    )
                  }
                />
              </label>
            ))}
            {candidates.length === 0 && (
              <p className="canvas-share-note">No people found.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Shared two-audience modal; the host supplies persistence and clipboard behavior. */
export function CanvasSharingDialog({
  open,
  title,
  onOpenChange,
  ...props
}: CanvasSharingDialogProps): React.JSX.Element {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Share Canvas"
      description={title}
    >
      {open && <CanvasSharingForm {...props} onOpenChange={onOpenChange} />}
    </Modal>
  );
}

function CanvasSharingForm({
  owner,
  members,
  initialSelection,
  artifactLink,
  artifactLinkStatus,
  onRetryArtifactLink,
  onOpenChange,
  onSave,
  onCopyLink,
  currentUserId = owner.id,
  editorExtras,
  editorNote,
  beforeEditors,
  saveFailure = "save",
}: Omit<CanvasSharingDialogProps, "open" | "title">): React.JSX.Element {
  const [selection, setSelection] = useState(initialSelection);
  const observed = useRef(initialSelection);
  useEffect(() => {
    const previous = observed.current;
    if (JSON.stringify(previous) === JSON.stringify(initialSelection)) return;
    observed.current = initialSelection;
    const merge = (current: string[], before: string[], after: string[]) => [
      ...new Set([
        ...current.filter((id) => !before.includes(id) || after.includes(id)),
        ...after.filter((id) => !before.includes(id)),
      ]),
    ];
    setSelection((current) => ({
      ...current,
      editors:
        initialSelection.editors !== previous.editors
          ? initialSelection.editors
          : current.editors,
      editorIds: merge(
        current.editorIds,
        previous.editorIds,
        initialSelection.editorIds,
      ),
      artifacts:
        initialSelection.artifacts !== previous.artifacts
          ? initialSelection.artifacts
          : current.artifacts,
      artifactUserIds: merge(
        current.artifactUserIds,
        previous.artifactUserIds,
        initialSelection.artifactUserIds,
      ),
    }));
  }, [initialSelection]);
  const [saving, setSaving] = useState(false);
  const [saveAttempt, setSaveAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFailure, setCopyFailure] = useState(0);
  const editorIds =
    selection.editors === "creator"
      ? []
      : selection.editors === "workspace"
        ? [
            ...members
              .filter((person) => person.accessClass !== "guest")
              .map((person) => person.id),
            ...selection.editorIds,
          ]
        : selection.editorIds;
  const editors = new Set([owner.id, ...editorIds]).size;
  const artifactSummary = {
    editors: "Editors only",
    participants: "Selected artifact users",
    workspace: "Organization access",
    public: "Public artifacts",
  }[selection.artifacts];
  const missingEditors =
    selection.editors === "participants" &&
    selection.editorIds.filter((id) => id !== owner.id).length === 0;
  const missingUsers =
    selection.artifacts === "participants" &&
    selection.artifactUserIds.length === 0;
  return (
    <form
      className="canvas-sharing-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving || missingEditors || missingUsers) return;
        setSaving(true);
        try {
          await onSave({
            ...selection,
            editorIds:
              selection.editors === "creator" ? [] : selection.editorIds,
            artifactUserIds:
              selection.artifacts === "participants" ||
              selection.artifacts === "workspace"
                ? selection.artifactUserIds
                : [],
          });
        } catch {
          setSaveAttempt((attempt) => attempt + 1);
        } finally {
          setSaving(false);
        }
      }}
    >
      {beforeEditors}
      <section className="canvas-sharing-section">
        <AudienceTiles
          title="Who can edit"
          description="Read the chat and ask Rally to change artifacts."
          icon={IconPencil}
          options={EDITOR_OPTIONS.map((option) =>
            option.value === "creator" && currentUserId !== owner.id
              ? { ...option, label: "Only the creator" }
              : option,
          )}
          disabled={saving}
          value={selection.editors}
          onChange={(value) => setSelection({ ...selection, editors: value })}
        />
        {selection.editors !== "creator" && (
          <AudiencePeople
            includedIds={
              selection.editors === "workspace"
                ? members
                    .filter((person) => person.accessClass !== "guest")
                    .map((person) => person.id)
                : []
            }
            currentUserId={currentUserId}
            disabled={saving}
            owner={owner}
            members={members}
            chosen={selection.editorIds}
            label="Editors"
            onChange={(editorIds) => setSelection({ ...selection, editorIds })}
          />
        )}
        <p className="canvas-share-note">
          {missingEditors
            ? "Choose at least one other editor."
            : "Editors can also use all artifacts."}
        </p>
        {editorNote && <p className="canvas-share-note">{editorNote}</p>}
        {editorExtras}
      </section>
      <section className="canvas-sharing-section">
        <AudienceTiles
          title="Who can interact with artifacts"
          description="Open and use the published artifacts in this Canvas."
          icon={IconWorld}
          options={ARTIFACT_OPTIONS}
          disabled={saving}
          value={selection.artifacts}
          onChange={(value) => setSelection({ ...selection, artifacts: value })}
          publicOptions
        />
        {(selection.artifacts === "participants" ||
          selection.artifacts === "workspace") && (
          <AudiencePeople
            currentUserId={currentUserId}
            disabled={saving}
            owner={owner}
            members={members}
            chosen={selection.artifactUserIds}
            includedIds={
              selection.artifacts === "workspace"
                ? members
                    .filter((person) => person.accessClass !== "guest")
                    .map((person) => person.id)
                : []
            }
            label="Artifact users"
            onChange={(artifactUserIds) =>
              setSelection({ ...selection, artifactUserIds })
            }
          />
        )}
        {selection.artifacts === "participants" && (
          <p className="canvas-share-note">
            {missingUsers
              ? "Choose at least one person. Editors already have access."
              : "Selected people and all editors can use the artifacts."}
          </p>
        )}
        <p className="canvas-sharing-privacy">
          <IconLock aria-hidden="true" size={16} stroke={1.6} />
          <span>The conversation is only visible to editors.</span>
        </p>
        {(artifactLink || artifactLinkStatus) && (
          <div className="canvas-sharing-link">
            <label htmlFor="canvas-sharing-link">Artifact link</label>
            <div className="canvas-sharing-link-control">
              <input
                id="canvas-sharing-link"
                value={artifactLink ?? ""}
                placeholder={artifactLinkStatus === "pending" ? "Getting artifact link…" : "Artifact link unavailable"}
                readOnly
              />
              <Button
                disabled={!artifactLink && artifactLinkStatus === "pending"}
                onClick={() => {
                  if (!artifactLink) {
                    onRetryArtifactLink?.();
                    return;
                  }
                  void onCopyLink().then(
                    () => setCopied(true),
                    () => setCopyFailure((attempt) => attempt + 1),
                  );
                }}
              >
                {!artifactLink ? (
                  <IconRefresh aria-hidden="true" size={16} />
                ) : copied ? (
                  <IconCheck aria-hidden="true" size={16} />
                ) : (
                  <IconCopy aria-hidden="true" size={16} />
                )}
                {!artifactLink
                  ? artifactLinkStatus === "pending" ? "Getting link…" : "Retry link"
                  : copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          </div>
        )}
      </section>
      {artifactLinkStatus === "error" && (
        <ErrorNotice title="Artifact link couldn’t be loaded">
          The artifact may still be publishing. Use Retry link to try again.
        </ErrorNotice>
      )}
      {saveAttempt > 0 && (
        <ErrorNotice occurrence={saveAttempt} title="Sharing couldn’t be saved">
          {saveFailure === "changed"
            ? "Sharing changed while this window was open. Close it and reopen it before saving."
            : saveFailure === "invitations"
              ? "Sharing was saved, but the guests couldn’t be invited. Try again."
              : saveFailure === "emails"
                ? "Enter valid email addresses, separated by spaces, commas, or semicolons."
                : "Sharing couldn’t be saved. Try again."}
        </ErrorNotice>
      )}
      {copyFailure > 0 && (
        <ErrorNotice occurrence={copyFailure} title="Link couldn’t be copied">
          Select the artifact link and copy it, or try Copy link again.
        </ErrorNotice>
      )}
      <footer className="canvas-sharing-footer">
        <span className="canvas-share-note" role="status">
          {editors} {editors === 1 ? "editor" : "editors"} · {artifactSummary}
        </span>
        <div className="canvas-share-actions">
          <Button disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="button-primary"
            type="submit"
            disabled={saving || missingEditors || missingUsers}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </footer>
    </form>
  );
}
