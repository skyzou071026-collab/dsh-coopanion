# Run only inside the isolated Windows test user's interactive session.
# https://learn.microsoft.com/windows/win32/shell/abm-setstate
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshTaskbarGeometry {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Data {
    public uint size; public IntPtr window; public uint callback, edge; public Rect rect; public IntPtr state;
  }
  [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint message, ref Data data);
  public static uint Read() { var data = new Data { size = (uint)Marshal.SizeOf(typeof(Data)) }; return (uint)SHAppBarMessage(4, ref data).ToUInt64(); }
  public static void Set(uint state) { var data = new Data { size = (uint)Marshal.SizeOf(typeof(Data)), state = new IntPtr(state) }; SHAppBarMessage(10, ref data); }
}
'@
$before = [DshTaskbarGeometry]::Read()
if ($null -ne $requestedState) {
  if ($requestedState -lt 0 -or $requestedState -gt 3) { throw 'Invalid taskbar state' }
  [DshTaskbarGeometry]::Set([uint32]$requestedState)
}
@{ before = $before; after = [DshTaskbarGeometry]::Read() } | ConvertTo-Json -Compress
