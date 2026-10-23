import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, ModuleContext } from '@poietic-tech/cli/module';
import { createProject, LocalDiskBlobStore } from '@poietic-tech/issues-core';
import { createTestContext, type TestContext } from '@poietic-tech/issues-core/testing';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { createApp } from '@poietic-tech/issues-server';
import { Command, Option } from 'commander';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderCliReference } from '../reference.ts';
import { registerTree } from '../tree/index.ts';
import type { Tree } from '../tree/runtime.ts';
import mod, { setup } from './index.ts';

let t: TestContext;
let asAdmin: (r: Request) => Promise<Response>;
let asMember: (r: Request) => Promise<Response>;
const dir = mkdtempSync(join(tmpdir(), 'issues-module-'));

/** A problem+json answer, as the server sends one. */
function problem(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({ type: `urn:tracker:error:${code}`, title: detail, status, code, detail }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

interface Recorded {
  method: string;
  args: unknown[];
}

/**
 * The module set up on `poietic-tech issues`, the way the host does it: a real commander root with the host's
 * global options, a fake ModuleContext that records output, and a caller whose fetch reaches the in-process app.
 */
function harness(
  opts: {
    fetch?: (r: Request) => Promise<Response>;
    env?: Record<string, string>;
    caller?: () => Promise<Caller>;
    cwd?: string;
  } = {},
) {
  const calls = { caller: 0, fetch: 0, keys: [] as (string | null)[] };
  const recorded: Recorded[] = [];
  let raw = '';
  const program = new Command('poietic-tech')
    .option('--json', 'same as --format json')
    .addOption(
      new Option('--format <format>', 'output format').choices(['table', 'json', 'ndjson', 'ids']),
    )
    .option('-q, --quiet', 'print only what was asked for')
    .option('--server <origin>', 'the auth server to use')
    .option('--no-wait', 'fail instead of waiting for a step-up')
    .option('--no-color', 'never colour output');
  const cmd = program.command('issues').description('Issue tracker at issues.poietic.tech');
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      void recorded.push({ method, args });
  const caller: Caller = {
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      calls.fetch++;
      const request = new Request(input, init);
      calls.keys.push(request.headers.get('idempotency-key'));
      return (opts.fetch ?? asAdmin)(request);
    },
  } as unknown as Caller;
  const ctx: ModuleContext = {
    program: cmd,
    caller: async () => {
      calls.caller++;
      return opts.caller ? opts.caller() : caller;
    },
    output: {
      item: record('item'),
      list: record('list'),
      message: record('message'),
      warn: record('warn'),
      secret: record('secret'),
      raw: (chunk: string | Uint8Array) => {
        raw += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      },
    },
    fail(code: string, message: string, o?: { status?: number }): never {
      throw { code, message, ...(o?.status !== undefined && { status: o.status }) };
    },
    stepUp: async () => {},
    server: 'https://auth.poietic.tech',
    env: { POIETIC_ISSUES_PROJECT: 'CLI', ...opts.env },
    version: { host: '0.2.0', api: [1] },
  };
  setup(ctx, {
    cwd: opts.cwd ?? dir,
    readStdin: async () => '',
  });
  let help = '';
  const configure = (c: Command) => {
    c.exitOverride().configureOutput({
      writeOut: (s) => (help += s),
      writeErr: (s) => (help += s),
      outputError: () => {},
    });
    c.commands.forEach(configure);
  };
  configure(program);
  return {
    cmd,
    calls,
    recorded,
    raw: () => raw,
    help: () => help,
    run: (args: string[]) => program.parseAsync(['issues', ...args], { from: 'user' }),
    last: (method: string) => recorded.filter((r) => r.method === method).at(-1)!,
  };
}

beforeAll(async () => {
  t = await createTestContext();
  await createProject(t.ctx, { key: 'CLI', name: 'CLI' });
  const app = (actor: string) =>
    createApp({
      db: t.db,
      auth: { mode: 'trusted', actor },
      blobStore: new LocalDiskBlobStore(join(dir, 'blobs')),
    });
  const admin = app('admin');
  const member = app('member');
  asAdmin = (r) => Promise.resolve(admin.fetch(r));
  asMember = (r) => Promise.resolve(member.fetch(r));
});
afterAll(async () => {
  await t.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe(`the poietic-tech issues module (${testDialect()})`, () => {
  it('default-exports API version 1 and its setup', () => {
    expect(mod.api).toBe(1);
    expect(mod.setup).toBe(setup);
  });

  it('creates an issue and hands it to ctx.output.item', async () => {
    const h = harness();
    await h.run(['issue', 'create', '-t', 'T']);
    const [obj, columns] = h.last('item').args as [
      Record<string, unknown>,
      [string, (r: unknown) => unknown][],
    ];
    expect(obj).toMatchObject({ key: 'CLI-1', title: 'T' });
    expect(columns.map(([header]) => header)).toContain('KEY');
    expect(h.calls.caller).toBe(1);
  });

  it('lists through ctx.output.list with --fields columns, projected rows and an id per row', async () => {
    const h = harness({ env: { POIETIC_ISSUES_PROJECT: '' } });
    await h.run(['-P', 'CLI', 'issue', 'list', '--fields', 'key,title']);
    const [rows, { columns, id }] = h.last('list').args as [
      Record<string, unknown>[],
      { columns: [string, (r: unknown) => unknown][]; id: (r: unknown) => string },
    ];
    expect(columns.map(([header]) => header)).toEqual(['KEY', 'TITLE']);
    expect(rows[0]).toEqual({ key: 'CLI-1', title: 'T' });
    expect(columns.map(([, get]) => get(rows[0]))).toEqual(['CLI-1', 'T']);
    expect(id(rows[0])).toBe('CLI-1');
  });

  it('gives -q the issue key on a single item, even when --fields leaves it out (host 0.2.0 item id)', async () => {
    const h = harness();
    await h.run(['--fields', 'title', 'issue', 'view', 'CLI-1']);
    const [obj, , opts] = h.last('item').args as [
      Record<string, unknown>,
      unknown,
      { id: (o: unknown) => string },
    ];
    expect(obj).toEqual({ title: 'T' });
    expect(opts.id(obj)).toBe('CLI-1');
  });

  it('shows an issue description as a multiline column', async () => {
    const h = harness();
    await h.run(['issue', 'view', 'CLI-1']);
    const [, columns] = h.last('item').args as [
      unknown,
      [string, unknown, { multiline?: boolean }?][],
    ];
    const description = columns.find(([header]) => header === 'DESCRIPTION');
    expect(description?.[2]).toEqual({ multiline: true });
  });

  it('hands the next cursor to ctx.output.list, and null on the last page', async () => {
    const setupHarness = harness();
    await setupHarness.run(['issue', 'create', '-t', 'Second']);
    const h = harness();
    await h.run(['issue', 'list', '--limit', '1']);
    const [, first] = h.last('list').args as [unknown, { nextCursor: string | null }];
    expect(typeof first.nextCursor).toBe('string');
    expect(h.last('message').args[0]).toContain(`--cursor ${first.nextCursor}`);
    const next = harness();
    await next.run(['issue', 'list', '--limit', '1', '--cursor', first.nextCursor!]);
    const [, last] = next.last('list').args as [unknown, { nextCursor: string | null }];
    expect(last.nextCursor).toBeNull();
  });

  it('uses the per-kind columns without --fields', async () => {
    const h = harness();
    await h.run(['issue', 'list']);
    const [, { columns }] = h.last('list').args as [unknown, { columns: [string][] }];
    expect(columns.map(([header]) => header)).toEqual([
      'KEY',
      'STATUS',
      'PRI',
      'ASSIGNEE',
      'LABELS',
      'TITLE',
    ]);
  });

  it('gives webhook signing secrets to ctx.output.secret', async () => {
    const h = harness();
    await h.run(['webhook', 'create', 'https://hooks.example.com/in']);
    const [secret, warning, extra] = h.last('secret').args as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(secret).toMatch(/^whsec_/);
    expect(warning).toMatch(/not shown again/);
    expect(extra).toMatchObject({ url: 'https://hooks.example.com/in' });
    expect(extra).not.toHaveProperty('secret');
  });

  describe('maps every row of the error table', () => {
    it('NOT_FOUND → not_found', async () => {
      await expect(harness().run(['issue', 'view', 'CLI-999'])).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('VALIDATION_FAILED from the server → bad_request, with its field errors', async () => {
      const failure = harness().run(['issue', 'create', '--input', '{"title":"x","priority":9}']);
      await expect(failure).rejects.toMatchObject({ code: 'bad_request', status: 400 });
      await expect(failure).rejects.toMatchObject({
        message: expect.stringMatching(/\n {2}priority: /),
      });
    });

    it('VERSION_MISMATCH → version_mismatch with status 409', async () => {
      await expect(
        harness().run(['issue', 'edit', 'CLI-1', '-t', 'U', '--if-version', '99']),
      ).rejects.toMatchObject({ code: 'version_mismatch', status: 409 });
    });

    it('FORBIDDEN → not_allowed', async () => {
      await expect(
        harness({ fetch: (r) => asMember(r) }).run(['webhook', 'list']),
      ).rejects.toMatchObject({ code: 'not_allowed' });
    });

    it('UNAUTHENTICATED (401) → not_logged_in', async () => {
      const fetch = async () => problem(401, 'UNAUTHENTICATED', 'Authentication required');
      await expect(harness({ fetch }).run(['issue', 'list'])).rejects.toMatchObject({
        code: 'not_logged_in',
      });
    });

    it('UNAVAILABLE (503) → server_error', async () => {
      const fetch = async () => problem(503, 'UNAVAILABLE', 'Service unavailable');
      await expect(harness({ fetch }).run(['issue', 'list'])).rejects.toMatchObject({
        code: 'server_error',
      });
    });

    it.each([
      [429, 'server_error'],
      [500, 'server_error'],
      [502, 'server_error'],
      [504, 'server_error'],
      [401, 'not_logged_in'],
      [403, 'not_allowed'],
      [404, 'not_found'],
      [400, 'bad_request'],
      [418, 'bad_request'],
    ])('an answer that is not a problem document maps by status: %i → %s', async (code, host) => {
      const fetch = async () =>
        new Response('<html>Rate limited</html>', {
          status: code,
          headers: { 'content-type': 'text/html' },
        });
      await expect(harness({ fetch }).run(['issue', 'list'])).rejects.toMatchObject({
        code: host,
        status: code,
      });
    });

    it('a real INTERNAL problem (500) stays internal', async () => {
      const fetch = async () => problem(500, 'INTERNAL', 'Internal error');
      await expect(harness({ fetch }).run(['issue', 'list'])).rejects.toMatchObject({
        code: 'internal',
      });
    });

    it('a network failure → network', async () => {
      const fetch = async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      };
      const h = harness({ fetch });
      await expect(h.run(['issue', 'list'])).rejects.toMatchObject({ code: 'network' });
      expect(h.calls.fetch).toBe(3);
    }, 10_000);

    it('no project → bad_usage', async () => {
      const h = harness({ env: { POIETIC_ISSUES_PROJECT: '' } });
      await expect(h.run(['field', 'list'])).rejects.toMatchObject({
        code: 'bad_usage',
      });
    });
  });

  it('propagates the host’s own error from caller() untouched (review focus 1)', async () => {
    const hostError = {
      code: 'not_logged_in',
      message: 'Not logged in. Run `poietic-tech login`.',
    };
    const failure = harness({ caller: () => Promise.reject(hostError) }).run(['issue', 'list']);
    await expect(failure).rejects.toBe(hostError);
  });

  it('propagates a host-shaped error thrown by caller().fetch itself, with exactly one fetch (no retry)', async () => {
    const hostError = {
      code: 'not_logged_in',
      message: 'Not logged in. Run `poietic-tech login`.',
    };
    const h = harness({ fetch: () => Promise.reject(hostError) });
    await expect(h.run(['issue', 'list'])).rejects.toBe(hostError);
    expect(h.calls.fetch).toBe(1);
  });

  it('refuses a server that is not https on *.poietic.tech before any credential access (review focus 2)', async () => {
    for (const server of [
      'http://localhost:3000',
      'https://issues.example.com',
      'http://issues.poietic.tech',
    ]) {
      const h = harness({ env: { POIETIC_ISSUES_SERVER: server } });
      await expect(h.run(['issue', 'list'])).rejects.toMatchObject({
        code: 'bad_usage',
        message: expect.stringMatching(/poietic\.tech/),
      });
      expect(h.calls.caller).toBe(0);
    }
  });

  it('reads the server from .poietic-issues.json and still refuses one holding a token', async () => {
    const project = mkdtempSync(join(dir, 'project-'));
    writeFileSync(join(project, '.poietic-issues.json'), '{"server":"http://127.0.0.1:3000"}');
    const local = harness({ cwd: project });
    await expect(local.run(['issue', 'list'])).rejects.toMatchObject({ code: 'bad_usage' });
    expect(local.calls.caller).toBe(0);

    writeFileSync(
      join(project, '.poietic-issues.json'),
      '{"server":"https://issues.poietic.tech","token":"x"}',
    );
    const token = harness({ cwd: project });
    await expect(token.run(['issue', 'list'])).rejects.toMatchObject({
      code: 'bad_usage',
      message: expect.stringMatching(/must not contain tokens/),
    });
    expect(token.calls.caller).toBe(0);

    writeFileSync(
      join(project, '.poietic-issues.json'),
      '{"server":"https://staging.poietic.tech"}',
    );
    const urls: string[] = [];
    const staging = harness({
      cwd: project,
      fetch: (r) => {
        urls.push(r.url);
        return asAdmin(r);
      },
    });
    await staging.run(['issue', 'list']);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^https:\/\/staging\.poietic\.tech\/api\/v1\//);
  });

  it('answers commands and schema offline, through raw, without the caller (review focus 3)', async () => {
    const h = harness();
    await h.run(['commands', '--json']);
    const info = JSON.parse(h.raw());
    expect(info.commands.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(['issue create', 'issue list', 'event tail', 'schema', 'api']),
    );
    const s = harness();
    await s.run(['schema', 'issue-create']);
    expect(JSON.parse(s.raw()).required).toEqual(['title']);
    const help = harness();
    await expect(help.run(['--help'])).rejects.toMatchObject({ exitCode: 0 });
    expect(help.help()).toContain('issue');
    for (const x of [h, s, help]) {
      expect(x.calls.caller).toBe(0);
      expect(x.recorded).toEqual([]);
    }
  });

  it('retries a create after a network failure with the same idempotency key, creating one issue (review focus 5)', async () => {
    let failed = false;
    const fetch = async (r: Request): Promise<Response> => {
      if (!failed) {
        failed = true;
        throw new TypeError('fetch failed');
      }
      return asAdmin(r);
    };
    const h = harness({ fetch });
    await h.run(['issue', 'create', '-t', 'Exactly once']);
    expect(h.calls.fetch).toBe(2);
    expect(h.calls.keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.calls.keys[1]).toBe(h.calls.keys[0]);
    const list = harness();
    await list.run(['issue', 'list', '--search', 'Exactly once']);
    expect((list.last('list').args[0] as unknown[]).length).toBe(1);
  });

  it('defines exactly -P/--project and --fields on the issues command', () => {
    expect(harness().cmd.options.map((o) => o.flags)).toEqual([
      '-P, --project <key>',
      '--fields <list>',
    ]);
  });

  it('describes itself for agents: the golden file and the reference', async () => {
    const h = harness();
    await h.run(['commands']);
    const info = JSON.parse(h.raw());
    expect(info.exitCodes).toMatchObject({
      0: expect.any(String),
      3: expect.any(String),
      8: expect.any(String),
    });
    expect(Object.keys(info.exitCodes)).toEqual(['0', '1', '2', '3', '4', '5', '8']);
    expect(info.errorCodes.VERSION_MISMATCH).toEqual({
      status: 409,
      code: 'version_mismatch',
      exit: 2,
    });
    expect(info.errorCodes.NOT_FOUND).toEqual({ status: 404, code: 'not_found', exit: 4 });
    // Golden file: changes to the command surface must be deliberate (update with `vitest -u`).
    await expect(h.raw()).toMatchFileSnapshot('../../test/commands.golden.json');
    // The CLI reference in docs/ is generated from the same description (update with `vitest -u`).
    await expect(renderCliReference(info)).toMatchFileSnapshot('../../../../docs/cli-reference.md');
  });

  it('never shadows the module’s or the host’s global options in a subcommand', async () => {
    const h = harness();
    await h.run(['commands']);
    const info = JSON.parse(h.raw());
    const flags = (s: string) => s.split(/[ ,|]+/).filter((f) => f.startsWith('-'));
    const globals = new Set([
      ...info.globalOptions.flatMap((o: { flags: string }) => flags(o.flags)),
      ...[
        '--json',
        '--format',
        '-q',
        '--quiet',
        '--server',
        '--no-wait',
        '--no-color',
        '-V',
        '--version',
      ],
    ]);
    const clashes = info.commands.flatMap((c: { name: string; options: { flags: string }[] }) =>
      c.options.flatMap((o) =>
        flags(o.flags)
          .filter((f) => globals.has(f))
          .map((f) => `${c.name} ${f}`),
      ),
    );
    expect(clashes).toEqual([]);
  });
});

describe('registerTree', () => {
  /** A host whose runtime answers every API call as for an anonymous visitor. */
  const stubTree = (): Tree => ({
    commandName: 'x issues',
    init: { describe: 'project', entries: () => ({}) },
    act:
      (handler) =>
      async (...all) => {
        const rt = {
          api: async () => ({ GET: async () => ({}) }),
          call: async () => ({ anonymous: true }),
          out: { item: () => {} },
        } as unknown as Parameters<typeof handler>[0];
        await handler(rt, all.slice(0, -2), {});
      },
  });

  it('registers every record command by default, in help order', () => {
    const root = new Command('x').command('issues');
    registerTree(root, stubTree());
    expect(root.commands.map((c) => c.name())).toEqual([
      'issue',
      'comment',
      'link',
      'attachment',
      'project',
      'status',
      'label',
      'field',
      'view',
      'event',
      'webhook',
      'user',
      'whoami',
      'init',
      'schema',
      'api',
    ]);
  });

  it('refuses an unknown name, including an inherited property', () => {
    expect(() => registerTree(new Command('x'), stubTree(), ['nope'])).toThrow(
      'Unknown command "nope"',
    );
    expect(() => registerTree(new Command('x'), stubTree(), ['toString'])).toThrow(
      'Unknown command "toString"',
    );
  });

  it('names the host in messages', async () => {
    const program = new Command('x');
    registerTree(program.command('issues'), stubTree(), ['whoami']);
    await expect(program.parseAsync(['issues', 'whoami'], { from: 'user' })).rejects.toThrow(
      /`x issues whoami`/,
    );
  });
});
