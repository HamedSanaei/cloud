import { z } from 'zod'
import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { bootstrapSuperAdmin } from '../modules/system/super-admin.js'

const target = z.uuid().safeParse(process.argv[2])
if (!target.success) throw new Error('Usage: node dist/scripts/bootstrap-super-admin.js <verified-admin-uuid>')
loadConfig()
const { db, pool } = createDb()
try {
  await bootstrapSuperAdmin(db, target.data)
  process.stdout.write('Initial Super Admin assigned and audited.\n')
} finally { await pool.end() }
