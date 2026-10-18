/** Pure visual-contract comparison. This is deliberately NOT a pixel-diff test. */
export function compareRegion(reference, actual, tolerance = 1) {
  const failures = []
  if (!actual) return [{ property: 'element', expected: 'present', actual: 'missing' }]
  for (const property of ['x', 'y', 'width', 'height', 'radius']) {
    if (typeof reference[property] !== 'number') continue
    if (!Number.isFinite(actual[property]) || Math.abs(reference[property] - actual[property]) > tolerance) {
      failures.push({ property, expected: reference[property], actual: actual[property] })
    }
  }
  if (reference.fill) {
    const rgb = reference.fill.slice(1).match(/../g).map(hex => parseInt(hex, 16)).join(', ')
    if (actual.background !== `rgb(${rgb})`) failures.push({ property: 'background', expected: reference.fill, actual: actual.background })
  }
  return failures
}
