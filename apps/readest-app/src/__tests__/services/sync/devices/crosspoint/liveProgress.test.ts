import { describe, expect, test, vi } from 'vitest';

import type { BookConfig } from '@/types/book';
import type { FoliateView } from '@/types/view';
import {
  applyPendingCrossPointProgress,
  getCommittedLiveProgress,
} from '@/services/sync/devices/crosspoint/liveProgress';
import type {
  CrossPointLocalProgressState,
  CrossPointProgressStateStore,
} from '@/services/sync/devices/crosspoint/progressState';

const DOCUMENT = '0123456789abcdef0123456789abcdef';
const CROSSPOINT_REVISION = '11111111111111111111111111111111';
const REMOTE_XPOINTER = '/body/DocFragment[3]/body/p[2]';
const APPLIED_XPOINTER = '/body/DocFragment[3]/body/p[3]/text().7';
const TARGET_CFI = 'epubcfi(/6/6!/4/2:7)';

const makeState = (): CrossPointLocalProgressState => ({
  schemaVersion: 1,
  document: DOCUMENT,
  baseline: { crosspointRevision: null, readest: null },
  pendingCrosspoint: {
    revision: CROSSPOINT_REVISION,
    xpointer: REMOTE_XPOINTER,
    percentage: 0.3,
    observedReadest: null,
  },
});

const makeStateStore = () => {
  let current = makeState();
  const stateStore: CrossPointProgressStateStore = {
    load: vi.fn(async () => structuredClone(current)),
    save: vi.fn(async (next) => {
      current = structuredClone(next);
    }),
    remove: vi.fn(async () => {}),
    gc: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
  return { stateStore, getCurrent: () => current };
};

const makeView = (onRelocate: (cfi: string) => void): FoliateView => {
  const view = document.createElement('div') as unknown as FoliateView;
  Object.assign(view, {
    renderer: {
      primaryIndex: 2,
      getContents: () => [],
    },
    goTo: vi.fn((cfi: string) => {
      onRelocate(cfi);
      view.dispatchEvent(new CustomEvent('relocate', { detail: { cfi } }));
    }),
  });
  return view;
};

describe('CrossPoint staged live progress apply', () => {
  test('only accepts a normal relocate pipeline commit for the exact live CFI', () => {
    expect(
      getCommittedLiveProgress(
        { updatedAt: 1, location: TARGET_CFI, progress: [42, 100] },
        TARGET_CFI,
      ),
    ).toMatchObject({ cfi: TARGET_CFI, current: 42, total: 100 });
    expect(
      getCommittedLiveProgress(
        { updatedAt: 1, location: 'epubcfi(/6/2!/4/2:0)', progress: [42, 100] },
        TARGET_CFI,
      ),
    ).toBeNull();
    expect(
      getCommittedLiveProgress(
        { updatedAt: 1, location: TARGET_CFI, progress: [0, 100] },
        TARGET_CFI,
      ),
    ).toBeNull();
  });

  test('navigates through Foliate, saves its actual tuple, then completes the staged state', async () => {
    const { stateStore, getCurrent } = makeStateStore();
    let config: BookConfig = { updatedAt: 1, location: 'epubcfi(/6/2!/4/2:0)', progress: [2, 10] };
    const view = makeView((cfi) => {
      // This listener stands in for FoliateViewer's already-registered normal
      // relocate pipeline: it writes real live location/page data before the
      // CrossPoint listener observes the event.
      config = { updatedAt: 1, location: cfi, progress: [42, 100] };
    });
    const saveConfig = vi.fn(async () => {});

    const applied = await applyPendingCrossPointProgress(
      {
        document: DOCUMENT,
        pending: makeState().pendingCrosspoint!,
        stateStore,
        view,
        bookDoc: {} as never,
        getConfig: () => config,
        saveConfig,
      },
      {
        getCFIFromXPointer: vi.fn(async () => TARGET_CFI),
        getXPointerFromCFI: vi.fn(async () => ({ xpointer: APPLIED_XPOINTER })),
        nextFrame: async () => {},
        relocateTimeoutMs: 25,
      },
    );

    expect(view.goTo).toHaveBeenCalledWith(TARGET_CFI);
    expect(saveConfig).toHaveBeenCalledWith({
      updatedAt: 1,
      location: TARGET_CFI,
      progress: [42, 100],
    });
    expect(applied).toMatchObject({
      xpointer: APPLIED_XPOINTER,
      percentage: Math.fround(0.42),
    });
    expect(getCurrent()).toMatchObject({
      baseline: { crosspointRevision: CROSSPOINT_REVISION, readest: applied },
      pendingCrosspoint: null,
    });
  });

  test('keeps the item staged when Foliate did not commit its relocation', async () => {
    const { stateStore, getCurrent } = makeStateStore();
    const config: BookConfig = {
      updatedAt: 1,
      location: 'epubcfi(/6/2!/4/2:0)',
      progress: [2, 10],
    };
    const view = makeView(() => {});
    const saveConfig = vi.fn(async () => {});

    await expect(
      applyPendingCrossPointProgress(
        {
          document: DOCUMENT,
          pending: makeState().pendingCrosspoint!,
          stateStore,
          view,
          bookDoc: {} as never,
          getConfig: () => config,
          saveConfig,
        },
        {
          getCFIFromXPointer: vi.fn(async () => TARGET_CFI),
          getXPointerFromCFI: vi.fn(async () => ({ xpointer: APPLIED_XPOINTER })),
          nextFrame: async () => {},
          relocateTimeoutMs: 25,
        },
      ),
    ).rejects.toThrow('was not committed by the live reader');

    expect(saveConfig).not.toHaveBeenCalled();
    expect(getCurrent().pendingCrosspoint).toEqual(makeState().pendingCrosspoint);
  });
});
