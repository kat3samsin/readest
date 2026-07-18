'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MdAdd, MdRefresh, MdRssFeed } from 'react-icons/md';
import Dialog from '@/components/Dialog';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { fetchAndParseFeed } from '@/services/rss/feedClient';
import { createFeedBook, generateFeedCoverSvg, rasterizeCoverSvg } from '@/services/rss/feedBook';
import { isFeedBookUrl, parseFeedBookUrl } from '@/services/rss/feedBookUrl';
import { refreshFeedManifest } from '@/services/rss/feedReader';
import { useLibraryStore } from '@/store/libraryStore';
import type { Book } from '@/types/book';
import type { FileSystem } from '@/types/system';
import { getCoverFilename } from '@/utils/book';
import { eventDispatcher } from '@/utils/event';
import { navigateToReader } from '@/utils/nav';
import AddFeedModal from './AddFeedModal';

interface FeedsViewProps {
  onClose: () => void;
}

const feedUrlOf = (book: Book): string | null => {
  if (book.url && isFeedBookUrl(book.url)) {
    try {
      return parseFeedBookUrl(book.url).feedUrl;
    } catch {
      return null;
    }
  }
  return book.metadata?.feedUrl ?? null;
};

const siteNameOf = (feedUrl: string): string => {
  try {
    return new URL(feedUrl).hostname.replace(/^www\./, '');
  } catch {
    return feedUrl;
  }
};

