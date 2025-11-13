import { useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { Pressable, Text, View, ScrollView, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import SyncStatus from "../components/SyncStatus";
import { Scan, ChartBar, ChevronRight, Camera ,AlertCircle} from "lucide-react-native";
import type { StackScreenProps } from '@react-navigation/stack';
import { RootStackParamList } from '../navigation/AppNavigator';
import { useState } from "react";
import { requestFullStateFromPeers, printPeerIPs } from "../services/sync/state";

type Props = StackScreenProps<RootStackParamList, 'Home'>;

export default function HomeScreen({ navigation }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [refreshing, setRefreshing] = useState(false);

  const isPermissionGranted = Boolean(permission?.granted);

  const onRefresh = async () => {
    setRefreshing(true);
    console.log('🔄 [REFRESH] User triggered refresh - rescanning for peers...');
    
    try {
      // Request full state from all peers (triggers peer discovery)
      await requestFullStateFromPeers();
      console.log('✅ [REFRESH] Peer discovery broadcast sent');
      
      // Print current peer list
      printPeerIPs();
    } catch (error) {
      console.error('❌ [REFRESH] Failed to rescan for peers:', error);
    } finally {
      // Keep spinner visible for at least 1 second for better UX
      setTimeout(() => {
        setRefreshing(false);
        console.log('✅ [REFRESH] Refresh complete');
      }, 1000);
    }
  };

  return (
    <SafeAreaView className="flex-1 w-full h-full bg-zinc-950">
      <StatusBar style="light" />
      
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingTop: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#71717a"
            title="Scanning for peers..."
            titleColor="#71717a"
          />
        }
      >
        <View className="flex-1 items-center justify-between">
          {/* Header Section */}
          <View className="items-center w-full mt-5">
            <Text className="text-3xl font-bold text-zinc-50 text-center mb-2 tracking-tight">
              Scanturnalia
            </Text>
            <Text className="text-sm text-zinc-500 text-center">
              Pull down to scan for peers
            </Text>
          </View>

          {/* Action Buttons */}
          <View className="w-full my-10 gap-2.5 items-center">
        {/* Request Permission Button */}
        {!isPermissionGranted && (
          <Pressable
            className="w-full max-w-[420px] bg-zinc-900 rounded-xl border border-zinc-800 active:bg-zinc-800"
            onPress={requestPermission}
          >
            <View className="flex-row items-center p-4 gap-3.5">
              <View className="w-11 h-11 rounded-lg bg-yellow-500 items-center justify-center">
                <AlertCircle color="white" size={22} />
              </View>
              <View className="flex-1 gap-0.5">
                <Text className="text-[15px] font-semibold text-zinc-50">
                  Enable Camera
                </Text>
                <Text className="text-[13px] text-zinc-400 font-normal ">
                  Required for QR scanning
                </Text>
              </View>
              <ChevronRight color="#71717a" size={24} strokeWidth={1.5} />
            </View>
          </Pressable>
        )}

        {/* Scan Code Button */}
        <Pressable
          onPress={() => navigation.navigate('QRScan')}
          className={`w-full max-w-[420px] bg-zinc-900 rounded-xl border ${
            isPermissionGranted ? 'border-zinc-700' : 'border-zinc-800 opacity-50'
          } ${isPermissionGranted ? 'active:bg-zinc-800' : ''}`}
          disabled={!isPermissionGranted}
        >
          <View className="flex-row items-center p-4 gap-3.5">
            <View className={`w-11 h-11 rounded-lg items-center justify-center ${
              isPermissionGranted ? 'bg-sky-500' : 'bg-zinc-700 opacity-50'
            }`}>
              <Scan color="white" size={22} />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className={`text-[15px] font-semibold ${
                isPermissionGranted ? 'text-zinc-50' : 'text-zinc-600'
              }`}>
                {isPermissionGranted ? "Scan QR Code" : "Camera Required"}
              </Text>
              <Text className={`text-[13px] font-normal leading-[18px] ${
                isPermissionGranted ? 'text-zinc-400' : 'text-zinc-600'
              }`}>
                {isPermissionGranted
                  ? "Start scanning tickets"
                  : "Enable camera to continue"}
              </Text>
            </View>
            <ChevronRight 
              color={isPermissionGranted ? "#71717a" : "#3f3f46"} 
              size={24} 
              strokeWidth={1.5} 
            />
          </View>
        </Pressable>

        {/* View Statistics Button */}
        <Pressable
          onPress={() => navigation.navigate('Stats')}
          className="w-full max-w-[420px] bg-zinc-900 rounded-xl border border-zinc-800 active:bg-zinc-800"
        >
          <View className="flex-row items-center p-4 gap-3.5">
            <View className="w-11 h-11 rounded-lg bg-zinc-700 items-center justify-center">
              <ChartBar color="white" size={22} />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="text-[15px] font-semibold text-zinc-50">
                View Statistics
              </Text>
              <Text className="text-[13px] text-zinc-400 font-normal">
                Check scan history and metrics
              </Text>
            </View>
            <ChevronRight color="#71717a" size={24} strokeWidth={1.5} />
          </View>
        </Pressable>
          </View>

          <SyncStatus />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}


