import { describe, expect, it, vi } from 'vitest';
import { createFeedIssue } from '@/services/rss/feedIssue';
import type { EpubBuildMetadata, EpubChapter } from '@/services/send/conversion/types';
import type { RssFeed, RssFeedItem } from '@/types/rss';

const fullContent = `<p>${'Readable feed content. '.repeat(20)}</p>`;

const item = (overrides: Partial<RssFeedItem>): RssFeedItem => ({
  id: 'article-1',
  title: 'Article one',
  link: 'https://example.com/article-1',
  read: false,
  ...overrides,
});

const feed = (items: RssFeedItem[]): RssFeed => ({
  id: 'https://example.com/feed.xml',
  url: 'https://example.com/feed.xml',
  title: 'Example feed',
  addedAt: 1,
  items,
});

describe('createFeedIssue', () => {
  it('builds one text-first EPUB from unread articles that have not been sent', async () => {
    const alreadySent = item({
      id: 'already-sent',
      title: 'Already sent',
      crossPointSyncedAt: 10,
      contentHtml: fullContent,
    });
    const build = vi.fn(
      async (_chapters: EpubChapter[], _metadata: EpubBuildMetadata) => new Blob(['epub']),
    );
    const result = await createFeedIssue(
      [
        feed([
          item({
            contentHtml: `${fullContent}<script>alert('no')</script><img src='remote.jpg' />`,
            publishedAt: '2026-07-16T10:00:00.000Z',
          }),
          item({ id: 'read', title: 'Read', read: true, contentHtml: fullContent }),
          alreadySent,
          item({
            id: 'summary-only',
            title: 'Summary only',
            link: 'https://example.com/summary-only',
            summary: 'A useful fallback summary.',
            publishedAt: '2026-07-15T10:00:00.000Z',
          }),
          item({
            id: 'unavailable',
            title: 'Unavailable',
            link: 'https://example.com/unavailable',
          }),
        ]),
      ],
      {
        build,
        fetchPage: vi.fn(async () => {
          throw new Error('offline');
        }),
        now: () => new Date('2026-07-16T12:00:00.000Z').getTime(),
      },
    );

    expect(result.title).toBe('Feeds · 2026-07-16');
    expect(result.file.name).toBe('Feeds 2026-07-16.epub');
    expect(result.articleCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.itemRefs).toEqual([
      { feedId: 'https://example.com/feed.xml', itemId: 'article-1' },
      { feedId: 'https://example.com/feed.xml', itemId: 'summary-only' },
    ]);

    const chapters = build.mock.calls[0]![0];
    const metadata = build.mock.calls[0]![1];
    expect(chapters.map((chapter) => chapter.title)).toEqual(['Article one', 'Summary only']);
    expect(chapters[0]!.html).toContain('<h1>Article one</h1>');
    expect(chapters[0]!.html).toContain('Example feed');
    expect(chapters[0]!.html).not.toContain('<script');
    expect(chapters[0]!.html).not.toContain('<img');
    expect(chapters[1]!.html).toContain('A useful fallback summary.');
    expect(metadata.identifier).toMatch(/^readest:feeds:/);
  });

  it('refuses to create an empty issue', async () => {
    await expect(
      createFeedIssue([feed([item({ read: true, contentHtml: fullContent })])]),
    ).rejects.toThrow(/no unread articles/i);
  });
});
