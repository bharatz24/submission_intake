import { z } from 'zod';

/**
 * The frontend's build-time configuration (Vite `VITE_*` variables), parsed once with Zod so a bad value fails loudly
 * at startup instead of as a broken request later. Read configuration from here, never from `import.meta.env` directly.
 */
const EnvSchema = z.object({
  /** Where the API lives: `/api` (same origin, the default) or an absolute URL. */
  VITE_API_BASE: z.union([z.string().regex(/^\//, 'must start with /'), z.url()]).optional(),
  /** How new-email notifications arrive: `sse` (a held stream, the default) or `poll` (serverless hosts, no streams). */
  VITE_EVENTS_TRANSPORT: z.enum(['sse', 'poll']).default('sse'),
  /** How files are uploaded: `direct` (one multipart request, the default) or `chunked` (3 MiB parts; serverless hosts). */
  VITE_UPLOAD_MODE: z.enum(['direct', 'chunked']).default('direct'),
  MODE: z.string().default('production'),
  DEV: z.boolean().default(false),
});

const raw: Record<string, unknown> =
  typeof import.meta !== 'undefined' && import.meta.env ? { ...import.meta.env } : {};
// An empty VITE_API_BASE= line means "not set".
for (const key of ['VITE_API_BASE', 'VITE_EVENTS_TRANSPORT', 'VITE_UPLOAD_MODE']) if (raw[key] === '') delete raw[key];

const parsed = EnvSchema.safeParse(raw);
if (!parsed.success) {
  throw new Error(
    `Invalid frontend configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  );
}

export type EventsTransport = z.infer<typeof EnvSchema>['VITE_EVENTS_TRANSPORT'];

export const env = {
  apiBase: parsed.data.VITE_API_BASE ?? '/api',
  eventsTransport: parsed.data.VITE_EVENTS_TRANSPORT,
  uploadMode: parsed.data.VITE_UPLOAD_MODE,
  mode: parsed.data.MODE,
  isDev: parsed.data.DEV,
} as const;
