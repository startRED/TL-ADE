import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const protoDir = fileURLToPath(new URL('..', import.meta.url));
const proposal = {
  id: 'chat-1',
  head: 'aaa',
  patch: [
    'diff --git a/app.js b/app.js',
    '--- a/app.js',
    '+++ b/app.js',
    '@@ -1 +1 @@',
    '-antigo',
    '+novo',
    'diff --git a/ola.txt b/ola.txt',
    '--- /dev/null',
    '+++ b/ola.txt',
    '@@ -0,0 +1 @@',
    '+oi',
    'diff --git a/fim.txt b/fim.txt',
    '--- a/fim.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-fim',
  ].join('\n'),
  files: [
    { path: 'ola.txt', kind: 'created' },
    { path: 'fim.txt', kind: 'deleted' },
    { path: 'app.js', kind: 'changed' },
  ],
  status: 'pending',
  commit: null,
};

async function loadPermissionCard() {
  const output = join(protoDir, '.ade', 'test', `permission-card-${randomUUID()}.mjs`);
  try {
    await build({
      bundle: true,
      entryPoints: [join(protoDir, 'src', 'PermissionCard.jsx')],
      format: 'esm',
      jsx: 'automatic',
      outfile: output,
      platform: 'node',
    });
    return await import(`${pathToFileURL(output).href}?${randomUUID()}`);
  } finally {
    await rm(output, { force: true });
  }
}

function content(Component, overrides = {}) {
  return renderToStaticMarkup(createElement(Component, {
    proposal,
    dir: 'C:/projeto',
    busy: false,
    dirty: false,
    projectHead: 'aaa',
    submitting: false,
    error: null,
    onApprove: () => {},
    onReject: () => {},
    ...overrides,
  }));
}

test('CA1 mostra arquivos e diferenças na ordem do patch', async () => {
  const { PermissionCardContent } = await loadPermissionCard();
  const markup = content(PermissionCardContent);

  assert.match(markup, /A IA quer mudar 3 arquivos/);
  assert.ok(markup.indexOf('app.js') < markup.indexOf('ola.txt'));
  assert.ok(markup.indexOf('ola.txt') < markup.indexOf('fim.txt'));
  assert.match(markup, /app\.js[\s\S]*?alterado/);
  assert.match(markup, /ola\.txt[\s\S]*?criado/);
  assert.match(markup, /fim\.txt[\s\S]*?apagado/);
  assert.match(markup, /@@ -1 \+1 @@/);
  assert.match(markup, /\+novo/);
  assert.match(markup, /-fim/);
  assert.equal((markup.match(/aria-expanded="true"/g) || []).length, 3);
  assert.match(markup, /aria-controls="permission-diff-/);

  const css = await readFile(new URL('./index.css', import.meta.url), 'utf8');
  assert.match(css, /\.permission-diff\s*\{[^}]*max-height:[^;}]+/s);
  assert.match(css, /\.permission-line\.add/);
  assert.match(css, /\.permission-line\.del/);
});

test('CA2 bloqueia aprovação por missão, alterações ou proposta desatualizada', async () => {
  const { PermissionCardContent } = await loadPermissionCard();
  const busy = content(PermissionCardContent, { busy: true });
  const dirty = content(PermissionCardContent, { dirty: true });
  const stale = content(PermissionCardContent, { projectHead: 'bbb' });

  assert.match(busy, /Há uma missão rodando nesta pasta; espere ela terminar\./);
  assert.match(busy, /<button[^>]*disabled[^>]*>Aprovar<\/button>/);
  assert.match(dirty, /A pasta tem alterações suas ainda não commitadas; commite ou descarte antes\./);
  assert.match(stale, /A proposta ficou desatualizada porque o projeto mudou depois dela; peça de novo\./);
});

test('CA3 mostra estados finais sem controles', async () => {
  const { PermissionCardContent } = await loadPermissionCard();
  const applied = content(PermissionCardContent, { proposal: { ...proposal, status: 'applied', commit: 'abc123456' } });
  const rejected = content(PermissionCardContent, { proposal: { ...proposal, status: 'rejected' } });

  assert.match(applied, /Aplicado · commit abc1234/);
  assert.doesNotMatch(applied, />Aprovar<|>Recusar</);
  assert.match(rejected, /Recusado/);
  assert.doesNotMatch(rejected, />Aprovar<|>Recusar</);
});

