// ESLint (coding-standards and accessibility skills): TypeScript, the rules of hooks, and jsx-a11y. Type-aware rules run
// on src/. Rules the existing code breaks in bulk start as warnings so the lint can gate CI now; tighten them to errors
// as the warnings are cleared (`npm run lint` lists them).
import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

/** Folders under src/features; each is reached from outside only through its index.ts. */
const FEATURES = ['submissions', 'settings', 'audit'];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'simple-import-sort': simpleImportSort },
    rules: {
      // The two classic hooks rules; the React Compiler rules in the plugin's newer presets are not adopted yet.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // MUI dialogs focus their first field (TextField autoFocus), the expected behaviour; plain DOM elements may not.
      'jsx-a11y/no-autofocus': ['error', { ignoreNonDOM: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Import order (coding-standards skill); a warning until existing files are sorted (`eslint --fix`).
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',
      // logging-monitoring skill: the app logs through src/lib/logger.ts (which also reports to the server).
      'no-console': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Fire-and-forget by design: TanStack's invalidate/refetch never reject unless asked to, and navigate() is
      // React Router's. Anything else unawaited must be awaited, caught, or marked `void` on purpose.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: '@tanstack/query-core',
              name: ['invalidateQueries', 'refetchQueries', 'cancelQueries', 'resetQueries', 'prefetchQuery'],
            },
            { from: 'package', package: 'react-router', name: ['NavigateFunction', 'navigate'] },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
    },
  },
  // Feature boundaries (react-architecture skill): another feature is reached only through its public index.ts
  // (`../../submissions`, never `../../submissions/queryKeys`), and shared code likewise. Only the router (App.tsx)
  // loads pages directly. Inside a feature, relative imports are free. One block per folder: flat config keeps only
  // the last setting of a rule for a file, so each file must get all of its patterns from a single block.
  ...FEATURES.map((feature) => ({
    files: [`src/features/${feature}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: FEATURES.filter((other) => other !== feature).map((other) => ({
            regex: `(^|/)${other}/.+`,
            message: `Import from the ${other} feature's public API (features/${other}/index.ts), not its internals.`,
          })),
        },
      ],
    },
  })),
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/features/**', 'src/App.tsx', 'src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '(^|/)features/[a-z]+/.+', message: 'Shared code may use a feature only through its index.ts.' },
          ],
        },
      ],
    },
  },
  {
    // styling-theming skill: colors come from the theme (src/theme.ts tokens and palette), never literals in components.
    files: ['src/**/*.tsx'],
    ignores: ['src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
          message: 'Use a theme palette path or `tokens` from theme.ts, not a hex color.',
        },
        {
          selector: 'Literal[value=/^rgba?[(]/]',
          message: 'Use a theme color with alpha(), not an rgb()/rgba() literal.',
        },
      ],
    },
  },
  {
    files: ['vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
);
