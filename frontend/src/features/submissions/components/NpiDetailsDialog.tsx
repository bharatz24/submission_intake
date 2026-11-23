import {
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { EnumChip, KeyValue } from '../../../components/common';
import { npiRegistryUrl } from '../../../lib/links';
import { formatDateTime, npiStatusColor } from '../../../lib/status';
import type { NpiVerification } from '../../../types';

/** Full CMS NPI Registry record stored with a verification (registry_data). */
interface Registry {
  number?: string;
  enumeration_type?: string;
  basic?: Record<string, string | undefined>;
  addresses?: Record<string, string | undefined>[];
  practiceLocations?: Record<string, string | undefined>[];
  taxonomies?: {
    code?: string;
    desc?: string;
    state?: string;
    license?: string;
    primary?: boolean;
    taxonomy_group?: string;
  }[];
  identifiers?: { code?: string; desc?: string; identifier?: string; state?: string; issuer?: string }[];
  other_names?: Record<string, string | undefined>[];
  endpoints?: Record<string, string | undefined>[];
}

const mono = { fontFamily: 'ui-monospace, Consolas, monospace' };

function formatAddress(a: Record<string, string | undefined>): string {
  const zip =
    a.postal_code && a.postal_code.length === 9
      ? `${a.postal_code.slice(0, 5)}-${a.postal_code.slice(5)}`
      : a.postal_code;
  return [
    a.address_1,
    a.address_2,
    [a.city, a.state, zip].filter(Boolean).join(' '),
    a.country_code !== 'US' ? a.country_name : null,
  ]
    .filter(Boolean)
    .join(', ');
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle2">{title}</Typography>
        {count !== undefined && <Chip size="small" label={count} />}
      </Stack>
      {children}
    </Box>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            {head.map((h) => (
              <TableCell key={h}>{h}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((c, j) => (
                <TableCell key={j}>{c ?? '—'}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function NpiDetailsDialog({ v, open, onClose }: { v: NpiVerification; open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [showRaw, setShowRaw] = useState(false);
  const r = (v.registryData ?? null) as Registry | null;
  const b = r?.basic ?? {};
  const isOrg = r?.enumeration_type === 'NPI-2';
  const addresses = r?.addresses ?? [];
  const locations = r?.practiceLocations ?? [];
  const taxonomies = r?.taxonomies ?? [];
  const identifiers = r?.identifiers ?? [];
  const otherNames = r?.other_names ?? [];
  const endpoints = r?.endpoints ?? [];

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" fullScreen={fullScreen} scroll="paper">
      <DialogTitle>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Box component="span" sx={mono}>
            {v.npi ? `NPI ${v.npi}` : 'NPI not on file'}
          </Box>
          <EnumChip value={v.status} color={npiStatusColor(v.status)} />
          {b.status && (
            <Chip
              size="small"
              variant="outlined"
              color={b.status === 'A' ? 'success' : 'error'}
              label={b.status === 'A' ? 'Active' : b.status === 'D' ? 'Deactivated' : b.status}
            />
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          CMS NPI Registry record fetched {formatDateTime(v.verifiedAt)}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        {!r ? (
          <Typography color="text.secondary">
            No registry record was stored for this check (
            {v.status === 'NOT_FOUND'
              ? 'NPI not found in the registry'
              : v.status === 'NOT_VERIFIED'
                ? 'no single registry record matched the name, ZIP and specialty'
                : 'registry lookup failed'}
            ).
          </Typography>
        ) : (
          <Stack spacing={3}>
            <Section title={isOrg ? 'Organization' : 'Provider'}>
              <Grid container spacing={1.5}>
                {isOrg ? (
                  <>
                    <Grid item xs={12} sm={6}>
                      <KeyValue label="Organization name" value={b.organization_name} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <KeyValue label="Subpart" value={b.organizational_subpart} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <KeyValue label="Type" value="Organization (NPI-2)" />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <KeyValue
                        label="Authorized official"
                        value={
                          [b.authorized_official_first_name, b.authorized_official_last_name]
                            .filter(Boolean)
                            .join(' ') || null
                        }
                      />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <KeyValue label="Official title" value={b.authorized_official_title_or_position} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <KeyValue label="Official phone" value={b.authorized_official_telephone_number} />
                    </Grid>
                  </>
                ) : (
                  <>
                    <Grid item xs={12} sm={6}>
                      <KeyValue
                        label="Name"
                        value={
                          [b.name_prefix, b.first_name, b.middle_name, b.last_name, b.name_suffix]
                            .filter(Boolean)
                            .join(' ') || null
                        }
                      />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <KeyValue label="Credential" value={b.credential} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <KeyValue label="Type" value="Individual (NPI-1)" />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <KeyValue label="Sex" value={b.sex ?? b.gender} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <KeyValue label="Sole proprietor" value={b.sole_proprietor} />
                    </Grid>
                  </>
                )}
                <Grid item xs={6} sm={3}>
                  <KeyValue label="Enumeration date" value={b.enumeration_date} />
                </Grid>
                <Grid item xs={6} sm={3}>
                  <KeyValue label="Last updated" value={b.last_updated} />
                </Grid>
                {b.deactivation_date && (
                  <Grid item xs={6} sm={3}>
                    <KeyValue label="Deactivated" value={b.deactivation_date} />
                  </Grid>
                )}
                {b.reactivation_date && (
                  <Grid item xs={6} sm={3}>
                    <KeyValue label="Reactivated" value={b.reactivation_date} />
                  </Grid>
                )}
              </Grid>
            </Section>

            <Section title="Taxonomies / licenses" count={taxonomies.length}>
              {taxonomies.length ? (
                <SimpleTable
                  head={['Code', 'Description', 'State', 'License', 'Primary']}
                  rows={taxonomies.map((t) => [
                    <Box component="span" sx={mono}>
                      {t.code}
                    </Box>,
                    t.desc,
                    t.state,
                    t.license,
                    t.primary ? <Chip size="small" color="primary" label="Primary" /> : 'No',
                  ])}
                />
              ) : (
                <Typography variant="body2" color="text.secondary">
                  None listed.
                </Typography>
              )}
            </Section>

            <Section title="Addresses" count={addresses.length + locations.length}>
              {addresses.length + locations.length ? (
                <SimpleTable
                  head={['Purpose', 'Address', 'Phone', 'Fax']}
                  rows={[
                    ...addresses,
                    ...locations.map(
                      (l): Record<string, string | undefined> => ({ ...l, address_purpose: 'PRACTICE LOCATION' }),
                    ),
                  ].map((a) => [a.address_purpose, formatAddress(a), a.telephone_number, a.fax_number])}
                />
              ) : (
                <Typography variant="body2" color="text.secondary">
                  None listed.
                </Typography>
              )}
            </Section>

            {identifiers.length > 0 && (
              <Section title="Other identifiers" count={identifiers.length}>
                <SimpleTable
                  head={['Type', 'Identifier', 'State', 'Issuer']}
                  rows={identifiers.map((i) => [
                    i.desc ?? i.code,
                    <Box component="span" sx={mono}>
                      {i.identifier}
                    </Box>,
                    i.state,
                    i.issuer,
                  ])}
                />
              </Section>
            )}

            {otherNames.length > 0 && (
              <Section title="Other names" count={otherNames.length}>
                <SimpleTable
                  head={['Type', 'Name']}
                  rows={otherNames.map((o) => [
                    o.type,
                    o.organization_name ??
                      ([o.prefix, o.first_name, o.middle_name, o.last_name, o.suffix].filter(Boolean).join(' ') ||
                        null),
                  ])}
                />
              </Section>
            )}

            {endpoints.length > 0 && (
              <Section title="Endpoints" count={endpoints.length}>
                <SimpleTable
                  head={['Type', 'Endpoint', 'Use']}
                  rows={endpoints.map((e) => [
                    e.endpointTypeDescription ?? e.endpointType,
                    e.endpoint,
                    e.useDescription ?? e.use,
                  ])}
                />
              </Section>
            )}

            <Box>
              <Button size="small" onClick={() => setShowRaw((x) => !x)}>
                {showRaw ? 'Hide' : 'Show'} raw registry JSON
              </Button>
              <Collapse in={showRaw} unmountOnExit>
                <Box
                  component="pre"
                  sx={{
                    ...mono,
                    fontSize: 12,
                    p: 1.5,
                    mt: 1,
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    overflow: 'auto',
                    maxHeight: 360,
                  }}
                >
                  {JSON.stringify(r, null, 2)}
                </Box>
              </Collapse>
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button component="a" href={npiRegistryUrl(v.npi)} target="_blank" rel="noopener noreferrer">
          Open on CMS site
        </Button>
        <Button variant="contained" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
