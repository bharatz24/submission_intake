---
name: styling-theming
description: Use when styling anything in the frontend with MUI v6 and Emotion — the createTheme theme (palette, typography, shape, spacing, component defaults/variants), design tokens, the sx prop vs styled(), responsive values and breakpoints, dark mode (colorSchemes / CssVarsProvider), status colors for risk levels and submission states, or deciding when inline styles are acceptable. Use it before adding any color, spacing value, or custom component style.
---

# Styling & Theming (MUI + Emotion)

The design system is **MUI v6 themed through one `createTheme`**. The theme is the single source of colors,
typography, spacing, radius and component defaults; components consume tokens, never raw values. That is
what keeps the 40+ screens consistent and makes dark mode or a rebrand a theme change, not a code hunt.

Related: `ui-ux-standards` (layout, states), `accessibility` (contrast, focus), `component-patterns`.

## Rules

- **Theme lives in `src/theme/theme.ts`** (plus `tokens.ts` for raw brand values used only by the theme).
  Use `ThemeProvider` + `CssBaseline` once in `app/providers.tsx`.
- **Colors come from the palette**, `theme.palette.*` or palette strings in `sx`
  (`color: 'text.secondary'`, `bgcolor: 'background.paper'`). No hex/rgb literals in components.
- **Domain colors are theme tokens, not ad-hoc chips.** Risk levels and submission statuses map to semantic
  palette keys in one place (`RISK_TONE`, `STATUS_TONE`), so "high risk" is the same red everywhere. Add custom palette
  entries via module augmentation if needed.
- **Spacing uses the theme scale** (`p: 2`, `gap: 1.5`, `theme.spacing(3)`). No pixel margins.
- **Typography uses variants** (`<Typography variant="h5">`, `subtitle2`, `body2`, `caption`). Don't
  restyle font sizes per component; add or adjust a variant in the theme. Keep the semantic heading level
  separate from the visual variant (`variant="h6" component="h2"`).
- **Component-wide look goes in `theme.components`** (`defaultProps`, `styleOverrides`, `variants`), e.g.
  dense tables, `textTransform: 'none'` buttons, outlined cards. Don't repeat the same `sx` on every usage.
- **`sx` for one-off, local styling; `styled()` for a reusable styled element.** Keep `sx` objects small;
  extract a constant or a `styled` component when it passes ~8 properties or is reused.
- **Responsive values use breakpoint objects** (`sx={{ flexDirection: { xs: 'column', md: 'row' } }}`) and
  `theme.breakpoints`, not hard-coded media queries.
- **Dark mode via `colorSchemes`** (`createTheme({ colorSchemes: { light, dark }, cssVariables: true })`)
  if/when it's offered. Write styles against palette tokens now so it works later with no rewrite.
- **Inline `style` only for runtime-computed values** (a progress width, a virtual-row transform).
- **Import MUI by path or named import from the package root.** Both tree-shake in Vite; be consistent.
  Icons: `import EditIcon from '@mui/icons-material/Edit'` (path imports keep dev startup fast).
- **Don't mix in a second styling system** (Tailwind, Bootstrap, styled-components) or global CSS that
  targets `.Mui*` class names; use theme overrides instead so MUI upgrades don't break you.
- **Keep the focus ring.** Never remove `:focus-visible` styling without an equally visible replacement.

## Patterns

```ts
// src/theme/theme.ts
import { createTheme } from '@mui/material/styles';
import { brand } from './tokens';

export const theme = createTheme({
  cssVariables: true,
  palette: {
    primary: { main: brand.navy },
    error: { main: brand.red },
    warning: { main: brand.amber },
    success: { main: brand.green },
    background: { default: brand.canvas, paper: '#fff' },
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily: '"Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiTableCell: { styleOverrides: { head: ({ theme }) => ({ fontWeight: 600, color: theme.palette.text.secondary }) } },
    MuiCard: { defaultProps: { variant: 'outlined' } },
  },
});
```

```ts
// src/features/assessments/constants.ts: one mapping from domain → palette
export const RISK_TONE = {
  LOW: 'success', MODERATE: 'info', ELEVATED: 'warning', HIGH: 'error',
} as const satisfies Record<RiskRating, 'success' | 'warning' | 'error' | 'info'>; // same values as the API
// <Chip size="small" color={RISK_TONE[level]} label={RISK_LABEL[level]} />
```

```tsx
// sx for local layout; styled() for a reusable element
<Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ p: 2, bgcolor: 'background.paper' }}>…</Stack>

const EvidenceQuote = styled('blockquote')(({ theme }) => ({
  margin: 0,
  padding: theme.spacing(1, 1.5),
  borderLeft: `3px solid ${theme.palette.primary.light}`,
  color: theme.palette.text.secondary,
  ...theme.typography.body2,
}));
```

## Review checklist

- [ ] No hex/rgb literals or pixel spacing in components; tokens only
- [ ] Repeated looks moved to `theme.components`, not copy-pasted `sx`
- [ ] Domain states (risk, status) use the shared tone mapping
- [ ] Responsive behaviour uses breakpoint values
- [ ] Heading semantics (`component`) are set independently of the visual variant
- [ ] Focus styles intact; contrast checked (see `accessibility`)
