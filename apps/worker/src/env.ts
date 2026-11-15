export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS?: Fetcher;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}
