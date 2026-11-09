using System.Drawing;
using System.Runtime.InteropServices;

namespace DshSuite.Shell;

/// <summary>Win32/DWM interop used by the frameless shell window.</summary>
internal static class NativeMethods
{
    // Window styles added to the borderless window so Windows keeps the native
    // sizing frame (resize borders, snap, minimise animation) and the DWM shadow.
    internal const int WsThickFrame = 0x00040000;
    internal const int WsMinimizeBox = 0x00020000;
    internal const int WsMaximizeBox = 0x00010000;
    internal const int WsSysMenu = 0x00080000;

    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaBorderColor = 34;
    private const int DwmwcpRound = 2;
    private const int DwmColorNone = unchecked((int)0xFFFFFFFE);

    internal const int WmNcLButtonDown = 0x00A1;
    internal const int WmGetMinMaxInfo = 0x0024;
    internal const int HtLeft = 10;
    internal const int HtRight = 11;
    internal const int HtTop = 12;
    internal const int HtTopLeft = 13;
    internal const int HtTopRight = 14;
    internal const int HtBottom = 15;
    internal const int HtBottomLeft = 16;
    internal const int HtBottomRight = 17;

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Margins
    {
        public int Left;
        public int Right;
        public int Top;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor;
        public Rect Work;
        public int Flags;
    }

    /// <summary>Win32 MINMAXINFO; every field is a POINT (two 32-bit ints).</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public Point Reserved;
        public Point MaxSize;
        public Point MaxPosition;
        public Point MinTrackSize;
        public Point MaxTrackSize;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    internal static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    internal static extern IntPtr SendMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);

    /// <summary>
    /// Turn the borderless form into a window that keeps the native DWM frame:
    /// a drop shadow (via a 1 px extended frame) and rounded Windows 11 corners.
    /// The sizing frame itself comes from the WS_THICKFRAME style bit added by
    /// <see cref="MainForm"/>; DWM paints the visible border and shadow.
    /// </summary>
    internal static void ApplyFramelessChrome(Form form)
    {
        if (!form.IsHandleCreated) return;

        var margins = new Margins { Left = 1, Right = 1, Top = 1, Bottom = 1 };
        _ = DwmExtendFrameIntoClientArea(form.Handle, ref margins);

        var round = DwmwcpRound;
        _ = DwmSetWindowAttribute(form.Handle, DwmwaWindowCornerPreference, ref round, sizeof(int));

        // This window paints its own content up to the window edge; the DWM
        // 1 px border would otherwise show as a dark line above the title bar.
        var noBorder = DwmColorNone;
        _ = DwmSetWindowAttribute(form.Handle, DwmwaBorderColor, ref noBorder, sizeof(int));
    }

    /// <summary>True while the window is maximized (the client covers the work area).</summary>
    internal static bool IsMaximized(IntPtr hwnd) => IsZoomed(hwnd);

    /// <summary>Screen work area of the monitor that hosts the window.</summary>
    internal static Rect GetWorkArea(IntPtr hwnd)
    {
        var monitor = MonitorFromWindow(hwnd, 2);
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        return GetMonitorInfo(monitor, ref info) ? info.Work : new Rect();
    }

    /// <summary>
    /// Size a maximized window to the monitor's work area instead of the whole
    /// monitor. A borderless form is a <c>WS_POPUP</c> window, so
    /// <c>DefWindowProc</c> answers <c>WM_GETMINMAXINFO</c> with the full monitor
    /// rectangle: the maximized window then covers the taskbar. Once the shell's
    /// fullscreen heuristic demotes the taskbar from topmost, that overlap turns
    /// into "the taskbar is visible but every click on it lands in our window"
    /// (its non-client strip at the bottom is never painted, so the taskbar
    /// shows through it). Pinning the maximized rectangle to the work area keeps
    /// the window off the taskbar.
    /// </summary>
    internal static void ApplyMaximizedWorkArea(IntPtr hwnd, IntPtr minMaxInfo)
    {
        if (minMaxInfo == IntPtr.Zero) return;

        var monitor = MonitorFromWindow(hwnd, 2);
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref info)) return;

        var limits = Marshal.PtrToStructure<MinMaxInfo>(minMaxInfo);
        // ptMaxPosition is relative to the monitor's top-left corner, not to the
        // desktop, so a taskbar on a secondary monitor still resolves correctly.
        limits.MaxPosition = new Point(
            info.Work.Left - info.Monitor.Left,
            info.Work.Top - info.Monitor.Top);
        limits.MaxSize = new Point(
            info.Work.Right - info.Work.Left,
            info.Work.Bottom - info.Work.Top);
        Marshal.StructureToPtr(limits, minMaxInfo, false);
    }

    /// <summary>Switch the DWM frame (1 px border and shadow) to dark colours.</summary>
    internal static void SetDarkFrame(Form form, bool dark)
    {
        if (!form.IsHandleCreated) return;
        var value = dark ? 1 : 0;
        _ = DwmSetWindowAttribute(form.Handle, DwmwaUseImmersiveDarkMode, ref value, sizeof(int));
    }
}
