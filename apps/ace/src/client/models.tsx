import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AgentModelRoutingSchema,
  MANAGED_MODELS,
  MODEL_CHOICES,
  ManagedModelUpdateSchema,
  type AgentModelRouting,
  type ManagedModelRole,
} from '../protocol';
import { Button, EmptyState, Field, Panel, StatusDot } from './components/ui';

interface FlagshipModelFlag {
  key?: string;
  enabled?: boolean;
  default_variation?: string;
  variations?: Record<string, unknown>;
}

interface ModelConfiguration {
  role: ManagedModelRole;
  routing: AgentModelRouting;
  persistedRouting: AgentModelRouting;
  source: 'flagship' | 'checked-in';
}

type ValidationState =
  | { status: 'incomplete' | 'checking' | 'valid' | 'unavailable'; invalidModelIds: string[] }
  | { status: 'invalid'; invalidModelIds: string[] };

async function responseBody<Result>(response: Response): Promise<Result> {
  const body = await response.json().catch(() => null) as (Result & { error?: string; message?: string }) | null;
  if (!response.ok || body === null) {
    throw new Error(body?.message ?? body?.error ?? `Request failed (${response.status})`);
  }
  return body;
}

function checkedInConfigurations(): ModelConfiguration[] {
  return MANAGED_MODELS.map((definition) => ({
    role: definition.role,
    routing: {
      model: definition.defaultRouting.model,
      fallbackModels: [...definition.defaultRouting.fallbackModels],
    },
    persistedRouting: {
      model: definition.defaultRouting.model,
      fallbackModels: [...definition.defaultRouting.fallbackModels],
    },
    source: 'checked-in',
  }));
}

export function routingFromFlag(flag: FlagshipModelFlag | undefined, role: ManagedModelRole): ModelConfiguration {
  const definition = MANAGED_MODELS.find((candidate) => candidate.role === role)!;
  const variation = flag?.default_variation
    ? flag.variations?.[flag.default_variation]
    : undefined;
  const parsed = AgentModelRoutingSchema.safeParse(variation);
  const routing = parsed.success ? parsed.data : {
    model: definition.defaultRouting.model,
    fallbackModels: [...definition.defaultRouting.fallbackModels],
  };
  return {
    role,
    routing,
    persistedRouting: {
      model: routing.model,
      fallbackModels: [...routing.fallbackModels],
    },
    source: parsed.success ? 'flagship' : 'checked-in',
  };
}

export function moveFallback(models: string[], index: number, delta: number): string[] {
  const target = index + delta;
  if (target < 0 || target >= models.length) return models;
  const next = models.slice();
  const [model] = next.splice(index, 1);
  next.splice(target, 0, model!);
  return next;
}

