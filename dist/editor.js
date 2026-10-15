// Offline Monaco editor panel (VS Code style) for the Micro:bit Compiler Studio (Tauri 2, withGlobalTauri).
// Usage: MbEditor.mount(document.getElementById('editor-root'));
(function () {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const ROOT_URL = new URL('vendor/monaco/', document.baseURI).href;
  const VS_URL = ROOT_URL + 'vs';

  const TEMPLATES = {
    ts: 'basic.showString("Hello!")\n',
    py: 'from microbit import *\n\ndisplay.scroll("Hello")\n',
    cpp:
      '#include "MicroBit.h"\n\nMicroBit uBit;\n\nint main()\n{\n    uBit.init();\n    uBit.display.scroll("Hello");\n    release_fiber();\n}\n',
  };
  const LANGS = {
    ts: 'typescript', py: 'python', cpp: 'cpp', c: 'c', h: 'cpp', hpp: 'cpp',
    js: 'javascript', json: 'json', md: 'markdown', txt: 'plaintext',
  };
  const LANG_NAMES = {
    typescript: 'TypeScript', python: 'Python', cpp: 'C++', c: 'C',
    javascript: 'JavaScript', json: 'JSON', markdown: 'Markdown', plaintext: 'Plain Text',
  };
  const FILE_COLORS = {
    ts: '#3b82c4', py: '#c79a00', cpp: '#3b82c4', c: '#8a63b8', h: '#8a63b8',
    hpp: '#8a63b8', js: '#b8a400', json: '#b8a400', md: '#3b82c4',
  };
  const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store']);

  const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
  const langFor = (name) => LANGS[extOf(name)] || 'plaintext';
  const baseName = (p) => p.split(/[\\/]/).pop();
  const dirName = (p) => p.replace(/[\\/][^\\/]*$/, '');
  const sepOf = (p) => (p.includes('\\') ? '\\' : '/');

  // ---- build diagnostics -------------------------------------------------
  const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
  const PATTERNS = [
    /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s*(?:TS\d+:\s*)?(.*)$/i, // tsc / pxt
    /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning):\s*(.*)$/i, // gcc / clang (CODAL)
  ];
  // The compiler builds a *copy* of the file, so errors name main.ts / main.cpp.
  const COPY_NAMES = new Set(['main.ts', 'main.cpp', 'main.c']);

  function parseLine(raw) {
    const line = raw.replace(ANSI, '').trim();
    for (const re of PATTERNS) {
      const m = re.exec(line);
      if (m) {
        return {
          file: baseName(m[1]),
          line: +m[2],
          col: +m[3],
          severity: /warn/i.test(m[4]) ? 'warning' : 'error',
          message: m[5],
        };
      }
    }
    return null;
  }

  // ---- state -------------------------------------------------------------
  let monaco = null;
  let editor = null;
  let ui = {};
  let tabs = [];
  let active = null;
  let untitled = 0;
  let buildTab = null;
  let diags = [];

  // Anything the user triggers goes through run(): it waits for Monaco to finish loading and
  // shows any failure in a dialog (instead of silently doing nothing).
  let isReady = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  ready.then(() => (isReady = true), () => {});
  function run(fn, ...args) {
    const gate = isReady
      ? Promise.resolve()
      : Promise.race([
          ready,
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error('The code editor has not finished loading. Check that vendor/monaco/vs/loader.js exists.')),
              10000,
            ),
          ),
        ]);
    return gate
      .then(() => fn(...args))
      .catch((e) => {
        console.error('[editor]', e);
        return showError(e && e.message ? e.message : e);
      });
  }

  let root = null; // { path, name } of the open folder
  let expanded = new Set();
  let selDir = null; // folder new files are created in
  const cache = new Map(); // dir path -> sorted entries
  let treeToken = 0;

  const isDirty = (t) => t.model.getAlternativeVersionId() !== t.savedVersion;

  // ---- Monaco loading (local files only) ---------------------------------
  function loadMonaco() {
    return new Promise((resolve, reject) => {
      let workerUrl = null;
      window.MonacoEnvironment = {
        getWorkerUrl() {
          if (!workerUrl) {
            const code =
              `self.MonacoEnvironment={baseUrl:'${ROOT_URL}'};` +
              `importScripts('${VS_URL}/base/worker/workerMain.js');`;
            workerUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          }
          return workerUrl;
        },
      };
      const s = document.createElement('script');
      s.src = VS_URL + '/loader.js';
      s.onerror = () => reject(new Error('Could not load ' + s.src));
      s.onload = () => {
        window.require.config({ paths: { vs: VS_URL } });
        window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
      };
      document.head.appendChild(s);
    });
  }

  // ---- theme: Monaco colors come from the app's CSS variables --------------
  function applyTheme() {
    if (!monaco) return;
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    const dark = document.documentElement.dataset.theme === 'dark';
    const panel = v('--panel', dark ? '#222a2f' : '#ffffff');
    const text = v('--text', dark ? '#e4e9e7' : '#1f2a30');
    const dim = v('--dim', '#8a8a8a');
    const border = v('--border', '#3a454a');
    const hover = v('--hover', dark ? '#2d363b' : '#f0f3f4');
    const accent = v('--green', '#216b56');
    const strong = v('--panel-strong', panel);
    monaco.editor.defineTheme('mbe', {
      base: dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': panel,
        'editor.foreground': text,
        'editorLineNumber.foreground': dim,
        'editorLineNumber.activeForeground': text,
        'editor.lineHighlightBackground': hover,
        'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': accent + '40',
        'editor.inactiveSelectionBackground': accent + '22',
        'editorCursor.foreground': accent,
        'editorIndentGuide.background1': border,
        'editorWidget.background': strong,
        'editorWidget.border': border,
        'editorSuggestWidget.background': strong,
        'editorSuggestWidget.border': border,
        'editorSuggestWidget.selectedBackground': hover,
        'editorHoverWidget.background': strong,
        'editorHoverWidget.border': border,
        'minimap.background': panel,
        'scrollbarSlider.background': border + '99',
        'scrollbarSlider.hoverBackground': border,
        'scrollbarSlider.activeBackground': border,
        focusBorder: accent,
      },
    });
    monaco.editor.setTheme('mbe');
  }

  // ---- small DOM helpers -------------------------------------------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const icon = (name, cls) => el('span', 'material-icons' + (cls ? ' ' + cls : ''), name);
  function ibtn(name, title, fn, cls) {
    const b = el('button', 'mbe-ibtn' + (cls ? ' ' + cls : ''));
    b.title = title;
    b.appendChild(icon(name));
    b.onclick = (e) => {
      e.stopPropagation();
      run(fn);
    };
    return b;
  }

  function ask(message, buttons) {
    return new Promise((resolve) => {
      const modal = el('div', 'mbe-modal');
      const card = el('div', 'mbe-card');
      card.appendChild(el('p', null, message));
      const row = el('div', 'row');
      for (const b of buttons) {
        const btn = el('button', 'mbe-btn' + (b.primary ? ' primary' : ''), b.label);
        btn.onclick = () => {
          modal.remove();
          resolve(b.value);
        };
        row.appendChild(btn);
      }
      card.appendChild(row);
      modal.appendChild(card);
      ui.root.appendChild(modal);
      row.lastChild.focus();
    });
  }

  function promptText(message, value = '') {
    return new Promise((resolve) => {
      const modal = el('div', 'mbe-modal');
      const card = el('div', 'mbe-card');
      card.appendChild(el('p', null, message));
      const input = el('input', 'mbe-input');
      input.value = value;
      card.appendChild(input);
      const row = el('div', 'row');
      const done = (v) => {
        modal.remove();
        resolve(v);
      };
      const cancel = el('button', 'mbe-btn', 'Cancel');
      cancel.onclick = () => done(null);
      const ok = el('button', 'mbe-btn primary', 'OK');
      ok.onclick = () => done(input.value.trim() || null);
      row.append(cancel, ok);
      card.appendChild(row);
      modal.appendChild(card);
      ui.root.appendChild(modal);
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') ok.click();
        else if (e.key === 'Escape') cancel.click();
      };
      input.focus();
      input.select();
    });
  }

  function showError(err) {
    return ask(String(err), [{ label: 'OK', value: true, primary: true }]);
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function updateStatusBar() {
    if (!ui.pos) return;
    if (!active) {
      ui.pos.textContent = ui.indent.textContent = ui.enc.textContent = ui.lang.textContent = '';
      return;
    }
    const p = editor.getPosition();
    ui.pos.textContent = p ? `Ln ${p.lineNumber}, Col ${p.column}` : '';
    ui.indent.textContent = 'Spaces: 4';
    ui.enc.textContent = 'UTF-8';
    const id = active.model.getLanguageId();
    ui.lang.textContent = LANG_NAMES[id] || id;
  }

  // ---- tabs --------------------------------------------------------------
  function addTab({ name, path, content }) {
    const model = monaco.editor.createModel(content, langFor(name));
    const tab = { name, path, model, savedVersion: model.getAlternativeVersionId() };
    model.onDidChangeContent(() => {
      monaco.editor.setModelMarkers(model, 'build', []); // stale after edits
      renderTabs();
    });
    tabs.push(tab);
    activate(tab);
    return tab;
  }

  function activate(tab) {
    active = tab;
    editor.setModel(tab.model);
    ui.empty.hidden = true;
    renderTabs();
    markActive();
    updateStatusBar();
    editor.focus();
  }

  function renderTabs() {
    ui.tabs.textContent = '';
    for (const t of tabs) {
      const div = el('div', 'mbe-tab' + (t === active ? ' active' : '') + (isDirty(t) ? ' dirty' : ''));
      div.tabIndex = 0;
      div.title = t.path || 'Not saved yet';
      const close = el('button', 'mbe-close');
      close.title = 'Close';
      close.append(icon('close', 'x'), el('span', 'dot'));
      close.onclick = (e) => {
        e.stopPropagation();
        run(closeTab, t);
      };
      div.append(el('span', 'mbe-tab-name', t.name), close);
      div.onclick = () => activate(t);
      div.onauxclick = (e) => e.button === 1 && run(closeTab, t);
      div.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && activate(t);
      ui.tabs.appendChild(div);
    }
    const a = ui.tabs.querySelector('.active');
    if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function closeTab(tab) {
    if (isDirty(tab)) {
      const choice = await ask(`Do you want to save the changes you made to ${tab.name}?`, [
        { label: 'Cancel', value: 'cancel' },
        { label: "Don't save", value: 'discard' },
        { label: 'Save', value: 'save', primary: true },
      ]);
      if (choice === 'cancel') return;
      if (choice === 'save' && !(await save(tab))) return;
    }
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (buildTab === tab) buildTab = null;
    if (tabs.length === 0) {
      active = null;
      editor.setModel(null);
      ui.empty.hidden = false;
    } else if (active === tab) {
      activate(tabs[Math.min(i, tabs.length - 1)]);
    }
    tab.model.dispose();
    renderTabs();
    markActive();
    updateStatusBar();
  }

  // ---- explorer ----------------------------------------------------------
  async function loadDir(path) {
    if (cache.has(path)) return cache.get(path);
    const list = (await invoke('editor_read_dir', { path })).filter((e) => !HIDDEN.has(e.name));
    list.sort(
      (a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    cache.set(path, list);
    return list;
  }

  function fileIcon(name) {
    const i = icon('description', 'mbe-ico');
    const c = FILE_COLORS[extOf(name)];
    if (c) i.style.color = c;
    return i;
  }

  function treeRow(e, depth) {
    const r = el('div', 'mbe-row');
    r.style.paddingLeft = 8 + depth * 14 + 'px';
    r.dataset.path = e.path;
    r.title = e.path;
    if (e.is_dir) {
      const open = expanded.has(e.path);
      r.append(icon(open ? 'expand_more' : 'chevron_right', 'mbe-chev'), icon(open ? 'folder_open' : 'folder', 'mbe-ico dir'));
    } else {
      r.append(el('span', 'mbe-chev-sp'), fileIcon(e.name));
    }
    r.append(el('span', 'mbe-label', e.name));
    r.onclick = () => {
      if (e.is_dir) {
        selDir = e.path;
        if (expanded.has(e.path)) expanded.delete(e.path);
        else expanded.add(e.path);
        renderTree();
      } else {
        selDir = dirName(e.path);
        run(openPath, e.path);
      }
    };
    return r;
  }

  async function renderTree() {
    const token = ++treeToken;
    if (!root) {
      const box = el('div', 'mbe-note');
      box.appendChild(el('p', null, 'You have not yet opened a folder.'));
      const b1 = el('button', 'mbe-btn primary wide', 'Open Folder');
      b1.onclick = () => run(openFolder);
      const b2 = el('button', 'mbe-btn wide', 'Open File');
      b2.onclick = () => run(openFile);
      box.append(b1, b2);
      ui.tree.replaceChildren(box);
      return;
    }
    const frag = document.createDocumentFragment();
    async function walk(dir, depth) {
      const entries = await loadDir(dir);
      for (const e of entries) {
        if (token !== treeToken) return;
        frag.appendChild(treeRow(e, depth));
        if (e.is_dir && expanded.has(e.path)) {
          try {
            await walk(e.path, depth + 1);
          } catch {
            /* unreadable subfolder: show it empty */
          }
        }
      }
    }
    try {
      await walk(root.path, 0);
    } catch (err) {
      if (token === treeToken) ui.tree.replaceChildren(el('div', 'mbe-note', 'Could not read folder: ' + err));
      return;
    }
    if (token !== treeToken) return;
    const top = ui.tree.scrollTop;
    ui.tree.replaceChildren(frag);
    ui.tree.scrollTop = top;
    markActive();
  }

  function markActive() {
    if (!ui.tree) return;
    for (const r of ui.tree.querySelectorAll('.mbe-row')) {
      r.classList.toggle('active', !!active && !!active.path && r.dataset.path === active.path);
    }
  }

  function renderRootRow() {
    ui.rootRow.hidden = !root;
    ui.rootRow.textContent = '';
    if (!root) return;
    const name = el('span', 'mbe-rootname', root.name.toUpperCase());
    name.title = root.path;
    const acts = el('div', 'mbe-rootacts');
    acts.append(
      ibtn('note_add', 'New File', createFile),
      ibtn('refresh', 'Refresh Explorer', refreshTree),
      ibtn('unfold_less', 'Collapse Folders', () => {
        expanded = new Set([root.path]);
        renderTree();
      }),
      ibtn('folder_open', 'Open Folder', openFolder),
      ibtn('close', 'Close Folder', closeFolder),
    );
    ui.rootRow.append(icon('expand_more', 'mbe-chev'), name, acts);
  }

  function refreshTree() {
    cache.clear();
    return renderTree();
  }

  async function setRoot(path) {
    root = { path, name: baseName(path) || path };
    expanded = new Set([path]);
    selDir = path;
    cache.clear();
    renderRootRow();
    await renderTree();
  }

  // ---- file actions ------------------------------------------------------
  // Closes the open folder (open tabs stay open). Afterwards "Open File" is available again.
  async function closeFolder() {
    if (!root) return;
    const path = root.path;
    root = null;
    expanded = new Set();
    selDir = null;
    cache.clear();
    try {
      await invoke('editor_close_dir', { path });
    } catch {
      /* nothing to forget */
    }
    renderRootRow();
    await renderTree();
  }

  function newFile(kind) {
    untitled += 1;
    addTab({ name: `untitled-${untitled}.${kind}`, path: null, content: TEMPLATES[kind] });
  }

  async function newFilePrompt() {
    const kind = await ask('What do you want to write?', [
      { label: 'Cancel', value: null },
      { label: 'C++', value: 'cpp' },
      { label: 'MicroPython', value: 'py' },
      { label: 'MakeCode (TypeScript)', value: 'ts', primary: true },
    ]);
    if (kind) newFile(kind);
  }

  // New file inside the open folder (explorer button); untitled tab when no folder is open.
  async function createFile() {
    if (!root) return newFilePrompt();
    const dir = selDir || root.path;
    const name = await promptText(`New file in ${baseName(dir) || dir}`, 'untitled.ts');
    if (!name) return;
    if (/[\\/]/.test(name)) return showError('A file name cannot contain / or \\.');
    const path = dir + sepOf(dir) + name;
    try {
      await invoke('editor_create_file', { path });
      const tpl = TEMPLATES[extOf(name)];
      if (tpl) await invoke('editor_save', { path, content: tpl });
    } catch (e) {
      return showError(e);
    }
    expanded.add(dir);
    cache.delete(dir);
    await renderTree();
    await openPath(path);
  }

  async function openPath(path) {
    const existing = tabs.find((t) => t.path === path);
    if (existing) return activate(existing);
    let content;
    try {
      content = await invoke('editor_read_file', { path });
    } catch (e) {
      return showError(e);
    }
    addTab({ name: baseName(path), path, content });
  }

  async function openFile() {
    let res;
    try {
      res = await invoke('editor_open');
    } catch (e) {
      return showError(e);
    }
    if (!res) return;
    const existing = tabs.find((t) => t.path === res.path);
    if (existing) return activate(existing);
    addTab({ name: res.name || baseName(res.path), path: res.path, content: res.content });
  }

  async function openFolder() {
    let path;
    try {
      path = await invoke('editor_open_dir');
    } catch (e) {
      return showError(e);
    }
    if (path) await setRoot(path);
  }

  async function save(tab = active) {
    if (!tab) return false;
    if (!tab.path) return saveAs(tab);
    try {
      await invoke('editor_save', { path: tab.path, content: tab.model.getValue() });
    } catch (e) {
      await showError(e);
      return false;
    }
    tab.savedVersion = tab.model.getAlternativeVersionId();
    renderTabs();
    return true;
  }

  async function saveAs(tab = active) {
    if (!tab) return false;
    let path;
    try {
      path = await invoke('editor_save_as', { suggested: tab.name, content: tab.model.getValue() });
    } catch (e) {
      await showError(e);
      return false;
    }
    if (!path) return false;
    tab.path = path;
    tab.name = baseName(path);
    monaco.editor.setModelLanguage(tab.model, langFor(tab.name));
    tab.savedVersion = tab.model.getAlternativeVersionId();
    renderTabs();
    updateStatusBar();
    if (root) refreshTree();
    return true;
  }

  // ---- build + diagnostics -----------------------------------------------
  async function build() {
    const tab = active;
    if (!tab) return;
    if (!(await save(tab))) return;
    monaco.editor.setModelMarkers(tab.model, 'build', []);
    buildTab = tab;
    diags = [];
    setStatus('Building…');
    // renderer.js owns the console/progress UI, so hand the build over to it.
    window.dispatchEvent(new CustomEvent('mbe:build', { detail: { path: tab.path } }));
  }

  function collect(msg) {
    for (const raw of String(msg).split(/\r?\n/)) {
      const d = parseLine(raw);
      if (d) diags.push(d);
    }
  }

  function applyDiagnostics() {
    const tab = buildTab; // only mark up builds started from the editor
    buildTab = null;
    if (!tab) {
      diags = [];
      return;
    }
    if (!diags.length) {
      setStatus('Build finished');
      return;
    }
    const seen = new Set();
    const markers = [];
    for (const d of diags) {
      if (!COPY_NAMES.has(d.file) && d.file !== tab.name) continue;
      const key = `${d.line}:${d.col}:${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lineNumber = Math.min(Math.max(d.line, 1), tab.model.getLineCount());
      const word = tab.model.getWordAtPosition({ lineNumber, column: d.col });
      markers.push({
        severity: d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
        message: d.message,
        startLineNumber: lineNumber,
        startColumn: d.col,
        endLineNumber: lineNumber,
        endColumn: word ? word.endColumn : tab.model.getLineMaxColumn(lineNumber),
      });
    }
    diags = [];
    monaco.editor.setModelMarkers(tab.model, 'build', markers);
    const errs = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
    setStatus(errs ? `${errs} error${errs > 1 ? 's' : ''}` : 'Build finished');
    const first = markers.find((m) => m.severity === monaco.MarkerSeverity.Error) || markers[0];
    if (first && tab === active) {
      editor.revealLineInCenter(first.startLineNumber);
      editor.setPosition({ lineNumber: first.startLineNumber, column: first.startColumn });
    }
  }

  // ---- mount -------------------------------------------------------------
  function buildEmpty() {
    const box = el('div', 'mbe-empty');
    box.appendChild(el('div', 'mbe-empty-title', 'Micro:bit Editor'));
    const list = el('div', 'mbe-empty-list');
    const items = [
      ['New File', 'Ctrl+N', newFilePrompt],
      ['Open File', 'Ctrl+O', openFile],
      ['Open Folder', 'Ctrl+Shift+O', openFolder],
    ];
    for (const [label, key, fn] of items) {
      const row = el('button', 'mbe-empty-row');
      row.append(el('span', null, label), el('kbd', null, key));
      row.onclick = () => run(fn);
      list.appendChild(row);
    }
    box.appendChild(list);
    return box;
  }

  async function mountInner(rootEl) {
    ui.root = rootEl;
    rootEl.classList.add('mbe');
    rootEl.textContent = '';

    // explorer
    ui.side = el('aside', 'mbe-side');
    ui.rootRow = el('div', 'mbe-rootrow');
    ui.tree = el('div', 'mbe-tree');
    const head = el('div', 'mbe-side-head');
    head.append(el('span', null, 'Explorer'), ibtn('folder_open', 'Open Folder (Ctrl+Shift+O)', openFolder));
    ui.side.append(head, ui.rootRow, ui.tree);

    const split = el('div', 'mbe-split');
    split.onpointerdown = (e) => {
      split.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = ui.side.offsetWidth;
      const move = (ev) => {
        ui.side.style.width = Math.min(520, Math.max(140, startW + ev.clientX - startX)) + 'px';
      };
      const up = () => {
        split.removeEventListener('pointermove', move);
        split.removeEventListener('pointerup', up);
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', up);
    };

    // tabs + editor
    const center = el('div', 'mbe-center');
    const bar = el('div', 'mbe-bar');
    ui.tabs = el('div', 'mbe-tabs');
    const actions = el('div', 'mbe-actions');
    actions.append(
      ibtn('save', 'Save (Ctrl+S)', () => save()),
      ibtn('play_arrow', 'Save and build (Ctrl+B)', build, 'run'),
    );
    bar.append(ui.tabs, actions);
    ui.host = el('div', 'mbe-host');
    ui.monacoEl = el('div', 'mbe-monaco');
    ui.empty = buildEmpty();
    ui.host.append(ui.monacoEl, ui.empty);
    center.append(bar, ui.host);

    // status bar
    const sb = el('div', 'mbe-statusbar');
    ui.status = el('span', 'mbe-sb-left');
    ui.pos = el('span');
    ui.indent = el('span');
    ui.enc = el('span');
    ui.lang = el('span');
    sb.append(ui.status, ui.pos, ui.indent, ui.enc, ui.lang);

    const main = el('div', 'mbe-main');
    main.append(ui.side, split, center);
    rootEl.append(main, sb);

    renderRootRow();
    renderTree();

    setStatus('Loading editor…');
    monaco = await loadMonaco();
    // MakeCode TypeScript uses pxt namespaces (basic, input, led...) that plain
    // TS doesn't know. Keep syntax checks, leave real errors to pxt's output.
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
    editor = monaco.editor.create(ui.monacoEl, {
      model: null,
      automaticLayout: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 14,
      fontFamily: "Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', monospace",
      tabSize: 4,
      insertSpaces: true,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true },
    });
    applyTheme();
    // data-theme flips on light/dark; the accent palette is written to inline style.
    new MutationObserver(applyTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    editor.onDidChangeCursorPosition(updateStatusBar);
    editor.onDidChangeModel(updateStatusBar);
    setStatus('');
    readyResolve();

    rootEl.addEventListener(
      'keydown',
      (e) => {
        const k = e.key.toLowerCase();
        let fn = null;
        if (e.ctrlKey || e.metaKey) {
          if (k === 's') fn = e.shiftKey ? () => saveAs() : () => save();
          else if (k === 'o') fn = e.shiftKey ? openFolder : openFile;
          else if (k === 'n') fn = newFilePrompt;
          else if (k === 'b') fn = build;
          else if (k === 'w') fn = () => active && closeTab(active);
        } else if (e.key === 'F5') {
          fn = build;
        }
        if (fn) {
          e.preventDefault();
          e.stopPropagation();
          run(fn);
        }
      },
      true,
    );

    await listen('build-log', (ev) => collect(ev.payload));
    await listen('build-complete', applyDiagnostics);

    // Reopen the folder from last time (Rust remembers it and re-approves it).
    try {
      const last = await invoke('editor_last_dir');
      if (last) await setRoot(last);
    } catch {
      /* no saved folder */
    }
  }

  async function mount(rootEl) {
    try {
      await mountInner(rootEl);
    } catch (e) {
      readyReject(e);
      throw e;
    }
  }

  window.MbEditor = {
    mount,
    openFile: () => run(openFile),
    openFolder: () => run(openFolder),
    closeFolder: () => run(closeFolder),
    save: () => run(save),
    build: () => run(build),
    /** Jump to a line in the active file, e.g. when a console line is clicked. */
    reveal(line, col = 1) {
      if (!editor || !active) return;
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: col });
      editor.focus();
    },
  };
})();