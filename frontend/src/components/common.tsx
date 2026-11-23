// Small shared UI building blocks: chips, state placeholders, markdown, section cards.
import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import MailIcon from '@mui/icons-material/MailOutline';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import type { ChipProps, TextFieldProps } from '@mui/material';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  InputAdornment,
  Link,
  Paper,
  Skeleton,
  Stack,
  TableCell,
  TableSortLabel,
  TextField,
  Typography,
} from '@mui/material';
import {
  type ChangeEvent,
  createContext,
  forwardRef,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { LOADING_MESSAGES } from '../constants';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { gmailMessageUrl, splitLinks } from '../lib/links';
import { nextSort, type SortOrder, type SortState } from '../lib/sort';
import type { ChipColor } from '../lib/status';
import { formatDate, parseUsDate } from '../lib/status';
import { humanize } from '../lib/status';
import { errorMessage } from '../services/api';
import { ExternalAnchor, NEW_TAB, safeMarkdownUrl } from './ExternalAnchor';
import type { MarkdownProps } from './MarkdownContent';
import type { Tone } from './ReportSection';
import { Section } from './ReportSection';

export function EnumChip({
  value,
  color,
  label,
  size = 'small',
  variant,
  title,
  icon,
}: {
  value: string | null | undefined;
  color: ChipColor;
  label?: string;
  size?: ChipProps['size'];
  variant?: ChipProps['variant'];
  title?: string;
  icon?: ChipProps['icon'];
}) {
  if (!value)
    return (
      <Typography component="span" variant="body2" color="text.disabled">
        —
      </Typography>
    );
  return (
    <Chip
      size={size}
      color={color}
      icon={icon}
      variant={variant ?? (color === 'default' ? 'outlined' : 'filled')}
      label={label ?? humanize(value)}
      title={title}
      sx={{ maxWidth: '100%' }}
    />
  );
}

/** How long a load runs before the loader says it is taking a while. */
const SLOW_LOAD_MS = 10_000;

/** The layout a loading placeholder takes, matching what will appear in its place. */
export type LoadingShape = 'text' | 'table' | 'list' | 'form' | 'chat' | 'cards' | 'document' | 'page';

// Varied widths (percent) so placeholder lines read as text, not a grid of bars.
const LINE_WIDTHS = [96, 88, 92, 74, 85, 68, 90, 80];
const w = (i: number, less = 0) => `${(LINE_WIDTHS[i % LINE_WIDTHS.length] ?? 90) - less}%`;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const SHAPES: Record<LoadingShape, (rows: number) => ReactNode> = {
  text: (rows) => (
    <>
      <Skeleton width="35%" height={26} sx={{ mb: 0.5 }} />
      {range(rows + 1).map((i) => (
        <Skeleton key={i} width={w(i)} height={18} />
      ))}
    </>
  ),
  table: (rows) => (
    <>
      <Stack direction="row" spacing={2} sx={{ pb: 1, borderBottom: 1, borderColor: 'divider' }}>
        {range(4).map((c) => (
          <Skeleton key={c} height={16} sx={{ flex: c === 1 ? 3 : 1 }} />
        ))}
      </Stack>
      {range(rows).map((r) => (
        <Stack key={r} direction="row" spacing={2} sx={{ py: 1, borderBottom: 1, borderColor: 'divider' }}>
          {range(4).map((c) => (
            <Box key={c} sx={{ flex: c === 1 ? 3 : 1 }}>
              <Skeleton height={18} width={w(r + c)} />
            </Box>
          ))}
        </Stack>
      ))}
    </>
  ),
  list: (rows) =>
    range(Math.max(2, Math.ceil(rows * 0.75))).map((r) => (
      <Stack
        key={r}
        direction="row"
        spacing={1.5}
        alignItems="center"
        sx={{ py: 1, borderBottom: 1, borderColor: 'divider' }}
      >
        <Skeleton variant="circular" width={28} height={28} sx={{ flexShrink: 0 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Skeleton height={18} width={w(r, 30)} />
          <Skeleton height={14} width={w(r + 3, 45)} />
        </Box>
      </Stack>
    )),
  form: (rows) =>
    range(Math.max(2, Math.ceil(rows / 1.5))).map((r) => (
      <Box key={r} sx={{ mb: 1.75 }}>
        <Skeleton height={14} width={`${18 + (r % 3) * 6}%`} sx={{ mb: 0.5 }} />
        <Skeleton variant="rounded" height={40} width={r % 2 ? '70%' : '100%'} />
      </Box>
    )),
  chat: (rows) =>
    range(Math.max(2, Math.ceil(rows / 1.5))).map((r) => (
      <Box key={r} sx={{ display: 'flex', justifyContent: r % 2 ? 'flex-end' : 'flex-start', mb: 1.25 }}>
        <Skeleton variant="rounded" height={r % 2 ? 40 : 64} width={r % 2 ? '55%' : '75%'} sx={{ borderRadius: 2 }} />
      </Box>
    )),
  cards: () => (
    <>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 1.5, mb: 1.5 }}>
        {range(4).map((i) => (
          <Skeleton key={i} variant="rounded" height={84} />
        ))}
      </Box>
      <Skeleton variant="rounded" height={220} />
    </>
  ),
  document: () => (
    <Box
      sx={{
        width: 'min(720px, 90vw)',
        p: 3,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.paper',
      }}
    >
      <Skeleton width="50%" height={28} sx={{ mb: 1.5 }} />
      {range(10).map((i) => (
        <Skeleton key={i} width={w(i)} height={16} />
      ))}
      <Skeleton variant="rounded" height={140} sx={{ my: 2 }} />
      {range(5).map((i) => (
        <Skeleton key={i} width={w(i + 2)} height={16} />
      ))}
    </Box>
  ),
  page: (rows) => (
    <>
      <Skeleton variant="rounded" height={56} sx={{ mb: 2 }} />
      <Skeleton width={260} height={34} sx={{ mb: 1.5 }} />
      {range(rows).map((i) => (
        <Skeleton key={i} width={w(i)} height={18} />
      ))}
    </>
  ),
};

/**
 * Placeholder shapes in the layout of what is loading, so content fills in where it will stand instead of replacing
 * a centred message. Screen readers hear `label`; after a while it says the load is taking longer than usual.
 */
export function Loading({
  label = 'Loading…',
  minHeight = 160,
  shape = 'text',
}: {
  label?: string;
  minHeight?: number;
  shape?: LoadingShape;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(t);
  }, []);
  const rows = Math.max(2, Math.round(minHeight / 40));
  return (
    <Box
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label.replace(/(…|\.\.\.)$/, '')}
      sx={{ minHeight, py: 1, width: shape === 'document' ? undefined : '100%' }}
    >
      {SHAPES[shape](rows)}
      {slow && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {LOADING_MESSAGES.slow}
        </Typography>
      )}
    </Box>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = 'Something went wrong',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <Alert
      severity="error"
      variant="outlined"
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      <AlertTitle>{title}</AlertTitle>
      {errorMessage(error)}
    </Alert>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={1}
      sx={{ py: 5, px: 2, textAlign: 'center', color: 'text.secondary' }}
    >
      <Box sx={{ color: 'text.disabled', '& svg': { fontSize: 40 } }}>{icon ?? <InboxOutlinedIcon />}</Box>
      <Typography variant="subtitle1" color="text.primary">
        {title}
      </Typography>
      {description && (
        <Typography variant="body2" sx={{ maxWidth: 480 }}>
          {description}
        </Typography>
      )}
      {action}
    </Stack>
  );
}

