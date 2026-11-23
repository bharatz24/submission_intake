import { describe, expect, it } from 'vitest';

import { isInvalidGrant } from '../src/services/gmail.js';
import { mcpUrl } from '../src/services/gmailMcp.js';

describe('Gmail OAuth failure detection', () => {
  it('recognises invalid_grant from gaxios responses and plain errors', () => {
    expect(
      isInvalidGrant({
        message: 'invalid_grant',
        response: { data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
      }),
    ).toBe(true);
    expect(isInvalidGrant(new Error('invalid_grant: Token has been expired or revoked.'))).toBe(true);
    expect(isInvalidGrant(new Error('Request failed with status code 500'))).toBe(false);
    expect(isInvalidGrant({ response: { data: { error: 'rate_limited' } } })).toBe(false);
    expect(isInvalidGrant(null)).toBe(false);
  });
});

describe('Gmail MCP URL policy', () => {
  it('requires https except for localhost', () => {
    expect(mcpUrl('https://mcp.example.com/mcp').href).toBe('https://mcp.example.com/mcp');
    expect(mcpUrl('http://localhost:8080/mcp').hostname).toBe('localhost');
    expect(mcpUrl('http://127.0.0.1:8080/mcp').hostname).toBe('127.0.0.1');
    expect(mcpUrl('http://[::1]:8080/mcp').port).toBe('8080');
    expect(() => mcpUrl('http://mcp.example.com/mcp')).toThrow(/https/);
    expect(() => mcpUrl('ftp://localhost/mcp')).toThrow(/https/);
  });
});
