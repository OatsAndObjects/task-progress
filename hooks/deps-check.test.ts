import { expect, test } from 'claude-code/testing'

import { installedNames, missingDeps } from './deps-check'

test('none missing', () => {
  expect(missingDeps(['feature-dev', 'code-simplifier', 'x'])).toEqual({ missing: [], message: null })
})
test('one missing', () => {
  const r = missingDeps(['feature-dev'])
  expect(r.missing).toEqual(['code-simplifier'])
  expect(r.message).toContain('claude plugin install code-simplifier@claude-plugins-official')
})
test('both missing', () => {
  const r = missingDeps([])
  expect(r.missing).toEqual(['feature-dev', 'code-simplifier'])
  expect(r.message).toContain('needs feature-dev, code-simplifier')
})
test('any marketplace suffix matches', () => {
  expect(missingDeps(['feature-dev@anthropic-plugin-directory', 'code-simplifier@whatever']).message).toBe(null)
})
test('installedNames strips suffix and survives bad json', () => {
  expect(installedNames('{"plugins":{"a@m":[],"b":[]}}')).toEqual(['a', 'b'])
  expect(installedNames('nope')).toEqual([])
})
