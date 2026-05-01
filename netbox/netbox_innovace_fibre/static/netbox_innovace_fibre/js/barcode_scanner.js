/**
 * BarcodeScanner — shared barcode lookup overlay for 3D Rack and Topology views.
 *
 * Usage:
 *   import { BarcodeScanner } from './barcode_scanner.js';
 *   const scanner = new BarcodeScanner({ onDeviceMatch, onCableMatch });
 *
 * Press "/" to open the scan input. Press Escape or click ✕ to dismiss.
 * Barcode scanners send characters followed by Enter — this is handled automatically.
 */

export class BarcodeScanner {
  /**
   * @param {object} opts
   * @param {function} opts.onDeviceMatch  - called with barcode API device response
   * @param {function} opts.onCableMatch   - called with barcode API cable response
   * @param {function} [opts.onNotFound]   - called with barcode string when no match
   * @param {string}   [opts.apiBase]      - API base URL, default '/api/plugins/innovace-fibre/'
   */
  constructor({ onDeviceMatch, onCableMatch, onNotFound, apiBase } = {}) {
    this._onDeviceMatch = onDeviceMatch || (() => {});
    this._onCableMatch  = onCableMatch  || (() => {});
    this._onNotFound    = onNotFound    || ((bc) => BarcodeScanner.showToast(`No match for barcode "${bc}"`, 'danger'));
    this._apiBase       = (apiBase || '/api/plugins/innovace-fibre/').replace(/\/$/, '/');
    this._overlay       = null;
    this._input         = null;
    this._busy          = false;

    this._buildOverlay();
    this._installHotkey();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  activate() {
    if (!this._overlay) return;
    this._overlay.style.display = 'flex';
    this._input.value = '';
    this._setStatus('');
    requestAnimationFrame(() => this._input.focus());
  }

  deactivate() {
    if (!this._overlay) return;
    this._overlay.style.display = 'none';
    this._input.value = '';
    this._setStatus('');
  }

  /** Show a Bootstrap-style toast at the top of the viewport. */
  static showToast(message, level = 'info') {
    const colorMap = {
      info:    '#2563eb',
      success: '#16a34a',
      warning: '#d97706',
      danger:  '#dc2626',
    };
    const bg = colorMap[level] || colorMap.info;

    let container = document.getElementById('iff-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'iff-toast-container';
      Object.assign(container.style, {
        position: 'fixed',
        top: '1rem',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '10000',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        pointerEvents: 'none',
      });
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    Object.assign(toast.style, {
      background: bg,
      color: '#fff',
      padding: '8px 18px',
      borderRadius: '6px',
      fontSize: '13px',
      fontWeight: '500',
      boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
      opacity: '1',
      transition: 'opacity 0.4s',
      pointerEvents: 'none',
    });
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 420);
    }, 3200);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'iff-scan-overlay';
    Object.assign(overlay.style, {
      display:        'none',
      position:       'fixed',
      top:            '1rem',
      right:          '1rem',
      zIndex:         '9998',
      alignItems:     'center',
      gap:            '0',
      background:     'rgba(10,12,20,0.97)',
      border:         '1px solid #3a4a6a',
      borderRadius:   '8px',
      boxShadow:      '0 8px 32px rgba(0,0,0,0.6)',
      padding:        '0',
      overflow:       'hidden',
      minWidth:       '280px',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display:         'flex',
      alignItems:      'center',
      gap:             '8px',
      padding:         '8px 10px 6px',
      borderBottom:    '1px solid #1e2840',
      background:      'rgba(20,28,48,0.98)',
    });
    header.innerHTML = `
      <span style="font-size:18px;line-height:1">&#x1F4F7;</span>
      <span style="font-size:12px;font-weight:600;color:#7dd3fc;letter-spacing:0.04em">BARCODE SCAN</span>
      <span style="font-size:10px;color:#4a5a7a;margin-left:auto">Press / or Esc</span>
    `;

    const body = document.createElement('div');
    Object.assign(body.style, {
      display:    'flex',
      alignItems: 'center',
      padding:    '8px 10px',
      gap:        '6px',
    });

