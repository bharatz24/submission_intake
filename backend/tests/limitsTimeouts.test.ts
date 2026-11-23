import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings → Limits without a database: the overall Claude deadline (streamed answer included), the Gmail request
 * timeout (Gmail API client and Gmail MCP tool calls), the Claude key test's timeout and the text budgets of
 * classification and field extraction, all read on each call.
 */

vi.hoisted(() => {
  process.env.GMAIL_MCP_URL = 'https://mcp.example.test/mcp';
});

const configured = vi.hoisted(() => ({ overrides: {} as Record<string, number> }));
vi.mock('../src/services/limitsSettings.js', async (orig) => {
  const real = await orig<typeof import('../src/services/limitsSettings.js')>();
  return { ...real, limits: () => ({ ...real.limits(), ...configured.overrides }) };
});
vi.mock('../src/services/anthropicSettings.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/anthropicSettings.js')>()),
  anthropicApiKey: () => 'sk-ant-test-key-0123456789',
  anthropicModel: () => 'claude-sonnet-5-5',
}));
const recordLlmCall = vi.hoisted(() => vi.fn());
vi.mock('../src/services/llmUsage.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/llmUsage.js')>()),
  assertLlmBudget: async () => undefined,
  recordLlmCall,
}));

// A Claude stream that never finishes: it only ends when the request's signal aborts.
const streamOptions = vi.hoisted(() => [] as { signal?: AbortSignal }[]);
const streamBodies = vi.hoisted(() => [] as unknown[]);
const retrieveOptions = vi.hoisted(() => [] as { timeout?: number }[]);
vi.mock('@anthropic-ai/sdk', async (orig) => {
  const real = await orig<typeof import('@anthropic-ai/sdk')>();
  class Stalling extends real.default {
    constructor(opts: ConstructorParameters<typeof real.default>[0]) {
      super(opts);
      (this as unknown as { models: unknown }).models = {
        retrieve: async (model: string, _q: unknown, options: { timeout?: number }) => {
          retrieveOptions.push(options);
          return { display_name: model };
        },
      };
      (this as unknown as { beta: unknown }).beta = {
        messages: {
          stream: (body: unknown, options: { signal?: AbortSignal }) => {
            streamOptions.push(options);
            streamBodies.push(body);
            return {
              finalMessage: () =>
                new Promise((_resolve, reject) => {
                  options.signal?.addEventListener('abort', () => reject(new real.APIUserAbortError()));
                }),
            };
          },
        },
      };
    }
  }
  return { ...real, default: Stalling };
});

const gmailApi = vi.hoisted(() => ({ gmail: vi.fn(), oauthClients: 0 }));
vi.mock('googleapis', () => ({
  google: {
    gmail: (opts: unknown) => {
      gmailApi.gmail(opts);
      return { users: { messages: { get: async () => ({ data: { payload: { parts: [] } } }) } } };
    },
    auth: {
      OAuth2: class {
        constructor() {
          gmailApi.oauthClients++;
        }
        setCredentials() {
          /* noop */
        }
      },
    },
  },
}));
const pool = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../src/db/pool.js', () => ({
  pool: { query: async () => ({ rows: pool.rows, rowCount: pool.rows.length }) },
  withTransaction: async () => {
    throw new Error('no database in this test');
  },
}));

const callTool = vi.hoisted(() => vi.fn());
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    onclose?: () => void;
    async connect() {
      /* connected */
    }
    callTool = callTool;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));

const { structuredCall, chatCall } = await import('../src/services/claude.js');
const { ClaudeTimeoutError } = await import('../src/services/llmUsage.js');
const { encrypt } = await import('../src/services/crypto.js');
const gmail = await import('../src/services/gmail.js');
const mcp = await import('../src/services/gmailMcp.js');
const { testAnthropicSettings } = await import('../src/services/anthropicSettings.js');
const { extractFields } = await import('../src/services/fieldExtraction.js');
const { classifyEmail } = await import('../src/services/classification.js');
const { z } = await import('zod');

const skill = { name: 'test-skill', version: '1', files: [], systemPrompt: 'Answer.', overridden: [] };

