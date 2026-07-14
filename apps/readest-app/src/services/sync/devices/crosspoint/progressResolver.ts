import { DocumentLoader } from '@/libs/document';
import type { Book, BookConfig } from '@/types/book';
import type { AppService } from '@/types/system';
import { isMalformedLocationCfi } from '@/utils/cfi';
import { getXPointerFromCFI } from '@/utils/xcfi';

/** Resolve the authoritative saved CFI without relying on a potentially stale compatibility XPointer. */
export const resolveCrossPointSavedXPointer = async (
  appService: AppService,
  book: Book,
  config: BookConfig,
): Promise<string | null> => {
  const fallback = config.xpointer?.trim() || null;
  if (!config.location || isMalformedLocationCfi(config.location)) return fallback;

  let file: File | null = null;
  try {
    file = (await appService.loadBookContent(book)).file;
    const nativeFilePath = await appService.resolveNativeBookFilePath(book).catch(() => null);
    const { book: bookDoc, format } = await new DocumentLoader(
      file,
      nativeFilePath ? { nativeFilePath } : {},
    ).open();
    if (format !== 'EPUB') return fallback;
    const converted = await getXPointerFromCFI(config.location, undefined, undefined, bookDoc);
    return converted.xpointer.trim() || fallback;
  } catch (error) {
    console.warn('[CrossPoint progress] failed to derive saved XPointer', book.hash, error);
    return fallback;
  } finally {
    const closable = file as (File & { close?: () => Promise<void> }) | null;
    if (closable?.close) await closable.close().catch(() => {});
  }
};
