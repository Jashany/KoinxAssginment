import * as SQLite from 'expo-sqlite';
import { LocalState, PassState, ScanEvent, DeviceInfo } from './types';

const DB_NAME = 'offline_scanner.db';

let db: SQLite.SQLiteDatabase | null = null;

/**
 * Initialize the SQLite database and create tables if they don't exist
 */
export async function initDatabase(): Promise<void> {
  try {
    db = await SQLite.openDatabaseAsync(DB_NAME);

    // Create scans table
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS scans (
        scan_id TEXT PRIMARY KEY,
        qr_code TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        date TEXT NOT NULL,
        synced_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_qr_timestamp ON scans(qr_code, timestamp);
      CREATE INDEX IF NOT EXISTS idx_qr_date ON scans(qr_code, date);
    `);

    // Create pass_types table (stores whether each QR is infinite or one-use)
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS pass_types (
        qr_code TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('infinite', 'one-use'))
      );
    `);

    // Create device_state table
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS device_state (
        device_id TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        ip_address TEXT
      );
    `);

    // Create broadcast_queue table (for retry mechanism)
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS broadcast_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        last_attempt INTEGER,
        created_at INTEGER NOT NULL
      );
    `);

    console.log('SQLite database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Save a scan event to the database
 */
export async function saveScanEvent(event: ScanEvent): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  try {
    await db.runAsync(
      `INSERT OR REPLACE INTO scans (scan_id, qr_code, timestamp, device_id, date, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [event.scanId, event.qrCode, event.timestamp, event.deviceId, event.date, Date.now()]
    );
  } catch (error) {
    console.error('Failed to save scan event:', error);
    throw error;
  }
}

/**
 * Save multiple scan events in a transaction (for batch sync)
 */
export async function saveScanEvents(events: ScanEvent[]): Promise<void> {
  if (!db) throw new Error('Database not initialized');
  if (events.length === 0) return;

  try {
    await db.withTransactionAsync(async () => {
      for (const event of events) {
        await db!.runAsync(
          `INSERT OR REPLACE INTO scans (scan_id, qr_code, timestamp, device_id, date, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [event.scanId, event.qrCode, event.timestamp, event.deviceId, event.date, Date.now()]
        );
      }
    });
  } catch (error) {
    console.error('Failed to save scan events:', error);
    throw error;
  }
}

/**
 * Get all scans for a specific QR code
 */
export async function getScansForQR(qrCode: string): Promise<ScanEvent[]> {
  if (!db) throw new Error('Database not initialized');

  try {
    const rows = await db.getAllAsync<{
      scan_id: string;
      qr_code: string;
      timestamp: number;
      device_id: string;
      date: string;
    }>(
      'SELECT scan_id, qr_code, timestamp, device_id, date FROM scans WHERE qr_code = ? ORDER BY timestamp ASC',
      [qrCode]
    );

    return rows.map(row => ({
      scanId: row.scan_id,
      qrCode: row.qr_code,
      timestamp: row.timestamp,
      deviceId: row.device_id,
      date: row.date,
    }));
  } catch (error) {
    console.error('Failed to get scans for QR:', error);
    return [];
  }
}

/**
 * Get all scans for a specific QR code on a specific date
 */
export async function getScansForQROnDate(qrCode: string, date: string): Promise<ScanEvent[]> {
  if (!db) throw new Error('Database not initialized');

  try {
    const rows = await db.getAllAsync<{
      scan_id: string;
      qr_code: string;
      timestamp: number;
      device_id: string;
      date: string;
    }>(
      'SELECT scan_id, qr_code, timestamp, device_id, date FROM scans WHERE qr_code = ? AND date = ? ORDER BY timestamp ASC',
      [qrCode, date]
    );

    return rows.map(row => ({
      scanId: row.scan_id,
      qrCode: row.qr_code,
      timestamp: row.timestamp,
      deviceId: row.device_id,
      date: row.date,
    }));
  } catch (error) {
    console.error('Failed to get scans for QR on date:', error);
    return [];
  }
}

/**
 * Load the complete state from the database
 */
export async function loadState(qrCodes: string[]): Promise<LocalState> {
  if (!db) throw new Error('Database not initialized');

  const state: LocalState = {};

  try {
    // Load pass types
    const passTypes = await db.getAllAsync<{ qr_code: string; type: 'infinite' | 'one-use' }>(
      'SELECT qr_code, type FROM pass_types'
    );

    const typeMap = new Map<string, 'infinite' | 'one-use'>();
    passTypes.forEach(row => typeMap.set(row.qr_code, row.type));

    // Load all scans
    for (const qrCode of qrCodes) {
      const scans = await getScansForQR(qrCode);
      const type = typeMap.get(qrCode) || (qrCode.includes('I') ? 'infinite' : 'one-use');

      state[qrCode] = {
        type,
        scans,
      };
    }

    return state;
  } catch (error) {
    console.error('Failed to load state:', error);
    return {};
  }
}

/**
 * Save or update pass type
 */
