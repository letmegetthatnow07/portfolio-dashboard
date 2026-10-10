import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import './ui-feedback.css';

// ── useFeedback ──────────────────────────────────────────────────────────────
// Replaces window.confirm / alert (which show the "xxx.vercel.app says" banner)
// with in-app toasts and a confirmation dialog.
//
//   const { toast, confirm, node } = useFeedback();
//   const id = toast.loading('Adding CRWD…');
//   toast.update(id, 'success', 'CRWD added to portfolio');
//   toast.success('Saved'); toast.error('Something failed');
//   if (await confirm({ title, message, confirmLabel, tone: 'danger' })) { … }
//   render {node} once inside your component.

const ICONS = {
  success: (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="10" r="8" /><path d="M6.5 10.5l2.4 2.4 4.6-5" /></svg>
  ),
  error: (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="10" r="8" /><path d="M10 6v4.5M10 13.6v.1" /></svg>
  ),
  info: (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="10" r="8" /><path d="M10 9v4.5M10 6.4v.1" /></svg>
  ),
  loading: <span className="fb-spinner" />,
};

export function useFeedback() {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const seq = useRef(0);
  const timers = useRef({});

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current[id]);
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  const schedule = useCallback((id, ms) => {
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => dismiss(id), ms);
  }, [dismiss]);

  const push = useCallback((type, message) => {
    const id = ++seq.current;
    setToasts(t => [...t, { id, type, message }]);
    if (type !== 'loading') schedule(id, type === 'error' ? 6000 : 3500);
    return id;
  }, [schedule]);

  const update = useCallback((id, type, message) => {
    setToasts(t => t.map(x => (x.id === id ? { ...x, type, message } : x)));
    schedule(id, type === 'error' ? 6000 : 3500);
  }, [schedule]);

  const toast = {
    loading: m => push('loading', m),
    success: m => push('success', m),
    error:   m => push('error', m),
    info:    m => push('info', m),
    update,
    dismiss,
  };

  const confirm = useCallback(opts => new Promise(resolve => {
    setDialog({ ...opts, resolve });
  }), []);

  const close = (result) => {
    dialog?.resolve(result);
    setDialog(null);
  };

  useEffect(() => {
    if (!dialog) return undefined;
    const onKey = e => {
      if (e.key === 'Escape') { dialog.resolve(false); setDialog(null); }
      if (e.key === 'Enter')  { dialog.resolve(true);  setDialog(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const node = createPortal(
    <>
      <div className="fb-toasts" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`fb-toast fb-${t.type}`}>
            <span className="fb-toast-icon">{ICONS[t.type]}</span>
            <span className="fb-toast-msg">{t.message}</span>
            {t.type !== 'loading' && (
              <button className="fb-toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
            )}
          </div>
        ))}
      </div>

      {dialog && (
        <div className="fb-overlay" onMouseDown={() => close(false)}>
          <div className="fb-dialog" role="alertdialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            <div className={`fb-dialog-icon fb-tone-${dialog.tone || 'default'}`}>
              {dialog.tone === 'danger'
                ? <svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6M8.5 9v4M11.5 9v4" /></svg>
                : ICONS.info}
            </div>
            <h3 className="fb-dialog-title">{dialog.title}</h3>
            {dialog.message && <p className="fb-dialog-msg">{dialog.message}</p>}
            <div className="fb-dialog-actions">
              <button className="btn-secondary" onClick={() => close(false)}>{dialog.cancelLabel || 'Cancel'}</button>
              <button
                className={dialog.tone === 'danger' ? 'btn-danger' : 'btn-primary'}
                onClick={() => close(true)}
                autoFocus
              >
                {dialog.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body
  );

  return { toast, confirm, node };
}
