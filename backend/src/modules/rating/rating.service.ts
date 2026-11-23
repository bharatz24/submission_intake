import { MANUAL_FACTOR } from '../../constants.js';
import { withTransaction } from '../../db/pool.js';
import type { AppDeps } from '../../deps.js';
import { AppError, notFound } from '../../http.js';
import { audit } from '../../services/audit.js';
import { start, taskSnapshot } from '../../services/backgroundTasks.js';
import { RatingError } from '../../services/rating/calc.js';
import { geoStats } from '../../services/rating/geo.js';
import { type GeoImportResult, importGeo } from '../../services/rating/geoImport.js';
import {
  exportFileName,
  importRateWorkbook,
  type RATE_WORKBOOK_PREFIXES,
  RateImportError,
  rateWorkbookCounts,
  streamRateWorkbook,
} from '../../services/rating/importer.js';
import { deriveRatingInputs, type ratingInputsSchema, UNDERWRITER_KEYS } from '../../services/rating/inputs.js';
import {
  createQuote,
  editInputs,
  previewQuote,
  QuoteConflictError,
  rateOptions,
  specialityOptions,
  updateQuote,
} from '../../services/rating/quote.js';
import { loadQuotes, setPrimaryRating } from '../../services/rating/store.js';
import { activeRateGroup, listRateGroups, RatesNotLoadedError } from '../../services/rating/tables.js';
import { parseRateWorkbook } from '../../services/rating/workbookParser.js';
import { requireLiveSubmission } from '../shared/submissionGuards.js';
import * as repo from './rating.repository.js';

type RatingInputs = import('zod').infer<typeof ratingInputsSchema>;
export type RateWorkbook = (typeof RATE_WORKBOOK_PREFIXES)[number];

/** The last ZIP data reload (app_settings), so whichever instance answers GET /geo/import knows how it ended. */
const GEO_LAST_KEY = 'rates.geo_import.last';
const GEO_TASK = 'geo-import';
export interface GeoImportRun {
  at: string;
  by: string | null;
  result: GeoImportResult | null;
  error: string | null;
}

/** No rate tables yet, credits beyond -100%, a version race or bad workbooks: a 4xx the UI can show, not a 500. */
const rated = <T>(fn: () => Promise<T>) =>
  fn().catch((err) => {
    if (err instanceof RatesNotLoadedError) throw new AppError('RATES_NOT_LOADED', 409, err.message);
    if (err instanceof RatingError) throw new AppError('RATING_ERROR', 400, err.message);
    if (err instanceof QuoteConflictError) throw new AppError('QUOTE_CONFLICT', 409, err.message);
    if (err instanceof RateImportError)
      throw new AppError('RATE_IMPORT_INVALID', 422, err.message, { problems: err.problems });
    throw err;
  });

