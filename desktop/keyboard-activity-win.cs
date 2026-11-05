// Raw Input notification only: never call GetRawInputData or inspect key payloads.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class KeyboardActivity : NativeWindow {
    [StructLayout(LayoutKind.Sequential)]
    struct Device { public ushort page, usage; public uint flags; public IntPtr target; }
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices(Device[] devices, uint count, uint size);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")]
    static extern bool CloseDesktop(IntPtr desktop);
    readonly Stopwatch clock = Stopwatch.StartNew();
    long last = -1;
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x00ff) last = clock.ElapsedMilliseconds;
        // Includes required foreground raw-input cleanup, without dereferencing lParam.
        base.WndProc(ref message);
    }
    [STAThread]
    public static void Run(int parentPid) {
        using (var parent = Process.GetProcessById(parentPid)) {
            var window = new KeyboardActivity();
            // Message-only window; never takes focus or suppresses normal keyboard input.
            window.CreateHandle(new CreateParams { Parent = new IntPtr(-3) });
            var devices = new[] { new Device { page = 1, usage = 6, flags = 0x100, target = window.Handle } };
            if (!RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(Device)))) {
                window.DestroyHandle(); throw new InvalidOperationException();
            }
            using (var timer = new Timer { Interval = 500 }) {
                timer.Tick += delegate {
                    if (parent.HasExited) { Application.ExitThread(); return; }
                    var desktop = OpenInputDesktop(0, false, 1);
                    bool available = desktop != IntPtr.Zero && Environment.UserInteractive && !SystemInformation.TerminalServerSession;
                    if (desktop != IntPtr.Zero) CloseDesktop(desktop);
                    // A fresh registration needs an observation window before claiming idle.
                    string state = !available || window.clock.ElapsedMilliseconds < 1500 ? "unknown"
                        : window.last >= 0 && window.clock.ElapsedMilliseconds - window.last < 1500 ? "active" : "idle";
                    Console.Out.WriteLine(state); Console.Out.Flush();
                };
                try { timer.Start(); Application.Run(); }
                finally {
                    RegisterRawInputDevices(new[] { new Device { page = 1, usage = 6, flags = 1, target = IntPtr.Zero } }, 1, (uint)Marshal.SizeOf(typeof(Device)));
                    window.DestroyHandle();
                }
            }
        }
    }
}
