// Copies SQL migrations next to the compiled migrator so `npm start` can run them.
import { cpSync } from 'node:fs';

cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
