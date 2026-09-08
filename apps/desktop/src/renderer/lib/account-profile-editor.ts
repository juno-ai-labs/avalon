import { PersonalPresentationSchema, type AccountOnboarding, type PersonalPresentation, type UpdateAccountOnboarding } from '@rally/contracts';

type Profile = Omit<PersonalPresentation, 'revision'>;
type EditableProfile = Pick<Profile, 'displayName' | 'initials' | 'color'>;

/** One account's latest draft, with at most one revision-checked write in flight. */
export class AccountProfileEditor {
  private account: AccountOnboarding | null = null;
  private draft: Partial<EditableProfile> = {};
  private running = false;
  private active = true;
  private listeners = new Set<() => void>();
  private snapshot: { profile: Profile; saving: boolean; error: string | null };

  constructor(
    private name: string,
    private readonly save: (input: UpdateAccountOnboarding) => Promise<AccountOnboarding>,
    private readonly reload: () => Promise<AccountOnboarding>,
    private readonly committed: (account: AccountOnboarding) => void,
  ) {
    this.snapshot = { profile: this.profile(), saving: false, error: null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): typeof this.snapshot => this.snapshot;

  private profile(): Profile {
    return {
      avatar: 'circle', color: this.account?.presentation?.color ?? 'blue',
      displayName: this.account?.presentation?.displayName ?? this.name,
      initials: this.account?.presentation?.initials ?? this.name.split(/\s+/u).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
      ...this.draft,
    };
  }

  private emit(error: string | null = null): void {
    this.snapshot = { profile: this.profile(), saving: this.running, error };
    this.listeners.forEach((listener) => listener());
  }

  refresh(account: AccountOnboarding, name?: string): void {
    if (name !== undefined) this.name = name;
    if (this.account && account.revision <= this.account.revision) return;
    this.account = account;
    this.emit(this.snapshot.error);
  }

  update(patch: Partial<EditableProfile>): void {
    this.draft = { ...this.draft, ...patch };
    this.emit();
    void this.flush();
  }

  retry = (): void => { void this.flush(); };

  start(): void { this.active = true; }
  stop(): void { this.active = false; }

  private async flush(): Promise<void> {
    if (!this.active || this.running || !this.account) return;
    this.running = true;
    this.emit();
    try {
      while (this.active && Object.keys(this.draft).length > 0) {
        const parsed = PersonalPresentationSchema.safeParse({ ...this.profile(), revision: this.account.revision });
        if (!parsed.success) {
          this.running = false;
          this.emit(!this.profile().displayName?.trim() ? 'Enter a name.' : !this.profile().initials?.trim() ? 'Enter avatar initials.' : 'Your name must be 255 characters or fewer.');
          return;
        }
        const submitted = { ...this.draft };
        const { displayName, initials, color, avatar } = parsed.data;
        const presentation = { displayName, initials, color, avatar };
        const saved = await this.save({ expectedRevision: this.account.revision, presentation });
        if (saved.revision >= this.account.revision) this.account = saved;
        // A response acknowledges only the draft it sent, never later typing.
        for (const key of ['displayName', 'initials', 'color'] as const) {
          if (key in submitted && this.draft[key] === submitted[key]) delete this.draft[key];
        }
        if (this.active) this.committed(this.account);
        this.emit();
      }
      this.running = false;
      this.emit();
    } catch (error) {
      // Refresh the revision after conflicts or lost responses, retaining the
      // user's draft. Retry is explicit after a failure; edits also retry.
      try { if (this.active) this.refresh(await this.reload()); } catch { /* Keep the last known revision while offline. */ }
      this.running = false;
      this.emit(error instanceof Error ? error.message : 'Could not save your profile.');
    }
  }
}
