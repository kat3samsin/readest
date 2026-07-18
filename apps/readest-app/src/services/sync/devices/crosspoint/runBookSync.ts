import type { Book } from '@/types/book';
import type { CrossPointSettings, SystemSettings, WebDAVSettings } from '@/types/settings';
import type { AppService } from '@/types/system';
import { isTauriAppPlatform, type EnvConfigType } from '@/services/environment';
import { useSettingsStore } from '@/store/settingsStore';
import { createAppLocalStore } from '@/services/sync/file/appLocalStore';
import { isFeedBookUrl } from '@/services/rss/feedBookUrl';
import { createWebDAVProvider } from '@/services/sync/providers/webdav/WebDAVProvider';
import {
  normalizeCrossPointServerUrl,
  probeCrossPointStatus,
  supportsCrossPointProgress,
  type CrossPointProbeResult,
  type CrossPointStatus,
} from './client';
import { sendCrossPointBooks } from './books';
import { buildCrossPointBridgeKey, createCrossPointProgressStateStore } from './progressState';
import { runCrossPointProgressSync, type CrossPointProgressSyncResult } from './progressSync';
import { resolveCrossPointSavedXPointer } from './progressResolver';
import { withCrossPointFeedSnapshots } from './feedBookStore';
import type {
  CrossPointBookProvider,
  CrossPointBookStore,
  CrossPointBookSyncProgress,
  CrossPointBookSyncResult,
} from './types';

export interface CrossPointHydratedBookMarker {
  bookHash: string;
  downloadedAt: number;
}

export interface CrossPointBookRunnerDependencies {
  isNative(): boolean;
  probe(settings: CrossPointSettings): Promise<CrossPointProbeResult | null>;
  createProvider(settings: WebDAVSettings): CrossPointBookProvider;
  createStore(args: {
    appService: AppService;
    settings: SystemSettings;
    envConfig: EnvConfigType;
  }): CrossPointBookStore;
  sendBooks(args: {
    provider: CrossPointBookProvider;
    store: CrossPointBookStore;
    books: Book[];
    onProgress?: (progress: CrossPointBookSyncProgress) => void;
  }): Promise<CrossPointBookSyncResult>;
  syncProgress(
    args: Parameters<typeof runCrossPointProgressSync>[0],
  ): Promise<CrossPointProgressSyncResult>;
  now(): number;
}

export interface RunCrossPointBookSyncInput {
  envConfig: EnvConfigType;
  settings: SystemSettings;
  books: Book[];
  onProgress?: (progress: CrossPointBookSyncProgress) => void;
  preferCrossPointDocuments?: readonly string[];
  /**
   * Persist only this device-local field on the latest live library row.
   * The runner deliberately does not persist a downloaded Book snapshot,
   * because progress may have changed while its cloud file was downloading.
   */
  persistHydratedBookMarkers(markers: CrossPointHydratedBookMarker[]): Promise<void>;
}

export type CrossPointProgressRunResult =
  | { supported: false }
  | { supported: true; sync: CrossPointProgressSyncResult };

export type CrossPointBookRunResult =
  | { ok: false; code: 'DEVICE_UNREACHABLE' }
  | {
      ok: false;
      code: 'DEVICE_CHANGED';
      expectedSerial: string;
      actualSerial: string;
      status: CrossPointStatus;
    }
  | { ok: false; code: 'INCOMPATIBLE_FIRMWARE'; status: CrossPointStatus }
  | {
      ok: false;
      code: 'HYDRATION_FAILED';
      bookHash: string;
      reason: string;
      hydratedBookHashes: string[];
    }
  | {
      ok: false;
      code: 'BOOK_SYNC_PARTIAL';
      status: CrossPointStatus;
      books: CrossPointBookSyncResult;
      progress: CrossPointProgressRunResult;
      hydratedBookHashes: string[];
    }
  | {
      ok: false;
      code: 'PROGRESS_SYNC_PARTIAL';
      status: CrossPointStatus;
      books: CrossPointBookSyncResult;
      progress: Extract<CrossPointProgressRunResult, { supported: true }>;
      hydratedBookHashes: string[];
    }
  | {
      ok: false;
      code: 'BOOK_SYNC_FAILED' | 'SETTINGS_PERSIST_FAILED';
      reason: string;
      status: CrossPointStatus;
      hydratedBookHashes: string[];
      books?: CrossPointBookSyncResult;
      progress?: CrossPointProgressRunResult;
    }
  | {
      ok: true;
      code: 'SUCCESS';
      status: CrossPointStatus;
      books: CrossPointBookSyncResult;
      progress: CrossPointProgressRunResult;
      hydratedBookHashes: string[];
    };

