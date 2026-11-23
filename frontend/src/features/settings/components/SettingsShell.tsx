import {
  Alert,
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useRef } from 'react';
import { useSearchParams } from 'react-router';

import { Section } from '../../../components/ReportSection';
import { POLL_MS } from '../../../constants';
import { apiWith } from '../../../services/api';
import { ims2Keys, rateKeys } from '../../submissions';
import { ALL_SECTIONS, DEFAULT_SECTION, type SectionKey, SETTINGS_GROUPS } from '../pages/SettingsPage';
import { gmailKeys, settingsKeys, systemKeys } from '../queryKeys';

type Tone = 'success' | 'warning' | 'error';

type SectionStatus = { tone: Tone; text: string };

/** A coloured dot in the rail where a section's state matters, from the queries the sections already use. */
function useSectionStatus(): Partial<Record<SectionKey, SectionStatus>> {
  const gmail = useQuery({
    queryKey: gmailKeys.status(),
    queryFn: ({ signal }) => apiWith(signal).gmailStatus(),
    refetchInterval: POLL_MS.gmailStatusSettings,
  });
  const claude = useQuery({
    queryKey: settingsKeys.anthropic(),
    queryFn: ({ signal }) => apiWith(signal).anthropicSettings(),
  });
  const rates = useQuery({ queryKey: rateKeys.groups(), queryFn: ({ signal }) => apiWith(signal).rateGroups() });
  const system = useQuery({
    queryKey: systemKeys.status(),
    queryFn: ({ signal }) => apiWith(signal).systemStatus(),
    refetchInterval: POLL_MS.systemStatusSettings,
  });
  const ims2 = useQuery({ queryKey: ims2Keys.sync(), queryFn: ({ signal }) => apiWith(signal).ims2QueueSyncInfo() });

  const out: Partial<Record<SectionKey, SectionStatus>> = {};
  const g = gmail.data;
  if (g)
    out.gmail = g.connected
      ? { tone: 'success', text: 'Connected' }
      : !g.configured
        ? { tone: 'warning', text: 'Not set up' }
        : { tone: 'warning', text: 'Off' };
  const c = claude.data;
  if (c)
    out.claude = c.keyError
      ? { tone: 'error', text: 'Key error' }
      : c.keySet
        ? { tone: 'success', text: 'Key set' }
        : { tone: 'warning', text: 'No key' };
  const r = rates.data;
  if (r)
    out.rates = r.groups.some((x) => x.isActive)
      ? { tone: 'success', text: 'Loaded' }
      : { tone: 'warning', text: 'None loaded' };
  const q = ims2.data;
  if (q?.configured) {
    out.ims2 = q.lastSync?.error
      ? { tone: 'error', text: 'Last sync failed' }
      : (q.counts.ERROR ?? 0) + (q.counts.FAILED ?? 0)
        ? { tone: 'warning', text: 'Intakes need attention' }
        : { tone: 'success', text: 'Working' };
  }
  const sys = system.data;
  if (system.isError) out.connections = { tone: 'error', text: 'No answer' };
  else if (sys) {
    const down = sys.services.filter((x) => !x.ok).length;
    out.connections = down ? { tone: 'error', text: `${down} failing` } : { tone: 'success', text: 'All working' };
  }
  return out;
}

const TONE_COLOR: Record<Tone, string> = { success: 'success.main', warning: 'warning.main', error: 'error.main' };

function StatusDot({ status }: { status?: SectionStatus }) {
  if (!status) return null;
  return (
    <Tooltip title={status.text} placement="right">
      <Box
        role="img"
        aria-label={status.text}
        sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: TONE_COLOR[status.tone], flexShrink: 0, ml: 1 }}
      />
    </Tooltip>
  );
}

