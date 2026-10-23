import { expect, test } from '@playwright/test';

const SSO = {
  name: 'Example',
  loginUrl: 'https://auth.example.test/login',
  refreshUrl: 'https://auth.example.test/me',
  sessionSeconds: 120,
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/config', (r) =>
    r.fulfill({ json: { devLogin: false, sso: SSO } }),
  );
  await page.route('https://auth.example.test/me', (r) => r.fulfill({ status: 200, json: {} }));
});

test('shows the pending screen when the account awaits approval', async ({ page }) => {
  await page.route('**/api/v1/auth/sso', (r) =>
    r.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'urn:tracker:error:PENDING_APPROVAL',
        title: 'Awaiting approval',
        status: 403,
        code: 'PENDING_APPROVAL',
        detail: '@pat is waiting for an admin to approve access',
      }),
    }),
  );
  await page.goto('/login');
  await expect(page.getByText('Waiting for approval')).toBeVisible();
  await expect(page.getByText('@pat is waiting')).toBeVisible();
  await expect(page.getByText('poietic-tech issues user edit <handle> --reactivate')).toBeVisible();
});

test('offers SSO and no API-token form', async ({ page }) => {
  await page.route('**/api/v1/auth/sso', (r) =>
    r.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'urn:tracker:error:UNAUTHENTICATED',
        title: 'Authentication required',
        status: 401,
        code: 'UNAUTHENTICATED',
      }),
    }),
  );
  await page.goto('/login?signedout=1');
  await expect(page.getByRole('button', { name: 'Sign in with Example' })).toBeVisible();
  await expect(page.getByLabel('API token')).toHaveCount(0);
  await expect(page.getByText(/token create|use a token/)).toHaveCount(0);
});

test('sends a signed-out visitor to the SSO login with a redirect back', async ({ page }) => {
  await page.route('**/api/v1/auth/sso', (r) =>
    r.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'urn:tracker:error:UNAUTHENTICATED',
        title: 'Authentication required',
        status: 401,
        code: 'UNAUTHENTICATED',
      }),
    }),
  );
  await page.route('https://auth.example.test/login**', (r) =>
    r.fulfill({ status: 200, body: 'login page' }),
  );
  await page.goto('/login?next=%2Fp%2FENG');
  const button = page.getByRole('button', { name: 'Sign in with Example' });
  await expect(button).toBeVisible(); // the automatic attempt got a 401 and stayed put
  await button.click();
  await page.waitForURL(/auth\.example\.test\/login/);
  const redirect = new URL(page.url()).searchParams.get('redirect')!;
  expect(new URL(redirect).pathname).toBe('/login');
  expect(new URL(redirect).searchParams.get('next')).toBe('/p/ENG');
});

test('enters the app when SSO sign-in succeeds', async ({ page }) => {
  // Sign in for real via dev login, then let the mocked SSO call report success.
  const user = await (
    await page.request.post('/api/v1/auth/dev-login', { data: { user: 'ada' } })
  ).json();
  await page.route('**/api/v1/auth/sso', (r) => r.fulfill({ status: 200, json: user }));
  await page.goto('/login?next=%2Fp%2FENG');
  await page.waitForURL(/\/p\/ENG/);
});

