import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildCrossPointStatusUrl,
  parseCrossPointStatus,
  probeCrossPointStatus,
  supportsCrossPointProgress,
} from '@/services/sync/devices/crosspoint/client';
import type { CrossPointSettings } from '@/types/settings';

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: vi.fn(() => false),
}));

const originalFetch = globalThis.fetch;

const settings: CrossPointSettings = {
  serverUrl: '192.168.0.154',
  username: 'crosspoint',
  password: 'secret',
};

const status = {
  version: '1.4.1-dev',
  ip: '192.168.0.154',
  mode: 'STA',
  rssi: -60,
  freeHeap: 76_340,
  uptime: 1_997,
  device: 'X4',
  serial: 'CP-123',
  readestSync: {
    protocol: 1,
    books: true,
    progress: false,
    highlights: false,
  },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('parseCrossPointStatus', () => {
  test.each(['X3', 'X4'] as const)('accepts a complete %s response', (device) => {
    expect(parseCrossPointStatus({ ...status, device })).toEqual({ ...status, device });
  });

  test('rejects an incomplete object with a spoofed device field', () => {
    expect(parseCrossPointStatus({ device: 'X4', version: '1.4.1-dev' })).toBeNull();
  });

  test('recognizes upstream firmware without claiming Readest sync compatibility', () => {
    const { readestSync: _readestSync, ...upstreamStatus } = status;
    expect(parseCrossPointStatus(upstreamStatus)).toEqual(upstreamStatus);
  });

  test.each([
    '',
    '   ',
    'Not found',
    ' NOT FOUND ',
  ])('treats the firmware serial sentinel %j as absent', (serial) => {
    const { serial: _serial, ...withoutSerial } = status;
    const parsed = parseCrossPointStatus({ ...status, serial });
    expect(parsed).toEqual(withoutSerial);
    expect(parsed).not.toHaveProperty('serial');
  });

  test('rejects unexpected devices, modes, and field types', () => {
    expect(parseCrossPointStatus({ ...status, device: 'X5' })).toBeNull();
    expect(parseCrossPointStatus({ ...status, mode: 'client' })).toBeNull();
    expect(parseCrossPointStatus({ ...status, uptime: '1997' })).toBeNull();
    expect(parseCrossPointStatus({ ...status, serial: 123 })).toBeNull();
  });

  test('accepts books-only protocol 1 but gates progress on protocol 2', () => {
    const booksOnly = parseCrossPointStatus({
      ...status,
      readestSync: { protocol: 1, books: true, progress: true, highlights: false },
    });
    const progress = parseCrossPointStatus({
      ...status,
      readestSync: { protocol: 2, books: true, progress: true, highlights: false },
    });

    expect(booksOnly?.readestSync?.protocol).toBe(1);
    expect(supportsCrossPointProgress(booksOnly!)).toBe(false);
    expect(supportsCrossPointProgress(progress!)).toBe(true);
  });
});

describe('buildCrossPointStatusUrl', () => {
  test('normalizes a bare LAN IP to the root HTTP status endpoint', () => {
    expect(buildCrossPointStatusUrl(' 192.168.0.154/ ')).toBe('http://192.168.0.154/api/status');
  });

  test('uses the endpoint origin even when the entered URL contains a path', () => {
    expect(buildCrossPointStatusUrl('http://crosspoint.local/files')).toBe(
      'http://crosspoint.local/api/status',
    );
  });

  test('rejects empty and non-HTTP server URLs', () => {
    expect(buildCrossPointStatusUrl('')).toBeNull();
    expect(buildCrossPointStatusUrl('ftp://192.168.0.154')).toBeNull();
  });
});

describe('probeCrossPointStatus', () => {
  test('GETs /api/status and returns the validated status', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(status));

    await expect(probeCrossPointStatus(settings)).resolves.toEqual({
      compatible: true,
      status,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://192.168.0.154/api/status');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ Accept: 'application/json' });
  });

  test('rejects upstream firmware as sync-incompatible with a typed result', async () => {
    const { readestSync: _readestSync, ...upstreamStatus } = status;
    fetchMock.mockResolvedValueOnce(Response.json(upstreamStatus));

    await expect(probeCrossPointStatus(settings)).resolves.toEqual({
      compatible: false,
      code: 'READEST_SYNC_UNSUPPORTED',
      status: upstreamStatus,
    });
  });

  test('accepts progress protocol 2 and rejects newer unknown protocols', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...status,
        readestSync: { ...status.readestSync, protocol: 2 },
      }),
    );

    await expect(probeCrossPointStatus(settings)).resolves.toMatchObject({
      compatible: true,
      status: { readestSync: { protocol: 2 } },
    });

    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...status,
        readestSync: { ...status.readestSync, protocol: 3 },
      }),
    );

    const result = await probeCrossPointStatus(settings);
    expect(result?.compatible).toBe(false);
    expect(result && 'code' in result ? result.code : null).toBe('READEST_SYNC_UNSUPPORTED');
  });

  test('returns null for a non-CrossPoint response or failed request', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ device: 'X4' }));
    await expect(probeCrossPointStatus(settings)).resolves.toBeNull();

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(probeCrossPointStatus(settings)).resolves.toBeNull();
  });
});
