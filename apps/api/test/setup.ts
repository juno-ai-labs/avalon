/**
 * Per-test resets for module state that production keeps for an isolate's
 * life. Both the Node and the workerd configs load this file.
 */
import { afterEach } from "vitest";

import { clearMemoryScopeCache } from "../src/services/memory-scope-cache";

// Fixtures re-create memory scopes under the same key with new ids, which
// production never does (docs/agent-harness.md, scoped durable memory).
afterEach(() => clearMemoryScopeCache());
