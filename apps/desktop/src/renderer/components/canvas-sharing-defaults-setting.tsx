import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_CANVAS_SHARING_DEFAULTS,
  type CanvasDefaultArtifactAudience,
  type CanvasDefaultEditorAudience,
  type CanvasSharingDefaults,
  type CanvasSharingDefaultsUpdate,
} from '@rally/contracts/canvases';
import type { RallyApi } from '../lib/api';
import { SettingCopy } from '../settings/setting-label';
import { settings } from '../settings/registry';
import { DropdownSelect, ErrorNotice } from './primitives';

const EDITOR_CHOICES: { value: CanvasDefaultEditorAudience; label: string }[] = [
  { value: 'creator', label: 'Creator' },
  { value: 'workspace', label: 'Everyone in the Organization' },
];
const ARTIFACT_CHOICES: { value: CanvasDefaultArtifactAudience; label: string }[] = [
  { value: 'editors', label: 'Editors only' },
  { value: 'workspace', label: 'Everyone in the Organization' },
  { value: 'public', label: 'Anyone with a link' },
];

export function canvasSharingDefaultsQueryKey(workspaceId: string) {
  return ['workspace', workspaceId, 'canvas-sharing-defaults'] as const;
}

export type CanvasSharingDefaultsApi = Pick<RallyApi, 'getCanvasSharingDefaults' | 'updateCanvasSharingDefaults'>;

/**
 * **Default Editor Audience** and **Default Artifact Audience** under
 * Organization preferences: who a new Canvas opens to, and who Rally will
 * suggest can use its artifacts. Every member sees them; only an
 * administrator changes them. Each dropdown saves its own field.
 */
export function CanvasSharingDefaultsSetting({ api, workspaceId, isAdmin }: {
  api: CanvasSharingDefaultsApi | null;
  workspaceId: string;
  isAdmin: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const key = canvasSharingDefaultsQueryKey(workspaceId);
  const defaults = useQuery({ queryKey: key, queryFn: ({ signal }) => api!.getCanvasSharingDefaults(signal), enabled: Boolean(api) });
  const save = useMutation({
    mutationFn: (update: CanvasSharingDefaultsUpdate) => api!.updateCanvasSharingDefaults(update),
    // Show the choice at once; the answer is the stored record either way.
    onMutate: (update) => {
      const previous = queryClient.getQueryData<CanvasSharingDefaults>(key);
      queryClient.setQueryData<CanvasSharingDefaults>(key, { ...(previous ?? DEFAULT_CANVAS_SHARING_DEFAULTS), ...update });
      return { previous };
    },
    onError: (_error, _update, context) => queryClient.setQueryData(key, context?.previous),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });
  const current = defaults.data ?? DEFAULT_CANVAS_SHARING_DEFAULTS;
  const disabled = !isAdmin || !api || !defaults.data;
  return <>
    <label className="settings-preference-row">
      <SettingCopy setting={settings.canvasEditorDefault} />
      <DropdownSelect
        ariaLabel={settings.canvasEditorDefault.label}
        disabled={disabled}
        onValueChange={(value) => save.mutate({ editors: value as CanvasDefaultEditorAudience })}
        options={EDITOR_CHOICES}
        value={current.editors}
        variant="secondary"
      />
    </label>
    <label className="settings-preference-row">
      <SettingCopy setting={settings.canvasArtifactDefault} />
      <DropdownSelect
        ariaLabel={settings.canvasArtifactDefault.label}
        disabled={disabled}
        onValueChange={(value) => save.mutate({ artifacts: value as CanvasDefaultArtifactAudience })}
        options={ARTIFACT_CHOICES}
        value={current.artifacts}
        variant="secondary"
      />
    </label>
    {defaults.error && <ErrorNotice occurrence={defaults.error}>{defaults.error.message}</ErrorNotice>}
    {save.error && <ErrorNotice occurrence={save.error}>{save.error.message}</ErrorNotice>}
  </>;
}
