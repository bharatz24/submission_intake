import { withTransaction } from '../../db/pool.js';
import type { AppDeps } from '../../deps.js';
import { AppError, notFound } from '../../http.js';
import { audit } from '../../services/audit.js';
import { bumpContextVersion } from '../../services/contextVersion.js';
import { effectiveFields, pickBest } from '../../services/fields.js';
import { isValidNpi } from '../../services/npi.js';
import { syncNpiRegistryFields } from '../../services/npiRegistryFields.js';
import { verifyNpi, verifySubmissionNpis } from '../../services/pipeline.js';
import { getSubmissionDetail, listNpis } from '../../services/queries.js';
import { requireLiveSubmission } from '../shared/submissionGuards.js';
import * as repo from './npi.repository.js';
import type { ManualNpiBody, OverrideBody, VerifyBody } from './npi.schemas.js';

/** Claimed values a person typed outrank anything extracted. */
const TYPED_CONFIDENCE = 2;

/**
 * A submission's NPI checks against the NPPES registry: re-verify, add one by hand, remove a manual one, and an
 * underwriter's decision on a partial match. Each change makes a new context version (the reports' evidence).
 */
export function createNpiService({ db, npi: registry }: Pick<AppDeps, 'db' | 'npi'>) {
  /** A check changed by hand: the registry-backed fields follow it, audited in the same transaction. */
  const changeCheck = async (submissionId: string, write: (tx: import('pg').PoolClient) => Promise<void>) => {
    await withTransaction(async (tx) => {
      await write(tx);
      await syncNpiRegistryFields(submissionId, tx);
    });
  };

  const checkFor = async (submissionId: string, verificationId: string) => {
    await requireLiveSubmission(db, submissionId);
    const v = await repo.getVerification(db, submissionId, verificationId);
    if (!v) throw notFound('NPI verification');
    return v;
  };

  return {
    /** The registry record for one NPI (the manual-entry dialog's preview). */
    lookup: (npi: string) => registry.lookup(npi),

    /** NPI numbers on the submission are verified by number; without one, the registry is searched by name + ZIP. */
    async verify(id: string, body: VerifyBody, actorId: string) {
      await getSubmissionDetail(id);
      const fields = await effectiveFields(id);
      if (body.npi) {
        const source = await repo.sourceOf(db, id, body.npi);
        await verifyNpi(
          id,
          {
            npi: body.npi,
            name: body.claimedName ?? pickBest(fields, 'applicant_name'),
            state: body.claimedState ?? pickBest(fields, 'practice_state'),
            specialty: pickBest(fields, 'specialty'),
          },
          actorId,
          { source: source ?? 'EXTRACTED' },
        );
      } else {
        const overrides = [
          ...(body.claimedName
            ? [{ fieldName: 'applicant_name', value: body.claimedName, confidence: TYPED_CONFIDENCE }]
            : []),
          ...(body.claimedState
            ? [{ fieldName: 'practice_state', value: body.claimedState, confidence: TYPED_CONFIDENCE }]
            : []),
        ];
        await verifySubmissionNpis(id, [...overrides, ...fields], actorId);
      }
      await bumpContextVersion(id, 'NPI re-verification', actorId);
      return listNpis(id);
    },

    /** An NPI a person entered: verified against the registry now, kept through reprocessing, removable later. */
    async addManual(id: string, body: ManualNpiBody, actorId: string) {
      if (!isValidNpi(body.npi))
        throw new AppError(
          'INVALID_NPI',
          400,
          'This is not a valid NPI: the check digit does not match. Check for a typo.',
        );
      await getSubmissionDetail(id);
      const fields = await effectiveFields(id);
      await verifyNpi(
        id,
        {
          npi: body.npi,
          name: body.claimedName ?? pickBest(fields, 'applicant_name'),
          state: body.claimedState ?? pickBest(fields, 'practice_state'),
          specialty: body.claimedSpecialty ?? pickBest(fields, 'specialty'),
        },
        actorId,
        { source: 'MANUAL', note: body.note || null },
      );
      await audit({
        action: 'NPI_ADDED',
        entityType: 'submission',
        entityId: id,
        submissionId: id,
        actorId,
        // The NPI is the reference; the claimed name/state and the note are applicant data (DB-01).
        details: {
          npi: body.npi,
          hasClaimedName: Boolean(body.claimedName),
          hasClaimedState: Boolean(body.claimedState),
          hasNote: Boolean(body.note),
        },
      });
      await bumpContextVersion(id, 'Manual NPI added', actorId);
      return listNpis(id);
    },

    /** Only NPIs entered by hand: the ones found on the submission come back on re-verification. */
    async removeManual(id: string, verificationId: string, actorId: string) {
      const v = await checkFor(id, verificationId);
      if (v.source !== 'MANUAL') {
        throw new AppError(
          'NOT_MANUAL',
          409,
          'Only NPIs entered by hand can be removed; NPIs found on the submission come back on re-verification',
        );
      }
      await changeCheck(id, async (tx) => {
        await repo.deleteVerification(tx, verificationId);
        await audit(
          {
            action: 'NPI_REMOVED',
            entityType: 'npi_verification',
            entityId: verificationId,
            submissionId: id,
            actorId,
            details: { npi: v.npi, status: v.status },
          },
          tx,
        );
      });
      await bumpContextVersion(id, 'Manual NPI removed', actorId);
      return listNpis(id);
    },

    /** An underwriter's decision on a partial match. Kept through re-verification while the registry differences stay the same. */
    async override(id: string, verificationId: string, body: OverrideBody, actorId: string) {
      const v = await checkFor(id, verificationId);
      if ((v.auto_status ?? v.status) !== 'PARTIAL_MATCH') {
        throw new AppError(
          'NOT_PARTIAL_MATCH',
          409,
          'Only partial matches can be changed by hand; re-verify or enter the correct NPI instead',
        );
      }
      await changeCheck(id, async (tx) => {
        await repo.setOverride(tx, verificationId, body.status, body.note, actorId);
        await audit(
          {
            action: 'NPI_MATCH_OVERRIDDEN',
            entityType: 'npi_verification',
            entityId: verificationId,
            submissionId: id,
            actorId,
            details: { npi: v.npi, from: v.status, to: body.status, noteLength: body.note?.length ?? 0 },
          },
          tx,
        );
      });
      await bumpContextVersion(id, 'NPI match changed by underwriter', actorId);
      return listNpis(id);
    },

    async undoOverride(id: string, verificationId: string, actorId: string) {
      const v = await checkFor(id, verificationId);
      if (!v.auto_status)
        throw new AppError('NOT_OVERRIDDEN', 409, 'This NPI check has no underwriter decision to undo');
      await changeCheck(id, async (tx) => {
        await repo.clearOverride(tx, verificationId);
        await audit(
          {
            action: 'NPI_OVERRIDE_REMOVED',
            entityType: 'npi_verification',
            entityId: verificationId,
            submissionId: id,
            actorId,
            details: { npi: v.npi, from: v.status, to: v.auto_status, hadNote: Boolean(v.override_note) },
          },
          tx,
        );
      });
      await bumpContextVersion(id, 'NPI match decision undone', actorId);
      return listNpis(id);
    },
  };
}
