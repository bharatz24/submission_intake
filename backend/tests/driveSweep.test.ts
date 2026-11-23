/**
 * Unit tests for the Drive orphan sweep's safety limit in services/reconcile.ts (no network, no database).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.GOOGLE_REFRESH_TOKEN = 'refresh-token';
process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.GDRIVE_ORPHAN_SWEEP_MAX = '2';

const fake = vi.hoisted(() => ({
  driveFiles: [] as string[],
  knownIds: [] as string[],
  queries: 0,
  trashDriveFile: vi.fn(async () => undefined),
  recordSystemError: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
}));

vi.mock('../src/db/pool.js', () => ({
  pool: {
    query: async () => {
      fake.queries++;
      return { rows: fake.knownIds.map((storage_key) => ({ storage_key })) };
    },
  },
}));
vi.mock('../src/services/audit.js', () => ({ audit: fake.audit, recordSystemError: fake.recordSystemError }));
vi.mock('../src/services/gmail.js', () => ({}));
vi.mock('../src/services/ingestQueue.js', () => ({}));
vi.mock('../src/services/driveStorage.js', () => ({
  trashDriveFile: fake.trashDriveFile,
  listAppFiles: async function* () {
    for (const id of fake.driveFiles) yield { id, name: `${id}.pdf`, documentId: null };
  },
}));

const { sweepDriveOrphans } = await import('../src/services/reconcile.js');

beforeEach(() => {
  for (const fn of [fake.trashDriveFile, fake.recordSystemError, fake.audit]) fn.mockClear();
  fake.knownIds = ['kept'];
  fake.queries = 0;
});

describe('sweepDriveOrphans', () => {
  it('trashes orphans up to the limit and keeps known files', async () => {
    fake.driveFiles = ['kept', 'orphan-1', 'orphan-2'];
    expect(await sweepDriveOrphans()).toBe(2);
    expect(fake.trashDriveFile.mock.calls.map(([id]: any) => id)).toEqual(['orphan-1', 'orphan-2']);
    expect(fake.audit).toHaveBeenCalledTimes(1);
    expect(fake.recordSystemError).not.toHaveBeenCalled();
  });

  it('trashes nothing and fails above the limit', async () => {
    fake.driveFiles = ['kept', 'orphan-1', 'orphan-2', 'orphan-3'];
    await expect(sweepDriveOrphans()).rejects.toThrow('GDRIVE_ORPHAN_SWEEP_MAX');
    expect(fake.trashDriveFile).not.toHaveBeenCalled();
  });

  it('stops scanning once the limit is passed', async () => {
    fake.driveFiles = Array.from({ length: 1000 }, (_, i) => `orphan-${i}`);
    await expect(sweepDriveOrphans()).rejects.toThrow('GDRIVE_ORPHAN_SWEEP_MAX');
    expect(fake.queries).toBe(1);
  });
});
