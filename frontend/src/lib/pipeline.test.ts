import { describe, expect, it } from 'vitest';

import { friendlyProcessingError } from './pipeline';

describe('friendlyProcessingError', () => {
  it('turns a raw Anthropic error into plain words and keeps the raw text for admins', () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}';
    const r = friendlyProcessingError(raw);
    expect(r.message).toMatch(/out of credit/);
    expect(r.technical).toBe(raw);
  });

  it('maps overload, rate limit and timeout errors', () => {
    expect(friendlyProcessingError('529 {"type":"error","error":{"type":"overloaded_error"}}').message).toMatch(
      /overloaded/,
    );
    expect(friendlyProcessingError('429 {"type":"error","error":{"type":"rate_limit_error"}}').message).toMatch(
      /too many requests/,
    );
    expect(
      friendlyProcessingError('ClaudeTimeoutError: Claude did not finish within 15 minutes\n    at x (y.js:1:1)')
        .message,
    ).toMatch(/took too long/);
  });

  it('passes a plain server message through unchanged', () => {
    const r = friendlyProcessingError('No documents could be read from this email.');
    expect(r).toEqual({ message: 'No documents could be read from this email.', technical: null });
  });

  it('falls back to a generic message for unknown technical text', () => {
    const r = friendlyProcessingError('TypeError: Cannot read properties of undefined (reading "id")');
    expect(r.message).toMatch(/Something went wrong/);
    expect(r.technical).toContain('TypeError');
  });

  it('handles an empty error', () => {
    expect(friendlyProcessingError(null)).toEqual({ message: 'Processing failed.', technical: null });
  });
});
