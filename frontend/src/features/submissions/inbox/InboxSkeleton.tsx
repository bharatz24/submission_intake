import { Box, Skeleton, Stack } from '@mui/material';

/** Placeholder rows in the table's shape while the first page loads; screen readers hear the status. */
export function InboxSkeleton({ columns, cards }: { columns: number; cards?: boolean }) {
  // Varied widths so the rows read as text, not a grid of bars.
  const widths = [70, 90, 60, 80, 55, 75, 65, 85];
  if (cards)
    return (
      <Stack
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="Loading submissions"
        spacing={1}
        sx={{ pt: 0.5 }}
      >
        {Array.from({ length: 5 }, (_, r) => (
          <Box key={r} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, px: 1.5, py: 1.25 }}>
            <Stack direction="row" spacing={1}>
              <Skeleton height={20} width={`${widths[r % widths.length]}%`} />
              <Box sx={{ flex: 1 }} />
              <Skeleton height={16} width={48} />
            </Stack>
            <Skeleton height={14} width="55%" />
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.75 }}>
              {[64, 80, 56].map((w) => (
                <Skeleton key={w} variant="rounded" height={22} width={w} />
              ))}
            </Stack>
          </Box>
        ))}
      </Stack>
    );
  return (
    <Box role="status" aria-live="polite" aria-busy="true" aria-label="Loading submissions" sx={{ px: 2, py: 1 }}>
      <Stack direction="row" spacing={2} sx={{ py: 1, borderBottom: 1, borderColor: 'divider' }}>
        {Array.from({ length: columns }, (_, c) => (
          <Skeleton key={c} height={16} sx={{ flex: c === 1 ? 3 : 1 }} />
        ))}
      </Stack>
      {Array.from({ length: 8 }, (_, r) => (
        <Stack
          key={r}
          direction="row"
          spacing={2}
          alignItems="center"
          sx={{ py: 1.25, borderBottom: 1, borderColor: 'divider' }}
        >
          {Array.from({ length: columns }, (_, c) => (
            <Box key={c} sx={{ flex: c === 1 ? 3 : 1, minWidth: 0 }}>
              {c === 1 ? (
                <>
                  <Skeleton height={18} width={`${widths[r % widths.length]}%`} />
                  <Skeleton height={14} width={`${(widths[(r + 3) % widths.length] ?? 60) - 20}%`} />
                </>
              ) : (
                <Skeleton height={18} width={`${widths[(r + c) % widths.length]}%`} />
              )}
            </Box>
          ))}
        </Stack>
      ))}
    </Box>
  );
}
