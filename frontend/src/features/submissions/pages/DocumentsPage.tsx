import DescriptionIcon from '@mui/icons-material/DescriptionOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Box,
  Button,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useSearchParams } from 'react-router';

import { EmptyState } from '../../../components/common';
import { paths } from '../../../paths';

/**
 * Reference documents shipped as static files under public/docs. Add an entry here to list a new one, with `scripts`
 * true only if its HTML has a <script> (DocumentsPage.test.tsx checks the flag against the file).
 */
export const DOCUMENTS = [
  {
    id: 'ims2-new-submission-workflow-v53',
    group: 'Workflow',
    title: 'IMS 2 New Submission Workflow v53',
    subtitle: 'Email triage',
    src: '/docs/ims2-new-submission-workflow-v53.html',
    // Its workflow diagram is animated by an inline script.
    scripts: true,
  },
  {
    id: 'email-triage-ims2-intake-implemented-2026-11-03',
    group: 'Workflow',
    title: 'Email Triage → IMS 2 Intake',
    subtitle: 'What was implemented · 2026-11-03',
    src: '/docs/email-triage-ims2-intake-implemented-2026-11-03.html',
    scripts: false,
  },
] as const;

type Doc = (typeof DOCUMENTS)[number];

/** Documents grouped for the rail, in the order their groups first appear. */
const DOCUMENT_GROUPS = DOCUMENTS.reduce<{ label: string; items: Doc[] }[]>((acc, d) => {
  const g = acc.find((x) => x.label === d.group);
  if (g) g.items.push(d);
  else acc.push({ label: d.group, items: [d] });
  return acc;
}, []);

// Same layout as Settings: a rail of documents grouped by topic, one document shown at a time.
export function DocumentsPage() {
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up('md'));
  const [params, setParams] = useSearchParams();
  const selected = DOCUMENTS.find((d) => d.id === params.get('doc')) ?? DOCUMENTS[0];
  const select = (id: string) => setParams({ doc: id }, { replace: true });

  const rail = (
    <Box component="nav" aria-label="Documents">
      {DOCUMENT_GROUPS.map((g, i) => (
        <Box key={g.label} sx={{ mt: i ? 1.5 : 0 }}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ px: 1.25, pb: 0.75, mb: 0.5, borderBottom: 1, borderColor: 'divider' }}
          >
            <Typography
              sx={{
                fontSize: '0.68rem',
                fontWeight: 700,
                letterSpacing: 0.8,
                textTransform: 'uppercase',
                color: 'text.secondary',
              }}
            >
              {g.label}
            </Typography>
            <Box
              sx={{
                px: 0.75,
                minWidth: 18,
                height: 18,
                borderRadius: 9,
                display: 'grid',
                placeItems: 'center',
                fontSize: '0.65rem',
                fontWeight: 700,
                color: 'primary.main',
                bgcolor: alpha(theme.palette.primary.main, 0.1),
              }}
            >
              {g.items.length}
            </Box>
          </Stack>
          <List dense disablePadding>
            {g.items.map((d) => {
              const on = d.id === selected?.id;
              return (
                <ListItemButton
                  key={d.id}
                  selected={on}
                  onClick={() => select(d.id)}
                  aria-current={on ? 'page' : undefined}
                  sx={{
                    borderRadius: 1,
                    minHeight: 32,
                    py: 0.5,
                    pl: 1.25,
                    pr: 1,
                    position: 'relative',
                    alignItems: 'flex-start',
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
                    sx={{
                      minWidth: 28,
                      mt: 0.25,
                      color: on ? 'primary.main' : 'text.secondary',
                      '& svg': { fontSize: 18 },
                    }}
                  >
                    <DescriptionIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText
                    sx={{ my: 0 }}
                    primary={d.title}
                    secondary={d.subtitle}
                    primaryTypographyProps={{
                      fontSize: '0.8125rem',
                      fontWeight: on ? 600 : 500,
                      color: on ? 'primary.main' : 'text.primary',
                    }}
                    secondaryTypographyProps={{ fontSize: '0.7rem' }}
                  />
                </ListItemButton>
              );
            })}
          </List>
        </Box>
      ))}
    </Box>
  );

  // Wide screens: the page fits the window (below the 56px app bar and the layout's 20px padding top and bottom),
  // so the page itself never scrolls; the document list stays put and only the document on the right scrolls.
  return (
    <Box sx={wide ? { height: 'calc(100dvh - 96px)', display: 'flex', flexDirection: 'column' } : undefined}>
      <Paper
        variant="outlined"
        sx={{
          display: 'flex',
          flexDirection: wide ? 'row' : 'column',
          ...(wide ? { flex: 1, minHeight: 0, overflow: 'hidden' } : {}),
        }}
      >
        {wide ? (
          <Box sx={{ width: 240, flexShrink: 0, p: 1.5, borderRight: 1, borderColor: 'divider', overflowY: 'auto' }}>
            {rail}
          </Box>
        ) : (
          // On small screens the rail becomes a scrolling row of tabs.
          <Tabs
            value={selected?.id ?? false}
            onChange={(_, v: string) => select(v)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ borderBottom: 1, borderColor: 'divider', px: 1 }}
          >
            {DOCUMENTS.map((d) => (
              <Tab key={d.id} value={d.id} label={d.title} />
            ))}
          </Tabs>
        )}
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: { xs: 600, md: 0 } }}>
          {selected ? (
            <>
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                spacing={2}
                sx={{ px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
                    {selected.title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                    {selected.subtitle}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  startIcon={<OpenInNewIcon />}
                  // A raw file with a script would run it on the app's own origin: open this sandboxed viewer instead.
                  href={selected.scripts ? `${paths.documents}?doc=${encodeURIComponent(selected.id)}` : selected.src}
                  target="_blank"
                  rel="noopener"
                  sx={{ flexShrink: 0 }}
                >
                  Open in new tab
                </Button>
              </Stack>
              {/* Sandboxed without allow-same-origin; scripts only for a document that has one, and even then they
                  cannot reach the app's session. */}
              <Box
                component="iframe"
                key={selected.id}
                src={selected.src}
                title={selected.title}
                sandbox={selected.scripts ? 'allow-scripts allow-popups' : 'allow-popups'}
                sx={{ border: 0, width: '100%', flex: 1, minHeight: 0, display: 'block' }}
              />
            </>
          ) : (
            <EmptyState
              title="No documents"
              description={<Typography variant="body2">No documents have been added yet.</Typography>}
            />
          )}
        </Box>
      </Paper>
    </Box>
  );
}
