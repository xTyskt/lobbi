export const VERSION: string;

export class LobbiError extends Error {
  code: string;
}

export interface ConnectOptions {
  /** Public key from your game settings (pk_...). Safe to ship in client code. */
  key: string;
  /** Server base url, e.g. wss://api.example.com (the /ws path is added for you). */
  url: string;
  /** Expected bandwidth per player in kbps; sizes the adaptive player cap. Default comes from the server. */
  perPlayerKbps?: number;
  /** Simulation tick budget in ms (1000 / tick rate). Default 50. */
  tickBudgetMs?: number;
}

export interface CreateOptions {
  name?: string;
  /** Maximum players you want in this lobby (the adaptive cap may admit fewer at first). */
  max?: number;
  public?: boolean;
  password?: string;
  /** Small JSON object (max 1 KB) shown in the lobby list. */
  meta?: Record<string, unknown>;
  perPlayerKbps?: number;
}

export interface LobbySummary {
  code: string;
  name: string;
  players: number;
  max: number;
  meta: Record<string, unknown>;
  hasPassword: boolean;
  createdAt: number;
}

export type Payload = string | ArrayBuffer | ArrayBufferView;
export type Channel = 'fast' | 'safe';

export interface SendOptions {
  /** Host only. Omit to broadcast. Players always send to the host. */
  to?: string;
  /** 'fast' = unreliable and unordered (may drop under load, max 16 KB); 'safe' = reliable and ordered (up to 8 MB, large messages are chunked and reassembled). Default 'fast'. */
  channel?: Channel;
}

export interface PeerStat {
  id: string;
  ready: boolean;
  relayed: boolean;
  rttMs: number;
  dropped: number;
  buffered: number;
}

export interface LobbyEvents {
  /** Host: a player's connection is ready. */
  playerConnected: (p: { id: string; relayed: boolean }) => void;
  /** Player: your connection to the host is ready. */
  connected: (p: { relayed: boolean }) => void;
  playerJoined: (id: string) => void;
  playerLeft: (id: string, reason: string) => void;
  message: (from: string, data: string | ArrayBuffer, channel: Channel) => void;
  /** The lobby is over. Reasons: host-left, host-lost, server-restart, kicked, p2p-failed, connect-timeout, connection-lost, left. */
  closed: (reason: string) => void;
  kicked: (reason: string) => void;
  /** The admission cap changed. */
  cap: (max: number) => void;
  meta: (meta: Record<string, unknown>) => void;
  hostUnfit: () => void;
  hostUnresponsive: (info: { state: string }) => void;
  playerLost: (info: { id: string }) => void;
}

export class Lobby {
  readonly code: string;
  readonly name: string;
  readonly id: string;
  readonly hostId: string;
  readonly isHost: boolean;
  readonly max: number;
  readonly meta: Record<string, unknown>;
  readonly dead: boolean;
  readonly hostUnfit: boolean;
  readonly members: string[];
  readonly connected: string[];

  on<K extends keyof LobbyEvents>(event: K, fn: LobbyEvents[K]): () => void;
  off<K extends keyof LobbyEvents>(event: K, fn: LobbyEvents[K]): void;
  once<K extends keyof LobbyEvents>(event: K, fn: LobbyEvents[K]): () => void;

  send(data: Payload, options?: SendOptions): boolean;
  broadcast(data: Payload, options?: { channel?: Channel; except?: string }): number;
  /** Host: report the duration of each simulation tick (ms). Feeds the adaptive cap. */
  reportTick(ms: number, budgetMs?: number): void;
  setMeta(meta: Record<string, unknown>): void;
  kick(id: string): void;
  leave(): Promise<void>;
  stats(): PeerStat[];
}

export class Lobbi {
  static connect(options: ConnectOptions): Promise<Lobbi>;
  readonly sessionId: string;
  readonly lobby: Lobby | null;
  readonly version: string;
  on(event: 'disconnected' | 'reconnecting' | 'offline', fn: () => void): () => void;
  on(event: 'reconnected', fn: (info: { resumed: boolean }) => void): () => void;
  on(event: 'error', fn: (err: LobbiError) => void): () => void;
  list(filter?: { name?: string }, cursor?: number): Promise<{ items: LobbySummary[]; cursor: number | null }>;
  create(options?: CreateOptions): Promise<Lobby>;
  join(code: string, options?: { password?: string }): Promise<Lobby>;
  joinOrCreate(options?: CreateOptions): Promise<Lobby>;
  close(): void;
}

export default Lobbi;
