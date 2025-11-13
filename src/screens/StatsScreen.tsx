import { getLocalState, getJSONConfigState } from "../services/sync";
import { LocalState, PassState } from "../services/sync/types";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type PassType = "infinite" | "one-use";

interface PassEntry {
  type: PassType;
  "14nov": boolean;
  "15nov": boolean;
  "16nov": boolean;
  count?: number;
}

// Helper function to transform PassState to PassEntry
const transformToPassEntry = (passState: PassState | undefined, qrCode: string, jsonConfig: any): PassEntry => {
  // If no scans yet, use the JSON config defaults
  if (!passState) {
    const configEntry = jsonConfig[qrCode];
    return {
      type: configEntry?.type || "one-use",
      "14nov": configEntry?.["14nov"] || false,
      "15nov": configEntry?.["15nov"] || false,
      "16nov": configEntry?.["16nov"] || false,
      ...(configEntry?.type === "infinite" && {
        count: configEntry?.count || 0,
      }),
    };
  }

  // Count scans per date from actual scan events
  const scansBy14nov = passState.scans.filter(s => s.date === "14nov").length;
  const scansBy15nov = passState.scans.filter(s => s.date === "15nov").length;
  const scansBy16nov = passState.scans.filter(s => s.date === "16nov").length;

  return {
    type: passState.type,
    "14nov": scansBy14nov > 0,
    "15nov": scansBy15nov > 0,
    "16nov": scansBy16nov > 0,
    ...(passState.type === "infinite" && {
      count: passState.scans.length,
    }),
  };
};

const DATE_LABELS = {
  "14nov": "14 Nov",
  "15nov": "15 Nov",
  "16nov": "16 Nov",
} as const;

const COLORS = {
  background: "#000000",
  card: "rgba(255,255,255,0.05)",
  border: "rgba(255,255,255,0.1)",
  primary: "#e2e8f0",
  secondary: "#94a3b8",
  muted: "#64748b",
  success: "#4ade80",
  accent: "#007AFF",
  badgeBg: "#1e293b",
};

export default function StatsScreen() {
  const [state, setState] = useState<LocalState>(getLocalState());
  const [jsonConfig, setJsonConfig] = useState<any>(getJSONConfigState());

  useEffect(() => {
    setState(getLocalState());
    setJsonConfig(getJSONConfigState());
  }, []);

  // Get all QR codes from JSON config (this includes all codes, not just scanned ones)
  const allQRCodes = Object.keys(jsonConfig);

  const infinitePasses = allQRCodes
    .filter((code) => jsonConfig[code]?.type === "infinite")
    .map(
      (code) =>
        [code, transformToPassEntry(state[code], code, jsonConfig)] as [string, PassEntry],
    );

  const oneUsePasses = allQRCodes
    .filter((code) => jsonConfig[code]?.type === "one-use")
    .map(
      (code) =>
        [code, transformToPassEntry(state[code], code, jsonConfig)] as [string, PassEntry],
    );

  const totalInfinite = infinitePasses.length;
  const totalOneUse = oneUsePasses.length;
  const usedInfiniteDates = infinitePasses.reduce((sum, [_, pass]) => {
    return (
      sum +
      (pass["14nov"] ? 1 : 0) +
      (pass["15nov"] ? 1 : 0) +
      (pass["16nov"] ? 1 : 0)
    );
  }, 0);
  const usedOneUse = oneUsePasses.filter(([, pass]) =>
    Object.values(pass).some((v) => v === true),
  ).length;

  return (
    <SafeAreaView style={styles.container}>
      {/* Summary Banner */}
      <View style={styles.summary}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryNumber}>{totalInfinite}</Text>
          <Text style={styles.summaryLabel}>Infinite</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryNumber}>{totalOneUse}</Text>
          <Text style={styles.summaryLabel}>One-Use</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryNumber}>
            {usedInfiniteDates}
          </Text>
          <Text style={styles.summaryLabel}>Used Dates</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryNumber}>{usedOneUse}</Text>
          <Text style={styles.summaryLabel}>Used One-Use</Text>
        </View>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Infinite Passes */}
        {infinitePasses.length > 0 && (
          <PassSection title="Infinite Passes" passes={infinitePasses} />
        )}

        {/* One-Use Passes */}
        {oneUsePasses.length > 0 && (
          <PassSection title="One-Use Passes" passes={oneUsePasses} />
        )}

        {allQRCodes.length === 0 && (
          <Text style={styles.empty}>No passes found.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function PassSection({
  title,
  passes,
}: {
  title: string;
  passes: [string, PassEntry][];
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <View style={styles.section}>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={styles.sectionHeader}
      >
        <Text style={styles.sectionTitle}>
          {title} ({passes.length})
        </Text>
        <Text style={styles.expandIcon}>
          {expanded ? "Collapse" : "Expand"}
        </Text>
      </Pressable>

      {expanded &&
        passes.map(([code, pass]) => (
          <PassCard key={code} code={code} pass={pass} />
        ))}
    </View>
  );
}

function PassCard({ code, pass }: { code: string; pass: PassEntry }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.code}>{code}</Text>
        {pass.type === "infinite" && pass.count !== undefined && (
          <View style={styles.countBadge}>
            <Text style={styles.countText}>
              Count: {pass.count}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.datesRow}>
        {Object.entries(DATE_LABELS).map(([key, label]) => {
          const used = pass[key as keyof typeof DATE_LABELS];
          return (
            <View
              key={key}
              style={[styles.datePill, used && styles.datePillUsed]}
            >
              <Text
                style={[styles.dateText, used && styles.dateTextUsed]}
              >
                {used ? "Used" : ""} {label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    backgroundColor: COLORS.background,
  },
  scroll: {
    flex: 1,
    marginTop: 16,
  },
  summary: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: COLORS.card,
    padding: 12,
    borderRadius: 12,
    marginTop: 8,
  },
  summaryItem: {
    alignItems: "center",
  },
  summaryNumber: {
    fontSize: 20,
    fontWeight: "bold",
    color: COLORS.success,
  },
  summaryLabel: {
    fontSize: 12,
    color: COLORS.secondary,
    marginTop: 2,
  },
  section: {
    marginTop: 24,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  sectionTitle: {
    fontWeight: "600",
    fontSize: 18,
    color: COLORS.primary,
  },
  expandIcon: {
    marginLeft: "auto",
    padding: 8,
    color: COLORS.accent,
    opacity: 0.8,
    fontSize: 14,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  code: {
    fontFamily: "monospace",
    fontWeight: "bold",
    fontSize: 14,
    color: COLORS.primary,
  },
  countBadge: {
    backgroundColor: COLORS.success,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  countText: {
    color: "#0f172a",
    fontSize: 12,
    fontWeight: "bold",
  },
  datesRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  datePill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.success,
  },
  datePillUsed: {
    backgroundColor: COLORS.badgeBg,
    borderColor: COLORS.muted,
  },
  dateText: {
    color: COLORS.success,
    fontSize: 13,
    fontWeight: "500",
  },
  dateTextUsed: {
    color: COLORS.secondary,
  },
  empty: {
    textAlign: "center",
    marginTop: 40,
    color: COLORS.muted,
    fontStyle: "italic",
  },
});
