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

// Pending messages awaiting ACK (messageId -> PendingMessage)
const pendingAcks: Map<string, { message: string; peerIp: string; timestamp: number; attempts: number; peerId: string }> = new Map();

// Received message IDs for deduplication (keep last 1000)
const receivedMessageIds: Set<string> = new Set();
const MAX_RECEIVED_IDS = 1000;

// Periodic sync interval
let syncInterval: ReturnType<typeof setInterval> | null = null;

// Heartbeat interval
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// ACK retry interval
let ackRetryInterval: ReturnType<typeof setInterval> | null = null;

// State hash reconciliation interval
let reconciliationInterval: ReturnType<typeof setInterval> | null = null;

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
 * Calculate hash of current state for reconciliation
 * Uses a simple hash of all scanIds sorted
 */
function calculateStateHash(): string {
  const allScanIds: string[] = [];

  for (const qrCode in localState) {
    for (const scan of localState[qrCode].scans) {
      allScanIds.push(scan.scanId);
    }
  }

  // Sort for deterministic hash
  allScanIds.sort();

  // Simple hash: concatenate and use length + first/last IDs
  if (allScanIds.length === 0) return "empty";

  const hash = `${allScanIds.length}-${allScanIds[0].substring(0, 8)}-${allScanIds[allScanIds.length - 1].substring(0, 8)}`;
  return hash;
}

/**
 * Add message ID to received set for deduplication
 */
function markMessageAsReceived(messageId: string) {
  receivedMessageIds.add(messageId);

  // Keep set size manageable
  if (receivedMessageIds.size > MAX_RECEIVED_IDS) {
    const idsArray = Array.from(receivedMessageIds);
    const toRemove = idsArray.slice(0, 100); // Remove oldest 100
    toRemove.forEach(id => receivedMessageIds.delete(id));
  }
}

/**
 * Check if message was already received
 */
function isMessageReceived(messageId: string): boolean {
  return receivedMessageIds.has(messageId);
}

/**
 * Send ACK for a received message
 */
async function sendAck(messageId: string, peerIp: string, peerDeviceId: string) {
  sequenceNumber++;

  const ackMessage: StateMessage = {
    type: 'ack',
    ackMessageId: messageId,
    sequenceNum: sequenceNumber,
    deviceId,
    timestamp: Date.now(),
  };

  const messageStr = JSON.stringify(ackMessage);

  try {
    await sendDeltaToPeer(messageStr, peerIp);
    console.log(`✅ [ACK] Sent ACK for message ${messageId.substring(0, 8)}... to peer ${peerDeviceId.substring(0, 8)}...`);
  } catch (error) {
    console.error(`❌ [ACK] Failed to send ACK to ${peerIp}:`, error);
  }
}

/**
 * Initialize P2P service with CRDT-based sync
 * Optimized for 4-5 devices with reliability features
 */
