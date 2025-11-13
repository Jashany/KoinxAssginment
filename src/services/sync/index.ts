import "./events";
import { getEntry, initializeP2P, addScanEvent, getLocalState, getJSONConfigState, getConnectedDevicesCount, getTimeSinceLastSync, getPendingBroadcastsCount, getPendingAcksCount, getConnectedPeers, printPeerIPs } from "./state";
import { getTodayKey } from "./utils";
import { ScanValidationResult } from "./types";
import * as Storage from "./storage";

/**
 * Validate a scan before processing
 */
export async function validateScan(qrCode: string): Promise<ScanValidationResult> {
  const entry = getEntry(qrCode);

  if (!entry) {
    return {
      allowed: false,
      reason: "Unknown QR code",
    };
  }

  const today = getTodayKey();
  const todayScans = await Storage.getScansForQROnDate(qrCode, today);

  // For one-use passes, check if already used today
  if (entry.type === "one-use") {
    if (todayScans.length > 0) {
      return {
        allowed: false,
        reason: "One-use pass already used today",
        todayScansCount: todayScans.length,
      };
    }
  }

  // Check for duplicate scan within 5 minutes (for both types)
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const recentScans = todayScans.filter(scan => scan.timestamp > fiveMinutesAgo);

  if (recentScans.length > 0) {
    return {
      allowed: false,
      reason: "Already scanned within the last 5 minutes",
      todayScansCount: todayScans.length,
    };
  }

  return {
    allowed: true,
    todayScansCount: todayScans.length,
  };
}

/**
 * Handle scanned QR code with validation
 * Returns the validation result
 */
export async function handleScannedQRCode(scannedData: string): Promise<ScanValidationResult> {
  // Validate the scan
  const validation = await validateScan(scannedData);

  if (!validation.allowed) {
    console.warn(`Scan rejected for ${scannedData}: ${validation.reason}`);
    return validation;
  }

  // Scan is valid, add the event
  const today = getTodayKey();
  try {
    await addScanEvent(scannedData, today);
    console.log(`Scan accepted for ${scannedData}`);
    return validation;
  } catch (error) {
    console.error('Failed to process scan:', error);
    return {
      allowed: false,
      reason: 'Failed to process scan. Please try again.',
    };
  }
}

export {
  getEntry,
  initializeP2P,
  getLocalState,
  getJSONConfigState,
  getConnectedDevicesCount,
  getTimeSinceLastSync,
  getPendingBroadcastsCount,
  getPendingAcksCount,
  getConnectedPeers,
  printPeerIPs
};
