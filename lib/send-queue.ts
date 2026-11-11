import type {PathInfo} from './connection-diagnostics';

const conservative = {high:64*1024,low:16*1024} as const;
const directHost = {high:256*1024,low:64*1024} as const;

// Measured on the user's UDP host-to-host path. Keep other ICE routes on
// their existing budget until measured separately. This is only the browser
// queue; the 4 MiB durable-ACK window and 1 MiB checkpoints do not change.
export function sendQueue(path?:PathInfo){
  return path?.protocol==='udp'&&path.local==='host'&&path.remote==='host'
    ?directHost:conservative;
}
