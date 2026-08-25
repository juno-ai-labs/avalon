import { describe, expect, it, vi } from 'vitest';
import {
  symbolicateNativeCrash,
  type CrashSymbolicatorExecutor,
  type CrashSymbolicatorProcess,
} from '../src/crash-symbolicator';

function stream(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function processResult(stdout: string, exitCode = 0, stderr = ''): CrashSymbolicatorProcess {
  return {
    kill: vi.fn(),
    output: vi.fn().mockResolvedValue({
      exitCode,
      stdout: new TextEncoder().encode(stdout).buffer,
      stderr: new TextEncoder().encode(stderr).buffer,
    }),
  };
}

describe('native crash symbolicator', () => {
  it('streams only the selected dump and symbol archive into fixed container paths', async () => {
    const calls: Array<{ command: string[]; input: string | null; user: string | undefined }> = [];
    const executor: CrashSymbolicatorExecutor = {
      running: false,
      start: vi.fn(async () => undefined),
      exec: vi.fn(async (command, options) => {
        calls.push({
          command,
          input: options?.stdin ? await new Response(options.stdin).text() : null,
          user: options?.user,
        });
        return command[0] === '/usr/local/bin/rally-symbolicate'
          ? processResult('{"status":"ok","threads":[]}')
          : processResult('');
      }),
    };

    await expect(symbolicateNativeCrash(executor, {
      dump: stream('minidump-bytes'),
      symbols: stream('symbol-archive-bytes'),
    })).resolves.toEqual({
      parserState: 'symbolicated',
      report: { status: 'ok', threads: [] },
    });

    expect(executor.start).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      {
        command: ['mkdir', '-p', '/workspace/symbols'],
        input: null,
        user: 'processor',
      },
      {
        command: ['tee', '/workspace/input.dmp'],
        input: 'minidump-bytes',
        user: 'processor',
      },
      {
        command: ['tee', '/workspace/symbols.tar'],
        input: 'symbol-archive-bytes',
        user: 'processor',
      },
      {
        command: ['tar', '-xf', '/workspace/symbols.tar', '-C', '/workspace/symbols', '--no-same-owner', '--no-same-permissions'],
        input: null,
        user: 'processor',
      },
      {
        command: ['/usr/local/bin/rally-symbolicate', '/workspace/input.dmp', '/workspace/symbols'],
        input: null,
        user: 'processor',
      },
      {
        command: ['rm', '-rf', '/workspace/input.dmp', '/workspace/symbols.tar', '/workspace/symbols'],
        input: null,
        user: 'processor',
      },
    ]);
  });

  it('returns a bounded malformed state for invalid processor output and still cleans up', async () => {
    const commands: string[][] = [];
    const executor: CrashSymbolicatorExecutor = {
      running: true,
      start: vi.fn(async () => undefined),
      exec: vi.fn(async (command) => {
        commands.push(command);
        return command[0] === '/usr/local/bin/rally-symbolicate'
          ? processResult('not-json')
          : processResult('');
      }),
    };

    await expect(symbolicateNativeCrash(executor, {
      dump: stream('dump'),
      symbols: stream('symbols'),
    })).resolves.toEqual({ parserState: 'malformed', report: null });

    expect(executor.start).not.toHaveBeenCalled();
    expect(commands.at(-1)).toEqual([
      'rm',
      '-rf',
      '/workspace/input.dmp',
      '/workspace/symbols.tar',
      '/workspace/symbols',
    ]);
  });

  it('accepts only the processor result states in the container contract', async () => {
    const outputs = [
      '{"status":"unsymbolicated","reason":"symbols_missing"}',
      '{"status":"unexpected","threads":[]}',
    ];
    const executor: CrashSymbolicatorExecutor = {
      running: true,
      start: vi.fn(async () => undefined),
      exec: vi.fn(async (command) => command[0] === '/usr/local/bin/rally-symbolicate'
        ? processResult(outputs.shift() ?? '')
        : processResult('')),
    };

    await expect(symbolicateNativeCrash(executor, {
      dump: stream('dump'),
      symbols: stream('symbols'),
    })).resolves.toEqual({
      parserState: 'unsymbolicated',
      report: { status: 'unsymbolicated', reason: 'symbols_missing' },
    });
    await expect(symbolicateNativeCrash(executor, {
      dump: stream('dump'),
      symbols: stream('symbols'),
    })).resolves.toEqual({ parserState: 'malformed', report: null });
  });

  it('never exposes processor stderr when a command fails', async () => {
    const executor: CrashSymbolicatorExecutor = {
      running: true,
      start: vi.fn(async () => undefined),
      exec: vi.fn(async (command) => command[0] === 'tar'
        ? processResult('', 2, 'user-secret-from-dump')
        : processResult('')),
    };

    const result = symbolicateNativeCrash(executor, {
      dump: stream('dump'),
      symbols: stream('symbols'),
    });

    await expect(result).rejects.toThrow('crash_symbolicator_process_failed');
    await expect(result).rejects.not.toThrow('user-secret-from-dump');
    expect(executor.exec).toHaveBeenLastCalledWith([
      'rm',
      '-rf',
      '/workspace/input.dmp',
      '/workspace/symbols.tar',
      '/workspace/symbols',
    ], { user: 'processor' });
  });

  it('rejects processor reports above the fixed output ceiling', async () => {
    const tooLarge = 'x'.repeat(4 * 1024 * 1024 + 1);
    const executor: CrashSymbolicatorExecutor = {
      running: true,
      start: vi.fn(async () => undefined),
      exec: vi.fn(async (command) => command[0] === '/usr/local/bin/rally-symbolicate'
        ? processResult(tooLarge)
        : processResult('')),
    };

    await expect(symbolicateNativeCrash(executor, {
      dump: stream('dump'),
      symbols: stream('symbols'),
    })).rejects.toThrow('crash_symbolicator_report_too_large');
  });
});
