import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { AppService } from '@/types/system';
import type { EnvConfigType } from '@/services/environment';
import type { CrossPointProbeResult } from '@/services/sync/devices/crosspoint/client';
import type {
  CrossPointBookProvider,
  CrossPointBookStore,
  CrossPointBookSyncResult,
} from '@/services/sync/devices/crosspoint/types';
import { useSettingsStore } from '@/store/settingsStore';

const persistActiveCloudProvider = vi.hoisted(() => vi.fn());
vi.mock('@/services/sync/cloudSyncActivation', () => ({ persistActiveCloudProvider }));

import {
  runCrossPointBookSync,
  type CrossPointBookRunnerDependencies,
  type CrossPointHydratedBookMarker,
} from '@/services/sync/devices/crosspoint/runBookSync';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccc';

const makeBook = (hash: string, overrides: Partial<Book> = {}): Book => ({
  hash,
  format: 'EPUB',
  title: `Book ${hash.slice(0, 4)}`,
  sourceTitle: `Book ${hash.slice(0, 4)}`,
  author: 'Author',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const settings = (): SystemSettings =>
  ({
    version: 1,
    webdav: {
      enabled: false,
      serverUrl: 'https://personal.example/dav',
      username: 'cloud-user',
      password: 'cloud-password',
      rootPath: '/Readest',
      syncBooks: true,
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
    crosspoint: {
      serverUrl: ' 192.168.0.154/files ',
      username: 'crosspoint',
      password: 'device-password',
    },
    kosync: { enabled: true, serverUrl: 'https://sync.example' },
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
  readestSync: { protocol: 1 as const, books: true as const, progress: false, highlights: false },
};

const compatibleProbe: CrossPointProbeResult = { compatible: true, status };

const completeBookResult = (overrides: Partial<CrossPointBookSyncResult> = {}) => ({
  manifest: { version: 1 as const, books: {} },
  considered: 1,
  uploaded: 1,
  recovered: 0,
  skipped: 0,
  unavailable: 0,
  failures: [],
  ...overrides,
});

const makeStore = (available: Set<string> = new Set()): CrossPointBookStore => ({
  resolveLocalBookPath: vi.fn(async (book) =>
    available.has(book.hash) ? { path: `/local/${book.hash}.epub`, size: 42 } : null,
  ),
  loadBookFile: vi.fn(async () => null),
  loadConfig: vi.fn(async () => null),
});

const makeHarness = ({
  probe = compatibleProbe,
  books = [makeBook(HASH_A)],
  store = makeStore(new Set([HASH_A])),
  sendResult = completeBookResult(),
}: {
  probe?: CrossPointProbeResult | null;
  books?: Book[];
  store?: CrossPointBookStore;
  sendResult?: CrossPointBookSyncResult;
} = {}) => {
  const appService = {
    isDesktopApp: true,
    downloadBook: vi.fn(async (book: Book) => {
      book.downloadedAt = 777;
    }),
    saveSettings: vi.fn(async () => {}),
  } as unknown as AppService;
  const envConfig = { getAppService: vi.fn(async () => appService) } as EnvConfigType;
  const provider = {} as CrossPointBookProvider;
  const dependencies: CrossPointBookRunnerDependencies = {
    isNative: vi.fn(() => true),
    probe: vi.fn(async () => probe),
    createProvider: vi.fn(() => provider),
    createStore: vi.fn(() => store),
    sendBooks: vi.fn(async () => sendResult),
    syncProgress: vi.fn(async () => ({
      considered: 0,
      sent: 0,
      staged: 0,
      acknowledged: 0,
      waiting: 0,
      repaired: 0,
      unchanged: 0,
      skipped: 0,
      conflicts: [],
      failures: [],
    })),
    now: vi.fn(() => 999),
  };
  const persistHydratedBookMarkers = vi.fn(async (_markers: CrossPointHydratedBookMarker[]) => {});

  return {
    appService,
    envConfig,
    provider,
    dependencies,
    books,
    persistHydratedBookMarkers,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: settings() });
});

describe('runCrossPointBookSync', () => {
  test('rejects non-native execution before probing the LAN device', async () => {
    const harness = makeHarness();
    vi.mocked(harness.dependencies.isNative).mockReturnValue(false);

    await expect(
      runCrossPointBookSync(
        {
          envConfig: harness.envConfig,
          settings: settings(),
          books: harness.books,
          persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
        },
        harness.dependencies,
      ),
    ).resolves.toEqual({ ok: false, code: 'DEVICE_UNREACHABLE' });
    expect(harness.dependencies.probe).not.toHaveBeenCalled();
  });

  test('rejects mobile Tauri execution before probing the LAN device', async () => {
    const harness = makeHarness();
    harness.appService.isDesktopApp = false;

    await expect(
      runCrossPointBookSync(
        {
          envConfig: harness.envConfig,
          settings: settings(),
          books: harness.books,
          persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
        },
        harness.dependencies,
      ),
    ).resolves.toEqual({ ok: false, code: 'DEVICE_UNREACHABLE' });
    expect(harness.dependencies.probe).not.toHaveBeenCalled();
  });

  test('uses WebDAV only as a root transport and updates only CrossPoint success metadata', async () => {
    const harness = makeHarness();
    const initial = settings();
    useSettingsStore.setState({ settings: initial });
    const cloudBefore = JSON.stringify({
      webdav: initial.webdav,
      googleDrive: initial.googleDrive,
      s3: initial.s3,
      onedrive: initial.onedrive,
      kosync: initial.kosync,
    });

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: initial,
        books: harness.books,
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(harness.dependencies.probe).toHaveBeenCalledWith({
      ...initial.crosspoint,
      serverUrl: 'http://192.168.0.154',
      username: '',
      password: '',
    });
    expect(harness.dependencies.createProvider).toHaveBeenCalledWith({
      enabled: false,
      serverUrl: 'http://192.168.0.154',
      username: '',
      password: '',
      rootPath: '/',
    });
    expect(harness.dependencies.createStore).toHaveBeenCalledWith({
      appService: harness.appService,
      settings: initial,
      envConfig: harness.envConfig,
    });
    expect(harness.dependencies.sendBooks).toHaveBeenCalledWith({
      provider: harness.provider,
      store: expect.any(Object),
      books: harness.books,
    });

    expect(result).toMatchObject({
      ok: true,
      code: 'SUCCESS',
      hydratedBookHashes: [HASH_A],
      progress: { supported: false },
    });
    expect(harness.appService.saveSettings).toHaveBeenCalledOnce();
    const persisted = vi.mocked(harness.appService.saveSettings).mock.calls[0]?.[0];
    expect(persisted?.crosspoint).toEqual({
      ...initial.crosspoint,
      username: '',
      password: '',
      device: 'X4',
      serial: 'CP-123',
      lastSyncedAt: 999,
    });
    expect(
      JSON.stringify({
        webdav: persisted?.webdav,
        googleDrive: persisted?.googleDrive,
        s3: persisted?.s3,
        onedrive: persisted?.onedrive,
        kosync: persisted?.kosync,
      }),
    ).toBe(cloudBefore);
    expect(persistActiveCloudProvider).not.toHaveBeenCalled();
  });

  test('returns DEVICE_UNREACHABLE before constructing a provider when probing fails', async () => {
    const harness = makeHarness({ probe: null });

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: settings(),
        books: harness.books,
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(result).toEqual({ ok: false, code: 'DEVICE_UNREACHABLE' });
    expect(harness.dependencies.createProvider).not.toHaveBeenCalled();
    expect(harness.appService.saveSettings).not.toHaveBeenCalled();
  });

  test('returns INCOMPATIBLE_FIRMWARE for a CrossPoint without the book protocol', async () => {
    const incompatible: CrossPointProbeResult = {
      compatible: false,
      code: 'READEST_SYNC_UNSUPPORTED',
      status: { ...status, readestSync: undefined },
    };
    const harness = makeHarness({ probe: incompatible });

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: settings(),
        books: harness.books,
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'INCOMPATIBLE_FIRMWARE',
      status: incompatible.status,
    });
    expect(harness.dependencies.createProvider).not.toHaveBeenCalled();
  });

  test('refuses a different physical reader when both serials are known', async () => {
    const harness = makeHarness();
    const saved = settings();
    saved.crosspoint.serial = 'CP-OTHER';

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: saved,
        books: harness.books,
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'DEVICE_CHANGED',
      expectedSerial: 'CP-OTHER',
      actualSerial: 'CP-123',
    });
    expect(harness.dependencies.createProvider).not.toHaveBeenCalled();
  });

  test('runs progress only for protocol 2 with progress capability', async () => {
    const progressStatus = {
      ...status,
      readestSync: {
        protocol: 2 as const,
        books: true as const,
        progress: true,
        highlights: false,
      },
    };
    const harness = makeHarness({
      probe: { compatible: true, status: progressStatus },
      sendResult: completeBookResult({
        manifest: {
          version: 1,
          books: {
            [HASH_A]: { path: '/Book.epub', size: 42, revision: 1, state: 'active' },
          },
        },
      }),
    });

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: settings(),
        books: harness.books,
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(harness.dependencies.syncProgress).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, progress: { supported: true } });
  });

  test('does not report success when progress has failures or conflicts', async () => {
    const progressStatus = {
      ...status,
      readestSync: {
        protocol: 2 as const,
        books: true as const,
        progress: true,
        highlights: false,
      },
    };
    const harness = makeHarness({ probe: { compatible: true, status: progressStatus } });
    vi.mocked(harness.dependencies.syncProgress).mockResolvedValue({
      considered: 1,
      sent: 0,
      staged: 0,
      acknowledged: 0,
      waiting: 0,
      repaired: 0,
      unchanged: 0,
      skipped: 0,
      conflicts: [],
      failures: [{ document: HASH_A, stage: 'READ', reason: 'device busy' }],
    });

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: settings(),
        books: harness.books,
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'PROGRESS_SYNC_PARTIAL',
      progress: { supported: true, sync: { failures: [{ reason: 'device busy' }] } },
    });
    expect(harness.appService.saveSettings).not.toHaveBeenCalled();
  });

  test('coalesces concurrent calls through the process-level CrossPoint mutex', async () => {
    const harness = makeHarness();
    let releaseProbe!: () => void;
    vi.mocked(harness.dependencies.probe).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseProbe = () => resolve(compatibleProbe);
        }),
    );
    const input = {
      envConfig: harness.envConfig,
      settings: settings(),
      books: harness.books,
      persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
    };

    const first = runCrossPointBookSync(input, harness.dependencies);
    const second = runCrossPointBookSync(input, harness.dependencies);

    expect(second).toBe(first);
    await vi.waitFor(() => expect(harness.dependencies.probe).toHaveBeenCalledOnce());
    releaseProbe();
    await Promise.all([first, second]);
    expect(harness.dependencies.sendBooks).toHaveBeenCalledOnce();
  });

  test('hydrates cloud-only EPUBs sequentially and persists field-scoped markers before send', async () => {
    const books = [
      makeBook(HASH_A, { uploadedAt: 100 }),
      makeBook(HASH_B, { uploadedAt: 200 }),
      makeBook(HASH_C),
    ];
    const available = new Set([HASH_C]);
    const store = makeStore(available);
    const harness = makeHarness({
      books,
      store,
      sendResult: completeBookResult({ considered: 3 }),
    });
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(harness.appService.downloadBook).mockImplementation(async (book) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`download:${book.hash}`);
      await Promise.resolve();
      book.downloadedAt = book.hash === HASH_A ? 701 : 702;
      available.add(book.hash);
      inFlight -= 1;
    });
    harness.persistHydratedBookMarkers.mockImplementation(async (markers) => {
      events.push(
        `persist:${markers.map((marker) => `${marker.bookHash}:${marker.downloadedAt}`).join(',')}`,
      );
    });
    vi.mocked(harness.dependencies.sendBooks).mockImplementation(async () => {
      events.push('send');
      return completeBookResult({ considered: 3 });
    });

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: settings(),
        books,
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(maxInFlight).toBe(1);
    expect(events).toEqual([
      `download:${HASH_A}`,
      `download:${HASH_B}`,
      `persist:${HASH_A}:701,${HASH_B}:702,${HASH_C}:999`,
      'send',
    ]);
    expect(result).toMatchObject({
      ok: true,
      code: 'SUCCESS',
      hydratedBookHashes: [HASH_A, HASH_B, HASH_C],
    });
    expect(books[0]?.downloadedAt).toBeUndefined();
    expect(books[1]?.downloadedAt).toBeUndefined();
  });

  test('returns HYDRATION_FAILED without sending when a cloud download fails', async () => {
    const book = makeBook(HASH_A, { uploadedAt: 100 });
    const harness = makeHarness({ books: [book], store: makeStore() });
    vi.mocked(harness.appService.downloadBook).mockRejectedValue(new Error('cloud offline'));

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: settings(),
        books: [book],
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(result).toEqual({
      ok: false,
      code: 'HYDRATION_FAILED',
      bookHash: HASH_A,
      reason: 'cloud offline',
      hydratedBookHashes: [],
    });
    expect(harness.dependencies.sendBooks).not.toHaveBeenCalled();
    expect(harness.appService.saveSettings).not.toHaveBeenCalled();
  });

  test('returns HYDRATION_FAILED when its field-scoped marker cannot be persisted', async () => {
    const book = makeBook(HASH_A, { uploadedAt: 100 });
    const available = new Set<string>();
    const harness = makeHarness({ books: [book], store: makeStore(available) });
    vi.mocked(harness.appService.downloadBook).mockImplementation(async (target) => {
      target.downloadedAt = 701;
      available.add(target.hash);
    });
    harness.persistHydratedBookMarkers.mockRejectedValue(new Error('library save failed'));

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: settings(),
        books: [book],
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'HYDRATION_FAILED',
      bookHash: HASH_A,
      reason: 'library save failed',
    });
    expect(harness.dependencies.sendBooks).not.toHaveBeenCalled();
  });

  test('returns BOOK_SYNC_PARTIAL and does not stamp success for failures or unavailable books', async () => {
    const partial = completeBookResult({
      considered: 2,
      uploaded: 0,
      unavailable: 1,
      failures: [{ bookHash: HASH_A, reason: 'PUT failed' }],
    });
    const harness = makeHarness({ sendResult: partial });

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: settings(),
        books: harness.books,
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(result).toMatchObject({ ok: false, code: 'BOOK_SYNC_PARTIAL', books: partial });
    expect(harness.appService.saveSettings).not.toHaveBeenCalled();
  });

  test('returns BOOK_SYNC_FAILED when the device transfer throws', async () => {
    const harness = makeHarness();
    vi.mocked(harness.dependencies.sendBooks).mockRejectedValue(new Error('manifest rejected'));

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: settings(),
        books: harness.books,
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'BOOK_SYNC_FAILED',
      reason: 'manifest rejected',
    });
    expect(harness.appService.saveSettings).not.toHaveBeenCalled();
  });

  test('returns SETTINGS_PERSIST_FAILED when the final local marker cannot be saved', async () => {
    const harness = makeHarness();
    vi.mocked(harness.appService.saveSettings).mockRejectedValue(new Error('disk full'));

    const result = await runCrossPointBookSync(
      {
        envConfig: harness.envConfig,
        settings: settings(),
        books: harness.books,
        persistHydratedBookMarkers: harness.persistHydratedBookMarkers,
      },
      harness.dependencies,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'SETTINGS_PERSIST_FAILED',
      reason: 'disk full',
    });
    expect(useSettingsStore.getState().settings.crosspoint.lastSyncedAt).toBeUndefined();
  });
});
