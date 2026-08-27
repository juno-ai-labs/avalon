import { useState } from 'react';

import { resolvedThemes, type ResolvedTheme } from '../../common/themes';
import {
  Badge,
  Button,
  Code,
  ConnectorIcon,
  Description,
  Dialog,
  Divider,
  ErrorMessage,
  Eyebrow,
  Field,
  Fieldset,
  Heading,
  Icon,
  IconButton,
  Input,
  Kbd,
  Label,
  Select,
  Strong,
  Subheading,
  Switch,
  Text,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  badgeTones,
  buttonVariantNames,
  cn,
  connectorNames,
  iconNames,
  useFieldControl,
} from '../components/ui';

/**
 * What the explorer shows, named so a test can hold it to the barrel.
 *
 * The list is the point. A library nobody can look at is a folder, and the way
 * a folder rots is that a component ships, nothing renders it beside its
 * neighbours, and six months later there are two of it. `component-explorer.test.tsx`
 * fails when a barrel export has no entry here, which makes "add it to the
 * explorer" part of adding a component rather than a thing to remember.
 */
export const explorerSections = [
  { id: 'foundations', name: 'Foundations', components: ['Icon', 'ConnectorIcon', 'Heading', 'Subheading', 'Eyebrow', 'Text', 'Strong', 'Code', 'Kbd', 'Divider'] },
  { id: 'controls', name: 'Controls', components: ['Button', 'IconButton', 'Switch', 'Select', 'Badge'] },
  { id: 'forms', name: 'Forms', components: ['Field', 'Fieldset', 'Label', 'Description', 'ErrorMessage', 'Input', 'Textarea', 'useFieldControl'] },
  { id: 'overlays', name: 'Overlays', components: ['Dialog', 'Tooltip', 'TooltipTrigger', 'TooltipContent'] },
  { id: 'utilities', name: 'Utilities', components: ['cn', 'iconNames', 'connectorNames', 'buttonVariantNames', 'badgeTones'] },
] as const;

/**
 * Exports the explorer deliberately does not render, and why. An entry here is
 * a claim that the export has nothing to look at — not that nobody got round
 * to it.
 */
export const explorerExempt: Record<string, string> = {
  TooltipProvider: 'Application plumbing. It renders no markup of its own; App mounts exactly one.',
};

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] items-start gap-4 py-3">
      <code className="pt-1 font-mono text-hint text-ink-muted">{label}</code>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function Section({ id, name, children }: { id: string; name: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section aria-labelledby={`explorer-${id}`} className="mb-10">
      <Eyebrow id={`explorer-${id}`}>{name}</Eyebrow>
      <Divider className="my-3" />
      <div className="divide-y divide-line-subtle">{children}</div>
    </section>
  );
}

function DemoField(): React.JSX.Element {
  const control = useFieldControl();
  return <Input placeholder="you@example.com" {...control} />;
}

/**
 * Every primitive, in every variant, under any of the four themes.
 *
 * Reached at `#/explorer`. It is not linked from the interface: it is a
 * developer surface, and a route nobody navigates to costs nothing, where a
 * navigation entry would have to answer who is allowed to see it.
 */
