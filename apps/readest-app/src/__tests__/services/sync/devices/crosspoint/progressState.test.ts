import { describe, expect, test, vi } from 'vitest';

import type { AppService, BaseDir, FileItem } from '@/types/system';
import {
  buildCrossPointBridgeKey,
  buildCrossPointProgressStatePath,
  completePendingCrossPointProgress,
  createCrossPointProgressStateStore,
  loadPendingCrossPointProgress,
  parseCrossPointLocalProgressState,
  type CrossPointLocalProgressState,
} from '@/services/sync/devices/crosspoint/progressState';
import { buildPortableReadestPosition } from '@/services/sync/devices/crosspoint/progressProtocol';

const DOCUMENT = '0123456789abcdef0123456789abcdef';
const OTHER_DOCUMENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CROSSPOINT_REVISION = '11111111111111111111111111111111';

const state = (): CrossPointLocalProgressState => ({
  schemaVersion: 1,
  document: DOCUMENT,
  baseline: {
    crosspointRevision: null,
    readest: null,
  },
  pendingCrosspoint: {
    revision: CROSSPOINT_REVISION,
    xpointer: '/body/DocFragment[2]/body',
    percentage: 0.25,
    observedReadest: null,
  },
});

const makeAppService = (initial: Record<string, string> = {}) => {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const key = (path: string, base: BaseDir) => `${base}:${path}`;
  const appService = {
    exists: vi.fn(async (path: string, base: BaseDir) => {
      const exact = key(path, base);
      const prefix = key(`${path}/`, base);
      return files.has(exact) || [...files.keys()].some((file) => file.startsWith(prefix));
    }),
    readFile: vi.fn(async (path: string, base: BaseDir) => {
      const value = files.get(key(path, base));
      if (value === undefined) throw new Error('missing');
      return value;
    }),
    writeFile: vi.fn(async (path: string, base: BaseDir, content: string | ArrayBuffer | File) => {
      if (typeof content !== 'string') throw new Error('expected text');
      writes.push(path);
      files.set(key(path, base), content);
    }),
    createDir: vi.fn(async () => {}),
    deleteFile: vi.fn(async (path: string, base: BaseDir) => {
      files.delete(key(path, base));
    }),
    deleteDir: vi.fn(async (path: string, base: BaseDir) => {
      const prefix = key(`${path}/`, base);
      for (const file of [...files.keys()]) {
        if (file.startsWith(prefix)) files.delete(file);
      }
    }),
    readDirectory: vi.fn(async (path: string, base: BaseDir): Promise<FileItem[]> => {
      const prefix = key(`${path}/`, base);
      return [...files.entries()]
        .filter(([file]) => file.startsWith(prefix))
        .map(([file, value]) => ({ path: file.slice(prefix.length), size: value.length }));
    }),
  } as unknown as AppService;
  return { appService, files, writes, key };
};

