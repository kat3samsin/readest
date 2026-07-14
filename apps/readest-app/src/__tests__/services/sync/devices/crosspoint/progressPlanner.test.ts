import { describe, expect, test } from 'vitest';

import {
  buildPortableReadestPosition,
  buildReadestProgressSidecar,
  type CrossPointProgressSidecar,
  type PortableReadestPosition,
} from '@/services/sync/devices/crosspoint/progressProtocol';
import {
  planCrossPointProgressExchange,
  type CrossPointProgressConflictKind,
} from '@/services/sync/devices/crosspoint/progressPlanner';
import type { CrossPointLocalProgressState } from '@/services/sync/devices/crosspoint/progressState';

const DOCUMENT = '0123456789abcdef0123456789abcdef';
const C2 = '22222222222222222222222222222222';
const C3 = '33333333333333333333333333333333';

const local = (xpointer: string, percentage: number): PortableReadestPosition =>
  buildPortableReadestPosition({ document: DOCUMENT, xpointer, percentage });

const R2 = local('/body/DocFragment[2]/body', 0.2);
const R3 = local('/body/DocFragment[3]/body', 0.3);
const R4 = local('/body/DocFragment[4]/body', 0.4);

const crosspoint = (
  revision: string,
  xpointer = '/body/DocFragment[2]/body',
  percentage = 0.2,
  appliedReadest: string | null = null,
): CrossPointProgressSidecar => ({
  schemaVersion: 2,
  document: DOCUMENT,
  revision,
  xpointer,
  percentage,
  appliedReadest,
  spineIndex: 1,
  pageNumber: 2,
  pageCount: 10,
});

const causalState = (
  crosspointRevision: string | null = C2,
  readest: PortableReadestPosition | null = R2,
): CrossPointLocalProgressState => ({
  schemaVersion: 1,
  document: DOCUMENT,
  baseline: { crosspointRevision, readest },
  pendingCrosspoint: null,
});

const plan = (overrides: Partial<Parameters<typeof planCrossPointProgressExchange>[0]> = {}) =>
  planCrossPointProgressExchange({
    document: DOCUMENT,
    local: R2,
    readest: buildReadestProgressSidecar(DOCUMENT, R2, C2),
    crosspoint: crosspoint(C2),
    state: causalState(),
    ...overrides,
  });

const expectConflict = (
  result: ReturnType<typeof planCrossPointProgressExchange>,
  kind: CrossPointProgressConflictKind,
) => {
  expect(result.kind).toBe('CONFLICT');
  if (result.kind !== 'CONFLICT') throw new Error('expected conflict');
  expect(result.conflict.kind).toBe(kind);
};

