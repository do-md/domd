// The Electron app the benchmark drives when --electron is given: one hidden
// window on the bench page, set up like ponjo's test/views/main.js (same
// window size, smooth scrolling off, no background throttling), so the
// engine and window are the same as the ponjo numbers it is compared with.
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('disable-smooth-scrolling');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  window.loadFile(process.env.BENCH_PAGE);
});
app.on('window-all-closed', () => app.quit());
