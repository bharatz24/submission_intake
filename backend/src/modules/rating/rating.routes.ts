import { type Response, Router } from 'express';
import { z } from 'zod';

import type { AppDeps } from '../../deps.js';
import { AppError, currentUser, limitedUpload, parseBody, requirePermission, uuidParam } from '../../http.js';
import { logger } from '../../logger.js';
import { limits } from '../../services/limitsSettings.js';
import { RATE_WORKBOOK_PREFIXES } from '../../services/rating/importer.js';
import { ratingInputsSchema } from '../../services/rating/inputs.js';
import { createRatingService } from './rating.service.js';

const QuoteBody = z.object({ inputs: ratingInputsSchema });
const SaveQuoteBody = QuoteBody.extend({ basedOn: z.uuid().optional() });
const PrimaryBody = z.object({ ratingId: z.uuid() });
const SpecialityBody = QuoteBody.extend({
  index: z.number().int().min(0).max(20).optional(),
  title: z.string().max(300).optional(),
});
const OptionsQuery = z.object({ state: z.string().length(2).optional() });
const WorkbookParam = z.object({ workbook: z.enum(RATE_WORKBOOK_PREFIXES) });

// Rate workbooks are small and parsed at once: kept in memory only while they are read. Size limit from Settings → Limits.
const workbookUpload = limitedUpload(
  'file',
  () => ({ maxFileMb: limits().rateWorkbookMaxMb, maxFiles: 1 }),
  'single',
  'memory',
);

function uploadedXlsx(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file) throw new AppError('FILE_REQUIRED', 400, 'Choose an .xlsx workbook to upload');
  if (!/\.xlsx$/i.test(file.originalname))
    throw new AppError('RATE_IMPORT_INVALID', 400, `${file.originalname} is not an .xlsx workbook`);
  return file;
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Streams the workbook (PERF-02); an error once bytes are sent can only cut the download, which is logged. */
async function sendXlsx(res: Response, fileName: string, write: (out: Response) => Promise<void>) {
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    await write(res);
  } catch (err) {
    if (!res.headersSent) throw err;
    logger.error({ err }, 'rate workbook export failed mid-stream');
    res.destroy();
  }
}

/** Quotes, rate tables and ZIP-to-county data. Mounted behind requireAuth (app.ts). */
export function ratingRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createRatingService(deps);
  const submissionId = (value: string | string[] | undefined) => uuidParam(value, 'Submission');

  router.get('/submissions/:id/rating-inputs', async (req, res) => {
    res.json(await service.ratingInputs(submissionId(req.params.id)));
  });

  router.get('/submissions/:id/quotes', async (req, res) => {
    res.json(await service.quotes(submissionId(req.params.id)));
  });

  router.get('/submissions/:id/quotes/:quoteId/inputs', async (req, res) => {
    const id = submissionId(req.params.id);
    res.json(await service.editInputs(id, uuidParam(req.params.quoteId, 'Quote')));
  });

  /** Prices without saving: the dialog's "Calculate" button. */
  router.post('/submissions/:id/quotes/preview', requirePermission('submission:write'), async (req, res) => {
    const id = submissionId(req.params.id);
    res.json(await service.preview(id, parseBody(QuoteBody, req.body).inputs));
  });

  /** The dialog's "Save quote" button. */
  router.post('/submissions/:id/quotes', requirePermission('submission:write'), async (req, res) => {
    const id = submissionId(req.params.id);
    const { inputs, basedOn } = parseBody(SaveQuoteBody, req.body);
    res.status(201).json(await service.save(id, inputs, currentUser(req).id, basedOn));
  });

  /** The edit dialog's "Save changes to vN" button: overwrites that quote, keeping its version. */
  router.put('/submissions/:id/quotes/:quoteId', requirePermission('submission:write'), async (req, res) => {
    const id = submissionId(req.params.id);
    const { inputs } = parseBody(QuoteBody, req.body);
    res.json(await service.update(id, uuidParam(req.params.quoteId, 'Quote'), inputs, currentUser(req).id));
  });

  /** Marks one saved quote as the submission's primary rating (submissions.primary_rating_id). */
  router.put('/submissions/:id/primary-rating', requirePermission('submission:write'), async (req, res) => {
    const id = submissionId(req.params.id);
    const { ratingId } = parseBody(PrimaryBody, req.body);
    res.json(await service.setPrimary(id, ratingId, currentUser(req).id));
  });

  /** Acknowledge a quote generated automatically ("Mark reviewed"). */
  router.post('/submissions/:id/quotes/:quoteId/review', requirePermission('submission:write'), async (req, res) => {
    const id = submissionId(req.params.id);
    res.json(await service.review(id, uuidParam(req.params.quoteId, 'Quote'), currentUser(req).id));
  });

  router.post('/submissions/:id/speciality-options', requirePermission('submission:write'), async (req, res) => {
    const id = submissionId(req.params.id);
    const body = parseBody(SpecialityBody, req.body);
    res.json(await service.specialityOptions(id, body.inputs, { index: body.index, title: body.title }));
  });

  /** Dropdown data for the quote dialog (limits, hours bands, credits, fees) for one state. */
  router.get('/rates/options', async (req, res) => {
    res.json(await service.options(parseBody(OptionsQuery, req.query).state));
  });

  router.get('/rates/groups', async (_req, res) => {
    res.json(await service.groups());
  });

  router.post('/rates/import/:workbook', requirePermission('rate:manage'), workbookUpload, async (req, res) => {
    const { workbook } = parseBody(WorkbookParam, req.params);
    const file = uploadedXlsx(req.file);
    res.json(await service.importWorkbook(workbook, file.originalname, file.buffer, currentUser(req).id));
  });

  router.get('/rates/export/:workbook', async (req, res) => {
    const { workbook } = parseBody(WorkbookParam, req.params);
    const { fileName, write } = await service.exportWorkbook(workbook);
    await sendXlsx(res, fileName, write);
  });

  /** Starts the ZIP data reload in the background (202); `started` false when one already runs here. */
  router.post('/geo/import', requirePermission('rate:manage'), async (req, res) => {
    const user = currentUser(req);
    res.status(202).json(await service.startGeoImport({ id: user.id, name: user.name }));
  });

  router.get('/geo/import', requirePermission('rate:manage'), async (_req, res) => {
    res.json(await service.geoImportStatus());
  });

  return router;
}
