/**
 * Vitest setup: load backend/.env.local (then backend/.env) into process.env
 * once per test run, so local test runs see the same developer-local
 * configuration as `npm run dev` / the CLI. Existing process env still wins,
 * and production-mode runs skip file loading entirely (see env-loader.ts).
 */
import { loadLocalEnvFiles } from '../src/lib/env-loader.js'

loadLocalEnvFiles()