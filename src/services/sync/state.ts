// services/sync/state.ts
import * as Network from "expo-network";
import * as Crypto from 'expo-crypto';
import { serviceEvents } from "./events";
import { initSocket, setBroadcastAddr, sendDelta, sendDeltaToPeer } from "./network";
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
    console.log("🚀 [INIT] ========================================");
    console.log("🚀 [INIT] Initializing P2P service...");
    console.log("🚀 [INIT] ========================================");

    // 1. Initialize SQLite database
    await Storage.initDatabase();
    console.log("✅ [INIT] SQLite database initialized");

    // 2. Generate or load device ID
    deviceId = uuidv4();
    console.log(`✅ [INIT] Device ID: ${deviceId}`);
    console.log(`   [INIT] Short ID: ${deviceId.substring(0, 8)}...`);

    // 3. Initialize UDP socket
    await initSocket();
    console.log("✅ [INIT] UDP socket initialized");

    // 4. Initialize pass types in database
    await initializePassTypes();
    console.log("✅ [INIT] Pass types initialized");

    // 5. Load state from database
    localState = await Storage.loadState(QR_CODES);
    const totalScans = Object.values(localState).reduce((sum, pass) => sum + pass.scans.length, 0);
    console.log(`✅ [INIT] State loaded from database: ${Object.keys(localState).length} QR codes, ${totalScans} total scans`);

    // 6. Get IP and set broadcast address
    try {
      const ip = await Network.getIpAddressAsync();
      console.log(`🌐 [INIT] Device IP from expo-network: ${ip}`);
      
      if (ip && ip !== "0.0.0.0") {
        console.log("Trying common hotspot broadcast addresses:");
        console.log("  - 192.168.43.255 (Android hotspot)");
        console.log("  - 192.168.137.255 (Windows hotspot)");
        console.log("  - 172.20.10.255 (iPhone hotspot)");
        
        // Default to Android hotspot (most common)
        setBroadcastAddr("192.168.43.255");
        console.log("Using broadcast: 192.168.43.255");
        console.log("Note: Unicast will work once peers are discovered");
      }
    } catch (ipError) {
      console.warn("Failed to get IP address, using fallback:", ipError);
      setBroadcastAddr("192.168.43.255");
      console.log("Using fallback broadcast: 192.168.43.255");
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

  console.log('📱 [LOCAL SCAN] Creating new scan event:', {
    scanId: event.scanId.substring(0, 8) + '...',
    qrCode: event.qrCode,
    date: event.date,
    deviceId: deviceId.substring(0, 8) + '...',
  });

  // Add to in-memory state
  if (!localState[qrCode]) {
    const type = qrCode.includes('I') ? 'infinite' : 'one-use';
    localState[qrCode] = {
      type,
      scans: [],
    };
    console.log(`📝 [LOCAL SCAN] Initialized new QR code entry: ${qrCode} (${type})`);
  }

  localState[qrCode].scans.push(event);
  sortScans(localState[qrCode].scans);

  console.log(`💾 [LOCAL SCAN] Saved to in-memory state. Total scans for ${qrCode}: ${localState[qrCode].scans.length}`);

  // Save to database
  await Storage.saveScanEvent(event);
  console.log('✅ [LOCAL SCAN] Saved to SQLite database');

  // Broadcast to peers
  await broadcastDelta([event]);

  return event;
}

/**
 * Broadcast delta changes to all peers (using unicast)
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

  console.log('📤 [SENDING DELTA] Preparing to send delta:', {
    type: message.type,
    deltasCount: deltas.length,
    sequenceNum: sequenceNumber,
    deviceId: deviceId.substring(0, 8) + '...',
    knownPeers: knownDevices.size,
  });

  deltas.forEach((delta, index) => {
    console.log(`  📋 [DELTA ${index + 1}] QR: ${delta.qrCode}, ScanId: ${delta.scanId.substring(0, 8)}..., Date: ${delta.date}`);
  });

  const messageStr = JSON.stringify(message);
  console.log(`📦 [SENDING DELTA] Message size: ${messageStr.length} bytes`);

  // Send to each known peer individually (unicast)
  await sendToAllPeers(messageStr);
  console.log(`✅ [SENDING DELTA] Sent delta with ${deltas.length} scans to ${knownDevices.size} peers`);
}

/**
 * Listen for incoming messages from peers
 */
