import {
  buildReadestProgressSidecar,
  samePortableReadestPosition,
  type CrossPointProgressSidecar,
  type PortableReadestPosition,
  type ReadestProgressSidecar,
} from './progressProtocol';
import type { CrossPointLocalProgressState } from './progressState';

export type CrossPointProgressConflictKind =
  | 'BOTH_CHANGED'
  | 'BASELINE_MISSING'
  | 'READEST_WIRE_DIVERGED'
  | 'STALE_PENDING'
  | 'CROSSPOINT_STATE_MISSING';

export interface CrossPointProgressConflict {
  kind: CrossPointProgressConflictKind;
  document: string;
  baseline: CrossPointLocalProgressState['baseline'] | null;
  local: PortableReadestPosition | null;
  readestWire: ReadestProgressSidecar | null;
  crosspointWire: CrossPointProgressSidecar | null;
}

export type CrossPointProgressPlan =
  | { kind: 'NO_CHANGE'; state: CrossPointLocalProgressState }
  | {
      kind: 'ACKNOWLEDGED';
      readestRevision: string;
      state: CrossPointLocalProgressState;
    }
  | {
      kind: 'WAITING_FOR_ACK';
      readestRevision: string;
      state: CrossPointLocalProgressState;
    }
  | {
      kind: 'WRITE_READEST';
      reason: 'LOCAL_CHANGED' | 'ACK_WITH_NEWER_LOCAL' | 'WIRE_REPAIR';
      sidecar: ReadestProgressSidecar;
      state: CrossPointLocalProgressState;
    }
  | {
      kind: 'STAGE_CROSSPOINT';
      remote: CrossPointProgressSidecar;
      state: CrossPointLocalProgressState;
    }
  | { kind: 'CONFLICT'; conflict: CrossPointProgressConflict; state: CrossPointLocalProgressState };

interface PlanCrossPointProgressExchangeInput {
  document: string;
  local: PortableReadestPosition | null;
  readest: ReadestProgressSidecar | null;
  crosspoint: CrossPointProgressSidecar | null;
  state: CrossPointLocalProgressState | null;
}

const initialState = (document: string): CrossPointLocalProgressState => ({
  schemaVersion: 1,
  document,
  baseline: { crosspointRevision: null, readest: null },
  pendingCrosspoint: null,
});

const fromReadestSidecar = (sidecar: ReadestProgressSidecar): PortableReadestPosition => ({
  revision: sidecar.revision,
  xpointer: sidecar.xpointer,
  percentage: sidecar.percentage,
});

/** Resolve one surfaced conflict only after the user explicitly chooses the device position. */
export const preferCrossPointProgress = (plan: CrossPointProgressPlan): CrossPointProgressPlan => {
  if (plan.kind !== 'CONFLICT' || !plan.conflict.crosspointWire) return plan;
  const remote = plan.conflict.crosspointWire;
  const { staleReadest: _staleReadest, ...state } = plan.state;
  return {
    kind: 'STAGE_CROSSPOINT',
    remote,
    state: {
      ...state,
      pendingCrosspoint: {
        revision: remote.revision,
        xpointer: remote.xpointer,
        percentage: remote.percentage,
        observedReadest: plan.conflict.local,
      },
      ...(plan.conflict.readestWire
        ? { staleReadest: fromReadestSidecar(plan.conflict.readestWire) }
        : {}),
    },
  };
};

const withoutStaleReadest = ({
  staleReadest: _staleReadest,
  ...state
}: CrossPointLocalProgressState): CrossPointLocalProgressState => state;

const conflict = (
  kind: CrossPointProgressConflictKind,
  input: PlanCrossPointProgressExchangeInput,
  state: CrossPointLocalProgressState,
): CrossPointProgressPlan => ({
  kind: 'CONFLICT',
  conflict: {
    kind,
    document: input.document,
    baseline: input.state?.baseline ?? null,
    local: input.local,
    readestWire: input.readest,
    crosspointWire: input.crosspoint,
  },
  state,
});

