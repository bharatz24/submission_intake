import { createDriveClient, type DriveClient } from './drive/drive.client.js';
import { createGmailClient, type GmailClient } from './gmail/gmail.client.js';
import { createIms2Client, type Ims2Client } from './ims2/ims2.client.js';
import { createNpiClient, type NpiClient } from './npi/npi.client.js';

export type { DriveClient } from './drive/drive.client.js';
export type { GmailClient } from './gmail/gmail.client.js';
export type { Ims2Client } from './ims2/ims2.client.js';
export type { NpiClient } from './npi/npi.client.js';

/** The external systems the app talks to, one adapter each (external-integrations skill). */
export interface Integrations {
  drive: DriveClient;
  gmail: GmailClient;
  ims2: Ims2Client;
  npi: NpiClient;
}

export function defaultIntegrations(): Integrations {
  return { drive: createDriveClient(), gmail: createGmailClient(), ims2: createIms2Client(), npi: createNpiClient() };
}

let current: Integrations | null = null;

/**
 * The clients background work uses (the pipeline, storage, reconciliation, connection tests), which runs outside any
 * request and so cannot be handed createApp's deps. Created on first use, so importing this module has no effect.
 * HTTP modules take theirs from createApp(deps), which defaults to these.
 */
export function integrations(): Integrations {
  return (current ??= defaultIntegrations());
}

/**
 * Replaces some clients for the whole process (tests: a fake Drive, Gmail, IMS 2 or NPI registry without mocking
 * modules). Returns a function that puts the previous ones back.
 */
export function setIntegrations(overrides: Partial<Integrations>): () => void {
  const previous = integrations();
  current = { ...previous, ...overrides };
  return () => {
    current = previous;
  };
}