describe('CrossPoint causal progress planner', () => {
  test('handles all four initial change states conservatively', () => {
    expect(plan({ local: null, readest: null, crosspoint: null, state: null })).toMatchObject({
      kind: 'NO_CHANGE',
    });
    expect(plan({ local: R2, readest: null, crosspoint: null, state: null })).toMatchObject({
      kind: 'WRITE_READEST',
      sidecar: { revision: R2.revision, basedOnCrosspoint: null },
    });
    expect(
      plan({ local: null, readest: null, crosspoint: crosspoint(C2), state: null }),
    ).toMatchObject({
      kind: 'STAGE_CROSSPOINT',
      state: {
        baseline: { crosspointRevision: null, readest: null },
        pendingCrosspoint: { revision: C2, observedReadest: null },
      },
    });
    expectConflict(
      plan({ local: R2, readest: null, crosspoint: crosspoint(C2), state: null }),
      'BASELINE_MISSING',
    );
  });

  test('no-ops when neither causal side moved', () => {
    expect(plan()).toMatchObject({ kind: 'NO_CHANGE', state: causalState() });
  });

  test('publishes a local-only move against the current CrossPoint baseline', () => {
    expect(plan({ local: R3 })).toMatchObject({
      kind: 'WRITE_READEST',
      reason: 'LOCAL_CHANGED',
      sidecar: {
        revision: R3.revision,
        xpointer: R3.xpointer,
        basedOnCrosspoint: C2,
      },
    });
  });

  test('waits instead of rewriting an unacknowledged publication', () => {
    expect(
      plan({
        local: R3,
        readest: buildReadestProgressSidecar(DOCUMENT, R3, C2),
      }),
    ).toMatchObject({ kind: 'WAITING_FOR_ACK', readestRevision: R3.revision });
  });

  test('stages a CrossPoint-only move without changing the causal baseline', () => {
    const remote = crosspoint(C3, '/body/DocFragment[3]/body', 0.3);
    expect(plan({ crosspoint: remote })).toEqual({
      kind: 'STAGE_CROSSPOINT',
      remote,
      state: {
        ...causalState(),
        pendingCrosspoint: {
          revision: C3,
          xpointer: remote.xpointer,
          percentage: remote.percentage,
          observedReadest: R2,
        },
      },
    });
  });

  test('detects c2/r2 -> published r3 while CrossPoint independently moves to c3', () => {
    const result = plan({
      local: R3,
      readest: buildReadestProgressSidecar(DOCUMENT, R3, C2),
      crosspoint: crosspoint(C3, '/body/DocFragment[8]/body', 0.8),
      state: causalState(C2, R2),
    });

    expectConflict(result, 'BOTH_CHANGED');
  });

  test('advances an acknowledged baseline before publishing a newer local move', () => {
    const acknowledged = crosspoint(C3, R3.xpointer, 0.31, R3.revision);
    expect(
      plan({
        local: R4,
        readest: buildReadestProgressSidecar(DOCUMENT, R3, C2),
        crosspoint: acknowledged,
      }),
    ).toMatchObject({
      kind: 'WRITE_READEST',
      reason: 'ACK_WITH_NEWER_LOCAL',
      sidecar: { revision: R4.revision, basedOnCrosspoint: C3 },
      state: { baseline: { crosspointRevision: C3, readest: R3 } },
    });
  });

  test('records a stable acknowledgement and repairs only its baseline link', () => {
    const acknowledged = crosspoint(C3, R3.xpointer, 0.31, R3.revision);
    expect(
      plan({
        local: R3,
        readest: buildReadestProgressSidecar(DOCUMENT, R3, C2),
        crosspoint: acknowledged,
      }),
    ).toMatchObject({
      kind: 'WRITE_READEST',
      reason: 'WIRE_REPAIR',
      sidecar: { revision: R3.revision, basedOnCrosspoint: C3 },
      state: { baseline: { crosspointRevision: C3, readest: R3 } },
    });
  });

  test('repairs the older Readest wire after a staged CrossPoint update is applied live', () => {
    const appliedState = { ...causalState(C3, R3), staleReadest: R2 };
    const result = plan({
      local: R3,
      readest: buildReadestProgressSidecar(DOCUMENT, R2, C2),
      crosspoint: crosspoint(C3, R3.xpointer, 0.3),
      state: appliedState,
    });
    expect(result).toMatchObject({
      kind: 'WRITE_READEST',
      reason: 'WIRE_REPAIR',
      sidecar: { revision: R3.revision, basedOnCrosspoint: C3 },
      state: {
        baseline: { crosspointRevision: C3, readest: R3 },
        pendingCrosspoint: null,
      },
    });
    if (result.kind !== 'WRITE_READEST') throw new Error('expected a repair');
    expect(result.state.staleReadest).toBeUndefined();
  });

  test('does not repair a different Readest wire after a staged CrossPoint update', () => {
    expectConflict(
      plan({
        local: R3,
        readest: buildReadestProgressSidecar(DOCUMENT, R4, C2),
        crosspoint: crosspoint(C3, R3.xpointer, 0.3),
        state: { ...causalState(C3, R3), staleReadest: R2 },
      }),
      'READEST_WIRE_DIVERGED',
    );
  });

  test('rejects an unacknowledged Readest wire revision from another causal history', () => {
    expectConflict(
      plan({
        local: R2,
        readest: buildReadestProgressSidecar(DOCUMENT, R3, C2),
      }),
      'READEST_WIRE_DIVERGED',
    );
  });

  test('does not treat a missing persisted CrossPoint sidecar as remote deletion', () => {
    expectConflict(plan({ crosspoint: null }), 'CROSSPOINT_STATE_MISSING');
  });

  test('turns a staged inbound move into a conflict if Readest moves before book open', () => {
    const pending = {
      ...causalState(),
      pendingCrosspoint: {
        revision: C3,
        xpointer: '/body/DocFragment[3]/body',
        percentage: 0.3,
        observedReadest: R2,
      },
    };
    expectConflict(
      plan({
        local: R3,
        readest: buildReadestProgressSidecar(DOCUMENT, R2, C2),
        crosspoint: crosspoint(C3, pending.pendingCrosspoint.xpointer, 0.3),
        state: pending,
      }),
      'STALE_PENDING',
    );
  });

  test('keeps an unchanged staged inbound move pending without restaging it', () => {
    const pending = {
      ...causalState(),
      pendingCrosspoint: {
        revision: C3,
        xpointer: '/body/DocFragment[3]/body',
        percentage: 0.3,
        observedReadest: R2,
      },
    };
    expect(
      plan({
        local: R2,
        readest: buildReadestProgressSidecar(DOCUMENT, R2, C2),
        crosspoint: crosspoint(C3, pending.pendingCrosspoint.xpointer, 0.3),
        state: pending,
      }),
    ).toEqual({ kind: 'NO_CHANGE', state: pending });
  });
});