/** Grid item sx whose card stretches to the row height, so side-by-side cards line up top and bottom. */
export const fillCell = { display: 'flex', '& > *': { flex: 1 } } as const;

const BandsContext = createContext(false);
/** Inside this wrapper every SectionCard renders as a full-width collapsible band, matching the Analysis tab. */
export function SectionBands({ children }: { children: ReactNode }) {
  return <BandsContext.Provider value>{children}</BandsContext.Provider>;
}

export function SectionCard({
  title,
  subtitle,
  actions,
  children,
  dense,
  tone = 'primary',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  dense?: boolean;
  tone?: Tone;
}) {
  const band = useContext(BandsContext);
  if (band)
    return (
      <Section title={title} tone={tone} subtitle={subtitle} actions={actions}>
        {children}
      </Section>
    );
  return (
    <Paper variant="outlined" sx={{ p: dense ? 1.5 : 2 }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1} sx={{ mb: 1.25 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1">{title}</Typography>
          {subtitle && (
            <Typography variant="caption" color="text.secondary">
              {subtitle}
            </Typography>
          )}
        </Box>
        {actions && (
          <Stack direction="row" spacing={1} flexShrink={0}>
            {actions}
          </Stack>
        )}
      </Stack>
      {children}
    </Paper>
  );
}

/** Asks the user to confirm an action. Stays open with the error while `busy` or after a failed `onConfirm`. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  busy,
  error,
  tone = 'error',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: unknown;
  /** `error` for destructive actions, `primary` for a plain "are you sure". */
  tone?: 'error' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onClose={() => !busy && onCancel()} fullWidth maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {error != null && <Alert severity="error">{errorMessage(error)}</Alert>}
          <DialogContentText component="div">{message}</DialogContentText>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button color={tone} variant="contained" onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="overline" sx={{ fontSize: '0.65rem', lineHeight: 1.6, display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ wordBreak: 'break-word' }}>
        {value === null || value === undefined || value === '' ? (
          <Box component="span" color="text.disabled">
            —
          </Box>
        ) : (
          value
        )}
      </Typography>
    </Box>
  );
}

