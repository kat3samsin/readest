import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';

const probeCrossPointStatus = vi.hoisted(() => vi.fn());
const runCrossPointBookSync = vi.hoisted(() => vi.fn());
const persistActiveCloudProvider = vi.hoisted(() => vi.fn());
const isTauriAppPlatform = vi.hoisted(() => vi.fn(() => true));
const saveSettings = vi.hoisted(() => vi.fn(async () => {}));
const loadLibraryBooks = vi.hoisted(() => vi.fn(async () => []));

const envConfig = { getAppService: vi.fn(async () => ({ saveSettings, loadLibraryBooks })) };
const appService = { isDesktopApp: true };

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig,
    appService,
  }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, values?: Record<string, string | number>) =>
    key.replace(/{{(\w+)}}/g, (_match, name: string) => String(values?.[name] ?? '')),
}));

vi.mock('@/services/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/environment')>();
  return { ...actual, isTauriAppPlatform };
});

vi.mock('@/services/sync/devices/crosspoint/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sync/devices/crosspoint/client')>();
  return { ...actual, probeCrossPointStatus };
});

vi.mock('@/services/sync/devices/crosspoint/runBookSync', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/sync/devices/crosspoint/runBookSync')>();
  return { ...actual, runCrossPointBookSync };
});

vi.mock('@/services/sync/cloudSyncActivation', () => ({ persistActiveCloudProvider }));

import CrossPointForm from '@/components/settings/integrations/CrossPointForm';

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const book = {
  hash: HASH,
  format: 'EPUB',
  title: 'Witchcraft for Wayward Girls',
  sourceTitle: 'Witchcraft for Wayward Girls',
  author: 'Grady Hendrix',
  createdAt: 1,
  updatedAt: 1,
} as Book;

const makeSettings = (): SystemSettings =>
  ({
    webdav: {
      enabled: false,
      serverUrl: 'https://cloud.example/dav',
      username: 'cloud-user',
      password: 'cloud-password',
      rootPath: '/Readest',
    },
    googleDrive: { enabled: false, accountLabel: 'reader@example.com' },
    s3: {
      enabled: false,
      endpoint: 'https://s3.example',
      region: 'auto',
      bucket: 'books',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    },
    onedrive: { enabled: false, accountLabel: 'reader@example.com' },
    kosync: { enabled: true, serverUrl: 'https://progress.example' },
    crosspoint: { serverUrl: '', username: '', password: '' },
  }) as SystemSettings;

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

const progressSync = {
  considered: 1,
  sent: 0,
  staged: 0,
  acknowledged: 0,
  waiting: 0,
  repaired: 0,
  unchanged: 1,
  skipped: 0,
  conflicts: [],
  failures: [],
};

const cloudSnapshot = (settings: SystemSettings) =>
  JSON.stringify({
    webdav: settings.webdav,
    googleDrive: settings.googleDrive,
    s3: settings.s3,
    onedrive: settings.onedrive,
    kosync: settings.kosync,
  });

beforeEach(() => {
  vi.clearAllMocks();
  appService.isDesktopApp = true;
  useSettingsStore.setState({ settings: makeSettings() } as never);
  useLibraryStore.setState({
    library: [book],
    libraryLoaded: true,
    hashIndex: new Map([[HASH, 0]]),
    visibleLibrary: [book],
  } as never);
  probeCrossPointStatus.mockResolvedValue({ compatible: true, status });
  runCrossPointBookSync.mockResolvedValue({
    ok: true,
    code: 'SUCCESS',
    status,
    progress: { supported: false },
    hydratedBookHashes: [],
    books: {
      manifest: { version: 1, books: {} },
      considered: 1,
      uploaded: 1,
      recovered: 0,
      skipped: 0,
      unavailable: 0,
      failures: [],
    },
  });
});

afterEach(cleanup);

