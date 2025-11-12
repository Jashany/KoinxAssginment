# Multi-Device Offline QR Scanner

A React Native app built with Expo that enables offline, multi-device QR code scanning with real-time peer-to-peer synchronization. Optimized for 4-5 scanning devices working together without internet.

## Features

- **Offline-First**: No internet required - works on local WiFi
- **Multi-Device Sync**: Real-time UDP broadcasting syncs scans across 4-5 devices
- **CRDT-Based**: Conflict-free replicated data types ensure consistency
- **Pass Types**: Supports infinite passes and one-use passes
- **Statistics Dashboard**: View scan counts and usage metrics
- **Visual Feedback**: Animated success/error messages during scanning
- **Retry Queue**: Failed broadcasts are automatically retried

## Architecture

### Core Technology Stack

- **React Native + Expo**: Cross-platform mobile (iOS/Android)
- **React Navigation**: Traditional stack-based navigation
- **SQLite (expo-sqlite)**: Local persistence with atomic transactions
- **UDP Broadcasting (react-native-udp)**: Peer-to-peer communication on port 43210
- **CRDT State Management**: Append-only event log for conflict resolution
- **NativeWind**: Tailwind CSS styling for React Native

### File Structure

```
my-expo-app/
├── src/
│   ├── services/
│   │   └── sync/              # Offline sync service
│   │       ├── types.ts       # TypeScript interfaces
│   │       ├── storage.ts     # SQLite database layer
│   │       ├── state.ts       # CRDT state management
│   │       ├── network.ts     # UDP broadcasting
│   │       ├── events.ts      # Event emitter
│   │       ├── utils.ts       # Date utilities
│   │       └── index.ts       # Public API
│   ├── screens/
│   │   ├── HomeScreen.tsx     # Main screen
│   │   ├── QRScanScreen.tsx   # Camera scanner
│   │   └── StatsScreen.tsx    # Statistics view
│   ├── components/
│   │   └── SyncStatus.tsx     # Real-time sync status
│   └── navigation/
│       └── AppNavigator.tsx   # React Navigation setup
└── App.tsx                    # Entry point
```

## Installation

### Prerequisites

- Node.js 18+
- iOS Simulator (Mac) or Android Emulator
- Expo CLI: `npm install -g expo-cli`

### Setup

```bash
# Navigate to project
cd my-expo-app

# Install dependencies (already done)
npm install

# Start development server
npx expo start

# Run on iOS
npx expo start --ios

# Run on Android
npx expo start --android
```

## Usage

### Single Device Testing

1. Launch the app
2. Tap "Enable Camera" to grant permissions
3. Tap "Scan QR Code" to open scanner
4. Scan a QR code from the hardcoded list
5. View statistics with "View Statistics"

### Multi-Device Setup (4-5 Devices)

#### Option 1: Venue WiFi (Recommended)

1. **Connect all devices to the same WiFi network**:
   - Settings → WiFi → Select same network
   - Verify same subnet (e.g., 192.168.1.x)

2. **Launch app on all devices**:
   - App auto-detects network and sets broadcast address
   - Check sync status shows "Connected Devices: X"

3. **Test sync**:
   - Scan QR on Device A
   - Should appear on Devices B, C, D, E within 1-2 seconds

#### Option 2: Mobile Hotspot (Fallback)

If venue WiFi blocks UDP broadcasts:

1. **Device A (Coordinator)**:
   - Settings → Personal Hotspot / Mobile Hotspot
   - Enable hotspot
   - Set name: "Scanner-Network"
   - Set password: "scanner123"

2. **Devices B, C, D, E**:
   - Settings → WiFi → Connect to "Scanner-Network"
   - Enter password

3. **Launch app on all devices** and test

### QR Codes (Hardcoded)

The app recognizes 20 QR codes:

**Infinite Passes (10):**
- SAT25IBLXRRU, SAT25IPGOP23, SAT25I32LFFI, SAT25IB2JHC0, SAT25IIPXM4M
- SAT25I5N8EKB, SAT25ITPC3AZ, SAT25IW6YXON, SAT25ITUBCAP, SAT25I8JOGTS

**One-Use Passes (10):**
- SAT25SD724M2, SAT25S9NHZT5, SAT25SLTAAGR, SAT25SCA78P3, SAT25SI3IVAX
- SAT25SWRG0M5, SAT25S36GKMG, SAT25SJ5CNQK, SAT25S5SCQG0, SAT25SEK2YC1

### Validation Rules

