import { describe, expect, test } from 'vitest';
import { DEFAULT_CROSSPOINT_SETTINGS, DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import {
  getCloudSyncProvider,
  isReadestCloudStorageActive,
} from '@/services/sync/cloudSyncProvider';
import { SETTINGS_WHITELIST } from '@/services/sync/adapters/settings';
import type { SystemSettings } from '@/types/settings';

describe('CrossPoint settings boundary', () => {
  test('provides a disconnected device-local default', () => {
    expect(DEFAULT_CROSSPOINT_SETTINGS).toEqual({
      serverUrl: '',
      username: '',
      password: '',
    });
    expect(DEFAULT_SYSTEM_SETTINGS.crosspoint).toEqual(DEFAULT_CROSSPOINT_SETTINGS);
  });

  test('configuring a CrossPoint leaves Readest Cloud selected', () => {
    const settings = {
      webdav: { enabled: false },
      googleDrive: { enabled: false },
      s3: { enabled: false },
      onedrive: { enabled: false },
      crosspoint: {
        ...DEFAULT_CROSSPOINT_SETTINGS,
        serverUrl: '192.168.0.154',
        device: 'X4',
      },
    } as SystemSettings;

    expect(getCloudSyncProvider(settings)).toBe('readest');
    expect(isReadestCloudStorageActive(settings)).toBe(true);
  });

  test('does not replicate any CrossPoint device settings', () => {
    expect(SETTINGS_WHITELIST.some((path) => path.startsWith('crosspoint'))).toBe(false);
  });
});
