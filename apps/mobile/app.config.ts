import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Rally',
  slug: 'rally-mobile',
  owner: 'juno-ai-labs',
  extra: { eas: { projectId: 'bbcfbf5b-7ed7-4672-a40c-ebcc97a37e25' } },
  icon: '../desktop/resources/icon.png',
  scheme: 'rally-mobile',
  plugins: ['expo-dev-client', 'expo-web-browser', 'expo-font', 'react-native-bottom-tabs',
    'expo-background-task', 'expo-secure-store', ['expo-notifications', { mode: 'production', defaultChannel: 'default' }]],
  runtimeVersion: { policy: 'fingerprint' },
  updates: {
    url: 'https://u.expo.dev/bbcfbf5b-7ed7-4672-a40c-ebcc97a37e25',
    checkAutomatically: 'ON_LOAD',
    fallbackToCacheTimeout: 0,
  },
  version: '0.1.0',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true, bundleIdentifier: 'ai.rallywith.mobile',
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSCameraUsageDescription: 'Add a photo to your canvas conversation.',
      NSPhotoLibraryUsageDescription: 'Attach a photo to your canvas conversation.',
      NSMicrophoneUsageDescription: 'Dictate a message in your canvas conversation.',
    },
  },
  // React Navigation requires opting out until its navigators support predictive Back.
  // https://reactnavigation.org/docs/getting-started/#opting-out-of-predictive-back-on-android
  android: { package: 'ai.rally.mobile',
    predictiveBackGestureEnabled: false, softwareKeyboardLayoutMode: 'resize', permissions: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'] },
  web: { bundler: 'metro', name: 'Rally Mobile' },
};
export default config;
