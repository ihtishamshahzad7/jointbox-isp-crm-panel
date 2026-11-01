export type SnmpVersionFormValue = "1" | "2c" | "3";

export function isSnmpVersionFormValue(value: string): value is SnmpVersionFormValue {
  return value === "1" || value === "2c" || value === "3";
}

export function snmpVersionFormValue(version?: string | null): SnmpVersionFormValue {
  switch (String(version ?? "V2C").trim().toUpperCase()) {
    case "1":
    case "V1":
      return "1";
    case "2":
    case "2C":
    case "V2C":
      return "2c";
    case "3":
    case "V3":
      return "3";
    default:
      throw new Error("Unsupported SNMP version returned by the server.");
  }
}
