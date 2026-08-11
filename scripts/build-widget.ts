import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Bundle the embeddable intake widget to public/widget.js.
 *
 * Runs before `next build` (see the `build` script). The output must be a
 * single self-contained IIFE with no imports and no runtime dependencies —
 * it is loaded by one script tag on the firm's WordPress site, which we do not
 * control and cannot ask to change.
 */
async function main(): Promise<void> {
  const outfile = path.resolve(process.cwd(), 'public/widget.js');
  await mkdir(path.dirname(outfile), { recursive: true });

  const result = await build({
    entryPoints: [path.resolve(process.cwd(), 'src/widget/widget.ts')],
    outfile,
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    // Broad enough to cover the browsers a Malaysian law firm's clients
    // actually use, including older Safari on iOS.
    target: ['es2019', 'safari13', 'chrome80', 'firefox78'],
    legalComments: 'none',
    metafile: true,
  });

  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`widget.js built — ${(bytes / 1024).toFixed(1)} kB`);
}

main().catch((error: unknown) => {
  console.error('Widget build failed:', error);
  process.exit(1);
});
