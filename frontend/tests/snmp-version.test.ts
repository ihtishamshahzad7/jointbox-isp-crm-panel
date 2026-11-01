import { test } from "node:test";
import assert from "node:assert/strict";
import { isSnmpVersionFormValue, snmpVersionFormValue } from "../app/nas/[id]/snmp-version.ts";

test("SNMP enum values select the matching configuration form version", () => {
  assert.equal(snmpVersionFormValue("V1"), "1");
  assert.equal(snmpVersionFormValue("V2C"), "2c");
  assert.equal(snmpVersionFormValue("V3"), "3");
  assert.equal(snmpVersionFormValue("3"), "3");
  assert.equal(snmpVersionFormValue(null), "2c");
});

test("unknown SNMP versions are not silently mapped to a weaker protocol", () => {
  assert.throws(() => snmpVersionFormValue("unknown"), /Unsupported SNMP version/);
  assert.equal(isSnmpVersionFormValue("unknown"), false);
});