    const input = document.createElement('input');
    input.type          = 'text';
    input.autocomplete  = 'off';
    input.spellcheck    = false;
    input.placeholder   = 'Scan or type barcode…';
    Object.assign(input.style, {
      flex:        '1',
      background:  '#0d1120',
      color:       '#e2e8f0',
      border:      '1px solid #2a3a5a',
      borderRadius:'4px',
      padding:     '5px 10px',
      fontSize:    '13px',
      outline:     'none',
      fontFamily:  'monospace',
      letterSpacing: '0.06em',
    });
    input.addEventListener('focus', () => {
      input.style.borderColor = '#4a9eff';
    });
    input.addEventListener('blur', () => {
      input.style.borderColor = '#2a3a5a';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._submit(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); this.deactivate(); }
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      background:   'none',
      border:       'none',
      color:        '#4a5a7a',
      cursor:       'pointer',
      fontSize:     '14px',
      lineHeight:   '1',
      padding:      '2px 4px',
    });
    closeBtn.addEventListener('click', () => this.deactivate());

    const statusEl = document.createElement('div');
    statusEl.id = 'iff-scan-status';
    Object.assign(statusEl.style, {
      fontSize:    '11px',
      color:       '#4a9eff',
      padding:     '0 10px 8px',
      minHeight:   '0',
    });

    body.appendChild(input);
    body.appendChild(closeBtn);
    overlay.appendChild(header);
    overlay.appendChild(body);
    overlay.appendChild(statusEl);
    document.body.appendChild(overlay);

    this._overlay   = overlay;
    this._input     = input;
    this._statusEl  = statusEl;
  }

  _installHotkey() {
    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || document.activeElement?.isContentEditable;
// Toggle overlay with F2 key (not to be confused with ~ which requires Shift)
      if (e.key === 'F2' && !isEditable && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (this._overlay?.style.display !== 'none') {
          this.deactivate();
        } else {
          this.activate();
        }
      }

      if (e.key === 'Escape' && this._overlay?.style.display !== 'none') {
        this.deactivate();
      }
    });
  }

  async _submit(value) {
    const barcode = value.trim();
    if (!barcode || this._busy) return;

    this._busy = true;
    this._setStatus('Looking up…');

    try {
      const resp = await fetch(
        `${this._apiBase}barcode-lookup/?barcode=${encodeURIComponent(barcode)}`,
        { headers: { 'Accept': 'application/json' } },
      );

      if (resp.status === 404) {
        this._setStatus('');
        this.deactivate();
        this._onNotFound(barcode);
        return;
      }

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        this._setStatus(`Error: ${err.error || resp.statusText}`);
        return;
      }

      const data = await resp.json();
      this.deactivate();

      if (data.type === 'device') {
        this._onDeviceMatch(data);
      } else if (data.type === 'cable') {
        this._onCableMatch(data);
      }
    } catch (err) {
      this._setStatus(`Network error: ${err.message}`);
    } finally {
      this._busy = false;
    }
  }

  _setStatus(text) {
    if (!this._statusEl) return;
    this._statusEl.textContent = text;
    this._statusEl.style.display = text ? '' : 'none';
  }
}

/**
 * Shared signal-selection modal used by both 3D rack and topology views.
 * Renders a Bootstrap-compatible modal listing signal checkboxes.
 *
 * @param {object} cableData   - cable response from barcode-lookup API
 * @param {function} onConfirm - called with array of selected signal numbers
 */
