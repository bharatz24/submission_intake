import AutoModeIcon from '@mui/icons-material/AutoModeOutlined';
import CableIcon from '@mui/icons-material/CableOutlined';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweepOutlined';
import HistoryIcon from '@mui/icons-material/HistoryOutlined';
import MailIcon from '@mui/icons-material/MailOutline';
import NotificationsIcon from '@mui/icons-material/NotificationsNoneOutlined';
import PsychologyIcon from '@mui/icons-material/PsychologyOutlined';
import SyncIcon from '@mui/icons-material/Sync';
import TableChartIcon from '@mui/icons-material/TableChartOutlined';
import TuneIcon from '@mui/icons-material/TuneOutlined';
import KeyIcon from '@mui/icons-material/VpnKeyOutlined';
import { Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { useSearchParams } from 'react-router';

import { AnthropicCard } from '../components/AnthropicCard';
import { AutomationCard } from '../components/AutomationCard';
import { ConnectionsCard, Ims2IntakeSyncCard } from '../components/ConnectionsCard';
import { GMAIL_OAUTH_CHANNEL, GmailCard } from '../components/GmailCard';
import { GmailImportCard } from '../components/GmailImportCard';
import { LimitsCard } from '../components/LimitsCard';
import { NotificationsCard } from '../components/NotificationsCard';
import { RatesCard } from '../components/RatesCard';
import { RetentionCard } from '../components/RetentionCard';
import { SettingsShell } from '../components/SettingsShell';
import { SkillsCard } from '../components/SkillsCard';
import { gmailKeys } from '../queryKeys';

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const gmailParam = params.get('gmail');
  const inPopup = params.get('popup') === '1';

  // Running in the sign-in pop-up after Google redirected back: report the result to the app tab and close.
  useEffect(() => {
    if (!inPopup || !gmailParam) return;
    try {
      const ch = new BroadcastChannel(GMAIL_OAUTH_CHANNEL);
      ch.postMessage({ result: gmailParam });
      ch.close();
    } catch {
      /* no BroadcastChannel: the app tab still refreshes Gmail status when the pop-up closes */
    }
    window.close();
  }, [inPopup, gmailParam]);

  // App tab: show the result of a sign-in that finished in the pop-up.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(GMAIL_OAUTH_CHANNEL);
    ch.onmessage = (e: MessageEvent<{ result: string }>) => {
      const n = new URLSearchParams(window.location.search);
      n.delete('popup');
      n.set('gmail', e.data.result);
      setParams(n, { replace: true });
      qc.invalidateQueries({ queryKey: gmailKeys.status() });
    };
    return () => ch.close();
  }, [qc, setParams]);

  if (inPopup && gmailParam) {
    return <Typography sx={{ p: 3 }}>Gmail sign-in complete. You can close this window.</Typography>;
  }

  return <SettingsShell />;
}

// ---- Settings layout: a rail of sections grouped by topic, one section shown at a time.

export type SectionKey =
  | 'gmail'
  | 'import'
  | 'notifications'
  | 'claude'
  | 'skills'
  | 'automation'
  | 'rates'
  | 'limits'
  | 'ims2'
  | 'connections'
  | 'retention';

type SectionDef = { key: SectionKey; label: string; icon: ReactNode; render: () => ReactNode };

export const SETTINGS_GROUPS: { label: string; items: SectionDef[] }[] = [
  {
    label: 'Mailbox',
    items: [
      { key: 'gmail', label: 'Gmail connection', icon: <MailIcon fontSize="small" />, render: () => <GmailCard /> },
      {
        key: 'import',
        label: 'Import older email',
        icon: <HistoryIcon fontSize="small" />,
        render: () => <GmailImportCard />,
      },
    ],
  },
  {
    label: 'You',
    items: [
      {
        key: 'notifications',
        label: 'Notifications',
        icon: <NotificationsIcon fontSize="small" />,
        render: () => <NotificationsCard />,
      },
    ],
  },
  {
    label: 'Claude',
    items: [
      {
        key: 'claude',
        label: 'API key and model',
        icon: <KeyIcon fontSize="small" />,
        render: () => <AnthropicCard />,
      },
      { key: 'skills', label: 'Skills', icon: <PsychologyIcon fontSize="small" />, render: () => <SkillsCard /> },
    ],
  },
  {
    label: 'Processing',
    items: [
      {
        key: 'automation',
        label: 'Automation',
        icon: <AutoModeIcon fontSize="small" />,
        render: () => <AutomationCard />,
      },
      { key: 'rates', label: 'Rate tables', icon: <TableChartIcon fontSize="small" />, render: () => <RatesCard /> },
      { key: 'limits', label: 'Limits', icon: <TuneIcon fontSize="small" />, render: () => <LimitsCard /> },
    ],
  },
  {
    label: 'System',
    items: [
      { key: 'ims2', label: 'IMS 2 intake', icon: <SyncIcon fontSize="small" />, render: () => <Ims2IntakeSyncCard /> },
      {
        key: 'connections',
        label: 'Connections',
        icon: <CableIcon fontSize="small" />,
        render: () => <ConnectionsCard />,
      },
      {
        key: 'retention',
        label: 'Data retention',
        icon: <DeleteSweepIcon fontSize="small" />,
        render: () => <RetentionCard />,
      },
    ],
  },
];

export const ALL_SECTIONS = SETTINGS_GROUPS.flatMap((g) => g.items);

export const DEFAULT_SECTION: SectionKey = 'gmail';
