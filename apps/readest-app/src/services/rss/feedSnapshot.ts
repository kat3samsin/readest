import { buildEpub } from '@/services/send/conversion/buildEpub';
import type { EpubChapter } from '@/services/send/conversion/types';
import type { Book } from '@/types/book';
import type { FileSystem } from '@/types/system';
import { sanitizeHtml } from '@/utils/sanitize';
import { loadArticleCache } from './feedArticleContent';
import { parseFeedBookUrl } from './feedBookUrl';
import { loadManifest, type FeedManifest } from './feedManifest';
import { refreshFeedManifest } from './feedReader';
import { sortFeedEntriesNewestFirst } from './makeFeedBook';

export type FeedSnapshotFileSystem = Pick<FileSystem, 'exists' | 'readFile' | 'writeFile'>;

interface FeedSnapshotDependencies {
  build?: typeof buildEpub;
  refresh?: typeof refreshFeedManifest;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const cleanArticleBody = (html: string): string => {
  const doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
  doc.querySelector('h1')?.remove();
  // Cached feed images can still be remote. CrossPoint snapshots must remain
  // readable offline, so omit them instead of shipping broken placeholders.
  doc.querySelectorAll('img').forEach((image) => image.remove());
  return doc.body.innerHTML.trim();
};

/** Materialize the current local state of one living feed book as an EPUB. */
export async function buildFeedSnapshot(
  fs: FeedSnapshotFileSystem,
  book: Book,
  dependencies: FeedSnapshotDependencies = {},
): Promise<Blob> {
  if (!book.url) throw new Error('Feed book URL is missing');
  const { feedUrl } = parseFeedBookUrl(book.url);
  const fileSystem = fs as FileSystem;
  let manifest: FeedManifest;
  try {
    manifest = await (dependencies.refresh ?? refreshFeedManifest)(
      fileSystem,
      book.hash,
      feedUrl,
      book.title,
    );
  } catch {
    // A CrossPoint can be reachable on a LAN with no internet access. In that
    // case, sync the last local feed snapshot instead of failing the book.
    manifest = await loadManifest(fileSystem, book.hash, feedUrl, book.title);
  }
  const chapters: EpubChapter[] = [];

  for (const entry of sortFeedEntriesNewestFirst(manifest.entries)) {
    const cached = await loadArticleCache(fileSystem, book.hash, entry.id);
    const body = cached ? cleanArticleBody(cached) : '<p>Article content unavailable offline.</p>';
    chapters.push({
      title: entry.title,
      html: [
        `<h1>${escapeHtml(entry.title)}</h1>`,
        entry.author ? `<p>${escapeHtml(entry.author)}</p>` : '',
        body,
        `<p><a href="${escapeHtml(entry.link)}">Original article</a></p>`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }

  if (chapters.length === 0) {
    throw new Error('No feed articles are available to sync');
  }

  return (dependencies.build ?? buildEpub)(chapters, {
    title: manifest.title || book.title,
    author: 'Readest feeds',
    language: 'en',
    identifier: feedUrl,
  });
}
