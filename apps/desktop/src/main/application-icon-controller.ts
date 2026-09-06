import type { StoredApplicationIconSelection } from './application-icon';
import {
  parseApplicationIconId,
  type ApplicationIconId,
  type DesktopApplicationIconState,
} from '../common/application-icons';

export interface ApplicationIconControllerDependencies {
  readonly supported: boolean;
  readonly automaticIcon: () => ApplicationIconId;
  readonly validateIcon: (iconId: ApplicationIconId) => void;
  readonly readStoredIcon: () => Promise<StoredApplicationIconSelection>;
  readonly writeStoredIcon: (iconId: ApplicationIconId) => Promise<void>;
  readonly clearStoredIcon: () => Promise<void>;
  readonly applyIcon: (iconId: ApplicationIconId) => Promise<void>;
  readonly resetNativeIcon: () => Promise<void>;
  readonly onStateChange: (state: DesktopApplicationIconState) => void;
}

export class ApplicationIconController {
  private selectedIcon: ApplicationIconId | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: ApplicationIconControllerDependencies) {}

  state(): DesktopApplicationIconState {
    return {
      activeIcon: this.selectedIcon ?? this.dependencies.automaticIcon(),
      isAutomatic: this.selectedIcon === null,
      supported: this.dependencies.supported,
    };
  }

  appearanceChanged(): void {
    this.dependencies.onStateChange(this.state());
  }

  restore(): Promise<void> {
    const result = this.mutationTail.then(() => this.restoreNow());
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async restoreNow(): Promise<void> {
    if (!this.dependencies.supported) return;
    const storedIcon = await this.dependencies.readStoredIcon();
    if (!storedIcon) return;
    if (storedIcon === 'retired') {
      // Preserve the retired preference until cleanup succeeds so startup retries
      // a failed native reset instead of leaving Finder permanently stale.
      await this.dependencies.resetNativeIcon();
      await this.dependencies.clearStoredIcon();
      this.selectedIcon = null;
      this.dependencies.onStateChange(this.state());
      return;
    }
    this.dependencies.validateIcon(storedIcon);
    await this.dependencies.applyIcon(storedIcon);
    this.selectedIcon = storedIcon;
    this.dependencies.onStateChange(this.state());
  }

  change(rawIconId: unknown): Promise<DesktopApplicationIconState> {
    return this.enqueue(() => this.changeNow(rawIconId));
  }

  reset(): Promise<DesktopApplicationIconState> {
    return this.enqueue(() => this.resetNow());
  }

  private enqueue(
    mutation: () => Promise<DesktopApplicationIconState>,
  ): Promise<DesktopApplicationIconState> {
    const result = this.mutationTail.then(mutation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async changeNow(rawIconId: unknown): Promise<DesktopApplicationIconState> {
    const iconId = parseApplicationIconId(rawIconId);
    if (!iconId) throw new Error('Unknown application icon');
    if (!this.dependencies.supported) {
      throw new Error('Custom application icons are available only on macOS');
    }

    this.dependencies.validateIcon(iconId);
    const previousIcon = this.selectedIcon;
    await this.dependencies.writeStoredIcon(iconId);
    try {
      await this.dependencies.applyIcon(iconId);
    } catch (error) {
      await this.rollBackMutation(previousIcon, error);
    }

    this.selectedIcon = iconId;
    const state = this.state();
    this.dependencies.onStateChange(state);
    return state;
  }

  private async resetNow(): Promise<DesktopApplicationIconState> {
    if (!this.dependencies.supported) {
      throw new Error('Custom application icons are available only on macOS');
    }

    const previousIcon = this.selectedIcon;
    await this.dependencies.clearStoredIcon();
    try {
      await this.dependencies.resetNativeIcon();
    } catch (error) {
      await this.rollBackMutation(previousIcon, error);
    }

    this.selectedIcon = null;
    const state = this.state();
    this.dependencies.onStateChange(state);
    return state;
  }

  private async rollBackMutation(
    previousIcon: ApplicationIconId | null,
    cause: unknown,
  ): Promise<never> {
    const rollbackFailures: unknown[] = [];
    try {
      if (previousIcon) await this.dependencies.writeStoredIcon(previousIcon);
      else await this.dependencies.clearStoredIcon();
    } catch (error) {
      rollbackFailures.push(error);
    }

    try {
      if (previousIcon) await this.dependencies.applyIcon(previousIcon);
      else await this.dependencies.resetNativeIcon();
    } catch (error) {
      rollbackFailures.push(error);
    }

    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [cause, ...rollbackFailures],
        'Could not change the application icon or fully restore the previous icon',
      );
    }
    throw cause;
  }
}
