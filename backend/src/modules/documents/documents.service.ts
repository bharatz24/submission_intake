import type { Readable } from 'node:stream';

import type { Queryable } from '../../db/pool.js';
import type { AppDeps } from '../../deps.js';
import { AppError, notFound } from '../../http.js';
import { audit } from '../../services/audit.js';
import { safeContentType } from '../../services/mime.js';
import { openStoredFile, previewMimeType } from '../../services/storage.js';

/** A document of a deleted (hidden) submission is gone too. */
async function liveDocument(db: Queryable, id: string) {
  const {
    rows: [doc],
  } = await db.query(
    'SELECT d.* FROM documents d JOIN submissions s ON s.id=d.submission_id WHERE d.id=$1 AND s.deleted_at IS NULL',
    [id],
  );
  if (!doc) throw notFound('Document');
  return doc;
}

export interface OpenedDocument {
  filename: string;
  contentType: string;
  body: Readable;
}

/** Opening a stored document for download or for the in-app viewer; every open is audited. */
export function createDocumentsService({ db }: Pick<AppDeps, 'db'>) {
  return {
    /** The bytes with the sender's type (made safe: a malformed one becomes application/octet-stream). */
    async openForDownload(id: string, actorId: string): Promise<OpenedDocument> {
      const doc = await liveDocument(db, id);
      // Opened before any header is sent: a missing file or storage outage still gets a JSON 404/502 (http.ts).
      const body = await openStoredFile(doc);
      await audit({
        action: 'DOCUMENT_DOWNLOADED',
        entityType: 'document',
        entityId: id,
        submissionId: doc.submission_id,
        actorId,
        // The document id is the reference; its filename is applicant data and stays out of the audit trail (DB-01).
        details: { source: doc.source ?? null },
      });
      return { filename: doc.filename, contentType: safeContentType(doc.mime_type), body };
    },

    /** Only renderable, script-free types; others are refused with 415. */
    async openForView(id: string, actorId: string): Promise<OpenedDocument> {
      const doc = await liveDocument(db, id);
      const contentType = previewMimeType(doc.filename, doc.mime_type, doc.detected_type);
      if (!contentType)
        throw new AppError('PREVIEW_UNSUPPORTED', 415, 'This file type cannot be previewed; download it instead.');
      const body = await openStoredFile(doc);
      await audit({
        action: 'DOCUMENT_VIEWED',
        entityType: 'document',
        entityId: id,
        submissionId: doc.submission_id,
        actorId,
        // The document id is the reference; its filename is applicant data and stays out of the audit trail (DB-01).
        details: { source: doc.source ?? null },
      });
      return { filename: doc.filename, contentType, body };
    },
  };
}