/** Quotes for a submission, and the rate tables and ZIP data they are priced with. */
export function createRatingService({ db }: Pick<AppDeps, 'db'>) {
  const live = (id: string) => requireLiveSubmission(db, id);

  /** The ZIP data reload's "last run" record, read by GET /geo/import on any instance. */
  const finishGeo = (actor: { id: string; name: string }, run: Omit<GeoImportRun, 'at' | 'by'>) =>
    repo.writeSetting(db, GEO_LAST_KEY, { at: new Date().toISOString(), by: actor.name, ...run }, actor.id);
  const recordFailure = (actor: { id: string; name: string }, err: unknown) =>
    finishGeo(actor, { result: null, error: err instanceof Error ? err.message : String(err) });
  /** Reload the ZIP data, then its audit row and "last run" record. */
  const importAndRecord = async (actor: { id: string; name: string }): Promise<GeoImportResult> => {
    const result = await importGeo();
    await audit({
      action: 'GEO_IMPORTED',
      entityType: 'geo',
      entityId: null,
      actorId: actor.id,
      details: { ...result },
    });
    await finishGeo(actor, { result, error: null });
    return result;
  };

  return {
    /** Inputs to prefill the quote dialog: from the submission's fields, plus the latest quote's underwriter choices. */
    async ratingInputs(id: string) {
      await live(id);
      const { inputs, sources } = await deriveRatingInputs(id);
      const last = await repo.latestQuoteInputs(db, id);
      if (last) {
        for (const k of UNDERWRITER_KEYS) {
          if (last.inputs[k] === undefined) continue;
          (inputs as Record<string, unknown>)[k] = last.inputs[k];
          sources[k] = `quote v${last.version}`;
        }
      }
      return { inputs, sources };
    },

    async quotes(id: string) {
      await live(id);
      return loadQuotes({ submissionId: id });
    },

    /** Inputs to prefill editing one saved quote, with the rate group a save prices with. */
    async editInputs(id: string, quoteId: string) {
      await live(id);
      const prefill = await editInputs(id, quoteId);
      if (!prefill) throw notFound('Quote');
      return prefill;
    },

    async preview(id: string, inputs: RatingInputs) {
      await live(id);
      return rated(() => previewQuote(id, inputs));
    },

    /**
     * An incomplete rating is saved as INCOMPLETE, never as $0. `basedOn` names the saved quote being edited: it stays
     * as it was, and the edit is saved as the next version.
     */
    async save(id: string, inputs: RatingInputs, actorId: string, basedOn?: string) {
      await live(id);
      let revised: { id: string; version: number } | undefined;
      if (basedOn) {
        const r = await repo.quoteOf(db, id, basedOn);
        if (!r) throw notFound('Quote');
        revised = { id: r.id, version: r.version };
      }
      const quoteId = await rated(() => createQuote(id, inputs, actorId, revised));
      const [q] = await loadQuotes({ id: quoteId });
      return q;
    },

    /** Saves the edit over the quote itself (same version), instead of as a new version. */
    async update(id: string, quoteId: string, inputs: RatingInputs, actorId: string) {
      await live(id);
      if (!(await rated(() => updateQuote(id, quoteId, inputs, actorId)))) throw notFound('Quote');
      const [q] = await loadQuotes({ id: quoteId });
      return q;
    },

    async setPrimary(id: string, ratingId: string, actorId: string) {
      await live(id);
      if (!(await setPrimaryRating(id, ratingId))) throw notFound('Quote');
      await audit({
        action: 'PRIMARY_RATING_SET',
        entityType: 'quote',
        entityId: ratingId,
        submissionId: id,
        actorId,
        details: {},
      });
      return loadQuotes({ submissionId: id });
    },

    /** Acknowledge an automatic quote (idempotent: the first reviewer is kept); returns the quote. */
    async review(id: string, quoteId: string, actorId: string) {
      await live(id);
      const found = await withTransaction(async (tx) => {
        const q = await repo.markQuoteReviewed(tx, id, quoteId, actorId);
        if (q?.reviewed)
          await audit(
            {
              action: 'QUOTE_REVIEWED',
              entityType: 'quote',
              entityId: quoteId,
              submissionId: id,
              actorId,
              details: { version: q.version },
            },
            tx,
          );
        return q !== null;
      });
      if (!found) throw notFound('Quote');
      const [quote] = await loadQuotes({ id: quoteId });
      if (!quote) throw notFound('Quote');
      return quote;
    },

    /** Rate classes that match a specialty, each priced with the other inputs. */
    async specialityOptions(id: string, inputs: RatingInputs, pick: { index?: number; title?: string }) {
      await live(id);
      return rated(() => specialityOptions(id, inputs, pick));
    },

    /** Dropdown data for one state, with the bounds of a manual specialty factor (the dialog checks the same range). */
    async options(state?: string) {
      return { ...(await rated(() => rateOptions(state))), manualFactor: MANUAL_FACTOR };
    },

    async groups() {
      const [groups, geo] = await Promise.all([listRateGroups(), geoStats()]);
      const active = groups.find((g) => g.is_active)?.name;
      return {
        groups: groups.map((g) => ({ name: g.name, isActive: g.is_active, importedAt: g.imported_at })),
        geo,
        workbooks: await rateWorkbookCounts(active),
      };
    },

    /**
     * One uploaded workbook becomes a new rate group: the other tables are copied from the active group, which is kept
     * as it was for the quotes already priced with it. The new group becomes active.
     */
    async importWorkbook(workbook: RateWorkbook, fileName: string, data: Buffer, actorId: string) {
      // Parsed in a worker thread after a zip-bomb check (workbookParser.ts), never on the event loop.
      const result = await rated(() => importRateWorkbook(workbook, fileName, data, parseRateWorkbook));
      await audit({
        action: 'RATE_WORKBOOK_IMPORTED',
        entityType: 'rate_group',
        entityId: null,
        actorId,
        details: { ...result },
      });
      return result;
    },

    /**
     * One workbook of the active rate group, in the format the upload reads: the file name, and a writer that streams
     * it (no rate tables: RATES_NOT_LOADED before anything is written).
     */
    async exportWorkbook(workbook: RateWorkbook) {
      const group = await rated(() => activeRateGroup());
      return {
        fileName: exportFileName(workbook),
        write: (out: import('node:stream').Writable) => streamRateWorkbook(workbook, group, out),
      };
    },

    /**
     * Downloads and reloads the ZIP-to-county tables (Census + GeoNames, about 7 MB) in the background (PERF-01): the
     * request answers 202 with the server time it started; GET /geo/import shows the run once `last.at` >= `since`.
     */
    async startGeoImport(actor: { id: string; name: string }): Promise<{ started: boolean; since: string }> {
      const since = new Date().toISOString();
      // Netlify: worker (a 7 MB download and reload); it records the run like runGeoImport below.
      const started = await start(
        GEO_TASK,
        () => importAndRecord(actor),
        (err) => void recordFailure(actor, err).catch(() => undefined),
        { worker: { task: 'geo-import', payload: { actor } } },
      );
      return { started, since };
    },

    /** The reload with its audit row and "last run" record, run by the Netlify worker's `geo-import` task. */
    async runGeoImport(actor: { id: string; name: string }): Promise<void> {
      try {
        await importAndRecord(actor);
      } catch (err) {
        await recordFailure(actor, err);
        throw err;
      }
    },

    /** Whether a reload runs on this instance, and how the last one (on any instance) ended. */
    async geoImportStatus() {
      return {
        running: taskSnapshot(GEO_TASK).running,
        last: await repo.readSetting<GeoImportRun>(db, GEO_LAST_KEY),
      };
    },
  };
}
