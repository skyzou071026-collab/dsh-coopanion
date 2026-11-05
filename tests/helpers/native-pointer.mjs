import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Electron supplies physical pixels for Windows input. PowerShell starts DPI
// unaware: both cursor movement and readback can otherwise be virtualized.
async function warpWindowsCursor({ x, y }) {
  assert.ok(Number.isFinite(x) && Number.isFinite(y), 'Native cursor requires finite physical coordinates');
  const point = { x: Math.round(x), y: Math.round(y) };
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PetNativeCursor {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out POINT point);
}
'@
$previous = [PetNativeCursor]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($previous -eq [IntPtr]::Zero) { throw 'Cannot set native input DPI awareness' }
if (-not [PetNativeCursor]::SetCursorPos(${point.x}, ${point.y})) { throw 'Cannot move the native test cursor' }
$actual = New-Object PetNativeCursor+POINT
if (-not [PetNativeCursor]::GetPhysicalCursorPos([ref]$actual)) { throw 'Cannot read the physical cursor' }
if ($actual.x -ne ${point.x} -or $actual.y -ne ${point.y}) { throw 'Native cursor did not reach the requested physical point' }
`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
}

const warpMacCursor = `
import ctypes, sys
class Point(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
cg.CGWarpMouseCursorPosition.argtypes = [Point]
cg.CGWarpMouseCursorPosition.restype = ctypes.c_int32
if cg.CGWarpMouseCursorPosition(Point(float(sys.argv[1]), float(sys.argv[2]))) != 0:
    raise RuntimeError('Cannot move the native test cursor')
`;
const warpCursor = `
import ctypes, sys
x11 = ctypes.CDLL('libX11.so.6')
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XWarpPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_int, ctypes.c_int]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
display = x11.XOpenDisplay(None)
if not display:
    raise RuntimeError('Cannot open the native test display')
x11.XWarpPointer(display, 0, x11.XDefaultRootWindow(display), 0, 0, 0, 0, int(sys.argv[1]), int(sys.argv[2]))
x11.XSync(display, 0)
x11.XCloseDisplay(display)
`;

/** Exercise real click-through hit testing with the OS and CDP cursors at the same point. */
export async function petClick(page, options = {}, twice = false) {
  await page.evaluate(() => {
    if (window.__nativeInputTrace) { window.__nativeInputTrace.length = 0; return; }
    window.__nativeInputTrace = [];
    const record = entry => { window.__nativeInputTrace.push({ t: Math.round(performance.now()), ...entry }); if (window.__nativeInputTrace.length > 100) window.__nativeInputTrace.shift(); };
    window.dshPetBridge.subscribe(message => { if (['cursor', 'hit-state'].includes(message.type)) record(message); });
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'contextmenu']) document.addEventListener(type, event => {
      const pet = document.getElementById('pet'), box = pet.getBoundingClientRect();
      record({ type, target: `${event.target.tagName}#${event.target.id}`, x: event.clientX, y: event.clientY, nativeHit: pet.dataset.nativeHit, mode: pet.dataset.mode, hidden: pet.hidden, focus: document.hasFocus(), box: { x: box.x, y: box.y, w: box.width, h: box.height } });
    }, true);
  });
  const pet = page.locator('#pet');
  await pet.waitFor({ state: 'visible' });
  // CDP can attach to an inactive target after relaunch. Activate it before
  // ordinary pointer input; the desktop itself continues to show without stealing focus.
  await page.bringToFront();
  if (process.platform === 'darwin') {
    // A restarted transparent window can appear under a stationary cursor.
    // Observe a real leave/enter through the native cursor poll before CDP input.
    const origin = await pet.evaluate(() => ({ x: screenX, y: screenY }));
    await run('python3', ['-c', warpMacCursor, String(origin.x), String(origin.y)]);
    await page.waitForSelector('#pet[data-native-hit=false]');
    // Roaming can move the body while the cursor helper starts. Track its
    // current position until the native window acknowledges entry, then click.
    let entered = false;
    for (let attempt = 0; attempt < 10 && !entered; attempt++) {
      const point = await pet.evaluate(el => {
        const b = el.getBoundingClientRect(), x = b.x + b.width / 2, y = b.y + b.height / 2;
        return { x, y, screenX: screenX + x, screenY: screenY + y };
      });
      await run('python3', ['-c', warpMacCursor, String(point.screenX), String(point.screenY)]);
      await page.mouse.move(point.x, point.y);
      try { await page.waitForSelector('#pet[data-native-hit=true]', { timeout: 300 }); entered = true; }
      catch (error) { if (error.name !== 'TimeoutError') throw error; }
    }
    assert.ok(entered, `Native cursor did not enter the moving pet: ${JSON.stringify(await page.evaluate(() => window.__nativeInputTrace))}`);
  }
  if (process.platform === 'linux' && process.env.DISPLAY) {
    // CDP moves a virtual pointer. Enabling native input also generates X11
    // movement at the physical cursor; keep both at the same point as a user.
    const { point } = await nativeMeasurement(page, '#pet');
    await run('python3', ['-c', warpCursor, String(point.x), String(point.y)]);
  }
  if (process.platform === 'win32') {
    const { point } = await nativeMeasurement(page, '#pet');
    await warpWindowsCursor(point);
  }
  await pet.hover();
  await page.waitForSelector('#pet[data-native-hit=true]');
  if (process.platform === 'darwin') {
    // Hover freezes roaming. Use one fresh point for both pointers so a later
    // locator stability check cannot choose another point in the breathing body.
    const point = await pet.evaluate(el => {
      const b = el.getBoundingClientRect(), x = b.x + b.width / 2, y = b.y + b.height / 2;
      return { x, y, screenX: screenX + x, screenY: screenY + y };
    });
    await run('python3', ['-c', warpMacCursor, String(point.screenX), String(point.screenY)]);
    await page.mouse[twice ? 'dblclick' : 'click'](point.x, point.y, options);
  } else await pet[twice ? 'dblclick' : 'click'](options);
  if (options.button === 'right') {
    try { await page.locator('#menu').waitFor({ state: 'visible', timeout: 3000 }); }
    catch (error) { console.log('Native pointer failure:', JSON.stringify(await page.evaluate(() => window.__nativeInputTrace))); throw error; }
    const trace = await page.evaluate(() => window.__nativeInputTrace);
    assert.ok(trace.some(event => event.type === 'pointerdown' && event.target === 'DIV#pet'), 'native right click reaches the pet');
    assert.ok(trace.some(event => event.type === 'contextmenu' && event.target === 'DIV#pet'), 'native right click opens the menu through contextmenu');
    if (process.env.DSH_PET_INPUT_TRACE === '1') console.log('Native pointer pass:', JSON.stringify(trace));
  }
}

