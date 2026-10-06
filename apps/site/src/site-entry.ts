import { initializeSiteTelemetry } from './telemetry';

// Capability pages have no acquisition telemetry, including their fragments.
if (!/^\/download(?:\/|$)/u.test(location.pathname)) initializeSiteTelemetry();
