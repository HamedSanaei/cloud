/**
 * Local environment check (npm run env:check).
 *
 * Prints only configured/missing state — never secret values — and never
 * contacts Leaseweb or any other service.
 */
import { loadLocalEnvFiles, describeLocalEnv } from '../lib/env-loader.js'

function main(): number {
  const loaded = loadLocalEnvFiles()
  const state = describeLocalEnv()

  console.log(`${loaded.envLocalPath}: ${state.envLocalFound ? 'found' : 'missing'}`)
  console.log(`LEASEWEB_API_KEY: ${state.apiKey}`)
  console.log(`LEASEWEB_MODE: ${state.mode}`)
  console.log(`LEASEWEB_ORDERING_ENABLED: ${state.orderingEnabled}`)
  return 0
}

process.exit(main())