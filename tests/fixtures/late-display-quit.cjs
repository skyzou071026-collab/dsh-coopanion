// Reproduce a queued OS display update after the native window is destroyed.
const { app, screen } = require('electron');
app.on('browser-window-created', (_event, win) => {
  win.once('closed', () => {
    if (process.connected) process.send({ type: 'late-display-injected' }, () => {});
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea']);
  });
});
