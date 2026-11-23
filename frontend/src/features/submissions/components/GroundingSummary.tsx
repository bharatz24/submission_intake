// Grounding check results (backend services/grounding.ts): generated evidence whose source or values were not found
// in the submission. A summary for a report, an inline marker per unverified item, and a footnote for chat answers.
// Each pairs an icon with text, so the warning never rests on colour alone.
import SearchOffIcon from '@mui/icons-material/SearchOffOutlined';
import { Alert, Box, Chip, Tooltip, Typography } from '@mui/material';

import type { Grounding, GroundingItem } from '../../../types';

const NOT_FOUND = 'Not found in source';

/** A missing value as the underwriter reads it: "source: x.pdf" → "x.pdf (file not in the submission)", 175000 → 175,000. */
export function describeMissing(value: string): string {
  if (value.startsWith('source: ')) return `${value.slice('source: '.length)} (file not in the submission)`;
  if (/^\d{4,}(\.\d+)?$/.test(value)) return Number(value).toLocaleString('en-US');
  return value;
}

/** Unverified items by their path in the report content ("extractedFacts[0]"). */
export function unverifiedByPath(grounding: Grounding | null | undefined): Map<string, GroundingItem> {
  return new Map((grounding?.items ?? []).map((i) => [i.path, i]));
}

/** "3 of 41 evidence items not found in the submission"; nothing when everything checked was found. */
export function GroundingSummary({ grounding }: { grounding: Grounding | null | undefined }) {
  if (!grounding || grounding.unverified === 0) return null;
  return (
    <Alert severity="warning" variant="outlined" icon={<SearchOffIcon fontSize="inherit" />} role="status">
      <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
        {grounding.unverified} of {grounding.checked} evidence items not found in the submission
      </Typography>
      <Typography variant="caption" component="p" color="text.secondary">
        Their file or values could not be found in the email, attachments or extracted data. Check them against the
        documents before relying on them; each is marked “{NOT_FOUND}”.
      </Typography>
    </Alert>
  );
}

/**
 * Hidden from sight, read by screen readers (the tooltip is mouse-only). Sizes are strings on purpose: in sx a bare `1`
 * means 100%, which makes the span as wide as its container and the page scroll sideways (QA-002).
 */
const srOnly = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

/** Inline marker on one unverified item; the tooltip (and screen readers) list what was not found. */
export function NotFoundMarker({ item }: { item: GroundingItem | undefined }) {
  if (!item) return null;
  const missing = item.missing.map(describeMissing).join(', ');
  return (
    <Tooltip describeChild title={missing ? `Not found: ${missing}` : NOT_FOUND}>
      <Chip
        size="small"
        color="warning"
        variant="outlined"
        icon={<SearchOffIcon aria-hidden />}
        label={
          <>
            {NOT_FOUND}
            {missing && (
              <Box component="span" sx={srOnly}>
                : {missing}
              </Box>
            )}
          </>
        }
        sx={{ ml: 0.5, verticalAlign: 'middle' }}
      />
    </Tooltip>
  );
}

/** Under a chat answer: the values in it that could not be found in the submission. */
export function GroundingFootnote({ grounding }: { grounding: Grounding | null | undefined }) {
  if (!grounding || grounding.unverified === 0) return null;
  const values = [...new Set(grounding.items.flatMap((i) => i.missing))].map(describeMissing);
  return (
    <Box
      role="note"
      sx={{
        mt: 1,
        pt: 0.75,
        borderTop: 1,
        borderColor: 'divider',
        display: 'flex',
        gap: 0.75,
        alignItems: 'flex-start',
      }}
    >
      <SearchOffIcon fontSize="small" color="warning" aria-hidden sx={{ mt: '1px' }} />
      <Typography variant="caption" color="text.secondary">
        {NOT_FOUND} — not in the submission: {values.join(', ')}. Check these before relying on them.
      </Typography>
    </Box>
  );
}
