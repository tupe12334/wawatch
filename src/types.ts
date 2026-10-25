/** 'connecting' is the reconnect right after a scan; 'loggedOut' means the phone unlinked this device. */
export type LinkStatus = 'starting' | 'qr' | 'connecting' | 'open' | 'closed' | 'loggedOut';

/** A chat as the transport sees it. */
export interface ChatRef {
  id: string;
  name: string;
}

/** A message as the transport delivers it (before the hub assigns a cursor). */
export interface IncomingMessage {
  id: string;
  chatId: string;
  sender: string;
  fromMe: boolean;
  text: string;
  timestamp: number; // ms since epoch
  /** True for messages from history sync, not live delivery. They do not wake waiters or webhooks. */
  history?: boolean;
}

/** What a transport reports to the hub. */
export interface TransportSink {
  status(status: LinkStatus, qr?: string): void;
  chats(chats: ChatRef[]): void;
  message(msg: IncomingMessage): void;
}

/** A WhatsApp connection. The real one uses Baileys; tests and demo mode use a mock. */
export interface Transport {
  start(sink: TransportSink): Promise<void>;
  /** Sends text as-is and returns the WhatsApp message id. */
  send(chatId: string, text: string): Promise<string>;
  /** Forgets the saved pairing and starts over, so a new QR code appears. */
  repair(): Promise<void>;
  stop(): Promise<void>;
}
