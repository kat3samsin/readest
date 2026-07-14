import type { Book, BookConfig } from '@/types/book';
import type { LocalStore } from '@/services/sync/file/localStore';
import type { CrossPointBookProvider, CrossPointLibraryManifest } from './types';
import {
  buildCrossPointProgressPath,
  buildPortableReadestPosition,
  buildReadestProgressPath,
  parseCrossPointProgressSidecar,
  parseReadestProgressSidecar,
  samePortableReadestPosition,
  serializeReadestProgressSidecar,
  isCrossPointDocumentId,
  type PortableReadestPosition,
} from './progressProtocol';
import {
  planCrossPointProgressExchange,
  type CrossPointProgressConflict,
  type CrossPointProgressPlan,
} from './progressPlanner';
import type { CrossPointProgressStateStore } from './progressState';

export type CrossPointProgressBookStore = Pick<LocalStore, 'loadConfig'>;

export type CrossPointProgressFailureStage = 'READ' | 'PARSE' | 'RESOLVE' | 'WRITE';

export interface CrossPointProgressFailure {
  document: string;
  stage: CrossPointProgressFailureStage;
  reason: string;
}

export interface CrossPointProgressSyncResult {
  considered: number;
  sent: number;
  staged: number;
  acknowledged: number;
  waiting: number;
  repaired: number;
  unchanged: number;
  skipped: number;
  conflicts: CrossPointProgressConflict[];
  failures: CrossPointProgressFailure[];
}

export type CrossPointSavedXPointerResolver = (
  book: Book,
  config: BookConfig,
) => Promise<string | null>;

interface RunCrossPointProgressSyncInput {
  provider: Pick<CrossPointBookProvider, 'readText' | 'writeText'>;
  stateStore: CrossPointProgressStateStore;
  store: CrossPointProgressBookStore;
  books: Book[];
  manifest: CrossPointLibraryManifest;
  resolveXPointer: CrossPointSavedXPointerResolver;
}

class ProgressSyncError extends Error {
  constructor(
    readonly stage: CrossPointProgressFailureStage,
    message: string,
  ) {
    super(message);
  }
}

const reasonFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const loadPortablePosition = async (
  store: CrossPointProgressBookStore,
  resolveXPointer: CrossPointSavedXPointerResolver,
  book: Book,
): Promise<PortableReadestPosition | null> => {
  let config: BookConfig | null;
  try {
    config = await store.loadConfig(book);
  } catch (error) {
    throw new ProgressSyncError('RESOLVE', reasonFor(error));
  }
  if (!config?.progress) return null;

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

  let xpointer: string | null;
  try {
    xpointer = await resolveXPointer(book, config);
  } catch (error) {
    throw new ProgressSyncError('RESOLVE', reasonFor(error));
  }
  if (!xpointer) return null;
  return buildPortableReadestPosition({
    document: book.hash,
    xpointer,
    percentage: current / total,
  });
};

const readWire = async (provider: Pick<CrossPointBookProvider, 'readText'>, document: string) => {
  let readestRaw: string | null;
  let crosspointRaw: string | null;
  try {
    readestRaw = await provider.readText(buildReadestProgressPath(document));
    crosspointRaw = await provider.readText(buildCrossPointProgressPath(document));
  } catch (error) {
    throw new ProgressSyncError('READ', reasonFor(error));
  }
  try {
    return {
      readest: parseReadestProgressSidecar(readestRaw, document),
      crosspoint: parseCrossPointProgressSidecar(crosspointRaw, document),
    };
  } catch (error) {
    throw new ProgressSyncError('PARSE', reasonFor(error));
  }
};

const changesLocalState = (plan: CrossPointProgressPlan): boolean =>
  plan.kind !== 'NO_CHANGE' && plan.kind !== 'CONFLICT';

