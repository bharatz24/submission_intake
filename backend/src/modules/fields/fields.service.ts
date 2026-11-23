import { withTransaction } from '../../db/pool.js';
import type { AppDeps } from '../../deps.js';
import { AppError, notFound } from '../../http.js';
import { audit } from '../../services/audit.js';
import { bumpContextVersion } from '../../services/contextVersion.js';
import {
  addManualFields,
  effectiveFields,
  manualFieldRef,
  pickBest,
  refreshApplicantName,
} from '../../services/fields.js';
import { verifyNpi } from '../../services/pipeline.js';
import { getSubmissionDetail } from '../../services/queries.js';
import { requireLiveSubmission } from '../shared/submissionGuards.js';
import * as repo from './fields.repository.js';
import type { AddFieldsBody, UpdateFieldBody } from './fields.schemas.js';

/** Manual fields (services/fields.ts): each supersedes the extracted values with its field name. */
export function createFieldsService({ db }: Pick<AppDeps, 'db'>) {
  /** A manual value may cite one of this submission's documents, never another's. */
  const assertOwnDocuments = async (submissionId: string, ids: (string | null | undefined)[]) => {
    const wanted = [...new Set(ids.filter((d): d is string => !!d))];
    if (!wanted.length) return;
    if ((await repo.countOwnDocuments(db, submissionId, wanted)) !== wanted.length) {
      throw new AppError('FOREIGN_DOCUMENT', 400, 'The supporting document must belong to this submission');
    }
  };

  /** After any change: inbox name, NPI check for an entered NPI, new context version. */
  const afterChange = async (
    id: string,
    actorId: string,
    reason: string,
    npiField?: { value: string; note?: string | null },
  ) => {
    await refreshApplicantName(id);
    const npi = npiField?.value.replace(/\D/g, '');
    if (npi?.length === 10) {
      const fields = await effectiveFields(id);
      await verifyNpi(
        id,
        {
          npi,
          name: pickBest(fields, 'applicant_name'),
          state: pickBest(fields, 'practice_state'),
          specialty: pickBest(fields, 'specialty'),
        },
        actorId,
        { source: 'MANUAL', note: npiField?.note ?? null },
      );
    }
    await bumpContextVersion(id, reason, actorId);
  };

  const fieldOf = async (id: string, fieldId: string) => {
    await requireLiveSubmission(db, id);
    const field = await repo.getField(db, id, fieldId);
    if (!field) throw notFound('Field');
    return field;
  };

  return {
    async add(id: string, body: AddFieldsBody, actorId: string) {
      await getSubmissionDetail(id);
      await assertOwnDocuments(
        id,
        body.fields.map((f) => f.documentId),
      );
      await withTransaction((tx) => addManualFields(tx, id, body.fields, actorId));
      const npiFields = body.fields.filter((f) => f.fieldName === 'npi');
      if (!npiFields.length) await afterChange(id, actorId, 'Manual fields added');
      for (const f of npiFields) await afterChange(id, actorId, 'Manual fields added', f);
      return getSubmissionDetail(id);
    },

    async update(id: string, fieldId: string, body: UpdateFieldBody, actorId: string) {
      const before = await fieldOf(id, fieldId);
      await assertOwnDocuments(id, [body.documentId]);
      const after = {
        value: body.value ?? before.value,
        note: body.note === undefined ? before.note : body.note,
        documentId: body.documentId === undefined ? before.document_id : body.documentId,
      };
      await withTransaction(async (tx) => {
        await repo.updateField(tx, fieldId, after, actorId);
        await audit(
          {
            action: 'MANUAL_FIELD_UPDATED',
            entityType: 'manual_field',
            entityId: fieldId,
            submissionId: id,
            actorId,
            // References only (DB-01): which parts changed, never the values or notes themselves.
            details: {
              fieldName: before.field_name,
              valueChanged: after.value !== before.value,
              noteChanged: (after.note ?? null) !== (before.note ?? null),
              from: manualFieldRef(before.field_name, before.value, before.note, before.document_id),
              to: manualFieldRef(before.field_name, after.value, after.note ?? null, after.documentId ?? null),
            },
          },
          tx,
        );
      });
      await afterChange(id, actorId, 'Manual field updated', before.field_name === 'npi' ? after : undefined);
      return getSubmissionDetail(id);
    },

    async remove(id: string, fieldId: string, actorId: string) {
      const before = await fieldOf(id, fieldId);
      await withTransaction(async (tx) => {
        await repo.deleteField(tx, fieldId);
        await audit(
          {
            action: 'MANUAL_FIELD_DELETED',
            entityType: 'manual_field',
            entityId: fieldId,
            submissionId: id,
            actorId,
            details: manualFieldRef(before.field_name, before.value, before.note, before.document_id),
          },
          tx,
        );
      });
      // The NPI check it created stays: it is a manual NPI the user can remove on the NPI tab.
      await afterChange(id, actorId, 'Manual field removed');
      return getSubmissionDetail(id);
    },
  };
}
