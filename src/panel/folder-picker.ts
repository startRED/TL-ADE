import { execFile as defaultExecFile } from 'node:child_process'
import { AdeError } from '../journal/errors.ts'

const TITLE = 'Escolha a pasta do projeto'

// Diálogo de pasta do Explorer (IFileOpenDialog com FOS_PICKFOLDERS), dono numa janela invisível sempre no topo
// para abrir na frente do navegador mesmo com o servidor em segundo plano.
const WINDOWS_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AdeFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr f);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr e, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem si);
    void SetFolder(IShellItem si);
    void GetFolder(out IShellItem si);
    void GetCurrentSelection(out IShellItem si);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem si);
  }
  public static string Pick(IntPtr owner, string title) {
    var dialog = (IFileDialog)new FileOpenDialog();
    uint fos; dialog.GetOptions(out fos);
    dialog.SetOptions(fos | 0x20 | 0x40);
    dialog.SetTitle(title);
    if (dialog.Show(owner) != 0) return "";
    IShellItem item; dialog.GetResult(out item);
    string name; item.GetDisplayName(0x80058000, out name);
    return name;
  }
}
'@
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; FormBorderStyle = 'None'; Opacity = 0; Width = 1; Height = 1; StartPosition = 'CenterScreen' }
$owner.Show(); $owner.Activate()
try { [AdeFolderPicker]::Pick($owner.Handle, '${TITLE}') } finally { $owner.Close() }
`

/**
 * Comando nativo que abre o seletor de pasta do sistema e imprime o caminho escolhido (vazio ou erro de cancelamento).
 */
export function folderPickerCommand(platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')],
    }
  }
  if (platform === 'darwin') return { file: 'osascript', args: ['-e', `POSIX path of (choose folder with prompt "${TITLE}")`] }
  return { file: 'zenity', args: ['--file-selection', '--directory', `--title=${TITLE}`] }
}

/**
 * Abre o seletor de pasta do sistema na máquina do servidor; devolve o caminho ou null se a pessoa cancelar.
 */
export function pickFolder({ platform = process.platform, execFile = defaultExecFile }: { platform?: NodeJS.Platform; execFile?: Function } = {}): Promise<string | null> {
  const { file, args } = folderPickerCommand(platform)
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => {
      // Cancelar: o osascript sai 1 com o erro -128; o zenity sai 1 sem saída; o Windows imprime vazio.
      if (err && err.code === 1 && (platform !== 'darwin' || String(stderr).includes('-128'))) return resolve(null)
      if (err) {
        return reject(new AdeError('folder_picker_failed', err.code === 'ENOENT'
          ? `O seletor de pasta (${file}) não está instalado; digite o caminho da pasta.`
          : `O seletor de pasta falhou: ${String(stderr || err.message).trim()}`, 2, { cause: err }))
      }
      const picked = String(stdout).trim()
      resolve(picked || null)
    })
  })
}