/**
 * Markdown from generated text (reports, drafts, chat). The renderer is its own chunk, loaded the first time a
 * screen shows markdown (FE-05): the sign-in page and the shell never download react-markdown. `innerRef` reaches
 * the rendered block once it has loaded.
 */
export function Markdown(props: MarkdownProps) {
  return (
    <Suspense fallback={<Loading label="Loading text…" minHeight={80} />}>
      <LazyMarkdownContent {...props} />
    </Suspense>
  );
}

const LazyMarkdownContent = lazy(() => import('./MarkdownContent').then((m) => ({ default: m.MarkdownContent })));

/** Starts loading the markdown renderer ahead of time (a screen about to show a report can call it on mount). */
export const preloadMarkdown = () => import('./MarkdownContent');

export { ExternalAnchor, safeMarkdownUrl };

/** Opens the submission's original email in Gmail; renders nothing for manual-intake submissions. */
export function GmailButton({
  messageId,
  variant = 'text',
}: {
  messageId: string | null | undefined;
  variant?: 'text' | 'outlined';
}) {
  if (!messageId) return null;
  return (
    <Button
      size="small"
      variant={variant}
      component="a"
      href={gmailMessageUrl(messageId)}
      {...NEW_TAB}
      title="Open the original email in Gmail (new tab)"
      startIcon={<MailIcon />}
      endIcon={<OpenInNewIcon sx={{ fontSize: '0.9rem !important' }} />}
      sx={{ whiteSpace: 'nowrap' }}
    >
      Email
    </Button>
  );
}

/** Plain text with valid NPIs linked to the NPPES registry and emails as mailto links. */
export function Linkify({ children }: { children?: ReactNode }) {
  if (typeof children !== 'string') return <>{children}</>;
  return (
    <>
      {splitLinks(children).map((seg, i) =>
        !seg.href ? (
          seg.text
        ) : (
          <Link key={i} href={seg.href} underline="hover" {...(seg.href.startsWith('http') ? NEW_TAB : {})}>
            {seg.text}
          </Link>
        ),
      )}
    </>
  );
}

/**
 * A page's title row. The title is the page's h1 (focused by Layout after a navigation, so screen readers announce
 * the new page) and, when it is plain text, the browser tab's name; pass `documentTitle` when the title is not.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  documentTitle,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  documentTitle?: string;
}) {
  useDocumentTitle(documentTitle ?? (typeof title === 'string' ? title : null));
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      alignItems={{ xs: 'flex-start', sm: 'center' }}
      justifyContent="space-between"
      spacing={1.5}
      sx={{ mb: 2 }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h5" component="h1" tabIndex={-1} data-page-title sx={{ '&:focus': { outline: 'none' } }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}

/** Sortable header cell; numeric and time columns pass first="desc" so the first click shows largest/newest. */
export function SortCell<K extends string>({
  k,
  sort,
  onSort,
  first = 'asc',
  align,
  children,
}: {
  k: K;
  sort: SortState<K>;
  onSort: (next: SortState<K>) => void;
  first?: SortOrder;
  align?: 'right';
  children: ReactNode;
}) {
  const active = sort.key === k;
  return (
    <TableCell align={align} sortDirection={active ? sort.order : false}>
      <TableSortLabel
        active={active}
        direction={active ? sort.order : first}
        onClick={() => onSort(nextSort(sort, k, first))}
      >
        {children}
      </TableSortLabel>
    </TableCell>
  );
}

