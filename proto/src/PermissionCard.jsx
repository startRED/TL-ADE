import { useRef, useState } from 'react';

import { parseDiff } from './diff-lines.mjs';

const LOCK_REASONS = {
  busy: 'Há uma missão rodando nesta pasta; espere ela terminar.',
  dirty: 'A pasta tem alterações suas ainda não commitadas; commite ou descarte antes.',
  stale: 'A proposta ficou desatualizada porque o projeto mudou depois dela; peça de novo.',
};

const KIND_LABELS = {
  created: 'criado',
  changed: 'alterado',
  deleted: 'apagado',
};

/**
 * @param {'approve'|'reject'} action
 * @param {{dir: string, id: string}} proposal
 * @param {(path: string, body: {dir: string, id: string}) => Promise<Response>} post
 */
export async function submitPermissionDecision(action, { dir, id }, post) {
  try {
    const response = await post(`/api/chat/${action}`, { dir, id });
    if (response.ok) {
      return { ok: true };
    }

    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && typeof body.error === 'string' && body.error.trim()) {
      return { ok: false, error: body.error };
    }
  } catch {
    return { ok: false, error: 'Não foi possível concluir. Tente de novo.' };
  }

  return { ok: false, error: 'Não foi possível concluir. Tente de novo.' };
}

/**
 * @param {{proposal: {id: string, head: string, patch: string, files: Array<{path: string, kind: 'created'|'changed'|'deleted'}>, status: 'pending'|'applied'|'rejected', commit: string|null}, dir: string, busy: boolean, dirty: boolean, projectHead: string, submitting: boolean, error: string|null, onApprove: () => void, onReject: () => void, openPaths?: Set<string>, onToggle?: (path: string) => void}} props
 */
export function PermissionCardContent({ proposal, busy, dirty, projectHead, submitting, error, onApprove, onReject, openPaths, onToggle }) {
  const files = parseDiff(proposal.patch);
  const locked = busy ? LOCK_REASONS.busy : dirty ? LOCK_REASONS.dirty : proposal.head !== projectHead ? LOCK_REASONS.stale : null;

  return (
    <section className="permission-card" aria-label="Proposta de alteração">
      <header className="permission-card-head">
        <strong>A IA quer mudar {proposal.files.length} arquivos</strong>
      </header>

      <div className="permission-files">
        {files.map((file, index) => {
          const metadata = proposal.files.find((item) => item.path === file.path);
          const open = openPaths ? openPaths.has(file.path) : true;
          const controls = `permission-diff-${index}`;
          return (
            <article className="permission-file" key={file.path}>
              <button className="permission-file-head" type="button" aria-expanded={open} aria-controls={controls} onClick={() => onToggle?.(file.path)}>
                <span className="permission-path mono">{file.path}</span>
                <span className={`permission-kind ${metadata.kind}`}>{KIND_LABELS[metadata.kind]}</span>
              </button>
              {open && (
                <pre className="permission-diff" id={controls}>
                  {file.lines.map((line, lineIndex) => <code className={`permission-line ${line.type}`} key={lineIndex}>{line.text}{'\n'}</code>)}
                </pre>
              )}
            </article>
          );
        })}
      </div>

      {proposal.status === 'applied' ? <p className="permission-final ok">Aplicado · commit {proposal.commit.slice(0, 7)}</p>
        : proposal.status === 'rejected' ? <p className="permission-final dim">Recusado</p>
          : <div className="permission-actions">
              {locked && <p className="permission-lock">{locked}</p>}
              {error && <p className="permission-error" role="alert">{error}</p>}
              <div className="permission-buttons">
                <button className="btn primary" type="button" disabled={Boolean(locked) || submitting} onClick={onApprove}>Aprovar</button>
                <button className="btn" type="button" disabled={submitting} onClick={onReject}>Recusar</button>
              </div>
            </div>}
    </section>
  );
}

/**
 * @param {{proposal: {id: string, head: string, patch: string, files: Array<{path: string, kind: 'created'|'changed'|'deleted'}>, status: 'pending'|'applied'|'rejected', commit: string|null}, dir: string, busy: boolean, dirty: boolean, projectHead: string, post: (path: string, body: {dir: string, id: string}) => Promise<Response>}} props
 */
export function PermissionCard({ proposal, dir, busy, dirty, projectHead, post }) {
  const files = parseDiff(proposal.patch);
  const [openPaths, setOpenPaths] = useState(() => new Set(files.map((file) => file.path)));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const submittingRef = useRef(false);

  function toggle(path) {
    setOpenPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function decide(action) {
    if (submittingRef.current) {
      return;
    }
    submittingRef.current = true;
    setError(null);
    setSubmitting(true);
    try {
      const result = await submitPermissionDecision(action, { dir, id: proposal.id }, post);
      if (!result.ok) {
        setError(result.error);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return <PermissionCardContent proposal={proposal} dir={dir} busy={busy} dirty={dirty} projectHead={projectHead} submitting={submitting} error={error} onApprove={() => decide('approve')} onReject={() => decide('reject')} openPaths={openPaths} onToggle={toggle} />;
}
