import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('merchant product management exposes a working owner-home button', () => {
  assert.match(
    appSource,
    /<button className="icon-button" onClick=\{onBack\} aria-label="사장님 홈">\s*<Home size=\{20\} \/>\s*<\/button>/,
  );
});
