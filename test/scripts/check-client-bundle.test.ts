import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'

import { BUNDLE_PATH, PACKAGE_NAME, checkBundle } from '../../scripts/check-client-bundle.ts'

/** A minimal bundle in the shape the Web boot can load. */
const CLASSIC = `window.__ModuleLoader__.load({
  id: "${PACKAGE_NAME}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    exports.apply = function apply() {};
    return module.exports;
  }
});`

/** @param source bundle text @returns the rules that fired */
function fired(source: string): string[] {
  return checkBundle(source).map((problem) => problem.rule)
}

test('the shape the Web boot loads passes', () => {
  assert.deepEqual(fired(CLASSIC), [])
})

test('an ESM bundle is rejected with the error the browser actually throws', () => {
  const problems = checkBundle('import { useState } from "react"\nexport function apply() {}\n')

  assert.deepEqual(
    problems.map((problem) => problem.rule),
    ['classic-script'],
  )
  // This is the exact message a `<script>` gets, and the reason the entry never activated.
  assert.match(problems[0]?.problem ?? '', /Cannot use import statement outside a module/)
})

test('a bundle that runs but registers nothing is caught', () => {
  assert.deepEqual(fired('var answer = 42;\n'), ['registers-factory'])
})

test('a bundle registered under another id is caught', () => {
  const problems = checkBundle(CLASSIC.replaceAll(PACKAGE_NAME, 'some-other-plugin'))

  assert.deepEqual(
    problems.map((problem) => problem.rule),
    ['registration-id'],
  )
  assert.match(problems[0]?.problem ?? '', /some-other-plugin/)
})

test('the built bundle on disk is loadable as a classic script', (t) => {
  if (!existsSync(BUNDLE_PATH)) {
    // lib/ is gitignored build output, and `pnpm check` runs tests before the build.
    t.skip(`${BUNDLE_PATH} is not built; run pnpm build`)
    return
  }
  assert.deepEqual(checkBundle(readFileSync(BUNDLE_PATH, 'utf8')), [])
})