export function ModelsView(): React.JSX.Element {
  const [configurations, setConfigurations] = useState<ModelConfiguration[]>(checkedInConfigurations);
  const [selectedRole, setSelectedRole] = useState<ManagedModelRole>('workstream');
  const [connected, setConnected] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [statusIsError, setStatusIsError] = useState(false);
  const [validation, setValidation] = useState<ValidationState>({
    status: 'checking',
    invalidModelIds: [],
  });

  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setStatus(''); setStatusIsError(false);
    try {
      const body = await responseBody<{ flags?: FlagshipModelFlag[] }>(await fetch('/api/models'));
      const byKey = new Map((body.flags ?? []).map((flag) => [flag.key, flag]));
      setConfigurations(MANAGED_MODELS.map((definition) => routingFromFlag(byKey.get(definition.key), definition.role)));
      setConnected(true);
    } catch (error) {
      setConnected(false);
      setStatusIsError(true);
      setStatus(error instanceof Error ? error.message : 'Model routing is unavailable.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const definition = MANAGED_MODELS.find((candidate) => candidate.role === selectedRole)!;
  const selected = configurations.find((candidate) => candidate.role === selectedRole)
    ?? routingFromFlag(undefined, selectedRole);
  const updateRouting = (routing: AgentModelRouting): void => {
    setStatus('');
    setStatusIsError(false);
    setConfigurations((current) => current.map((configuration) => (
      configuration.role === selectedRole ? { ...configuration, routing } : configuration
    )));
  };
  const suggestedModels = useMemo(() => Array.from(new Set([
    ...MODEL_CHOICES,
    ...configurations.flatMap((configuration) => [configuration.routing.model, ...configuration.routing.fallbackModels]),
  ])), [configurations]);
  const validationFingerprint = JSON.stringify([
    selectedRole,
    selected.routing.model,
    ...selected.routing.fallbackModels,
  ]);
  const routeIsDirty = JSON.stringify(selected.routing) !== JSON.stringify(selected.persistedRouting);
  const invalidModelIds = new Set(validation.invalidModelIds);

  useEffect(() => {
    const [, ...modelIds] = JSON.parse(validationFingerprint) as string[];
    if (modelIds.some((modelId) => modelId.trim().length === 0)) {
      setValidation({ status: 'incomplete', invalidModelIds: [] });
      return undefined;
    }

    const controller = new AbortController();
    setValidation({ status: 'checking', invalidModelIds: [] });
    const timeout = window.setTimeout(() => {
      void fetch('/api/models/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds }),
        signal: controller.signal,
      }).then((response) => responseBody<{ models: Array<{ modelId: string; valid: boolean }> }>(response))
        .then((body) => {
          const invalid = body.models.filter((model) => !model.valid).map((model) => model.modelId);
          setValidation({ status: invalid.length === 0 ? 'valid' : 'invalid', invalidModelIds: invalid });
        }).catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setValidation({ status: 'unavailable', invalidModelIds: [] });
        });
    }, 400);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [validationFingerprint]);

  const save = async (): Promise<void> => {
    if (connected !== true) {
      setStatusIsError(true);
      setStatus('Flagship is unavailable. Reload before making changes.');
      return;
    }
    const parsed = ManagedModelUpdateSchema.safeParse({ role: selectedRole, routing: selected.routing });
    if (!parsed.success) {
      setStatusIsError(true);
      setStatus('Choose a primary model and complete or remove every fallback model.');
      return;
    }
    setSaving(true); setStatus(''); setStatusIsError(false);
    try {
      const body = await responseBody<{ flag?: FlagshipModelFlag }>(await fetch(`/api/models/${encodeURIComponent(selectedRole)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      }));
      const next = routingFromFlag(body.flag, selectedRole);
      setConfigurations((current) => current.map((configuration) => configuration.role === selectedRole
        ? {
            ...next,
            routing: parsed.data.routing,
            persistedRouting: parsed.data.routing,
            source: 'flagship',
          }
        : configuration));
      setStatus('Saved to Flagship. New runs will resolve this route on their next admission.');
    } catch (error) {
      setStatusIsError(true);
      setStatus(error instanceof Error ? error.message : 'Save failed.');
    } finally { setSaving(false); }
  };

  return <>
    <datalist id="ace-model-choices">{suggestedModels.map((model) => <option key={model} value={model} />)}</datalist>
    <aside className="model-list"><header><p>Agent routing</p><h1>Models</h1><small>{MANAGED_MODELS.length} model-using roles</small></header>
      <div className="models">
        {MANAGED_MODELS.map((model) => {
          const current = configurations.find((candidate) => candidate.role === model.role)!;
          const sourceLabel = current.source === 'flagship' ? 'Flagship default' : 'Checked-in fallback';
          return <button className={selectedRole === model.role ? 'selected' : ''} key={model.role} onClick={() => { setSelectedRole(model.role); setStatus(''); setStatusIsError(false); }} type="button">
            <StatusDot active={connected === true && current.source === 'flagship'} label={sourceLabel} />
            <div><strong><span className="model-rank-number">{model.rank}</span>{model.label}</strong><small className="model-rank-reason">{model.rankReason}</small><small>{current.routing.model} · {current.routing.fallbackModels.length} {current.routing.fallbackModels.length === 1 ? 'fallback' : 'fallbacks'}</small></div><b>›</b>
          </button>;
        })}
      </div>
      <footer><span className={connected === true ? 'healthy-dot' : 'status-dot'} />{loading ? 'Connecting to Flagship…' : connected ? 'Flagship connected' : 'Flagship unavailable'}</footer>
    </aside>
    <main className="model-editor"><header className="model-editor-header"><div><p>Model route</p><h2>{definition.label}</h2><code>{definition.key}</code></div><Button variant="primary" disabled={saving || !routeIsDirty || connected !== true || validation.status !== 'valid'} onClick={() => void save()} type="button">{saving ? 'Saving…' : 'Save route'}</Button></header>
      <section className="model-purpose"><div><h3>What this model does</h3><p>{definition.description}</p></div><span className={`route-source ${selected.source}`}>{selected.source === 'flagship' ? 'Flagship default' : 'Checked-in fallback'}</span></section>
      <section className="model-routing"><div className="section-title"><div><h3>Default route</h3><p>The primary model is tried first. Fallbacks are traversed in the order shown when Bind classifies a failure as routable.</p></div></div>
        <Panel className="model-route-card">
          <Field label="Primary model"><input aria-invalid={invalidModelIds.has(selected.routing.model) || selected.routing.model.trim().length === 0} list="ace-model-choices" onChange={(event) => updateRouting({ ...selected.routing, model: event.target.value })} placeholder="provider/model" spellCheck={false} value={selected.routing.model} /></Field>
          <small className="model-input-help">Choose a known model or enter any OpenRouter model ID.</small>
          <div className="fallback-heading"><div><h3>Fallback model array</h3><p>Ordered from first backup to last.</p></div><Button onClick={() => updateRouting({ ...selected.routing, fallbackModels: [...selected.routing.fallbackModels, ''] })} type="button">＋ Add fallback</Button></div>
          <div className="fallback-stack">
            {selected.routing.fallbackModels.map((model, index) => <div className="fallback-row" key={index}>
              <span className="fallback-number">{index + 1}</span>
              <input aria-invalid={invalidModelIds.has(model) || model.trim().length === 0} aria-label={`Fallback ${index + 1} model`} list="ace-model-choices" onChange={(event) => updateRouting({ ...selected.routing, fallbackModels: selected.routing.fallbackModels.map((candidate, candidateIndex) => candidateIndex === index ? event.target.value : candidate) })} placeholder="provider/model" spellCheck={false} value={model} />
              <div className="fallback-actions"><button aria-label={`Move fallback ${index + 1} up`} disabled={index === 0} onClick={() => updateRouting({ ...selected.routing, fallbackModels: moveFallback(selected.routing.fallbackModels, index, -1) })} type="button">↑</button><button aria-label={`Move fallback ${index + 1} down`} disabled={index === selected.routing.fallbackModels.length - 1} onClick={() => updateRouting({ ...selected.routing, fallbackModels: moveFallback(selected.routing.fallbackModels, index, 1) })} type="button">↓</button><button aria-label={`Remove fallback ${index + 1}`} className="remove" onClick={() => updateRouting({ ...selected.routing, fallbackModels: selected.routing.fallbackModels.filter((_, candidateIndex) => candidateIndex !== index) })} type="button">Remove</button></div>
            </div>)}
            {selected.routing.fallbackModels.length === 0 && <EmptyState title="No fallback models" description="This role stops after the primary model's route plan is exhausted." />}
          </div>
          <p className={`model-validation ${validation.status}`} role="status">{
            validation.status === 'checking' ? 'Checking this route against OpenRouter…'
              : validation.status === 'valid' ? 'All model IDs are available through OpenRouter.'
                : validation.status === 'invalid' ? `OpenRouter does not recognize or currently route: ${validation.invalidModelIds.join(', ')}`
                  : validation.status === 'unavailable' ? 'OpenRouter validation is temporarily unavailable. Saving is disabled.'
                    : 'Complete or remove every model entry before saving.'
          }</p>
        </Panel>
        <p className="model-preservation">Saving changes only the current default variation. Existing staged variations, targeting rules, rollout percentages, and flag status are preserved. Targeted rules may still serve a different variation to specific workspaces or people.</p>
        {status && <p className={statusIsError ? 'model-save-error' : 'save-status'} role="status">{status}</p>}
      </section>
    </main>
  </>;
}
