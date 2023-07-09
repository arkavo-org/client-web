import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
  await page.goto('http://localhost:5173/');

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/Vite/);
});

test('push the button', async ({ page }) => {
  await page.goto('http://localhost:5173/');
  // Push the button
  await page.getByRole('button', {}).click();
});
