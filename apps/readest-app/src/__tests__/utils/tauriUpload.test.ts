import { beforeEach, describe, expect, test, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage?: unknown;
  },
}));

import { tauriUpload } from '@/utils/transfer';

describe('tauriUpload', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue('');
  });

  test('serializes an opt-in native request deadline as timeoutMs', async () => {
    await tauriUpload(
      'http://192.168.0.154/Book.epub',
      '/local/Book.epub',
      'PUT',
      undefined,
      undefined,
      120_000,
    );

    expect(invokeMock).toHaveBeenCalledWith(
      'upload_file',
      expect.objectContaining({
        url: 'http://192.168.0.154/Book.epub',
        filePath: '/local/Book.epub',
        method: 'PUT',
        timeoutMs: 120_000,
      }),
    );
  });

  test('keeps existing native uploads unbounded when no deadline is requested', async () => {
    await tauriUpload('https://dav.example.com/Book.epub', '/local/Book.epub', 'PUT');

    const args = invokeMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('timeoutMs');
  });
});