/** Measurements and physical conversion come from the tested Electron instance. */
export async function nativeMeasurement(page, selector) {
  return page.locator(selector).evaluate(el => {
    const b = el.getBoundingClientRect();
    if (!window.dshPetBridge.testScreenPoint) throw new Error('Native measurement requires an isolated debug test profile');
    const css = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    return window.dshPetBridge.testScreenPoint({...css,width:innerWidth,height:innerHeight}).then(native => ({ ...native, css }));
  });
}

/** Native OS cursor + CDP click on a panel's measured CSS hit region. */
export async function nativeClick(page, selector) {
  await page.bringToFront();
  await page.locator(selector).click({ trial: true });
  const measurement = await nativeMeasurement(page, selector), p = measurement.point;
  if (process.platform === 'darwin') await run('python3', ['-c', warpMacCursor, String(p.x), String(p.y)]);
  else if (process.platform === 'linux') await run('python3', ['-c', warpCursor, String(p.x), String(p.y)]);
  else await warpWindowsCursor(p);
  // A font/size update can reflow the panel while the OS helper starts. Keep
  // CDP and the physical cursor on the same measured point rather than mixing
  // two layout samples; locator trial above waits for actionability/stability.
  const { x, y } = measurement.css;
  await page.mouse.move(x, y);
  await page.waitForSelector('#pet[data-native-hit=true]');
  await page.mouse.click(x, y);
  const observed = await nativeMeasurement(page, selector);
  assert.ok(Math.hypot(observed.cursor.x - measurement.dip.x, observed.cursor.y - measurement.dip.y) <= 2,
    `OS cursor reaches the measured DIP point: ${JSON.stringify({ measurement, observed })}`);
  return { ...measurement, cursorAfterClick: observed.cursor };
}

/** Keep the OS cursor and CDP pointer away from an autonomous walking path. */
export async function parkNativePointer(page) {
  const origin = await page.evaluate(() => ({ x: screenX + 2, y: screenY + 2 }));
  if (process.platform === 'darwin') await run('python3', ['-c', warpMacCursor, String(origin.x), String(origin.y)]);
  else if (process.platform === 'linux' && process.env.DISPLAY) await run('python3', ['-c', warpCursor, String(origin.x), String(origin.y)]);
  else if (process.platform === 'win32') {
    const point = await page.evaluate(() => window.dshPetBridge.testScreenPoint({ x: 2, y: 2, width: innerWidth, height: innerHeight }).then(value => value.point));
    await warpWindowsCursor(point);
  }
  await page.mouse.move(2, 2);
}