export async function savePassType(qrCode: string, type: 'infinite' | 'one-use'): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  try {
    await db.runAsync(
      'INSERT OR REPLACE INTO pass_types (qr_code, type) VALUES (?, ?)',
      [qrCode, type]
    );
  } catch (error) {
    console.error('Failed to save pass type:', error);
    throw error;
  }
}

/**
 * Update device state (for sequence number tracking)
 */
export async function updateDeviceState(deviceInfo: DeviceInfo): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  try {
    await db.runAsync(
      `INSERT OR REPLACE INTO device_state (device_id, last_sequence, last_seen, ip_address)
       VALUES (?, ?, ?, ?)`,
      [deviceInfo.deviceId, deviceInfo.lastSequence, deviceInfo.lastSeen, deviceInfo.ipAddress || null]
    );
  } catch (error) {
    console.error('Failed to update device state:', error);
    throw error;
  }
}

/**
 * Get device state
 */
export async function getDeviceState(deviceId: string): Promise<DeviceInfo | null> {
  if (!db) throw new Error('Database not initialized');

  try {
    const row = await db.getFirstAsync<{
      device_id: string;
      last_sequence: number;
      last_seen: number;
      ip_address: string | null;
    }>(
      'SELECT device_id, last_sequence, last_seen, ip_address FROM device_state WHERE device_id = ?',
      [deviceId]
    );

    if (!row) return null;

    return {
      deviceId: row.device_id,
      lastSequence: row.last_sequence,
      lastSeen: row.last_seen,
      ipAddress: row.ip_address || undefined,
    };
  } catch (error) {
    console.error('Failed to get device state:', error);
    return null;
  }
}

/**
 * Get all known devices
 */
export async function getAllDeviceStates(): Promise<DeviceInfo[]> {
  if (!db) throw new Error('Database not initialized');

  try {
    const rows = await db.getAllAsync<{
      device_id: string;
      last_sequence: number;
      last_seen: number;
      ip_address: string | null;
    }>('SELECT device_id, last_sequence, last_seen, ip_address FROM device_state');

    return rows.map(row => ({
      deviceId: row.device_id,
      lastSequence: row.last_sequence,
      lastSeen: row.last_seen,
      ipAddress: row.ip_address || undefined,
    }));
  } catch (error) {
    console.error('Failed to get all device states:', error);
    return [];
  }
}

/**
 * Add message to broadcast queue
 */
export async function enqueueBroadcast(message: string): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  try {
    await db.runAsync(
      'INSERT INTO broadcast_queue (message, attempts, created_at) VALUES (?, 0, ?)',
      [message, Date.now()]
    );
  } catch (error) {
    console.error('Failed to enqueue broadcast:', error);
    throw error;
  }
}

/**
 * Get pending broadcasts from queue
 */
export async function getPendingBroadcasts(maxAttempts: number = 5): Promise<Array<{ id: number; message: string; attempts: number }>> {
  if (!db) throw new Error('Database not initialized');

  try {
    const rows = await db.getAllAsync<{
      id: number;
      message: string;
      attempts: number;
    }>(
      'SELECT id, message, attempts FROM broadcast_queue WHERE attempts < ? ORDER BY created_at ASC LIMIT 10',
      [maxAttempts]
    );

    return rows;
  } catch (error) {
    console.error('Failed to get pending broadcasts:', error);
    return [];
  }
}

/**
 * Update broadcast attempt
 */
export async function updateBroadcastAttempt(id: number): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  try {
    await db.runAsync(
      'UPDATE broadcast_queue SET attempts = attempts + 1, last_attempt = ? WHERE id = ?',
      [Date.now(), id]
    );
  } catch (error) {
    console.error('Failed to update broadcast attempt:', error);
    throw error;
  }
}

/**
 * Remove broadcast from queue
 */
export async function removeBroadcast(id: number): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  try {
    await db.runAsync('DELETE FROM broadcast_queue WHERE id = ?', [id]);
  } catch (error) {
    console.error('Failed to remove broadcast:', error);
    throw error;
  }
}

/**
 * Get total scan count across all QR codes (for statistics)
 */
export async function getTotalScanCount(): Promise<number> {
  if (!db) throw new Error('Database not initialized');

  try {
    const row = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM scans'
    );

    return row?.count || 0;
  } catch (error) {
    console.error('Failed to get total scan count:', error);
    return 0;
  }
}

/**
 * Get pending broadcast queue size
 */
export async function getPendingBroadcastCount(): Promise<number> {
  if (!db) throw new Error('Database not initialized');

  try {
    const row = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM broadcast_queue WHERE attempts < 5'
    );

    return row?.count || 0;
  } catch (error) {
    console.error('Failed to get pending broadcast count:', error);
    return 0;
  }
}

/**
 * Clear all data (for testing/reset)
 */
export async function clearAllData(): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  try {
    await db.withTransactionAsync(async () => {
      await db!.runAsync('DELETE FROM scans');
      await db!.runAsync('DELETE FROM pass_types');
      await db!.runAsync('DELETE FROM device_state');
      await db!.runAsync('DELETE FROM broadcast_queue');
    });
    console.log('All data cleared successfully');
  } catch (error) {
    console.error('Failed to clear all data:', error);
    throw error;
  }
}
