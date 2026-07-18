import clsx from 'clsx';
import React, { useState } from 'react';
import { MdSync } from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useTranslation, type TranslationFunc } from '@/hooks/useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  supportsCrossPointProgress,
  type CrossPointStatus,
} from '@/services/sync/devices/crosspoint/client';
import { connectCrossPoint } from '@/services/sync/devices/crosspoint/connect';
import {
  runCrossPointBookSync,
  type CrossPointBookRunResult,
} from '@/services/sync/devices/crosspoint/runBookSync';
import type { CrossPointProgressConflict } from '@/services/sync/devices/crosspoint/progressPlanner';
import { persistCrossPointHydratedBookMarkers } from '@/services/sync/devices/crosspoint/libraryMarker';
import type { CrossPointBookSyncProgress } from '@/services/sync/devices/crosspoint/types';
import SubPageHeader from '../SubPageHeader';
import { BoxedList, SectionTitle, SettingsRow, Tips } from '../primitives';

interface CrossPointFormProps {
  onBack: () => void;
}

type Notice = { type: 'info' | 'warning' | 'error'; message: string };

const syncResultNotice = (_: TranslationFunc, result: CrossPointBookRunResult): Notice => {
  switch (result.code) {
    case 'SUCCESS':
      if (result.progress.supported && result.progress.sync.staged > 0) {
        return {
          type: 'info',
          message: _(
            '{{count}} book(s) synced. {{staged}} CrossPoint progress update(s) were received and will apply when the matching EPUB opens in desktop Readest.',
            {
              count: result.books.considered,
              staged: result.progress.sync.staged,
            },
          ),
        };
      }
      return {
        type: 'info',
        message: _('{{count}} book(s) synced to CrossPoint', {
          count: result.books.considered,
        }),
      };
    case 'DEVICE_UNREACHABLE':
      return {
        type: 'error',
        message: _(
          'CrossPoint could not be reached. Check its address and make sure both devices are on the same network.',
        ),
      };
    case 'DEVICE_CHANGED':
      return {
        type: 'error',
        message: _(
          'The connected reader does not match your saved CrossPoint. Use Test connection to reconnect it explicitly before syncing.',
        ),
      };
    case 'INCOMPATIBLE_FIRMWARE':
      return {
        type: 'error',
        message: _('This CrossPoint firmware does not support Readest book sync.'),
      };
    case 'HYDRATION_FAILED':
      return {
        type: 'error',
        message: _('A Readest Cloud book could not be downloaded before device sync.'),
      };
    case 'BOOK_SYNC_PARTIAL':
      return {
        type: 'warning',
        message: _(
          'Book sync finished with {{failed}} failure(s) and {{unavailable}} unavailable book(s).',
          {
            failed: result.books.failures.length,
            unavailable: result.books.unavailable,
          },
        ),
      };
    case 'PROGRESS_SYNC_PARTIAL':
      return {
        type: 'warning',
        message: _(
          'Book files synced, but reading progress finished with {{failed}} failure(s) and {{conflicts}} conflict(s).',
          {
            failed: result.progress.sync.failures.length,
            conflicts: result.progress.sync.conflicts.length,
          },
        ),
      };
    case 'BOOK_SYNC_FAILED':
      return { type: 'error', message: _('Book sync failed. Check the reader and try again.') };
    case 'SETTINGS_PERSIST_FAILED':
      return {
        type: 'warning',
        message: _('Books synced, but Readest could not save the device status.'),
      };
  }
};

