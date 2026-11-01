import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { apiCreateIssue, expect, row, test } from './fixtures.ts';

const PORT = process.env.E2E_PORT ?? 3100;
const origin = `http://127.0.0.1:${PORT}`;

test('an edit in one browser appears live in another', async ({ page, browser }) => {
  const key = await apiCreateIssue(page.request, { title: 'Live original title' });
  await page.goto('/p/ENG');
  await expect(row(page, key)).toContainText('Live original title');
  await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-connected', 'true');

  // A second user in a separate browser context edits the issue.
  const other = await browser.newContext();
  const graceRequest = other.request;
  expect(
    (await graceRequest.post(`${origin}/api/v1/auth/dev-login`, { data: { user: 'grace' } })).ok(),
  ).toBe(true);
  const otherPage = await other.newPage();
  await otherPage.goto(`${origin}/i/${key}`);
  await otherPage.getByTestId('issue-title').fill('Live edited title');
  await otherPage.getByTestId('issue-title').press('Enter');

  // The first browser updates without a reload.
  await expect(row(page, key)).toContainText('Live edited title', { timeout: 2000 });

  // Moving it to the trash removes it from the list live.
  await graceRequest.delete(`${origin}/api/v1/issues/${key}`, { headers: { origin } });
  await expect(row(page, key)).toHaveCount(0, { timeout: 2000 });
  await other.close();
});

test('a board card moves live when another client changes its status', async ({ page }) => {
  const key = await apiCreateIssue(page.request, { title: 'Moved elsewhere', status: 'Todo' });
  await page.goto('/p/ENG/board');
  const todo = page.locator('[data-testid="board-column"][data-column="Todo"]');
  const done = page.locator('[data-testid="board-column"][data-column="Done"]');
  await expect(todo.locator(`[data-key="${key}"]`)).toBeVisible();
  await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-connected', 'true');
  // Change it through the API as if from another tool.
  await page.request.patch(`/api/v1/issues/${key}`, {
    data: { status: 'Done' },
    headers: { origin, 'x-request-id': 'external-1' },
  });
  await expect(done.locator(`[data-key="${key}"]`)).toBeVisible({ timeout: 2000 });
  await expect(todo.locator(`[data-key="${key}"]`)).toHaveCount(0);
});

test('an operator-tool write (another process, same database) appears in the browser', async ({
  page,
}) => {
  test.skip(
    !!process.env.E2E_DATABASE_URL?.startsWith('postgres'),
    'uses the SQLite e2e database file',
  );
  await page.goto('/p/ENG/board');
  await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-connected', 'true');
  const bin = fileURLToPath(new URL('../../cli/src/admin-bin.ts', import.meta.url));
  const db = fileURLToPath(new URL('../test-results/e2e.db', import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [bin, 'issue', 'create', '-P', 'ENG', '-t', 'Created by an agent via the CLI', '-q'],
    {
      env: {
        ...process.env,
        POIETIC_ISSUES_DATABASE_URL: `sqlite:${db}`,
        POIETIC_ISSUES_ACTOR: 'claude',
      },
    },
  );
  const key = stdout.trim();
  expect(key).toMatch(/^ENG-\d+$/);
  await expect(page.locator(`[data-testid="issue-card"][data-key="${key}"]`)).toBeVisible({
    timeout: 2000,
  });
});

test('a project created elsewhere appears in the sidebar live, on a page outside any project', async ({
  page,
}) => {
  await page.goto('/settings/webhooks');
  await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-connected', 'true');
  const key = `LV${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const res = await page.request.post('/api/v1/projects', {
    data: { key, name: 'Created live elsewhere' },
    headers: { origin, 'x-request-id': 'external-project-1' },
  });
  expect(res.ok()).toBe(true);
  await expect(page.getByRole('link', { name: /Created live elsewhere/ })).toBeVisible({
    timeout: 2000,
  });
});
