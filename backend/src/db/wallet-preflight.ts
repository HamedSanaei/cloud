import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pg, { type PoolClient } from 'pg'
import { getConfig } from '../config.js'

export async function walletPreflight(client: PoolClient) {
  const { rows } = await client.query(`
    WITH wallet_refs AS (
      SELECT 'ledger' AS kind,id,wallet_id,user_id FROM wallet_transactions UNION ALL
      SELECT 'order',id,wallet_id,user_id FROM orders WHERE wallet_id IS NOT NULL UNION ALL
      SELECT 'payment',id,wallet_id,user_id FROM wallet_payments UNION ALL
      SELECT 'adjustment',id,wallet_id,user_id FROM admin_adjustments UNION ALL
      SELECT 'ip_operation',o.id,w.id,s.user_id FROM provider_operations o
        LEFT JOIN wallets w ON w.id::text=o.request_metadata->>'walletId'
        LEFT JOIN servers s ON s.id=o.reference_id
        WHERE o.action='replace_primary_ipv4' AND o.completed_at IS NULL
    ), wallet_plan AS (
      SELECT user_id, count(*) AS count, sum(balance_rial)::text AS total,
        jsonb_agg(jsonb_build_object('id',id,'balanceRial',balance_rial::text,'currency',currency,'wasDefault',is_default)
          ORDER BY is_default DESC, created_at, id) AS wallets,
        bool_or(currency <> 'IRR' OR balance_rial < 0) OR sum(balance_rial) > 9007199254740991 AS invalid
      FROM wallets GROUP BY user_id
    ), refs AS (
      SELECT user_id, kind, jsonb_agg(id ORDER BY id) AS ids FROM wallet_refs WHERE kind <> 'ledger' GROUP BY user_id, kind
    ), invalid_refs AS (
      SELECT r.user_id, jsonb_agg(jsonb_build_object('kind',r.kind,'id',r.id,'walletId',r.wallet_id)) AS ids
      FROM wallet_refs r LEFT JOIN wallets w ON w.id=r.wallet_id WHERE w.user_id IS DISTINCT FROM r.user_id GROUP BY r.user_id
    ), ledger_totals AS (
      SELECT user_id, count(*) AS count, count(idempotency_key) - count(DISTINCT idempotency_key) AS collisions
      FROM wallet_transactions GROUP BY user_id
    )
    SELECT u.id AS "userId", coalesce(p.count,0)::int AS "walletCount", coalesce(p.total,'0') AS "totalRial",
      coalesce(p.wallets,'[]') AS wallets, p.wallets->0->>'id' AS "canonicalId", coalesce(p.invalid,false) AS "invalidBalance",
      coalesce(i.ids,'[]') AS "invalidReferences", coalesce(l.count,0)::int AS "ledgerRows", coalesce(l.collisions,0)::int AS "legacyKeyCollisions",
      coalesce((SELECT jsonb_object_agg(kind,ids) FROM refs r WHERE r.user_id=u.id),'{}') AS "walletReferences",
      ARRAY(SELECT id FROM wallet_payments WHERE user_id=u.id AND status IN ('creating','pending','unknown')) AS "openPayments",
      ARRAY(SELECT id FROM charge_requests WHERE user_id=u.id AND status IN ('pending','processing')) AS "openChargeRequests",
      ARRAY(SELECT id FROM subscriptions WHERE user_id=u.id AND status <> 'cancelled') AS "subscriptions",
      ARRAY(SELECT r.id FROM renewal_attempts r JOIN subscriptions s ON s.id=r.subscription_id
        WHERE s.user_id=u.id AND r.status NOT IN ('succeeded','cancelled')) AS "unresolvedRenewals",
      ARRAY(SELECT o.id FROM provider_operations o LEFT JOIN servers s ON s.id=o.reference_id AND o.reference_type='server'
        LEFT JOIN orders r ON r.id=o.reference_id AND o.reference_type='order' WHERE o.status IN ('pending','running','unknown','needs_reconciliation')
        AND (s.user_id=u.id OR r.user_id=u.id)) AS "openOperations",
      ARRAY(SELECT o.id FROM provider_operations o LEFT JOIN wallets w ON w.id::text=o.request_metadata->>'walletId'
        LEFT JOIN servers s ON s.id=o.reference_id WHERE o.action='replace_primary_ipv4' AND o.completed_at IS NULL
        AND (s.user_id=u.id OR o.request_metadata->>'actorId'=u.id::text) AND (w.id IS NULL OR w.user_id::text IS DISTINCT FROM o.request_metadata->>'actorId'
          OR s.user_id IS DISTINCT FROM w.user_id)) AS "invalidIpOperations"
    FROM users u LEFT JOIN wallet_plan p ON p.user_id=u.id LEFT JOIN ledger_totals l ON l.user_id=u.id
    LEFT JOIN invalid_refs i ON i.user_id=u.id ORDER BY u.id
  `)
  return rows
}

async function main() {
  const pool = new pg.Pool({ connectionString: getConfig().DATABASE_URL, max: 1 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const rows = await walletPreflight(client)
    const { rows: orphaned } = await client.query(`SELECT o.id FROM provider_operations o LEFT JOIN servers s ON s.id=o.reference_id
      LEFT JOIN users u ON u.id::text=o.request_metadata->>'actorId'
      WHERE o.action='replace_primary_ipv4' AND o.completed_at IS NULL AND s.id IS NULL AND u.id IS NULL`)
    const invalid = rows.filter(row => row.invalidBalance || row.invalidReferences.length || row.invalidIpOperations.length)
    const blockers = invalid.length + orphaned.length
    process.stdout.write(JSON.stringify({ users: rows.length, mergeUsers: rows.filter(row => row.walletCount > 1).length,
      missingWallets: rows.filter(row => row.walletCount === 0).length, blockers, orphanedOperations: orphaned.map(row => row.id), accounts: rows }, null, 2) + '\n')
    if (blockers) process.exitCode = 1
  } finally { client.release(true); await pool.end() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('Wallet preflight failed. Verify database access and schema.\n'); process.exitCode = 1 })
}
