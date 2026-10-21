import { ErrorNotice } from './primitives';
import { settings } from '../settings/registry';
import { SettingLabel } from '../settings/setting-label';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applicationIconChoices,
  type ApplicationIconId,
  type DesktopApplicationIconState,
} from '../../common/application-icons';
import builderIcon from '../assets/app-icons/builder.png';
import calmIcon from '../assets/app-icons/calm.png';
import darkIcon from '../assets/app-icons/dark.png';
import homageIcon from '../assets/app-icons/homage.png';
import lightIcon from '../assets/app-icons/light.png';
import ludicrousSpeedIcon from '../assets/app-icons/ludicrous.png';
import quietIcon from '../assets/app-icons/quiet.png';
import { desktopBridge } from '../lib/platform';

const applicationIconArtwork: Record<ApplicationIconId, string> = {
  light: lightIcon,
  dark: darkIcon,
  calm: calmIcon,
  ludicrous: ludicrousSpeedIcon,
  homage: homageIcon,
  builder: builderIcon,
  quiet: quietIcon,
};

export function ApplicationIconPicker(): React.JSX.Element {
  const bridge = useMemo(() => desktopBridge(), []);
  const [iconState, setIconState] = useState<DesktopApplicationIconState | null>(null);
  const [pendingIcon, setPendingIcon] = useState<ApplicationIconId | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [jumpingIcon, setJumpingIcon] = useState<ApplicationIconId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jumpTimer = useRef<number | null>(null);
  const selectionSequence = useRef(0);

  useEffect(() => {
    let mounted = true;
    void bridge.getApplicationIcon().then((state) => {
      if (mounted) setIconState(state);
    }).catch((reason: unknown) => {
      if (mounted) setError(reason instanceof Error ? reason.message : 'Could not load the app icon preference.');
    });
    const unsubscribe = bridge.onApplicationIconChanged((state) => {
      if (mounted) setIconState(state);
    });
    return () => {
      mounted = false;
      unsubscribe();
      if (jumpTimer.current !== null) window.clearTimeout(jumpTimer.current);
    };
  }, [bridge]);

  const selectedIcon = pendingIcon ?? iconState?.activeIcon ?? 'light';
  const selectedChoice = applicationIconChoices.find(({ id }) => id === selectedIcon)!;
  const isAvailable = iconState?.supported ?? false;

  const chooseIcon = async (iconId: ApplicationIconId): Promise<void> => {
    if (!isAvailable || pendingIcon !== null || isResetting) return;
    const sequence = selectionSequence.current + 1;
    selectionSequence.current = sequence;
    setPendingIcon(iconId);
    setJumpingIcon(iconId);
    setError(null);
    if (jumpTimer.current !== null) window.clearTimeout(jumpTimer.current);
    jumpTimer.current = window.setTimeout(() => setJumpingIcon(null), 560);
    try {
      const state = await bridge.setApplicationIcon(iconId);
      if (selectionSequence.current === sequence) setIconState(state);
    } catch (reason) {
      if (selectionSequence.current === sequence) {
        setError(reason instanceof Error ? reason.message : 'Could not change the app icon.');
      }
    } finally {
      if (selectionSequence.current === sequence) setPendingIcon(null);
    }
  };

  const resetIcon = async (): Promise<void> => {
    if (!isAvailable || pendingIcon !== null || isResetting) return;
    const sequence = selectionSequence.current + 1;
    selectionSequence.current = sequence;
    setIsResetting(true);
    setError(null);
    try {
      const state = await bridge.resetApplicationIcon();
      if (selectionSequence.current === sequence) setIconState(state);
    } catch (reason) {
      if (selectionSequence.current === sequence) {
        setError(reason instanceof Error ? reason.message : 'Could not restore the system app icon.');
      }
    } finally {
      if (selectionSequence.current === sequence) setIsResetting(false);
    }
  };

  return (
    <div className="settings-app-icon-card">
      <div className="settings-app-icon-heading">
        <img alt="" aria-hidden="true" src={applicationIconArtwork[selectedIcon]} />
        <span>
          <strong><SettingLabel setting={settings.appIcon} /></strong>
          <small>{settings.appIcon.description}</small>
        </span>
      </div>
      <div
        aria-busy={pendingIcon !== null || isResetting}
        aria-label="App icon"
        className="settings-app-icon-shelf"
        role="group"
      >
        {applicationIconChoices.map((choice) => {
          const selected = selectedIcon === choice.id;
          return (
            <button
              aria-label={`${choice.label} app icon`}
              aria-pressed={selected}
              className={jumpingIcon === choice.id ? 'is-jumping' : undefined}
              disabled={!isAvailable || pendingIcon !== null || isResetting}
              key={choice.id}
              onClick={() => void chooseIcon(choice.id)}
              title={choice.label}
              type="button"
            >
              <span className="settings-app-icon-artwork">
                <img alt="" aria-hidden="true" src={applicationIconArtwork[choice.id]} />
              </span>
              <span aria-hidden="true" className="settings-app-icon-selection" />
            </button>
          );
        })}
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <p aria-live="polite" className="settings-app-icon-status">
        {iconState === null
          ? 'Loading icon preference…'
          : !iconState.supported
            ? 'Custom app icons are available in the macOS app.'
            : iconState.isAutomatic
              ? `Using ${selectedChoice.label.toLowerCase()} automatically with the system appearance.`
              : `${selectedChoice.label} is selected.`}
      </p>
      {iconState && !iconState.isAutomatic && (
        <button
          className="settings-app-icon-reset"
          disabled={pendingIcon !== null || isResetting}
          onClick={() => void resetIcon()}
          type="button"
        >
          {isResetting ? 'Restoring…' : 'Use the system icon'}
        </button>
      )}
    </div>
  );
}
