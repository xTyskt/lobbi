// Where the demo finds Lobbi. Replace the three YOUR-... values (see the setup guide).
// Both url and key can also be overridden in the page address: ?api=wss://your-host&key=pk_xxx
const local = ['localhost', '127.0.0.1'].includes(location.hostname);

export default {
  url: local ? 'ws://localhost:8080' : 'wss://lobbi-api.duckdns.org',
  key: 'pk_demo_change_me',
  // Dashboard sign-in. Both values are public by design; access rules protect the data.
  authUrl: 'https://cnnvxvxhxocqkcxurpkq.supabase.co',
  authKey: 'sb_publishable_tInc8ilv1S1alBZ-Otkz5Q_pT-0b6iV',
};
