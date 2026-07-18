import { md5 } from 'js-md5';

export const CROSSPOINT_PROGRESS_DIR = '/.crosspoint/readest-sync';
export const MAX_PROGRESS_XPOINTER_BYTES = 1024;
export const MAX_PROGRESS_SIDECAR_BYTES = 2048;

const LOWER_HEX_32 = /^[0-9a-f]{32}$/;
const CROSSPOINT_REVISION_DOMAIN = 'crosspoint-progress-v2';
const encoder = new TextEncoder();

export interface PortableReadestPosition {
  revision: string;
  xpointer: string;
  percentage: number;
}

export interface ReadestProgressSidecar extends PortableReadestPosition {
  schemaVersion: 2;
  document: string;
  basedOnCrosspoint: string | null;
}

export interface CrossPointProgressSidecar {
  schemaVersion: 2;
  document: string;
  revision: string;
  xpointer: string;
  percentage: number;
  appliedReadest: string | null;
  spineIndex: number;
  pageNumber: number;
  pageCount: number;
}

interface PortablePositionInput {
  document: string;
  xpointer: string;
  percentage: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isCrossPointDocumentId = (value: unknown): value is string =>
  typeof value === 'string' && LOWER_HEX_32.test(value);

const isRevision = isCrossPointDocumentId;

const isPercentage = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const isXPointer = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  encoder.encode(value).byteLength <= MAX_PROGRESS_XPOINTER_BYTES;

const normalizeLink = (value: unknown): string | null | undefined => {
  if (value === null || value === '') return null;
  return isRevision(value) ? value : undefined;
};

const assertDocument = (document: string): void => {
  if (!isCrossPointDocumentId(document)) throw new Error('invalid CrossPoint document id');
};

export const buildReadestProgressPath = (document: string): string => {
  assertDocument(document);
  return `${CROSSPOINT_PROGRESS_DIR}/${document}.readest.json`;
};

export const buildCrossPointProgressPath = (document: string): string => {
  assertDocument(document);
  return `${CROSSPOINT_PROGRESS_DIR}/${document}.crosspoint.json`;
};

export const computeReadestProgressRevision = ({
  document,
  xpointer,
  percentage,
}: PortablePositionInput): string =>
  md5(JSON.stringify([document, xpointer, Math.fround(percentage)]));

const computeLegacyReadestProgressRevision = ({
  document,
  xpointer,
  percentage,
}: PortablePositionInput): string => md5(JSON.stringify([document, xpointer, percentage]));

export const computeCrossPointProgressRevision = ({
  document,
  xpointer,
  percentage,
}: PortablePositionInput): string => {
  const prefix = encoder.encode(`${CROSSPOINT_REVISION_DOMAIN}\0${document}\0${xpointer}\0`);
  const bytes = new Uint8Array(prefix.byteLength + 4);
  bytes.set(prefix);
  new DataView(bytes.buffer).setFloat32(prefix.byteLength, Math.fround(percentage), false);
  return md5(bytes);
};

export const buildPortableReadestPosition = (
  input: PortablePositionInput,
): PortableReadestPosition => {
  if (
    !isCrossPointDocumentId(input.document) ||
    !isXPointer(input.xpointer) ||
    !isPercentage(input.percentage)
  ) {
    throw new Error('invalid Readest progress position');
  }
  return {
    revision: computeReadestProgressRevision(input),
    xpointer: input.xpointer,
    // Firmware stores and hashes IEEE-754 Float32 percentage bits. Keep the
    // JSON value and Readest revision on that same canonical value.
    percentage: Math.fround(input.percentage),
  };
};

export const buildReadestProgressSidecar = (
  document: string,
  position: PortableReadestPosition,
  basedOnCrosspoint: string | null,
): ReadestProgressSidecar => {
  const expected = buildPortableReadestPosition({ document, ...position });
  if (
    expected.revision !== position.revision ||
    expected.percentage !== position.percentage ||
    normalizeLink(basedOnCrosspoint) === undefined
  ) {
    throw new Error('invalid Readest progress position');
  }
  return {
    schemaVersion: 2,
    document,
    revision: position.revision,
    xpointer: position.xpointer,
    percentage: position.percentage,
    basedOnCrosspoint,
  };
};

const parseBody = (raw: string, writer: 'Readest' | 'CrossPoint'): Record<string, unknown> => {
  if (encoder.encode(raw).byteLength > MAX_PROGRESS_SIDECAR_BYTES) {
    throw new Error(`${writer} progress sidecar exceeds ${MAX_PROGRESS_SIDECAR_BYTES} UTF-8 bytes`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Normalized below.
  }
  throw new Error(`invalid ${writer} progress sidecar`);
};

const validPortableFields = (
  value: Record<string, unknown>,
  expectedDocument: string,
): value is Record<'document' | 'revision' | 'xpointer' | 'percentage', string | number> =>
  value['schemaVersion'] === 2 &&
  value['document'] === expectedDocument &&
  isRevision(value['revision']) &&
  isXPointer(value['xpointer']) &&
  isPercentage(value['percentage']);

export const parseReadestProgressSidecar = (
  raw: string | null,
  expectedDocument: string,
): ReadestProgressSidecar | null => {
  assertDocument(expectedDocument);
  if (raw === null) return null;
  const parsed = parseBody(raw, 'Readest');
  const basedOnCrosspoint = normalizeLink(parsed['basedOnCrosspoint']);
  if (!validPortableFields(parsed, expectedDocument) || basedOnCrosspoint === undefined) {
    throw new Error('invalid Readest progress sidecar');
  }
  const expectedRevision = computeReadestProgressRevision({
    document: expectedDocument,
    xpointer: parsed['xpointer'] as string,
    percentage: parsed['percentage'] as number,
  });
  const percentage = parsed['percentage'] as number;
  const isCanonical =
    parsed['revision'] === expectedRevision && percentage === Math.fround(percentage);
  // Early protocol-v2 builds hashed and serialized the full JS percentage.
  // Accept only records whose legacy checksum is intact; the next successful
  // publication rewrites them in the canonical Float32 form.
  const isValidLegacy =
    parsed['revision'] ===
    computeLegacyReadestProgressRevision({
      document: expectedDocument,
      xpointer: parsed['xpointer'] as string,
      percentage,
    });
  if (!isCanonical && !isValidLegacy) {
    throw new Error('invalid Readest progress sidecar');
  }
  return {
    schemaVersion: 2,
    document: expectedDocument,
    revision: parsed['revision'] as string,
    xpointer: parsed['xpointer'] as string,
    percentage,
    basedOnCrosspoint,
  };
};

export const parseCrossPointProgressSidecar = (
  raw: string | null,
  expectedDocument: string,
): CrossPointProgressSidecar | null => {
  assertDocument(expectedDocument);
  if (raw === null) return null;
  const parsed = parseBody(raw, 'CrossPoint');
  const appliedReadest = normalizeLink(parsed['appliedReadest']);
  const spineIndex = parsed['spineIndex'];
  const pageNumber = parsed['pageNumber'];
  const pageCount = parsed['pageCount'];
  if (
    !validPortableFields(parsed, expectedDocument) ||
    appliedReadest === undefined ||
    !Number.isSafeInteger(spineIndex) ||
    (spineIndex as number) < 0 ||
    !Number.isSafeInteger(pageNumber) ||
    (pageNumber as number) < 0 ||
    !Number.isSafeInteger(pageCount) ||
    (pageCount as number) <= 0 ||
    (pageNumber as number) >= (pageCount as number)
  ) {
    throw new Error('invalid CrossPoint progress sidecar');
  }
  const percentage = Math.fround(parsed['percentage'] as number);
  const expectedRevision = computeCrossPointProgressRevision({
    document: expectedDocument,
    xpointer: parsed['xpointer'] as string,
    percentage,
  });
  if (parsed['revision'] !== expectedRevision) {
    throw new Error('invalid CrossPoint progress sidecar');
  }
  return {
    schemaVersion: 2,
    document: expectedDocument,
    revision: parsed['revision'] as string,
    xpointer: parsed['xpointer'] as string,
    percentage,
    appliedReadest,
    spineIndex: spineIndex as number,
    pageNumber: pageNumber as number,
    pageCount: pageCount as number,
  };
};

export const serializeReadestProgressSidecar = (sidecar: ReadestProgressSidecar): string => {
  const normalized = buildReadestProgressSidecar(
    sidecar.document,
    {
      revision: sidecar.revision,
      xpointer: sidecar.xpointer,
      percentage: sidecar.percentage,
    },
    sidecar.basedOnCrosspoint,
  );
  const serialized = JSON.stringify(normalized);
  if (encoder.encode(serialized).byteLength > MAX_PROGRESS_SIDECAR_BYTES) {
    throw new Error(`Readest progress sidecar exceeds ${MAX_PROGRESS_SIDECAR_BYTES} UTF-8 bytes`);
  }
  return serialized;
};

export const samePortableReadestPosition = (
  left: PortableReadestPosition | null,
  right: PortableReadestPosition | null,
): boolean =>
  left === right ||
  (!!left &&
    !!right &&
    left.revision === right.revision &&
    left.xpointer === right.xpointer &&
    left.percentage === right.percentage);
