import { describe, expect, test, vi } from 'vitest';

import type { Book, BookConfig } from '@/types/book';
import type {
  CrossPointBookProvider,
  CrossPointLibraryManifest,
} from '@/services/sync/devices/crosspoint/types';
import {
  buildCrossPointProgressPath,
  buildPortableReadestPosition,
  buildReadestProgressPath,
  buildReadestProgressSidecar,
  computeCrossPointProgressRevision,
} from '@/services/sync/devices/crosspoint/progressProtocol';
import {
  runCrossPointProgressSync,
  type CrossPointProgressBookStore,
} from '@/services/sync/devices/crosspoint/progressSync';
import type {
  CrossPointLocalProgressState,
  CrossPointProgressStateStore,
} from '@/services/sync/devices/crosspoint/progressState';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CROSSPOINT_XPOINTER = '/body/DocFragment[7]/body';
const C2 = computeCrossPointProgressRevision({
  document: HASH_A,
  xpointer: CROSSPOINT_XPOINTER,
  percentage: 0.2,
});
const C3 = computeCrossPointProgressRevision({
  document: HASH_A,
  xpointer: CROSSPOINT_XPOINTER,
  percentage: 0.7,
});

const makeBook = (hash: string, overrides: Partial<Book> = {}): Book => ({
  hash,
  format: 'EPUB',
  title: `Book ${hash.slice(0, 4)}`,
  author: 'Author',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const manifest = (hashes: string[]): CrossPointLibraryManifest => ({
  version: 1,
  books: Object.fromEntries(
    hashes.map((hash) => [
      hash,
      { path: `/${hash}.epub`, size: 42, revision: 1, state: 'active' as const },
    ]),
  ),
});

const makeStateStore = () => {
  const states = new Map<string, CrossPointLocalProgressState>();
  const store: CrossPointProgressStateStore = {
    load: vi.fn(async (document) => states.get(document) ?? null),
    save: vi.fn(async (value) => {
      states.set(value.document, structuredClone(value));
    }),
    remove: vi.fn(async (document) => {
      states.delete(document);
    }),
    gc: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
  return { store, states };
};

const makeProvider = (readText: (path: string) => Promise<string | null>) =>
  ({
    readText: vi.fn(readText),
    writeText: vi.fn(async () => {}),
  }) as unknown as CrossPointBookProvider;

const config = (xpointer: string, current = 2, total = 10): BookConfig => ({
  updatedAt: 5,
  xpointer,
  progress: [current, total],
});

const crosspointRaw = (document: string, percentage = 0.7) =>
  JSON.stringify({
    schemaVersion: 2,
    document,
    revision: computeCrossPointProgressRevision({
      document,
      xpointer: CROSSPOINT_XPOINTER,
      percentage,
    }),
    xpointer: CROSSPOINT_XPOINTER,
    percentage,
    appliedReadest: null,
    spineIndex: 6,
    pageNumber: 7,
    pageCount: 10,
  });

describe('runCrossPointProgressSync', () => {
  test('scans only manifest-owned active EPUBs sequentially', async () => {
    const { store: stateStore } = makeStateStore();
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = makeProvider(async (path) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(path);
      await Promise.resolve();
      inFlight -= 1;
      return null;
    });
    const bookStore: CrossPointProgressBookStore = {
      loadConfig: vi.fn(async () => null),
    };

    const result = await runCrossPointProgressSync({
      provider,
      stateStore,
      store: bookStore,
      books: [
        makeBook(HASH_A),
        makeBook(HASH_B),
        makeBook('cccccccccccccccccccccccccccccccc', { format: 'PDF' }),
      ],
      manifest: manifest([HASH_A, HASH_B]),
      resolveXPointer: async (_book, value) => value.xpointer ?? null,
    });

    expect(maxInFlight).toBe(1);
    expect(result).toMatchObject({ considered: 2, unchanged: 2, failures: [], conflicts: [] });
    expect(events).toEqual([
      buildReadestProgressPath(HASH_A),
      buildCrossPointProgressPath(HASH_A),
      buildReadestProgressPath(HASH_B),
      buildCrossPointProgressPath(HASH_B),
    ]);
  });

  test('stages inbound closed-book progress without mutating BookConfig or Book fields', async () => {
    const book = makeBook(HASH_A, { progress: [2, 10], updatedAt: 123 });
    const original = structuredClone(book);
    const local = buildPortableReadestPosition({
      document: HASH_A,
      xpointer: '/body/DocFragment[2]/body',
      percentage: 0.2,
    });
    const currentState: CrossPointLocalProgressState = {
      schemaVersion: 1,
      document: HASH_A,
      baseline: { crosspointRevision: C2, readest: local },
      pendingCrosspoint: null,
    };
    const { store: stateStore, states } = makeStateStore();
    states.set(HASH_A, currentState);
    const provider = makeProvider(async (path) => {
      if (path.endsWith('.readest.json')) {
        return JSON.stringify(buildReadestProgressSidecar(HASH_A, local, C2));
      }
      return crosspointRaw(HASH_A);
    });
    const savedConfig = config(local.xpointer);
    const bookStore: CrossPointProgressBookStore = {
      loadConfig: vi.fn(async () => structuredClone(savedConfig)),
    };

    const result = await runCrossPointProgressSync({
      provider,
      stateStore,
      store: bookStore,
      books: [book],
      manifest: manifest([HASH_A]),
      resolveXPointer: async (_book, value) => value.xpointer ?? null,
    });

    expect(result).toMatchObject({ considered: 1, staged: 1, sent: 0 });
    expect(book).toEqual(original);
    expect(savedConfig).toEqual(config(local.xpointer));
    expect(states.get(HASH_A)).toMatchObject({
      baseline: currentState.baseline,
      pendingCrosspoint: { revision: C3, observedReadest: local },
    });
    expect(provider.writeText).not.toHaveBeenCalled();
  });

  test('stages a baseline conflict when the user explicitly chooses CrossPoint progress', async () => {
    const { store: stateStore, states } = makeStateStore();
    const local = buildPortableReadestPosition({
      document: HASH_A,
      xpointer: '/body/DocFragment[2]/body',
      percentage: 0.2,
    });
    const provider = makeProvider(async (path) => {
      if (path.endsWith('.readest.json')) {
        return JSON.stringify(buildReadestProgressSidecar(HASH_A, local, C2));
      }
      return crosspointRaw(HASH_A);
    });
    const bookStore: CrossPointProgressBookStore = {
      loadConfig: vi.fn(async () => config(local.xpointer)),
    };

    const result = await runCrossPointProgressSync({
      provider,
      stateStore,
      store: bookStore,
      books: [makeBook(HASH_A)],
      manifest: manifest([HASH_A]),
      resolveXPointer: async (_book, value) => value.xpointer ?? null,
      preferCrossPointDocuments: [HASH_A],
    });

    expect(result).toMatchObject({ staged: 1, conflicts: [], failures: [] });
    expect(states.get(HASH_A)).toMatchObject({
      pendingCrosspoint: { revision: C3, observedReadest: local },
      staleReadest: local,
    });
    expect(provider.writeText).not.toHaveBeenCalled();
  });

  test('publishes local progress and retries once from a fresh snapshot', async () => {
    const { store: stateStore, states } = makeStateStore();
    const r2 = buildPortableReadestPosition({
      document: HASH_A,
      xpointer: '/body/DocFragment[2]/body',
      percentage: 0.2,
    });
    states.set(HASH_A, {
      schemaVersion: 1,
      document: HASH_A,
      baseline: { crosspointRevision: C2, readest: r2 },
      pendingCrosspoint: null,
    });
    const provider = makeProvider(async (path) => {
      if (path.endsWith('.readest.json')) {
        return JSON.stringify(buildReadestProgressSidecar(HASH_A, r2, C2));
      }
      return crosspointRaw(HASH_A, 0.2);
    });
    const snapshots = [
      config('/body/DocFragment[3]/body', 3),
      config('/body/DocFragment[4]/body', 4),
      config('/body/DocFragment[4]/body', 4),
      config('/body/DocFragment[4]/body', 4),
    ];
    const bookStore: CrossPointProgressBookStore = {
      loadConfig: vi.fn(async () => structuredClone(snapshots.shift()!)),
    };

    const result = await runCrossPointProgressSync({
      provider,
      stateStore,
      store: bookStore,
      books: [makeBook(HASH_A)],
      manifest: manifest([HASH_A]),
      resolveXPointer: async (_book, value) => value.xpointer ?? null,
    });

    expect(result).toMatchObject({ sent: 1, failures: [] });
    expect(provider.readText).toHaveBeenCalledTimes(4);
    expect(provider.writeText).toHaveBeenCalledOnce();
    const body = vi.mocked(provider.writeText).mock.calls[0]?.[1];
    expect(JSON.parse(body!)).toMatchObject({
      xpointer: '/body/DocFragment[4]/body',
      percentage: Math.fround(0.4),
      basedOnCrosspoint: C2,
    });
  });

  test('reports a repeated stale local snapshot instead of writing old progress', async () => {
    const { store: stateStore } = makeStateStore();
    let page = 1;
    const provider = makeProvider(async () => null);
    const bookStore: CrossPointProgressBookStore = {
      loadConfig: vi.fn(async () => {
        page += 1;
        return config(`/body/DocFragment[${page}]/body`, page);
      }),
    };

    const result = await runCrossPointProgressSync({
      provider,
      stateStore,
      store: bookStore,
      books: [makeBook(HASH_A)],
      manifest: manifest([HASH_A]),
      resolveXPointer: async (_book, value) => value.xpointer ?? null,
    });

    expect(result.failures).toEqual([
      { document: HASH_A, stage: 'RESOLVE', reason: 'STALE_LOCAL_SNAPSHOT' },
    ]);
    expect(provider.writeText).not.toHaveBeenCalled();
  });

  test('records one malformed sidecar failure and continues with the next book', async () => {
    const { store: stateStore } = makeStateStore();
    const provider = makeProvider(async (path) => {
      if (path.includes(HASH_A) && path.endsWith('.crosspoint.json')) return '{';
      return null;
    });
    const bookStore: CrossPointProgressBookStore = { loadConfig: vi.fn(async () => null) };

    const result = await runCrossPointProgressSync({
      provider,
      stateStore,
      store: bookStore,
      books: [makeBook(HASH_A), makeBook(HASH_B)],
      manifest: manifest([HASH_A, HASH_B]),
      resolveXPointer: async (_book, value) => value.xpointer ?? null,
    });

    expect(result).toMatchObject({ considered: 2, unchanged: 1 });
    expect(result.failures).toEqual([
      {
        document: HASH_A,
        stage: 'PARSE',
        reason: 'invalid CrossPoint progress sidecar',
      },
    ]);
  });
});
