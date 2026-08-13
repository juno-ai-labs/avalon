import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";

type LifecycleProvider = Pick<
  TerminalSandboxProvider,
  "archiveSandbox" | "startSandbox" | "stopSandbox"
>;

type LifecyclePhase = "restart" | "restore";

export async function verifyTerminalRestartAndRestore(
  provider: LifecycleProvider,
  sandboxId: string,
  verifyWorkspace: (phase: LifecyclePhase) => Promise<void>,
): Promise<void> {
  await provider.stopSandbox(sandboxId);
  await provider.startSandbox(sandboxId);
  await verifyWorkspace("restart");

  // Daytona accepts archive requests only while the sandbox is stopped.
  await provider.stopSandbox(sandboxId);
  await provider.archiveSandbox(sandboxId);
  await provider.startSandbox(sandboxId);
  await verifyWorkspace("restore");
}