export function SettingsShell() {
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up('md'));
  const [params, setParams] = useSearchParams();
  const status = useSectionStatus();
  const gmailParam = params.get('gmail');

  const requested = params.get('section') as SectionKey | null;
  const active: SectionKey =
    requested && ALL_SECTIONS.some((s) => s.key === requested) ? requested : gmailParam ? 'gmail' : DEFAULT_SECTION;
  // Every section stays mounted (hidden when not selected) so unsaved edits survive switching sections.
  const panels = ALL_SECTIONS.map((s) => (
    <Box key={s.key} hidden={s.key !== active}>
      {s.render()}
    </Box>
  ));
  const contentRef = useRef<HTMLDivElement>(null);
  const select = (key: SectionKey) => {
    contentRef.current?.scrollTo?.({ top: 0 });
    const n = new URLSearchParams(params);
    n.set('section', key);
    setParams(n, { replace: true });
  };

  const rail = (
    <Box component="nav" aria-label="Settings sections">
      {SETTINGS_GROUPS.map((g, i) => (
        <Box key={g.label} sx={{ mt: i ? 1.5 : 0 }}>
          <Typography sx={{ px: 1.25, pb: 0.25, fontSize: '0.7rem', fontWeight: 600, color: 'text.secondary' }}>
            {g.label}
          </Typography>
          <List dense disablePadding>
            {g.items.map((s) => {
              const on = s.key === active;
              return (
                <ListItem key={s.key} disablePadding>
                  <ListItemButton
                    selected={on}
                    onClick={() => select(s.key)}
                    aria-current={on ? 'page' : undefined}
                    sx={{
                      borderRadius: 1,
                      minHeight: 32,
                      py: 0.25,
                      pl: 1.25,
                      pr: 1,
                      position: 'relative',
                      '&.Mui-selected': { bgcolor: alpha(theme.palette.primary.main, 0.07) },
                      '&.Mui-selected:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) },
                      '&.Mui-selected::before': {
                        content: '""',
                        position: 'absolute',
                        left: 0,
                        top: 7,
                        bottom: 7,
                        width: 3,
                        borderRadius: 2,
                        bgcolor: 'primary.main',
                      },
                    }}
                  >
                    <ListItemIcon
                      sx={{ minWidth: 28, color: on ? 'primary.main' : 'text.secondary', '& svg': { fontSize: 18 } }}
                    >
                      {s.icon}
                    </ListItemIcon>
                    <ListItemText
                      primary={s.label}
                      primaryTypographyProps={{
                        fontSize: '0.8125rem',
                        fontWeight: on ? 600 : 500,
                        color: on ? 'primary.main' : 'text.primary',
                        noWrap: true,
                      }}
                    />
                    <StatusDot status={status[s.key]} />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        </Box>
      ))}
    </Box>
  );

  const banner = gmailParam && (
    <Alert
      severity={gmailParam === 'connected' ? 'success' : 'warning'}
      sx={{ mb: 2 }}
      onClose={() => {
        const n = new URLSearchParams(params);
        n.delete('gmail');
        setParams(n, { replace: true });
      }}
    >
      {gmailParam === 'connected' ? 'Gmail connected. Monitoring starts within a minute.' : `Gmail: ${gmailParam}`}
    </Alert>
  );

  // Wide screens: the page fits the window (below the 56px app bar and the layout's 20px padding top and bottom),
  // so the page itself never scrolls; the section list stays put and only the section on the right scrolls.
  return (
    <Box sx={wide ? { height: 'calc(100dvh - 96px)', display: 'flex', flexDirection: 'column' } : undefined}>
      {banner && <Box sx={{ flexShrink: 0 }}>{banner}</Box>}
      <Paper
        variant="outlined"
        sx={{
          display: 'flex',
          flexDirection: wide ? 'row' : 'column',
          ...(wide ? { flex: 1, minHeight: 0, overflow: 'hidden' } : {}),
        }}
      >
        {wide ? (
          <Box sx={{ width: 212, flexShrink: 0, p: 1.5, borderRight: 1, borderColor: 'divider', overflowY: 'auto' }}>
            {rail}
          </Box>
        ) : (
          // On small screens the rail becomes a scrolling row of tabs and the page scrolls as usual.
          <Tabs
            value={active}
            onChange={(_, v: SectionKey) => select(v)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ borderBottom: 1, borderColor: 'divider', px: 1 }}
          >
            {ALL_SECTIONS.map((s) => (
              <Tab key={s.key} value={s.key} label={s.label} />
            ))}
          </Tabs>
        )}
        <Box
          ref={contentRef}
          sx={{
            flex: 1,
            minWidth: 0,
            px: { xs: 2, md: 4, lg: 5 },
            py: { xs: 2.5, md: 3.5 },
            ...(wide ? { overflowY: 'auto' } : {}),
          }}
        >
          {panels}
        </Box>
      </Paper>
    </Box>
  );
}

/** The body of one settings section: the shared band header, a plain-language description, then the controls. */
export function SettingsPanel({
  title,
  subtitle,
  action,
  fullWidth,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  fullWidth?: boolean;
  children: ReactNode;
}) {
  return (
    // Not labelled itself: the band's content region is named after its title (ReportSection), and a second region with
    // the same name would be a duplicate landmark.
    <Box component="section" sx={{ maxWidth: fullWidth ? 'none' : 820 }}>
      <Section title={title} subtitle={subtitle} actions={action} heading="h2">
        {children}
      </Section>
    </Box>
  );
}
