import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Pure JS helper is also consumed by screenshot runners.
import { compareRegion } from './visual/compare.mjs'

const baseline = JSON.parse(readFileSync('test/visual/penpot-reference.json', 'utf8'))
const mapping = JSON.parse(readFileSync('test/visual/regions.json', 'utf8'))

describe('Penpot-derived visual contract (not pixel approval)', () => {
  it('resolves every measured selector to an actual Penpot shape', () => {
    for (const [route, regions] of Object.entries(mapping.screens)) {
      const screen = baseline.screens.find((s: { route: string }) => s.route === route)
      expect(screen, route).toBeTruthy()
      for (const name of Object.values(regions as Record<string, string>)) expect(screen.shapes.some((shape: { name: string }) => shape.name === name), `${route}: ${name}`).toBe(true)
    }
  })
  it('fails on missing regions, geometry regressions and changed colors', () => {
    const reference = { x: 48, y: 344, width: 366, height: 132, radius: 16, fill: '#ffffff' }
    const actual = { x: 48, y: 344, width: 366.02, height: 132, radius: 16, background: 'rgb(255, 255, 255)' }
    expect(compareRegion(reference, actual)).toEqual([])
    expect(compareRegion(reference, null)).toHaveLength(1)
    expect(compareRegion(reference, { ...actual, y: 350 })).toEqual([expect.objectContaining({ property: 'y' })])
    expect(compareRegion(reference, { ...actual, background: 'rgb(0, 0, 0)' })).toEqual([expect.objectContaining({ property: 'background' })])
  })
})
