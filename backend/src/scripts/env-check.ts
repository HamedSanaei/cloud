/**
 * Local environment check (npm run env:check).
 *
 * Prints only configured/missing state — never secret values — and never
 * contacts Leaseweb or any other service.
 */
import { describeLocalEnv } from '../lib/env-loader.js'
import { loadConfig } from '../config.js'
function main(): number {
  const config = loadConfig()
  const state = describeLocalEnv()
  console.log(`${state.envLocalPath}: ${state.envLocalFound ? 'found' : 'missing'}`)
  for (const [id, provider] of Object.entries(config.PROVIDERS)) {
    const count = 'accounts' in provider ? provider.accounts.filter((account) => !!(account.apiKey || account.apiToken)).length : 0
    console.log(`${id}: enabled=${provider.enabled}, configured_accounts=${count}`)
  }
  return 0
}

process.exit(main())