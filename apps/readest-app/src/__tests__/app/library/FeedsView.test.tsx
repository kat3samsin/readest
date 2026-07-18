import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeedBook } from '@/services/rss/feedBook';
import { useLibraryStore } from '@/store/libraryStore';
import type { Book } from '@/types/book';

const fetchAndParseFeed = vi.hoisted(() => vi.fn());
const refreshFeedManifest = vi.hoisted(() => vi.fn());
const rasterizeCoverSvg = vi.hoisted(() => vi.fn());
const navigateToReader = vi.hoisted(() => vi.fn());
const saveLibraryBooks = vi.hoisted(() => vi.fn(async () => {}));

const appService = {
  createDir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  generateCoverImageUrl: vi.fn(async () => 'blob:cover'),
  saveLibraryBooks,
};
const envConfig = { getAppService: vi.fn(async () => appService) };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig, appService }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, values?: Record<string, string | number>) =>
    key.replace(/{{(\w+)}}/g, (_match, name: string) => String(values?.[name] ?? '')),
}));

vi.mock('@/components/Dialog', () => ({
  default: ({ title, children }: { title?: string; children: ReactNode }) => (
    <div>
      <div>{title}</div>
      {children}
    </div>
  ),
}));

vi.mock('@/app/library/components/feeds/AddFeedModal', () => ({
  default: ({
    isOpen,
    onSubmit,
  }: {
    isOpen: boolean;
    onSubmit?: (url: string) => Promise<void>;
  }) =>
    isOpen ? (
      <button type='button' onClick={() => void onSubmit?.('https://new.example/feed.xml')}>
        Confirm subscription
      </button>
    ) : null,
}));

vi.mock('@/services/rss/feedClient', () => ({ fetchAndParseFeed }));
vi.mock('@/services/rss/feedReader', () => ({ refreshFeedManifest }));
vi.mock('@/services/rss/feedBook', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/rss/feedBook')>();
  return { ...original, rasterizeCoverSvg };
});
vi.mock('@/utils/nav', () => ({ navigateToReader }));

import { FeedsView } from '@/app/library/components/feeds/FeedsView';

const regularBook = {
  hash: 'regular-book',
  format: 'EPUB',
  title: 'A regular book',
  author: 'Author',
  createdAt: 1,
  updatedAt: 1,
} as Book;

const feedBook = createFeedBook('https://example.com/feed.xml', {
  title: 'Example site',
  items: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  refreshFeedManifest.mockResolvedValue({
    feedUrl: 'https://example.com/feed.xml',
    title: 'Example site',
    entries: [],
  });
  fetchAndParseFeed.mockResolvedValue({ title: 'New site', items: [] });
  rasterizeCoverSvg.mockResolvedValue(new ArrayBuffer(8));
  useLibraryStore.setState({
    library: [regularBook, feedBook],
    libraryLoaded: true,
    hashIndex: new Map([
      [regularBook.hash, 0],
      [feedBook.hash, 1],
    ]),
    visibleLibrary: [regularBook, feedBook],
  } as never);
});

afterEach(cleanup);

describe('FeedsView', () => {
  it('treats each subscribed site as a book and opens it in the Readest reader', async () => {
    render(<FeedsView onClose={() => {}} />);

    expect(await screen.findByText('Example site')).toBeTruthy();
    expect(screen.queryByText('A regular book')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Read Example site' }));

    await waitFor(() =>
      expect(refreshFeedManifest).toHaveBeenCalledWith(
        appService,
        feedBook.hash,
        'https://example.com/feed.xml',
        'Example site',
      ),
    );
    expect(navigateToReader).toHaveBeenCalledWith(expect.anything(), [feedBook.hash]);
  });

  it('creates one living library book when a site is subscribed', async () => {
    render(<FeedsView onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add site' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm subscription' }));

    await waitFor(() =>
      expect(useLibraryStore.getState().library.some((book) => book.title === 'New site')).toBe(
        true,
      ),
    );
    expect(fetchAndParseFeed).toHaveBeenCalledWith('https://new.example/feed.xml');
    expect(saveLibraryBooks).toHaveBeenCalled();
  });
});
