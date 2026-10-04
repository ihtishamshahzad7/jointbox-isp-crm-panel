import { ServiceUnavailableException } from '@nestjs/common';
import { gitFailure } from './app.controller';

/**
 * git prints the remote URL in its errors, and a deploy remote often carries
 * a token. The update screen and the log must never echo it.
 */
describe('update errors', () => {
  it('masks credentials in remote URLs and known token formats', () => {
    const msg = gitFailure('check', {
      message: "Command failed: git fetch origin main\nfatal: unable to access 'https://deploy:ghp_abcdefghijklmnop1234@github.com/acme/panel.git/': Could not resolve host",
    }).message;
    expect(msg).not.toMatch(/ghp_abcdefghijklmnop1234/);
    expect(msg).not.toMatch(/deploy:/);
    expect(msg).toMatch(/https:\/\/\*\*\*@github\.com/);
  });

  it('a server not installed from git gets a plain explanation, not a 500', () => {
    const e = gitFailure('check', { message: 'fatal: not a git repository (or any of the parent directories): .git' });
    expect(e).toBeInstanceOf(ServiceUnavailableException);
  });
});
