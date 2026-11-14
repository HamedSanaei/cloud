import type { CustomerProvider, ManagementAction, ServerActionEvidence } from '../customer.interface.js'
import type { ProviderServerView } from '../provider.interface.js'
import { ProviderPermanentError, ProviderUnknownError } from '../../../lib/errors.js'
import { HetznerApiError, object, type HetznerClient } from './client.js'

export const hetznerCommands: Record<ManagementAction, string> = {
  power_on: 'poweron', shutdown: 'shutdown', power_off: 'poweroff', reboot: 'reboot', reset: 'reset', delete: 'delete_server',
  resize: 'change_type', rebuild: 'rebuild', reset_password: 'reset_password', enable_rescue: 'enable_rescue', disable_rescue: 'disable_rescue',
  attach_iso: 'attach_iso', detach_iso: 'detach_iso', change_protection: 'change_protection',
}
export function createCustomerProvider(resolve: (id: string) => { id: string; client: HetznerClient }, inspect: (id: string) => Promise<ProviderServerView>): CustomerProvider {
  return {
    inspect,
    async submit(id, action, input) {
      const route = resolve(id), command = hetznerCommands[action]
      let body: Record<string, unknown> | undefined
      if (action === 'resize') body = { server_type: input.serverType, upgrade_disk: input.upgradeDisk === true }
      if (action === 'rebuild') body = { image: Number(input.image) }
      if (action === 'enable_rescue') body = { type: 'linux64' }
      if (action === 'attach_iso') body = { iso: Number(input.iso) }
      if (action === 'change_protection') body = { delete: input.delete === true, rebuild: input.rebuild === true }
      const data = await route.client.request(action === 'delete' ? 'DELETE' : 'POST', action === 'delete' ? `/servers/${route.id}` : `/servers/${route.id}/actions/${command}`, body)
      const result = object(data.action)
      if (!Number.isSafeInteger(result.id) || Number(result.id) <= 0) throw new ProviderUnknownError('Provider action identity was not returned; manual reconciliation is required')
      if (result.status === 'error') throw new ProviderPermanentError('Hetzner rejected the action')
      return { actionId: Number(result.id), ...(typeof result.command === 'string' ? { command: result.command } : {}),
        ...(typeof data.root_password === 'string' && data.root_password.length <= 4096 ? { secret: data.root_password } : {}) }
    },
    async observe(id, actionId) {
      const route = resolve(id)
      if (!Number.isSafeInteger(actionId) || actionId <= 0) throw new ProviderPermanentError('Invalid action identity')
      const data = await route.client.request('GET', `/servers/${route.id}/actions/${actionId}`), action = object(data.action)
      if (action.id !== actionId || !['running', 'success', 'error'].includes(String(action.status)) || typeof action.command !== 'string') throw new ProviderUnknownError('Provider action identity or state was not verified')
      return { status: action.status as 'running' | 'success' | 'error', command: action.command,
        ...(action.status === 'error' ? { errorCode: 'provider_action_failed' } : {}) }
    },
    async actionHistory(id, actionId) {
      const route = resolve(id)
      const base = `/servers/${route.id}/actions`
      let data: { actions?: unknown }
      if (actionId === undefined) {
        // Missing or incomplete pagination must never prove that a request was not dispatched.
        const all: unknown[] = []
        let page = 1
        while (true) {
          const result = await route.client.request('GET', base + '?sort=started:desc&per_page=50&page=' + page)
          if (!Array.isArray(result.actions)) throw new ProviderUnknownError('Invalid Hetzner action page')
          all.push(...result.actions)
          if (all.length > 2_000) throw new ProviderUnknownError('Hetzner action history exceeds verification limit')
          const pagination = object(object(result.meta).pagination)
          if (pagination.page !== page || pagination.per_page !== 50 ||
            !Number.isSafeInteger(pagination.total_entries) || Number(pagination.total_entries) < 0 ||
            !Object.hasOwn(pagination, 'next_page')) throw new ProviderUnknownError('Hetzner pagination cannot be verified')
          if (pagination.next_page === null) {
            if (all.length !== pagination.total_entries) throw new ProviderUnknownError('Hetzner history was incomplete')
            break
          }
          if (typeof pagination.next_page !== 'number' || !Number.isSafeInteger(pagination.next_page) ||
            pagination.next_page <= page) throw new ProviderUnknownError('Hetzner pagination is inconsistent')
          page = pagination.next_page
        }
        data = { actions: all }
      } else {
        try { data = { actions: [(await route.client.request('GET', `${base}/${actionId}`)).action] } }
        catch (error) {
          if (error instanceof HetznerApiError && error.httpStatus === 404 && error.providerCode === 'not_found') return []
          throw error
        }
      }
      if (!Array.isArray(data.actions)) throw new ProviderUnknownError('Hetzner action history is unavailable')
      // A partially parsed history must NEVER be used as proof of non-dispatch.
      if (actionId === undefined && (data.actions.length > 2_000 ||
        data.actions.some(raw => {
          const action = object(raw)
          return typeof action.id !== 'number' || !Number.isSafeInteger(action.id) || action.id <= 0 ||
            typeof action.command !== 'string' || !['running', 'success', 'error'].includes(String(action.status)) ||
            typeof action.started !== 'string' || !Number.isFinite(Date.parse(action.started)) ||
            !Array.isArray(action.resources) ||
            !action.resources.map(object).some(resource => resource.type === 'server' && String(resource.id) === route.id)
        }))) throw new ProviderUnknownError('Hetzner full action history cannot be verified')
      return data.actions.map(object).flatMap(action => {
        const { id, command, status, started, finished } = action
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof command !== 'string' ||
          (status !== 'running' && status !== 'success' && status !== 'error') || typeof started !== 'string' ||
          !Number.isFinite(Date.parse(started)) || !Array.isArray(action.resources) ||
          !action.resources.map(object).some(resource => resource.type === 'server' && String(resource.id) === route.id)) return []
        const finishedAt = typeof finished === 'string' && Date.parse(finished) >= Date.parse(started) ? finished : null
        return [{ id, command, status, startedAt: started, finishedAt } satisfies ServerActionEvidence]
      })
    },
    async absent(id) {
      try { await inspect(id); return false } catch (error) {
        if (error instanceof HetznerApiError && error.httpStatus === 404 && error.providerCode === 'not_found') return true
        throw error
      }
    },
    async metrics(id, start, end, step) {
      const route = resolve(id), query = new URLSearchParams({ type: 'cpu,network,disk', start: start.toISOString(), end: end.toISOString(), step: String(step) })
      const data = await route.client.request('GET', `/servers/${route.id}/metrics?${query}`), metrics = object(data.metrics)
      const series: Record<string, Array<[number, number | null]>> = {}
      for (const [name, raw] of Object.entries(object(metrics.time_series))) {
        if (!/^(cpu$|network\.[\w.]+$|disk\.[\w.]+$)/.test(name)) continue
        const values = object(raw).values
        if (!Array.isArray(values)) continue
        series[name] = values.slice(0, 2500).filter(v => Array.isArray(v) && typeof v[0] === 'number' && Number.isFinite(v[0])).map(v => {
          const value = typeof v[1] === 'string' && v[1].trim() ? Number(v[1]) : NaN
          return [v[0] as number, Number.isFinite(value) ? value : null]
        })
      }
      return { start: start.toISOString(), end: end.toISOString(), step, series }
    },
    async images(id) {
      const route = resolve(id), server = await inspect(id), architecture = server.metadata?.architecture
      return (await route.client.pages('/images?type=system&status=available', 'images'))
        .filter(image => image.type === 'system' && image.status === 'available' && !image.deprecated && !image.deprecation && image.architecture === architecture && Number.isSafeInteger(image.id))
        .map(image => ({ id: String(image.id), name: String(image.description ?? image.name ?? image.id), architecture: String(image.architecture), minDiskGb: typeof image.disk_size === 'number' ? image.disk_size : 0 }))
    },
    async resizeOptions(id) {
      const route = resolve(id), server = await inspect(id), location = server.metadata?.location
      return (await route.client.pages('/server_types', 'server_types')).filter(type => !type.deprecated && !type.deprecation && type.architecture === server.metadata?.architecture)
        .flatMap(type => {
          const locations = Array.isArray(type.locations) ? type.locations.map(object) : []
          if (!locations.some(entry => (entry.name === location || entry.location === location || object(entry.location).name === location) && entry.available === true)) return []
          if (typeof type.name !== 'string' || typeof type.cores !== 'number' || typeof type.memory !== 'number' || typeof type.disk !== 'number' || typeof type.storage_type !== 'string') return []
          return [{ type: type.name, architecture: String(type.architecture), storageType: type.storage_type, vcpu: type.cores, memoryMb: Math.round(type.memory * 1024), diskGb: type.disk, available: true }]
        })
    },
    async console(id) {
      const route = resolve(id), data = await route.client.request('POST', `/servers/${route.id}/actions/request_console`)
      if (typeof data.wss_url !== 'string' || typeof data.password !== 'string' || data.password.length > 4096) throw new ProviderUnknownError('Console credentials were not returned')
      const url = new URL(data.wss_url)
      if (url.protocol !== 'wss:' || !url.hostname.endsWith('.hetzner.cloud') || url.username || url.password || (url.port && url.port !== '443')) throw new ProviderPermanentError('Provider console origin is not permitted')
      return { url: url.toString(), password: data.password }
    },
  }
}
