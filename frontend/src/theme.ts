import { alpha, createTheme } from '@mui/material/styles';

const navy = '#1f3a68';

/**
 * Every color the app uses beyond MUI's palette roles (primary, text, divider…). Components reach them through the
 * palette (`sx={{ bgcolor: 'surface.subtle' }}`) or, where a raw value is needed (alpha(), Web Animations), through
 * this object: never as literals, so a rebrand or a dark mode is one edit here.
 */
export const tokens = {
  surface: {
    /** Table heads, code and quoted text blocks. */
    subtle: '#f8f9fb',
    /** Inline code. */
    muted: '#f1f3f7',
    /** Behind a previewed document. */
    canvas: '#f3f4f6',
    /** The email body card. */
    raised: '#fafbfc',
    /** The email draft toolbar. */
    tint: '#f2f6fc',
    /** Highlighted words in reports. */
    highlight: '#fff3a3',
  },
  nav: {
    bg: '#132647',
    text: '#dfe6f2',
    muted: '#9fb0cc',
    icon: '#9fb7e0',
    link: '#c3cee2',
    hover: 'rgba(255,255,255,.08)',
    active: 'rgba(255,255,255,.12)',
    divider: 'rgba(255,255,255,.08)',
  },
  /** Icons of the email draft editor (Gmail-like toolbar). */
  ink: '#444746',
  /** Attachment icons by file type. */
  fileType: {
    pdf: '#d93025',
    image: '#9334e6',
    sheet: '#188038',
    doc: '#1a73e8',
    slides: '#e8710a',
    archive: '#795548',
    neutral: '#5f6368',
  },
  accent: { analysis: '#7a4fa0' },
} as const;

type Tokens = typeof tokens;
declare module '@mui/material/styles' {
  interface Palette {
    surface: Tokens['surface'];
    nav: Tokens['nav'];
    ink: { main: string };
    fileType: Tokens['fileType'];
    accent: Tokens['accent'];
  }
  interface PaletteOptions {
    surface?: Tokens['surface'];
    nav?: Tokens['nav'];
    ink?: { main: string };
    fileType?: Tokens['fileType'];
    accent?: Tokens['accent'];
  }
}

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: navy, light: '#3d5a8c', dark: '#132647', contrastText: '#fff' },
    secondary: { main: '#4a6fa5' },
    success: { main: '#2e7d4f' },
    warning: { main: '#b26a00' },
    error: { main: '#b3261e' },
    info: { main: '#2f6690' },
    background: { default: '#f4f6f9', paper: '#ffffff' },
    text: { primary: '#1b2433', secondary: '#5a6578' },
    divider: '#e1e5ec',
    surface: tokens.surface,
    nav: tokens.nav,
    ink: { main: tokens.ink },
    fileType: tokens.fileType,
    accent: tokens.accent,
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily: '"Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: 13,
    h4: { fontWeight: 600, fontSize: '1.5rem' },
    h5: { fontWeight: 600, fontSize: '1.25rem' },
    h6: { fontWeight: 600, fontSize: '1.05rem' },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 600, fontSize: '0.8rem', letterSpacing: 0.2 },
    overline: { fontWeight: 600, letterSpacing: 0.8, color: '#5a6578' },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    // Subtitles are styling, not headings: MUI would render them as <h6>, breaking the heading outline screen
    // readers navigate by. A real heading sets `component="h3"` (or the right level) itself.
    MuiTypography: { defaultProps: { variantMapping: { subtitle1: 'p', subtitle2: 'p' } } },
    MuiAppBar: { defaultProps: { elevation: 0 } },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { outlined: { borderColor: '#e1e5ec' } },
    },
    MuiCard: { defaultProps: { variant: 'outlined' } },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600, fontSize: '0.7rem', height: 22 },
        sizeSmall: { height: 20 },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { padding: '8px 12px', borderColor: '#eef1f5' },
        head: {
          fontWeight: 600,
          color: '#5a6578',
          fontSize: '0.75rem',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          background: tokens.surface.subtle,
        },
      },
    },
    MuiTableRow: {
      styleOverrides: { hover: { '&:hover': { backgroundColor: alpha(navy, 0.035) } } },
    },
    MuiTab: { styleOverrides: { root: { minHeight: 44, textTransform: 'none', fontWeight: 600 } } },
    MuiTabs: { styleOverrides: { root: { minHeight: 44 } } },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiSelect: { defaultProps: { size: 'small' } },
    MuiFormControl: { defaultProps: { size: 'small' } },
  },
});
