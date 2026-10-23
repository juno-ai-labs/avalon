import { useState, type ReactNode } from 'react';
import { useClickBurst } from '../../lib/easter-eggs';

/** Who made Rally, shown to whoever clicks the version seven times. */
export const RALLY_CREDITS = ['Adam J', 'Alex T', 'Katherine B', 'Zzyzx'] as const;

const CLICKS = 7;
const WITHIN_MS = 3_000;

/** The About card: the version, and the credits hidden behind it. */
export function AboutRally({ version, versionLabel }: { version: string; versionLabel: ReactNode }): React.JSX.Element {
  const [creditsShown, setCreditsShown] = useState(false);
  const click = useClickBurst(CLICKS, WITHIN_MS, () => setCreditsShown(true));
  return (
    <>
      <dl className="settings-diagnostics settings-list-card">
        <div><dt>{versionLabel}</dt><dd onClick={click}>{version}</dd></div>
      </dl>
      {creditsShown && (
        <section aria-label="Credits" className="about-credits settings-list-card">
          <p>Made by</p>
          <ul>{RALLY_CREDITS.map((name) => <li key={name}>{name}</li>)}</ul>
          <p>at Juno AI Labs</p>
        </section>
      )}
    </>
  );
}
