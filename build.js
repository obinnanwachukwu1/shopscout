/**
 * Simple build script using esbuild for Chrome Extension MV3
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const isWatch = process.argv.includes('--watch');

// Clean dist directory
if (fs.existsSync('dist')) {
  fs.rmSync('dist', { recursive: true });
}
fs.mkdirSync('dist', { recursive: true });

// Build configuration
const buildConfig = {
  bundle: true,
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info'
};

// Build background.js
await esbuild.build({
  ...buildConfig,
  entryPoints: ['background.js'],
  outfile: 'dist/background.js'
});

// Build sidepanel.js
await esbuild.build({
  ...buildConfig,
  entryPoints: ['sidepanel.js'],
  outfile: 'dist/sidepanel.js'
});

// Copy content-script.js (no bundling needed, it's standalone)
fs.copyFileSync('content-script.js', 'dist/content-script.js');

// Copy manifest.json
fs.copyFileSync('manifest.json', 'dist/manifest.json');

// Copy sidepanel.html
fs.copyFileSync('sidepanel.html', 'dist/sidepanel.html');

// Copy icons directory
if (fs.existsSync('icons')) {
  fs.mkdirSync('dist/icons', { recursive: true });
  const icons = fs.readdirSync('icons');
  icons.forEach(icon => {
    fs.copyFileSync(path.join('icons', icon), path.join('dist', 'icons', icon));
  });
}

// Copy config.local.js if it exists
if (fs.existsSync('config.local.js')) {
  fs.copyFileSync('config.local.js', 'dist/config.local.js');
}

console.log('✅ Build complete! Extension files are in ./dist');

if (isWatch) {
  console.log('👀 Watching for changes...');

  // Watch for file changes
  const watchFiles = ['background.js', 'sidepanel.js', 'content-script.js', 'manifest.json', 'sidepanel.html'];

  watchFiles.forEach(file => {
    fs.watch(file, async (eventType) => {
      if (eventType === 'change') {
        console.log(`📝 ${file} changed, rebuilding...`);

        if (file === 'background.js') {
          await esbuild.build({
            ...buildConfig,
            entryPoints: ['background.js'],
            outfile: 'dist/background.js'
          });
        } else if (file === 'sidepanel.js') {
          await esbuild.build({
            ...buildConfig,
            entryPoints: ['sidepanel.js'],
            outfile: 'dist/sidepanel.js'
          });
        } else {
          fs.copyFileSync(file, path.join('dist', file));
        }

        console.log('✅ Rebuild complete!');
      }
    });
  });

  // Watch src directory
  fs.watch('src', { recursive: true }, async (eventType, filename) => {
    if (eventType === 'change' && filename) {
      console.log(`📝 src/${filename} changed, rebuilding...`);

      await esbuild.build({
        ...buildConfig,
        entryPoints: ['background.js'],
        outfile: 'dist/background.js'
      });

      console.log('✅ Rebuild complete!');
    }
  });
}
