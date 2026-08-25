import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applicationIconChoices,
  type ApplicationIconId,
  type DesktopApplicationIconState,
} from '../../common/application-icons';
import blueprintIcon from '../assets/app-icons/blueprint.png';
import darkIcon from '../assets/app-icons/dark.png';
import holographicIcon from '../assets/app-icons/holographic.png';
import leatherIcon from '../assets/app-icons/leather.png';
import lightIcon from '../assets/app-icons/light.png';
import ludicrousSpeedIcon from '../assets/app-icons/ludicrous-speed.png';
import rubyIcon from '../assets/app-icons/ruby.png';
import sunsetSherbetIcon from '../assets/app-icons/sunset-sherbet.png';
import { desktopBridge } from '../lib/platform';

const applicationIconArtwork: Record<ApplicationIconId, string> = {
  light: lightIcon,
  dark: darkIcon,
  'sunset-sherbet': sunsetSherbetIcon,
  'ludicrous-speed': ludicrousSpeedIcon,
  ruby: rubyIcon,
  holographic: holographicIcon,
  leather: leatherIcon,
  blueprint: blueprintIcon,
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
          <strong>App icon</strong>
          <small>Choose how Rally appears in the Dock, Finder, Launchpad, and Spotlight.</small>
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
      <p aria-live="polite" className={error ? 'settings-app-icon-status is-error' : 'settings-app-icon-status'}>
        {error ?? (iconState === null
          ? 'Loading icon preference…'
          : !iconState.supported
            ? 'Custom app icons are available in the macOS app.'
            : iconState.isAutomatic
              ? `Using ${selectedChoice.label.toLowerCase()} automatically with the system appearance.`
              : `${selectedChoice.label} is selected.`)}
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