const productionDependencies: CrossPointBookRunnerDependencies = {
  isNative: isTauriAppPlatform,
  probe: probeCrossPointStatus,
  createProvider: (settings) => createWebDAVProvider(settings),
  createStore: (args) => withCrossPointFeedSnapshots(createAppLocalStore(args), args.appService),
  sendBooks: (args) => sendCrossPointBooks(args),
  syncProgress: (args) => runCrossPointProgressSync(args),
  now: () => Date.now(),
};

const reasonFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const activeEpubs = (books: Book[]): Book[] =>
  books.filter((book) => book.format === 'EPUB' && !book.deletedAt);

const buildTransportSettings = (serverUrl: string): WebDAVSettings => ({
  enabled: false,
  serverUrl,
  // CrossPoint's local server does not authenticate requests. Clear legacy
  // persisted fields so an old password cannot be sent to the LAN endpoint.
  username: '',
  password: '',
  rootPath: '/',
});

const persistSuccessfulDeviceState = async ({
  envConfig,
  fallbackSettings,
  status,
  now,
}: {
  envConfig: EnvConfigType;
  fallbackSettings: SystemSettings;
  status: CrossPointStatus;
  now: number;
}): Promise<void> => {
  const settingsStore = useSettingsStore.getState();
  const latest = settingsStore.settings?.crosspoint ? settingsStore.settings : fallbackSettings;
  const crosspoint = {
    ...latest.crosspoint,
    username: '',
    password: '',
    device: status.device,
    lastSyncedAt: now,
  };
  if (status.serial === undefined) {
    delete crosspoint.serial;
  } else {
    crosspoint.serial = status.serial;
  }

  const next = { ...latest, crosspoint };
  await useSettingsStore.getState().saveSettings(envConfig, next);
  useSettingsStore.getState().setSettings(next);
};

/**
 * Send the Readest library to one CrossPoint without entering the Cloud Sync
 * provider registry. WebDAV is constructed directly as a root transport;
 * its `enabled` flag remains false and no cloud-provider activation runs.
 */
