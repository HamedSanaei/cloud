# Renewal incident #112

Read-only production audit on 2026-11-18 at 14:38 UTC. The production site
runtime contained the exact server, order and subscription. The queries used
read-only transactions. Times below are UTC.

## Reconciliation

| Check | Finding |
| --- | --- |
| Server | `qa-retest-804052`, Hetzner `hel1`, active since 2026-11-16 04:41:18 |
| Initial order | Hourly, paid on 2026-11-16 at 04:41:01. The paid invoice matches the purchase debit in the order's wallet. |
| Renewal history | All 15 paid renewal invoices match exactly one debit each, using the renewal idempotency key and invoice amount. Last debit on 2026-11-16 at 19:42:15. |
| Linkage | Subscription, server, order and wallet ownership agree. Auto-renew is enabled. |
| First unpaid boundary | 2026-11-16 20:41:18. No open renewal invoice or failed payment attempt exists for that boundary. |
| Historical FX | The latest EUR observation before the first boundary's 20:59:59.999 cutoff was 2026-10-15 21:30:15, outside the 24-hour limit. The first later observation was 2026-11-17 22:21:58. |
| Scope at audit | One active overdue subscription. Four overdue cancelled subscriptions belonged to terminated servers. Of the sample's 42 elapsed hourly boundaries, 26 had no eligible EUR observation and 16 had one but were queued behind the first gap. These are boundaries, not calculated amounts owed. |

The older paid invoices use the previous pricing path and do not carry an
FX-observation ID. The last successful sweep was on 2026-11-16 at 19:50:15.
The first failed sweep was at 19:51:15, when the [billing release for #94](https://github.com/HamedSanaei/cloud/actions/runs/43934483915/job/133566375109)
completed. The deployed worker keeps reporting missing valid FX for the
historic hour, even while the current EUR refresh succeeds. The historical
FX guard is doing its job. The defect is that one unpriceable period aborts
the sweep, so other due subscriptions can be skipped and the affected
subscription gets no durable record explaining why an invoice was withheld.

## Change and recovery

The sweep records one `subscription.renewal_blocked` audit entry per
subscription, period and cause under the existing subscription row lock.
It retains that period's original boundary and continues with the other
subscriptions. A failed FX warmup or funding forecast no longer blocks unrelated
renewals. The worker logs its blocked count. DB and unexpected exceptions still
fail the job. The existing invoice, debit, and period advancement transaction
is used for eligible renewals.

The affected subscription requires a separately approved reconciliation
decision. A new EUR observation cannot repair historical evidence. The code
does not assign a current rate to a past hour, skip or forgive the gap, create
a debt or debit the wallet for a blocked period. An operator should reconcile
provider usage, FX evidence and the ledger for the window before approving any
settlement or a new billing boundary. No customer balance, rate, server state
or production configuration was changed during this investigation.
