import { apiCreateIssue, expect, openList, row, test } from './fixtures.ts';

test('sets, shows, filters and clears an issue type, and records the change', async ({ page }) => {
  const key = await apiCreateIssue(page.request, { title: 'Needs a type' });
  await page.goto(`/i/${key}`);
  const detail = page.getByTestId('issue-detail');
  await expect(detail.getByTestId('type-picker')).toContainText('Set type');
  await detail.getByTestId('type-picker').click();
  await page.getByRole('option', { name: 'Bug' }).click();
  await expect(detail.getByTestId('type-picker')).toContainText('Bug');
  await expect(detail.getByTestId('activity')).toContainText('set type to Bug');

  await page.reload();
  await expect(detail.getByTestId('type-picker')).toContainText('Bug');

  // The Type quick filter narrows the list to bugs.
  await openList(page);
  await page.getByTestId('filter-type').click();
  await page.getByRole('option', { name: 'Bug' }).click();
  await page.keyboard.press('Escape');
  await expect(row(page, key)).toBeVisible();
  // Seeded issues of other types, or none, drop out.
  await expect(
    page.getByTestId('issue-row').filter({ hasText: 'Write the API guide' }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('issue-row').filter({ hasText: 'Kanban board with customizable cards' }),
  ).toHaveCount(0);

  await page.goto(`/i/${key}`);
  await detail.getByTestId('type-picker').click();
  await page.getByRole('option', { name: 'No type' }).click();
  await expect(detail.getByTestId('activity')).toContainText('removed the type');
});

test('creates an issue with a type from the create dialog', async ({ page }) => {
  await openList(page);
  await page.keyboard.press('c');
  const dialog = page.getByTestId('create-issue-dialog');
  await dialog.getByTestId('create-title').fill('Typed from the dialog');
  await dialog.getByTestId('create-type').click();
  await page.getByRole('option', { name: 'Task' }).click();
  await expect(dialog.getByTestId('create-type')).toContainText('Task');
  await dialog.getByTestId('create-submit').click();
  await expect(dialog).toBeHidden();
  const created = page.getByTestId('issue-row').filter({ hasText: 'Typed from the dialog' });
  await created.click();
  await expect(page.getByTestId('type-picker').first()).toContainText('Task');
});

test('adds, renames and deletes an issue type in project settings', async ({ page }) => {
  await page.goto('/p/ENG/settings');
  const section = page.getByTestId('settings-types');
  await expect(section.getByLabel('Type name', { exact: true })).toHaveCount(3);
  const name = `Spike ${Date.now()}`;
  await section.getByLabel('New type name').fill(name);
  await section.getByRole('button', { name: 'Add type' }).click();
  await expect(section.getByLabel('Type name', { exact: true })).toHaveCount(4);
  const field = section.getByLabel('Type name', { exact: true }).last();
  await expect(field).toHaveValue(name);
  await field.fill(`${name} renamed`);
  await field.press('Enter');
  await expect(page.getByText(`Saved “${name} renamed”`)).toBeVisible();
  await section.getByRole('button', { name: `Delete type ${name} renamed` }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(section.getByLabel('Type name', { exact: true })).toHaveCount(3);
});
