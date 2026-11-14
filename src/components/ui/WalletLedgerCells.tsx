import { Link } from 'react-router-dom'
import type { Transaction } from '../../lib/types'
import { emptyAmount, transactionCategory } from '../../lib/walletHistory'

export function WalletLedgerAmountCells({ amounts }: { amounts: [string, string] }) {
  return <><td className="ledger-amount ledger-amount--credit"><bdi>{amounts[0]}</bdi></td>
    <td className="ledger-amount ledger-amount--debit"><bdi>{amounts[1]}</bdi></td></>
}

export function WalletLedgerDescription({ transaction, admin = false }: {
  transaction: Pick<Transaction, 'description' | 'type' | 'referenceId' | 'referenceType'>; admin?: boolean
}) {
  const { description, referenceId, referenceType } = transaction
  const category = transactionCategory(transaction)
  const isServer = referenceType === 'primary_ipv4_replacement' || referenceType === 'server'
  const path = isServer ? (admin ? '/admin/servers/' : '/servers/') : admin && referenceType === 'order' ? '/admin/orders/' : null
  return <><span>{description || category}</span>
    {description && category !== emptyAmount && category !== description && <small className="ledger-reference">{category}</small>}
    {referenceId && <small className="ledger-reference">مرجع {referenceType && <bdi>{referenceType}</bdi>}{' '}
      {path ? <Link to={path + encodeURIComponent(referenceId)}><bdi>{referenceId}</bdi></Link> : <bdi>{referenceId}</bdi>}
    </small>}</>
}
