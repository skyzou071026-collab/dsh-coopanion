// Read-only native measurements for isolated test profiles. Never loaded by a normal install.
module.exports.installDisplayProbe = ({ ipcMain, screen, win, displays }) => {
  ipcMain.handle('pet:test-screen-point', (event, value) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !value || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(value[k])) || value.width <= 0 || value.height <= 0) return null;
    const b = win.getContentBounds();
    const dip = { x: Math.round(b.x + value.x * b.width / value.width), y: Math.round(b.y + value.y * b.height / value.height) };
    // CoreGraphics cursor points are logical global coordinates. X11/Win32 need
    // the platform converter: global DIP * devicePixelRatio breaks mixed DPI.
    const point = process.platform === 'darwin' ? dip : screen.dipToScreenPoint(dip);
    return { point, dip, geometry: displays.state, contentBounds: b, cursor: screen.getCursorScreenPoint(),
      displays: screen.getAllDisplays().map(d => ({id:d.id,label:d.label,bounds:d.bounds,workArea:d.workArea,scaleFactor:d.scaleFactor,rotation:d.rotation})), electron: process.versions.electron };
  });
};
