import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { Box, Chip, Menu, MenuItem, Stack, Typography } from '@mui/material';
import { useState } from 'react';

import { EnumChip } from '../../../components/common';
import { npiRegistryUrl } from '../../../lib/links';
import { humanize, npiStatusColor } from '../../../lib/status';
import type { NpiStatus, NpiVerification } from '../../../types';

const NPI_RANK: NpiStatus[] = ['MATCH', 'PARTIAL_MATCH', 'NOT_VERIFIED', 'ERROR', 'NOT_FOUND', 'MISMATCH'];

export const npiRank = (s: NpiStatus) => NPI_RANK.indexOf(s);

/** Header NPI badge: opens the NPPES registry page, or a menu when the submission has several NPIs. */
export function NpiHeaderChip({ status, verifications }: { status: NpiStatus; verifications: NpiVerification[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const withNpi = verifications.filter((v) => v.npi);
  // Agree with the NPI tab's banner: any one matching NPI verifies the submission (status is the best check).
  const verified = [...withNpi]
    .filter((v) => v.status === 'MATCH' || v.status === 'PARTIAL_MATCH')
    .sort((a, b) => npiRank(a.status) - npiRank(b.status));
  const [only] = withNpi;
  const label =
    withNpi.length === 1
      ? `NPI ${only?.npi}`
      : verified.length
        ? `NPI ${verified[0]?.npi} · matched ${verified.length} of ${withNpi.length}`
        : `NPI: ${status.replace('_', ' ').toLowerCase()}`;
  const common = {
    size: 'small' as const,
    variant: 'outlined' as const,
    color: npiStatusColor(status),
    label: (
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
        {label}
        <OpenInNewIcon sx={{ fontSize: '0.85rem' }} />
      </Box>
    ),
  };
  if (withNpi.length === 0)
    return <EnumChip value={status} color={npiStatusColor(status)} variant="outlined" label={label} />;
  if (withNpi.length === 1 && only?.npi) {
    return (
      <Chip
        {...common}
        clickable
        component="a"
        href={npiRegistryUrl(only.npi)}
        target="_blank"
        rel="noopener noreferrer"
        title={`${humanize(only.status)} · open in the NPPES NPI Registry`}
      />
    );
  }
  return (
    <>
      <Chip
        {...common}
        clickable
        onClick={(e) => setAnchor(e.currentTarget)}
        title="Open an NPI in the NPPES NPI Registry"
      />
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {withNpi.map((v) => (
          <MenuItem
            key={v.id}
            component="a"
            href={npiRegistryUrl(v.npi)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setAnchor(null)}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" sx={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>
                {v.npi}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {v.registryName ?? v.claimedName ?? ''}
              </Typography>
              <EnumChip value={v.status} color={npiStatusColor(v.status)} />
            </Stack>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
