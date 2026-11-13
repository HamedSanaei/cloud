import { createDb } from '../db/index.js'
import { loadConfig } from '../config.js'
import { recoverBackupJob } from '../modules/system/backups.js'

async function main() {
  loadConfig()
  const [id, confirmation] = process.argv.slice(2)
  if (!id || !/^[0-9a-f-]{36}$/.test(id) || confirmation && confirmation !== '--confirm-rollback') throw new Error('Usage: node dist/scripts/system-recovery.js <operation-uuid> [--confirm-rollback]')
  const handle = createDb()
  try { console.log(JSON.stringify(await recoverBackupJob(handle.db, id, confirmation === '--confirm-rollback'))) }
  finally { await handle.pool.end() }
}
void main().catch(() => { console.error('Recovery failed; maintenance remains active. Check protected configuration and operator runbook.'); process.exitCode = 1 })