describe('CrossPoint bridge identity', () => {
  test('prefers a normalized serial and excludes endpoint credentials', () => {
    const first = buildCrossPointBridgeKey({
      serverUrl: 'http://192.168.0.154',
      username: 'crosspoint',
      device: 'X4',
      serial: ' CP-123 ',
    });
    const moved = buildCrossPointBridgeKey({
      serverUrl: 'http://192.168.0.200',
      username: 'someone-else',
      device: 'X3',
      serial: 'cp-123',
    });
    expect(first).toBe(moved);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  test('uses normalized origin and device without treating credentials as identity', () => {
    const base = buildCrossPointBridgeKey({
      serverUrl: ' 192.168.0.154/files ',
      username: 'CrossPoint',
      device: 'X4',
    });
    expect(
      buildCrossPointBridgeKey({
        serverUrl: 'http://192.168.0.154',
        username: 'CrossPoint',
        device: 'X4',
      }),
    ).toBe(base);
    expect(
      buildCrossPointBridgeKey({
        serverUrl: 'http://192.168.0.154',
        username: 'crosspoint',
        device: 'X4',
      }),
    ).toBe(base);
    expect(
      buildCrossPointBridgeKey({
        serverUrl: 'http://192.168.0.154',
        username: 'CrossPoint',
        device: 'X3',
      }),
    ).not.toBe(base);
  });
});

describe('CrossPoint local causal progress state', () => {
  test('strictly validates the version, document, positions, and pending record', () => {
    expect(parseCrossPointLocalProgressState(JSON.stringify(state()), DOCUMENT)).toEqual(state());
    for (const invalid of [
      { ...state(), schemaVersion: 2 },
      { ...state(), document: OTHER_DOCUMENT },
      { ...state(), baseline: { crosspointRevision: 'INVALID', readest: null } },
      { ...state(), pendingCrosspoint: { ...state().pendingCrosspoint, percentage: 2 } },
    ]) {
      expect(() => parseCrossPointLocalProgressState(JSON.stringify(invalid), DOCUMENT)).toThrow(
        'invalid CrossPoint local progress state',
      );
    }
  });

  test('writes the backup before the main file and loads the main state', async () => {
    const { appService, writes } = makeAppService();
    const bridgeKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const store = createCrossPointProgressStateStore(appService, bridgeKey);

    await store.save(state());

    const path = buildCrossPointProgressStatePath(bridgeKey, DOCUMENT);
    expect(writes).toEqual([`${path}.bak`, path]);
    expect(await store.load(DOCUMENT)).toEqual(state());
  });

  test('recovers a valid backup when the main state is corrupt', async () => {
    const bridgeKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const path = buildCrossPointProgressStatePath(bridgeKey, DOCUMENT);
    const { appService, files, key } = makeAppService({
      [`Data:${path}`]: '{',
      [`Data:${path}.bak`]: JSON.stringify(state()),
    });
    const store = createCrossPointProgressStateStore(appService, bridgeKey);

    expect(await store.load(DOCUMENT)).toEqual(state());
    expect(files.get(key(path, 'Data'))).toBe(JSON.stringify(state()));
  });

  test('does not silently turn a corrupt persisted baseline into first sync', async () => {
    const bridgeKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const path = buildCrossPointProgressStatePath(bridgeKey, DOCUMENT);
    const { appService } = makeAppService({ [`Data:${path}`]: '{' });
    const store = createCrossPointProgressStateStore(appService, bridgeKey);

    await expect(store.load(DOCUMENT)).rejects.toThrow('invalid CrossPoint local progress state');
  });

  test('completes a staged inbound position without mutating any book record', async () => {
    const { appService } = makeAppService();
    const store = createCrossPointProgressStateStore(
      appService,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    await store.save(state());
    expect(await loadPendingCrossPointProgress(store, DOCUMENT)).toEqual(state().pendingCrosspoint);
    const applied = buildPortableReadestPosition({
      document: DOCUMENT,
      xpointer: state().pendingCrosspoint!.xpointer,
      percentage: 0.3,
    });

    await completePendingCrossPointProgress(store, DOCUMENT, CROSSPOINT_REVISION, applied);

    expect(await store.load(DOCUMENT)).toEqual({
      schemaVersion: 1,
      document: DOCUMENT,
      baseline: { crosspointRevision: CROSSPOINT_REVISION, readest: applied },
      pendingCrosspoint: null,
    });
  });

  test('records only the previously observed wire position after a live apply', async () => {
    const { appService } = makeAppService();
    const store = createCrossPointProgressStateStore(
      appService,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    const observedReadest = buildPortableReadestPosition({
      document: DOCUMENT,
      xpointer: '/body/DocFragment[2]/body',
      percentage: 0.2,
    });
    await store.save({
      ...state(),
      pendingCrosspoint: { ...state().pendingCrosspoint!, observedReadest },
    });
    const applied = buildPortableReadestPosition({
      document: DOCUMENT,
      xpointer: '/body/DocFragment[3]/body',
      percentage: 0.3,
    });

    await completePendingCrossPointProgress(store, DOCUMENT, CROSSPOINT_REVISION, applied);

    expect(await store.load(DOCUMENT)).toMatchObject({
      baseline: { crosspointRevision: CROSSPOINT_REVISION, readest: applied },
      pendingCrosspoint: null,
      staleReadest: observedReadest,
    });
  });

  test('garbage-collects deleted book state and can clear one disconnected endpoint', async () => {
    const bridgeKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const keepPath = buildCrossPointProgressStatePath(bridgeKey, DOCUMENT);
    const removePath = buildCrossPointProgressStatePath(bridgeKey, OTHER_DOCUMENT);
    const { appService } = makeAppService({
      [`Data:${keepPath}`]: JSON.stringify(state()),
      [`Data:${removePath}`]: JSON.stringify({ ...state(), document: OTHER_DOCUMENT }),
      [`Data:${removePath}.bak`]: JSON.stringify({ ...state(), document: OTHER_DOCUMENT }),
    });
    const store = createCrossPointProgressStateStore(appService, bridgeKey);

    await store.gc(new Set([DOCUMENT]));
    expect(appService.deleteFile).toHaveBeenCalledTimes(2);
    expect(await store.load(DOCUMENT)).toEqual(state());
    expect(await store.load(OTHER_DOCUMENT)).toBeNull();

    await store.clear();
    expect(appService.deleteDir).toHaveBeenCalledWith(`CrossPoint/${bridgeKey}`, 'Data', true);
  });
});
