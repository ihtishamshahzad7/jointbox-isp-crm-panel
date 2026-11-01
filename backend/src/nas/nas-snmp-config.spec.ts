/**
 * Stage 2 — SNMP config validation, normalisation, and secret redaction.
 */
import { BadRequestException } from '@nestjs/common';
import {
  assertSnmpTargetAllowed,
  assertValidSnmpPort,
  clampInt,
  normalizeMonitoredPorts,
  assertSnmpConfigValid,
  normalizeSnmpVersion,
} from './nas-snmp-config';
import { sanitizeNas } from './nas-credentials';

describe('SNMP config helpers (Stage 2)', () => {
  describe('clampInt', () => {
    it('clamps into range and defaults non-numbers', () => {
      expect(clampInt(5, 10, 100, 30)).toBe(10);
      expect(clampInt(99999, 10, 100, 30)).toBe(100);
      expect(clampInt('abc', 10, 100, 30)).toBe(30);
      expect(clampInt(42, 10, 100, 30)).toBe(42);
    });
  });

  describe('normalizeMonitoredPorts', () => {
    it('accepts arrays, CSV and JSON; null when empty', () => {
      expect(normalizeMonitoredPorts(['ether1', 'ether2'])).toBe('["ether1","ether2"]');
      expect(normalizeMonitoredPorts('ether1, ether2')).toBe('["ether1","ether2"]');
      expect(normalizeMonitoredPorts('["vlan10"]')).toBe('["vlan10"]');
      expect(normalizeMonitoredPorts('')).toBeNull();
      expect(normalizeMonitoredPorts(null)).toBeNull();
    });
  });

  describe('assertSnmpConfigValid — never a silent downgrade', () => {
    it('allows v2c without extra validation', () => {
      expect(() => assertSnmpConfigValid({ snmpVersion: 'V2C' }, {})).not.toThrow();
    });

    it('accepts a complete SNMPv3 authPriv configuration', () => {
      expect(() => assertSnmpConfigValid({}, {
        snmpVersion: 'V3', snmpV3User: 'netops', snmpV3SecLevel: 'authPriv',
        snmpV3AuthProto: 'SHA', snmpV3AuthPass: 'enc:auth', snmpV3PrivProto: 'AES', snmpV3PrivPass: 'enc:priv',
      })).not.toThrow();
    });

    it('rejects v3 with no username', () => {
      expect(() => assertSnmpConfigValid({}, { snmpVersion: 'V3', snmpV3SecLevel: 'authPriv' }))
        .toThrow(BadRequestException);
    });

    it('rejects v3 with no / invalid security level', () => {
      expect(() => assertSnmpConfigValid({}, { snmpVersion: 'V3', snmpV3User: 'u' }))
        .toThrow(/security level/i);
    });

    it('rejects authPriv missing the privacy passphrase (no silent downgrade)', () => {
      expect(() => assertSnmpConfigValid({}, {
        snmpVersion: 'V3', snmpV3User: 'u', snmpV3SecLevel: 'authPriv',
        snmpV3AuthProto: 'SHA', snmpV3AuthPass: 'enc:auth', snmpV3PrivProto: 'AES', // no priv pass
      })).toThrow(/privacy passphrase/i);
    });

    it('rejects authNoPriv missing the auth passphrase', () => {
      expect(() => assertSnmpConfigValid({}, {
        snmpVersion: 'V3', snmpV3User: 'u', snmpV3SecLevel: 'authNoPriv', snmpV3AuthProto: 'SHA',
      })).toThrow(/authentication passphrase/i);
    });

    it('uses EXISTING stored passphrases when the update only changes the level', () => {
      // Passphrases already stored; the update just (re)affirms authPriv.
      expect(() => assertSnmpConfigValid(
        { snmpVersion: 'V3', snmpV3User: 'u', snmpV3AuthProto: 'SHA', snmpV3AuthPass: 'enc:a', snmpV3PrivProto: 'AES', snmpV3PrivPass: 'enc:p' },
        { snmpV3SecLevel: 'authPriv' },
      )).not.toThrow();
    });
  });

  describe('normalizeSnmpVersion', () => {
    it('maps supported UI and enum forms to the Prisma enum', () => {
      expect(normalizeSnmpVersion('1')).toBe('V1');
      expect(normalizeSnmpVersion('2c')).toBe('V2C');
      expect(normalizeSnmpVersion('2')).toBe('V2C');
      expect(normalizeSnmpVersion('3')).toBe('V3');
      expect(normalizeSnmpVersion('V3')).toBe('V3');
      expect(() => normalizeSnmpVersion('nonsense')).toThrow(BadRequestException);
      expect(() => normalizeSnmpVersion('')).toThrow(BadRequestException);
    });
  });

  describe('SNMP target restrictions', () => {
    it('requires an operator allowlist and rejects out-of-range destinations', () => {
      expect(() => assertSnmpTargetAllowed('10.20.30.40', 161, '')).toThrow(/SNMP_ALLOWED_CIDRS/);
      expect(() => assertSnmpTargetAllowed('10.20.30.40', 161, '10.20.0.0/16')).not.toThrow();
      expect(() => assertSnmpTargetAllowed('10.20.30.40', 161, '10.21.0.0/16')).toThrow(/outside/);
    });

    it('validates target addresses, CIDR syntax, and SNMP ports', () => {
      expect(() => assertSnmpTargetAllowed('router.example', 161, '10.0.0.0/8')).toThrow(/valid IP address/);
      expect(() => assertSnmpTargetAllowed('10.1.2.3', 161, '10.0.0.0/99')).toThrow(/CIDR prefix/);
      expect(() => assertSnmpTargetAllowed('10.1.2.3', 65536, '10.0.0.0/8')).toThrow(/SNMP port/);
      expect(() => assertValidSnmpPort(0)).toThrow(/SNMP port/);
    });

    it('supports IPv6 allowlisted targets', () => {
      expect(() => assertSnmpTargetAllowed('2001:db8::5', 161, '2001:db8::/32')).not.toThrow();
    });
  });

  describe('secret redaction', () => {
    it('masks SNMP community and v3 passphrases, exposes has-flags only', () => {
      const out: any = sanitizeNas({
        id: 1, nasname: 'n1',
        snmpCommunity: 'enc:v1:supersecret',
        snmpV3AuthPass: 'enc:v1:authsecret',
        snmpV3PrivPass: 'enc:v1:privsecret',
        snmpV3User: 'netops',
      });
      expect(out.snmpCommunity).not.toContain('supersecret');
      expect(out.snmpV3AuthPass).not.toContain('authsecret');
      expect(out.snmpV3PrivPass).not.toContain('privsecret');
      expect(out.hasSnmpCommunity).toBe(true);
      expect(out.hasSnmpV3AuthPass).toBe(true);
      expect(out.hasSnmpV3PrivPass).toBe(true);
      expect(out.snmpV3User).toBe('netops'); // username is not a secret
    });
  });
});
