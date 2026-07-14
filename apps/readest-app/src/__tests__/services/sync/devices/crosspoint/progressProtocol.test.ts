import { describe, expect, test } from 'vitest';

import {
  CROSSPOINT_PROGRESS_DIR,
  MAX_PROGRESS_SIDECAR_BYTES,
  MAX_PROGRESS_XPOINTER_BYTES,
  buildCrossPointProgressPath,
  buildPortableReadestPosition,
  buildReadestProgressPath,
  buildReadestProgressSidecar,
  computeCrossPointProgressRevision,
  computeReadestProgressRevision,
  parseCrossPointProgressSidecar,
  parseReadestProgressSidecar,
  serializeReadestProgressSidecar,
} from '@/services/sync/devices/crosspoint/progressProtocol';

const DOCUMENT = '0123456789abcdef0123456789abcdef';
const CROSSPOINT_REVISION = '11111111111111111111111111111111';
const READEST_REVISION = '22222222222222222222222222222222';
const XPOINTER = '/body/DocFragment[2]/body/p[1]';

const crossPointSidecar = (overrides: Record<string, unknown> = {}) => {
  const sidecar = {
    schemaVersion: 2,
    document: DOCUMENT,
    xpointer: XPOINTER,
    percentage: 0.25,
    appliedReadest: null,
    spineIndex: 1,
    pageNumber: 2,
    pageCount: 10,
    ...overrides,
  };
  const revision = Object.hasOwn(overrides, 'revision')
    ? overrides['revision']
    : computeCrossPointProgressRevision({
        document: sidecar.document as string,
        xpointer: sidecar.xpointer as string,
        percentage: sidecar.percentage as number,
      });
  return { ...sidecar, revision };
};