export const planCrossPointProgressExchange = (
  input: PlanCrossPointProgressExchangeInput,
): CrossPointProgressPlan => {
  const state = input.state ?? initialState(input.document);

  // Firmware acknowledgement is causal proof. Consume it before comparing
  // either side against the previous checkpoint.
  if (input.readest && input.crosspoint?.appliedReadest === input.readest.revision) {
    const acknowledgedPosition = fromReadestSidecar(input.readest);
    const acknowledgedState: CrossPointLocalProgressState = {
      ...withoutStaleReadest(state),
      baseline: {
        crosspointRevision: input.crosspoint.revision,
        readest: acknowledgedPosition,
      },
      pendingCrosspoint: null,
    };
    if (input.local && !samePortableReadestPosition(input.local, acknowledgedPosition)) {
      return {
        kind: 'WRITE_READEST',
        reason: 'ACK_WITH_NEWER_LOCAL',
        sidecar: buildReadestProgressSidecar(
          input.document,
          input.local,
          input.crosspoint.revision,
        ),
        state: acknowledgedState,
      };
    }
    if (
      input.local &&
      samePortableReadestPosition(input.local, acknowledgedPosition) &&
      input.readest.basedOnCrosspoint !== input.crosspoint.revision
    ) {
      return {
        kind: 'WRITE_READEST',
        reason: 'WIRE_REPAIR',
        sidecar: buildReadestProgressSidecar(
          input.document,
          input.local,
          input.crosspoint.revision,
        ),
        state: acknowledgedState,
      };
    }
    return {
      kind: 'ACKNOWLEDGED',
      readestRevision: input.readest.revision,
      state: acknowledgedState,
    };
  }

  if (!input.state && input.local && input.crosspoint) {
    return conflict('BASELINE_MISSING', input, state);
  }
  if (state.baseline.crosspointRevision && !input.crosspoint) {
    return conflict('CROSSPOINT_STATE_MISSING', input, state);
  }
  if (
    state.pendingCrosspoint &&
    input.crosspoint?.revision === state.pendingCrosspoint.revision &&
    !samePortableReadestPosition(input.local, state.pendingCrosspoint.observedReadest)
  ) {
    return conflict('STALE_PENDING', input, state);
  }
  if (
    state.pendingCrosspoint &&
    input.crosspoint?.revision === state.pendingCrosspoint.revision &&
    samePortableReadestPosition(input.local, state.pendingCrosspoint.observedReadest)
  ) {
    return { kind: 'NO_CHANGE', state };
  }

  // A staged CrossPoint update is applied later by the live reader. It saves
  // the exact prior Readest position that may still be on the wire, so a
  // background scan repairs only that known stale record—not an unknown
  // competing publication.
  const canRepairStaleReadestWire =
    !!input.readest &&
    !!input.local &&
    !!state.baseline.readest &&
    !!state.staleReadest &&
    input.crosspoint?.revision === state.baseline.crosspointRevision &&
    samePortableReadestPosition(input.local, state.baseline.readest) &&
    samePortableReadestPosition(fromReadestSidecar(input.readest), state.staleReadest);

  // A non-acknowledged Readest wire may be the current local publication or
  // the previous checkpoint. Any third revision belongs to an unknown causal
  // history and must not be overwritten automatically.
  if (
    input.readest &&
    !samePortableReadestPosition(input.local, fromReadestSidecar(input.readest)) &&
    !samePortableReadestPosition(state.baseline.readest, fromReadestSidecar(input.readest)) &&
    !canRepairStaleReadestWire
  ) {
    return conflict('READEST_WIRE_DIVERGED', input, state);
  }

  const localChanged = state.baseline.readest
    ? !samePortableReadestPosition(input.local, state.baseline.readest)
    : input.local !== null;
  const crosspointChanged = state.baseline.crosspointRevision
    ? input.crosspoint?.revision !== state.baseline.crosspointRevision
    : input.crosspoint !== null;

  if (localChanged && crosspointChanged) return conflict('BOTH_CHANGED', input, state);

  if (localChanged && input.local) {
    const basedOn = input.crosspoint?.revision ?? state.baseline.crosspointRevision;
    if (
      input.readest &&
      samePortableReadestPosition(input.local, fromReadestSidecar(input.readest)) &&
      input.readest.basedOnCrosspoint === basedOn
    ) {
      return {
        kind: 'WAITING_FOR_ACK',
        readestRevision: input.readest.revision,
        state: withoutStaleReadest(state),
      };
    }
    return {
      kind: 'WRITE_READEST',
      reason: 'LOCAL_CHANGED',
      sidecar: buildReadestProgressSidecar(input.document, input.local, basedOn),
      state: withoutStaleReadest(state),
    };
  }

  if (crosspointChanged && input.crosspoint) {
    return {
      kind: 'STAGE_CROSSPOINT',
      remote: input.crosspoint,
      state: {
        ...state,
        pendingCrosspoint: {
          revision: input.crosspoint.revision,
          xpointer: input.crosspoint.xpointer,
          percentage: input.crosspoint.percentage,
          observedReadest: input.local,
        },
      },
    };
  }

  if (input.local) {
    const basedOn = input.crosspoint?.revision ?? state.baseline.crosspointRevision;
    if (
      !input.readest ||
      !samePortableReadestPosition(input.local, fromReadestSidecar(input.readest)) ||
      input.readest.basedOnCrosspoint !== basedOn
    ) {
      return {
        kind: 'WRITE_READEST',
        reason: 'WIRE_REPAIR',
        sidecar: buildReadestProgressSidecar(input.document, input.local, basedOn),
        state: withoutStaleReadest(state),
      };
    }
  }

  return {
    kind: 'NO_CHANGE',
    state:
      state.pendingCrosspoint && input.crosspoint?.revision === state.baseline.crosspointRevision
        ? { ...state, pendingCrosspoint: null }
        : state.staleReadest &&
            input.readest &&
            samePortableReadestPosition(state.baseline.readest, fromReadestSidecar(input.readest))
          ? withoutStaleReadest(state)
          : state,
  };
};
