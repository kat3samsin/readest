import type { Book } from '@/types/book';
import { buildBookFileName } from '@/services/sync/file/layout';
import type { BookBytes } from '@/services/sync/file/localStore';
import type { FileEntry } from '@/services/sync/file/provider';
import type {
  CrossPointBookProvider,
  CrossPointBookStore,
  CrossPointBookSyncResult,
  CrossPointLibraryManifest,
  CrossPointManifestEntry,
} from './types';

export const CROSSPOINT_MANIFEST_PATH = '/.crosspoint/readest-library.json';
export const CROSSPOINT_BOOK_REVISION = 1;
export const CROSSPOINT_STREAM_UPLOAD_TIMEOUT_MS = 120_000;

const MAX_FILENAME_BYTES = 255;
const encoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const canonicalPath = (path: string): string => path.normalize('NFC').toLowerCase();

const isSafeRootEpubPath = (path: unknown): path is string => {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  const filename = path.slice(1);
  return (
    filename.length > 0 &&
    !filename.startsWith('.') &&
    !filename.includes('/') &&
    !/[<>:"/\\|?*\x00-\x1F]/.test(filename) &&
    filename.toLowerCase().endsWith('.epub') &&
    encoder.encode(filename).length <= MAX_FILENAME_BYTES
  );
};

const invalidManifest = (): never => {
  throw new Error('CrossPoint library manifest is invalid');
};

export const parseCrossPointLibraryManifest = (text: string | null): CrossPointLibraryManifest => {
  if (text === null) return { version: 1, books: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidManifest();
  }
  if (!isRecord(parsed) || parsed['version'] !== 1 || !isRecord(parsed['books'])) {
    return invalidManifest();
  }

  const books: Record<string, CrossPointManifestEntry> = {};
  const claimedPaths = new Set<string>();
  for (const [hash, value] of Object.entries(parsed['books'])) {
    if (
      !hash ||
      hash.length > 128 ||
      hash === '__proto__' ||
      hash === 'constructor' ||
      hash === 'prototype' ||
      !isRecord(value) ||
      !isSafeRootEpubPath(value['path']) ||
      !isPositiveSafeInteger(value['size']) ||
      !isPositiveSafeInteger(value['revision']) ||
      (value['state'] !== 'uploading' && value['state'] !== 'active')
    ) {
      return invalidManifest();
    }

    const pathKey = canonicalPath(value['path']);
    if (claimedPaths.has(pathKey)) return invalidManifest();
    claimedPaths.add(pathKey);
    books[hash] = {
      path: value['path'],
      size: value['size'],
      revision: value['revision'],
      state: value['state'],
    };
  }

  return { version: 1, books };
};

const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (encoder.encode(value).length <= maxBytes) return value;
  const codePoints = Array.from(value);
  while (codePoints.length > 0 && encoder.encode(codePoints.join('')).length > maxBytes) {
    codePoints.pop();
  }
  return codePoints.join('');
};

const appendSuffix = (filename: string, suffix: string): string => {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  const tail = `${suffix}${extension}`;
  const stemBytes = Math.max(0, MAX_FILENAME_BYTES - encoder.encode(tail).length);
  return `${truncateUtf8(stem, stemBytes)}${tail}`;
};

export const chooseCrossPointBookPath = (
  book: Book,
  occupiedPaths: ReadonlySet<string>,
): string => {
  const occupied = new Set([...occupiedPaths].map(canonicalPath));
  const rawFilename = buildBookFileName(book);
  const filename = appendSuffix(rawFilename.startsWith('.') ? `_${rawFilename}` : rawFilename, '');
  const preferred = `/${filename}`;
  if (!occupied.has(canonicalPath(preferred))) return preferred;

  const shortHash = book.hash.slice(0, 7);
  let candidate = `/${appendSuffix(filename, `-${shortHash}`)}`;
  let index = 2;
  while (occupied.has(canonicalPath(candidate))) {
    candidate = `/${appendSuffix(filename, `-${shortHash}-${index}`)}`;
    index += 1;
  }
  return candidate;
};

const writeManifest = async (
  provider: CrossPointBookProvider,
  manifest: CrossPointLibraryManifest,
): Promise<void> => {
  await provider.writeText(
    CROSSPOINT_MANIFEST_PATH,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'application/json',
  );
};

const rootInventory = (entries: FileEntry[]): Map<string, FileEntry> => {
  const inventory = new Map<string, FileEntry>();
  for (const entry of entries) {
    if (entry.isDirectory || !isSafeRootEpubPath(entry.path)) continue;
    inventory.set(canonicalPath(entry.path), entry);
  }
  return inventory;
};

const validSize = (size: number): boolean => Number.isSafeInteger(size) && size > 0;

interface LocalSource {
  size: number;
  path?: string;
  bytes?: BookBytes;
}

