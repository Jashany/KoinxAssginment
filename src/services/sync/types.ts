// CRDT-based types for conflict-free replication
export interface ScanEvent {
  scanId: string;        // UUID for this specific scan
  qrCode: string;        // The QR code that was scanned
  timestamp: number;     // Milliseconds since epoch
  deviceId: string;      // Unique device identifier
  date: string;          // Date key (e.g., "14nov", "15nov")
}

export interface PassState {
  type: "infinite" | "one-use";
  scans: ScanEvent[];    // Append-only log of all scans
}

export type LocalState = Record<string, PassState>;

export interface StateMessage {
  type: "delta" | "full-state" | "state-request";
  deltas?: ScanEvent[];      // New scans since last broadcast
  fullState?: LocalState;    // Complete state (for full sync)
  sequenceNum: number;       // Per-device sequence number
  deviceId: string;          // Sender's device ID
  timestamp: number;         // Message creation time
}

export interface DeviceInfo {
  deviceId: string;
  lastSequence: number;
  lastSeen: number;
  ipAddress?: string; // Peer's IP address for unicast
}

export interface ScanValidationResult {
  allowed: boolean;
  reason?: string;
  todayScansCount?: number;
}

// Legacy types (for backward compatibility during migration)
export type LegacyCodeEntry =
  | {
      type: "infinite";
      [key: string]: boolean | number | string | undefined;
      count: number;
    }
  | {
      type: "one-use";
      [key: string]: boolean | string | undefined;
    };

export type LegacyLocalState = Record<string, LegacyCodeEntry>;