const runCrossPointBookSyncUnlocked = async (
  input: RunCrossPointBookSyncInput,
  dependencies: CrossPointBookRunnerDependencies = productionDependencies,
): Promise<CrossPointBookRunResult> => {
  if (!dependencies.isNative()) return { ok: false, code: 'DEVICE_UNREACHABLE' };
  const serverUrl = normalizeCrossPointServerUrl(input.settings.crosspoint.serverUrl);
  if (!serverUrl) return { ok: false, code: 'DEVICE_UNREACHABLE' };

  let appService: AppService;
  try {
    appService = await input.envConfig.getAppService();
  } catch {
    return { ok: false, code: 'DEVICE_UNREACHABLE' };
  }
  if (!appService.isDesktopApp) return { ok: false, code: 'DEVICE_UNREACHABLE' };

  const connection: CrossPointSettings = {
    ...input.settings.crosspoint,
    serverUrl,
    username: '',
    password: '',
  };
  let probe: CrossPointProbeResult | null;
  try {
    probe = await dependencies.probe(connection);
  } catch {
    probe = null;
  }
  if (!probe) return { ok: false, code: 'DEVICE_UNREACHABLE' };
  if (!probe.compatible) {
    return { ok: false, code: 'INCOMPATIBLE_FIRMWARE', status: probe.status };
  }
  const expectedSerial = input.settings.crosspoint.serial?.trim();
  const actualSerial = probe.status.serial?.trim();
  if (
    expectedSerial &&
    actualSerial &&
    expectedSerial.toLowerCase() !== actualSerial.toLowerCase()
  ) {
    return {
      ok: false,
      code: 'DEVICE_CHANGED',
      expectedSerial,
      actualSerial,
      status: probe.status,
    };
  }

  const hydratedBookHashes: string[] = [];
  const hydratedBookMarkers: CrossPointHydratedBookMarker[] = [];
  let provider: CrossPointBookProvider;
  let store: CrossPointBookStore;
  try {
    provider = dependencies.createProvider(buildTransportSettings(serverUrl));
    store = dependencies.createStore({
      appService,
      settings: input.settings,
      envConfig: input.envConfig,
    });
  } catch (error) {
    return {
      ok: false,
      code: 'BOOK_SYNC_FAILED',
      reason: reasonFor(error),
      status: probe.status,
      hydratedBookHashes,
    };
  }

  for (const book of activeEpubs(input.books)) {
    try {
      if (await store.resolveLocalBookPath(book)) {
        if (!book.downloadedAt) {
          hydratedBookMarkers.push({ bookHash: book.hash, downloadedAt: dependencies.now() });
          hydratedBookHashes.push(book.hash);
        }
        continue;
      }
      if (!book.uploadedAt) continue;

      const downloadTarget = { ...book };
      await appService.downloadBook(downloadTarget, false, false);
      if (!(await store.resolveLocalBookPath(book))) {
        throw new Error('Downloaded book is still unavailable locally');
      }

      hydratedBookMarkers.push({
        bookHash: book.hash,
        downloadedAt: downloadTarget.downloadedAt ?? dependencies.now(),
      });
      hydratedBookHashes.push(book.hash);
    } catch (error) {
      return {
        ok: false,
        code: 'HYDRATION_FAILED',
        bookHash: book.hash,
        reason: reasonFor(error),
        hydratedBookHashes,
      };
    }
  }

  if (hydratedBookMarkers.length > 0) {
    try {
      await input.persistHydratedBookMarkers(hydratedBookMarkers);
    } catch (error) {
      return {
        ok: false,
        code: 'HYDRATION_FAILED',
        bookHash: hydratedBookMarkers[0]!.bookHash,
        reason: reasonFor(error),
        hydratedBookHashes,
      };
    }
  }

  let books: CrossPointBookSyncResult;
  try {
    books = await dependencies.sendBooks({
      provider,
      store,
      books: input.books,
      onProgress: input.onProgress,
    });
  } catch (error) {
    return {
      ok: false,
      code: 'BOOK_SYNC_FAILED',
      reason: reasonFor(error),
      status: probe.status,
      hydratedBookHashes,
    };
  }

  let progress: CrossPointProgressRunResult = { supported: false };
  if (supportsCrossPointProgress(probe.status)) {
    const bridgeKey = buildCrossPointBridgeKey({
      serverUrl,
      username: connection.username,
      device: probe.status.device,
      serial: probe.status.serial,
    });
    progress = {
      supported: true,
      sync: await dependencies.syncProgress({
        provider,
        stateStore: createCrossPointProgressStateStore(appService, bridgeKey),
        store,
        // A CrossPoint feed EPUB is a delivery snapshot, while Readest tracks
        // the living book with stable feed-slot CFIs. Do not exchange the
        // snapshot's positional progress with the living book.
        books: input.books.filter((book) => !book.url || !isFeedBookUrl(book.url)),
        manifest: books.manifest,
        resolveXPointer: (book, config) => resolveCrossPointSavedXPointer(appService, book, config),
        preferCrossPointDocuments: input.preferCrossPointDocuments,
      }),
    };
  }

  if (books.failures.length > 0 || books.unavailable > 0) {
    return {
      ok: false,
      code: 'BOOK_SYNC_PARTIAL',
      status: probe.status,
      books,
      progress,
      hydratedBookHashes,
    };
  }

  if (
    progress.supported &&
    (progress.sync.failures.length > 0 || progress.sync.conflicts.length > 0)
  ) {
    return {
      ok: false,
      code: 'PROGRESS_SYNC_PARTIAL',
      status: probe.status,
      books,
      progress,
      hydratedBookHashes,
    };
  }

  try {
    await persistSuccessfulDeviceState({
      envConfig: input.envConfig,
      fallbackSettings: input.settings,
      status: probe.status,
      now: dependencies.now(),
    });
  } catch (error) {
    return {
      ok: false,
      code: 'SETTINGS_PERSIST_FAILED',
      reason: reasonFor(error),
      status: probe.status,
      hydratedBookHashes,
      books,
      progress,
    };
  }

  return {
    ok: true,
    code: 'SUCCESS',
    status: probe.status,
    books,
    progress,
    hydratedBookHashes,
  };
};

let activeCrossPointSync: Promise<CrossPointBookRunResult> | null = null;

export const isCrossPointSyncRunning = (): boolean => activeCrossPointSync !== null;

/** Coalesce remount/concurrent calls without entering the cloud provider registry. */
export const runCrossPointBookSync = (
  input: RunCrossPointBookSyncInput,
  dependencies: CrossPointBookRunnerDependencies = productionDependencies,
): Promise<CrossPointBookRunResult> => {
  if (activeCrossPointSync) return activeCrossPointSync;
  const run = runCrossPointBookSyncUnlocked(input, dependencies);
  activeCrossPointSync = run;
  const clear = () => {
    if (activeCrossPointSync === run) activeCrossPointSync = null;
  };
  void run.then(clear, clear);
  return run;
};
