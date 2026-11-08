import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProductFeatureFlagKey } from '@rally/contracts';
import type { AceCondition } from '../protocol';
import { FLAG_ATTRIBUTES, MANAGED_FLAGS, ManagedFlagUpdateSchema, MAX_CONDITION_DEPTH } from '../protocol';
import { Button, EmptyState, Field, Panel, SegmentedControl, StatusDot } from './components/ui';
import { ModelsView } from './models';
import { AccessView } from './private-access';
import { QueuesView } from './queues';
import { WorkspacesView, type RetiredWorkspace } from './workspaces';
import './styles.css';

type Operator = 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'greater_than_or_equals'
  | 'less_than_or_equals' | 'contains' | 'starts_with' | 'ends_with' | 'in' | 'not_in';

interface Rule {
  // Client-only identity, never sent to Flagship (stripped in dirtyPayload).
  // Rule cards are keyed by this rather than array position, because a
  // position survives a reorder while the rule at that position does not —
  // an index key would leave `SimpleConditionEditor`'s local lookup state
  // behind at the old position instead of following the moved rule.
  _clientId: string;
  priority: number;
  conditions: AceCondition[];
  serve_variation: 'on' | 'off';
  rollout?: { percentage: number; attribute?: string };
}

interface Flag {
  key: ProductFeatureFlagKey;
  description?: string;
  enabled?: boolean;
  default_variation?: 'on' | 'off';
  rules?: Rule[];
}

interface DirectoryResult { id: string; name: string; email?: string; slug?: string; region: string }

