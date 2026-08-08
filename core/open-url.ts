import { execFile } from 'node:child_process';

export type BrowserCommand = {
  command: string;
  args: string[];
};

export function getBrowserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      return { command: 'explorer.exe', args: [url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}

export function openExternalUrl(url: string): Promise<void> {
  const { command, args } = getBrowserCommand(url);
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(new Error(`Could not open the browser with ${command}: ${error.message}`, { cause: error }));
        return;
      }
      resolve();
    });
  });
}