export function ComponentExplorerScreen(): React.JSX.Element {
  const [theme, setTheme] = useState<ResolvedTheme | 'app'>('app');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState('daily');
  const [checked, setChecked] = useState(true);

  return (
    // `surface-canvas` rather than `pane.background`, which Air and Air Dark
    // both set to `transparent` so their painted backdrop shows through the
    // feed. That backdrop is on `body`, which belongs to the *application's*
    // theme — so an explorer previewing Air Dark inside a light window came out
    // as near-white text on the light backdrop. Every theme declares its canvas
    // outright, which is what a preview needs: a surface of its own.
    <div
      className="h-full overflow-auto bg-surface-canvas p-pane text-ink"
      {...(theme === 'app' ? {} : { 'data-theme': theme })}
    >
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading>Component explorer</Heading>
          <Text className="mt-1">
            Every primitive the barrel exports. Switch the theme to check a component against all four.
          </Text>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setTheme('app')} variant={theme === 'app' ? 'primary' : 'default'}>
            Follow the app
          </Button>
          {resolvedThemes.map((candidate) => (
            <Button
              key={candidate}
              onClick={() => setTheme(candidate)}
              variant={theme === candidate ? 'primary' : 'default'}
            >
              {candidate}
            </Button>
          ))}
        </div>
      </header>

      <Section id="foundations" name="Foundations">
        <Row label="Icon">
          {iconNames.map((name) => (
            <span className="flex flex-col items-center gap-1" key={name}>
              <Icon name={name} size="md" />
              <small className="text-[9px] text-ink-disabled">{name}</small>
            </span>
          ))}
        </Row>
        <Row label="Icon · sizes">
          <Icon name="suggestion" size="xs" />
          <Icon name="suggestion" size="sm" />
          <Icon name="suggestion" size="md" />
          <Icon name="suggestion" size="lg" />
          <Icon name="spinner" size="md" spinning />
        </Row>
        <Row label="ConnectorIcon">
          {connectorNames.map((name) => (
            <ConnectorIcon key={name} label={name} name={name} />
          ))}
        </Row>
        <Row label="ConnectorIcon · plain">
          {connectorNames.map((name) => (
            <ConnectorIcon key={name} label={name} name={name} plain />
          ))}
        </Row>
        <Row label="Heading">
          <Heading>A page title</Heading>
        </Row>
        <Row label="Subheading">
          <Subheading>A section title</Subheading>
        </Row>
        <Row label="Eyebrow">
          <Eyebrow>Over a group</Eyebrow>
        </Row>
        <Row label="Text / Strong / Code">
          <Text>
            Body copy, with <Strong>emphasis</Strong> and <Code>inline code</Code>.
          </Text>
        </Row>
        <Row label="Kbd">
          <span>
            Submit <Kbd>⌘↵</Kbd>
          </span>
        </Row>
        <Row label="Divider">
          <div className="w-64">
            <Divider />
            <div className="h-3" />
            <Divider soft />
          </div>
        </Row>
      </Section>

      <Section id="controls" name="Controls">
        <Row label="Button">
          {buttonVariantNames.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
        </Row>
        <Row label="Button · disabled">
          {buttonVariantNames.map((variant) => (
            <Button disabled key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
        </Row>
        <Row label="Button · with icon">
          <Button variant="primary">
            <Icon name="add" size="sm" /> New work stream
          </Button>
          <Button variant="danger">
            <Icon name="trash" size="sm" /> Delete
          </Button>
        </Row>
        <Row label="IconButton">
          <IconButton label="Settings">
            <Icon name="settings" size="md" />
          </IconButton>
          <IconButton label="More">
            <Icon name="more" size="md" />
          </IconButton>
          <IconButton disabled label="Refresh">
            <Icon name="refresh" size="md" />
          </IconButton>
        </Row>
        <Row label="Switch">
          <Switch checked={checked} label="A preference" onChange={(event) => setChecked(event.currentTarget.checked)} />
          <Switch checked={false} label="Off" readOnly />
          <Switch checked disabled label="Disabled" readOnly />
        </Row>
        <Row label="Select">
          <Select
            label="Digest cadence"
            onValueChange={setSelected}
            options={[
              { value: 'daily', label: 'Every day', description: 'One digest each morning.' },
              { value: 'weekly', label: 'Every week' },
              { value: 'never', label: 'Never' },
            ]}
            value={selected}
          />
          <Select
            label="Digest cadence, quiet"
            onValueChange={setSelected}
            options={[
              { value: 'daily', label: 'Every day' },
              { value: 'weekly', label: 'Every week' },
              { value: 'never', label: 'Never' },
            ]}
            value={selected}
            variant="quiet"
          />
        </Row>
        <Row label="Badge">
          {badgeTones.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </Row>
      </Section>

      <Section id="forms" name="Forms">
        <Row label="Field">
          <div className="w-80">
            <Field>
              <Label>Email address</Label>
              <DemoField />
              <Description>Where digests are delivered.</Description>
            </Field>
          </div>
        </Row>
        <Row label="Field · error">
          <div className="w-80">
            <Field>
              <Label>Email address</Label>
              <Input defaultValue="not-an-address" />
              <ErrorMessage>That does not look like an email address.</ErrorMessage>
            </Field>
          </div>
        </Row>
        <Row label="Fieldset">
          <div className="w-80">
            <Fieldset legend="Delivery">
              <Field>
                <Label>Address</Label>
                <Input placeholder="you@example.com" />
              </Field>
              <Field>
                <Label>Note</Label>
                <Textarea placeholder="Anything to add?" rows={3} />
              </Field>
            </Fieldset>
          </div>
        </Row>
        <Row label="Input">
          <Input className="w-64" placeholder="Placeholder" />
          <Input className="w-40" defaultValue="Disabled" disabled />
        </Row>
        <Row label="Textarea">
          <Textarea className="w-64" placeholder="Multiple lines" rows={3} />
        </Row>
      </Section>

      <Section id="overlays" name="Overlays">
        <Row label="Tooltip">
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button>Hover me</Button>
            </TooltipTrigger>
            <TooltipContent>On a surface that opposes the theme</TooltipContent>
          </Tooltip>
        </Row>
        <Row label="Dialog">
          <Button onClick={() => setDialogOpen(true)} variant="primary">
            Open the dialog
          </Button>
          <Dialog
            description="Everything a dialog is, assembled once."
            footer={
              <>
                <Button onClick={() => setDialogOpen(false)} variant="quiet">
                  Cancel
                </Button>
                <Button onClick={() => setDialogOpen(false)} variant="primary">
                  Confirm
                </Button>
              </>
            }
            onOpenChange={setDialogOpen}
            open={dialogOpen}
            title="A dialog"
          >
            <Text>The body scrolls when it needs to. The header and the footer do not.</Text>
          </Dialog>
        </Row>
      </Section>

      <Section id="utilities" name="Utilities">
        <Row label="cn">
          <Code className={cn('text-hint text-ink-muted')}>
            cn(&apos;text-ink-muted&apos;, &apos;text-ink&apos;) → &quot;{cn('text-ink-muted', 'text-ink')}&quot;
          </Code>
        </Row>
        <Row label="registries">
          <Text className="text-hint">
            {iconNames.length} icons · {connectorNames.length} connectors · {buttonVariantNames.length} button
            variants · {badgeTones.length} badge tones
          </Text>
        </Row>
      </Section>
    </div>
  );
}
