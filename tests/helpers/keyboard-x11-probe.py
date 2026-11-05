"""Isolated X11 integration test: known synthetic input, never content capture."""
import ctypes as C
import json
import os
import select
import subprocess
import sys
import time

x = C.CDLL('libX11.so.6')
test = C.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes = [C.c_char_p]; x.XOpenDisplay.restype = C.c_void_p
x.XFlush.argtypes = [C.c_void_p]
x.XCloseDisplay.argtypes = [C.c_void_p]
test.XTestFakeKeyEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
test.XTestFakeMotionEvent.argtypes = [C.c_void_p, C.c_int, C.c_int, C.c_int, C.c_ulong]
test.XTestFakeButtonEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
display = x.XOpenDisplay(None)
assert display, 'Test display unavailable'
helper = subprocess.Popen(['/usr/bin/python3', '-I', '-u', sys.argv[1]], stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)

def sample(timeout=3):
    ready, _, _ = select.select([helper.stdout], [], [], timeout)
    assert ready, 'Helper heartbeat missing'
    line = helper.stdout.readline().decode().strip()
    assert line in ('active', 'idle', 'unknown'), 'Invalid helper output'
    return line

def until(state, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if sample() == state:
            return
    raise AssertionError('Expected ' + state)

try:
    until('idle')
    # Keep moving and clicking through multiple heartbeat intervals. It must stay idle.
    mouse_deadline = time.monotonic() + 2
    i = 0
    while time.monotonic() < mouse_deadline:
        test.XTestFakeMotionEvent(display, -1, 20 + i % 50, 20, 0)
        test.XTestFakeButtonEvent(display, 1, 1, 0)
        test.XTestFakeButtonEvent(display, 1, 0, 0)
        x.XFlush(display)
        assert sample() == 'idle', 'Mouse must not be classified as keyboard activity'
        i += 1
    # A known test key is sent; the helper never reads its identity or payload.
    test.XTestFakeKeyEvent(display, 38, 1, 0)
    test.XTestFakeKeyEvent(display, 38, 0, 0)
    x.XFlush(display)
    until('active')
    until('idle')
    print(json.dumps({'platform': 'linux-x11', 'syntheticKeyboardDetected': True,
                      'mouseOnlyRemainsIdle': True, 'returnsIdle': True,
                      'physicalTypingValidated': False}))
finally:
    helper.terminate()
    helper.wait(timeout=3)
    x.XCloseDisplay(display)
