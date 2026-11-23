import { Box, Grid, Paper, Skeleton, Stack } from '@mui/material';

/**
 * Placeholder shapes in the page's own layout (title, chips, actions, tabs, cards) while the submission loads, so the
 * page fills in where it already stands instead of swapping from a centred message. Screen readers hear the status.
 */
export function SubmissionSkeleton() {
  return (
    <Box role="status" aria-live="polite" aria-busy="true" aria-label="Loading submission">
      <Skeleton width={180} height={18} sx={{ mb: 1 }} />
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.5}
        justifyContent="space-between"
        alignItems={{ md: 'center' }}
        sx={{ mb: 1.5 }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Skeleton variant="text" sx={{ fontSize: '1.6rem', width: { xs: '80%', md: 360 } }} />
          <Stack direction="row" spacing={0.75} sx={{ mt: 0.5 }}>
            {[96, 110, 80, 72].map((w) => (
              <Skeleton key={w} variant="rounded" width={w} height={24} sx={{ borderRadius: 4 }} />
            ))}
          </Stack>
          <Skeleton width={260} height={16} sx={{ mt: 0.5 }} />
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
          <Skeleton variant="rounded" width={128} height={36} />
          <Skeleton variant="rounded" width={118} height={36} />
        </Stack>
      </Stack>
      <Paper variant="outlined" sx={{ mb: 2, px: 2, py: 1.25 }}>
        <Stack direction="row" spacing={3}>
          {[72, 84, 64, 76, 70].map((w, i) => (
            <Skeleton key={i} width={w} height={22} />
          ))}
        </Stack>
      </Paper>
      <Grid container spacing={2}>
        {[0, 1].map((i) => (
          <Grid key={i} item xs={12} md={6}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Skeleton width="40%" height={24} sx={{ mb: 1 }} />
              {[100, 92, 96, 70].map((w, j) => (
                <Skeleton key={j} width={`${w}%`} height={18} />
              ))}
            </Paper>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