describe('Claude overall response timeout', () => {
  beforeEach(() => {
    configured.overrides = {};
    recordLlmCall.mockReset();
    streamOptions.length = 0;
  });

  it('ends a stalled structured call with a clear error, recorded as a failed call', async () => {
    configured.overrides = { claudeResponseTimeoutMinutes: 0.001 }; // 60 ms; the setting itself takes whole minutes
    const call = structuredCall({
      skill,
      prompt: 'hi',
      schema: z.object({ ok: z.boolean() }),
      effort: 'low',
      task: 'classification',
      maxTokens: 1000,
    });
    await expect(call).rejects.toThrow(ClaudeTimeoutError);
    await expect(call).rejects.toThrow('Claude did not finish within 0.001 minutes');
    expect(streamOptions[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(recordLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ERROR', error: expect.any(ClaudeTimeoutError) }),
    );
    const err = (await call.catch((e: unknown) => e)) as InstanceType<typeof ClaudeTimeoutError>;
    expect(err).toMatchObject({ status: 504, code: 'LLM_TIMEOUT' });
  });

  it('ends a stalled chat answer the same way', async () => {
    configured.overrides = { claudeResponseTimeoutMinutes: 0.001 };
    await expect(chatCall({ skill, context: 'ctx', messages: [{ role: 'user', content: 'Hello?' }] })).rejects.toThrow(
      ClaudeTimeoutError,
    );
  });

  it('stops a call made inside a job as soon as the job loses its lease, without calling it a timeout', async () => {
    const { withJobSignal, jobLeaseLost } = await import('../src/services/jobContext.js');
    const lease = new AbortController();
    const call = withJobSignal(lease.signal, () =>
      structuredCall({
        skill,
        prompt: 'hi',
        schema: z.object({ ok: z.boolean() }),
        effort: 'low',
        task: 'synthesis',
        maxTokens: 1000,
      }).catch((e: unknown) => ({ err: e, leaseLost: jobLeaseLost() })),
    );
    await vi.waitFor(() => expect(streamOptions).toHaveLength(1));
    lease.abort(new Error('Job lease lost'));
    const { err, leaseLost } = await call;
    expect(err).not.toBeInstanceOf(ClaudeTimeoutError);
    expect(leaseLost).toBe(true); // what the handlers check before recording a failure
    expect(jobLeaseLost()).toBe(false); // outside the job
  });

  it('defaults to 15 minutes', async () => {
    // AbortSignal.timeout runs on the platform's timers, not vitest's fake ones: hand out a signal the test aborts.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      const call = structuredCall({
        skill,
        prompt: 'hi',
        schema: z.object({ ok: z.boolean() }),
        effort: 'low',
        task: 'classification',
        maxTokens: 1000,
      }).catch((e: unknown) => e);
      await vi.waitFor(() => expect(streamOptions).toHaveLength(1));
      expect(timeout).toHaveBeenCalledWith(15 * 60_000);
      deadline.abort();
      const err = await call;
      expect(err).toBeInstanceOf(ClaudeTimeoutError);
      expect((err as Error).message).toBe('Claude did not finish within 15 minutes');
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('Gmail request timeout', () => {
  beforeEach(() => {
    configured.overrides = {};
  });

  it('passes the configured timeout to the Gmail API, rebuilding the client when it changes', async () => {
    pool.rows = [{ id: 'acc-1', email: 'uw@insurer.test', refresh_token_enc: encrypt('refresh-token') }];
    gmail.forgetGmailClient();
    await gmail.gmailAttachmentCount('m1');
    await gmail.gmailAttachmentCount('m2');
    expect(gmailApi.gmail.mock.calls.map(([o]) => (o as { timeout: number }).timeout)).toEqual([60_000]);
    configured.overrides = { gmailTimeoutSeconds: 20 };
    await gmail.gmailAttachmentCount('m3');
    expect(gmailApi.gmail.mock.calls.map(([o]) => (o as { timeout: number }).timeout)).toEqual([60_000, 20_000]);
    // The OAuth client (and its access token) is kept.
    expect(gmailApi.oauthClients).toBe(1);
  });

  it('passes the configured timeout to Gmail MCP tool calls', async () => {
    callTool
      .mockReset()
      .mockResolvedValue({ content: [{ type: 'text', text: '{"messages":[]}' }], structuredContent: { messages: [] } });
    await mcp.searchMessageIds('in:inbox').catch(() => undefined);
    configured.overrides = { gmailTimeoutSeconds: 120 };
    await mcp.searchMessageIds('in:inbox').catch(() => undefined);
    expect(callTool.mock.calls.map((c) => c[2])).toEqual([{ timeout: 60_000 }, { timeout: 120_000 }]);
  });
});

describe('Claude key test timeout', () => {
  beforeEach(() => {
    configured.overrides = {};
    retrieveOptions.length = 0;
  });

  it('uses the Connection test timeout, like every other connection test', async () => {
    await testAnthropicSettings({ apiKey: 'sk-ant-test-key-0123456789', model: 'claude-sonnet-5-5' });
    configured.overrides = { connectionTestTimeoutSeconds: 40 };
    await testAnthropicSettings({ apiKey: 'sk-ant-test-key-0123456789', model: 'claude-sonnet-5-5' });
    expect(retrieveOptions.map((o) => o.timeout)).toEqual([25_000, 40_000]);
  });
});

describe('Text sent to Claude', () => {
  /** The longest run of "x" in the last request Claude was sent: how much of the padded text survived. */
  const keptChars = () => Math.max(...(JSON.stringify(streamBodies.at(-1)).match(/x+/g) ?? ['']).map((m) => m.length));

  beforeEach(() => {
    streamBodies.length = 0;
  });

  it('cuts each extraction source at "Text kept per document (field extraction)"', async () => {
    const sources = [{ documentId: null, label: 'email body', text: 'x'.repeat(100_000), ocrUsed: false }];
    configured.overrides = { claudeResponseTimeoutMinutes: 0.001 };
    await extractFields(sources).catch(() => undefined);
    expect(keptChars()).toBe(60_000);
    configured.overrides = { claudeResponseTimeoutMinutes: 0.001, extractionPerDocChars: 20_000 };
    await extractFields(sources).catch(() => undefined);
    expect(keptChars()).toBe(20_000);
  });

  it('cuts the email body at "Email text read for classification"', async () => {
    const email = {
      fromAddress: 'broker@example.test',
      subject: 'Platform UX Audit',
      bodyText: 'x'.repeat(20_000),
      attachmentNames: [] as string[],
    };
    configured.overrides = { claudeResponseTimeoutMinutes: 0.001 };
    await classifyEmail(email).catch(() => undefined);
    expect(keptChars()).toBe(8000);
    configured.overrides = { claudeResponseTimeoutMinutes: 0.001, classificationBodyChars: 3000 };
    await classifyEmail(email).catch(() => undefined);
    expect(keptChars()).toBe(3000);
  });
});
