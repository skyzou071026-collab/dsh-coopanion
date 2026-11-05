"""XInput2 event category only. Never fetch cookie data, key codes or key maps."""
import ctypes as C
import os
import select
import sys
import time


def run():
    if os.environ.get('WAYLAND_DISPLAY') or os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland' or not os.environ.get('DISPLAY'):
        raise RuntimeError()
    x = C.CDLL('libX11.so.6')
    xi = C.CDLL('libXi.so.6')
    # Only the generic-event header is represented. The opaque payload is not fetched.
    class Header(C.Structure):
        _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int),
                    ('display', C.c_void_p), ('extension', C.c_int), ('evtype', C.c_int)]
    class Event(C.Union):
        _fields_ = [('header', Header), ('padding', C.c_long * 24)]
    class Mask(C.Structure):
        _fields_ = [('deviceid', C.c_int), ('mask_len', C.c_int), ('mask', C.POINTER(C.c_ubyte))]
    x.XOpenDisplay.argtypes = [C.c_char_p]; x.XOpenDisplay.restype = C.c_void_p
    x.XDefaultRootWindow.argtypes = [C.c_void_p]; x.XDefaultRootWindow.restype = C.c_ulong
    x.XQueryExtension.argtypes = [C.c_void_p, C.c_char_p, C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int)]
    x.XConnectionNumber.argtypes = [C.c_void_p]; x.XConnectionNumber.restype = C.c_int
    x.XPending.argtypes = [C.c_void_p]
    x.XNextEvent.argtypes = [C.c_void_p, C.POINTER(Event)]
    x.XFlush.argtypes = [C.c_void_p]
    x.XCloseDisplay.argtypes = [C.c_void_p]
    xi.XIQueryVersion.argtypes = [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)]
    xi.XISelectEvents.argtypes = [C.c_void_p, C.c_ulong, C.POINTER(Mask), C.c_int]
    display = x.XOpenDisplay(None)
    if not display:
        raise RuntimeError()
    try:
        opcode, first, error = C.c_int(), C.c_int(), C.c_int()
        if x.XQueryExtension(display, b'XWAYLAND', C.byref(opcode), C.byref(first), C.byref(error)):
            raise RuntimeError()
        if not x.XQueryExtension(display, b'XInputExtension', C.byref(opcode), C.byref(first), C.byref(error)):
            raise RuntimeError()
        major, minor = C.c_int(2), C.c_int(1)
        if xi.XIQueryVersion(display, C.byref(major), C.byref(minor)) != 0 or (major.value, minor.value) < (2, 1):
            raise RuntimeError()
        bits = (C.c_ubyte * 2)()
        for kind in (13, 14):  # XI_RawKeyPress / XI_RawKeyRelease, not key identifiers.
            bits[kind >> 3] |= 1 << (kind & 7)
        mask = Mask(1, 2, bits)  # XIAllMasterDevices; avoid duplicate slave notifications.
        if xi.XISelectEvents(display, x.XDefaultRootWindow(display), C.byref(mask), 1) != 0:
            raise RuntimeError()
        x.XFlush(display)
        fd, parent = x.XConnectionNumber(display), os.getppid()
        started, last, due = time.monotonic(), None, time.monotonic()
        event = Event()
        while parent > 1 and os.getppid() == parent:
            # Bound each drain so an input flood cannot starve heartbeats or termination.
            for _ in range(256):
                if not x.XPending(display):
                    break
                x.XNextEvent(display, C.byref(event))
                h = event.header
                if h.type == 35 and h.extension == opcode.value and h.evtype in (13, 14):
                    last = time.monotonic()
            now = time.monotonic()
            if now >= due:
                print('unknown' if now - started < 1.5 else 'active' if last is not None and now - last < 1.5 else 'idle', flush=True)
                due = now + .5
            select.select([fd], [], [], max(0, due - time.monotonic()))
    finally:
        x.XCloseDisplay(display)


if __name__ == '__main__':
    try:
        run()
    except Exception:
        print('unknown', flush=True)
        sys.exit(1)