test('CA4 envia decisões e preserva erro de conflito sem bloquear nova tentativa', async () => {
  const { PermissionCardContent, submitPermissionDecision } = await loadPermissionCard();
  const calls = [];
  const approve = await submitPermissionDecision('approve', { dir: 'C:/projeto', id: 'chat-1' }, async (path, body) => {
    calls.push([path, body]);
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(calls, [['/api/chat/approve', { dir: 'C:/projeto', id: 'chat-1' }]]);
  assert.deepEqual(approve, { ok: true });

  const reject = await submitPermissionDecision('reject', { dir: 'C:/projeto', id: 'chat-1' }, async (path, body) => {
    calls.push([path, body]);
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(calls[1], ['/api/chat/reject', { dir: 'C:/projeto', id: 'chat-1' }]);
  assert.deepEqual(reject, { ok: true });

  const conflict = await submitPermissionDecision('reject', { dir: 'C:/projeto', id: 'chat-1' }, async () => new Response(JSON.stringify({ error: 'O projeto mudou.' }), { status: 409 }));
  assert.deepEqual(conflict, { ok: false, error: 'O projeto mudou.' });
  assert.deepEqual(await submitPermissionDecision('approve', { dir: 'C:/projeto', id: 'chat-1' }, async () => new Response(JSON.stringify({}), { status: 409 })), { ok: false, error: 'Não foi possível concluir. Tente de novo.' });
  assert.deepEqual(await submitPermissionDecision('approve', { dir: 'C:/projeto', id: 'chat-1' }, async () => new Response(null, { status: 500 })), { ok: false, error: 'Não foi possível concluir. Tente de novo.' });
  assert.deepEqual(await submitPermissionDecision('approve', { dir: 'C:/projeto', id: 'chat-1' }, async () => Promise.reject(new Error('offline'))), { ok: false, error: 'Não foi possível concluir. Tente de novo.' });

  const markup = content(PermissionCardContent, { error: conflict.error });
  assert.match(markup, /O projeto mudou\./);
  assert.match(markup, />Aprovar</);
  assert.match(markup, />Recusar</);
  assert.doesNotMatch(markup, /disabled/);
});

test('CA1 integra PermissionCard entre o texto e os metadados da conversa', async () => {
  const app = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');

  assert.match(app, /<ChatView turns=\{state\.chat\} dir=\{state\.project\?\.dir\} busy=\{state\.busy\} dirty=\{state\.project\?\.dirty\} projectHead=\{state\.project\?\.head\} postDecision=\{post\} onClear=\{/);
  assert.match(app, /function ChatView\(\{turns,dir,busy,dirty,projectHead,postDecision,onClear\}\)/);
  assert.match(app, /import \{ PermissionCard \} from ['"]\.\/PermissionCard\.jsx['"]/);

  const assistantBranch = app.slice(app.indexOf(": <Ade key={i}"), app.indexOf("<div ref={endRef} />"));
  assert.ok(assistantBranch.indexOf('<Rich text={t.text} />') < assistantBranch.indexOf('<PermissionCard'));
  assert.ok(assistantBranch.indexOf('<PermissionCard') < assistantBranch.indexOf('<p className="chat-meta">'));
  assert.match(assistantBranch, /proposal=\{t\.proposal\} dir=\{dir\} busy=\{busy\} dirty=\{dirty\} projectHead=\{projectHead\} post=\{postDecision\}/);
});

test('CA2 trava pergunta enquanto há proposta pendente', async () => {
  const app = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');

  assert.match(app, /const pendingProposal = \(state\.chat \|\| \[\]\)\.some\(\(message\) => message\.proposal\?\.status === 'pending'\)/);
  assert.match(app, /async function ask\(text\) \{\s*if \(pendingProposal\) return/s);
  assert.match(app, /disabled=\{mode === 'ask' \? \(!p \|\| pendingProposal\) : busy\}/);
  assert.match(app, /disabled=\{mode === 'ask' \? \(!p \|\| state\.chat_busy \|\| pendingProposal \|\| !request\.trim\(\)\)/);
  assert.match(app, /pendingProposal \? 'decida o cartão acima'/);
});

test('CA3 mostra as novas explicações da conversa', async () => {
  const app = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');

  assert.match(app, /altera só com a sua permissão, não vira missão/);
  assert.match(app, /Se a IA quiser mudar arquivos, aparece um cartão para você aprovar ou recusar\. Não vira missão\./);
});

test('CA4 documenta a cópia isolada, decisões e travas do chat', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  assert.doesNotMatch(readme, /A conversa é só leitura/);
  assert.match(readme, /cópia isolada/);
  assert.match(readme, /Aprovar/);
  assert.match(readme, /chat: …/);
  assert.match(readme, /Recusar/);
  assert.match(readme, /missão ativa/);
  assert.match(readme, /alterações locais/);
  assert.match(readme, /proposta desatualizada/);
});
