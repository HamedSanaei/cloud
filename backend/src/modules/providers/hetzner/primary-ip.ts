import { isIPv4 } from 'node:net'
import { ProviderUnknownError } from '../../../lib/errors.js'
import type { PrimaryIpv4, PrimaryIpv4Provider } from '../customer.interface.js'
import { HetznerApiError, object, type HetznerClient } from './client.js'

const label = 'parserver-ip-operation'
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const invalid = () => new ProviderUnknownError('Hetzner did not prove the Primary IPv4 resource or action identity')

function parseIp(raw: unknown): PrimaryIpv4 {
  const ip = object(raw), location = object(ip.location).name
  if (!validId(ip.id) || ip.type !== 'ipv4' || typeof ip.ip !== 'string' || !isIPv4(ip.ip) ||
    typeof location !== 'string' || typeof ip.auto_delete !== 'boolean' || typeof ip.blocked !== 'boolean' ||
    typeof object(ip.protection).delete !== 'boolean' || (ip.assignee_id !== null &&
      (!validId(ip.assignee_id) || ip.assignee_type !== 'server'))) throw invalid()
  return { id: ip.id, address: ip.ip, location, serverId: ip.assignee_id === null ? null : String(ip.assignee_id),
    autoDelete: ip.auto_delete, protected: object(ip.protection).delete === true, blocked: ip.blocked,
    customReverseDns: Array.isArray(ip.dns_ptr) && ip.dns_ptr.some(entry => {
      const ptr = object(entry).dns_ptr
      return typeof ptr === 'string' && !ptr.endsWith('.your-cloud.host')
    }) }
}

export function createPrimaryIpv4Provider(resolve: (server: string) => { id: string; client: HetznerClient }): PrimaryIpv4Provider {
  async function mutate(server: string, ip: number, command: 'assign' | 'unassign') {
    const { client, id } = resolve(server)
    const { action } = await client.request('POST', `/primary_ips/${ip}/actions/${command}`,
      command === 'assign' ? { assignee_id: Number(id), assignee_type: 'server' } : undefined)
    const receipt = object(action)
    if (!validId(receipt.id) || receipt.command !== `${command}_primary_ip`) throw invalid()
    return receipt.id
  }
  return {
    async read(server, id) {
      try {
        const ip = parseIp((await resolve(server).client.request('GET', `/primary_ips/${id}`)).primary_ip)
        if (ip.id !== id) throw invalid()
        return ip
      } catch (error) {
        if (error instanceof HetznerApiError && error.httpStatus === 404 && error.providerCode === 'not_found') return null
        throw error
      }
    },
    async findReplacement(server, operationId) {
      const rows = await resolve(server).client.pages(`/primary_ips?label_selector=${encodeURIComponent(`${label}=${operationId}`)}`, 'primary_ips')
      if (rows.length > 1 || rows.some(row => object(row.labels)[label] !== operationId)) throw invalid()
      return rows[0] ? parseIp(rows[0]) : null
    },
    async create(server, location, operationId) {
      const { primary_ip: raw, action } = await resolve(server).client.request('POST', '/primary_ips', {
        type: 'ipv4', location, name: `parserver-${operationId}`, auto_delete: true, labels: { [label]: operationId },
      })
      const ip = parseIp(raw)
      if (ip.location !== location || ip.serverId !== null || object(object(raw).labels)[label] !== operationId) throw invalid()
      if (action == null) return { ipId: ip.id, actionId: null }
      const receipt = object(action)
      if (!validId(receipt.id) || receipt.command !== 'create_primary_ip') throw invalid()
      return { ipId: ip.id, actionId: receipt.id }
    },
    assign: (server, id) => mutate(server, id, 'assign'),
    unassign: (server, id) => mutate(server, id, 'unassign'),
    async remove(server, id) {
      // Hetzner returns HTTP 204 for a successful DELETE; existence is checked afterward.
      await resolve(server).client.request('DELETE', `/primary_ips/${id}`)
    },
    async observe(server, actionId, target, command) {
      const scope = target.type === 'server' ? 'servers' : 'primary_ips'
      const { action: raw } = await resolve(server).client.request('GET', `/${scope}/actions/${actionId}`)
      const action = object(raw)
      if (action.id !== actionId || action.command !== command || !Array.isArray(action.resources) ||
        !action.resources.some(resource => object(resource).id === target.id && object(resource).type === target.type) ||
        (action.status !== 'running' && action.status !== 'success' && action.status !== 'error')) throw invalid()
      return action.status
    },
  }
}