export async function initializeP2P() {
  try {
    console.log("🚀 [INIT] ========================================");
    console.log("🚀 [INIT] Initializing P2P service...");
    console.log("🚀 [INIT] ========================================");

    // 1. Initialize SQLite database
    await Storage.initDatabase();
    console.log("✅ [INIT] SQLite database initialized");

    // 2. Get or create persistent device ID
    deviceId = await Storage.getOrCreateDeviceId(uuidv4);
    console.log(`✅ [INIT] Device ID: ${deviceId}`);
    console.log(`   [INIT] Short ID: ${deviceId.substring(0, 8)}...`);
    console.log(`   [INIT] Device identity will persist across app restarts`);

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
        // Calculate broadcast address based on IP (assuming /24 subnet)
        const ipParts = ip.split('.');
        if (ipParts.length === 4) {
          // For /24 network (255.255.255.0), broadcast is x.x.x.255
          const broadcastAddr = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.255`;
          setBroadcastAddr(broadcastAddr);
          console.log(`✅ [INIT] Calculated broadcast address: ${broadcastAddr} (from IP: ${ip})`);
        } else {
          console.warn(`⚠️  [INIT] Invalid IP format: ${ip}, using fallback`);
          setBroadcastAddr("255.255.255.255");
          console.log("Using global broadcast: 255.255.255.255");
        }
      } else {
        console.warn("⚠️  [INIT] No valid IP detected, using global broadcast");
        setBroadcastAddr("255.255.255.255");
        console.log("Using global broadcast: 255.255.255.255");
      }

      console.log("📡 [INIT] Network Discovery:");
      console.log("   - Initial discovery uses broadcast");
      console.log("   - Subsequent messages use unicast to known peers");
      console.log("   - Heartbeat every 10s keeps connections alive");
    } catch (ipError) {
      console.warn("Failed to get IP address, using fallback:", ipError);
      setBroadcastAddr("255.255.255.255");
      console.log("Using global broadcast: 255.255.255.255");
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

    // 11. Start heartbeat mechanism (every 10 seconds)
    startHeartbeat();

    // 12. Start ACK retry processor (every 2 seconds)
    startAckRetryProcessor();

    // 13. Start state reconciliation (every 20 seconds)
    startStateReconciliation();

    console.log("🎉 [INIT] P2P service initialized successfully with reliability features");
    console.log("   [INIT] - Heartbeat: Every 10s");
    console.log("   [INIT] - Full sync: Every 30s");
    console.log("   [INIT] - ACK retry: Every 2s");
    console.log("   [INIT] - State reconciliation: Every 20s");
    console.log("   [INIT] - Peer timeout: 30s");
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
 * Broadcast delta changes to all peers (using unicast with ACK tracking)
 */
async function broadcastDelta(deltas: ScanEvent[]) {
  sequenceNumber++;
  const messageId = uuidv4(); // Unique ID for ACK tracking

  const message: StateMessage = {
    type: 'delta',
    messageId,
    deltas,
    sequenceNum: sequenceNumber,
    deviceId,
    timestamp: Date.now(),
  };

  console.log('📤 [SENDING DELTA] Preparing to send delta:', {
    type: message.type,
    messageId: messageId.substring(0, 8) + '...',
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

  // Send to each known peer individually (unicast) and track for ACK
  await sendToAllPeersWithAck(messageStr, messageId);
  console.log(`✅ [SENDING DELTA] Sent delta with ${deltas.length} scans to ${knownDevices.size} peers`);
}

/**
 * Send to all peers with ACK tracking
 */
async function sendToAllPeersWithAck(messageStr: string, messageId: string) {
  const peers = Array.from(knownDevices.values()).filter(p => p.ipAddress);

  if (peers.length === 0) {
    // No known peers yet, use broadcast for discovery (no ACK tracking for broadcast)
    console.log('🔍 [SEND WITH ACK] No known peers, using broadcast for discovery');
    try {
      await sendDelta(messageStr);
      console.log('✅ [SEND WITH ACK] Broadcast sent successfully');
    } catch (error) {
      console.error('❌ [SEND WITH ACK] Failed to send broadcast:', error);
      await Storage.enqueueBroadcast(messageStr);
    }
    return;
  }

  // Send to each peer and track for ACK
  for (const peer of peers) {
    try {
      await sendDeltaToPeer(messageStr, peer.ipAddress!);

      // Track this message for ACK
      const ackKey = `${messageId}-${peer.deviceId}`;
      pendingAcks.set(ackKey, {
        message: messageStr,
        peerIp: peer.ipAddress!,
        timestamp: Date.now(),
        attempts: 1,
        peerId: peer.deviceId,
      });

      console.log(`✅ [SEND WITH ACK] Sent to ${peer.ipAddress}, tracking ACK: ${ackKey.substring(0, 16)}...`);
    } catch (error) {
      console.error(`❌ [SEND WITH ACK] Failed to send to ${peer.ipAddress}:`, error);
    }
  }
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

    // Check for duplicate messages
    if (message.messageId && isMessageReceived(message.messageId)) {
      console.log(`⏭️  [RECEIVED] Duplicate message ${message.messageId.substring(0, 8)}..., ignoring`);
      return;
    }

    // Mark message as received
    if (message.messageId) {
      markMessageAsReceived(message.messageId);
    }

    // Update known devices with IP address for unicast
    const existingDevice = knownDevices.get(message.deviceId);
    const deviceInfo: DeviceInfo = {
      deviceId: message.deviceId,
      lastSequence: message.sequenceNum,
      lastSeen: Date.now(),
      lastHeartbeat: message.type === 'heartbeat' ? Date.now() : existingDevice?.lastHeartbeat,
      ipAddress: rinfo?.address,
      stateHash: message.stateHash || existingDevice?.stateHash,
      connectionState: 'connected',
    };

    // Check if this is a new peer
    const isNewPeer = !knownDevices.has(message.deviceId);

    knownDevices.set(message.deviceId, deviceInfo);
    await Storage.updateDeviceState(deviceInfo);

    if (isNewPeer) {
      console.log(`🆕 NEW PEER DISCOVERED: ${message.deviceId.substring(0, 8)}... at IP: ${rinfo?.address}`);
      printPeerIPs();

      // Request full state from new peer
      await requestFullStateFromPeers();
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

        // Send ACK back to sender
        if (message.messageId && rinfo?.address) {
          await sendAck(message.messageId, rinfo.address, message.deviceId);
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
        await broadcastFullState();
        break;

      case 'ack':
        if (message.ackMessageId) {
          console.log(`✅ [RECEIVED ACK] Got ACK for message ${message.ackMessageId.substring(0, 8)}... from ${message.deviceId.substring(0, 8)}...`);

          // Remove from pending ACKs
          const ackKey = `${message.ackMessageId}-${message.deviceId}`;
          if (pendingAcks.has(ackKey)) {
            pendingAcks.delete(ackKey);
            console.log(`✅ [ACK] Removed from pending: ${ackKey.substring(0, 16)}... (${pendingAcks.size} pending)`);
          }
        }
        break;

      case 'heartbeat':
        console.log(`💓 [HEARTBEAT] Received from ${message.deviceId.substring(0, 8)}... at ${rinfo?.address}`);
        // Device info already updated above
        break;

      case 'state-hash':
        if (message.stateHash) {
          const ourHash = calculateStateHash();
          console.log(`🔍 [STATE HASH] Peer: ${message.stateHash}, Ours: ${ourHash}`);

          if (message.stateHash !== ourHash) {
            console.log(`⚠️  [STATE HASH] State mismatch detected! Requesting full state...`);
            await requestFullStateFromPeers();
          } else {
            console.log(`✅ [STATE HASH] States match!`);

            // Update connection state to synced
            const device = knownDevices.get(message.deviceId);
            if (device) {
              device.connectionState = 'synced';
              knownDevices.set(message.deviceId, device);
            }
          }
        }
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
 * Start heartbeat mechanism (every 10 seconds)
 * Sends lightweight heartbeat messages to maintain peer connections
 */
function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  heartbeatInterval = setInterval(async () => {
    sequenceNumber++;

    const heartbeatMessage: StateMessage = {
      type: 'heartbeat',
      sequenceNum: sequenceNumber,
      deviceId,
      timestamp: Date.now(),
      stateHash: calculateStateHash(), // Include state hash for quick verification
    };

    const messageStr = JSON.stringify(heartbeatMessage);

    // Send heartbeat to all known peers
    const peers = Array.from(knownDevices.values()).filter(p => p.ipAddress);

    if (peers.length > 0) {
      console.log(`💓 [HEARTBEAT] Sending to ${peers.length} peers...`);

      for (const peer of peers) {
        try {
          await sendDeltaToPeer(messageStr, peer.ipAddress!);
        } catch (error) {
          console.error(`❌ [HEARTBEAT] Failed to send to ${peer.ipAddress}:`, error);
        }
      }
    }
  }, 10000); // 10 seconds
}

/**
 * Start ACK retry processor (every 2 seconds)
 * Retries messages that haven't been acknowledged
 */
function startAckRetryProcessor() {
  if (ackRetryInterval) {
    clearInterval(ackRetryInterval);
  }

  ackRetryInterval = setInterval(async () => {
    const now = Date.now();
    const ACK_TIMEOUT = 5000; // 5 seconds
    const MAX_ATTEMPTS = 5;

    const toRetry: Array<[string, any]> = [];

    // Find messages that need retry
    for (const [ackKey, pending] of pendingAcks.entries()) {
      const timeSinceSent = now - pending.timestamp;

      if (timeSinceSent > ACK_TIMEOUT) {
        if (pending.attempts >= MAX_ATTEMPTS) {
          // Give up after max attempts
          console.log(`❌ [ACK RETRY] Giving up on ${ackKey.substring(0, 16)}... after ${MAX_ATTEMPTS} attempts`);
          pendingAcks.delete(ackKey);
        } else {
          toRetry.push([ackKey, pending]);
        }
      }
    }

    // Retry messages
    for (const [ackKey, pending] of toRetry) {
      try {
        console.log(`🔄 [ACK RETRY] Retrying ${ackKey.substring(0, 16)}... (attempt ${pending.attempts + 1}/${MAX_ATTEMPTS})`);
        await sendDeltaToPeer(pending.message, pending.peerIp);

        // Update attempts and timestamp
        pending.attempts++;
        pending.timestamp = now;
        pendingAcks.set(ackKey, pending);
      } catch (error) {
        console.error(`❌ [ACK RETRY] Retry failed for ${ackKey.substring(0, 16)}...:`, error);
      }
    }

    if (toRetry.length > 0) {
      console.log(`📊 [ACK RETRY] Retried ${toRetry.length} messages, ${pendingAcks.size} still pending`);
    }
  }, 2000); // 2 seconds
}

/**
 * Start state reconciliation (every 20 seconds)
 * Sends state hash to peers for verification
 */
function startStateReconciliation() {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
  }

  reconciliationInterval = setInterval(async () => {
    sequenceNumber++;

    const stateHash = calculateStateHash();
    const hashMessage: StateMessage = {
      type: 'state-hash',
      stateHash,
      sequenceNum: sequenceNumber,
      deviceId,
      timestamp: Date.now(),
    };

    const messageStr = JSON.stringify(hashMessage);

    // Send to all known peers
    const peers = Array.from(knownDevices.values()).filter(p => p.ipAddress);

    if (peers.length > 0) {
      console.log(`🔍 [RECONCILIATION] Sending state hash (${stateHash}) to ${peers.length} peers...`);

      for (const peer of peers) {
        try {
          await sendDeltaToPeer(messageStr, peer.ipAddress!);
        } catch (error) {
          console.error(`❌ [RECONCILIATION] Failed to send to ${peer.ipAddress}:`, error);
        }
      }
    }
  }, 20000); // 20 seconds
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
    console.log('🔄 [PERIODIC SYNC] Running periodic full-state sync...');
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
 * Reduced timeout to 30 seconds for faster failure detection with heartbeat support
 */
export function getConnectedDevicesCount(): number {
  const now = Date.now();
  const timeout = 30000; // 30 seconds (reduced from 90 - heartbeats keep connections alive)

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
  const timeout = 30000; // 30 seconds

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
 * Get pending ACKs count (messages waiting for acknowledgment)
 */
export function getPendingAcksCount(): number {
  return pendingAcks.size;
}

/**
 * Shutdown P2P service
 */
export function shutdownP2P() {
  stopPeriodicSync();

  // Stop all intervals
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  if (ackRetryInterval) {
    clearInterval(ackRetryInterval);
    ackRetryInterval = null;
  }

  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
  }

  console.log('🛑 [SHUTDOWN] P2P service shutdown - all intervals stopped');
}
