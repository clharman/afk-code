import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ClerkProvider, ClerkLoaded, useAuth } from '@clerk/clerk-expo';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useStore } from '@/lib/store';
import { relay } from '@/lib/relay';
import { tokenCache } from '@/lib/token-cache';

// Only import notifications on native platforms
let notificationModule: typeof import('@/lib/notifications') | null = null;
if (Platform.OS !== 'web') {
  notificationModule = require('@/lib/notifications');
}

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;

if (!publishableKey) {
  throw new Error('Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY');
}

function AuthenticatedApp() {
  const { isSignedIn, getToken } = useAuth();
  const { setToken, setConnected } = useStore();

  useEffect(() => {
    let cleanup = () => {};

    // Set up notifications only on native
    if (notificationModule) {
      notificationModule.setupNotificationChannel();
      cleanup = notificationModule.setupNotificationListeners();
    }

    return cleanup;
  }, []);

  useEffect(() => {
    async function connectToRelay() {
      if (!isSignedIn) {
        setConnected(false);
        relay.disconnect();
        return;
      }

      try {
        // Set the token getter so relay can refresh tokens on reconnect
        relay.setTokenGetter(getToken);

        const token = await getToken();
        if (token) {
          setToken(token);
          await relay.connect(token);

          // Register for push notifications after connecting (native only)
          if (notificationModule) {
            const pushToken = await notificationModule.registerForPushNotifications();
            if (pushToken) {
              relay.registerPushToken(pushToken);
            }
          }
        }
      } catch (err) {
        console.error('Failed to connect to relay:', err);
      }
    }

    connectToRelay();
  }, [isSignedIn]);

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#1a1a2e' },
          headerTintColor: '#fff',
          contentStyle: { backgroundColor: '#0f0f1a' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Snowfort' }} />
        <Stack.Screen name="login" options={{ title: 'Sign In', presentation: 'modal' }} />
        <Stack.Screen name="session/[id]" options={{ title: 'Session' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <ClerkLoaded>
        <AuthenticatedApp />
      </ClerkLoaded>
    </ClerkProvider>
  );
}
