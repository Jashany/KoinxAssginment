// services/sync/state.ts
import * as Network from "expo-network";
import * as Crypto from 'expo-crypto';
import { serviceEvents } from "./events";
import { initSocket, setBroadcastAddr, sendDelta } from "./network";
import { LocalState, PassState, ScanEvent, StateMessage, DeviceInfo } from "./types";
import * as Storage from "./storage";

// UUID v4 generator using expo-crypto
function uuidv4(): string {
  return Crypto.randomUUID();
}

// Device identifier (persisted in memory for this session)
let deviceId: string = "";
let sequenceNumber: number = 0;

// In-memory state (loaded from SQLite)
let localState: LocalState = {};

// Known peer devices
const knownDevices: Map<string, DeviceInfo> = new Map();

// Periodic sync interval
let syncInterval: ReturnType<typeof setInterval> | null = null;

// QR codes list (hardcoded for now)
export const QR_CODES = [
  // Infinite passes
  "SAT25IBLXRRU",
  "SAT25IPGOP23",
  "SAT25I32LFFI",
  "SAT25IB2JHC0",
  "SAT25IIPXM4M",
  "SAT25I5N8EKB",
  "SAT25ITPC3AZ",
  "SAT25IW6YXON",
  "SAT25ITUBCAP",
  "SAT25I8JOGTS",
  // One-use passes
  "SAT25SD724M2",
  "SAT25S9NHZT5",
  "SAT25SLTAAGR",
  "SAT25SCA78P3",
  "SAT25SI3IVAX",
  "SAT25SWRG0M5",
  "SAT25S36GKMG",
  "SAT25SJ5CNQK",
  "SAT25S5SCQG0",
  "SAT25SEK2YC1",
];

/**
 * Initialize P2P service with CRDT-based sync
 * Optimized for 4-5 devices
 */
export async function initializeP2P() {
  try {
    console.log("Initializing P2P service...");

    // 1. Initialize SQLite database
    await Storage.initDatabase();

    // 2. Generate or load device ID
    deviceId = uuidv4();
    console.log(`Device ID: ${deviceId}`);

    // 3. Initialize UDP socket
    await initSocket();

    // 4. Initialize pass types in database
    await initializePassTypes();

    // 5. Load state from database
    localState = await Storage.loadState(QR_CODES);
    console.log("State loaded from database");

    // 6. Get IP and set broadcast address
    try {
      const ip = await Network.getIpAddressAsync();
      if (ip && ip !== "0.0.0.0") {
        const broadcastAddr = ip.replace(/\d+$/, "255");
        setBroadcastAddr(broadcastAddr);
        console.log(`UDP Broadcast to ${broadcastAddr}`);
      } else {
        console.warn("No valid IP address found (maybe on emulator or no WiFi)");
      }
    } catch (ipError) {
      console.warn("Failed to get IP address, continuing with default:", ipError);
    }

    // 7. Load known devices from database
    const devices = await Storage.getAllDeviceStates();
    devices.forEach(device => knownDevices.set(device.deviceId, device));

    // 8. Request full state from peers (in case this is a new/recovering device)
    await requestFullStateFromPeers().catch(err => {
      console.warn("Failed to request full state from peers (this is okay):", err);
    });

    // 9. Start periodic full-state sync (every 30 seconds - good for 4-5 devices)
    startPeriodicSync();

    // 10. Start broadcast queue processor
    startBroadcastQueueProcessor();

    console.log("P2P service initialized successfully");
  } catch (err) {
    console.error("Error initializing P2P:", err);
    throw err; // Re-throw so the caller knows initialization failed
  }
}

/**
 * Initialize pass types in the database
 */
async function initializePassTypes() {
  for (const qrCode of QR_CODES) {
    const type = qrCode.includes('I') ? 'infinite' : 'one-use';
    await Storage.savePassType(qrCode, type);
  }
}

/**
 * Get the current device ID
 */
export function getDeviceId(): string {
  return deviceId;
}

/**
 * Get the current local state
 */
export function getLocalState(): LocalState {
  return localState;
}

/**
 * Get entry for a specific QR code
 */
export function getEntry(key: string): PassState | undefined {
  return localState[key];
}

/**
 * Add a new scan event to the local state
 * This is called when a QR code is scanned on this device
 */
export async function addScanEvent(qrCode: string, date: string): Promise<ScanEvent> {
  const event: ScanEvent = {
    scanId: uuidv4(),
    qrCode,
    timestamp: Date.now(),
    deviceId,
    date,
  };

  // Add to in-memory state
  if (!localState[qrCode]) {
    const type = qrCode.includes('I') ? 'infinite' : 'one-use';
    localState[qrCode] = {
      type,
      scans: [],
    };
  }

  localState[qrCode].scans.push(event);
  sortScans(localState[qrCode].scans);

  // Save to database
  await Storage.saveScanEvent(event);

  // Broadcast to peers
  await broadcastDelta([event]);

  return event;
}

/**
 * Broadcast delta changes to all peers
 */
async function broadcastDelta(deltas: ScanEvent[]) {
  sequenceNumber++;

  const message: StateMessage = {
    type: 'delta',
    deltas,
    sequenceNum: sequenceNumber,
    deviceId,
    timestamp: Date.now(),
  };

  const messageStr = JSON.stringify(message);

  try {
    await sendDelta(messageStr);
    console.log(`Broadcasted delta with ${deltas.length} scans`);
  } catch (error) {
    console.error('Failed to broadcast delta, adding to queue:', error);
    // Add to queue for retry
    await Storage.enqueueBroadcast(messageStr);
  }
}

/**
 * Listen for incoming messages from peers
 */
