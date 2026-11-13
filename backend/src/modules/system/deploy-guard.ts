// A deployment-scoped container command, never an API, poller or worker.
import { access } from 'node:fs/promises'
import path from 'node:path'
import { getConfig, loadConfig } from '../../config.js'
import { coordinationPool, exclusive, operationsLock } from './writer-gate.js'

async function main() {
  loadConfig()
  const pool = coordinationPool(1), client = await pool.connect()
  try {
    await exclusive(client, operationsLock)
    if (await access(path.join(getConfig().SYSTEM_BACKUP_DIR, 'maintenance.lock')).then(() => true, () => false)) throw new Error('Recovery is unresolved')
    process.stdout.write('SYSTEM_DEPLOY_GUARD_READY\n')
    await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
  } finally { client.release(true); await pool.end() }
}
void main().catch(() => { process.stderr.write('System operation lock or recovery preflight rejected deployment\n'); process.exitCode = 1 })
