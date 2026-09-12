import type { AuthorizedConnectorConnection } from "./types";

/** Provider protocol only. The host persists intent and authorizes every call. */
export interface ConnectorRegistration {
  key: string;
  providerId: string | null;
  events: string[];
  destination: string;
  enabled: boolean | null;
}
export interface ConnectorInstallationManagement {
  version: number;
  capability: string;
  events: readonly string[];
  grouping: "single_event" | "grouped";
  signingSecretSource: "host" | "provider";
  canUpdateDestination: boolean;
  support: Readonly<Record<"create" | "inspect" | "update" | "remove" | "rotate" | "reconcileCreate", "automatic" | "manual" | "unsupported">>;
  manualInstructions: string;
  validate(connection: AuthorizedConnectorConnection, signal: AbortSignal): Promise<void>;
  create(connection: AuthorizedConnectorConnection, registration: ConnectorRegistration, secret: string | null, signal: AbortSignal): Promise<{ providerId: string; signingSecret?: string }>;
  inspect(connection: AuthorizedConnectorConnection, registration: ConnectorRegistration, signal: AbortSignal): Promise<ConnectorRegistration | null>;
  update?(connection: AuthorizedConnectorConnection, registration: ConnectorRegistration, signal: AbortSignal): Promise<void>;
  rotation?: {
    /** Must be established by provider delivery/cutover acceptance, never a guessed time window. */
    verificationPolicy: "active" | "active_and_pending";
    dispatch(connection: AuthorizedConnectorConnection, registration: ConnectorRegistration, pendingSecret: string, signal: AbortSignal): Promise<void>;
    verify(connection: AuthorizedConnectorConnection, registration: ConnectorRegistration, pendingSecret: string, signal: AbortSignal): Promise<{ verified: boolean; evidence: string }>;
  };
  remove(connection: AuthorizedConnectorConnection, providerId: string, signal: AbortSignal): Promise<void>;
}
