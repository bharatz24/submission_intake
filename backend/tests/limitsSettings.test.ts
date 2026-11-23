import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Settings → Limits without a database: the defaults before anything is loaded, and consumers reading limits() per call. */

const structuredCall = vi.fn();
vi.mock('../src/services/claude.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/claude.js')>()),
  claudeAvailable: () => true,
  structuredCall: (...args: unknown[]) => structuredCall(...args),
}));
// Rules that never decide on their own, so every email goes to Claude.
vi.mock('../src/services/classificationRules.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/classificationRules.js')>()),
  applyRules: () => ({ decisive: null, score: 2, reasons: ['+2: mentions malpractice'], submissionEvidence: false }),
}));
const recordSystemError = vi.fn();
vi.mock('../src/services/audit.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/audit.js')>()),
  recordSystemError: (...args: unknown[]) => recordSystemError(...args),
}));
const configured = vi.hoisted(() => ({ overrides: {} as Record<string, number> }));
vi.mock('../src/services/limitsSettings.js', async (orig) => {
  const real = await orig<typeof import('../src/services/limitsSettings.js')>();
  return { ...real, limits: () => ({ ...real.limits(), ...configured.overrides }) };
});

const { ClaudeTruncatedError } = await import('../src/services/llmUsage.js');
const { classifyEmail, clearRecentVerdicts } = await import('../src/services/classification.js');
const { extractFields } = await import('../src/services/fieldExtraction.js');
const real = await vi.importActual<typeof import('../src/services/limitsSettings.js')>(
  '../src/services/limitsSettings.js',
);

const email = {
  fromAddress: 'broker@acme.test',
  subject: 'Quote request',
  bodyText: 'Please quote',
  attachmentNames: [] as string[],
};
const verdict = {
  data: { classification: 'SUBMISSION', confidence: 0.9, reasons: ['Asks for a quote'] },
  usage: { inputTokens: 1, outputTokens: 1 },
  model: 'm',
};

describe('limits settings', () => {
  beforeEach(() => {
    clearRecentVerdicts();
    configured.overrides = {};
    structuredCall.mockReset().mockResolvedValue(verdict);
    recordSystemError.mockReset();
  });

  it('returns the code defaults, clamped into their bounds, when nothing is loaded', () => {
    expect(real.limits()).toEqual(real.LIMIT_DEFAULTS);
    expect(real.LIMIT_KEYS).toHaveLength(20);
    expect(real.LIMIT_KEYS).not.toContain('classificationRetryMaxTokens');
    expect(real.LIMIT_KEYS).not.toContain('extractionRetryMaxTokens');
    expect(real.LIMIT_DEFAULTS).toMatchObject({
      classificationMaxTokens: 16_000,
      extractionMaxTokens: 64_000,
      uploadMaxFileMb: 25,
      npiTimeoutSeconds: 15,
      reportPerDocChars: 80_000,
      extractionPerDocChars: 60_000,
      classificationBodyChars: 8000,
    });
    for (const key of real.LIMIT_KEYS) {
      expect(real.LIMIT_DEFAULTS[key]).toBeGreaterThanOrEqual(real.LIMIT_BOUNDS[key].min);
      expect(real.LIMIT_DEFAULTS[key]).toBeLessThanOrEqual(real.LIMIT_BOUNDS[key].max);
    }
    expect(real.LIMIT_BOUNDS.classificationMaxTokens).toEqual({ min: 1000, max: 64_000 });
    expect(real.LIMIT_BOUNDS.extractionMaxTokens).toEqual({ min: 8000, max: 64_000 });
  });

  it('classification makes exactly one Claude call with the configured output limit', async () => {
    configured.overrides = { classificationMaxTokens: 6000 };
    await classifyEmail(email);
    expect(structuredCall.mock.calls.map(([p]) => (p as { maxTokens: number }).maxTokens)).toEqual([6000]);

    // Read on each call, not at load: a later change applies to the next email.
    configured.overrides = { classificationMaxTokens: 8000 };
    await classifyEmail({ ...email, subject: 'Another quote request' });
    expect((structuredCall.mock.calls.at(-1)![0] as { maxTokens: number }).maxTokens).toBe(8000);
  });

  it('classification does not retry a cut-off answer: the error of the one call is thrown', async () => {
    structuredCall.mockRejectedValueOnce(new ClaudeTruncatedError('cut off'));
    await expect(classifyEmail(email)).rejects.toBeInstanceOf(ClaudeTruncatedError);
    expect(structuredCall).toHaveBeenCalledTimes(1);
  });

  it('extraction makes exactly one Claude call with the configured output limit, and no retry when cut off', async () => {
    const sources = [
      { documentId: null, label: 'email body', text: 'Applicant: Jane Smith, NPI 1234567893', ocrUsed: false },
    ];
    configured.overrides = { extractionMaxTokens: 20_000 };
    structuredCall.mockResolvedValueOnce({
      data: { fields: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    });
    await extractFields(sources);
    expect(structuredCall.mock.calls.map(([p]) => (p as { maxTokens: number }).maxTokens)).toEqual([20_000]);

    // A cut-off answer falls back to the NPI regex after that single call.
    structuredCall.mockReset().mockRejectedValueOnce(new ClaudeTruncatedError('cut off'));
    const fields = await extractFields(sources);
    expect(structuredCall).toHaveBeenCalledTimes(1);
    expect(fields.map((f) => f.fieldName)).toEqual(['npi']);
    expect(recordSystemError).toHaveBeenCalledTimes(1);
  });
});
