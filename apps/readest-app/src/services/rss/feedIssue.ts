import { buildEpub } from '@/services/send/conversion/buildEpub';
import type { EpubChapter } from '@/services/send/conversion/types';
import { md5 } from '@/utils/md5';
import { sanitizeHtml } from '@/utils/sanitize';
import type { RssFeed, RssFeedItem, RssFeedItemRef } from '@/types/rss';
import { extractArticle, MIN_FEED_CONTENT } from './feedArticleContent';
import { guardedFetchText } from './feedGuardedFetch';

interface FeedIssueEntry {
  feed: RssFeed;
  item: RssFeedItem;
  order: number;
}

interface CreateFeedIssueDependencies {
  build?: typeof buildEpub;
  fetchPage?: typeof guardedFetchText;
  now?: () => number;
}

export interface FeedIssueResult {
  file: File;
  title: string;
  articleCount: number;
  skippedCount: number;
  itemRefs: RssFeedItemRef[];
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const issueDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const cleanArticleBody = (html: string): string => {
  const sanitized = sanitizeHtml(html);
  const doc = new DOMParser().parseFromString(sanitized, 'text/html');
  doc.querySelector('h1')?.remove();
  doc.querySelectorAll('img').forEach((image) => image.remove());
  return doc.body.innerHTML.trim();
};

const resolveArticleBody = async (
  item: RssFeedItem,
  fetchPage: typeof guardedFetchText,
): Promise<string | null> => {
  let html =
    item.contentHtml && item.contentHtml.length >= MIN_FEED_CONTENT ? item.contentHtml : '';
  if (!html) {
    try {
      html = extractArticle(await fetchPage(item.link), item.link);
    } catch {
      html = item.summary ? `<p>${escapeHtml(item.summary)}</p>` : '';
    }
  }
  const cleaned = html ? cleanArticleBody(html) : '';
  return cleaned && new DOMParser().parseFromString(cleaned, 'text/html').body.textContent?.trim()
    ? cleaned
    : null;
};

const issueEntries = (feeds: RssFeed[]): FeedIssueEntry[] => {
  let order = 0;
  return feeds
    .flatMap((feed) =>
      feed.items
        .filter((item) => !item.read && !item.crossPointSyncedAt)
        .map((item) => ({ feed, item, order: order++ })),
    )
    .sort((left, right) => {
      const leftDate = left.item.publishedAt ? new Date(left.item.publishedAt).getTime() : 0;
      const rightDate = right.item.publishedAt ? new Date(right.item.publishedAt).getTime() : 0;
      return rightDate - leftDate || left.order - right.order;
    });
};

export async function createFeedIssue(
  feeds: RssFeed[],
  dependencies: CreateFeedIssueDependencies = {},
): Promise<FeedIssueResult> {
  const entries = issueEntries(feeds);
  if (entries.length === 0) {
    throw new Error('No unread articles are ready for the next issue.');
  }

  const build = dependencies.build ?? buildEpub;
  const fetchPage = dependencies.fetchPage ?? guardedFetchText;
  const timestamp = (dependencies.now ?? Date.now)();
  const date = issueDate(timestamp);
  const title = `Feeds · ${date}`;
  const chapters: EpubChapter[] = [];
  const itemRefs: RssFeedItemRef[] = [];

  for (const { feed, item } of entries) {
    const body = await resolveArticleBody(item, fetchPage);
    if (!body) continue;
    const author = item.author ? ` · ${escapeHtml(item.author)}` : '';
    chapters.push({
      title: item.title,
      html: [
        `<h1>${escapeHtml(item.title)}</h1>`,
        `<p><strong>${escapeHtml(feed.title)}</strong>${author}</p>`,
        body,
        `<p><a href="${escapeHtml(item.link)}">Original article</a></p>`,
      ].join('\n'),
    });
    itemRefs.push({ feedId: feed.id, itemId: item.id });
  }

  if (chapters.length === 0) {
    throw new Error('No unread articles had readable content.');
  }

  const identifier = `readest:feeds:${md5(
    itemRefs.map((item) => `${item.feedId}\n${item.itemId}`).join('\n'),
  )}`;
  const blob = await build(chapters, {
    title,
    author: 'Readest feeds',
    language: 'en',
    identifier,
  });

  return {
    file: new File([blob], `Feeds ${date}.epub`, { type: 'application/epub+zip' }),
    title,
    articleCount: chapters.length,
    skippedCount: entries.length - chapters.length,
    itemRefs,
  };
}