describe('CrossPoint progress protocol v2', () => {
  test('builds only flat lower-hex document paths in the firmware-owned directory', () => {
    expect(CROSSPOINT_PROGRESS_DIR).toBe('/.crosspoint/readest-sync');
    expect(buildReadestProgressPath(DOCUMENT)).toBe(
      `${CROSSPOINT_PROGRESS_DIR}/${DOCUMENT}.readest.json`,
    );
    expect(buildCrossPointProgressPath(DOCUMENT)).toBe(
      `${CROSSPOINT_PROGRESS_DIR}/${DOCUMENT}.crosspoint.json`,
    );

    for (const invalid of ['', '../book', DOCUMENT.toUpperCase(), `${DOCUMENT}0`]) {
      expect(() => buildReadestProgressPath(invalid)).toThrow('invalid CrossPoint document id');
      expect(() => buildCrossPointProgressPath(invalid)).toThrow('invalid CrossPoint document id');
    }
  });

  test('computes a deterministic Readest revision from only the portable position', () => {
    const position = { document: DOCUMENT, xpointer: XPOINTER, percentage: 0.25 };
    expect(computeReadestProgressRevision(position)).toBe(
      computeReadestProgressRevision({ ...position }),
    );
    expect(computeReadestProgressRevision(position)).toMatch(/^[0-9a-f]{32}$/);
    expect(computeReadestProgressRevision({ ...position, percentage: 0.26 })).not.toBe(
      computeReadestProgressRevision(position),
    );

    const portable = buildPortableReadestPosition(position);
    expect(buildReadestProgressSidecar(DOCUMENT, portable, null).revision).toBe(
      buildReadestProgressSidecar(DOCUMENT, portable, CROSSPOINT_REVISION).revision,
    );
  });

  test('canonicalizes percentage to firmware Float32 before revision and JSON', () => {
    const percentage = 0.12345679;
    const portable = buildPortableReadestPosition({
      document: DOCUMENT,
      xpointer: XPOINTER,
      percentage,
    });
    expect(portable.percentage).toBe(Math.fround(percentage));
    expect(portable.revision).toBe(
      computeReadestProgressRevision({
        document: DOCUMENT,
        xpointer: XPOINTER,
        percentage: Math.fround(percentage),
      }),
    );
    expect(
      JSON.parse(
        serializeReadestProgressSidecar(
          buildReadestProgressSidecar(DOCUMENT, portable, CROSSPOINT_REVISION),
        ),
      ).percentage,
    ).toBe(Math.fround(percentage));
  });

  test('verifies firmware revisions from Float32 big-endian bytes', () => {
    const xpointer = '/body/DocFragment[2]/body/p[3]/text().4';
    expect(
      computeCrossPointProgressRevision({
        document: DOCUMENT,
        xpointer,
        percentage: 0.25,
      }),
    ).toBe('b3c9f417197abd2c175e33cac4e6d24b');

    const rawFirmwarePercentage = 0.123456791;
    const revision = computeCrossPointProgressRevision({
      document: DOCUMENT,
      xpointer,
      percentage: rawFirmwarePercentage,
    });
    expect(revision).toBe('cdcb92b71d22d3cbe18e590f38003593');

    expect(
      parseCrossPointProgressSidecar(
        JSON.stringify({
          ...crossPointSidecar(),
          revision,
          xpointer,
          percentage: rawFirmwarePercentage,
        }),
        DOCUMENT,
      )?.percentage,
    ).toBe(Math.fround(rawFirmwarePercentage));
  });

  test('strictly parses both writer-owned sidecars and preserves exact XPointer bytes', () => {
    const portable = buildPortableReadestPosition({
      document: DOCUMENT,
      xpointer: XPOINTER,
      percentage: 0.25,
    });
    const readest = buildReadestProgressSidecar(DOCUMENT, portable, CROSSPOINT_REVISION);

    expect(parseReadestProgressSidecar(JSON.stringify(readest), DOCUMENT)).toEqual(readest);
    expect(parseCrossPointProgressSidecar(JSON.stringify(crossPointSidecar()), DOCUMENT)).toEqual(
      crossPointSidecar(),
    );
  });

  test('accepts a legacy empty acknowledgement link but serializes canonical null', () => {
    expect(
      parseCrossPointProgressSidecar(
        JSON.stringify(crossPointSidecar({ appliedReadest: '' })),
        DOCUMENT,
      )!.appliedReadest,
    ).toBeNull();

    const portable = buildPortableReadestPosition({
      document: DOCUMENT,
      xpointer: XPOINTER,
      percentage: 0.25,
    });
    const serialized = serializeReadestProgressSidecar(
      buildReadestProgressSidecar(DOCUMENT, portable, null),
    );
    expect(JSON.parse(serialized).basedOnCrosspoint).toBeNull();
  });

  test('returns null only for a missing sidecar and rejects malformed records', () => {
    expect(parseReadestProgressSidecar(null, DOCUMENT)).toBeNull();
    expect(parseCrossPointProgressSidecar(null, DOCUMENT)).toBeNull();

    const portable = buildPortableReadestPosition({
      document: DOCUMENT,
      xpointer: XPOINTER,
      percentage: 0.25,
    });
    const readest = buildReadestProgressSidecar(DOCUMENT, portable, null);
    const malformed = [
      '{',
      JSON.stringify({ ...readest, schemaVersion: 1 }),
      JSON.stringify({ ...readest, document: READEST_REVISION }),
      JSON.stringify({ ...readest, percentage: 1.1 }),
      JSON.stringify({ ...readest, xpointer: '' }),
      JSON.stringify({ ...readest, revision: READEST_REVISION }),
      JSON.stringify({ ...readest, basedOnCrosspoint: 'INVALID' }),
    ];
    for (const raw of malformed) {
      expect(() => parseReadestProgressSidecar(raw, DOCUMENT)).toThrow(
        'invalid Readest progress sidecar',
      );
    }

    const malformedCrossPoint = [
      JSON.stringify(crossPointSidecar({ document: READEST_REVISION })),
      JSON.stringify(crossPointSidecar({ revision: 'A'.repeat(32) })),
      JSON.stringify(crossPointSidecar({ appliedReadest: 'INVALID' })),
      JSON.stringify(crossPointSidecar({ spineIndex: -1 })),
      JSON.stringify(crossPointSidecar({ pageNumber: 10 })),
      JSON.stringify(crossPointSidecar({ pageCount: 0 })),
    ];
    for (const raw of malformedCrossPoint) {
      expect(() => parseCrossPointProgressSidecar(raw, DOCUMENT)).toThrow(
        'invalid CrossPoint progress sidecar',
      );
    }
  });

  test('enforces the UTF-8 XPointer and complete body limits while parsing and serializing', () => {
    const atLimit = buildPortableReadestPosition({
      document: DOCUMENT,
      xpointer: 'x'.repeat(MAX_PROGRESS_XPOINTER_BYTES),
      percentage: 0.5,
    });
    expect(() =>
      serializeReadestProgressSidecar(buildReadestProgressSidecar(DOCUMENT, atLimit, null)),
    ).not.toThrow();

    expect(() =>
      buildPortableReadestPosition({
        document: DOCUMENT,
        xpointer: 'é'.repeat(MAX_PROGRESS_XPOINTER_BYTES / 2 + 1),
        percentage: 0.5,
      }),
    ).toThrow('invalid Readest progress position');

    const oversized = JSON.stringify({
      ...crossPointSidecar(),
      ignored: 'x'.repeat(MAX_PROGRESS_SIDECAR_BYTES),
    });
    expect(() => parseCrossPointProgressSidecar(oversized, DOCUMENT)).toThrow(
      'CrossPoint progress sidecar exceeds 2048 UTF-8 bytes',
    );
  });
});
