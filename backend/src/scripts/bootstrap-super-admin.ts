import { z } from 'zod'
import { createInterface } from 'node:readline/promises'
import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { bootstrapSuperAdmin } from '../modules/system/super-admin.js'

if (!process.stdin.isTTY || process.argv.length !== 2) throw new Error('Run interactively as the database operator.')
const terminal = createInterface({ input: process.stdin, output: process.stdout })
const email = await terminal.question('Email of the independently verified administrator: ').finally(() => terminal.close())
const target = z.email().safeParse(email.trim().toLowerCase())
if (!target.success) throw new Error('Enter a valid administrator email.')
loadConfig()
const { db, pool } = createDb()
try {
  await bootstrapSuperAdmin(db, target.data)
  process.stdout.write('Initial Super Admin assigned and audited.\n')
} finally { await pool.end() }
