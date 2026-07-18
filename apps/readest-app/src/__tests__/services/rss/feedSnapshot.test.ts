import { describe, expect, it, vi } from 'vitest';

import { buildFeedBookUrl } from '@/services/rss/feedBookUrl';
import type { FeedManifest } from '@/services/rss/feedManifest';
import { buildFeedSnapshot } from '@/services/rss/feedSnapshot';
import type { EpubBuildMetadata, EpubChapter } from '@/services/send/conversion/types';
import type { Book } from '@/types/book';
import type { BaseDir } from '@/types/system';

const book: Book = {
  hash: 'feed-hash',
  url: buildFeedBookUrl('https://example.com/feed.xml'),
  format: 'EPUB',
  title: 'Example site',
  author: '',
  createdAt: 1,
  updatedAt: 1,
};

describe('buildFeedSnapshot', () => {
  it('builds a self-contained EPUB snapshot with newest articles first', async () => {
    const manifest: FeedManifest = {
      feedUrl: 'https://example.com/feed.xml',
      title: 'Example site',
      entries: [
        {
          id: 'older',
          slot: 1,
          title: 'Older',
          link: 'https://example.com/older',
          publishedAt: '2026-07-17T00:00:00Z',
          read: false,
        },
        {
          id: 'newer',
          slot: 2,
          title: 'Newer',
          link: 'https://example.com/newer',
          publishedAt: '2026-07-18T00:00:00Z',
          read: false,
        },
      ],
    };
    const files = new Map<string, string>([
      ['Books/feed-hash/feed-manifest.json', JSON.stringify(manifest)],
      ['Books/feed-hash/articles/older.html', '<p>Older body</p><img src="https://x/old.jpg">'],
      ['Books/feed-hash/articles/newer.html', '<p>Newer body</p><img src="https://x/new.jpg">'],
    ]);
    const fs = {
      exists: vi.fn(async (path: string, base: BaseDir) => files.has(`${base}/${path}`)),
      readFile: vi.fn(async (path: string, base: BaseDir) => files.get(`${base}/${path}`) ?? ''),
      writeFile: vi.fn(async () => {}),
    };
    const build = vi.fn(
      async (_chapters: EpubChapter[], _metadata: EpubBuildMetadata) => new Blob(['epub']),
    );

    const refresh = vi.fn(async () => manifest);
    const snapshot = await buildFeedSnapshot(fs, book, { build, refresh });

    expect(snapshot.size).toBe(4);
    expect(refresh).toHaveBeenCalledWith(
      fs,
      'feed-hash',
      'https://example.com/feed.xml',
      'Example site',
    );
    expect(build).toHaveBeenCalledOnce();
    const [chapters, metadata] = build.mock.calls[0]!;
    expect(chapters.map((chapter) => chapter.title)).toEqual(['Newer', 'Older']);
    expect(chapters[0]!.html).toContain('Newer body');
    expect(chapters[0]!.html).toContain('Original article');
    expect(chapters[0]!.html).not.toContain('<img');
    expect(metadata).toMatchObject({
      title: 'Example site',
      identifier: 'https://example.com/feed.xml',
    });
  });

  it('writes TOC targets that exactly match the EPUB spine paths', async () => {
    const manifest: FeedManifest = {
      feedUrl: 'https://example.com/feed.xml',
      title: 'Example site',
      entries: [
        {
          id: 'older',
          slot: 1,
          title: 'Older',
          link: 'https://example.com/older',
          publishedAt: '2026-07-17T00:00:00Z',
          read: false,
        },
        {
          id: 'newer',
          slot: 2,
          title: 'Newer',
          link: 'https://example.com/newer',
          publishedAt: '2026-07-18T00:00:00Z',
          read: false,
        },
      ],
    };
    const files = new Map<string, string>([
      ['Books/feed-hash/articles/older.html', '<p>Older body</p>'],
      ['Books/feed-hash/articles/newer.html', '<p>Newer body</p>'],
    ]);
    const fs = {
      exists: vi.fn(async (path: string, base: BaseDir) => files.has(`${base}/${path}`)),
      readFile: vi.fn(async (path: string, base: BaseDir) => files.get(`${base}/${path}`) ?? ''),
      writeFile: vi.fn(async () => {}),
    };

    const snapshot = await buildFeedSnapshot(fs, book, {
      refresh: vi.fn(async () => manifest),
    });
    const { BlobReader, TextWriter, ZipReader } = await import('@zip.js/zip.js');
    const reader = new ZipReader(new BlobReader(snapshot));
    const entries = await reader.getEntries();
    const tocEntry = entries.find((entry) => entry.filename === 'toc.ncx');
    if (!tocEntry || !('getData' in tocEntry) || !tocEntry.getData) {
      throw new Error('toc.ncx missing');
    }
    const toc = await tocEntry.getData(new TextWriter());
    await reader.close();

    expect(toc).toContain('<content src="OEBPS/chapter1.xhtml"/>');
    expect(toc).toContain('<content src="OEBPS/chapter2.xhtml"/>');
    expect(toc).not.toContain('<content src="./');
  });
});
