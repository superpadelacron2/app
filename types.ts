
export interface SuperSaaSSettings {
  scheduleId: string;
  apiKey: string;
}

export interface TranscriptionEntry {
  type: 'user' | 'model';
  text: string;
  timestamp: number;
}

export enum SessionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}