export function showSignalModal(cableData, onConfirm) {
  const existing = document.getElementById('iff-signal-modal');
  if (existing) existing.remove();

  const signals = cableData.signals || [1];
  const aEnd = (cableData.a_terminations || []).map(t => `${t.device_name} / ${t.port_name}`).join(', ');
  const bEnd = (cableData.b_terminations || []).map(t => `${t.device_name} / ${t.port_name}`).join(', ');
  const matchedEndLabel = cableData.matched_end === 'a' ? aEnd : bEnd;

  const backdrop = document.createElement('div');
  backdrop.id = 'iff-signal-modal';
  Object.assign(backdrop.style, {
    position:   'fixed',
    inset:      '0',
    zIndex:     '9999',
    background: 'rgba(0,0,0,0.65)',
    display:    'flex',
    alignItems: 'center',
    justifyContent: 'center',
  });

  const dialog = document.createElement('div');
  Object.assign(dialog.style, {
    background:   '#12151c',
    border:       '1px solid #2a3045',
    borderRadius: '10px',
    boxShadow:    '0 16px 56px rgba(0,0,0,0.7)',
    minWidth:     '320px',
    maxWidth:     '460px',
    padding:      '0',
    overflow:     'hidden',
    color:        '#c9d1e0',
    fontFamily:   'system-ui, sans-serif',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    padding:      '14px 18px 12px',
    borderBottom: '1px solid #1e2740',
    background:   '#0e1120',
    fontSize:     '14px',
    fontWeight:   '600',
  });
  header.textContent = `Trace Signal — Cable${cableData.label ? ` "${cableData.label}"` : ` #${cableData.id}`}`;

  const info = document.createElement('div');
  Object.assign(info.style, {
    padding:     '10px 18px',
    fontSize:    '11px',
    color:       '#5c7090',
    borderBottom:'1px solid #1a2030',
  });
  info.innerHTML = `
    <div>Scanned end: <span style="color:#7dd3fc">${matchedEndLabel || '—'}</span></div>
    <div style="margin-top:3px">Select which signals to trace:</div>
  `;

  const checkboxArea = document.createElement('div');
  Object.assign(checkboxArea.style, {
    padding:    '12px 18px',
    display:    'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
    gap:        '8px',
    maxHeight:  '200px',
    overflowY:  'auto',
  });

  const checkboxes = signals.map(sig => {
    const label = document.createElement('label');
    Object.assign(label.style, {
      display:    'flex',
      alignItems: 'center',
      gap:        '6px',
      fontSize:   '12px',
      cursor:     'pointer',
      padding:    '4px 6px',
      background: '#1a1e2a',
      borderRadius: '4px',
      border:     '1px solid #2a3045',
    });
    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.value   = sig;
    cb.checked = true;
    cb.style.accentColor = '#4a9eff';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`Signal ${sig}`));
    checkboxArea.appendChild(label);
    return cb;
  });

  const footer = document.createElement('div');
  Object.assign(footer.style, {
    display:      'flex',
    gap:          '8px',
    padding:      '10px 18px 14px',
    borderTop:    '1px solid #1e2740',
    justifyContent: 'flex-end',
  });

  const btnCancel = _makeModalBtn('Cancel', '#1a1e2a', '#4a5a7a');
  const btnSelected = _makeModalBtn('Trace Selected', '#1a2e4a', '#4a9eff');
  const btnAll = _makeModalBtn('Trace All', '#1a3060', '#7dd3fc');

  btnCancel.addEventListener('click', () => backdrop.remove());

  btnSelected.addEventListener('click', () => {
    const selected = checkboxes.filter(cb => cb.checked).map(cb => parseInt(cb.value, 10));
    if (selected.length === 0) return;
    backdrop.remove();
    onConfirm(selected);
  });

  btnAll.addEventListener('click', () => {
    backdrop.remove();
    onConfirm(signals);
  });

  footer.appendChild(btnCancel);
  footer.appendChild(btnSelected);
  footer.appendChild(btnAll);

  dialog.appendChild(header);
  dialog.appendChild(info);
  dialog.appendChild(checkboxArea);
  dialog.appendChild(footer);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', escHandler); }
  });
}

function _makeModalBtn(text, bg, color) {
  const btn = document.createElement('button');
  btn.textContent = text;
  Object.assign(btn.style, {
    background:   bg,
    color:        color,
    border:       `1px solid ${color}44`,
    borderRadius: '5px',
    padding:      '6px 14px',
    fontSize:     '12px',
    fontWeight:   '500',
    cursor:       'pointer',
  });
  btn.addEventListener('mouseover', () => { btn.style.opacity = '0.85'; });
  btn.addEventListener('mouseout',  () => { btn.style.opacity = '1'; });
  return btn;
}
