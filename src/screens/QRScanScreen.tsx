import { BarcodeScanningResult, CameraView } from "expo-camera";
import { Platform, StatusBar, StyleSheet, View, Text, Animated, Pressable } from "react-native";
import { useState, useRef, useEffect } from "react";
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from "react-native-safe-area-context";
import { handleScannedQRCode } from "../services/sync";

const COLORS = {
  primary: "#2563eb",
  success: "#10b981",
  error: "#ef4444",
  warning: "#f59e0b",
  background: "#ffffff",
  text: "#0f172a",
  textSecondary: "#475569",
};

type ScanFeedback = {
  type: "success" | "error" | "warning";
  message: string;
};

export default function QRScanScreen() {
  const navigation = useNavigation();
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [isScanning, setIsScanning] = useState(true);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.9)).current;

  // Reset scanning after cooldown
  useEffect(() => {
    if (!isScanning) {
      const timer = setTimeout(() => {
        setIsScanning(true);
        setFeedback(null);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isScanning]);

  // Animate feedback message
  useEffect(() => {
    if (feedback) {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 7,
          tension: 40,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();

      // Fade out after delay
      setTimeout(() => {
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }).start();
      }, 1700);
    }
  }, [feedback]);

  const handleBarcodeScan = async ({ data }: BarcodeScanningResult) => {
    if (!isScanning) return;

    setIsScanning(false);
    console.log("Scanned:", data);

    try {
      const result = await handleScannedQRCode(data);

      if (result.allowed) {
        // Success
        setFeedback({
          type: "success",
          message: `Scan accepted${result.todayScansCount !== undefined ? ` • ${result.todayScansCount + 1} today` : ""}`,
        });

        // Go back after short delay
        setTimeout(() => {
          if (navigation.canGoBack()) navigation.goBack();
        }, 1500);
      } else {
        // Error
        setFeedback({
          type: "error",
          message: result.reason || "Scan rejected",
        });
      }
    } catch (error) {
      // Error
      setFeedback({
        type: "error",
        message: "Failed to process scan",
      });
      console.error("Scan processing error:", error);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {Platform.OS === "android" ? <StatusBar hidden /> : null}

      {/* Camera View */}
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ["qr"],
        }}
        onBarcodeScanned={isScanning ? handleBarcodeScan : undefined}
      />

      {/* Overlay */}
      <View style={styles.overlay}>
        {/* Top Bar */}
        <View style={styles.topBar}>
          <Pressable
            onPress={() => navigation.goBack()}
            style={styles.backButton}
          >
            <Text style={styles.backButtonText}>← Back</Text>
          </Pressable>
          <Text style={styles.title}>Scan QR Code</Text>
          <View style={styles.placeholder} />
        </View>

        {/* Scanning Frame */}
        <View style={styles.centerContainer}>
          <View style={styles.scanFrame}>
            <View style={[styles.corner, styles.cornerTopLeft]} />
            <View style={[styles.corner, styles.cornerTopRight]} />
            <View style={[styles.corner, styles.cornerBottomLeft]} />
            <View style={[styles.corner, styles.cornerBottomRight]} />
          </View>
          <Text style={styles.instruction}>
            Position QR code within frame
          </Text>
        </View>

        {/* Feedback Message */}
        {feedback && (
          <Animated.View
            style={[
              styles.feedbackContainer,
              {
                backgroundColor:
                  feedback.type === "success"
                    ? COLORS.success
                    : feedback.type === "error"
                      ? COLORS.error
                      : COLORS.warning,
                opacity: fadeAnim,
                transform: [{ scale: scaleAnim }],
              },
            ]}
          >
            <Text style={styles.feedbackIcon}>
              {feedback.type === "success" ? "✓" : "✗"}
            </Text>
            <Text style={styles.feedbackText}>{feedback.message}</Text>
          </Animated.View>
        )}

        {/* Processing Indicator */}
        {!isScanning && !feedback && (
          <View style={styles.processingContainer}>
            <View style={styles.processingDot} />
            <Text style={styles.processingText}>Processing...</Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  overlay: {
    flex: 1,
    backgroundColor: "transparent",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  backButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  backButtonText: {
    color: COLORS.background,
    fontSize: 16,
    fontWeight: "600",
  },
  title: {
    color: COLORS.background,
    fontSize: 18,
    fontWeight: "700",
  },
  placeholder: {
    width: 60,
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
  },
  scanFrame: {
    width: 280,
    height: 280,
    position: "relative",
  },
  corner: {
    position: "absolute",
    width: 40,
    height: 40,
    borderColor: COLORS.background,
    borderWidth: 4,
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderTopLeftRadius: 8,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
    borderTopRightRadius: 8,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderRightWidth: 0,
    borderTopWidth: 0,
    borderBottomLeftRadius: 8,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderLeftWidth: 0,
    borderTopWidth: 0,
    borderBottomRightRadius: 8,
  },
  instruction: {
    color: COLORS.background,
    fontSize: 16,
    fontWeight: "500",
    textAlign: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 20,
  },
  feedbackContainer: {
    position: "absolute",
    bottom: 120,
    left: 20,
    right: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    borderRadius: 16,
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  feedbackIcon: {
    fontSize: 24,
    color: COLORS.background,
    fontWeight: "700",
  },
  feedbackText: {
    color: COLORS.background,
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
  },
  processingContainer: {
    position: "absolute",
    bottom: 120,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 20,
    gap: 12,
  },
  processingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.primary,
  },
  processingText: {
    color: COLORS.background,
    fontSize: 16,
    fontWeight: "600",
  },
});
