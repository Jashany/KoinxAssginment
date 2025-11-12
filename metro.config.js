const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// Add resolver configuration for Buffer polyfill
config.resolver = {
  ...config.resolver,
  extraNodeModules: {
    ...config.resolver?.extraNodeModules,
    buffer: require.resolve('@craftzdog/react-native-buffer'),
  },
};

module.exports = withNativeWind(config, { input: './global.css' });
