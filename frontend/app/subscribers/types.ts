/**
 * Shared subscriber types — imported by page.tsx and subscriber-table.tsx so
 * both sides of the table contract agree on the row shape. The backend list
 * endpoint returns FULL subscriber records (no SELECT narrowing) plus the
 * `liveStatus` enrichments, so rows ARE `Subscriber`-shaped at runtime; the
 * table's render extras (daysLeft …) are computed per render on top.
 */
export interface Package {
  id: number;
  name: string;
  price: number;
  downloadSpeed: number;
  uploadSpeed: number;
  pool?: { name: string } | null;
}
export interface Area { id: number; name: string; }
export interface NasEntry { id: number; nasname: string; nasIp: string | null; isActive: boolean; }
export interface Salesperson { id: number; name: string; }

export interface Subscriber {
  id: number;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  username: string | null;
  password: string | null;
  identity: string | null;
  connectionType: string;
  status: "ACTIVE" | "EXPIRED" | "SUSPENDED" | "INACTIVE";
  packageId: number | null;
  areaId: number | null;
  nasId: number | null;
  salespersonId: number | null;
  documentUrl: string | null;
  photoUrl?: string | null;
  cnicFrontUrl?: string | null;
  cnicBackUrl?: string | null;
  installationDate: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: string;
  package?: Package;
  area?: Area;
  nas?: NasEntry;
  /** WHO SOLD IT — attribution only. Carries no wallet and no visibility. */
  salesperson?: Salesperson;
  /**
   * WHO OWNS IT — whose wallet is charged on activation and in whose subtree
   * this customer appears.
   */
  userId?: number | null;
  user?: { id: number; name: string; role: string } | null;
  serviceSettings?: {
    expiryDate?: string | null;
    staticIp?: string | null;
  } | null;
  // Runtime-only flags added by the API / live-status merge (not columns).
  isStaleSession?: boolean;
  isOnline?: boolean;
  liveStatus?: "ONLINE" | "OFFLINE" | string;
}