const operators: Array<{ value: Operator; label: string }> = [
  { value: 'equals', label: 'is' }, { value: 'not_equals', label: 'is not' },
  { value: 'contains', label: 'contains' }, { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' }, { value: 'in', label: 'is one of' },
  { value: 'not_in', label: 'is not one of' }, { value: 'greater_than', label: 'is greater than' },
  { value: 'greater_than_or_equals', label: 'is at least' }, { value: 'less_than', label: 'is less than' },
  { value: 'less_than_or_equals', label: 'is at most' },
];

function emptyFlag(key: Flag['key']): Flag {
  const definition = MANAGED_FLAGS.find((flag) => flag.key === key)!;
  return { key, description: definition.description, enabled: true, default_variation: definition.defaultVariation, rules: [] };
}

type SimpleCondition = Omit<Required<Pick<AceCondition, 'attribute' | 'operator' | 'value'>>, 'value'> & {
  value: string | number | Array<string | number>;
};

function newSimpleCondition(): SimpleCondition {
  return { attribute: 'userPlatformId', operator: 'equals', value: '' };
}

function isGroup(condition: AceCondition): condition is AceCondition & { logical_operator: 'AND' | 'OR'; clauses: AceCondition[] } {
  return condition.logical_operator !== undefined && condition.clauses !== undefined;
}

export function initialDirectoryLookup(condition: Pick<AceCondition, 'value'>): string {
  return String(condition.value ?? '');
}

export function reorderRules<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

// A rule loaded from Flagship, or created by "+ Add rule", has no id of its
// own; this assigns one only where missing, so it is safe to call on a mix of
// already-tagged and freshly loaded rules without generating new ids for the
// ones that already have one.
function withRuleIds(rules: Rule[]): Rule[] {
  return rules.map((rule) => rule._clientId ? rule : { ...rule, _clientId: crypto.randomUUID() });
}

// Native drag-and-drop needs something on `dataTransfer` to be considered a
// valid drag by Firefox, and reading the source index back from it in `onDrop`
// removes the alternative — carrying the index only in React state — which
// depends on a commit between `dragstart` and `drop` landing first. The type
// string doubles as the drop-target gate: `onDragOver`/`onDrop` on a rule card
// check for it before calling `preventDefault()`, so a drag that isn't a rule
// drag (a file, a link, selected text) is left for the browser to handle
// rather than silently swallowed.
const RULE_DRAG_MIME = 'application/x-ace-rule-index';

export function SimpleConditionEditor({ condition, onChange, onRemove }: {
  condition: SimpleCondition; onChange: (condition: AceCondition) => void; onRemove?: () => void;
}): React.JSX.Element {
  const conditionValue = initialDirectoryLookup(condition);
  const [lookupState, setLookupState] = useState(() => ({ storedValue: conditionValue, text: conditionValue }));
  const lookup = lookupState.storedValue === conditionValue ? lookupState.text : conditionValue;
  const [results, setResults] = useState<DirectoryResult[]>([]);
  const lookupKind = condition.attribute === 'userPlatformId' ? 'users'
    : condition.attribute === 'workspaceId' ? 'workspaces' : null;

  useEffect(() => {
    if (!lookupKind || lookup.trim().length < 2) { setResults([]); return undefined; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`/api/directory/${lookupKind}?q=${encodeURIComponent(lookup)}`, { signal: controller.signal })
        .then(async (response) => await response.json() as { results?: DirectoryResult[] })
        .then((body) => setResults(body.results ?? []))
        .catch(() => undefined);
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [lookup, lookupKind]);

  const expectsList = condition.operator === 'in' || condition.operator === 'not_in';
  const attribute = FLAG_ATTRIBUTES.find((candidate) => candidate.key === condition.attribute);

  return (
    <div className="condition-row">
      <div className="condition-grid">
        <Field label="Match"><select value={condition.attribute} onChange={(event) => {
          const nextAttribute = event.target.value;
          setLookupState({ storedValue: '', text: '' });
          onChange({ attribute: nextAttribute, operator: 'equals', value: '' });
        }}>{FLAG_ATTRIBUTES.map((attribute) => <option key={attribute.key} value={attribute.key}>{attribute.label}</option>)}</select></Field>
        <Field label="Operator"><select value={condition.operator} onChange={(event) => {
          const operator = event.target.value as Operator;
          onChange({ ...condition, operator, value: operator === 'in' || operator === 'not_in' ? [] : '' });
        }}>
          {operators.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
        </select></Field>
        <Field className="value-field" label={lookupKind ? 'Find and select' : 'Value'}>
          <input
            placeholder={lookupKind === 'users' ? 'Search by name or email…' : lookupKind === 'workspaces' ? 'Search by workspace name…' : 'Enter a value'}
            type={attribute?.type === 'number' && !expectsList ? 'number' : 'text'}
            value={lookupKind ? lookup : Array.isArray(condition.value) ? condition.value.join(', ') : String(condition.value)}
            onChange={(event) => {
              if (lookupKind) setLookupState({ storedValue: conditionValue, text: event.target.value });
              else onChange({
                ...condition,
                value: expectsList
                  ? event.target.value.split(',').map((entry) => entry.trim()).filter(Boolean)
                    .map((entry) => attribute?.type === 'number' ? Number(entry) : entry)
                  : event.target.type === 'number' ? Number(event.target.value) : event.target.value,
              });
            }}
          />
          {lookupKind && results.length > 0 && <div className="lookup-menu">
            {results.map((result) => <button key={`${result.region}-${result.id}`} onClick={() => {
              onChange({ ...condition, value: result.id });
              setLookupState({
                storedValue: result.id,
                text: result.email ?? `${result.name}${result.slug ? ` · ${result.slug}` : ''}`,
              });
              setResults([]);
            }} type="button"><strong>{result.name}</strong><small>{result.email ?? result.slug} · {result.region}</small></button>)}
          </div>}
          {lookupKind && String(condition.value) && <small className="stored-value">Stored as opaque ID · {String(condition.value).slice(0, 18)}…</small>}
          {expectsList && <small className="stored-value">Separate values with commas.</small>}
        </Field>
      </div>
      {onRemove && <Button variant="quiet" onClick={onRemove} type="button">Remove condition</Button>}
    </div>
  );
}

function ConditionEditor({ condition, depth, onChange, onRemove }: {
  condition: AceCondition; depth: number; onChange: (condition: AceCondition) => void; onRemove?: () => void;
}): React.JSX.Element {
  if (!isGroup(condition)) {
    return <SimpleConditionEditor
      condition={condition as SimpleCondition}
      onChange={onChange}
      {...(onRemove ? { onRemove } : {})}
    />;
  }
  const setClauses = (clauses: AceCondition[]): void => onChange({ ...condition, clauses });
  return <div className={`condition-group depth-${depth}`}>
    <div className="group-heading">
      <span>Match</span>
      <SegmentedControl options={['AND', 'OR'] as const} value={condition.logical_operator} onChange={(logical_operator) => onChange({ ...condition, logical_operator })} />
      <small>{condition.logical_operator === 'AND' ? 'all conditions' : 'any condition'}</small>
      {onRemove && <Button variant="quiet" onClick={onRemove} type="button">Remove group</Button>}
    </div>
    <div className="group-clauses">
      {condition.clauses.length === 0 && <p className="unconditional">{depth === 1
        ? 'This rule matches everyone.'
        : 'Add a condition or remove this group before saving.'}</p>}
      {condition.clauses.map((clause, index) => <ConditionEditor
        condition={clause}
        depth={depth + 1}
        key={index}
        onChange={(next) => setClauses(condition.clauses.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate))}
        onRemove={() => setClauses(condition.clauses.filter((_, candidateIndex) => candidateIndex !== index))}
      />)}
    </div>
    <div className="group-actions">
      <Button variant="secondary" onClick={() => setClauses([...condition.clauses, newSimpleCondition()])} type="button">＋ Condition</Button>
      {depth < MAX_CONDITION_DEPTH && <Button variant="secondary" onClick={() => setClauses([...condition.clauses, { logical_operator: 'AND', clauses: [newSimpleCondition()] }])} type="button">＋ Group</Button>}
    </div>
  </div>;
}

function RuleEditor({ rule, index, dragging, onChange, onRemove, onDragStart, onDragEnd, onDragOver, onDrop, onKeyDown, handleRef }: {
  rule: Rule; index: number; dragging: boolean; onChange: (rule: Rule) => void; onRemove: () => void;
  onDragStart: (event: React.DragEvent) => void; onDragEnd: () => void;
  onDragOver: (event: React.DragEvent) => void; onDrop: (event: React.DragEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void; handleRef: (element: HTMLButtonElement | null) => void;
}): React.JSX.Element {
  const rootCondition: AceCondition = rule.conditions.length === 1 && isGroup(rule.conditions[0]!)
    ? rule.conditions[0]!
    : { logical_operator: 'AND', clauses: rule.conditions };
  const setRootCondition = (conditions: AceCondition): void => onChange({
    ...rule,
    conditions: isGroup(conditions) && conditions.logical_operator === 'AND'
      ? conditions.clauses
      : [conditions],
  });
  return (
    <Panel className={`rule-card${dragging ? ' dragging' : ''}`} onDragOver={onDragOver} onDrop={onDrop}>
      <header>
        <button aria-keyshortcuts="ArrowUp ArrowDown" aria-label={`Reorder rule ${index + 1}`} className="rule-handle" draggable onDragEnd={onDragEnd} onDragStart={onDragStart} onKeyDown={onKeyDown} ref={handleRef} type="button">⠿</button>
        <span className="rule-number">{index + 1}</span><strong>Target rule</strong><Button variant="quiet" onClick={onRemove} type="button">Remove rule</Button>
      </header>
      <ConditionEditor condition={rootCondition} depth={1} onChange={setRootCondition} />
      <div className="rule-result"><span>Then serve</span><SegmentedControl onChange={(value) => onChange({ ...rule, serve_variation: value })} options={['on', 'off'] as const} value={rule.serve_variation} /><Field className="rollout" label="Rollout"><input min="0" max="100" type="number" value={rule.rollout?.percentage ?? 100} onChange={(event) => onChange({ ...rule, rollout: { percentage: Number(event.target.value), attribute: rule.rollout?.attribute ?? 'userPlatformId' } })} /><b>%</b></Field><Field className="bucket" label="Sticky by"><select value={rule.rollout?.attribute ?? 'userPlatformId'} onChange={(event) => onChange({ ...rule, rollout: { percentage: rule.rollout?.percentage ?? 100, attribute: event.target.value } })}>{FLAG_ATTRIBUTES.map((attribute) => <option key={attribute.key} value={attribute.key}>{attribute.label}</option>)}</select></Field></div>
    </Panel>
  );
}

function App(): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<'feature-flags' | 'models' | 'queues' | 'workspaces' | 'access'>('feature-flags');
  // Held here rather than in the tab: the tab unmounts on a switch, and a
  // retired workspace has to stay marked when the operator comes back to it.
  const [retiredWorkspaces, setRetiredWorkspaces] = useState<ReadonlyMap<string, RetiredWorkspace>>(new Map());
  const [flags, setFlags] = useState<Flag[]>(MANAGED_FLAGS.map((flag) => emptyFlag(flag.key)));
  const [selectedKey, setSelectedKey] = useState<Flag['key']>('suggested-work-enabled');
  const [operatorEmail, setOperatorEmail] = useState<string | null>(null);
  const [flagshipConnected, setFlagshipConnected] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [draggedRuleIndex, setDraggedRuleIndex] = useState<number | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');
  const [focusRuleIndex, setFocusRuleIndex] = useState<number | null>(null);
  const ruleHandleRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    document.title = activeSection === 'access' ? 'Ace · Access' : activeSection === 'queues'
      ? 'Ace · Queues'
      : activeSection === 'models' ? 'Ace · Models'
        : activeSection === 'workspaces' ? 'Ace · Workspaces' : 'Ace · Feature flags';
  }, [activeSection]);

  // Rule cards are keyed by array position, not a stable rule identity, so a
  // keyboard-driven move reorders the data but leaves focus sitting on the
  // position it started at — now showing a different rule. Without this, a
  // second arrow-key press would silently move whatever landed there instead
  // of the rule the operator is actually moving.
  useEffect(() => {
    if (focusRuleIndex === null) return;
    ruleHandleRefs.current[focusRuleIndex]?.focus();
    setFocusRuleIndex(null);
  }, [focusRuleIndex]);

  useEffect(() => {
    void fetch('/api/session').then(async (response) => await response.json() as { email?: string | null })
      .then((sessionBody) => setOperatorEmail(sessionBody.email ?? null))
      .catch(() => undefined);
    void fetch('/api/flags').then(async (response) => response.ok
      ? await response.json() as { flags?: Flag[] }
      : Promise.reject(new Error('flags'))).then((flagBody) => {
      const byKey = new Map((flagBody.flags ?? []).map((flag) => [flag.key, flag]));
      setFlags(MANAGED_FLAGS.map((managed) => {
        const merged = { ...emptyFlag(managed.key), ...byKey.get(managed.key) };
        return { ...merged, rules: withRuleIds(merged.rules ?? []) };
      }));
      setFlagshipConnected(true);
    }).catch(() => {
      setFlagshipConnected(false);
      setStatus('Flagship is unavailable. No values were changed.');
    });
  }, []);

  const selected = flags.find((flag) => flag.key === selectedKey) ?? emptyFlag(selectedKey);
  const definition = MANAGED_FLAGS.find((flag) => flag.key === selectedKey)!;
  const updateSelected = (patch: Partial<Flag>): void => setFlags((current) => current.map((flag) => flag.key === selectedKey ? { ...flag, ...patch } : flag));
  const moveRuleBy = (index: number, delta: number): void => {
    const rules = selected.rules ?? [];
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    updateSelected({ rules: reorderRules(rules, index, target) });
    setReorderAnnouncement(`Moved rule to position ${target + 1} of ${rules.length}.`);
    setFocusRuleIndex(target);
  };
  const dirtyPayload = useMemo(() => ({
    key: selected.key,
    description: selected.description ?? definition.description,
    enabled: selected.enabled ?? true,
    default_variation: selected.default_variation ?? definition.defaultVariation,
    // `FlagRuleSchema` is `.strict()`, so `_clientId` — a client-only field,
    // never known to Flagship — has to come out here, not just for payload
    // hygiene: left in, every save would fail validation.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop it from the payload
    rules: (selected.rules ?? []).map(({ _clientId, ...rule }, priority) => ({ ...rule, priority: priority + 1 })),
  }), [definition.description, definition.defaultVariation, selected]);

  const save = async (): Promise<void> => {
    if (flagshipConnected !== true) {
      setStatus('Flagship is unavailable. Reload before making changes.');
      return;
    }
    const parsed = ManagedFlagUpdateSchema.safeParse(dirtyPayload);
    if (!parsed.success) {
      setStatus('Complete every targeting condition before saving.');
      return;
    }
    setSaving(true); setStatus('');
    try {
      const response = await fetch(`/api/flags/${selected.key}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data),
      });
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      setStatus('Saved to Flagship. Connected clients will refresh after propagation.');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Save failed.'); }
    finally { setSaving(false); }
  };

  return <div className="ace-shell">
    <aside className="primary-nav"><div className="brand"><span>A</span><strong>Ace</strong></div><nav><button aria-current={activeSection === 'access' ? 'page' : undefined} className={activeSection === 'access' ? 'active' : ''} onClick={() => setActiveSection('access')} type="button"><i>↗</i>Access</button><button aria-current={activeSection === 'feature-flags' ? 'page' : undefined} className={activeSection === 'feature-flags' ? 'active' : ''} onClick={() => setActiveSection('feature-flags')} type="button"><i>⚑</i>Feature flags</button><button aria-current={activeSection === 'models' ? 'page' : undefined} className={activeSection === 'models' ? 'active' : ''} onClick={() => setActiveSection('models')} type="button"><i>◇</i>Models</button><button aria-current={activeSection === 'queues' ? 'page' : undefined} className={activeSection === 'queues' ? 'active' : ''} onClick={() => setActiveSection('queues')} type="button"><i>⇥</i>Queues</button><button aria-current={activeSection === 'workspaces' ? 'page' : undefined} className={activeSection === 'workspaces' ? 'active' : ''} onClick={() => setActiveSection('workspaces')} type="button"><i>▦</i>Workspaces</button></nav><footer><span className="avatar">{operatorEmail?.[0]?.toUpperCase() ?? 'A'}</span><div><strong>{operatorEmail ?? 'Internal operator'}</strong><small>Cloudflare Access</small></div></footer></aside>
    {activeSection === 'access' ? <AccessView /> : activeSection === 'queues' ? <QueuesView /> : activeSection === 'models' ? <ModelsView /> : activeSection === 'workspaces' ? <WorkspacesView onRetired={(record) => setRetiredWorkspaces((current) => new Map(current).set(record.workspace.id, record))} retired={retiredWorkspaces} /> : <><aside className="flag-list"><header><p>Product controls</p><h1>Feature flags</h1><small>{MANAGED_FLAGS.length} managed flags</small></header><div className="flags">
      {MANAGED_FLAGS.map((flag) => { const current = flags.find((candidate) => candidate.key === flag.key); const ruleCount = (current?.rules ?? []).length; const stateLabel = flagshipConnected === false ? 'Unavailable' : current?.enabled ? 'Enabled' : 'Paused'; return <button className={selectedKey === flag.key ? 'selected' : ''} key={flag.key} onClick={() => setSelectedKey(flag.key)} type="button"><StatusDot active={flagshipConnected === true && current?.enabled === true} label={stateLabel} /><div><strong>{flag.label}</strong><small>{current?.default_variation === 'on' ? 'Default on' : 'Default off'} · {ruleCount} {ruleCount === 1 ? 'rule' : 'rules'}</small></div><b>›</b></button>; })}
    </div><footer><span className={flagshipConnected === true ? 'healthy-dot' : 'status-dot'} />{flagshipConnected === null ? 'Connecting to Flagship…' : flagshipConnected ? 'Flagship connected' : 'Flagship unavailable'}</footer></aside>
    <main className="flag-editor"><header className="editor-header"><div><p>Feature flag</p><h2>{definition.label}</h2><code>{selected.key}</code></div><Button variant="primary" disabled={saving || flagshipConnected !== true} onClick={() => void save()} type="button">{saving ? 'Saving…' : 'Save changes'}</Button></header>
      <section className="default-section"><div><h3>Default</h3><p>The value for anyone who does not match a targeting rule.</p></div><div className="flag-controls"><Field label="Flag status"><SegmentedControl onChange={(value) => updateSelected({ enabled: value === 'enabled' })} options={['enabled', 'paused'] as const} value={selected.enabled === false ? 'paused' : 'enabled'} /></Field><Field label="Default value"><SegmentedControl large onChange={(value) => updateSelected({ default_variation: value })} options={['off', 'on'] as const} value={selected.default_variation ?? definition.defaultVariation} /></Field></div></section>
      <section className="targeting"><div className="section-title"><div><h3>Targeting rules</h3><p>Rules run from top to bottom. The first match wins. Nest AND/OR groups for precise audiences.</p></div><button className="add" onClick={() => updateSelected({ rules: [...(selected.rules ?? []), { _clientId: crypto.randomUUID(), priority: (selected.rules ?? []).length + 1, conditions: [newSimpleCondition()], serve_variation: 'on', rollout: { percentage: 100, attribute: 'userPlatformId' } }] })} type="button">＋ Add rule</button></div>
        <span aria-live="polite" className="sr-only">{reorderAnnouncement}</span>
        <div className="rule-stack">{(selected.rules ?? []).map((rule, index) => <RuleEditor
          dragging={draggedRuleIndex === index}
          handleRef={(element) => { ruleHandleRefs.current[index] = element; }}
          index={index}
          key={rule._clientId}
          onChange={(next) => updateSelected({ rules: (selected.rules ?? []).map((candidate, candidateIndex) => candidateIndex === index ? next : candidate) })}
          onDragEnd={() => setDraggedRuleIndex(null)}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(RULE_DRAG_MIME)) return;
            event.preventDefault();
          }}
          onDragStart={(event) => {
            event.dataTransfer.setData(RULE_DRAG_MIME, String(index));
            event.dataTransfer.effectAllowed = 'move';
            setDraggedRuleIndex(index);
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes(RULE_DRAG_MIME)) return;
            event.preventDefault();
            const fromIndex = Number(event.dataTransfer.getData(RULE_DRAG_MIME));
            if (fromIndex !== index) updateSelected({ rules: reorderRules(selected.rules ?? [], fromIndex, index) });
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            moveRuleBy(index, event.key === 'ArrowUp' ? -1 : 1);
          }}
          onRemove={() => updateSelected({ rules: (selected.rules ?? []).filter((_, candidateIndex) => candidateIndex !== index) })}
          rule={rule}
        />)}
          {(selected.rules ?? []).length === 0 && <EmptyState title="No targeting rules" description="Everyone receives the default value." />}
        </div><div className="unmatched"><span>↓</span><div><strong>Unmatched users stay {selected.default_variation === 'on' ? 'on' : 'off'}.</strong><small>Every change is evaluated by Flagship per person and workspace.</small></div></div>{status && <p className="save-status" role="status">{status}</p>}
      </section>
    </main></>}
  </div>;
}

const root = typeof document === 'undefined' ? null : document.getElementById('root');
if (root) createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
