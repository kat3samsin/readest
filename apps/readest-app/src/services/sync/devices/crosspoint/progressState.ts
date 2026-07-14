import { md5 } from 'js-md5';

import type { AppService } from '@/types/system';
import type { CrossPointDevice } from '@/types/settings';
import { normalizeCrossPointServerUrl } from './client';
import {
  MAX_PROGRESS_XPOINTER_BYTES,
  isCrossPointDocumentId,
  samePortableReadestPosition,
  type PortableReadestPosition,
} from './progressProtocol';

const BRIDGE_KEY = /^[0-9a-f]{32}$/;
const encoder = new TextEncoder();

export interface CrossPointPendingProgress {
  revision: string;
  xpointer: string;
  percentage: number;
  observedReadest: PortableReadestPosition | null;
}

export interface CrossPointLocalProgressState {
  schemaVersion: 1;
  document: string;
  baseline: {
    crosspointRevision: string | null;
    readest: PortableReadestPosition | null;
  };
  pendingCrosspoint: CrossPointPendingProgress | null;
  /** The one prior Readest wire position a completed live apply may repair. */
  staleReadest?: PortableReadestPosition;
}

export interface CrossPointProgressStateStore {
  load(document: string): Promise<CrossPointLocalProgressState | null>;
  save(state: CrossPointLocalProgressState): Promise<void>;
  remove(document: string): Promise<void>;
  gc(activeDocuments: ReadonlySet<string>): Promise<void>;
  clear(): Promise<void>;
}

interface BridgeIdentity {
  serverUrl: string;
  username?: string;
  device: CrossPointDevice;
  serial?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRevisionOrNull = (value: unknown): value is string | null =>
  value === null || isCrossPointDocumentId(value);

const isPercentage = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const isXPointer = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  encoder.encode(value).byteLength <= MAX_PROGRESS_XPOINTER_BYTES;

const parsePortablePosition = (value: unknown): PortableReadestPosition | null | undefined => {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isCrossPointDocumentId(value['revision']) ||
    !isXPointer(value['xpointer']) ||
    !isPercentage(value['percentage'])
  ) {
    return undefined;
  }
  return {
    revision: value['revision'],
    xpointer: value['xpointer'],
    percentage: value['percentage'],
  };
};

const invalidState = (): never => {
  throw new Error('invalid CrossPoint local progress state');
};

export const parseCrossPointLocalProgressState = (
  raw: string,
  expectedDocument: string,
): CrossPointLocalProgressState => {
  if (!isCrossPointDocumentId(expectedDocument)) return invalidState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidState();
  }
  if (
    !isRecord(parsed) ||
    parsed['schemaVersion'] !== 1 ||
    parsed['document'] !== expectedDocument ||
    !isRecord(parsed['baseline'])
  ) {
    return invalidState();
  }

  const crosspointRevision = parsed['baseline']['crosspointRevision'];
  const readest = parsePortablePosition(parsed['baseline']['readest']);
  if (!isRevisionOrNull(crosspointRevision) || readest === undefined) return invalidState();

  const staleReadest =
    'staleReadest' in parsed ? parsePortablePosition(parsed['staleReadest']) : null;
  if (staleReadest === undefined) return invalidState();

  const rawPending = parsed['pendingCrosspoint'];
  let pendingCrosspoint: CrossPointPendingProgress | null = null;
  if (rawPending !== null) {
    if (!isRecord(rawPending)) return invalidState();
    const observedReadest = parsePortablePosition(rawPending['observedReadest']);
    if (
      !isCrossPointDocumentId(rawPending['revision']) ||
      !isXPointer(rawPending['xpointer']) ||
      !isPercentage(rawPending['percentage']) ||
      observedReadest === undefined
    ) {
      return invalidState();
    }
    pendingCrosspoint = {
      revision: rawPending['revision'],
      xpointer: rawPending['xpointer'],
      percentage: rawPending['percentage'],
      observedReadest,
    };
  }

  const state: CrossPointLocalProgressState = {
    schemaVersion: 1,
    document: expectedDocument,
    baseline: { crosspointRevision, readest },
    pendingCrosspoint,
  };
  if (staleReadest) state.staleReadest = staleReadest;
  return state;
};

export const buildCrossPointBridgeKey = ({ serverUrl, device, serial }: BridgeIdentity): string => {
  const normalizedSerial = serial?.trim().toLowerCase();
  const identity =
    normalizedSerial && normalizedSerial !== 'not found'
      ? ['serial', normalizedSerial]
      : ['endpoint', normalizeCrossPointServerUrl(serverUrl), device];
  if (!identity[1]) throw new Error('invalid CrossPoint bridge identity');
  return md5(JSON.stringify(identity));
};

