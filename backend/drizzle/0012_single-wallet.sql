-- The migrator holds the exclusive writer gate. Table locks also fence direct SQL writers.
LOCK TABLE users, wallets, wallet_transactions, orders, wallet_payments, admin_adjustments,
  subscriptions, renewal_attempts, charge_requests, servers, provider_operations IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$ BEGIN
  IF current_setting('parserver.wallet_consolidation_approved', true) = 'false'
    AND EXISTS (SELECT 1 FROM wallets GROUP BY user_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Wallet consolidation requires approved preflight and verified backup';
  END IF;
  IF EXISTS (SELECT 1 FROM wallets WHERE currency <> 'IRR' OR balance_rial < 0)
    OR EXISTS (SELECT 1 FROM wallets GROUP BY user_id HAVING sum(balance_rial) > 9007199254740991) THEN
    RAISE EXCEPTION 'Wallet consolidation blocked: currency, negative balance, or unsafe total; run wallet preflight';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT wallet_id, user_id FROM wallet_transactions UNION ALL
      SELECT wallet_id, user_id FROM orders WHERE wallet_id IS NOT NULL UNION ALL
      SELECT wallet_id, user_id FROM wallet_payments UNION ALL
      SELECT wallet_id, user_id FROM admin_adjustments
    ) r LEFT JOIN wallets w ON w.id = r.wallet_id WHERE w.user_id IS DISTINCT FROM r.user_id
  ) OR EXISTS (
    SELECT 1 FROM provider_operations o LEFT JOIN wallets w ON w.id::text = o.request_metadata->>'walletId'
    LEFT JOIN servers s ON s.id=o.reference_id
    WHERE o.action = 'replace_primary_ipv4' AND o.completed_at IS NULL
    AND (w.id IS NULL OR w.user_id::text IS DISTINCT FROM o.request_metadata->>'actorId' OR s.user_id IS DISTINCT FROM w.user_id)
  ) THEN RAISE EXCEPTION 'Wallet consolidation blocked: invalid wallet ownership; run wallet preflight'; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE wallets ADD COLUMN merged_into uuid;
--> statement-breakpoint
CREATE TEMP TABLE wallet_merge_plan ON COMMIT DROP AS
SELECT id, user_id, balance_rial, first_value(id) OVER member AS canonical_id,
       sum(balance_rial) OVER (PARTITION BY user_id) AS total,
       count(*) OVER (PARTITION BY user_id) AS members
FROM wallets
WINDOW member AS (PARTITION BY user_id ORDER BY is_default DESC, created_at ASC, id ASC);
--> statement-breakpoint
INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata)
SELECT p.user_id, 'wallet.consolidated', 'wallet', p.canonical_id,
  jsonb_build_object('operationId', gen_random_uuid(), 'currency', 'IRR',
    'beforeRial', max(p.total), 'afterRial', max(p.total),
    'canonicalBeforeRial', max(p.balance_rial) FILTER (WHERE p.id = p.canonical_id),
    'sources', jsonb_agg(jsonb_build_object('walletId', p.id, 'balanceRial', p.balance_rial) ORDER BY p.id),
    'lastLegacyCanonicalLedgerId', (SELECT t.id FROM wallet_transactions t WHERE t.wallet_id=p.canonical_id ORDER BY t.created_at DESC, t.id DESC LIMIT 1))
FROM wallet_merge_plan p WHERE p.members > 1 GROUP BY p.user_id, p.canonical_id;
--> statement-breakpoint
UPDATE orders r SET wallet_id = p.canonical_id FROM wallet_merge_plan p
WHERE r.wallet_id = p.id AND r.user_id = p.user_id AND p.id <> p.canonical_id
  AND (r.status NOT IN ('failed','cancelled','refunded') OR EXISTS (
    SELECT 1 FROM subscriptions s WHERE s.order_id=r.id AND s.status NOT IN ('cancelled','expired')
  ));
--> statement-breakpoint
UPDATE wallet_payments r SET wallet_id = p.canonical_id FROM wallet_merge_plan p
WHERE r.wallet_id = p.id AND r.user_id = p.user_id AND p.id <> p.canonical_id AND r.status IN ('creating','pending','unknown');
--> statement-breakpoint
UPDATE admin_adjustments r SET wallet_id = p.canonical_id FROM wallet_merge_plan p
WHERE r.wallet_id = p.id AND r.user_id = p.user_id AND p.id <> p.canonical_id AND r.status = 'awaiting_approval';
--> statement-breakpoint
-- IP operations retain their accepted request metadata. Their refund path resolves owner-checked aliases.
UPDATE wallets w SET merged_into = CASE WHEN p.id <> p.canonical_id THEN p.canonical_id END,
  balance_rial = CASE WHEN p.id = p.canonical_id THEN p.total::bigint ELSE 0 END,
  is_default = (p.id = p.canonical_id), updated_at = now()
FROM wallet_merge_plan p WHERE w.id = p.id AND (p.members > 1 OR NOT w.is_default);
--> statement-breakpoint
INSERT INTO wallets (user_id, name, is_default)
SELECT u.id, 'کیف پول', true FROM users u WHERE NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM wallet_merge_plan p JOIN wallets w ON w.id = p.canonical_id
    WHERE w.balance_rial <> p.total OR w.merged_into IS NOT NULL) THEN
    RAISE EXCEPTION 'Wallet consolidation balance invariant failed';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX wallets_owner_identity_idx ON wallets (id, user_id, currency);
--> statement-breakpoint
ALTER TABLE wallets ADD CONSTRAINT wallets_merge_same_owner_fk FOREIGN KEY (merged_into, user_id, currency) REFERENCES wallets (id, user_id, currency);
--> statement-breakpoint
CREATE UNIQUE INDEX wallets_one_active_per_user ON wallets (user_id) WHERE merged_into IS NULL;
--> statement-breakpoint
ALTER TABLE wallets ADD CONSTRAINT wallets_merge_state CHECK (currency = 'IRR' AND balance_rial BETWEEN 0 AND 9007199254740991
  AND (merged_into IS NULL OR (merged_into <> id AND balance_rial = 0)));
--> statement-breakpoint
CREATE INDEX wallet_tx_owner_key_idx ON wallet_transactions (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
-- Provision on any insert, including imports, within the same transaction as the user.
CREATE FUNCTION provision_user_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wallets (user_id, name, is_default) VALUES (NEW.id, 'کیف پول', true)
  ON CONFLICT (user_id) WHERE merged_into IS NULL DO NOTHING;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER provision_user_wallet AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION provision_user_wallet();
