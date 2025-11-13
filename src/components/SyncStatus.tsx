import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import {
  getConnectedDevicesCount,
  getTimeSinceLastSync,
  getPendingBroadcastsCount,
} from "../services/sync";

const COLORS = {
  background: "#09090b",
  card: "#18181b",
  primary: "#f4f4f5",
  secondary: "#71717a",
  muted: "#3f3f46",
  success: "#22c55e",
  warning: "#eab308",
  error: "#ef4444",
  border: "#27272a",
};

export default function SyncStatus() {
  const [connectedDevices, setConnectedDevices] = useState(0);
  const [timeSinceSync, setTimeSinceSync] = useState(0);
  const [pendingBroadcasts, setPendingBroadcasts] = useState(0);

  useEffect(() => {
    // Update status every second
    const interval = setInterval(async () => {
      setConnectedDevices(getConnectedDevicesCount());
      setTimeSinceSync(getTimeSinceLastSync());
      const pending = await getPendingBroadcastsCount();
      setPendingBroadcasts(pending);
    }, 10000);

    return () => clearInterval(interval);
  }, []);

  const syncStatus =
    timeSinceSync === 0
      ? "Waiting"
      : timeSinceSync < 10
        ? "Synced"
        : timeSinceSync < 30
          ? "Recent"
          : "Delayed";

  const statusColor =
    syncStatus === "Synced"
      ? COLORS.success
      : syncStatus === "Recent"
        ? COLORS.warning
        : COLORS.error;

  return (
    <View style={styles.container}>
      {/* Status Row */}
      <View style={styles.row}>
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        <Text style={styles.statusText}>{syncStatus}</Text>
      </View>

      {/* Metrics */}
      <View style={styles.divider} />
      <View style={styles.metricsRow}>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>{connectedDevices}</Text>
          <Text style={styles.metricLabel}>Peers</Text>
        </View>
        {pendingBroadcasts > 0 && (
          <>
            <View style={styles.metricDivider} />
            <View style={styles.metric}>
              <Text style={[styles.metricValue, { color: COLORS.warning }]}>
                {pendingBroadcasts}
              </Text>
              <Text style={styles.metricLabel}>Queue</Text>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "80%",
    marginBlock: 'auto',
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 12,
    borderColor: COLORS.border,
    paddingVertical: 10,
    paddingHorizontal: 12,
    minWidth: 110,
    gap: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.primary,
    letterSpacing: -0.2,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.border,
  },
  metricsRow: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "center",
  },
  metric: {
    alignItems: "center",
    gap: 2,
  },
  metricDivider: {
    width: 1,
    backgroundColor: COLORS.border,
  },
  metricValue: {
    fontSize: 15,
    fontWeight: "700",
    color: COLORS.primary,
    letterSpacing: -0.5,
  },
  metricLabel: {
    fontSize: 9,
    color: COLORS.secondary,
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
