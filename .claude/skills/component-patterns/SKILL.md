---
name: component-patterns
description: Use when creating, splitting or refactoring React components (.tsx) — container vs presentational components, composition with children/slots, compound components, props interfaces and defaults, wrapping MUI components in the design system, ref forwarding, list keys, prop drilling, or when a component file is getting large (the app has several 500+ line components that should be split when touched).
---

# Component Patterns

Small components with one job, data fetched at the top, and composition instead of configuration. Large
"workspace" components that fetch, transform, lay out and handle five dialogs at once are the main source of
re-render bugs and merge conflicts, so split along those seams when you touch them.

Related: `typescript-standards` (props types), `performance` (memoisation), `styling-theming`,
`accessibility`, `custom-hooks`.

## Rules

- **Function components only, named `function` declarations with named exports.** (The single exception is
  an error-boundary class or `react-error-boundary`.)
- **One responsibility per component.** Split when the file passes ~200 lines, when JSX passes ~80 lines,
  or when it does two jobs (fetch *and* render a complex table *and* own a dialog).
- **Container vs presentational:**
  - *Container* (page or feature section) calls hooks, maps data, owns handlers, renders children.
  - *Presentational* receives data and callbacks via props and calls no data hooks. These are easy to test
    and reuse.
- **Props:** `interface <Name>Props` right above the component; defaults via destructuring
  (`size = 'medium'`); `children: ReactNode`; callbacks named `onX` that pass domain values
  (`onSelect(submissionId)`), not DOM events.
- **Wrap MUI for app-level primitives** (`ConfirmDialog`, `StatusChip`, `PageHeader`) so feature code uses
  the app's API (`tone`, `pending`, `destructive`) and MUI details stay in one file. Extend MUI's own props
  type (`ButtonProps`) and forward `...rest`, `sx`, and `ref` so consumers aren't boxed in.
- **Prefer composition** (`children`, slot props like `actions`, `header`) over passing props through
  more than two levels. Deeper sharing → Context for a subtree (see `state-management`).
- **Compound components** for multi-part widgets that share implicit state (`ReportSection` +
  `ReportSection.Evidence`), with a private context that throws a clear error if used outside its parent.
- **Keys are stable ids** (`row.id`), never array indexes for lists that sort, filter or reorder.
- **Early returns** for loading/error/empty (see `ui-ux-standards`), and dialogs mounted only when open if
  they fetch or hold heavy state.
- **Don't** define components inside components (they remount every render), use `React.FC`,
  `defaultProps`, or `propTypes`, mutate props, copy props into state (unless explicitly `initialX`), or
  derive render data in effects.

## Patterns

```tsx
// Container → presentational
export function SubmissionPage() {
  const submissionId = useSubmissionIdParam();
  const submission = useSubmission(submissionId);
  if (submission.isPending) return <SubmissionPageSkeleton />;
  if (submission.isError) return <ErrorState error={submission.error} onRetry={() => void submission.refetch()} />;
  return (
    <SubmissionLayout
      header={<SubmissionHeader submission={submission.data} />}
      main={<SubmissionTabs submission={submission.data} />}
      aside={<AttachmentsPanel submissionId={submissionId} />}
    />
  );
}

interface SubmissionHeaderProps { submission: Submission }
export function SubmissionHeader({ submission }: SubmissionHeaderProps) {
  return (
    <PageHeader title={submission.applicantName} subtitle={formatDate(submission.receivedAt)}
      actions={<StatusChip status={submission.status} />} />
  );
}
```

```tsx
// App primitive wrapping MUI with forwarded ref + rest props (Button `loading` exists from MUI 6.4)
interface ActionButtonProps extends Omit<ButtonProps, 'color' | 'loading'> { destructive?: boolean; pending?: boolean }

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  { destructive = false, pending = false, disabled, children, ...rest }, ref,
) {
  return (
    <Button ref={ref} color={destructive ? 'error' : 'primary'} loading={pending} disabled={disabled || pending} {...rest}>
      {children}
    </Button>
  );
});
```

```tsx
// Compound component with a private context
const SectionContext = createContext<{ sectionId: string } | null>(null);
function useSection() {
  const ctx = useContext(SectionContext);
  if (!ctx) throw new Error('ReportSection parts must be inside <ReportSection>');
  return ctx;
}
export function ReportSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <SectionContext.Provider value={useMemo(() => ({ sectionId: id }), [id])}>
      <Box component="section" aria-labelledby={`${id}-title`}>
        <Typography id={`${id}-title`} variant="h6" component="h3">{title}</Typography>
        {children}
      </Box>
    </SectionContext.Provider>
  );
}
ReportSection.Evidence = function Evidence({ quote, source }: { quote: string; source: string }) {
  const { sectionId } = useSection();
  return <EvidenceQuote data-section={sectionId} cite={source}>{quote}</EvidenceQuote>;
};
```

## Files & naming

- One exported component per file; file name = component name. Small private subcomponents may sit below
  the main one in the same file.
- Design-system wrappers: `src/components/ui/`. Domain components: `features/<f>/components/`.
  Route components: `features/<f>/pages/<Name>Page.tsx`.

## Review checklist

- [ ] Named function component + named export + `<Name>Props`
- [ ] ≤ ~200 lines and one responsibility; presentational parts have no data hooks
- [ ] No prop drilling past two levels; no nested component definitions
- [ ] Stable keys; MUI wrappers forward `ref`, `sx`, and rest props
