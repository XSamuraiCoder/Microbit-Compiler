## Micro:bit Compiler Studio 1.4.0

### New: built-in code editor
A new **Editor** tab in the sidebar lets you write and build your code without leaving the app.

- **Open a file or a whole folder.** Use Ctrl+O to open a file and Ctrl+Shift+O to open a folder. The explorer lists your project, and clicking a file opens it in a tab.
- **Close a folder** with the × on the folder row, then open a single file instead. The app reopens your last folder next time unless you close it.
- **New files in your project.** The note icon on the folder row creates a file there, with starter code for `.ts`, `.py` and `.cpp`.
- **VS Code-style layout.** Tabs show a dot for unsaved changes, there's a resizable explorer, and a status bar shows the build status, line and column, and language.
- **Matches your theme.** The editor follows your light or dark mode and your accent color from Settings, and updates as soon as you change them.
- **Build from the editor.** Press the run button, Ctrl+B or F5. The file is saved and built, the full log still appears in the Build tab, and compiler errors and warnings are marked on the exact lines in your code.
- **Works offline.** The editor is bundled with the app, so it needs no internet connection.

### Security
The editor can only read and write files and folders you picked in a file dialog, so a compromised page can't reach anywhere else on your disk.

### Notes
- Files larger than 5 MB, or files that aren't UTF-8 text, can't be opened in the editor.
- The Open File dialog lists source files (`.ts`, `.py`, `.cpp`, `.c`, `.h`, `.hpp`, `.js`, `.json`, `.md`, `.txt`).