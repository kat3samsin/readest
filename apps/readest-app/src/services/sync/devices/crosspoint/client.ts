import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import type { CrossPointDevice, CrossPointSettings } from '@/types/settings';

export interface CrossPointReadestSyncCapabilities {
  protocol: 1 | 2;
  books: true;
  progress: boolean;
  highlights: boolean;
}

export interface CrossPointStatus {
  version: string;
  ip: string;
  mode: 'STA' | 'AP';
  rssi: number;
  freeHeap: number;
  uptime: number;
  device: CrossPointDevice;
  serial?: string;
  readestSync?: CrossPointReadestSyncCapabilities;
}

export type CrossPointProbeResult =
  | {
      compatible: true;
      status: CrossPointStatus & { readestSync: CrossPointReadestSyncCapabilities };
    }
  | {
      compatible: false;
      code: 'READEST_SYNC_UNSUPPORTED';
      status: CrossPointStatus;
    };

const STATUS_TIMEOUT_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseReadestSyncCapabilities = (value: unknown): CrossPointReadestSyncCapabilities | null => {
  if (!isRecord(value)) return null;
  if ((value['protocol'] !== 1 && value['protocol'] !== 2) || value['books'] !== true) return null;
  if (typeof value['progress'] !== 'boolean' || typeof value['highlights'] !== 'boolean') {
    return null;
  }
  return {
    protocol: value['protocol'],
    books: true,
    progress: value['progress'],
    highlights: value['highlights'],
  };
};

export const supportsCrossPointProgress = (
  status: CrossPointStatus,
): status is CrossPointStatus & {
  readestSync: CrossPointReadestSyncCapabilities & { protocol: 2; progress: true };
} => status.readestSync?.protocol === 2 && status.readestSync.progress;

/** Validate the complete firmware status shape before trusting the device label. */
export const parseCrossPointStatus = (value: unknown): CrossPointStatus | null => {
  if (!isRecord(value)) return null;

  const version = value['version'];
  const ip = value['ip'];
  const mode = value['mode'];
  const rssi = value['rssi'];
  const freeHeap = value['freeHeap'];
  const uptime = value['uptime'];
  const device = value['device'];
  const serial = value['serial'];
  const readestSync = parseReadestSyncCapabilities(value['readestSync']);

  if (typeof version !== 'string' || !version.trim()) return null;
  if (typeof ip !== 'string' || !ip.trim()) return null;
  if (mode !== 'STA' && mode !== 'AP') return null;
  if (!isFiniteNumber(rssi) || !isFiniteNumber(freeHeap) || !isFiniteNumber(uptime)) return null;
  if (device !== 'X3' && device !== 'X4') return null;
  if (serial !== undefined && typeof serial !== 'string') return null;
  const normalizedSerial =
    typeof serial === 'string' && serial.trim().toLowerCase() !== 'not found'
      ? serial.trim()
      : undefined;

  return {
    version,
    ip,
    mode,
    rssi,
    freeHeap,
    uptime,
    device,
    ...(normalizedSerial ? { serial: normalizedSerial } : {}),
    ...(readestSync ? { readestSync } : {}),
  };
};

/**
 * Convert user input into the reader's origin. A bare LAN host/IP is HTTP;
 * any entered path is discarded because the firmware API lives at the root.
 */
export const normalizeCrossPointServerUrl = (serverUrl: string): string | null => {
  const input = serverUrl.trim();
  if (!input) return null;

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
};

export const buildCrossPointStatusUrl = (serverUrl: string): string | null => {
  const origin = normalizeCrossPointServerUrl(serverUrl);
  return origin ? `${origin}/api/status` : null;
};

const getFetch = () => (isTauriAppPlatform() ? tauriFetch : globalThis.fetch.bind(globalThis));

/** Best-effort probe: unreachable and non-CrossPoint endpoints return null. */
export const probeCrossPointStatus = async (
  settings: CrossPointSettings,
): Promise<CrossPointProbeResult | null> => {
  const url = buildCrossPointStatusUrl(settings.serverUrl);
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const response = await getFetch()(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const status = parseCrossPointStatus(await response.json());
    if (!status) return null;
    if (!status.readestSync) {
      return { compatible: false, code: 'READEST_SYNC_UNSUPPORTED', status };
    }
    return {
      compatible: true,
      status: { ...status, readestSync: status.readestSync },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
