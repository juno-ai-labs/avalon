import { isMobileOs } from './device';
import { initializeSiteTelemetry } from './telemetry';

// The header offers the web app instead of the Mac download on phones and tablets.
if (isMobileOs(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)) document.documentElement.dataset['mobileOs'] = '';

// Capability pages have no acquisition telemetry, including their fragments.
if (!/^\/download(?:\/|$)/u.test(location.pathname)) initializeSiteTelemetry();