describe('CrossPointForm', () => {
  test('connects without activating or changing the Readest Cloud provider', async () => {
    const before = cloudSnapshot(useSettingsStore.getState().settings);
    render(<CrossPointForm onBack={() => {}} />);

    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: '192.168.0.154/files' },
    });
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(
      screen.getByText(
        "CrossPoint's current server has no authentication. Use this desktop setup only on a trusted local network.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(probeCrossPointStatus).toHaveBeenCalledOnce());
    expect(probeCrossPointStatus).toHaveBeenCalledWith({
      serverUrl: 'http://192.168.0.154',
      username: '',
      password: '',
    });
    expect(cloudSnapshot(useSettingsStore.getState().settings)).toBe(before);
    expect(useSettingsStore.getState().settings.crosspoint).toMatchObject({
      serverUrl: 'http://192.168.0.154',
      username: '',
      password: '',
      device: 'X4',
      serial: 'CP-123',
    });
    expect(persistActiveCloudProvider).not.toHaveBeenCalled();
    expect(await screen.findByText('Books: supported')).toBeTruthy();
    expect(screen.getByText('Progress: not yet supported')).toBeTruthy();
  });

  test('runs book sync from the live library without changing cloud settings', async () => {
    const configured = makeSettings();
    configured.crosspoint = {
      serverUrl: 'http://192.168.0.154',
      username: 'crosspoint',
      password: 'device-password',
      device: 'X4',
    };
    useSettingsStore.setState({ settings: configured } as never);
    const before = cloudSnapshot(configured);
    render(<CrossPointForm onBack={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sync books' }));

    await waitFor(() => expect(runCrossPointBookSync).toHaveBeenCalledOnce());
    expect(runCrossPointBookSync).toHaveBeenCalledWith(
      expect.objectContaining({
        envConfig,
        settings: configured,
        books: [book],
        persistHydratedBookMarkers: expect.any(Function),
      }),
    );
    expect(cloudSnapshot(useSettingsStore.getState().settings)).toBe(before);
    expect(persistActiveCloudProvider).not.toHaveBeenCalled();
    expect(await screen.findByText('1 book(s) synced to CrossPoint')).toBeTruthy();
  });

  test('requires an explicit reconnect when the connected reader serial changes', async () => {
    const configured = makeSettings();
    configured.crosspoint = {
      serverUrl: 'http://192.168.0.154',
      username: '',
      password: '',
      device: 'X4',
      serial: 'CP-123',
    };
    useSettingsStore.setState({ settings: configured } as never);
    runCrossPointBookSync.mockResolvedValue({
      ok: false,
      code: 'DEVICE_CHANGED',
      expectedSerial: 'CP-123',
      actualSerial: 'CP-999',
      status: { ...status, serial: 'CP-999' },
    });
    render(<CrossPointForm onBack={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sync books' }));

    expect(
      await screen.findByText(
        'The connected reader does not match your saved CrossPoint. Use Test connection to reconnect it explicitly before syncing.',
      ),
    ).toBeTruthy();
  });

  test('says when CrossPoint progress is staged for the matching desktop reader session', async () => {
    const configured = makeSettings();
    configured.crosspoint = {
      serverUrl: 'http://192.168.0.154',
      username: '',
      password: '',
      device: 'X4',
    };
    useSettingsStore.setState({ settings: configured } as never);
    runCrossPointBookSync.mockResolvedValue({
      ok: true,
      code: 'SUCCESS',
      status,
      hydratedBookHashes: [],
      books: {
        manifest: { version: 1, books: {} },
        considered: 1,
        uploaded: 0,
        recovered: 0,
        skipped: 1,
        unavailable: 0,
        failures: [],
      },
      progress: { supported: true, sync: { ...progressSync, staged: 1, unchanged: 0 } },
    });
    render(<CrossPointForm onBack={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sync books' }));

    expect(
      await screen.findByText(
        '1 book(s) synced. 1 CrossPoint progress update(s) were received and will apply when the matching EPUB opens in desktop Readest.',
      ),
    ).toBeTruthy();
  });

  test('surfaces progress failures and conflicts as a partial sync', async () => {
    const configured = makeSettings();
    configured.crosspoint = {
      serverUrl: 'http://192.168.0.154',
      username: '',
      password: '',
      device: 'X4',
    };
    useSettingsStore.setState({ settings: configured } as never);
    runCrossPointBookSync.mockResolvedValue({
      ok: false,
      code: 'PROGRESS_SYNC_PARTIAL',
      status,
      hydratedBookHashes: [],
      books: {
        manifest: { version: 1, books: {} },
        considered: 1,
        uploaded: 0,
        recovered: 0,
        skipped: 1,
        unavailable: 0,
        failures: [],
      },
      progress: {
        supported: true,
        sync: {
          ...progressSync,
          unchanged: 0,
          conflicts: [
            {
              kind: 'BOTH_CHANGED',
              document: HASH,
              baseline: null,
              local: null,
              readestWire: null,
              crosspointWire: null,
            },
          ],
          failures: [{ document: HASH, stage: 'READ', reason: 'network error' }],
        },
      },
    });
    render(<CrossPointForm onBack={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sync books' }));

    expect(
      await screen.findByText(
        'Book files synced, but reading progress finished with 1 failure(s) and 1 conflict(s).',
      ),
    ).toBeTruthy();
  });

  test('does not expose the device connection or sync controls outside the desktop app', () => {
    appService.isDesktopApp = false;
    const configured = makeSettings();
    configured.crosspoint = {
      serverUrl: 'http://192.168.0.154',
      username: 'crosspoint',
      password: 'device-password',
    };
    useSettingsStore.setState({ settings: configured } as never);
    render(<CrossPointForm onBack={() => {}} />);

    expect(
      screen.getByText('CrossPoint device sync is available in the Readest desktop app.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Server URL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync books' })).toBeNull();
  });
});
