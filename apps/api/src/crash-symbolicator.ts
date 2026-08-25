export interface CrashSymbolicatorProcessOutput {
  exitCode: number;
  stdout: ArrayBuffer;
  stderr: ArrayBuffer;
}

export interface CrashSymbolicatorProcess {
  output(): Promise<CrashSymbolicatorProcessOutput>;
  kill(): Promise<void> | void;
}

export interface CrashSymbolicatorExecutor {
  running: boolean;
  start(): Promise<void>;
  exec(
    command: string[],
    options?: {
      stdin?: ReadableStream<Uint8Array>;
      stdout?: 'ignore';
      user?: string;
    },
  ): Promise<CrashSymbolicatorProcess>;
}

export interface CrashSymbolicationInput {
  dump: ReadableStream<Uint8Array>;
  symbols: ReadableStream<Uint8Array>;
}

export interface CrashSymbolicationResult {
  parserState: 'symbolicated' | 'unsymbolicated' | 'malformed';
  report: unknown;
}

const PROCESSOR_USER = 'processor';
const DUMP_PATH = '/workspace/input.dmp';
const SYMBOL_ARCHIVE_PATH = '/workspace/symbols.tar';
const SYMBOL_DIRECTORY = '/workspace/symbols';
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

async function waitForProcess(
  process: CrashSymbolicatorProcess,
  timeoutMs: number,
): Promise<CrashSymbolicatorProcessOutput> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.output(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void process.kill();
          reject(new Error('crash_symbolicator_timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function execute(
  executor: CrashSymbolicatorExecutor,
  command: string[],
  options: { stdin?: ReadableStream<Uint8Array>; stdout?: 'ignore' } = {},
  timeoutMs = 30_000,
): Promise<CrashSymbolicatorProcessOutput> {
  const process = await executor.exec(command, { ...options, user: PROCESSOR_USER });
  const output = await waitForProcess(process, timeoutMs);
  if (output.exitCode !== 0) throw new Error('crash_symbolicator_process_failed');
  return output;
}

export async function symbolicateNativeCrash(
  executor: CrashSymbolicatorExecutor,
  input: CrashSymbolicationInput,
): Promise<CrashSymbolicationResult> {
  if (!executor.running) await executor.start();

  try {
    await execute(executor, ['mkdir', '-p', SYMBOL_DIRECTORY]);
    await execute(executor, ['tee', DUMP_PATH], { stdin: input.dump, stdout: 'ignore' });
    await execute(executor, ['tee', SYMBOL_ARCHIVE_PATH], { stdin: input.symbols, stdout: 'ignore' });
    await execute(executor, [
      'tar',
      '-xf',
      SYMBOL_ARCHIVE_PATH,
      '-C',
      SYMBOL_DIRECTORY,
      '--no-same-owner',
      '--no-same-permissions',
    ]);
    const output = await execute(executor, [
      '/usr/local/bin/rally-symbolicate',
      DUMP_PATH,
      SYMBOL_DIRECTORY,
    ]);
    if (output.stdout.byteLength > MAX_REPORT_BYTES) {
      throw new Error('crash_symbolicator_report_too_large');
    }

    let report: unknown;
    try {
      report = JSON.parse(new TextDecoder().decode(output.stdout));
    } catch {
      return { parserState: 'malformed', report: null };
    }
    if (!report || typeof report !== 'object' || Array.isArray(report) || !('status' in report)) {
      return { parserState: 'malformed', report: null };
    }
    if (report.status === 'ok') return { parserState: 'symbolicated', report };
    if (report.status === 'unsymbolicated') return { parserState: 'unsymbolicated', report };
    return { parserState: 'malformed', report: null };
  } finally {
    await execute(executor, [
      'rm',
      '-rf',
      DUMP_PATH,
      SYMBOL_ARCHIVE_PATH,
      SYMBOL_DIRECTORY,
    ]);
  }
}
