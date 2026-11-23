import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  alpha,
  Box,
  Chip,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';

export type Tone = 'primary' | 'error' | 'warning' | 'info' | 'success' | 'secondary';

export const accent = (c: string) => (c === 'default' ? 'divider' : `${c}.main`);

/** Header bar height, and where the header buttons end: left of the expand icon (summary padding + icon + gap). */
const HEADER_MIN_HEIGHT = 40;
const ACTIONS_RIGHT = 48;

/**
 * A full-width, collapsible band: tinted title bar with accent edge and count badge. Open by default.
 * `heading` is the title's heading element: h2 (the default) for a page's sections under its h1 title; h3 when nested in one.
 */
export function Section({
  title,
  tone = 'primary',
  count,
  subtitle,
  defaultOpen = true,
  actions,
  heading = 'h2',
  children,
}: {
  title: ReactNode;
  tone?: Tone;
  count?: number;
  subtitle?: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
  heading?: 'h2' | 'h3';
  children: ReactNode;
}) {
  // Header id + aria-controls: MUI names the content region after the title (unique landmarks for screen readers).
  const id = useId();
  // The header buttons sit over the bar, outside the toggle (a button inside a button is unusable with a keyboard or
  // a screen reader); the title leaves room for them.
  const actionsRef = useRef<HTMLDivElement>(null);
  const [actionsWidth, setActionsWidth] = useState(0);
  useLayoutEffect(() => {
    const el = actionsRef.current;
    if (!el) return;
    const update = () => setActionsWidth(el.offsetWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [actions]);

  return (
    <Box sx={{ position: 'relative', minWidth: 0 }}>
      <Accordion
        variant="outlined"
        defaultExpanded={defaultOpen}
        disableGutters
        slotProps={{ heading: { component: heading } }}
        sx={{
          '&:before': { display: 'none' },
          overflow: 'hidden',
          minWidth: 0,
          // MUI only rounds the first/last accordion in a group; round every band alike so the accent bar's corners match.
          '&, &:first-of-type, &:last-of-type': { borderRadius: 1 },
        }}
      >
        <AccordionSummary
          id={`${id}-header`}
          aria-controls={`${id}-content`}
          expandIcon={<ExpandMoreIcon />}
          sx={{
            borderLeft: 4,
            borderLeftColor: `${tone}.main`,
            bgcolor: (t) => alpha(t.palette[tone].main, 0.1),
            minHeight: HEADER_MIN_HEIGHT,
            '& .MuiAccordionSummary-content': { my: 0.75, mr: actions ? `${actionsWidth + 8}px` : 0, minWidth: 0 },
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
            {/* Already inside the section's heading element: a span, not a nested <h6>. */}
            <Typography
              variant="subtitle2"
              component="span"
              sx={{ fontWeight: 700, letterSpacing: 0.2, color: `${tone}.dark` }}
            >
              {title}
            </Typography>
            {count !== undefined && (
              <Chip
                size="small"
                color={tone}
                label={count}
                sx={{ height: 20, minWidth: 24, fontWeight: 700, fontSize: '0.72rem' }}
              />
            )}
          </Stack>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 1.5 }}>
          {subtitle && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
              {subtitle}
            </Typography>
          )}
          {children}
        </AccordionDetails>
      </Accordion>
      {actions && (
        <Stack
          ref={actionsRef}
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ position: 'absolute', top: 0, right: ACTIONS_RIGHT, height: HEADER_MIN_HEIGHT }}
        >
          {actions}
        </Stack>
      )}
    </Box>
  );
}

/** One slim line for a section with nothing in it, instead of a mostly empty card. */
export function SlimEmpty({ title, tone, text }: { title: string; tone: Tone; text: string }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        px: 1.5,
        py: 0.75,
        borderLeft: 4,
        borderLeftColor: `${tone}.main`,
        bgcolor: (t) => alpha(t.palette[tone].main, 0.04),
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Typography variant="subtitle2" sx={{ fontWeight: 700, color: `${tone}.dark` }}>
          {title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {text} ✓
        </Typography>
      </Stack>
    </Paper>
  );
}
