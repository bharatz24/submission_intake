---
name: ui-ux-standards
description: Use when building or changing any screen, panel, table, dialog or data view — loading/empty/error states, skeletons, progress for long-running pipeline steps, action feedback (pending, toasts), confirmation for destructive or outbound actions (delete, send email, decline, submit to IMS), dense data tables, responsive layout, UI copy, US date/currency/number formatting, or showing AI-generated content with its evidence. Use it for every UI change, however small.
---

# UI/UX Standards

This is a professional underwriting workstation: users scan many submissions, compare documents, and make
decisions with financial consequences. The UI should be **dense but calm, predictable, and honest** about
what is loading, what failed, what the AI produced, and what a click will do.

Related: `styling-theming`, `accessibility`, `error-handling`, `component-patterns`.

## Rules

- **Every data view handles loading → error → empty → content**, in that order, with early returns.
  - Loading: MUI `Skeleton` shaped like the final layout (no layout shift). Spinners only for inline or
    button-level waits; full-page loader only for session restore.
  - Error: `<ErrorState error onRetry />`, a short message plus a retry action.
  - Empty: `<EmptyState title description action? />`. Distinguish "nothing yet" from "no results for these
    filters" (offer Clear filters).
- **Keep stale data visible during refetch or paging** (`keepPreviousData`) with a subtle progress
  indicator (`LinearProgress` at the top of the table) instead of swapping back to skeletons.
- **Long-running work shows progress by stage** (duplicate check → classification → extraction → NPI
  verification → Synthesis → Analysis, the `PIPELINE_STAGES` order), with the current step, elapsed time, and a clear failed state with "Retry from
  this step". Never a spinner with no explanation for a minute.
- **Every action gives feedback within ~100 ms:** the button shows pending (`loading` prop) and is
  disabled while pending to prevent double submits; the result is a toast, an inline update, or navigation.
- **Confirm destructive and outbound actions** with `<ConfirmDialog>`: delete, decline, send/forward email,
  submit to IMS, overwrite a skill. The title names the object ("Send reply to jane@clinic.com?"), one
  sentence states the consequence, the confirm button repeats the verb ("Send reply"), and focus starts on
  Cancel. Reversible actions can use an Undo toast instead.
- **AI-generated content is labelled and traceable.** Mark synthesized/analysed text as generated, show
  the evidence quote and source document for extracted facts, show the version/timestamp, and never present
  an AI suggestion as a final decision. The underwriter decides.
- **Tables:** sticky header, right-aligned numbers, consistent date format, sortable columns where users
  compare, row click and keyboard both open detail, wide tables scroll inside their container. Use MUI
  `Table` for small sets and a virtualised/data-grid approach beyond ~100 visible rows (see `performance`).
- **Responsive:** desktop-first is acceptable for this tool, but nothing may break at 1024 px or at 200 %
  zoom, and there is no horizontal page scroll. Side panels collapse to tabs or drawers below `md`.
- **Use the design-system wrappers** in `@/components/ui` (EmptyState, ErrorState, ConfirmDialog,
  PageHeader, StatusChip). If a primitive is missing, add it there rather than restyling MUI in a feature.
- **Copy:** sentence case; buttons are verb + noun ("Generate analysis", "Send reply"); errors say how to
  fix; no "OK", "Submit", or "Click here"; no jargon the underwriter wouldn't use.
- **Format with `@/lib/format`** (`Intl` with `en-US`): dates `MM/DD/YYYY` (with time zone where it
  matters), currency `$12,500`, percentages with fixed decimals. Store/transport ISO 8601; format only at
  display. Never format by string concatenation.
- **Don't** use `window.alert/confirm/prompt`, disable a control without explaining why (tooltip), or show
  raw ids/enum values (`READY_FOR_REVIEW`, `ACCEPT_WITH_CONDITIONS`) to users; map them to labels.

## Patterns

```tsx
// Four states, with stale-while-refetching
export function SubmissionTable({ filters }: { filters: InboxFilters }) {
  const { data, isPending, isError, error, refetch, isFetching, isPlaceholderData } = useSubmissions(filters);
  if (isPending) return <SubmissionTableSkeleton rows={PAGE_SIZE} />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (data.items.length === 0) {
    return hasActiveFilters(filters)
      ? <EmptyState title="No submissions match these filters" action={<ClearFiltersButton />} />
      : <EmptyState title="No submissions yet" description="New emails appear here automatically." />;
  }
  return (
    <Box sx={{ position: 'relative' }} aria-busy={isFetching}>
      {isFetching && <LinearProgress sx={{ position: 'absolute', inset: '0 0 auto 0' }} />}
      <SubmissionTableView rows={data.items} dimmed={isPlaceholderData} />
    </Box>
  );
}
```

```tsx
// Outbound action: confirm + pending + feedback
const send = useSendReply();
<ConfirmDialog
  open={open}
  title={`Send reply to ${draft.to}?`}
  description="The email is sent from the connected mailbox and recorded in the audit trail."
  confirmLabel="Send reply"
  pending={send.isPending}
  onCancel={() => setOpen(false)}
  onConfirm={() => send.mutate(draft, { onSuccess: () => { setOpen(false); toast.success('Reply sent'); } })}
/>
```

```ts
// src/lib/format.ts
const usDate = new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
// Date-only values ('2026-01-15') must parse as local dates: new Date('2026-01-15') is UTC midnight,
// which shows the previous day in US time zones.
const toDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso));
export const formatDate = (iso: string | null | undefined) => (iso ? usDate.format(toDate(iso)) : '—');
export const formatCurrency = (amount: number | null | undefined) => (amount == null ? '—' : usd.format(amount));
```

## Review checklist

- [ ] Loading (skeleton), error (retry), empty (with guidance), content all implemented
- [ ] Long work shows stage progress and a retryable failed state
- [ ] Every action has pending + result feedback and can't double-submit
- [ ] Destructive/outbound actions confirm with specific copy
- [ ] AI output is labelled, versioned, and linked to evidence
- [ ] Works at 1024 px and 200 % zoom; no horizontal page scroll
- [ ] Dates/currency via `@/lib/format`; no raw enum values shown