serviceEvents.on("message", async (messageStr: string, rinfo: any) => {
  try {
    console.log(`📥 [RECEIVED] Message from ${rinfo?.address}:${rinfo?.port}, size: ${messageStr.length} bytes`);
    
    const message: StateMessage = JSON.parse(messageStr);

    console.log(`📨 [RECEIVED] Message type: ${message.type}, from device: ${message.deviceId.substring(0, 8)}..., seq: ${message.sequenceNum}`);

    // Ignore messages from ourselves
    if (message.deviceId === deviceId) {
      console.log('⏭️  [RECEIVED] Ignoring message from self');
      return;
    }

    // Update known devices with IP address for unicast
    const deviceInfo: DeviceInfo = {
      deviceId: message.deviceId,
      lastSequence: message.sequenceNum,
      lastSeen: Date.now(),
      ipAddress: rinfo?.address, // Capture sender's IP
    };
    
    // Check if this is a new peer
    const isNewPeer = !knownDevices.has(message.deviceId);
    
    knownDevices.set(message.deviceId, deviceInfo);
    await Storage.updateDeviceState(deviceInfo);
    
    if (isNewPeer) {
      console.log(`🆕 NEW PEER DISCOVERED: ${message.deviceId.substring(0, 8)}... at IP: ${rinfo?.address}`);
      printPeerIPs();
    } else {
      console.log(`👋 [RECEIVED] Known peer ${message.deviceId.substring(0, 8)}... at ${rinfo?.address}`);
    }

    // Handle different message types
    switch (message.type) {
      case 'delta':
        console.log(`🔄 [RECEIVED DELTA] Processing ${message.deltas?.length || 0} scan events`);
        if (message.deltas) {
          message.deltas.forEach((delta, index) => {
            console.log(`  📋 [DELTA ${index + 1}] QR: ${delta.qrCode}, ScanId: ${delta.scanId.substring(0, 8)}..., Date: ${delta.date}, From: ${delta.deviceId.substring(0, 8)}...`);
          });
          await mergeDeltaScans(message.deltas);
        }
        break;

      case 'full-state':
        console.log(`🔄 [RECEIVED FULL-STATE] Processing full state from peer`);
        if (message.fullState) {
          const totalScans = Object.values(message.fullState).reduce((sum, pass) => sum + pass.scans.length, 0);
          console.log(`  📊 [FULL-STATE] Contains ${Object.keys(message.fullState).length} QR codes with ${totalScans} total scans`);
          await mergeFullState(message.fullState);
        }
        break;

      case 'state-request':
        console.log(`📢 [RECEIVED STATE-REQUEST] Peer requesting full state, sending ours...`);
        // Someone is requesting full state, send ours
        await broadcastFullState();
        break;
    }
  } catch (error) {
    console.error('❌ [RECEIVED] Error processing message:', error);
  }
});

/**
 * Merge incoming scan events (CRDT logic)
 */
