import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The command tree registers onto a host's commander root (the poietic-tech CLI), so it must not load
// commander itself at run time, nor the in-process server stack that only the local operator tool uses.
const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TREE_DIRS = ['tree', 'commands'].map((d) => join(src, d));

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Module specifiers of the value (non-`import type`) imports and re-exports in a file. */
function valueImports(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  const specs: string[] = [];
  for (const m of text.matchAll(/^(?:import|export)\s+(?!type\s)[^;]*?from\s+'([^']+)'/gms))
    specs.push(m[1]!);
  for (const m of text.matchAll(/import\(\s*'([^']+)'\s*\)/g)) specs.push(m[1]!);
  return specs;
}

const files = TREE_DIRS.flatMap(sourceFiles);
const FORBIDDEN = /^@poietic-tech\/issues-(core|db|server)(\/|$)/;

describe('the command tree', () => {
  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.slice(src.length + 1), f]))(
    '%s imports commander for types only',
    (_name, path) => {
      const lines = readFileSync(path, 'utf8').split('\n');
      expect(lines.filter((l) => /^import (?!type)[^;]*from 'commander'/.test(l))).toEqual([]);
    },
  );

  it.each(files.map((f) => [f.slice(src.length + 1), f]))(
    '%s does not import the core, db or server packages',
    (_name, path) => {
      expect(readFileSync(path, 'utf8')).not.toMatch(
        /from '@poietic-tech\/issues-(core|db|server)['/]|import\('@poietic-tech\/issues-(core|db|server)['/]/,
      );
    },
  );

  it('reaches neither commander nor core, db or server through relative imports', () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const visit = (path: string, via: string[]) => {
      if (seen.has(path)) return;
      seen.add(path);
      for (const spec of valueImports(path)) {
        const chain = [...via, spec].join(' -> ');
        if (spec === 'commander' || FORBIDDEN.test(spec)) offenders.push(chain);
        else if (spec.startsWith('.')) visit(resolve(dirname(path), spec), [...via, spec]);
      }
    };
    for (const f of files) visit(f, [f.slice(src.length + 1)]);
    expect(offenders).toEqual([]);
  });
});
