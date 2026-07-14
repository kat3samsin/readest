import { useEffect, useRef } from 'react';

import type { BookDoc } from '@/libs/document';
import { useEnv } from '@/context/EnvContext';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { FoliateView } from '@/types/view';
import { eventDispatcher } from '@/utils/event';
import { applyPendingCrossPointProgress } from '@/services/sync/devices/crosspoint/liveProgress';
import {
  buildCrossPointBridgeKey,
  createCrossPointProgressStateStore,
  loadPendingCrossPointProgress,
} from '@/services/sync/devices/crosspoint/progressState';
import { isCrossPointDocumentId } from '@/services/sync/devices/crosspoint/progressProtocol';

/**
 * Applies a CrossPoint position only after the book has opened in a real
 * desktop reader view. Background device sync deliberately stages these
 * positions instead of mutating a closed book's config, because Readest's
 * pagination is available only here.
 */
export const useCrossPointPendingProgress = (
  bookKey: string,
  bookDoc: BookDoc,
  view: FoliateView | null,
) => {
  const { appService, envConfig } = useEnv();
  const getBookData = useBookDataStore((state) => state.getBookData);
  const getConfig = useBookDataStore((state) => state.getConfig);
  const saveConfig = useBookDataStore((state) => state.saveConfig);
  const previewMode = useReaderStore((state) => state.viewStates[bookKey]?.previewMode ?? false);
  const crosspoint = useSettingsStore((state) => state.settings.crosspoint);
  const attemptedViewRef = useRef<FoliateView | null>(null);

  useEffect(() => {
    if (!view || attemptedViewRef.current === view) return;
    if (!appService?.isDesktopApp || previewMode) return;
    if (!crosspoint.serverUrl || !crosspoint.device) return;

    const book = getBookData(bookKey)?.book;
    if (!book || book.format !== 'EPUB' || !isCrossPointDocumentId(book.hash)) return;

    let bridgeKey: string;
    try {
      bridgeKey = buildCrossPointBridgeKey({
        serverUrl: crosspoint.serverUrl,
        device: crosspoint.device,
        serial: crosspoint.serial,
      });
    } catch (error) {
      console.warn('[CrossPoint progress] invalid device identity', error);
      return;
    }

    // A failed apply remains staged until the next reader open. Do not let a
    // settings rerender start competing navigation attempts in this live view.
    attemptedViewRef.current = view;
    const controller = new AbortController();
    const stateStore = createCrossPointProgressStateStore(appService, bridgeKey);

    const run = async () => {
      const pending = await loadPendingCrossPointProgress(stateStore, book.hash);
      if (!pending || controller.signal.aborted) return;

      await applyPendingCrossPointProgress({
        document: book.hash,
        pending,
        stateStore,
        view,
        bookDoc,
        getConfig: () => getConfig(bookKey),
        saveConfig: async (config) => {
          const latestSettings = useSettingsStore.getState().settings;
          await saveConfig(envConfig, bookKey, config, latestSettings);
        },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        eventDispatcher.dispatch('hint', {
          bookKey,
          message: 'CrossPoint reading progress synced',
        });
      }
    };

    run().catch((error) => {
      if (!controller.signal.aborted) {
        console.warn('[CrossPoint progress] failed to apply staged progress', book.hash, error);
      }
    });

    return () => controller.abort();
  }, [
    appService,
    bookDoc,
    bookKey,
    crosspoint.device,
    crosspoint.serial,
    crosspoint.serverUrl,
    envConfig,
    getBookData,
    getConfig,
    previewMode,
    saveConfig,
    view,
  ]);
};
