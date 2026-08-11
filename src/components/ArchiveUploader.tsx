'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Bulk archive uploader (FR-5.1).
 *
 * "single and bulk (multi-file drag-drop, minimum 200 files per batch) with a
 *  visible progress queue and per-file status."
 *
 * Files are posted one request each through a bounded concurrency pool. That
 * is deliberate: a single multipart request for 200 scans is one opaque
 * spinner and one all-or-nothing failure, whereas per-file requests give real
 * per-file status and let a partial batch be retried without redoing the rest.
 */

type FileState = 'queued' | 'uploading' | 'done' | 'duplicate' | 'failed';

interface Item {
  key: string;
  name: string;
  size: number;
  state: FileState;
  detail?: string;
}

const CONCURRENCY = 4;

const PRACTICE_AREAS = [
  ['family_matrimonial', 'Family & matrimonial'],
  ['debt_recovery', 'Debt recovery'],
  ['land_property', 'Land & property'],
  ['corporate_disputes', 'Corporate disputes'],
  ['general', 'General'],
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ArchiveUploader({ matterId }: { matterId?: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [practiceArea, setPracticeArea] = useState<string>('general');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const batchId = useRef<string>(crypto.randomUUID());

  const update = useCallback((key: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }, []);

  const upload = useCallback(
    async (file: File, key: string) => {
      update(key, { state: 'uploading' });

      const body = new FormData();
      body.append('file', file);
      body.append('practiceArea', practiceArea);
      body.append('batchId', batchId.current);
      if (matterId) body.append('matterId', matterId);

      try {
        const response = await fetch('/api/archive/upload', { method: 'POST', body });
        const payload = (await response.json()) as {
          status?: string;
          error?: string;
          detail?: string;
        };

        if (!response.ok) {
          update(key, { state: 'failed', detail: payload.error ?? `HTTP ${response.status}` });
          return;
        }
        update(key, {
          state: payload.status === 'duplicate' ? 'duplicate' : 'done',
          detail:
            payload.status === 'duplicate'
              ? 'Already in the archive — not indexed twice'
              : 'Queued for text extraction',
        });
      } catch {
        update(key, { state: 'failed', detail: 'Network error' });
      }
    },
    [matterId, practiceArea, update],
  );

  const addFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);

      const queued: Item[] = files.map((file, index) => ({
        key: `${Date.now()}-${index}-${file.name}`,
        name: file.name,
        size: file.size,
        state: 'queued',
      }));
      setItems((prev) => [...queued, ...prev]);
      setBusy(true);

      // Bounded pool: a 200-file drop must not open 200 sockets.
      let cursor = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const file = files[index];
          const item = queued[index];
          if (!file || !item) return;
          await upload(file, item.key);
        }
      });

      await Promise.all(workers);
      setBusy(false);
      batchId.current = crypto.randomUUID();
    },
    [upload],
  );

  const counts = items.reduce<Record<FileState, number>>(
    (acc, item) => ({ ...acc, [item.state]: (acc[item.state] ?? 0) + 1 }),
    { queued: 0, uploading: 0, done: 0, duplicate: 0, failed: 0 },
  );

  return (
    <div className="space-y-5">
      <div className="surface-raised p-5">
        <label className="label" htmlFor="practiceArea">
          Practice area for this batch
        </label>
        <select
          className="field max-w-sm"
          id="practiceArea"
          value={practiceArea}
          onChange={(e) => setPracticeArea(e.target.value)}
        >
          {PRACTICE_AREAS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <p className="text-ink-faint mt-2 text-xs">
          Files without a matter land in the review queue for assignment.
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }}
        className={`rounded-md border-2 border-dashed p-10 text-center transition-colors ${
          dragging
            ? 'border-navy-600 bg-navy-50'
            : 'border-[color:var(--color-line-strong)] bg-[color:var(--color-paper-raised)]'
        }`}
      >
        <p className="font-display text-lg">Drop files here</p>
        <p className="text-ink-muted mx-auto mt-2 max-w-md text-sm">
          PDF, DOCX, JPG, PNG or plain text. Up to 50 MB each. Drop the whole folder — the queue
          below shows every file individually.
        </p>
        <button
          type="button"
          className="btn btn-secondary mt-4"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {busy ? 'Uploading…' : 'Choose files'}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          accept=".pdf,.docx,.jpg,.jpeg,.png,.txt"
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {items.length > 0 ? (
        <section aria-live="polite">
          <div className="mb-3 flex flex-wrap gap-2">
            <span className="pill pill-neutral" data-numeric>
              {items.length} file{items.length === 1 ? '' : 's'}
            </span>
            {counts.done > 0 ? (
              <span className="pill pill-success" data-numeric>
                {counts.done} uploaded
              </span>
            ) : null}
            {counts.duplicate > 0 ? (
              <span className="pill pill-info" data-numeric>
                {counts.duplicate} already present
              </span>
            ) : null}
            {counts.failed > 0 ? (
              <span className="pill pill-danger" data-numeric>
                {counts.failed} failed
              </span>
            ) : null}
            {counts.uploading + counts.queued > 0 ? (
              <span className="pill pill-warning" data-numeric>
                {counts.uploading + counts.queued} pending
              </span>
            ) : null}
          </div>

          <ul className="surface divide-line divide-y">
            {items.map((item) => (
              <li key={item.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                <span className="text-ink-faint text-xs" data-numeric>
                  {formatBytes(item.size)}
                </span>
                <span
                  className={`pill ${
                    item.state === 'done'
                      ? 'pill-success'
                      : item.state === 'duplicate'
                        ? 'pill-info'
                        : item.state === 'failed'
                          ? 'pill-danger'
                          : item.state === 'uploading'
                            ? 'pill-warning'
                            : 'pill-neutral'
                  }`}
                >
                  {item.state}
                </span>
                {item.detail ? (
                  <span className="text-ink-faint w-full text-xs">{item.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
