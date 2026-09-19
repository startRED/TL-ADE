import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDiff } from './diff-lines.mjs';

test('CA1 separa um arquivo criado e classifica hunk e adição', () => {
  assert.deepEqual(
    parseDiff('diff --git a/ola.txt b/ola.txt\n--- /dev/null\n+++ b/ola.txt\n@@ -0,0 +1 @@\n+oi'),
    [{
      path: 'ola.txt',
      lines: [
        { type: 'hunk', text: '@@ -0,0 +1 @@' },
        { type: 'add', text: '+oi' },
      ],
    }],
  );
});

test('CA2 mantém ordem, classifica conteúdo e escolhe caminho de exclusão', () => {
  assert.deepEqual(
    parseDiff('diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n igual\n-velho\n+novo\n---texto\n+++texto\ndiff --git a/velho.txt b/velho.txt\n--- a/velho.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-antigo'),
    [
      {
        path: 'a.txt',
        lines: [
          { type: 'hunk', text: '@@ -1 +1 @@' },
          { type: 'ctx', text: ' igual' },
          { type: 'del', text: '-velho' },
          { type: 'add', text: '+novo' },
          { type: 'del', text: '---texto' },
          { type: 'add', text: '+++texto' },
        ],
      },
      {
        path: 'velho.txt',
        lines: [
          { type: 'hunk', text: '@@ -1 +0,0 @@' },
          { type: 'del', text: '-antigo' },
        ],
      },
    ],
  );
});

test('CA3 descarta patch vazio e blocos apenas com cabeçalhos', () => {
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(
    parseDiff('diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt'),
    [],
  );
});

test('CA4 omite blocos binários e preserva blocos textuais', () => {
  assert.deepEqual(
    parseDiff('diff --git a/foto.png b/foto.png\nGIT binary patch\nliteral 12\ndiff --git a/ola.txt b/ola.txt\n--- /dev/null\n+++ b/ola.txt\n@@ -0,0 +1 @@\n+oi'),
    [{
      path: 'ola.txt',
      lines: [
        { type: 'hunk', text: '@@ -0,0 +1 @@' },
        { type: 'add', text: '+oi' },
      ],
    }],
  );
  assert.deepEqual(
    parseDiff('diff --git a/foto.png b/foto.png\nBinary files a/foto.png and b/foto.png differ'),
    [],
  );
});
