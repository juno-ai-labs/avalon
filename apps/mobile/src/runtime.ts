// Loaded from the entry point so the OS can run tasks without mounting React.
import './background';
import { restoreDiagnostics } from './diagnostics';
restoreDiagnostics();

import { installCrashHandler } from './crashes';
installCrashHandler();
