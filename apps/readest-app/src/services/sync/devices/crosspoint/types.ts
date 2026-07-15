import type { Book } from '@/types/book';
import type { LocalStore } from '@/services/sync/file/localStore';
import type { FileSyncProvider } from '@/services/sync/file/provider';

export type CrossPointManifestEntryState = 'uploading' | 'active';

export interface CrossPointManifestEntry {
  path: string;
  size: number;
  revision: number;
  state: CrossPointManifestEntryState;
}

export interface CrossPointLibraryManifest {
  version: 1;
  books: Record<string, CrossPointManifestEntry>;
}

export type CrossPointBookProvider = Pick<
  FileSyncProvider,
  'list' | 'readText' | 'readBinary' | 'writeText' | 'head' | 'writeBinary' | 'uploadStream'
>;

export type CrossPointBookStore = Pick<
  LocalStore,
  'resolveLocalBookPath' | 'loadBookFile' | 'loadConfig'
>;

export interface CrossPointBookSyncFailure {
  bookHash: string;
  reason: string;
}

export interface CrossPointBookSyncProgress {
  book: Book;
  /** Zero-based index of the active EPUB currently being processed. */
  index: number;
  total: number;
}

export interface CrossPointBookSyncResult {
  manifest: CrossPointLibraryManifest;
  considered: number;
  uploaded: number;
  recovered: number;
  skipped: number;
  unavailable: number;
  failures: CrossPointBookSyncFailure[];
}
