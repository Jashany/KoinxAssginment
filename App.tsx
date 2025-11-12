// Buffer polyfill for react-native-udp
import { Buffer } from '@craftzdog/react-native-buffer';

import './global.css';
import { NavigationContainer } from '@react-navigation/native';
import RootNavigator from './src/navigation/RootNavigator';
(global as any).Buffer = Buffer;

export default function App() {
  return (
    <NavigationContainer>
      {
        <RootNavigator />
      }
    </NavigationContainer>
  );
}