/**
 * A date typed and shown as MM/DD/YYYY whatever the browser's locale (a native date input follows the OS region),
 * with a calendar button. `value` / `onChange` carry ISO "YYYY-MM-DD"; an empty or unfinished entry is null.
 */
export function UsDateField({
  value,
  onChange,
  helperText,
  error,
  ...props
}: Omit<TextFieldProps, 'value' | 'onChange' | 'type'> & {
  value: string | null | undefined;
  onChange: (iso: string | null) => void;
}) {
  const toText = (v: string | null | undefined) => (v ? formatDate(v) : '');
  const [text, setText] = useState(() => toText(value));
  const picker = useRef<HTMLInputElement>(null);
  // Follow outside changes (reset, prefill) without wiping a half-typed entry.
  useEffect(() => {
    if ((parseUsDate(text) ?? null) !== (value || null) && !(value == null && text !== '' && !parseUsDate(text)))
      setText(toText(value));
    // Only a new `value` from outside resyncs the box; `text` is read, not watched, or each keystroke would be
    // overwritten by the last committed date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const type = (raw: string) => {
    const d = raw.replace(/\D/g, '').slice(0, 8);
    const masked =
      d.length > 4
        ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`
        : d.length > 2
          ? `${d.slice(0, 2)}/${d.slice(2)}`
          : d;
    setText(masked);
    onChange(parseUsDate(masked));
  };
  const bad = text.length === 10 && !parseUsDate(text);

  return (
    <TextField
      {...props}
      value={text}
      placeholder="MM/DD/YYYY"
      error={error || bad}
      helperText={bad ? 'Not a real date. Use MM/DD/YYYY.' : helperText}
      onChange={(e) => type(e.target.value)}
      InputLabelProps={{ shrink: true, ...props.InputLabelProps }}
      inputProps={{ inputMode: 'numeric', maxLength: 10, ...props.inputProps }}
      InputProps={{
        ...props.InputProps,
        endAdornment: (
          <InputAdornment position="end" sx={{ position: 'relative' }}>
            <IconButton
              size="small"
              edge="end"
              aria-label="Pick a date"
              disabled={props.disabled}
              onClick={() => {
                try {
                  picker.current?.showPicker();
                } catch {
                  picker.current?.focus();
                }
              }}
            >
              <CalendarMonthOutlinedIcon fontSize="small" />
            </IconButton>
            <Box
              component="input"
              ref={picker}
              type="date"
              tabIndex={-1}
              aria-hidden
              value={value ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const iso = e.target.value || null;
                setText(toText(iso));
                onChange(iso);
              }}
              sx={{
                position: 'absolute',
                right: 0,
                bottom: 0,
                width: 1,
                height: 1,
                opacity: 0,
                border: 0,
                p: 0,
                pointerEvents: 'none',
              }}
            />
          </InputAdornment>
        ),
      }}
    />
  );
}

/**
 * A password or secret input with an eye button that shows / hides what was typed. Takes every TextField prop
 * except `type`, and forwards its ref so react-hook-form's `register` works. The button keeps focus in the input.
 */
export const PasswordField = forwardRef<HTMLDivElement, Omit<TextFieldProps, 'type'>>(
  function PasswordField(props, ref) {
    const [shown, setShown] = useState(false);
    return (
      <TextField
        {...props}
        ref={ref}
        type={shown ? 'text' : 'password'}
        InputProps={{
          ...props.InputProps,
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                size="small"
                edge="end"
                aria-label={shown ? 'Hide password' : 'Show password'}
                aria-pressed={shown}
                disabled={props.disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShown((v) => !v)}
              >
                {shown ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
              </IconButton>
            </InputAdornment>
          ),
        }}
      />
    );
  },
);