const assertBridgeKey = (bridgeKey: string): void => {
  if (!BRIDGE_KEY.test(bridgeKey)) throw new Error('invalid CrossPoint bridge key');
};

const progressDir = (bridgeKey: string): string => {
  assertBridgeKey(bridgeKey);
  return `CrossPoint/${bridgeKey}/progress`;
};

export const buildCrossPointProgressStatePath = (bridgeKey: string, document: string): string => {
  if (!isCrossPointDocumentId(document)) throw new Error('invalid CrossPoint document id');
  return `${progressDir(bridgeKey)}/${document}.json`;
};

const readIfPresent = async (appService: AppService, path: string): Promise<string | null> => {
  if (!(await appService.exists(path, 'Data'))) return null;
  const value = await appService.readFile(path, 'Data', 'text');
  return typeof value === 'string' ? value : null;
};

const deleteIfPresent = async (appService: AppService, path: string): Promise<void> => {
  if (await appService.exists(path, 'Data')) await appService.deleteFile(path, 'Data');
};

export const createCrossPointProgressStateStore = (
  appService: AppService,
  bridgeKey: string,
): CrossPointProgressStateStore => {
  const dir = progressDir(bridgeKey);
  return {
    load: async (document) => {
      const path = buildCrossPointProgressStatePath(bridgeKey, document);
      const main = await readIfPresent(appService, path);
      if (main !== null) {
        try {
          return parseCrossPointLocalProgressState(main, document);
        } catch {
          // Recover from the backup below.
        }
      }

      const backup = await readIfPresent(appService, `${path}.bak`);
      if (backup !== null) {
        const recovered = parseCrossPointLocalProgressState(backup, document);
        await appService.writeFile(path, 'Data', JSON.stringify(recovered));
        return recovered;
      }
      if (main !== null) throw new Error('invalid CrossPoint local progress state');
      return null;
    },

    save: async (state) => {
      const path = buildCrossPointProgressStatePath(bridgeKey, state.document);
      const serialized = JSON.stringify(state);
      const normalized = parseCrossPointLocalProgressState(serialized, state.document);
      const body = JSON.stringify(normalized);
      await appService.createDir(dir, 'Data', true);
      // AppService has no cross-platform rename primitive. Keeping a complete
      // backup before replacing the main file gives every platform a valid
      // recovery point if the second write is interrupted.
      await appService.writeFile(`${path}.bak`, 'Data', body);
      await appService.writeFile(path, 'Data', body);
    },

    remove: async (document) => {
      const path = buildCrossPointProgressStatePath(bridgeKey, document);
      await deleteIfPresent(appService, path);
      await deleteIfPresent(appService, `${path}.bak`);
    },

    gc: async (activeDocuments) => {
      if (!(await appService.exists(dir, 'Data'))) return;
      const entries = await appService.readDirectory(dir, 'Data');
      const stale = new Set<string>();
      for (const entry of entries) {
        const match = /^(?<document>[0-9a-f]{32})\.json(?:\.bak)?$/.exec(entry.path);
        const document = match?.groups?.['document'];
        if (document && !activeDocuments.has(document)) stale.add(document);
      }
      for (const document of stale) {
        const path = buildCrossPointProgressStatePath(bridgeKey, document);
        await deleteIfPresent(appService, path);
        await deleteIfPresent(appService, `${path}.bak`);
      }
    },

    clear: async () => {
      const root = `CrossPoint/${bridgeKey}`;
      if (await appService.exists(root, 'Data')) await appService.deleteDir(root, 'Data', true);
    },
  };
};

export const loadPendingCrossPointProgress = async (
  store: CrossPointProgressStateStore,
  document: string,
): Promise<CrossPointPendingProgress | null> =>
  (await store.load(document))?.pendingCrosspoint ?? null;

/** Narrow hand-off for the future live-reader hook after it applies a staged XPointer. */
export const completePendingCrossPointProgress = async (
  store: CrossPointProgressStateStore,
  document: string,
  crosspointRevision: string,
  appliedReadest: PortableReadestPosition,
): Promise<void> => {
  const current = await store.load(document);
  if (!current?.pendingCrosspoint || current.pendingCrosspoint.revision !== crosspointRevision) {
    throw new Error('CrossPoint pending progress changed before apply');
  }
  const { staleReadest: _staleReadest, ...withoutStaleReadest } = current;
  const previousReadest = current.pendingCrosspoint.observedReadest;
  await store.save({
    ...withoutStaleReadest,
    baseline: { crosspointRevision, readest: appliedReadest },
    pendingCrosspoint: null,
    ...(previousReadest && !samePortableReadestPosition(previousReadest, appliedReadest)
      ? { staleReadest: previousReadest }
      : {}),
  });
};
