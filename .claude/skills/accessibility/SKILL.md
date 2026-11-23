---
name: accessibility
description: Use when building or reviewing frontend UI for accessibility (a11y, WCAG 2.2 AA) — semantic HTML and landmarks, heading order, labels for MUI inputs and icon buttons, keyboard navigation of tables/tabs/dialogs/menus, focus management after route changes, dialogs and deletes, ARIA and live regions for toasts and pipeline progress, color contrast and color-only status, document/PDF viewers, reduced motion, or axe/jsx-a11y checks. Use it for every new component or screen.
---

# Accessibility (WCAG 2.2 AA)

Underwriters spend whole days in this app, often keyboard-first and at high zoom. MUI gives accessible
primitives, but only if they are used as designed: a `Box onClick` or an unlabeled `IconButton` throws the
benefit away. Target WCAG 2.2 AA.

Related: `forms-validation` (field wiring), `styling-theming` (contrast, focus), `testing` (axe).

## Rules

- **Use the native or MUI element for the job:** `Button`/`IconButton` for actions, `Link` (router) for
  navigation, `Table` with `TableHead` + `th scope` for tabular data, `List` for lists, `Tabs` + `TabPanel`
  for tabs. Never `onClick` on a `div`/`Box`/`span`.
- **Landmarks and headings:** `AppLayout` provides `<header>`, `<nav aria-label="Main">`,
  `<main id="main">` and a "Skip to content" link as the first focusable element. One `h1` per page, and no
  skipped levels. Use `Typography component="h2"` to fix semantics while keeping the visual variant.
- **Every control has an accessible name:** a visible `label` for inputs; `aria-label` for icon-only
  buttons, describing the action and object ("Delete attachment loss-runs.pdf"). Wrap icon buttons in a
  `Tooltip` with the same text for sighted mouse users.
- **Keyboard:** everything works with the keyboard, tab order follows visual order, and custom widgets
  follow the WAI-ARIA APG pattern. Clickable table rows also need a focusable element (a link in the
  first cell) and Enter support.
- **Dialogs (MUI `Dialog`)** get `aria-labelledby` to their title, close on Escape, put initial focus on
  the first meaningful control (Cancel for destructive ones), and return focus to the trigger (MUI does this
  if you don't unmount the trigger).
- **Focus after change:** on route change, focus the page `h1`; after deleting a row, focus the next row
  or the table heading, never `<body>`.
- **Announce async status:** toasts use `role="status"` (errors `role="alert"`); pipeline progress and
  "report generating" regions use `aria-live="polite"` and `aria-busy` while loading.
- **Contrast:** text ≥ 4.5:1 (large ≥ 3:1); focus indicators and input borders ≥ 3:1. Check the palette
  once in the theme rather than per component.
- **Never color alone:** risk and status chips include text (and ideally an icon); diff views mark
  additions/removals with symbols or labels, not just green/red.
- **Images and documents:** meaningful images get `alt`; decorative ones `alt=""`; decorative icons
  `aria-hidden`. Embedded PDF/document viewers have a title and a "Download" / "Open in new tab" alternative.
- **Motion:** respect `prefers-reduced-motion` (MUI transitions can be shortened via theme), and nothing
  auto-animates for more than 5 s.
- **Target size ≥ 24×24 px** (WCAG 2.2). Dense tables are fine, but row actions still need that hit area.
- **Don't** use positive `tabIndex`, `aria-hidden` on focusable elements, ARIA that duplicates native
  semantics, `title` or placeholder as the only label, or remove focus outlines.

## Patterns

```tsx
// Icon button with name + tooltip; status not color-only
<Tooltip title={`Remove ${file.name}`}>
  <IconButton aria-label={`Remove ${file.name}`} onClick={() => onRemove(file.id)} size="small">
    <DeleteOutlineIcon fontSize="small" />
  </IconButton>
</Tooltip>
<Chip size="small" color={RISK_TONE[rating]} icon={<RiskIcon rating={rating} />} label={RISK_LABEL[rating]} />
```

```tsx
// src/components/layout/PageHeader.tsx: focus target on route change
export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const { pathname } = useLocation();
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [pathname]);
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
      <Typography ref={ref} tabIndex={-1} variant="h5" component="h1" sx={{ outline: 'none' }}>{title}</Typography>
      {actions}
    </Stack>
  );
}
```

```tsx
// @vitest-environment jsdom
// Automated check in component tests (vitest-axe, a dev dependency to add with the first axe test);
// manual keyboard checks still required
it('has no detectable a11y violations', async () => {
  const { container } = renderWithProviders(<QuoteInputsForm quote={buildQuote()} />);
  expect(await axe(container)).toHaveNoViolations();
});
```

## Review checklist

- [ ] Semantic elements, landmarks, one `h1`, ordered headings
- [ ] Every input labelled; every icon button has `aria-label` (+ tooltip)
- [ ] Whole flow done keyboard-only: visible focus, no traps, focus restored after dialogs
- [ ] Live regions for toasts and async progress
- [ ] Contrast OK; no color-only meaning
- [ ] `eslint-plugin-jsx-a11y` clean and an axe test on new screens/forms
