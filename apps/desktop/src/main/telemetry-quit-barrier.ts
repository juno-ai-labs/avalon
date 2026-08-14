export class TelemetryQuitBarrier {
  private state: 'idle' | 'holding' | 'finished' = 'idle';

  constructor(
    private readonly flush: () => Promise<void>,
    private readonly timeoutMs: number,
  ) {}

  /** Returns whether Electron must prevent this quit attempt. */
  hold(resume: () => void): boolean {
    if (this.state === 'finished') return false;
    if (this.state === 'holding') return true;
    this.state = 'holding';
    const finish = (): void => {
      if (this.state === 'finished') return;
      this.state = 'finished';
      clearTimeout(timer);
      resume();
    };
    const timer = setTimeout(finish, this.timeoutMs);
    void Promise.resolve().then(this.flush).then(finish, finish);
    return true;
  }
}
