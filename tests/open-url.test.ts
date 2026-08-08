import { describe, expect, it } from 'vitest';
import { getBrowserCommand } from '../core/open-url.js';

describe('getBrowserCommand', () => {
  const url = 'http://127.0.0.1:4747';

  it('uses open on macOS', () => {
    expect(getBrowserCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] });
  });

  it('uses explorer on Windows', () => {
    expect(getBrowserCommand(url, 'win32')).toEqual({ command: 'explorer.exe', args: [url] });
  });

  it('uses xdg-open on Linux', () => {
    expect(getBrowserCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
  });
});
