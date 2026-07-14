import type { BookConfig } from '@/types/book';
import type { BookDoc } from '@/libs/document';
import type { FoliateView } from '@/types/view';
import { getCFIFromXPointer, getXPointerFromCFI } from '@/utils/xcfi';

import { buildPortableReadestPosition, type PortableReadestPosition } from './progressProtocol';
import {
  completePendingCrossPointProgress,
  type CrossPointPendingProgress,
  type CrossPointProgressStateStore,
} from './progressState';

const LIVE_RELOCATE_TIMEOUT_MS = 15_000;
const LIVE_PROGRESS_COMMIT_FRAMES = 4;

export interface CrossPointLiveProgressApplyInput {
  document: string;
  pending: CrossPointPendingProgress;
  stateStore: CrossPointProgressStateStore;
  view: FoliateView;
  bookDoc: BookDoc;
  /**
   * Reads the config populated by FoliateViewer's normal relocate handler.
   * This helper never manufactures a page tuple or mutates BookConfig itself.
   */
  getConfig(): BookConfig | null;
  /** Persist the normal live-reader config before acknowledging the staged item. */
  saveConfig(config: BookConfig): Promise<void>;
  signal?: AbortSignal;
}

export interface CrossPointLiveProgressDependencies {
  getCFIFromXPointer: typeof getCFIFromXPointer;
  getXPointerFromCFI: typeof getXPointerFromCFI;
  nextFrame(): Promise<void>;
  relocateTimeoutMs: number;
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });

const productionDependencies: CrossPointLiveProgressDependencies = {
  getCFIFromXPointer,
  getXPointerFromCFI,
  nextFrame,
  relocateTimeoutMs: LIVE_RELOCATE_TIMEOUT_MS,
};

const abortError = (): Error => new Error('CrossPoint pending progress apply cancelled');

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError();
};

const readRelocatedCfi = (event: Event): string | null => {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== 'object') return null;
  const cfi = (detail as { cfi?: unknown }).cfi;
  return typeof cfi === 'string' && cfi.length > 0 ? cfi : null;
};

interface RelocateWaiter {
  promise: Promise<string>;
  cancel(): void;
}

const waitForLiveRelocate = (
  view: FoliateView,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): RelocateWaiter => {
  let settled = false;
  let rejectPromise: (error: Error) => void = () => {};
  let resolvePromise: (cfi: string) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    view.removeEventListener('relocate', onRelocate);
    signal?.removeEventListener('abort', onAbort);
    if (timer !== null) clearTimeout(timer);
  };
  const settle = (callback: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const onRelocate = (event: Event) => {
    const cfi = readRelocatedCfi(event);
    if (cfi) settle(() => resolvePromise(cfi));
  };
  const onAbort = () => settle(() => rejectPromise(abortError()));

  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  view.addEventListener('relocate', onRelocate);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  else {
    timer = setTimeout(
      () => settle(() => rejectPromise(new Error('CrossPoint pending progress did not relocate'))),
      timeoutMs,
    );
  }

  return {
    promise,
    cancel: () => settle(() => rejectPromise(abortError())),
  };
};

interface CommittedLiveProgress {
  config: BookConfig;
  cfi: string;
  current: number;
  total: number;
}

/**
 * Returns only a config that FoliateViewer's relocate path committed for the
 * relocation we initiated. A pre-existing location, even when it happens to
 * look valid, is not enough to acknowledge a pending CrossPoint update.
 */
export const getCommittedLiveProgress = (
  config: BookConfig | null,
  relocatedCfi: string,
): CommittedLiveProgress | null => {
  if (!config || config.location !== relocatedCfi || !Array.isArray(config.progress)) return null;
  const [current, total] = config.progress;
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(total) ||
    current < 1 ||
    total < 1 ||
    current > total
  ) {
    return null;
  }
  return { config, cfi: relocatedCfi, current, total };
};

const waitForCommittedLiveProgress = async (
  getConfig: () => BookConfig | null,
  relocatedCfi: string,
  signal: AbortSignal | undefined,
  dependencies: CrossPointLiveProgressDependencies,
): Promise<CommittedLiveProgress> => {
  for (let frame = 0; frame < LIVE_PROGRESS_COMMIT_FRAMES; frame += 1) {
    throwIfAborted(signal);
    const committed = getCommittedLiveProgress(getConfig(), relocatedCfi);
    if (committed) return committed;
    await dependencies.nextFrame();
  }
  throw new Error('CrossPoint pending progress was not committed by the live reader');
};

const buildAppliedPosition = async (
  document: string,
  cfi: string,
  current: number,
  total: number,
  view: FoliateView,
  bookDoc: BookDoc,
  dependencies: CrossPointLiveProgressDependencies,
): Promise<PortableReadestPosition> => {
  const contents = view.renderer.getContents();
  const primaryIndex = view.renderer.primaryIndex;
  const content = contents.find((item) => item.index === primaryIndex) ?? contents[0];
  const xpointer = await dependencies.getXPointerFromCFI(
    cfi,
    content?.doc,
    content?.index,
    bookDoc,
  );
  return buildPortableReadestPosition({
    document,
    xpointer: xpointer.xpointer,
    percentage: current / total,
  });
};

/**
 * Applies a staged CrossPoint update through the already-open Foliate view.
 *
 * The only progress we persist is the actual relocation emitted by Foliate and
 * committed by FoliateViewer's normal progress pipeline. This preserves the
 * renderer's real pagination and makes a later retry safe if navigation,
 * conversion, or persistence fails.
 */
export const applyPendingCrossPointProgress = async (
  input: CrossPointLiveProgressApplyInput,
  overrideDependencies: Partial<CrossPointLiveProgressDependencies> = {},
): Promise<PortableReadestPosition> => {
  const dependencies = { ...productionDependencies, ...overrideDependencies };
  throwIfAborted(input.signal);

  const contents = input.view.renderer.getContents();
  const primaryIndex = input.view.renderer.primaryIndex;
  const content = contents.find((item) => item.index === primaryIndex) ?? contents[0];
  const targetCfi = await dependencies.getCFIFromXPointer(
    input.pending.xpointer,
    content?.doc,
    content?.index,
    input.bookDoc,
  );
  throwIfAborted(input.signal);

  // Register before navigating: Foliate may emit relocate synchronously for a
  // same-section target. The listener is cleaned on every success/failure path.
  const relocate = waitForLiveRelocate(input.view, input.signal, dependencies.relocateTimeoutMs);
  // If `goTo` itself rejects before we can await the relocation, cancellation
  // below rejects this waiter. Keep that cleanup rejection observed while the
  // original navigation error remains the one reported to the caller.
  void relocate.promise.catch(() => {});
  try {
    await input.view.goTo(targetCfi);
    const relocatedCfi = await relocate.promise;
    const committed = await waitForCommittedLiveProgress(
      input.getConfig,
      relocatedCfi,
      input.signal,
      dependencies,
    );
    const applied = await buildAppliedPosition(
      input.document,
      committed.cfi,
      committed.current,
      committed.total,
      input.view,
      input.bookDoc,
      dependencies,
    );
    throwIfAborted(input.signal);

    // This is the ordinary, live-reader config snapshot. Saving it before the
    // bridge checkpoint means a crash cannot acknowledge progress that Readest
    // itself failed to retain.
    await input.saveConfig(committed.config);
    throwIfAborted(input.signal);
    await completePendingCrossPointProgress(
      input.stateStore,
      input.document,
      input.pending.revision,
      applied,
    );
    return applied;
  } catch (error) {
    relocate.cancel();
    throw error;
  }
};
