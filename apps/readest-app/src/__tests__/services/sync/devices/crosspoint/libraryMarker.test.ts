import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { EnvConfigType } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import {
  persistCrossPointHydratedBookMarker,
  persistCrossPointHydratedBookMarkers,
} from '@/services/sync/devices/crosspoint/libraryMarker';

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const makeBook = (overrides: Partial<Book> = {}): Book => ({
  hash: HASH,
  format: 'EPUB',
  title: 'Current title',
  sourceTitle: 'Current title',
  author: 'Current author',
  progress: [26, 100],
  updatedAt: 50,
  createdAt: 1,
  ...overrides,
});

beforeEach(() => {
  useLibraryStore.setState({
    library: [],
    libraryLoaded: false,
    hashIndex: new Map(),
    visibleLibrary: [],
  } as never);
});

describe('persistCrossPointHydratedBookMarker', () => {
  test('patches only downloadedAt on the latest live row and preserves concurrent progress', async () => {
    const latest = makeBook({ progress: [27, 100], updatedAt: 75, groupName: 'Fiction' });
    useLibraryStore.getState().setLibrary([latest]);
    const saveLibraryBooks = vi.fn(async (_books: Book[]) => {});
    const appService = { saveLibraryBooks } as unknown as AppService;
    const envConfig = { getAppService: vi.fn(async () => appService) } as EnvConfigType;

    await persistCrossPointHydratedBookMarker(envConfig, {
      bookHash: HASH,
      downloadedAt: 900,
    });

    const persisted = saveLibraryBooks.mock.calls[0]?.[0]?.[0];
    expect(persisted).toEqual({ ...latest, downloadedAt: 900 });
    expect(persisted?.progress).toEqual([27, 100]);
    expect(persisted?.updatedAt).toBe(75);
    expect(useLibraryStore.getState().getBookByHash(HASH)).toEqual({
      ...latest,
      downloadedAt: 900,
    });
  });

  test('hydrates the library before patching instead of saving against an empty store', async () => {
    const onDisk = makeBook({ progress: [31, 100] });
    const saveLibraryBooks = vi.fn(async (_books: Book[]) => {});
    const appService = {
      loadLibraryBooks: vi.fn(async () => [onDisk]),
      saveLibraryBooks,
    } as unknown as AppService;
    const envConfig = { getAppService: vi.fn(async () => appService) } as EnvConfigType;

    await persistCrossPointHydratedBookMarker(envConfig, {
      bookHash: HASH,
      downloadedAt: 901,
    });

    expect(saveLibraryBooks).toHaveBeenCalledWith([{ ...onDisk, downloadedAt: 901 }]);
    expect(useLibraryStore.getState().libraryLoaded).toBe(true);
  });

  test('flushes the latest row when progress changes during the marker write', async () => {
    const latest = makeBook({ progress: [27, 100] });
    useLibraryStore.getState().setLibrary([latest]);
    const saveLibraryBooks = vi.fn(async (_books: Book[]) => {
      if (saveLibraryBooks.mock.calls.length === 1) {
        useLibraryStore.getState().updateBookProgress(HASH, [28, 100], latest.readingStatus);
      }
    });
    const appService = { saveLibraryBooks } as unknown as AppService;
    const envConfig = { getAppService: vi.fn(async () => appService) } as EnvConfigType;

    await persistCrossPointHydratedBookMarker(envConfig, {
      bookHash: HASH,
      downloadedAt: 902,
    });

    expect(saveLibraryBooks).toHaveBeenCalledTimes(2);
    expect(saveLibraryBooks.mock.calls[1]?.[0]?.[0]).toMatchObject({
      progress: [28, 100],
      downloadedAt: 902,
    });
  });

  test('batches markers and preserves a concurrent change to an unrelated row', async () => {
    const otherHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const first = makeBook();
    const other = makeBook({ hash: otherHash, title: 'Other', progress: [4, 10] });
    useLibraryStore.getState().setLibrary([first, other]);
    const saveLibraryBooks = vi.fn(async (_books: Book[]) => {
      if (saveLibraryBooks.mock.calls.length === 1) {
        useLibraryStore.getState().updateBookProgress(otherHash, [5, 10], other.readingStatus);
      }
    });
    const appService = { saveLibraryBooks } as unknown as AppService;
    const envConfig = { getAppService: vi.fn(async () => appService) } as EnvConfigType;

    await persistCrossPointHydratedBookMarkers(envConfig, [
      { bookHash: HASH, downloadedAt: 900 },
      { bookHash: otherHash, downloadedAt: 901 },
    ]);

    expect(saveLibraryBooks).toHaveBeenCalledTimes(2);
    expect(saveLibraryBooks.mock.calls[0]?.[0]).toMatchObject([
      { hash: HASH, downloadedAt: 900 },
      { hash: otherHash, downloadedAt: 901, progress: [4, 10] },
    ]);
    expect(saveLibraryBooks.mock.calls[1]?.[0]).toMatchObject([
      { hash: HASH, downloadedAt: 900 },
      { hash: otherHash, downloadedAt: 901, progress: [5, 10] },
    ]);
  });

  test('rolls back only the marker when persistence fails and keeps newer progress', async () => {
    const latest = makeBook({ progress: [27, 100], downloadedAt: 500 });
    useLibraryStore.getState().setLibrary([latest]);
    const saveLibraryBooks = vi.fn(async (_books: Book[]) => {
      useLibraryStore.getState().updateBookProgress(HASH, [28, 100], latest.readingStatus);
      throw new Error('disk full');
    });
    const appService = { saveLibraryBooks } as unknown as AppService;
    const envConfig = { getAppService: vi.fn(async () => appService) } as EnvConfigType;

    await expect(
      persistCrossPointHydratedBookMarker(envConfig, {
        bookHash: HASH,
        downloadedAt: 902,
      }),
    ).rejects.toThrow('disk full');

    expect(useLibraryStore.getState().getBookByHash(HASH)).toMatchObject({
      progress: [28, 100],
      downloadedAt: 500,
    });
  });
});
