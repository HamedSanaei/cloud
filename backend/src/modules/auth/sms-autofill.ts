export function isDomainBoundLoginPattern(pattern: string, frontendUrl: string): boolean {
  const { protocol, port, hostname } = new URL(frontendUrl)
  const lines = pattern.split('\n')
  return protocol === 'https:' && !port && /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(hostname) &&
    !pattern.includes('\r') && lines.pop() === `@${hostname} #%%` &&
    lines.join('\n').split('%%').length === 2
}
