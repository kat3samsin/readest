import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectCrossPoint } from '@/services/sync/devices/crosspoint/connect';
import { useSettingsStore } from '@/store/settingsStore';

const probeCrossPointStatus = vi.hoisted(() => vi.fn());
const saveSettings = vi.hoisted(() => vi.fn(async () => {}));
const envConfig = {
  getAppService: vi.fn(async () => ({ saveSettings })),
} as never;

vi.mock('@/services/sync/devices/crosspoint/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sync/devices/crosspoint/client')>();
  return { ...actual, probeCrossPointStatus };
});

const status = {
  version: '1.5.0-katre',
  ip: '192.168.0.154',
  mode: 'STA' as const,
  rssi: -55,
  freeHeap: 76_000,
  uptime: 100,
  device: 'X4' as const,
  serial: 'CP-123',
  readestSync: { protocol: 1 as const, books: true as const, progress: true, highlights: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({
    settings: {
      autoUpload: false,
      crosspoint: { serverUrl: '', username: '', password: '' },
    },
  } as never);
  probeCrossPointStatus.mockResolvedValue({ compatible: true, status });
});

describe('connectCrossPoint', () => {
  it('normalizes, probes, and persists the X4 address without changing other settings', async () => {
    const result = await connectCrossPoint(envConfig, '192.168.0.154/files');

    expect(result).toEqual({ ok: true, status, serverUrl: 'http://192.168.0.154' });
    expect(probeCrossPointStatus).toHaveBeenCalledWith({
      serverUrl: 'http://192.168.0.154',
      username: '',
      password: '',
    });
    expect(useSettingsStore.getState().settings).toMatchObject({
      autoUpload: false,
      crosspoint: {
        serverUrl: 'http://192.168.0.154',
        username: '',
        password: '',
        device: 'X4',
        serial: 'CP-123',
      },
    });
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it('rejects an invalid address before probing', async () => {
    await expect(connectCrossPoint(envConfig, 'not an address')).resolves.toEqual({
      ok: false,
      code: 'INVALID_ADDRESS',
    });
    expect(probeCrossPointStatus).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('does not save an unreachable device', async () => {
    probeCrossPointStatus.mockResolvedValue(null);

    await expect(connectCrossPoint(envConfig, '192.168.0.155')).resolves.toEqual({
      ok: false,
      code: 'DEVICE_UNREACHABLE',
    });
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
