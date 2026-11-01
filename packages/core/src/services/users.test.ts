import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { withActor } from '../context.ts';
import { createTestContext, type TestContext } from '../testing.ts';
import { listEvents } from './events.ts';
import { createUser, getUser, toActor, updateUser } from './users.ts';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.destroy());

describe(`updateUser handle renames (${testDialect()})`, () => {
  it('lets an admin rename a user, keeping the id and recording the change', async () => {
    const before = await createUser(t.ctx, { handle: 'old-name', name: 'Old', kind: 'agent' });
    const after = await updateUser(t.ctx, 'old-name', { handle: 'New-Name' });
    expect(after).toMatchObject({ id: before.id, handle: 'new-name' });
    expect((await getUser(t.ctx, 'new-name')).id).toBe(before.id);
    await expect(getUser(t.ctx, 'old-name')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const events = (await listEvents(t.ctx, { types: ['user.updated'], limit: 1000 })).data;
    expect(events.at(-1)!.data.changes).toEqual({ handle: { from: 'old-name', to: 'new-name' } });
  });

  it('frees the old handle for another user', async () => {
    await createUser(t.ctx, { handle: 'swap-a', name: 'A' });
    const b = await createUser(t.ctx, { handle: 'swap-a-2', name: 'B' });
    await updateUser(t.ctx, 'swap-a', { handle: 'swap-a-legacy' });
    expect(await updateUser(t.ctx, 'swap-a-2', { handle: 'swap-a' })).toMatchObject({
      id: b.id,
      handle: 'swap-a',
    });
  });

  it('refuses a taken handle as a conflict', async () => {
    await createUser(t.ctx, { handle: 'taken-1', name: 'One' });
    await createUser(t.ctx, { handle: 'taken-2', name: 'Two' });
    await expect(updateUser(t.ctx, 'taken-2', { handle: 'TAKEN-1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await getUser(t.ctx, 'taken-2')).handle).toBe('taken-2');
  });

  it('refuses reserved handles, invalid handles and renaming the system user', async () => {
    await createUser(t.ctx, { handle: 'plain', name: 'Plain' });
    for (const handle of ['me', 'system', 'x', 'has space'])
      await expect(updateUser(t.ctx, 'plain', { handle })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    await expect(updateUser(t.ctx, 'system', { handle: 'robot' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('is admin only, even for your own handle', async () => {
    const self = await createUser(t.ctx, { handle: 'selfie', name: 'Self' });
    for (const who of [withActor(t.ctx, toActor(self)), t.member])
      await expect(updateUser(who, 'selfie', { handle: 'selfie-2' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
  });
});
