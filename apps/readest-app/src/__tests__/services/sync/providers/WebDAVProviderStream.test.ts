import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@/utils/transfer', () => ({
  tauriUpload: vi.fn(async () => ''),
  tauriDownload: vi.fn(async () => ({})),
}));

import { createWebDAVProvider } from '@/services/sync/providers/webdav/WebDAVProvider';
import { tauriUpload } from '@/utils/transfer';

const settings = {
  enabled: false,
  serverUrl: 'http://192.168.0.154',
  username: '',
  password: '',
  rootPath: '/',
};

describe('WebDAVProvider — native streaming upload timeout', () => {
  beforeEach(() => {
    vi.mocked(tauriUpload).mockClear();
  });

  test('forwards an opt-in request deadline to the native uploader', async () => {
    const provider = createWebDAVProvider(settings);

    await expect(provider.uploadStream!('/Book.epub', '/local/Book.epub', 120_000)).resolves.toBe(
      true,
    );

    expect(tauriUpload).toHaveBeenCalledWith(
      'http://192.168.0.154/Book.epub',
      '/local/Book.epub',
      'PUT',
      undefined,
      { Authorization: 'Basic Og==' },
      120_000,
    );
  });

  test('does not add a deadline for existing WebDAV uploads', async () => {
    const provider = createWebDAVProvider(settings);

    await expect(provider.uploadStream!('/Book.epub', '/local/Book.epub')).resolves.toBe(true);

    expect(tauriUpload).toHaveBeenCalledWith(
      'http://192.168.0.154/Book.epub',
      '/local/Book.epub',
      'PUT',
      undefined,
      { Authorization: 'Basic Og==' },
      undefined,
    );
  });
});
