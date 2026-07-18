import { describe, expect, it } from 'vitest';
import { makeFeedBook } from '@/services/rss/makeFeedBook';
import { CFI } from '@/libs/document';
import type { FeedManifest } from '@/services/rss/feedManifest';

// Manifest with hash-style slots (non-sequential). Slot 7 is "older" (publishedAt earlier),
// slot 42 is "newer" (publishedAt later). The reader should show newest first.
const manifest: FeedManifest = {
  feedUrl: 'u',
  title: 'Blog',
  entries: [
    {
      id: 'a',
      slot: 42,
      title: 'A',
      link: 'https://x/a',
      read: false,
      publishedAt: '2024-01-02T00:00:00Z',
    },
    {
      id: 'c',
      slot: 7,
      title: 'C',
      link: 'https://x/c',
      read: false,
      publishedAt: '2024-01-01T00:00:00Z',
    },
  ],
};

describe('makeFeedBook', () => {
  it('builds one section per entry with correct CFIs (slot != array index)', async () => {
    const book = await makeFeedBook(manifest, async (e) => `<p>body ${e.id}</p>`);
    expect(book.sections).toHaveLength(2);
    expect(book.sections[0]!.cfi).toBe(CFI.fake.fromIndex(42));
    expect(book.sections[1]!.cfi).toBe(CFI.fake.fromIndex(7));
    expect(book.metadata.title).toBe('Blog');
    const doc0 = await book.sections[0]!.createDocument();
    expect(doc0.body.textContent).toContain('body a');
  });

  it('sorts sections newest first and keeps undated entries last', async () => {
    const mixedManifest: FeedManifest = {
      feedUrl: 'u',
      title: 'Mixed',
      entries: [
        {
          id: 'newer',
          slot: 100,
          title: 'Newer',
          link: 'https://x/newer',
          read: false,
          publishedAt: '2024-02-01T00:00:00Z',
        },
        { id: 'undated', slot: 200, title: 'Undated', link: 'https://x/undated', read: false },
        {
          id: 'older',
          slot: 300,
          title: 'Older',
          link: 'https://x/older',
          read: false,
          publishedAt: '2024-01-01T00:00:00Z',
        },
      ],
    };
    const book = await makeFeedBook(mixedManifest, async (e) => `<p>body ${e.id}</p>`);
    expect(book.sections[0]!.id).toBe('100');
    expect(book.sections[1]!.id).toBe('300');
    expect(book.sections[2]!.id).toBe('200'); // undated last
  });

  it('resolveCFI resolves by slot id, not array index', async () => {
    // The key invariant is that resolution follows the stable slot, not its current array index.
    const book = await makeFeedBook(manifest, async (e) => `<p>body ${e.id}</p>`);
    const bookWithResolve = book as unknown as {
      resolveCFI: (c: string) => { index: number; anchor: (doc: Document) => unknown };
    };
    expect(typeof bookWithResolve.resolveCFI).toBe('function');
    // slot-7 (C) is at array index 1 after newest-first sorting.
    const result7 = bookWithResolve.resolveCFI(CFI.fake.fromIndex(7));
    expect(result7.index).toBe(1);
    // slot-42 (A) is at array index 0.
    const result42 = bookWithResolve.resolveCFI(CFI.fake.fromIndex(42));
    expect(result42.index).toBe(0);
  });
});