serviceEvents.on("message", async (messageStr: string) => {
  try {
    const message: StateMessage = JSON.parse(messageStr);

    // Ignore messages from ourselves
    if (message.deviceId === deviceId) {
      return;
    }

    // Update known devices
    const deviceInfo: DeviceInfo = {
      deviceId: message.deviceId,
      lastSequence: message.sequenceNum,
      lastSeen: Date.now(),
    };
    knownDevices.set(message.deviceId, deviceInfo);
    await Storage.updateDeviceState(deviceInfo);

    // Handle different message types
    switch (message.type) {
      case 'delta':
        if (message.deltas) {
          await mergeDeltaScans(message.deltas);
        }
        break;

      case 'full-state':
        if (message.fullState) {
          await mergeFullState(message.fullState);
        }
        break;

      case 'state-request':
        // Someone is requesting full state, send ours
        await broadcastFullState();
        break;
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
});

/**
 * Merge incoming scan events (CRDT logic)
 */
async function mergeDeltaScans(incomingScans: ScanEvent[]) {
  if (incomingScans.length === 0) return;

  const newScans: ScanEvent[] = [];

  for (const incomingScan of incomingScans) {
    const { qrCode } = incomingScan;

    // Initialize state for this QR if it doesn't exist
    if (!localState[qrCode]) {
      const type = qrCode.includes('I') ? 'infinite' : 'one-use';
      localState[qrCode] = {
        type,
        scans: [],
      };
    }

    // Check if we already have this scan (by scanId)
    const exists = localState[qrCode].scans.some(
      scan => scan.scanId === incomingScan.scanId
    );

    if (!exists) {
      localState[qrCode].scans.push(incomingScan);
      newScans.push(incomingScan);
    }
  }

  // Sort scans by timestamp (deterministic ordering)
  for (const qrCode in localState) {
    sortScans(localState[qrCode].scans);
  }

  // Save new scans to database
  if (newScans.length > 0) {
    await Storage.saveScanEvents(newScans);
    console.log(`Merged ${newScans.length} new scans from peer`);
  }
}

/**
 * Merge full state from a peer (used for late-joining devices)
 */
async function mergeFullState(peerState: LocalState) {
  const allIncomingScans: ScanEvent[] = [];

  for (const qrCode in peerState) {
    const peerPass = peerState[qrCode];
    allIncomingScans.push(...peerPass.scans);
  }

  await mergeDeltaScans(allIncomingScans);
  console.log('Merged full state from peer');
}

/**
 * Sort scans by timestamp, then by deviceId (deterministic)
 */
function sortScans(scans: ScanEvent[]) {
  scans.sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    return a.deviceId.localeCompare(b.deviceId);
  });
}

/**
 * Request full state from all peers
 */
async function requestFullStateFromPeers() {
  sequenceNumber++;

  const message: StateMessage = {
    type: 'state-request',
    sequenceNum: sequenceNumber,
    deviceId,
    timestamp: Date.now(),
  };

  try {
    await sendDelta(JSON.stringify(message));
    console.log('Requested full state from peers');
  } catch (error) {
    console.error('Failed to request full state:', error);
  }
}

/**
 * Broadcast full state to all peers
 */
async function broadcastFullState() {
  sequenceNumber++;

  const message: StateMessage = {
    type: 'full-state',
    fullState: localState,
    sequenceNum: sequenceNumber,
    deviceId,
    timestamp: Date.now(),
  };

  try {
    await sendDelta(JSON.stringify(message));
    console.log('Broadcasted full state to peers');
  } catch (error) {
    console.error('Failed to broadcast full state:', error);
  }
}

/**
 * Start periodic full-state sync (every 30 seconds)
 * Optimized for 4-5 devices - frequency is appropriate
 */
function startPeriodicSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
  }

  syncInterval = setInterval(async () => {
    console.log('Running periodic full-state sync...');
    await broadcastFullState();
  }, 30000); // 30 seconds
}

/**
 * Stop periodic sync
 */
export function stopPeriodicSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

/**
 * Process broadcast queue (retry failed broadcasts)
 */
async function processBroadcastQueue() {
  const pending = await Storage.getPendingBroadcasts(5);

  for (const item of pending) {
    try {
      await sendDelta(item.message);
      await Storage.removeBroadcast(item.id);
      console.log(`Successfully retried broadcast ${item.id}`);
    } catch (error) {
      await Storage.updateBroadcastAttempt(item.id);
      console.log(`Retry ${item.attempts + 1} failed for broadcast ${item.id}`);
    }
  }
}

/**
 * Start broadcast queue processor (every 3 seconds)
 */
function startBroadcastQueueProcessor() {
  setInterval(async () => {
    await processBroadcastQueue();
  }, 3000); // 3 seconds
}

/**
 * Get connected devices count
 * Increased timeout to 90 seconds for 4-5 device scenarios
 */
export function getConnectedDevicesCount(): number {
  const now = Date.now();
  const timeout = 90000; // 90 seconds (increased from 60 for more devices)

  let count = 0;
  for (const device of knownDevices.values()) {
    if (now - device.lastSeen < timeout) {
      count++;
    }
  }

  return count;
}

/**
 * Get time since last sync
 */
export function getTimeSinceLastSync(): number {
  const now = Date.now();
  let mostRecentSync = 0;

  for (const device of knownDevices.values()) {
    if (device.lastSeen > mostRecentSync) {
      mostRecentSync = device.lastSeen;
    }
  }

  return mostRecentSync > 0 ? Math.floor((now - mostRecentSync) / 1000) : 0;
}

/**
 * Get pending broadcasts count
 */
export async function getPendingBroadcastsCount(): Promise<number> {
  return await Storage.getPendingBroadcastCount();
}

/**
 * Shutdown P2P service
 */
export function shutdownP2P() {
  stopPeriodicSync();
  console.log('P2P service shutdown');
}
