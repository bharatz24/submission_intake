// Instruction-like text found in the email or attachments (backend services/injectionFlags.ts). The submission is
// processed as usual and the model is told not to follow that text; this banner tells the underwriter where it is.
// Not dismissable: it lasts as long as the flags do.
import GppMaybeIcon from '@mui/icons-material/GppMaybeOutlined';
import { Alert, AlertTitle, Box, Typography } from '@mui/material';

import type { InjectionCategory, InjectionFlag } from '../../../types';

const CATEGORY_LABEL: Record<InjectionCategory, string> = {
  override: 'Tells the AI to ignore its instructions',
  role: 'Tries to give the AI a new role',
  ai_address: 'Addressed to an AI',
  steering: 'Asks for a particular outcome',
  exfiltration: 'Asks the AI to reveal its instructions',
  hidden_text: 'Hidden characters',
};

export function InjectionBanner({ flags }: { flags: InjectionFlag[] | undefined }) {
  if (!flags?.length) return null;
  const sources = [...new Set(flags.map((f) => f.source))];
  return (
    <Alert severity="warning" icon={<GppMaybeIcon fontSize="inherit" />} role="status" sx={{ mb: 1.5 }}>
      <AlertTitle>Instruction-like text found in {sources.join(', ')}</AlertTitle>
      <Typography variant="body2" sx={{ mb: 0.5 }}>
        Text in this submission reads like instructions to an AI. Claude was told not to follow it; review the reports
        with this in mind.
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {flags.map((f) => (
          <li key={f.id}>
            <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
              {f.source}
            </Typography>
            <Typography variant="body2" component="span">
              {' '}
              ({CATEGORY_LABEL[f.category] ?? f.category}): “{f.excerpt}”
            </Typography>
          </li>
        ))}
      </Box>
    </Alert>
  );
}