- **One-use passes**: Max 1 scan per day (rejects duplicates)
- **Infinite passes**: Unlimited scans, but 5-minute cooldown between scans
- **Unknown QR codes**: Rejected immediately

## How It Works

### CRDT Synchronization

1. **Scan Event**: Device A scans QR → creates `ScanEvent` with UUID
2. **Local Save**: Persisted to SQLite immediately
3. **Broadcast**: Sent via UDP to 192.168.x.255:43210
4. **Peer Reception**: Devices B, C, D, E receive message
5. **CRDT Merge**: Deduplicate by scanId, sort by timestamp
6. **Save**: Merged scans saved to SQLite on all devices

### Network Architecture

```
Device A (192.168.1.100) ─┐
Device B (192.168.1.101) ─┤
Device C (192.168.1.102) ─┼─ UDP Broadcast (Port 43210)
Device D (192.168.1.103) ─┤
Device E (192.168.1.104) ─┘
```

All devices broadcast to `192.168.1.255` (subnet broadcast address)

### Optimizations for 4-5 Devices

- **Peer timeout**: Increased to 90 seconds (vs 60s for 2-3 devices)
- **Periodic sync**: Every 30 seconds (full state broadcast)
- **Retry queue**: Max 5 attempts with 3-second intervals
- **Batch operations**: SQLite transactions for efficiency

## Troubleshooting

### "Connected Devices: 0"

**Causes:**
- Devices on different WiFi networks
- Venue WiFi blocking UDP broadcasts
- Firewall blocking port 43210

**Solutions:**
1. Verify all devices on same network (check IP addresses)
2. Switch to mobile hotspot mode
3. Restart app on all devices

### Scans Not Syncing

**Check:**
1. Sync status shows green "Synced" indicator
2. "Pending Queue" is 0 (no failed broadcasts)
3. All devices see "Connected Devices > 0"

**Debug:**
- Check console logs: `npx expo start` → see broadcast messages
- Test with 2 devices first before adding more

### Performance Issues

With 5 devices scanning simultaneously:
- Expect 1-2 second sync delay (normal)
- If delay > 5 seconds, reduce devices to 4 or check network quality
- Monitor "Pending Queue" - should stay at 0

## Development

### Adding New QR Codes

Edit `src/services/sync/state.ts`:

```typescript
export const QR_CODES = [
  // Add your codes here
  "YOUR_CODE_HERE",
];
```

### Changing Pass Types

Edit `initializePassTypes()` in `state.ts`:

```typescript
const type = qrCode.includes('I') ? 'infinite' : 'one-use';
```

### Adjusting Sync Intervals

In `state.ts`:
- Periodic sync: Change `30000` (30s) in `startPeriodicSync()`
- Retry queue: Change `3000` (3s) in `startBroadcastQueueProcessor()`
- Peer timeout: Change `90000` (90s) in `getConnectedDevicesCount()`

## Technical Details

### Database Schema

**scans table:**
- scan_id (PRIMARY KEY)
- qr_code, timestamp, device_id, date
- Indexes: (qr_code, timestamp), (qr_code, date)

**pass_types table:**
- qr_code (PRIMARY KEY)
- type ('infinite' | 'one-use')

**device_state table:**
- device_id (PRIMARY KEY)
- last_sequence, last_seen

**broadcast_queue table:**
- id (AUTO INCREMENT)
- message, attempts, last_attempt, created_at

### Message Protocol

```typescript
interface StateMessage {
  type: "delta" | "full-state" | "state-request";
  deltas?: ScanEvent[];      // For delta messages
  fullState?: LocalState;    // For full-state messages
  sequenceNum: number;       // Message ordering
  deviceId: string;          // Sender identifier
  timestamp: number;         // Message creation time
}
```

## Testing Checklist

### Single Device
- [ ] Camera permission flow works
- [ ] QR scanning succeeds
- [ ] One-use pass rejected on duplicate
- [ ] Infinite pass has 5-min cooldown
- [ ] Statistics screen shows correct data
- [ ] App survives restart (SQLite persistence)

### Multi-Device (4-5 devices)
- [ ] All devices show "Connected Devices: 4" (or 3, 2, 1)
- [ ] Scan on Device A appears on B, C, D, E
- [ ] Same QR scanned simultaneously → Both recorded
- [ ] One-use: Device A scans → Device B rejected
- [ ] Device crashes → Rejoins and syncs
- [ ] WiFi disconnect → Queue fills → Reconnect → Queue drains

## License

MIT

## Credits

Based on the Scanturnalia offline sync architecture, adapted for React Navigation and optimized for 4-5 devices.
