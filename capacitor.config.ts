import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'fun.cauai.niannianstocks',
  appName: '念念智股',
  webDir: 'dist',
  server: {
    url: 'https://stocks.cauai.fun',
    cleartext: false,
    allowNavigation: [
      'stocks.cauai.fun',
      '*.supabase.co',
      '*.dodopayments.com',
    ],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
