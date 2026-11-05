'use strict';

const api = window.claudeDual;

const $ = (id) => document.getElementById(id);
const els = {
  list: $('accounts'),
  add: $('add'),
  reload: $('reload'),
  overlay: $('overlay'),
  form: $('editor'),
  title: $('editor-title'),
  preview: $('preview'),
  name: $('f-name'),
  initial: $('f-initial'),
  swatches: $('swatches'),
  del: $('delete'),
  cancel: $('cancel'),
};

let state = { accounts: [], activeId: null, modKey: 'Ctrl', palette: [] };
// Editor: { mode: 'add' | 'edit', id?, color, initialTouched }
let editor = null;

// ---------- Utilidades ----------

// Texto blanco u oscuro según la luminosidad del color de fondo.
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#16141f' : '#ffffff';
}

function paintAvatar(el, color, initial) {
  el.style.setProperty('--c', color);
  el.style.setProperty('--on-c', textOn(color));
  el.textContent = initial || '?';
}

const segmenter = new Intl.Segmenter();
const firstChar = (s) => ([...segmenter.segment(s.trim())][0]?.segment || '').toUpperCase();

// ---------- Barra lateral ----------

function render() {
  const active = state.accounts.find((a) => a.id === state.activeId);
  document.documentElement.style.setProperty('--active', active ? active.color : 'transparent');

  els.list.replaceChildren(
    ...state.accounts.map((account, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'account' + (account.id === state.activeId ? ' active' : '');
      btn.style.setProperty('--c', account.color);
      const shortcut = i < 9 ? `${state.modKey}+${i + 1}` : '';
      btn.title = shortcut ? `${account.name} (${shortcut})\nClic derecho: opciones` : account.name;
      btn.setAttribute('aria-label', account.name);
      if (account.id === state.activeId) btn.setAttribute('aria-current', 'true');

      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      paintAvatar(avatar, account.color, account.initial);
      if (i < 9) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(i + 1);
        avatar.append(badge);
      }

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = account.name;

      btn.append(avatar, name);
      btn.addEventListener('click', () => api.switchTo(account.id));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.showAccountMenu(account.id);
      });
      btn.addEventListener('dblclick', () => openEditor({ mode: 'edit', id: account.id }));

      li.append(btn);
      return li;
    })
  );

  els.reload.title = `Recargar (${state.modKey}+R)`;
}

// ---------- Editor ----------

function renderSwatches() {
  const colors = [...state.palette];
  const custom = !colors.includes(editor.color);
  els.swatches.replaceChildren(
    ...colors.map((color) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.setProperty('--c', color);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', color);
      b.setAttribute('aria-checked', String(color === editor.color));
      b.addEventListener('click', () => setColor(color));
      return b;
    }),
    (() => {
      const wrap = document.createElement('label');
      wrap.className = 'swatch swatch-custom';
      wrap.title = 'Otro color';
      wrap.setAttribute('aria-checked', String(custom));
      if (custom) wrap.style.background = editor.color;
      const input = document.createElement('input');
      input.type = 'color';
      input.value = editor.color;
      input.setAttribute('aria-label', 'Otro color');
      input.addEventListener('input', () => setColor(input.value.toLowerCase()));
      wrap.append(input);
      return wrap;
    })()
  );
}

function setColor(color) {
  editor.color = color;
  renderSwatches();
  updatePreview();
}

function updatePreview() {
  const initial = els.initial.value.trim() || firstChar(els.name.value);
  paintAvatar(els.preview, editor.color, initial.toUpperCase());
}

function openEditor({ mode, id }) {
  const account = mode === 'edit' ? state.accounts.find((a) => a.id === id) : null;
  if (mode === 'edit' && !account) return;

  const n = state.accounts.length;
  const used = new Set(state.accounts.map((a) => a.color));
  editor = {
    mode,
    id,
    color: account ? account.color : state.palette.find((c) => !used.has(c)) || state.palette[n % state.palette.length],
    initialTouched: Boolean(account),
  };

  els.title.textContent = account ? 'Editar cuenta' : 'Nueva cuenta';
  els.name.value = account ? account.name : '';
  els.name.placeholder = account ? account.name : `Cuenta ${n + 1}`;
  els.initial.value = account ? account.initial : '';
  els.del.hidden = !account || n <= 1;

  renderSwatches();
  updatePreview();

  api.setOverlay(true);
  els.overlay.hidden = false;
  requestAnimationFrame(() => {
    els.name.focus();
    els.name.select();
  });
}

function closeEditor() {
  if (!editor) return;
  editor = null;
  els.overlay.hidden = true;
  api.setOverlay(false);
}

async function submitEditor(e) {
  e.preventDefault();
  if (!editor) return;
  const data = {
    name: els.name.value.trim() || els.name.placeholder,
    initial: els.initial.value.trim(),
    color: editor.color,
  };
  if (editor.mode === 'edit') await api.updateAccount(editor.id, data);
  else await api.addAccount(data);
  closeEditor();
}

// ---------- Eventos ----------

els.add.addEventListener('click', () => openEditor({ mode: 'add' }));
els.reload.addEventListener('click', () => api.reload());
els.cancel.addEventListener('click', closeEditor);
els.form.addEventListener('submit', submitEditor);
els.del.addEventListener('click', async () => {
  if (editor?.mode === 'edit' && (await api.removeAccount(editor.id))) closeEditor();
});

els.name.addEventListener('input', () => {
  if (!editor.initialTouched) els.initial.value = firstChar(els.name.value);
  updatePreview();
});
els.initial.addEventListener('input', () => {
  editor.initialTouched = els.initial.value.trim() !== '';
  updatePreview();
});

// Clic en el fondo oscuro: cerrar.
els.overlay.addEventListener('mousedown', (e) => {
  if (e.target === els.overlay) closeEditor();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeEditor();
});

api.onState((s) => {
  state = s;
  render();
  // Si la cuenta que se editaba ya no existe, cerramos el editor.
  if (editor?.mode === 'edit' && !state.accounts.some((a) => a.id === editor.id)) closeEditor();
});
api.onEditRequest(openEditor);

api.getState().then((s) => {
  if (s) {
    state = s;
    render();
  }
});
