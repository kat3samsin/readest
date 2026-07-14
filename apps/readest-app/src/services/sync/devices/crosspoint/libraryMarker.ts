import type { EnvConfigType } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import type { CrossPointHydratedBookMarker } from './runBookSync';

/** Persist a batch of field-scoped download markers against the latest live library. */
export const persistCrossPointHydratedBookMarkers = async (
  envConfig: EnvConfigType,
  markers: CrossPointHydratedBookMarker[],
): Promise<void> => {
  if (!markers.length) return;
  const appService = await envConfig.getAppService();
  let state = useLibraryStore.getState();
  if (!state.libraryLoaded) {
    state.setLibrary(await appService.loadLibraryBooks());
    state = useLibraryStore.getState();
  }

  const markerByHash = new Map(markers.map((marker) => [marker.bookHash, marker.downloadedAt]));
  const previous = new Map<string, number | null | undefined>();
  for (const hash of markerByHash.keys()) {
    const index = state.hashIndex.get(hash);
    if (index === undefined) throw new Error(`Hydrated book is missing from the library: ${hash}`);
    previous.set(hash, state.library[index]?.downloadedAt);
  }

  const nextLibrary = state.library.map((book) => {
    const downloadedAt = markerByHash.get(book.hash);
    return downloadedAt === undefined ? book : { ...book, downloadedAt };
  });
  state.setLibrary(nextLibrary);
  let firstWriteCompleted = false;
  try {
    await appService.saveLibraryBooks(nextLibrary);
    firstWriteCompleted = true;

    // Any row can change while the whole-library file is being written. Flush
    // the newest complete library once so the marker batch cannot leave an
    // unrelated row's older snapshot on disk.
    const latest = useLibraryStore.getState().library;
    if (latest !== nextLibrary) await appService.saveLibraryBooks(latest);
  } catch (error) {
    if (!firstWriteCompleted) {
      const latest = useLibraryStore.getState();
      const rolledBack = latest.library.map((book) => {
        const marker = markerByHash.get(book.hash);
        if (marker === undefined || book.downloadedAt !== marker) return book;
        const restored = { ...book };
        const oldValue = previous.get(book.hash);
        if (oldValue === undefined) delete restored.downloadedAt;
        else restored.downloadedAt = oldValue;
        return restored;
      });
      latest.setLibrary(rolledBack);
    }
    throw error;
  }
};

/** Compatibility helper for call sites that genuinely persist one marker. */
export const persistCrossPointHydratedBookMarker = async (
  envConfig: EnvConfigType,
  marker: CrossPointHydratedBookMarker,
): Promise<void> => persistCrossPointHydratedBookMarkers(envConfig, [marker]);
