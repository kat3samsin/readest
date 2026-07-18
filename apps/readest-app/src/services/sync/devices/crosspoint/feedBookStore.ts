import { isFeedBookUrl } from '@/services/rss/feedBookUrl';
import { buildFeedSnapshot, type FeedSnapshotFileSystem } from '@/services/rss/feedSnapshot';
import type { Book } from '@/types/book';
import type { CrossPointBookStore } from './types';

type FeedSnapshotBuilder = (fs: FeedSnapshotFileSystem, book: Book) => Promise<Blob>;

/** Add buffered EPUB snapshots for virtual feed books to the CrossPoint store. */
export const withCrossPointFeedSnapshots = (
  store: CrossPointBookStore,
  fs: FeedSnapshotFileSystem,
  buildSnapshot: FeedSnapshotBuilder = buildFeedSnapshot,
): CrossPointBookStore => ({
  ...store,
  loadBookFile: async (book) => {
    if (!book.url || !isFeedBookUrl(book.url)) return store.loadBookFile(book);
    const snapshot = await buildSnapshot(fs, book);
    const bytes = await snapshot.arrayBuffer();
    return { bytes, size: bytes.byteLength };
  },
});
