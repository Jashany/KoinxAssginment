import { View, Text, ActivityIndicator } from 'react-native';
import { useEffect, useState } from 'react';
import AppNavigator from './AppNavigator';
import { initializeP2P } from '../services/sync';

export default function RootNavigator() {
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    // Initialize the P2P sync service
    const init = async () => {
      try {
        await initializeP2P();
        console.log('P2P sync service initialized');
      } catch (error) {
        console.error('Failed to initialize P2P sync service:', error);
      } finally {
        // Always set initialized to true after attempting init
        setIsInitialized(true);
      }
    };

    init();
  }, []);

  // Show loading screen without NavigationContainer
  if (!isInitialized) {
    return (
      <View className='bg-black flex-1 items-center justify-center'>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text className='text-white mt-4' style={{ fontSize: 14 }}>Initializing...</Text>
      </View>
    );
  }

  // Once initialized, render the full app with NavigationContainer
  return (
      <AppNavigator />
  );
}
