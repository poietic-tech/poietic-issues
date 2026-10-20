import type { Command } from 'commander';
import { CliError, usage } from '../errors.ts';
import type { Tree } from '../tree/runtime.ts';

const list = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function registerWebhook(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent
    .command('webhook')
    .description('Push events to other services over HTTPS (admins; signed per Standard Webhooks)');
  cmd
    .command('list')
    .alias('ls')
    .description('List webhooks')
    .action(
      act(async (rt) => {
        const api = await rt.api();
        rt.out.list('webhook', (await rt.call(api.GET('/webhooks'))).data);
      }),
    );
  cmd
    .command('create')
    .description('Register a webhook; prints its signing secret (shown only now)')
    .argument('<url>', 'receiver URL (https)')
    .option('-e, --events <types>', 'comma-separated event types, `<noun>.*` or `*`', '*')
    .option('--scope <project>', 'only events from this project')
    .option('--description <text>', 'what the webhook is for')
    .option('--inactive', 'create it disabled')
    .action(
      act(async (rt, [url], o) => {
        const api = await rt.api();
        rt.out.item(
          'webhook',
          await rt.call(
            api.POST('/webhooks', {
              body: {
                url: String(url),
                eventTypes: list(String(o.events)),
                ...(o.scope !== undefined && { project: String(o.scope) }),
                ...(o.description !== undefined && { description: String(o.description) }),
                ...(o.inactive === true && { active: false }),
              },
            }),
          ),
          (w) =>
            `Created webhook ${String(w.id)}\nSigning secret (store it now; it is not shown again):\n${String(w.secret)}\n`,
        );
      }),
    );
  cmd
    .command('view')
    .description('Show a webhook')
    .argument('<id>', 'webhook id')
    .action(
      act(async (rt, [id]) => {
        const api = await rt.api();
        rt.out.item(
          'webhook',
          await rt.call(api.GET('/webhooks/{id}', { params: { path: { id: String(id) } } })),
        );
      }),
    );
  cmd
    .command('edit')
    .description('Change a webhook; --enable re-activates an automatically disabled one')
    .argument('<id>', 'webhook id')
    .option('--url <url>', 'receiver URL')
    .option('-e, --events <types>', 'comma-separated event types, `<noun>.*` or `*`')
    .option('--scope <project>', 'only events from this project; `all` removes the scope')
    .option('--description <text>', 'description')
    .option('--enable', 'activate')
    .option('--disable', 'deactivate')
    .action(
      act(async (rt, [id], o) => {
        if (o.enable && o.disable) throw usage('Use either --enable or --disable');
        const api = await rt.api();
        rt.out.item(
          'webhook',
          await rt.call(
            api.PATCH('/webhooks/{id}', {
              params: { path: { id: String(id) } },
              body: {
                ...(o.url !== undefined && { url: String(o.url) }),
                ...(o.events !== undefined && { eventTypes: list(String(o.events)) }),
                ...(o.scope !== undefined && {
                  project: o.scope === 'all' ? null : String(o.scope),
                }),
                ...(o.description !== undefined && { description: String(o.description) }),
                ...(o.enable === true && { active: true }),
                ...(o.disable === true && { active: false }),
              },
            }),
          ),
        );
      }),
    );
  cmd
    .command('delete')
    .alias('rm')
    .description('Delete a webhook and its delivery log')
    .argument('<id>', 'webhook id')
    .action(
      act(async (rt, [id]) => {
        const api = await rt.api();
        rt.out.item(
          'webhook',
          await rt.call(api.DELETE('/webhooks/{id}', { params: { path: { id: String(id) } } })),
          (w) => `Deleted webhook ${String(w.id)}\n`,
        );
      }),
    );
  cmd
    .command('rotate-secret')
    .description('Replace the signing secret; prints the new one')
    .argument('<id>', 'webhook id')
    .action(
      act(async (rt, [id]) => {
        const api = await rt.api();
        rt.out.item(
          'webhook',
          await rt.call(
            api.POST('/webhooks/{id}/rotate-secret', { params: { path: { id: String(id) } } }),
          ),
          (w) => `New signing secret for ${String(w.id)}:\n${String(w.secret)}\n`,
        );
      }),
    );
  cmd
    .command('test')
    .description('Send a signed webhook.ping now and show the answer (exit 6 unless it was 2xx)')
    .argument('<id>', 'webhook id')
    .action(
      act(async (rt, [id]) => {
        const api = await rt.api();
        const result = await rt.call(
          api.POST('/webhooks/{id}/test', { params: { path: { id: String(id) } } }),
        );
        rt.out.item('raw', result, (r) =>
          r.ok ? `OK: HTTP ${String(r.statusCode)} in ${String(r.durationMs)} ms\n` : '',
        );
        if (!result.ok)
          throw new CliError(
            'UNAVAILABLE',
            `Receiver did not accept the ping: ${result.error ?? `HTTP ${result.statusCode}`}`,
          );
      }),
    );
  cmd
    .command('deliveries')
    .description('Show recent deliveries, newest first')
    .argument('<id>', 'webhook id')
    .option('--status <status>', 'pending | succeeded | failed | dead')
    .option('--limit <n>', 'page size (1-200)', (v) => Number(v))
    .action(
      act(async (rt, [id], o) => {
        const api = await rt.api();
        rt.out.list(
          'webhookDelivery',
          await rt.call(
            api.GET('/webhooks/{id}/deliveries', {
              params: {
                path: { id: String(id) },
                query: {
                  ...(o.status !== undefined && {
                    status: String(o.status) as 'pending' | 'succeeded' | 'failed' | 'dead',
                  }),
                  ...(o.limit !== undefined && { limit: Number(o.limit) }),
                },
              },
            }),
          ),
        );
      }),
    );
  cmd
    .command('redeliver')
    .description('Send a delivery again (with a fresh set of retries)')
    .argument('<delivery>', 'delivery id (whd_…)')
    .action(
      act(async (rt, [id]) => {
        const api = await rt.api();
        rt.out.item(
          'webhookDelivery',
          await rt.call(
            api.POST('/webhook-deliveries/{id}/redeliver', {
              params: { path: { id: String(id) } },
            }),
          ),
        );
      }),
    );
  return cmd;
}
