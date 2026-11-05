// Where the demo finds Lobbi. Replace the three YOUR-... values (see the setup guide).
// Both url and key can also be overridden in the page address: ?api=wss://your-host&key=pk_xxx
const local = ['localhost', '127.0.0.1'].includes(location.hostname);

export default {
  url: local ? 'ws://localhost:8080' : 'wss://YOUR-API-HOST',
  key: 'pk_demo_change_me',
  // Dashboard sign-in. Both values are public by design; access rules protect the data.
  authUrl: 'https://YOUR-AUTH-URL',
  authKey: 'YOUR-AUTH-KEY',
};