test('does not sign back in silently after signing out', async ({ page }) => {
  const user = await (
    await page.request.post('/api/v1/auth/dev-login', { data: { user: 'ada' } })
  ).json();
  let ssoCalls = 0;
  await page.route('**/api/v1/auth/sso', (r) => {
    ssoCalls++;
    return r.fulfill({ status: 200, json: user });
  });
  await page.goto('/login?signedout=1&next=%2Fp%2FENG');
  await expect(page.getByRole('button', { name: 'Sign in with Example' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(page.url()).toContain('/login');
  expect(ssoCalls).toBe(0);
});

test('signing out from the app lands on the login page without re-signing in', async ({ page }) => {
  await page.request.post('/api/v1/auth/dev-login', { data: { user: 'ada' } });
  let ssoCalls = 0;
  await page.route('**/api/v1/auth/sso', (r) => {
    ssoCalls++;
    return r.fulfill({ status: 200, json: {} });
  });
  await page.goto('/');
  await page.getByTestId('logout').click();
  await page.waitForURL(/\/login\?signedout=1/);
  await expect(page.getByRole('button', { name: 'Sign in with Example' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(page.url()).toContain('/login');
  expect(ssoCalls).toBe(0);
});

test('a visitor already signed in to SSO lands in a private project, not on "not found"', async ({
  page,
}) => {
  let ssoCalls = 0;
  // The issuer's cookie is valid: the server signs the browser in (dev login stands in for the real exchange).
  await page.route('**/api/v1/auth/sso', async (r) => {
    ssoCalls++;
    const res = await page.request.post('/api/v1/auth/dev-login', { data: { user: 'ada' } });
    await r.fulfill({ status: 200, json: await res.json() });
  });
  await page.goto('/p/OPS');
  await expect(page.getByTestId('issue-row').first()).toBeVisible();
  await expect(page.getByTestId('logout')).toBeVisible();
  await expect(page).toHaveURL(/\/p\/OPS$/);
  expect(ssoCalls).toBe(1);
});

test('a failed silent SSO attempt leaves the visitor browsing signed out', async ({ page }) => {
  let ssoCalls = 0;
  await page.route('**/api/v1/auth/sso', (r) => {
    ssoCalls++;
    return r.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({ status: 401, code: 'UNAUTHENTICATED', title: 'Unauthenticated' }),
    });
  });
  await page.goto('/p/OPS');
  await expect(page.getByTestId('project-not-found')).toBeVisible();
  await expect(page).toHaveURL(/\/p\/OPS$/);
  // Once per browser session: moving around does not try again.
  // The home page opens the public project (the seeded ENG) rather than the sign-in gate.
  await page.goto('/');
  await expect(page).toHaveURL(/\/p\/ENG/);
  await expect(page.getByTestId('issue-row').first()).toBeVisible();
  expect(ssoCalls).toBe(1);
});

test('after signing out, the next visit does not sign back in silently', async ({ page }) => {
  let ssoCalls = 0;
  await page.route('**/api/v1/auth/sso', (r) => {
    ssoCalls++;
    return r.fulfill({ status: 200, json: {} });
  });
  await page.request.post('/api/v1/auth/dev-login', { data: { user: 'ada' } });
  await page.goto('/p/ENG');
  await page.getByTestId('logout').click();
  await page.waitForURL(/\/login\?signedout=1/);
  await page.goto('/p/OPS');
  await expect(page.getByTestId('project-not-found')).toBeVisible();
  await page.waitForTimeout(300);
  expect(ssoCalls).toBe(0);
});

test('keeps renewing an SSO session while the app is open', async ({ page }) => {
  await page.clock.install();
  let ssoCalls = 0;
  await page.route('**/api/v1/auth/sso', async (r) => {
    ssoCalls++;
    const res = await page.request.post('/api/v1/auth/dev-login', { data: { user: 'ada' } });
    await r.fulfill({ status: 200, json: await res.json() });
  });
  await page.goto('/login?next=%2Fp%2FENG');
  await page.waitForURL(/\/p\/ENG/);
  await expect(page.getByTestId('logout')).toBeVisible();
  expect(ssoCalls).toBe(1);
  // Half the 120 s lifetime later the next minute's check renews it.
  await page.clock.fastForward('00:59');
  expect(ssoCalls).toBe(1);
  await page.clock.fastForward('00:02');
  await expect.poll(() => ssoCalls).toBe(2);
});

test('never renews a session that did not come from SSO', async ({ page }) => {
  await page.clock.install();
  await page.request.post('/api/v1/auth/dev-login', { data: { user: 'ada' } });
  let ssoCalls = 0;
  await page.route('**/api/v1/auth/sso', (r) => {
    ssoCalls++;
    return r.fulfill({ status: 200, json: {} });
  });
  await page.goto('/p/ENG');
  await expect(page.getByTestId('logout')).toBeVisible();
  await page.clock.fastForward('05:00');
  await page.waitForTimeout(200);
  expect(ssoCalls).toBe(0);
});
