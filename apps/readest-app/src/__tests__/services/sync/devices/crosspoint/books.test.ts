import { describe, expect, test, vi } from 'vitest';

import type { Book } from '@/types/book';
import type {
  CrossPointBookProvider,
  CrossPointBookStore,
  CrossPointLibraryManifest,
} from '@/services/sync/devices/crosspoint/types';
import {
  CROSSPOINT_BOOK_REVISION,
  CROSSPOINT_MANIFEST_PATH,
  CROSSPOINT_STREAM_UPLOAD_TIMEOUT_MS,
  chooseCrossPointBookPath,
  parseCrossPointLibraryManifest,
  sendCrossPointBooks,
} from '@/services/sync/devices/crosspoint/books';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccc';

const makeBook = (hash: string, title: string, overrides: Partial<Book> = {}): Book => ({
  hash,
  format: 'EPUB',
  title,
  sourceTitle: title,
  author: 'Author',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const manifest = (books: CrossPointLibraryManifest['books'] = {}): CrossPointLibraryManifest => ({
  version: 1,
  books,
});

const makeStore = (sizes: Readonly<Record<string, number | undefined>>): CrossPointBookStore => ({
  resolveLocalBookPath: vi.fn(async (book) => {
    const size = sizes[book.hash];
    return size === undefined ? null : { path: `/local/${book.hash}.epub`, size };
  }),
  loadBookFile: vi.fn(async () => null),
  loadConfig: vi.fn(async () => null),
});

const makeProvider = ({
  root = [],
  initialManifest = null,
  onWriteManifest,
  onUpload,
  onHead,
}: {
  root?: Awaited<ReturnType<CrossPointBookProvider['list']>>;
  initialManifest?: CrossPointLibraryManifest | string | null;
  onWriteManifest?: (value: CrossPointLibraryManifest) => Promise<void> | void;
  onUpload?: (remotePath: string, localPath: string) => Promise<boolean> | boolean;
  onHead?: CrossPointBookProvider['head'];
} = {}): CrossPointBookProvider => {
  const manifestText =
    typeof initialManifest === 'string'
      ? initialManifest
      : initialManifest === null
        ? null
        : JSON.stringify(initialManifest);

  return {
    list: vi.fn(async () => root),
    readText: vi.fn(async () => manifestText),
    writeText: vi.fn(async (_path, body) => {
      await onWriteManifest?.(JSON.parse(body) as CrossPointLibraryManifest);
    }),
    head: vi.fn(onHead ?? (async () => null)),
    writeBinary: vi.fn(async () => {}),
    uploadStream: vi.fn(async (remotePath, localPath) => onUpload?.(remotePath, localPath) ?? true),
  };
};

describe('chooseCrossPointBookPath', () => {
  test('uses a readable root filename and resolves FAT case-insensitive collisions', () => {
    const book = makeBook(HASH_A, 'Readable: Title');

    expect(chooseCrossPointBookPath(book, new Set())).toBe('/Readable_ Title.epub');
    expect(chooseCrossPointBookPath(book, new Set(['/readable_ title.EPUB']))).toBe(
      '/Readable_ Title-aaaaaaa.epub',
    );
  });

  test('keeps a multibyte collision filename within the 255-byte FAT limit', () => {
    const title = '界'.repeat(100);
    const book = makeBook(HASH_A, title);
    const preferred = chooseCrossPointBookPath(book, new Set());
    const collision = chooseCrossPointBookPath(book, new Set([preferred.toLowerCase()]));

    expect(collision).toMatch(/-aaaaaaa\.epub$/);
    expect(new TextEncoder().encode(collision.slice(1)).length).toBeLessThanOrEqual(255);
  });

  test('keeps a multibyte preferred filename within the 255-byte FAT limit', () => {
    const preferred = chooseCrossPointBookPath(makeBook(HASH_A, '界'.repeat(100)), new Set());

    expect(preferred).toMatch(/\.epub$/);
    expect(new TextEncoder().encode(preferred.slice(1)).length).toBeLessThanOrEqual(255);
  });

  test('prefixes a dot-leading title so firmware does not treat the book as protected', () => {
    expect(chooseCrossPointBookPath(makeBook(HASH_A, '...And Then'), new Set())).toBe(
      '/_...And Then.epub',
    );
  });
});

describe('parseCrossPointLibraryManifest', () => {
  test('rejects a manifest-owned path that firmware would protect as hidden', () => {
    expect(() =>
      parseCrossPointLibraryManifest(
        JSON.stringify(
          manifest({
            [HASH_A]: {
              path: '/.hidden.epub',
              size: 42,
              revision: CROSSPOINT_BOOK_REVISION,
              state: 'active',
            },
          }),
        ),
      ),
    ).toThrow('CrossPoint library manifest is invalid');
  });
});

describe('sendCrossPointBooks', () => {
  test('uploads active local EPUBs sequentially with a two-phase manifest per book', async () => {
    const events: string[] = [];
    const remoteSizes = new Map<string, number>();
    let uploadsInFlight = 0;
    let maxUploadsInFlight = 0;
    const provider = makeProvider({
      onWriteManifest: (value) => {
        const latest = Object.entries(value.books).at(-1);
        events.push(`manifest:${latest?.[0]}:${latest?.[1].state}`);
      },
      onUpload: async (remotePath) => {
        uploadsInFlight += 1;
        maxUploadsInFlight = Math.max(maxUploadsInFlight, uploadsInFlight);
        events.push(`upload:${remotePath}`);
        await Promise.resolve();
        remoteSizes.set(remotePath, remotePath.includes('One') ? 11 : 22);
        uploadsInFlight -= 1;
        return true;
      },
      onHead: async (path) => ({ size: remoteSizes.get(path) }),
    });
    const books = [
      makeBook(HASH_A, 'One'),
      makeBook(HASH_B, 'Two'),
      makeBook(HASH_C, 'Not an EPUB', { format: 'PDF' }),
      makeBook('dddddddddddddddddddddddddddddddd', 'Deleted', { deletedAt: 2 }),
    ];

    const result = await sendCrossPointBooks({
      provider,
      store: makeStore({ [HASH_A]: 11, [HASH_B]: 22 }),
      books,
    });

    expect(provider.list).toHaveBeenCalledOnce();
    expect(provider.list).toHaveBeenCalledWith('/');
    expect(provider.readText).toHaveBeenCalledWith(CROSSPOINT_MANIFEST_PATH);
    expect(events).toEqual([
      `manifest:${HASH_A}:uploading`,
      'upload:/One.epub',
      `manifest:${HASH_A}:active`,
      `manifest:${HASH_B}:uploading`,
      'upload:/Two.epub',
      `manifest:${HASH_B}:active`,
    ]);
    expect(maxUploadsInFlight).toBe(1);
    expect(result).toMatchObject({
      considered: 2,
      uploaded: 2,
      recovered: 0,
      skipped: 0,
      unavailable: 0,
      failures: [],
    });
  });

  test('gives same-title Readest books distinct root paths in one run', async () => {
    const uploadedPaths: string[] = [];
    const remoteSizes = new Map<string, number>();
    const provider = makeProvider({
      onUpload: (remotePath, localPath) => {
        const size = localPath.includes(HASH_A) ? 11 : 22;
        uploadedPaths.push(remotePath);
        remoteSizes.set(remotePath, size);
        return true;
      },
      onHead: async (path) => ({ size: remoteSizes.get(path) }),
    });

    const result = await sendCrossPointBooks({
      provider,
      store: makeStore({ [HASH_A]: 11, [HASH_B]: 22 }),
      books: [makeBook(HASH_A, 'Shared'), makeBook(HASH_B, 'Shared')],
    });

    expect(uploadedPaths).toEqual(['/Shared.epub', '/Shared-bbbbbbb.epub']);
    expect(result.uploaded).toBe(2);
  });

  test('uses buffered bytes when the provider has no native streaming upload', async () => {
    const provider = makeProvider({ onHead: async () => ({ size: 4 }) });
    delete provider.uploadStream;
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const store = makeStore({ [HASH_A]: 4 });
    store.loadBookFile = vi.fn(async () => ({ bytes, size: 4 }));

    const result = await sendCrossPointBooks({
      provider,
      store,
      books: [makeBook(HASH_A, 'Web Book')],
    });

    expect(provider.writeBinary).toHaveBeenCalledWith(
      '/Web Book.epub',
      bytes,
      'application/epub+zip',
    );
    expect(result.uploaded).toBe(1);
  });

  test('skips only an active current manifest mapping with a matching root size', async () => {
    const book = makeBook(HASH_A, 'Renamed Locally');
    const provider = makeProvider({
      root: [{ name: 'Original.epub', path: '/Original.epub', isDirectory: false, size: 42 }],
      initialManifest: manifest({
        [HASH_A]: {
          path: '/Original.epub',
          size: 42,
          revision: 7,
          state: 'active',
        },
      }),
    });

    const result = await sendCrossPointBooks({
      provider,
      store: makeStore({ [HASH_A]: 42 }),
      books: [book],
    });

    expect(provider.uploadStream).not.toHaveBeenCalled();
    expect(provider.writeBinary).not.toHaveBeenCalled();
    expect(provider.writeText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ uploaded: 0, recovered: 0, skipped: 1, failures: [] });
  });

  test('reuploads a manifest-managed path and increments its revision when size is stale', async () => {
    const uploaded: string[] = [];
    const writes: CrossPointLibraryManifest[] = [];
    const provider = makeProvider({
      root: [
        { name: 'Managed.epub', path: '/Managed.epub', isDirectory: false, size: 41 },
        { name: 'Desired title.epub', path: '/Desired title.epub', isDirectory: false, size: 99 },
      ],
      initialManifest: manifest({
        [HASH_A]: { path: '/Managed.epub', size: 41, revision: 7, state: 'active' },
      }),
      onUpload: (path) => {
        uploaded.push(path);
        return true;
      },
      onHead: async () => ({ size: 42 }),
      onWriteManifest: (value) => {
        writes.push(structuredClone(value));
      },
    });

    const result = await sendCrossPointBooks({
      provider,
      store: makeStore({ [HASH_A]: 42 }),
      books: [makeBook(HASH_A, 'Desired title')],
    });

    expect(uploaded).toEqual(['/Managed.epub']);
    expect(writes.map((value) => value.books[HASH_A])).toEqual([
      { path: '/Managed.epub', size: 42, revision: 8, state: 'uploading' },
      { path: '/Managed.epub', size: 42, revision: 8, state: 'active' },
    ]);
    expect(result.uploaded).toBe(1);
  });

  test('reuses an interrupted manifest path instead of creating a duplicate', async () => {
    const provider = makeProvider({
      root: [{ name: 'Book.epub', path: '/Book.epub', isDirectory: false, size: 99 }],
      initialManifest: manifest({
        [HASH_A]: {
          path: '/Book-aaaaaaa.epub',
          size: 42,
          revision: CROSSPOINT_BOOK_REVISION,
          state: 'uploading',
        },
      }),
      onHead: async () => ({ size: 42 }),
    });

    const result = await sendCrossPointBooks({
      provider,
      store: makeStore({ [HASH_A]: 42 }),
      books: [makeBook(HASH_A, 'Book')],
    });

    expect(provider.uploadStream).toHaveBeenCalledWith(
      '/Book-aaaaaaa.epub',
      `/local/${HASH_A}.epub`,
      CROSSPOINT_STREAM_UPLOAD_TIMEOUT_MS,
    );
    expect(result.uploaded).toBe(1);
  });

  test('recovers a completed interrupted upload by HEAD-verifying and activating it', async () => {
    const writes: CrossPointLibraryManifest[] = [];
    const provider = makeProvider({
      root: [{ name: 'Pending.epub', path: '/Pending.epub', isDirectory: false, size: 42 }],
      initialManifest: manifest({
        [HASH_A]: {
          path: '/Pending.epub',
          size: 42,
          revision: CROSSPOINT_BOOK_REVISION,
          state: 'uploading',
        },
      }),
      onHead: async () => ({ size: 42 }),
      onWriteManifest: (value) => {
        writes.push(value);
      },
    });

    const result = await sendCrossPointBooks({
      provider,
      store: makeStore({ [HASH_A]: 42 }),
      books: [makeBook(HASH_A, 'Pending')],
    });

    expect(provider.uploadStream).not.toHaveBeenCalled();
    expect(provider.head).toHaveBeenCalledWith('/Pending.epub');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.books[HASH_A]?.state).toBe('active');
    expect(result).toMatchObject({ uploaded: 0, recovered: 1, skipped: 0, failures: [] });
  });

  test('leaves the durable manifest in uploading state when exact-size verification fails', async () => {
    const writes: CrossPointLibraryManifest[] = [];
    const provider = makeProvider({
      onHead: async () => ({ size: 41 }),
      onWriteManifest: (value) => {
        writes.push(structuredClone(value));
      },
    });

    const result = await sendCrossPointBooks({
      provider,
      store: makeStore({ [HASH_A]: 42 }),
      books: [makeBook(HASH_A, 'Book')],
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.books[HASH_A]?.state).toBe('uploading');
    expect(result.uploaded).toBe(0);
    expect(result.failures).toEqual([
      { bookHash: HASH_A, reason: 'Uploaded book size verification failed' },
    ]);
  });

  test('preserves manifest entries outside the current active library and never deletes files', async () => {
    const writes: CrossPointLibraryManifest[] = [];
    const provider = makeProvider({
      initialManifest: manifest({
        [HASH_B]: {
          path: '/Old Readest Book.epub',
          size: 9,
          revision: CROSSPOINT_BOOK_REVISION,
          state: 'active',
        },
      }),
      onHead: async () => ({ size: 42 }),
      onWriteManifest: (value) => {
        writes.push(structuredClone(value));
      },
    });

    await sendCrossPointBooks({
      provider,
      store: makeStore({ [HASH_A]: 42 }),
      books: [makeBook(HASH_A, 'New Book')],
    });

    expect(writes.at(-1)?.books[HASH_B]).toEqual({
      path: '/Old Readest Book.epub',
      size: 9,
      revision: CROSSPOINT_BOOK_REVISION,
      state: 'active',
    });
  });

  test('refuses a malformed manifest without uploading or replacing it', async () => {
    const provider = makeProvider({ initialManifest: '{"version":1,"books":[]}' });

    await expect(
      sendCrossPointBooks({
        provider,
        store: makeStore({ [HASH_A]: 42 }),
        books: [makeBook(HASH_A, 'Book')],
      }),
    ).rejects.toThrow('CrossPoint library manifest is invalid');

    expect(provider.writeText).not.toHaveBeenCalled();
    expect(provider.uploadStream).not.toHaveBeenCalled();
  });
});