async function mergeDeltaScans(incomingScans: ScanEvent[]) {
  if (incomingScans.length === 0) {
    console.log('⚠️  [MERGE] No scans to merge');
    return;
  }

  console.log(`🔀 [MERGE] Starting merge of ${incomingScans.length} incoming scans`);
  const newScans: ScanEvent[] = [];
  const duplicateScans: ScanEvent[] = [];

  for (const incomingScan of incomingScans) {
    const { qrCode } = incomingScan;

    // Initialize state for this QR if it doesn't exist
    if (!localState[qrCode]) {
      const type = qrCode.includes('I') ? 'infinite' : 'one-use';
      localState[qrCode] = {
        type,
        scans: [],
      };
      console.log(`  📝 [MERGE] Initialized new QR code entry: ${qrCode} (${type})`);
    }

    // Check if we already have this scan (by scanId)
    const exists = localState[qrCode].scans.some(
      scan => scan.scanId === incomingScan.scanId
    );

    if (!exists) {
      localState[qrCode].scans.push(incomingScan);
      newScans.push(incomingScan);
      console.log(`  ✅ [MERGE] NEW scan added: ${qrCode}, ScanId: ${incomingScan.scanId.substring(0, 8)}...`);
    } else {
      duplicateScans.push(incomingScan);
      console.log(`  ⏭️  [MERGE] DUPLICATE scan skipped: ${qrCode}, ScanId: ${incomingScan.scanId.substring(0, 8)}...`);
    }
  }

  // Sort scans by timestamp (deterministic ordering)
  for (const qrCode in localState) {
    sortScans(localState[qrCode].scans);
  }

  // Save new scans to database
  if (newScans.length > 0) {
    await Storage.saveScanEvents(newScans);
    console.log(`💾 [MERGE] Saved ${newScans.length} new scans to SQLite database`);
    
    // Log summary
    const qrCodeCounts: { [key: string]: number } = {};
    newScans.forEach(scan => {
      qrCodeCounts[scan.qrCode] = (qrCodeCounts[scan.qrCode] || 0) + 1;
    });
    console.log(`📊 [MERGE] Summary by QR code:`, qrCodeCounts);
  } else {
    console.log(`ℹ️  [MERGE] No new scans to save (${duplicateScans.length} duplicates ignored)`);
  }

  // Log current state
  const totalScans = Object.values(localState).reduce((sum, pass) => sum + pass.scans.length, 0);
  console.log(`📈 [MERGE] Current total scans in memory: ${totalScans} across ${Object.keys(localState).length} QR codes`);
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
 * Send message to all known peers using unicast
 */
async function sendToAllPeers(messageStr: string) {
  const peers = Array.from(knownDevices.values());
  
  console.log(`📡 [SEND TO PEERS] Attempting to send to ${peers.length} known peers`);
  
  if (peers.length === 0) {
    // No known peers yet, use broadcast for discovery
    console.log('🔍 [SEND TO PEERS] No known peers, using broadcast for discovery');
    try {
      await sendDelta(messageStr);
      console.log('✅ [SEND TO PEERS] Broadcast sent successfully');
    } catch (error) {
      console.error('❌ [SEND TO PEERS] Failed to send broadcast:', error);
      await Storage.enqueueBroadcast(messageStr);
      console.log('📥 [SEND TO PEERS] Message queued for retry');
    }
    return;
  }

  // Send to each peer individually
  let successCount = 0;
  let failCount = 0;
  
  for (const peer of peers) {
    if (peer.ipAddress) {
      try {
        console.log(`  📤 [UNICAST] Sending to peer ${peer.deviceId.substring(0, 8)}... at ${peer.ipAddress}`);
        await sendDeltaToPeer(messageStr, peer.ipAddress);
        successCount++;
        console.log(`  ✅ [UNICAST] Successfully sent to ${peer.ipAddress}`);
      } catch (error) {
        failCount++;
        console.error(`  ❌ [UNICAST] Failed to send to peer ${peer.deviceId.substring(0, 8)}... at ${peer.ipAddress}:`, error);
        await Storage.enqueueBroadcast(messageStr);
        console.log(`  📥 [UNICAST] Message queued for retry`);
      }
    } else {
      console.log(`  ⚠️  [UNICAST] Peer ${peer.deviceId.substring(0, 8)}... has no IP address`);
    }
  }
  
  console.log(`📊 [SEND TO PEERS] Results: ${successCount} successful, ${failCount} failed out of ${peers.length} peers`);
}

/**
 * Request full state from all peers
 */
export async function requestFullStateFromPeers() {
  sequenceNumber++;

  const message: StateMessage = {
    type: 'state-request',
    sequenceNum: sequenceNumber,
    deviceId,
    timestamp: Date.now(),
  };

  const messageStr = JSON.stringify(message);
  
  // Use broadcast for initial discovery
  try {
    await sendDelta(messageStr);
    console.log('Requested full state from peers (broadcast)');
  } catch (error) {
    console.error('Failed to request full state:', error);
  }
}

/**
 * Broadcast full state to all peers (using unicast)
 */
async function broadcastFullState() {
  sequenceNumber++;

  const totalScans = Object.values(localState).reduce((sum, pass) => sum + pass.scans.length, 0);
  const qrCodeCount = Object.keys(localState).length;

  console.log(`📤 [SENDING FULL-STATE] Preparing full state broadcast`);
  console.log(`  📊 [FULL-STATE] Contains ${qrCodeCount} QR codes with ${totalScans} total scans`);

  const message: StateMessage = {
    type: 'full-state',
    fullState: localState,
    sequenceNum: sequenceNumber,
    deviceId,
    timestamp: Date.now(),
  };

  const messageStr = JSON.stringify(message);
  console.log(`📦 [SENDING FULL-STATE] Message size: ${messageStr.length} bytes`);
  
  // Send to all known peers
  await sendToAllPeers(messageStr);
  console.log('✅ [SENDING FULL-STATE] Full state sent to peers');
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
  let totalDevices = 0;
  
  for (const device of knownDevices.values()) {
    totalDevices++;
    const timeSinceLastSeen = now - device.lastSeen;
    const isActive = timeSinceLastSeen < timeout;
    
    if (isActive) {
      count++;
    }
    
    // Debug log for each device
    console.log(`👥 [PEER CHECK] Device ${device.deviceId.substring(0, 8)}... | IP: ${device.ipAddress} | Last seen: ${Math.floor(timeSinceLastSeen / 1000)}s ago | Active: ${isActive}`);
  }

  console.log(`👥 [PEER COUNT] Total known devices: ${totalDevices}, Active devices: ${count}`);
  return count;
}

/**
 * Get all connected peer IPs
 * Returns array of peer info with deviceId and IP address
 */
export function getConnectedPeers(): Array<{ deviceId: string; ipAddress: string; lastSeen: number }> {
  const now = Date.now();
  const timeout = 90000; // 90 seconds

  const peers: Array<{ deviceId: string; ipAddress: string; lastSeen: number }> = [];
  
  for (const device of knownDevices.values()) {
    if (now - device.lastSeen < timeout && device.ipAddress) {
      peers.push({
        deviceId: device.deviceId,
        ipAddress: device.ipAddress,
        lastSeen: device.lastSeen,
      });
    }
  }

  return peers;
}

/**
 * Print all connected peer IPs to console
 */
export function printPeerIPs(): void {
  const peers = getConnectedPeers();
  
  if (peers.length === 0) {
    console.log('No connected peers found');
    return;
  }

  console.log(`\n=== Connected Peers (${peers.length}) ===`);
  peers.forEach((peer, index) => {
    const secondsAgo = Math.floor((Date.now() - peer.lastSeen) / 1000);
    console.log(`${index + 1}. Device: ${peer.deviceId.substring(0, 8)}... | IP: ${peer.ipAddress} | Last seen: ${secondsAgo}s ago`);
  });
  console.log('========================\n');
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
