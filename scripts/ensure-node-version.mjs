import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const nvmrcPath = path.join(root, '.nvmrc');
const expected = fs.readFileSync(nvmrcPath, 'utf8').trim();
const currentMajor = process.version.match(/^v(\d+)/)?.[1];

if (currentMajor !== expected) {
  console.error(
    `\nWrong Node.js version: ${process.version} (expected v${expected}.x from .nvmrc)\n` +
      `Run: nvm use ${expected}\n` +
      `Then: npm run dev\n`,
  );
  process.exit(1);
}
