import assert from 'node:assert/strict'
import test from 'node:test'

import { navigationUrl } from '../../src/cdp/browser.ts'

test('the current entry of navigation history is the URL', () => {
  assert.equal(
    navigationUrl({
      currentIndex: 1,
      entries: [{ url: 'https://www.zhipin.com/' }, { url: 'https://www.zhipin.com/web/geek/job' }],
    }),
    'https://www.zhipin.com/web/geek/job',
  )
})

test('unusable history yields undefined so the caller can fall back', () => {
  assert.equal(navigationUrl({}), undefined)
  assert.equal(navigationUrl({ currentIndex: 5, entries: [{ url: 'https://a' }] }), undefined)
  assert.equal(navigationUrl({ currentIndex: -1, entries: [] }), undefined)
  assert.equal(navigationUrl({ currentIndex: 0, entries: [{}] }), undefined)
  assert.equal(navigationUrl({ currentIndex: 0, entries: [{ url: '' }] }), undefined)
})
