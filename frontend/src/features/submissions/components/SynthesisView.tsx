import {
  alpha,
  Box,
  Chip,
  Grid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';

import { EnumChip, KeyValue, Linkify, Markdown } from '../../../components/common';
import { accent, Section, SlimEmpty } from '../../../components/ReportSection';
import { useManualStep } from '../../../lib/automation';
import { remarkHighlight } from '../../../lib/emailFormat';
import type { ApplicantName } from '../../../lib/status';
import { applicantNameFields, humanize, levelColor } from '../../../lib/status';
import { api } from '../../../services/api';
import type { GroundingItem, Report, Sourced, SynthesisContent } from '../../../types';
import { NotFoundMarker, unverifiedByPath } from './GroundingSummary';
import { ReportShell } from './ReportShell';

export function SynthesisView({
  submissionId,
  applicant,
  held = false,
}: {
  submissionId: string;
  applicant: ApplicantName;
  held?: boolean;
}) {
  const manual = useManualStep('synthesis', held);
  return (
    <ReportShell
      submissionId={submissionId}
      kind="SYNTHESIS"
      title="Synthesis Report"
      description="Synthesis creates the facts: a sourced, versioned consolidation of the email, attachments and NPI evidence."
      emptyDescription={
        manual ? "Synthesis is Manual in Settings → Automation. Generate the first version when you're ready." : null
      }
      generate={() => api.generateSynthesis(submissionId)}
      renderStructured={(r: Report) => (
        <SynthesisBody
          c={r.content as SynthesisContent}
          applicant={applicant}
          unverified={unverifiedByPath(r.grounding)}
        />
      )}
    />
  );
}

const NONE = new Map<string, GroundingItem>();

/** `path` is the content key of `rows` ("extractedFacts"), matched against grounding paths ("extractedFacts[0]"). */
function SourcedTable({
  rows,
  empty,
  path,
  unverified = NONE,
}: {
  rows: Sourced[];
  empty: string;
  path?: string;
  unverified?: Map<string, GroundingItem>;
}) {
  if (!rows?.length)
    return (
      <Typography variant="body2" color="text.secondary">
        {empty}
      </Typography>
    );
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Fact</TableCell>
            <TableCell width="28%">Source</TableCell>
            <TableCell width={110} align="right">
              Confidence
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((f, i) => (
            <TableRow key={i} sx={{ '& > td': { verticalAlign: 'top' } }}>
              <TableCell sx={{ wordBreak: 'break-word' }}>
                <Linkify>{f.text}</Linkify>
                {path && <NotFoundMarker item={unverified.get(`${path}[${i}]`)} />}
              </TableCell>
              <TableCell>
                <Typography variant="caption" color="text.secondary">
                  {f.source}
                </Typography>
              </TableCell>
              <TableCell align="right">
                <EnumChip value={f.confidence} color={levelColor(f.confidence, true)} variant="outlined" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

const IMPORTANCE_COLOR = { CRITICAL: 'error', IMPORTANT: 'warning', NICE_TO_HAVE: 'default' } as const;

/** Synthesis uses the same full-width collapsible bands as the Analysis tab; content is unchanged. */
function SynthesisBody({
  c,
  applicant,
  unverified,
}: {
  c: SynthesisContent;
  applicant: ApplicantName;
  /** Items not found in the submission, by path ("extractedFacts[0]"). */
  unverified: Map<string, GroundingItem>;
}) {
  const p = c.applicantProfile;
  const conflicts = c.conflicts ?? [];
  const inventory = c.emailAndAttachmentInventory ?? [];
  const facts = c.extractedFacts ?? [];
  const missing = [...(c.missingInformation ?? [])].sort((a, b) => order(a.importance) - order(b.importance));
  const confColor = levelColor(c.dataConfidence?.overall, true);

  return (
    <Stack spacing={1.5} useFlexGap>
      <Section title="Submission overview">
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
          <Linkify>{c.submissionOverview}</Linkify>
        </Typography>
      </Section>

      <Section title="Data confidence" tone={confColor === 'default' ? 'secondary' : confColor}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
          <EnumChip
            value={c.dataConfidence?.overall}
            color={confColor}
            size="medium"
            label={`${humanize(c.dataConfidence?.overall)} confidence`}
          />
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            <Linkify>{c.dataConfidence?.notes}</Linkify>
          </Typography>
        </Stack>
      </Section>

      <Section title="Applicant profile">
        <Grid container spacing={1.5} sx={{ mb: p?.other?.length ? 1.5 : 0 }}>
          {applicantNameFields(applicant, p?.name).map((f) => (
            <Grid key={f.label} item xs={6} sm={4} md={3}>
              <KeyValue label={f.label} value={f.value} />
            </Grid>
          ))}
          <Grid item xs={6} sm={4} md={3}>
            <KeyValue label="NPI" value={p?.npi ? <Linkify>{p.npi}</Linkify> : null} />
          </Grid>
          <Grid item xs={6} sm={4} md={3}>
            <KeyValue label="Specialty" value={p?.specialty} />
          </Grid>
          <Grid item xs={6} sm={4} md={3}>
            <KeyValue label="State" value={p?.state} />
          </Grid>
          <Grid item xs={6} sm={4} md={3}>
            <KeyValue label="Practice" value={p?.practiceName} />
          </Grid>
          <Grid item xs={6} sm={4} md={3}>
            <KeyValue label="Years in practice" value={p?.yearsInPractice} />
          </Grid>
        </Grid>
        {p?.other?.length > 0 && (
          <SourcedTable rows={p.other} empty="" path="applicantProfile.other" unverified={unverified} />
        )}
      </Section>

      {inventory.length === 0 ? (
        <SlimEmpty title="Email & attachment inventory" tone="primary" text="No items inventoried" />
      ) : (
        <Section title="Email & attachment inventory" count={inventory.length}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell width="26%">Item</TableCell>
                  <TableCell width={140}>Type</TableCell>
                  <TableCell width={140}>Status</TableCell>
                  <TableCell>Notes</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {inventory.map((it, i) => (
                  <TableRow key={i} sx={{ '& > td': { verticalAlign: 'top' } }}>
                    <TableCell sx={{ fontWeight: 600, wordBreak: 'break-word' }}>{it.item}</TableCell>
                    <TableCell>{it.type}</TableCell>
                    <TableCell>
                      <Chip size="small" variant="outlined" label={it.status} />
                    </TableCell>
                    <TableCell>
                      <Linkify>{it.notes}</Linkify>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Section>
      )}

      {facts.length === 0 ? (
        <SlimEmpty title="Extracted facts" tone="info" text="No facts extracted" />
      ) : (
        <Section title="Extracted facts" tone="info" count={facts.length} subtitle="Each fact cites its source.">
          <SourcedTable rows={facts} empty="No facts extracted." path="extractedFacts" unverified={unverified} />
        </Section>
      )}

      <Section title="NPI verification summary" tone="secondary">
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          <Linkify>{c.npiVerificationSummary || '—'}</Linkify>
        </Typography>
      </Section>

      {conflicts.length === 0 ? (
        <SlimEmpty title="Conflicts" tone="warning" text="No conflicts detected" />
      ) : (
        <Section title="Conflicts" tone="warning" count={conflicts.length} subtitle="Where sources disagree.">
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell width="38%">Description</TableCell>
                  <TableCell width="26%">Sources</TableCell>
                  <TableCell>Resolution</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {conflicts.map((cf, i) => (
                  <TableRow
                    key={i}
                    sx={{
                      '& > td': { verticalAlign: 'top' },
                      '& > td:first-of-type': { borderLeft: 3, borderLeftColor: 'warning.main' },
                    }}
                  >
                    <TableCell sx={{ fontWeight: 600 }}>
                      <Linkify>{cf.description}</Linkify>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {(cf.sources ?? []).map((s, j) => (
                          <Chip key={j} size="small" variant="outlined" label={s} />
                        ))}
                        <NotFoundMarker item={unverified.get(`conflicts[${i}].sources`)} />
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Linkify>{cf.resolution || 'Unresolved'}</Linkify>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Section>
      )}

      {missing.length === 0 ? (
        <SlimEmpty title="Missing information" tone="error" text="Nothing flagged as missing" />
      ) : (
        <Section title="Missing information" tone="error" count={missing.length}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell width="32%">Item</TableCell>
                  <TableCell width={140}>Importance</TableCell>
                  <TableCell>Reason</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {missing.map((m, i) => (
                  <TableRow
                    key={i}
                    sx={{
                      '& > td': { verticalAlign: 'top' },
                      '& > td:first-of-type': {
                        borderLeft: 3,
                        borderLeftColor: accent(IMPORTANCE_COLOR[m.importance] ?? 'default'),
                      },
                    }}
                  >
                    <TableCell sx={{ fontWeight: 600 }}>{m.item}</TableCell>
                    <TableCell>
                      <EnumChip value={m.importance} color={IMPORTANCE_COLOR[m.importance] ?? 'default'} />
                    </TableCell>
                    <TableCell>
                      <Linkify>{m.reason}</Linkify>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Section>
      )}

      {c.consolidatedContextForLlm && (
        <Section
          title="Consolidated context for LLM analysis"
          tone="secondary"
          subtitle="The fact base handed to the Analysis skill."
          defaultOpen={false}
        >
          <ConsolidatedContext text={c.consolidatedContextForLlm} />
        </Section>
      )}
    </Stack>
  );
}

// ---- Email-style rendering of the whole "Consolidated context" (display only; every statement of the source is kept) ----
// Headings the synthesis skill writes; each can sit on its own line or inline in the run-on text.
const HEADINGS = [
  'Transaction & [Ff]orms',
  'Requested coverage',
  'Prior coverage & continuity',
  'Claims & incidents',
  'Provider & licensure',
  'Specialty, time split & procedures',
  'Practice structure, locations & facilities',
  'ERP / DDR / cancellation',
  'Conflicts',
  'Missing items',
];
const HEAD_RE = new RegExp(
  `(?:^|\\s)(?:#{1,6}\\s*)?(?:\\*\\*|__)?(${HEADINGS.join('|').replace(/\//g, '\\/')})(?:\\s*\\([^)\\n]*\\))?(?:\\*\\*|__)?\\s*(?::|(?=\\n))`,
  'g',
);

const KEY_PHRASES =
  /\b(none received|not received|no application received|not present|not stated|unknown|unresolved|CONFLICT)\b/gi;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const cell = (v: string) => v.replace(/\|/g, '\\|').trim();
const keyInfo = (t: string) => t.replace(KEY_PHRASES, '==$1==').replace(DATE_RE, '**$&**');
const bullet = (x: string) => {
  const m = /^([^:*|]{2,70}):\s+(\S.*)$/.exec(x);
  return `- ${m?.[1] && m[2] ? `**${m[1].trim()}:** ${keyInfo(m[2])}` : keyInfo(x)}`;
};

/** Splits the run-on " - " text into its individual statements. */
function statements(raw: string): string[] {
  return raw
    .split('\n')
    .flatMap((l) => l.trim().split(/(?<=[.!?;)\]])\s+[-–•]\s+/))
    .map((x) => x.replace(/^[-–•*]\s+/, '').trim())
    .filter(Boolean);
}

/** Splits a statement into sentences without breaking on abbreviations such as "Dr." or "Pvt. Ltd.". */
const ABBR = /\b(?:Dr|Mr|Ms|Mrs|Pvt|Ltd|St|Ste|Blvd|No|vs)\.$/;
function sentences(item: string): string[] {
  const out: string[] = [];
  item.split(/(?<=\.)\s+(?=[A-Z'‘])/).forEach((part) => {
    const prev = out[out.length - 1];
    if (prev !== undefined && ABBR.test(prev)) out[out.length - 1] = `${prev} ${part}`;
    else out.push(part);
  });
  return out;
}
const flat = (items: string[]) => items.flatMap(sentences);

function transactionMd(raw: string): string {
  const rest = statements(raw);
  const md: string[] = [];
  const take = (re: RegExp) => {
    const i = rest.findIndex((x) => re.test(x));
    return i < 0 ? undefined : rest.splice(i, 1)[0];
  };
  const hm = rest.length
    ? /^(.+?)\s+per email body\s*\((.+?),\s*received\s+(\S+?),\s*sent from\s+([^\s)]+)\)\.?\s*(.*)$/i.exec(
        rest[0] ?? '',
      )
    : null;
  if (hm) {
    const [, transaction = '', broker = '', received = '', sentFrom = '', note = ''] = hm;
    rest.shift();
    md.push(
      '| Transaction | Broker | Received | Sent from |',
      '| --- | --- | --- | --- |',
      `| **${cell(transaction)}** | ${cell(broker)} | **${cell(received)}** | ${cell(sentFrom)} |`,
      '',
    );
    if (note) md.push(keyInfo(note), '');
  }
  const listedLine = take(/lists\s+\d+\s+attachments?\s*\(/i);
  const onlyLine = take(/^only attachment:/i);
  const absentLine = take(/^no\s+.+\b(present|received)\.?$/i);
  const rows: [string, string][] = [];
  let listedCount = 0;
  if (listedLine) {
    const lm = /^.*?lists\s+(\d+)\s+attachments?\s*\(([^)]+)\)\s*;?\s*(.*)$/i.exec(listedLine);
    if (lm) {
      const [, count = '0', listed = '', after = ''] = lm;
      listedCount = Number(count);
      const none = /none received/i.test(after);
      listed
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean)
        .forEach((d) => rows.push([d, none ? '==Not received==' : 'Listed']));
    } else rest.unshift(listedLine);
  }
  if (onlyLine) rows.push([onlyLine.replace(/^only attachment:\s*/i, '').replace(/\.$/, ''), '**Received**']);
  if (absentLine) {
    const am = /^no\s+(.+?)\s+(?:present|received)\.?$/i.exec(absentLine);
    if (am?.[1])
      am[1]
        .split(/,\s*(?:or\s+)?|\s+or\s+/)
        .filter(Boolean)
        .forEach((d) => rows.push([d.trim(), '==Not present==']));
    else rest.unshift(absentLine);
  }
  if (rows.length) {
    if (listedCount) md.push(`**${listedCount} attachments were listed in the email:**`, '');
    md.push('| Document | Status |', '| --- | --- |', ...rows.map(([d, st]) => `| ${cell(d)} | ${st} |`), '');
  }
  flat(rest).forEach((x) => md.push(bullet(x)));
  return md.join('\n');
}

const KV_RE = /^(Applicant|Coverage|Limit|Policy period|Retro date|Premium worksheet)\s*:?\s+(\S.*)$/;
function requestedMd(raw: string): string {
  const rows: string[] = [];
  const other: string[] = [];
  flat(statements(raw)).forEach((x) => {
    const m = KV_RE.exec(x);
    if (m?.[1] && m[2]) rows.push(`| **${m[1]}** | ${cell(keyInfo(m[2]))} |`);
    else other.push(bullet(x));
  });
  return [...(rows.length ? ['| Item | Detail |', '| --- | --- |', ...rows, ''] : []), ...other].join('\n');
}

function conflictsMd(raw: string): string {
  return statements(raw)
    .map((x, i) => `${i + 1}. ${keyInfo(x)}`)
    .join('\n');
}

function missingMd(raw: string): string {
  const rows: string[] = [];
  const other: string[] = [];
  statements(raw).forEach((x) => {
    const m = /^(CRITICAL|IMPORTANT|NICE[ _]TO[ _]HAVE)\s*:\s*(.*)$/i.exec(x);
    if (!m) {
      other.push(bullet(x));
      return;
    }
    const [, priority = '', items = ''] = m;
    const level =
      priority.toUpperCase() === 'CRITICAL'
        ? `==${priority.toUpperCase()}==`
        : `**${priority.toUpperCase().replace(/_/g, ' ')}**`;
    // Split on ";" only outside parentheses; a trailing sentence ("Data confidence: LOW (...)") becomes a note under the table.
    items
      .split(/;\s*(?![^(]*\))/)
      .filter(Boolean)
      .forEach((it) => {
        const [first, ...tail] = sentences(it.trim());
        if (first === undefined) return;
        rows.push(`| ${level} | ${cell(first.replace(/\.$/, ''))} |`);
        tail.forEach((t) => other.push(bullet(t)));
      });
  });
  return [...(rows.length ? ['| Priority | Missing item |', '| --- | --- |', ...rows, ''] : []), ...other].join('\n');
}

/** Bullets for a list-style section, a plain paragraph when the section is a single run of text. */
function genericMd(raw: string): string {
  const items = statements(raw);
  const isList = /^\s*[-–•]\s/.test(raw.trim()) || items.length > 1;
  const parts = flat(items);
  return isList ? parts.map(bullet).join('\n') : keyInfo(items.join(' '));
}

function renderSection(title: string, raw: string): string {
  if (/^Transaction/i.test(title)) return transactionMd(raw);
  if (title === 'Requested coverage') return requestedMd(raw);
  if (title === 'Conflicts') return conflictsMd(raw);
  if (title === 'Missing items') return missingMd(raw);
  return genericMd(raw);
}

/** Consolidated context: every heading becomes its own email-style section; text outside any heading stays as it was. */
function ConsolidatedContext({ text }: { text: string }) {
  const plain = (s: string) => (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        bgcolor: 'surface.subtle',
        borderRadius: 1,
        whiteSpace: 'pre-wrap',
        fontSize: '0.75rem',
        fontFamily: 'ui-monospace, Consolas, monospace',
      }}
    >
      <Linkify>{s}</Linkify>
    </Box>
  );
  const wrap = (children: ReactNode) => <Box sx={{ maxHeight: 560, overflow: 'auto' }}>{children}</Box>;
  const heads = [...text.matchAll(HEAD_RE)];
  if (!heads.length) return wrap(plain(text));

  const preamble = text.slice(0, heads[0]?.index).trim();
  const md = heads
    .map((m, i) => {
      const bodyStart = (m.index ?? 0) + m[0].length;
      const body = text.slice(bodyStart, heads[i + 1]?.index);
      const title = m[1] ?? '';
      return `## ${title}\n\n${renderSection(title, body)}`;
    })
    .join('\n\n');

  return wrap(
    <Stack spacing={1} useFlexGap>
      {preamble && plain(preamble)}
      <Box
        sx={(t) => ({
          p: { xs: 2, md: 3 },
          border: 1,
          borderColor: 'divider',
          borderTop: 4,
          borderTopColor: 'primary.main',
          borderRadius: 1.5,
          bgcolor: 'background.paper',
          counterReset: 'sec',
          '&& > div': { maxWidth: 980, fontSize: '0.9rem', lineHeight: 1.65 },
          // Section headings: numbered badge + hairline
          '&& h2': {
            counterIncrement: 'sec',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            mt: 3.5,
            mb: 1.25,
            pb: 0.75,
            fontSize: '1.02rem',
            fontWeight: 700,
            color: 'text.primary',
            borderBottom: '1px solid',
            borderColor: 'divider',
          },
          '&& h2::before': {
            content: 'counter(sec)',
            flexShrink: 0,
            width: 24,
            height: 24,
            borderRadius: '50%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            fontSize: '0.75rem',
            fontWeight: 700,
          },
          '&& > div > h2:first-of-type': { mt: 0 },
          // Tables: full width, quiet header row, zebra rows
          '&& table': {
            display: 'table',
            width: '100%',
            my: 1.25,
            borderCollapse: 'separate',
            borderSpacing: 0,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            overflow: 'hidden',
          },
          '&& th': {
            bgcolor: alpha(t.palette.primary.main, 0.08),
            color: 'text.secondary',
            fontSize: '0.7rem',
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            border: 0,
            borderBottom: '1px solid',
            borderColor: 'divider',
            py: 0.9,
            px: 1.5,
          },
          '&& td': { border: 0, borderBottom: '1px solid', borderColor: 'divider', py: 0.75, px: 1.5 },
          '&& tbody tr:last-of-type td': { borderBottom: 0 },
          '&& tbody tr:nth-of-type(even)': { bgcolor: alpha(t.palette.text.primary, 0.025) },
          '&& td:first-of-type': { whiteSpace: 'nowrap', width: '1%', fontWeight: 600 },
          // Lists and emphasis
          '&& ul, && ol': { pl: 3, my: 0.75 },
          '&& li': { mb: 0.4, pl: 0.25 },
          '&& li::marker': { color: t.palette.primary.main, fontWeight: 700 },
          '&& strong': { fontWeight: 700 },
          '&& mark': {
            bgcolor: alpha(t.palette.warning.main, 0.22),
            color: 'inherit',
            fontWeight: 600,
            px: 0.6,
            py: 0.1,
            borderRadius: 0.75,
            boxShadow: `inset 0 -2px 0 ${alpha(t.palette.warning.main, 0.55)}`,
          },
          '&& p': { my: 0.75 },
        })}
      >
        <Markdown plugins={[remarkHighlight]}>{md}</Markdown>
      </Box>
    </Stack>,
  );
}

function order(i: string): number {
  return i === 'CRITICAL' ? 0 : i === 'IMPORTANT' ? 1 : 2;
}
