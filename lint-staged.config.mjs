// Pre-commit checks on staged files (coding-standards skill), run by .husky/pre-commit.
//
// ESLint runs on every staged TypeScript file, from its own app so its eslint.config.js applies, with --fix, then
// Prettier formats it. The whole repo was formatted once (a `style:` commit), so formatting a staged file only touches
// the lines that changed. CI checks the same with `npm run format:check -- .`.
const quote = (files) => files.map((f) => JSON.stringify(f)).join(' ');
const prettier = (files) => [`prettier --write ${quote(files)}`];
// lint-staged runs from the repo root, so point ESLint at the app's flat config explicitly (npm --prefix does not change cwd).
const eslint = (app) => (files) => [
  `npm --prefix ${app} exec -- eslint --config ${app}/eslint.config.js --fix ${quote(files)}`,
  ...prettier(files),
];

export default {
  'backend/**/*.ts': eslint('backend'),
  'frontend/**/*.{ts,tsx}': eslint('frontend'),
  '*.{json,yml,yaml,md,css,html,mjs,js}': prettier,
};