export function FeedsView({ onClose }: FeedsViewProps) {
  const _ = useTranslation();
  const router = useRouter();
  const { envConfig, appService } = useEnv();
  const library = useLibraryStore((state) => state.library);
  const [showAddModal, setShowAddModal] = useState(false);
  const [refreshingHash, setRefreshingHash] = useState<string | null>(null);

  const sites = useMemo(
    () =>
      library.flatMap((book) => {
        const feedUrl = feedUrlOf(book);
        return feedUrl && !book.deletedAt ? [{ book, feedUrl }] : [];
      }),
    [library],
  );

  const refreshSite = async (book: Book, feedUrl: string, showSuccess: boolean) => {
    if (!appService || refreshingHash) return;
    setRefreshingHash(book.hash);
    try {
      await refreshFeedManifest(
        appService as unknown as FileSystem,
        book.hash,
        feedUrl,
        book.title,
      );
      if (showSuccess) {
        eventDispatcher.dispatch('toast', {
          type: 'success',
          message: _('{{title}} is up to date.', { title: book.title }),
          timeout: 2500,
        });
      }
    } catch (error) {
      eventDispatcher.dispatch('toast', {
        type: 'warning',
        message: error instanceof Error ? error.message : _('Could not refresh this site.'),
        timeout: 3500,
      });
    } finally {
      setRefreshingHash(null);
    }
  };

  const handleOpenSite = async (book: Book, feedUrl: string) => {
    await refreshSite(book, feedUrl, false);
    onClose();
    navigateToReader(router, [book.hash]);
  };

  const handleAddSite = async (feedUrl: string) => {
    if (!appService) throw new Error(_('Readest is still starting. Try again in a moment.'));
    if (sites.some((site) => site.feedUrl === feedUrl)) {
      throw new Error(_('You are already subscribed to this site.'));
    }

    const parsed = await fetchAndParseFeed(feedUrl);
    const book = createFeedBook(feedUrl, parsed);
    try {
      const cover = generateFeedCoverSvg(feedUrl, book.title);
      const pngBytes = await rasterizeCoverSvg(cover);
      await appService.createDir(book.hash, 'Books', true);
      await appService.writeFile(getCoverFilename(book), 'Books', pngBytes);
      book.coverImageUrl = await appService.generateCoverImageUrl(book);
    } catch (error) {
      console.warn('Failed to generate feed book cover:', error);
    }

    await useLibraryStore.getState().updateBooks(envConfig, [book]);
    eventDispatcher.dispatch('toast', {
      type: 'success',
      message: _('Subscribed to "{{title}}"', { title: book.title }),
      timeout: 3000,
    });
  };

  return (
    <>
      <Dialog
        isOpen={true}
        title={_('Sites')}
        onClose={onClose}
        bgClassName='sm:!bg-black/75'
        boxClassName='sm:min-w-[520px] sm:w-3/4 sm:h-[85%] sm:!max-w-screen-md'
      >
        <div className='bg-base-100 flex min-h-full flex-col pb-5'>
          <header className='border-base-200 flex flex-col gap-4 border-b px-4 pb-5 pt-2 sm:flex-row sm:items-end sm:justify-between'>
            <div>
              <h1 className='text-2xl font-semibold tracking-tight'>
                {_('Read sites like books')}
              </h1>
              <p className='text-base-content/60 mt-2 max-w-[58ch] text-sm leading-relaxed'>
                {_(
                  'Each site is one living book. New articles are appended while your reading position stays with the articles you already read.',
                )}
              </p>
            </div>
            <button
              type='button'
              className='btn btn-primary btn-sm min-h-10 shrink-0 whitespace-nowrap px-4'
              onClick={() => setShowAddModal(true)}
              aria-label={_('Add site')}
            >
              <MdAdd className='h-4 w-4' />
              {_('Add site')}
            </button>
          </header>

          <div className='min-h-0 flex-1 overflow-y-auto px-4 py-5'>
            {sites.length === 0 ? (
              <div className='text-base-content/60 flex min-h-56 flex-col items-center justify-center text-center'>
                <MdRssFeed className='mb-4 h-10 w-10' />
                <p className='font-medium'>{_('No sites yet.')}</p>
                <p className='mt-1 max-w-sm text-sm'>
                  {_('Add an RSS, Atom, or JSON Feed URL to create your first living book.')}
                </p>
              </div>
            ) : (
              <ul className='eink-bordered border-base-200 divide-base-200 divide-y overflow-hidden rounded-xl border'>
                {sites.map(({ book, feedUrl }) => {
                  const isRefreshing = refreshingHash === book.hash;
                  return (
                    <li
                      key={book.hash}
                      className='flex min-h-20 items-center gap-3 px-4 py-3 sm:gap-4'
                    >
                      <div className='bg-base-200 eink-bordered flex h-11 w-11 shrink-0 items-center justify-center rounded-lg'>
                        <MdRssFeed className='h-5 w-5' />
                      </div>
                      <div className='min-w-0 flex-1'>
                        <strong className='block truncate text-sm'>{book.title}</strong>
                        <span className='text-base-content/55 mt-1 block truncate text-xs'>
                          {siteNameOf(feedUrl)}
                        </span>
                        <span className='text-base-content/55 mt-1 block text-xs'>
                          {book.progress ? _('Continue reading') : _('Start reading')}
                        </span>
                      </div>
                      <button
                        type='button'
                        className='btn btn-ghost btn-sm eink-bordered min-h-9 w-9 shrink-0 p-0'
                        disabled={!!refreshingHash}
                        onClick={() => void refreshSite(book, feedUrl, true)}
                        aria-label={_('Refresh {{title}}', { title: book.title })}
                      >
                        {isRefreshing ? (
                          <span className='loading loading-spinner loading-xs' />
                        ) : (
                          <MdRefresh className='h-4 w-4' />
                        )}
                      </button>
                      <button
                        type='button'
                        className='btn btn-primary btn-sm min-h-9 shrink-0 whitespace-nowrap px-4'
                        disabled={!!refreshingHash}
                        onClick={() => void handleOpenSite(book, feedUrl)}
                        aria-label={_('Read {{title}}', { title: book.title })}
                      >
                        {_('Read')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </Dialog>
      <AddFeedModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSubmit={handleAddSite}
      />
    </>
  );
}
