import { expect, test } from '@playwright/test'
import { checkFormProviders } from '../src/forms/provider-check'

test('reports signed-out providers', async ({ page }) => {
  expect(
    await checkFormProviders(page, ['google', 'microsoft'], {
      urls: { google: '/forms-home.html', microsoft: '/forms-signin.html' }
    })
  ).toEqual(['microsoft'])
})
