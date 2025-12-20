import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { router } from 'expo-router';

// Configure notification behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPushNotifications(): Promise<string | null> {
  // Push notifications only work on physical devices
  if (!Device.isDevice) {
    console.log('[Push] Notifications require a physical device');
    return null;
  }

  // Check existing permissions
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  // Request permissions if not granted
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('[Push] Notification permission denied');
    return null;
  }

  try {
    // Get the Expo push token
    // Note: This requires a development build with EAS, won't work in Expo Go
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: process.env.EXPO_PUBLIC_PROJECT_ID,
    });
    console.log('[Push] Got push token:', tokenData.data.slice(0, 30) + '...');
    return tokenData.data;
  } catch (err) {
    console.log('[Push] Failed to get push token (dev build required):', (err as Error).message);
    return null;
  }
}

export function setupNotificationListeners() {
  // Handle notification received while app is in foreground
  const notificationListener = Notifications.addNotificationReceivedListener((notification) => {
    console.log('Notification received:', notification);
  });

  // Handle notification tap (opens the app)
  const responseListener = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;

    // Navigate to the session if sessionId is provided
    if (data?.sessionId) {
      router.push(`/session/${data.sessionId}`);
    }
  });

  // Return cleanup function
  return () => {
    notificationListener.remove();
    responseListener.remove();
  };
}

// For Android, we need to set up a notification channel
export async function setupNotificationChannel() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('session-alerts', {
      name: 'Session Alerts',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#6366f1',
    });
  }
}

// Send a local notification (works without Apple Developer account)
export async function sendLocalNotification(
  title: string,
  body: string,
  data?: Record<string, unknown>
) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
      sound: 'default',
    },
    trigger: null, // null = immediate
  });
}

// Notify when a session goes idle
export async function notifySessionIdle(sessionId: string, sessionName: string) {
  await sendLocalNotification(
    'Session Ready',
    `${sessionName} is waiting for input`,
    { sessionId }
  );
}
