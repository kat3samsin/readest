import { describe, expect, it, vi } from 'vitest';

import { buildFeedBookUrl } from '@/services/rss/feedBookUrl';
import { withCrossPointFeedSnapshots } from '@/services/sync/devices/crosspoint/feedBookStore';
import type { CrossPointBookStore } from '@/services/sync/devices/crosspoint/types';
import type { Book } from '@/types/book';

const makeBook = (url: string): Book => ({
  hash: 'hash',
  url,
  format: 'EPUB',
  title: 'Book',
  author: '',
  createdAt: 1,
  updatedAt: 1,
});

describe('withCrossPointFeedSnapshots', () => {
  it('materializes feed books and delegates normal EPUBs to the local store', async () => {
    const base: CrossPointBookStore = {
      resolveLocalBookPath: vi.fn(async () => null),
      loadBookFile: vi.fn(async () => ({ bytes: new ArrayBuffer(2), size: 2 })),
      loadConfig: vi.fn(async () => null),
    };
    const buildSnapshot = vi.fn(async () => new Blob(['feed']));
    const store = withCrossPointFeedSnapshots(base, {} as never, buildSnapshot);
    const feedBook = makeBook(buildFeedBookUrl('https://example.com/feed.xml'));
    const epubBook = makeBook('file:///book.epub');

    await expect(store.loadBookFile(feedBook)).resolves.toMatchObject({ size: 4 });
    expect(buildSnapshot).toHaveBeenCalledWith({}, feedBook);
    expect(base.loadBookFile).not.toHaveBeenCalled();

    await expect(store.loadBookFile(epubBook)).resolves.toMatchObject({ size: 2 });
    expect(base.loadBookFile).toHaveBeenCalledWith(epubBook);
  });
});
