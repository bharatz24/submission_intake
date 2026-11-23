import ArticleIcon from '@mui/icons-material/ArticleOutlined';
import GavelIcon from '@mui/icons-material/GavelOutlined';
import InsightsIcon from '@mui/icons-material/InsightsOutlined';
import LayersIcon from '@mui/icons-material/LayersOutlined';
import { Box, Chip, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { EmptyState, EnumChip, ErrorState, Loading, SectionCard } from '../../../components/common';
import { friendlyMessage } from '../../../lib/friendlyError';
import { decisionColor, formatDateTime, humanize, reportStatusColor, riskColor } from '../../../lib/status';
import { apiWith } from '../../../services/api';
import type { VersionsResponse } from '../../../types';
import { submissionKeys } from '../queryKeys';

type Kind = 'CONTEXT' | 'SYNTHESIS' | 'ANALYSIS' | 'ASSESSMENT';
interface Entry {
  key: string;
  kind: Kind;
  at: string;
  title: string;
  body: ReactNode;
  who: string | null;
}

export function mergeVersions(v: VersionsResponse): Entry[] {
  const entries: Entry[] = [];
  for (const c of v.contextVersions ?? []) {
    entries.push({
      key: `ctx-${c.version}`,
      kind: 'CONTEXT',
      at: c.createdAt,
      title: `Context v${c.version}`,
      who: c.createdBy,
      body: (
        <>
          <Typography variant="body2">{c.reason}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>
            snapshot {c.snapshotHash.slice(0, 16)}…
          </Typography>
        </>
      ),
    });
  }
  for (const r of v.reports ?? []) {
    entries.push({
      key: `rep-${r.id}`,
      kind: r.kind,
      at: r.createdAt,
      title: `${humanize(r.kind)} v${r.version}`,
      who: r.createdBy?.name ?? null,
      body: (
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
          <EnumChip value={r.status} color={reportStatusColor(r.status)} />
          <Chip size="small" variant="outlined" label={`${r.skillName} @ ${r.skillVersion}`} />
          <Chip size="small" variant="outlined" label={r.model} />
          <Chip size="small" variant="outlined" label={`context v${r.contextVersion}`} />
          {r.error && (
            <Typography variant="caption" color="error">
              {friendlyMessage(r.error)}
            </Typography>
          )}
        </Stack>
      ),
    });
  }
  for (const a of v.assessments ?? []) {
    entries.push({
      key: `asm-${a.id}`,
      kind: 'ASSESSMENT',
      at: a.createdAt,
      title: `Assessment v${a.version}`,
      who: a.createdBy?.name ?? null,
      body: (
        <Stack spacing={0.5}>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <EnumChip value={a.decision} color={decisionColor(a.decision)} />
            <EnumChip value={a.riskRating} color={riskColor(a.riskRating)} variant="outlined" />
            <Chip size="small" variant="outlined" label={`context v${a.contextVersion}`} />
          </Stack>
          {a.notes && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {a.notes}
            </Typography>
          )}
        </Stack>
      ),
    });
  }
  return entries.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
}

const META: Record<Kind, { icon: ReactNode; color: string; label: string }> = {
  CONTEXT: { icon: <LayersIcon fontSize="small" />, color: 'text.secondary', label: 'Context' },
  SYNTHESIS: { icon: <ArticleIcon fontSize="small" />, color: 'info.main', label: 'Synthesis' },
  ANALYSIS: { icon: <InsightsIcon fontSize="small" />, color: 'accent.analysis', label: 'Analysis' },
  ASSESSMENT: { icon: <GavelIcon fontSize="small" />, color: 'success.main', label: 'Assessment' },
};

export function VersionTimeline({ submissionId }: { submissionId: string }) {
  const [filter, setFilter] = useState<Kind[]>(['CONTEXT', 'SYNTHESIS', 'ANALYSIS', 'ASSESSMENT']);
  const q = useQuery({
    queryKey: submissionKeys.versions(submissionId),
    queryFn: ({ signal }) => apiWith(signal).versions(submissionId),
  });
  if (q.isLoading) return <Loading label="Loading version history…" shape="list" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} title="Could not load versions" />;
  const all = q.data ? mergeVersions(q.data) : [];
  const entries = all.filter((e) => filter.includes(e.kind));

  return (
    <SectionCard
      title="Version timeline"
      subtitle="Context snapshots, report versions and assessments, newest first."
      actions={
        <ToggleButtonGroup size="small" value={filter} onChange={(_, v: Kind[]) => setFilter(v)}>
          {(Object.keys(META) as Kind[]).map((k) => (
            <ToggleButton key={k} value={k}>
              {META[k].label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      }
    >
      {entries.length === 0 ? (
        <EmptyState title="No versions" description="Nothing matches the selected filters." />
      ) : (
        <Box sx={{ position: 'relative', pl: 4 }}>
          <Box sx={{ position: 'absolute', left: 13, top: 6, bottom: 6, width: 2, bgcolor: 'divider' }} />
          {entries.map((e) => (
            <Box key={e.key} sx={{ position: 'relative', mb: 2 }}>
              <Box
                sx={{
                  position: 'absolute',
                  left: -32,
                  top: 0,
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  bgcolor: 'background.paper',
                  border: 2,
                  borderColor: META[e.kind].color,
                  color: META[e.kind].color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {META[e.kind].icon}
              </Box>
              <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                <Typography variant="body2" fontWeight={700}>
                  {e.title}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatDateTime(e.at)}
                  {e.who ? ` · ${e.who}` : ' · system'}
                </Typography>
              </Stack>
              <Box sx={{ mt: 0.5 }}>{e.body}</Box>
            </Box>
          ))}
        </Box>
      )}
    </SectionCard>
  );
}
