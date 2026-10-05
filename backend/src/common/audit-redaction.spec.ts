import { redactForAudit } from './audit.interceptor';

/**
 * Found on a running panel: settings saved as { key, value } and alert
 * channels saved as { kind, value, extra } landed in the audit log in plain
 * text, readable by anyone allowed to read the log.
 */
describe('audit log redaction', () => {
  it('masks setting values, channel values and nested secrets', () => {
    const out = redactForAudit({
      key: 'WHATSAPP_TOKEN', value: 'EAAGabc', kind: 'DISCORD', extra: 'x',
      nas: { nasname: '10.1.0.1', secret: 's3cret', snmpCommunity: 'public' },
      url: 'https://user:pw@host/x', name: 'Router A',
    });
    expect(JSON.stringify(out)).not.toMatch(/EAAGabc|s3cret|public|user:pw/);
    expect(out.kind).toBe('DISCORD');
    expect(out.name).toBe('Router A');
    expect(out.nas.nasname).toBe('10.1.0.1');
  });
});