const resolveLocalSource = async (
  store: CrossPointBookStore,
  book: Book,
): Promise<LocalSource | null> => {
  const localPath = await store.resolveLocalBookPath(book);
  if (localPath && validSize(localPath.size)) {
    return { path: localPath.path, size: localPath.size };
  }

  const bytes = await store.loadBookFile(book);
  if (!bytes || !validSize(bytes.size)) return null;
  return { bytes, size: bytes.size };
};

const ensureBufferedSource = async (
  store: CrossPointBookStore,
  book: Book,
  source: LocalSource,
): Promise<LocalSource | null> => {
  if (source.bytes) return source;
  const bytes = await store.loadBookFile(book);
  if (!bytes || !validSize(bytes.size)) return null;
  return { ...source, bytes, size: bytes.size };
};

const uploadBook = async (
  provider: CrossPointBookProvider,
  path: string,
  source: LocalSource,
): Promise<void> => {
  if (source.path && provider.uploadStream) {
    const uploaded = await provider.uploadStream(
      path,
      source.path,
      CROSSPOINT_STREAM_UPLOAD_TIMEOUT_MS,
    );
    if (!uploaded) throw new Error('Streaming book upload failed');
    return;
  }
  if (!source.bytes) throw new Error('Local book file is unavailable');
  await provider.writeBinary(path, source.bytes.bytes, 'application/epub+zip');
};

const exactRootMatch = (
  inventory: ReadonlyMap<string, FileEntry>,
  entry: CrossPointManifestEntry,
  localSize: number,
): boolean => {
  const rootEntry = inventory.get(canonicalPath(entry.path));
  return entry.size === localSize && rootEntry?.size === localSize;
};

const reasonFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Send active Readest EPUBs to the CrossPoint root without touching unmanaged
 * files. The device manifest is the ownership boundary and is persisted before
 * and after each sequential upload so interrupted runs resume the same path.
 */
export const sendCrossPointBooks = async ({
  provider,
  store,
  books,
}: {
  provider: CrossPointBookProvider;
  store: CrossPointBookStore;
  books: Book[];
}): Promise<CrossPointBookSyncResult> => {
  const rootEntries = await provider.list('/');
  const inventory = rootInventory(rootEntries);
  const occupiedPaths = new Set(rootEntries.map((entry) => canonicalPath(entry.path)));
  const manifest = parseCrossPointLibraryManifest(
    await provider.readText(CROSSPOINT_MANIFEST_PATH),
  );
  for (const entry of Object.values(manifest.books)) {
    occupiedPaths.add(canonicalPath(entry.path));
  }

  const activeEpubs = books.filter((book) => book.format === 'EPUB' && !book.deletedAt);
  const failures: CrossPointBookSyncResult['failures'] = [];
  let uploaded = 0;
  let recovered = 0;
  let skipped = 0;
  let unavailable = 0;

  for (const book of activeEpubs) {
    try {
      let source = await resolveLocalSource(store, book);
      if (!source) {
        unavailable += 1;
        continue;
      }

      const previous = manifest.books[book.hash];
      if (previous?.state === 'active' && exactRootMatch(inventory, previous, source.size)) {
        skipped += 1;
        continue;
      }

      if (previous?.state === 'uploading' && exactRootMatch(inventory, previous, source.size)) {
        const head = await provider.head(previous.path);
        if (head?.size === source.size) {
          manifest.books[book.hash] = { ...previous, state: 'active' };
          await writeManifest(provider, manifest);
          recovered += 1;
          continue;
        }
      }

      if (!(source.path && provider.uploadStream)) {
        source = await ensureBufferedSource(store, book, source);
        if (!source) {
          unavailable += 1;
          continue;
        }
      }

      const path = previous?.path ?? chooseCrossPointBookPath(book, occupiedPaths);
      const revision = previous
        ? previous.state === 'uploading' && previous.size === source.size
          ? previous.revision
          : previous.revision + 1
        : CROSSPOINT_BOOK_REVISION;
      if (!Number.isSafeInteger(revision)) throw new Error('CrossPoint book revision overflow');

      const pending: CrossPointManifestEntry = {
        path,
        size: source.size,
        revision,
        state: 'uploading',
      };
      manifest.books[book.hash] = pending;
      occupiedPaths.add(canonicalPath(path));
      await writeManifest(provider, manifest);

      await uploadBook(provider, path, source);
      const head = await provider.head(path);
      if (head?.size !== source.size) {
        throw new Error('Uploaded book size verification failed');
      }

      manifest.books[book.hash] = { ...pending, state: 'active' };
      await writeManifest(provider, manifest);
      inventory.set(canonicalPath(path), {
        name: path.slice(1),
        path,
        isDirectory: false,
        size: source.size,
      });
      uploaded += 1;
    } catch (error) {
      failures.push({ bookHash: book.hash, reason: reasonFor(error) });
    }
  }

  return {
    manifest,
    considered: activeEpubs.length,
    uploaded,
    recovered,
    skipped,
    unavailable,
    failures,
  };
};
