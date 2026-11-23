import {
  Box,
  Button,
  Chip,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { EmptyState, ErrorState, Loading } from '../../../components/common';
import { STALE_MS } from '../../../constants';
import { apiWith } from '../../../services/api';
import type { SkillEvalStatus, SkillInfo } from '../../../types';
import { skillKeys } from '../queryKeys';
import { SettingsPanel } from './SettingsShell';

// The editor pulls in CodeMirror; load it only when a skill is opened.
const SkillEditorDialog = lazy(() => import('./SkillEditorDialog').then((m) => ({ default: m.SkillEditorDialog })));

// ------------------------------------------------------------------ Settings (/settings)

export function SkillsCard() {
  const { user } = useAuth();
  const skills = useQuery({
    queryKey: skillKeys.all(),
    queryFn: ({ signal }) => apiWith(signal).skills(),
    staleTime: STALE_MS.skills,
  });
  const [open, setOpen] = useState<string | null>(null);
  const openSkill: SkillInfo | undefined = skills.data?.find((sk) => sk.name === open);
  return (
    <SettingsPanel
      title="Skills"
      fullWidth
      subtitle="Versioned instructions Claude follows for each task. Edits here override the shipped files and create a new skill version."
    >
      {openSkill && (
        <Suspense fallback={<LinearProgress sx={{ mb: 1 }} />}>
          <SkillEditorDialog skill={openSkill} onClose={() => setOpen(null)} />
        </Suspense>
      )}
      {skills.isLoading ? (
        <Loading label="Loading skills…" shape="table" />
      ) : skills.isError ? (
        <ErrorState error={skills.error} onRetry={() => skills.refetch()} />
      ) : !skills.data?.length ? (
        <EmptyState title="No skills found" description="The backend did not report any skills." />
      ) : (
        <List dense disablePadding>
          {skills.data.map((sk) => (
            <ListItem key={sk.name} divider sx={{ alignItems: 'flex-start', px: 0 }}>
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="body2" fontWeight={600}>
                      {sk.name}
                    </Typography>
                    <Chip size="small" variant="outlined" label={`v${sk.version}`} />
                    {sk.overridden.length > 0 && (
                      <Chip size="small" color="warning" variant="outlined" label="edited in Settings" />
                    )}
                    {sk.eval && <EvalChip status={sk.eval} />}
                    <Box sx={{ flexGrow: 1 }} />
                    <Button size="small" onClick={() => setOpen(sk.name)}>
                      {hasPermission(user, 'skill:edit') ? 'View / Edit' : 'View'}
                    </Button>
                  </Stack>
                }
                secondary={
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                    {sk.files.map((f) => (
                      <Chip
                        key={f}
                        size="small"
                        label={f}
                        color={sk.overridden.includes(f) ? 'warning' : 'default'}
                        variant={sk.overridden.includes(f) ? 'outlined' : 'filled'}
                        sx={{ fontFamily: 'ui-monospace, Consolas, monospace', fontWeight: 400 }}
                      />
                    ))}
                  </Stack>
                }
                secondaryTypographyProps={{ component: 'div' }}
              />
            </ListItem>
          ))}
        </List>
      )}
    </SettingsPanel>
  );
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * The eval evidence for a skill the eval set covers: the committed baseline's scores, and whether they were recorded
 * for the version in use. An edit made in Settings is a new version no eval has seen: run `npm run eval`.
 */
function EvalChip({ status }: { status: SkillEvalStatus }) {
  const { baseline, latest, baselineCurrent } = status;
  if (!baseline) {
    return (
      <Tooltip title="No eval baseline has been recorded for this skill yet (backend/evals, npm run eval -- --update-baseline).">
        <Chip size="small" variant="outlined" label="not evaluated" />
      </Tooltip>
    );
  }
  const s = baseline.scores;
  const scores = `classification ${pct(s.classificationAccuracy)} · field recall ${pct(s.fieldRecall)} · evidence ${pct(s.evidenceRate)}`;
  const last = latest?.ranAt
    ? ` Last local run ${latest.ranAt.slice(0, 10)}: classification ${pct(latest.scores.classificationAccuracy)}, recall ${pct(latest.scores.fieldRecall)}.`
    : '';
  return (
    <Tooltip
      title={`Eval baseline (v${baseline.skillVersion ?? '?'}${baseline.model ? `, ${baseline.model}` : ''}): ${scores}.${last}${baselineCurrent ? '' : ' The version in use has not been evaluated: run npm run eval before relying on it.'}`}
    >
      <Chip
        size="small"
        variant="outlined"
        color={baselineCurrent ? 'success' : 'warning'}
        label={baselineCurrent ? `eval ${pct(s.classificationAccuracy)} / ${pct(s.fieldRecall)}` : 'eval out of date'}
      />
    </Tooltip>
  );
}

// ------------------------------------------------------------------ Monitoring (/monitoring)