const applyPlan = async (
  provider: Pick<CrossPointBookProvider, 'writeText'>,
  stateStore: CrossPointProgressStateStore,
  previousState: Awaited<ReturnType<CrossPointProgressStateStore['load']>>,
  plan: CrossPointProgressPlan,
): Promise<void> => {
  if (plan.kind === 'CONFLICT') return;
  const shouldSaveState =
    plan.kind !== 'NO_CHANGE' ||
    (previousState !== null && JSON.stringify(previousState) !== JSON.stringify(plan.state));
  try {
    if (shouldSaveState) await stateStore.save(plan.state);
    if (plan.kind === 'WRITE_READEST') {
      await provider.writeText(
        buildReadestProgressPath(plan.sidecar.document),
        serializeReadestProgressSidecar(plan.sidecar),
        'application/json',
      );
    }
  } catch (error) {
    throw new ProgressSyncError('WRITE', reasonFor(error));
  }
};

const scanBook = async (
  input: RunCrossPointProgressSyncInput,
  book: Book,
  attempt = 0,
): Promise<CrossPointProgressPlan> => {
  const localAtStart = await loadPortablePosition(input.store, input.resolveXPointer, book);
  let state;
  try {
    state = await input.stateStore.load(book.hash);
  } catch (error) {
    throw new ProgressSyncError('READ', reasonFor(error));
  }
  const wire = await readWire(input.provider, book.hash);
  const plan = planCrossPointProgressExchange({
    document: book.hash,
    local: localAtStart,
    readest: wire.readest,
    crosspoint: wire.crosspoint,
    state,
  });

  if (changesLocalState(plan)) {
    const currentLocal = await loadPortablePosition(input.store, input.resolveXPointer, book);
    if (!samePortableReadestPosition(localAtStart, currentLocal)) {
      if (attempt === 0) return scanBook(input, book, 1);
      throw new ProgressSyncError('RESOLVE', 'STALE_LOCAL_SNAPSHOT');
    }
  }

  await applyPlan(input.provider, input.stateStore, state, plan);
  return plan;
};

const countPlan = (result: CrossPointProgressSyncResult, plan: CrossPointProgressPlan): void => {
  switch (plan.kind) {
    case 'NO_CHANGE':
      result.unchanged += 1;
      break;
    case 'ACKNOWLEDGED':
      result.acknowledged += 1;
      break;
    case 'WAITING_FOR_ACK':
      result.waiting += 1;
      break;
    case 'STAGE_CROSSPOINT':
      result.staged += 1;
      break;
    case 'WRITE_READEST':
      if (plan.reason === 'WIRE_REPAIR') result.repaired += 1;
      else result.sent += 1;
      break;
    case 'CONFLICT':
      result.conflicts.push(plan.conflict);
      break;
  }
};

export const runCrossPointProgressSync = async (
  input: RunCrossPointProgressSyncInput,
): Promise<CrossPointProgressSyncResult> => {
  const result: CrossPointProgressSyncResult = {
    considered: 0,
    sent: 0,
    staged: 0,
    acknowledged: 0,
    waiting: 0,
    repaired: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: [],
    failures: [],
  };
  const activeDocuments = new Set(
    input.books
      .filter((book) => book.format === 'EPUB' && !book.deletedAt)
      .map((book) => book.hash)
      .filter(isCrossPointDocumentId),
  );

  for (const book of input.books) {
    if (book.format !== 'EPUB' || book.deletedAt) continue;
    const manifestEntry = input.manifest.books[book.hash];
    if (!isCrossPointDocumentId(book.hash) || manifestEntry?.state !== 'active') {
      result.skipped += 1;
      continue;
    }
    result.considered += 1;
    try {
      countPlan(result, await scanBook(input, book));
    } catch (error) {
      result.failures.push({
        document: book.hash,
        stage: error instanceof ProgressSyncError ? error.stage : 'RESOLVE',
        reason: reasonFor(error),
      });
    }
  }

  try {
    await input.stateStore.gc(activeDocuments);
  } catch (error) {
    result.failures.push({
      document: '00000000000000000000000000000000',
      stage: 'WRITE',
      reason: `progress state GC: ${reasonFor(error)}`,
    });
  }
  return result;
};
