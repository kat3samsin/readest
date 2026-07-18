import type { EnvConfigType } from '@/services/environment';
import { useSettingsStore } from '@/store/settingsStore';
import type { CrossPointSettings } from '@/types/settings';
import {
  normalizeCrossPointServerUrl,
  probeCrossPointStatus,
  type CrossPointStatus,
} from './client';

export type CrossPointConnectResult =
  | { ok: true; status: CrossPointStatus; serverUrl: string }
  | {
      ok: false;
      code:
        | 'INVALID_ADDRESS'
        | 'DEVICE_UNREACHABLE'
        | 'INCOMPATIBLE_FIRMWARE'
        | 'SETTINGS_PERSIST_FAILED';
      status?: CrossPointStatus;
    };

export async function connectCrossPoint(
  envConfig: EnvConfigType,
  serverUrl: string,
): Promise<CrossPointConnectResult> {
  const normalized = normalizeCrossPointServerUrl(serverUrl);
  if (!normalized) return { ok: false, code: 'INVALID_ADDRESS' };

  const connection: CrossPointSettings = {
    serverUrl: normalized,
    username: '',
    password: '',
  };
  const result = await probeCrossPointStatus(connection);
  if (!result) return { ok: false, code: 'DEVICE_UNREACHABLE' };
  if (!result.compatible) {
    return { ok: false, code: 'INCOMPATIBLE_FIRMWARE', status: result.status };
  }

  const latest = useSettingsStore.getState().settings;
  const crosspoint: CrossPointSettings = {
    ...latest.crosspoint,
    ...connection,
    device: result.status.device,
  };
  if (result.status.serial === undefined) delete crosspoint.serial;
  else crosspoint.serial = result.status.serial;
  const next = { ...latest, crosspoint };

  try {
    await useSettingsStore.getState().saveSettings(envConfig, next);
  } catch {
    return { ok: false, code: 'SETTINGS_PERSIST_FAILED', status: result.status };
  }
  useSettingsStore.getState().setSettings(next);
  return { ok: true, status: result.status, serverUrl: normalized };
}
