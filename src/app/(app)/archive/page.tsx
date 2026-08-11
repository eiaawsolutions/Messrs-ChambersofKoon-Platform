import type { Metadata } from 'next';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { recentUploads } from '@/lib/archive/upload';
import { ArchiveUploader } from '@/components/ArchiveUploader';
import { retryExtractionAction } from './actions';

export const metadata: Metadata = { title: 'Archive' };
export const dynamic = 'force-dynamic';

const STATE_PILL: Record<string, string> = {
  pending: 'pill-neutral',
  processing: 'pill-warning',
  done: 'pill-success',
  failed: 'pill-danger',
};

/**
 * Archive ingest screen (FR-5.1 – FR-5.4).
 *
 * The queue below the dropzone is the "never silently dropped" guarantee made
 * visible: every file shows its extraction state, its error if it has one, and
 * a retry that re-runs it (FR-5.3).
 */
export default async function ArchivePage() {
  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ARCHIVE_UPLOAD);

  const uploads = await recentUploads(actor);
  const failed = uploads.filter((u) => u.ocrState === 'failed');
  const unassigned = uploads.filter((u) => !u.matterReference);

  return (
    <div className="space-y-10">
      <header>
        <h1 className="rule-brass text-3xl">Archive</h1>
        <p className="text-ink-muted mt-4 max-w-2xl text-sm">
          Upload the firm&rsquo;s historic pleadings, correspondence and precedent. Text is
          extracted, chunked and indexed so it becomes searchable on the precedent screen.
          Re-uploading the same file is safe — it is recognised by content and never indexed twice.
        </p>
      </header>

      <ArchiveUploader />

      {failed.length > 0 ? (
        <section aria-labelledby="failed">
          <h2 id="failed" className="rule-brass text-xl">
            Needs attention
            <span className="pill pill-danger ml-3 align-middle" data-numeric>
              {failed.length}
            </span>
          </h2>
          <p className="text-ink-muted mt-3 max-w-2xl text-sm">
            Extraction failed on these. They are not indexed and are not lost — fix the cause and
            retry, or re-upload in a supported form.
          </p>
          <ul className="mt-5 space-y-2">
            {failed.map((file) => (
              <li key={file.id} className="surface border-l-clay-500 border-l-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-ink text-sm font-medium break-all">{file.filename}</p>
                    <p className="text-clay-700 mt-1 text-xs">{file.ocrError}</p>
                    <p className="text-ink-faint mt-1 text-xs" data-numeric>
                      {file.ocrAttempts} attempt{file.ocrAttempts === 1 ? '' : 's'}
                    </p>
                  </div>
                  <form action={retryExtractionAction} className="flex-none">
                    <input type="hidden" name="archiveFileId" value={file.id} />
                    <button className="btn btn-secondary" type="submit">
                      Retry
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="queue">
        <h2 id="queue" className="rule-brass text-xl">
          Recent uploads
        </h2>
        {unassigned.length > 0 ? (
          <p className="text-ink-muted mt-3 text-sm">
            {unassigned.length} file{unassigned.length === 1 ? ' is' : 's are'} not attached to a
            matter. They are searchable as firm-wide precedent.
          </p>
        ) : null}

        {uploads.length === 0 ? (
          <p className="surface text-ink-muted mt-5 p-8 text-center text-sm">
            Nothing uploaded yet.
          </p>
        ) : (
          <div className="scroll-x surface mt-5">
            <table className="table-legal">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Practice area</th>
                  <th scope="col">Matter</th>
                  <th scope="col">Pages</th>
                  <th scope="col">Indexed</th>
                  <th scope="col">State</th>
                  <th scope="col">Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {uploads.map((file) => (
                  <tr key={file.id}>
                    <td className="max-w-xs break-all">{file.filename}</td>
                    <td className="whitespace-nowrap">
                      {file.practiceArea?.replace(/_/g, ' ') ?? '—'}
                    </td>
                    <td className="font-mono text-xs">{file.matterReference ?? '—'}</td>
                    <td data-numeric>{file.pageCount ?? '—'}</td>
                    <td data-numeric>{file.chunkCount > 0 ? `${file.chunkCount} chunks` : '—'}</td>
                    <td>
                      <span className={`pill ${STATE_PILL[file.ocrState] ?? 'pill-neutral'}`}>
                        {file.ocrState}
                      </span>
                    </td>
                    <td className="whitespace-nowrap" data-numeric>
                      {new Intl.DateTimeFormat('en-MY', {
                        timeZone: 'Asia/Kuala_Lumpur',
                        day: 'numeric',
                        month: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      }).format(file.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