const CrossPointForm: React.FC<CrossPointFormProps> = ({ onBack }) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { settings } = useSettingsStore();
  const [serverUrl, setServerUrl] = useState(settings.crosspoint.serverUrl);
  const [status, setStatus] = useState<CrossPointStatus | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<CrossPointBookSyncProgress | null>(null);
  const [progressConflicts, setProgressConflicts] = useState<CrossPointProgressConflict[]>([]);
  const isDesktop = !!appService?.isDesktopApp;

  const header = (
    <SubPageHeader
      parentLabel={_('Integrations')}
      currentLabel={_('CrossPoint')}
      description={_('Send your Readest EPUB library to a CrossPoint reader on your network.')}
      onBack={onBack}
    />
  );

  if (!isDesktop) {
    return (
      <div className='w-full'>
        {header}
        <Tips title={_('App required')}>
          <li>{_('CrossPoint device sync is available in the Readest desktop app.')}</li>
        </Tips>
      </div>
    );
  }

  const handleConnect = async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    setNotice(null);
    try {
      const result = await connectCrossPoint(envConfig, serverUrl);
      if (result.ok) {
        setStatus(result.status);
        setServerUrl(result.serverUrl);
        setNotice({
          type: 'info',
          message: _('Connected to CrossPoint {{device}}.', { device: result.status.device }),
        });
      } else if (result.code === 'INVALID_ADDRESS') {
        setNotice({ type: 'error', message: _('Enter a valid CrossPoint server address.') });
      } else if (result.code === 'DEVICE_UNREACHABLE') {
        setNotice({
          type: 'error',
          message: _(
            'CrossPoint could not be reached. Check its address and make sure both devices are on the same network.',
          ),
        });
      } else if (result.code === 'INCOMPATIBLE_FIRMWARE') {
        setStatus(result.status ?? null);
        setNotice({
          type: 'error',
          message: _('This CrossPoint firmware does not support Readest book sync.'),
        });
      } else {
        setNotice({ type: 'error', message: _('Readest could not save this connection.') });
      }
    } finally {
      setIsConnecting(false);
    }
  };

  const handleSync = async (preferCrossPointDocuments: readonly string[] = []) => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncProgress(null);
    setNotice(null);
    setProgressConflicts([]);
    try {
      let { library, libraryLoaded } = useLibraryStore.getState();
      if (!libraryLoaded) {
        const appService = await envConfig.getAppService();
        library = await appService.loadLibraryBooks();
        useLibraryStore.getState().setLibrary(library);
      }

      const result = await runCrossPointBookSync({
        envConfig,
        settings: useSettingsStore.getState().settings,
        books: library,
        onProgress: setSyncProgress,
        preferCrossPointDocuments,
        persistHydratedBookMarkers: (markers) =>
          persistCrossPointHydratedBookMarkers(envConfig, markers),
      });
      if ('status' in result) setStatus(result.status);
      if (result.code === 'PROGRESS_SYNC_PARTIAL') {
        setProgressConflicts(
          result.progress.sync.conflicts.filter((conflict) => conflict.crosspointWire),
        );
      }
      setNotice(syncResultNotice(_, result));
    } catch {
      setNotice({ type: 'error', message: _('Book sync failed. Check the reader and try again.') });
    } finally {
      setIsSyncing(false);
      setSyncProgress(null);
    }
  };

  const visibleStatus =
    status ??
    (settings.crosspoint.device
      ? {
          device: settings.crosspoint.device,
          serial: settings.crosspoint.serial,
        }
      : null);
  const capabilities = status?.readestSync;
  const progressSupported = status ? supportsCrossPointProgress(status) : false;
  const canSync = !!settings.crosspoint.serverUrl && !isConnecting && !isSyncing;
  const syncDescription = isSyncing
    ? syncProgress
      ? _('Syncing book {{current}} of {{total}}: {{title}}', {
          current: syncProgress.index + 1,
          total: syncProgress.total,
          title: syncProgress.book.title || syncProgress.book.hash.slice(0, 8),
        })
      : _('Preparing CrossPoint sync…')
    : _('Adds missing Readest EPUBs without changing Readest Cloud.');

  return (
    <div className='w-full'>
      {header}

      <div className='space-y-5'>
        <Tips title={_('Trusted local network only')}>
          <li>
            {_(
              "CrossPoint's current server has no authentication. Use this desktop setup only on a trusted local network.",
            )}
          </li>
        </Tips>

        <form
          className='space-y-4'
          onSubmit={(event) => {
            event.preventDefault();
            void handleConnect();
          }}
        >
          <div className='space-y-1.5'>
            <SectionTitle as='label' htmlFor='crosspoint-server-url' className='block'>
              {_('Server URL')}
            </SectionTitle>
            <input
              id='crosspoint-server-url'
              type='text'
              inputMode='url'
              placeholder='192.168.0.154'
              className='input input-bordered eink-bordered h-11 w-full text-sm focus:outline-none'
              spellCheck='false'
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
            />
          </div>

          <div className='flex justify-end'>
            <button
              type='submit'
              disabled={isConnecting || isSyncing}
              className='btn btn-primary h-10 min-h-10 px-4'
            >
              {isConnecting && <span className='loading loading-spinner loading-xs' />}
              {settings.crosspoint.device ? _('Test connection') : _('Connect')}
            </button>
          </div>
        </form>

        <BoxedList title={_('Device Sync')}>
          <SettingsRow
            label={
              visibleStatus
                ? _('CrossPoint {{device}}', { device: visibleStatus.device })
                : _('CrossPoint')
            }
            description={
              visibleStatus?.serial
                ? _('Serial {{serial}}', { serial: visibleStatus.serial })
                : _('No device confirmed yet')
            }
          />
          {capabilities && (
            <SettingsRow label={_('Firmware capabilities')}>
              <div className='flex flex-col items-end gap-0.5 text-end text-[0.8em]'>
                <span>{_('Books: supported')}</span>
                <span>
                  {progressSupported ? _('Progress: supported') : _('Progress: not yet supported')}
                </span>
                <span>
                  {capabilities.highlights
                    ? _('Highlights: supported')
                    : _('Highlights: not yet supported')}
                </span>
              </div>
            </SettingsRow>
          )}
          <SettingsRow
            label={settings.crosspoint.lastSyncedAt ? _('Books synced') : _('Send Readest books')}
            description={syncDescription}
          >
            <button
              type='button'
              onClick={() => void handleSync()}
              disabled={!canSync}
              className={clsx(
                'btn btn-ghost btn-sm h-8 min-h-8 gap-1 px-2',
                !canSync && 'opacity-60',
              )}
            >
              {isSyncing ? (
                <span className='loading loading-spinner loading-xs' />
              ) : (
                <MdSync className='h-4 w-4' />
              )}
              {_('Sync books')}
            </button>
          </SettingsRow>
        </BoxedList>

        {progressConflicts.length > 0 && (
          <BoxedList title={_('Progress conflicts')}>
            {progressConflicts.map((conflict) => {
              const conflictBook = useLibraryStore
                .getState()
                .library.find((book) => book.hash === conflict.document);
              const title = conflictBook?.title || conflict.document.slice(0, 8);
              return (
                <SettingsRow
                  key={conflict.document}
                  label={title}
                  description={_(
                    'Readest and CrossPoint have different saved positions. Open the book after choosing to apply the CrossPoint position.',
                  )}
                >
                  <button
                    type='button'
                    onClick={() => void handleSync([conflict.document])}
                    disabled={isSyncing}
                    className='btn btn-ghost btn-sm h-8 min-h-8 px-2'
                  >
                    {_('Use CrossPoint progress')}
                  </button>
                </SettingsRow>
              );
            })}
          </BoxedList>
        )}

        {notice && (
          <div
            role={notice.type === 'error' ? 'alert' : 'status'}
            className={clsx(
              'eink-bordered rounded-lg border px-4 py-3 text-sm',
              notice.type === 'error' && 'border-error/40 bg-error/10 text-error',
              notice.type === 'warning' && 'border-warning/40 bg-warning/10 text-base-content',
              notice.type === 'info' && 'border-base-300 bg-base-200/40 text-base-content',
            )}
          >
            {notice.message}
          </div>
        )}
      </div>
    </div>
  );
};

export default CrossPointForm;
