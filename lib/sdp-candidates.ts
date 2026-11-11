// BUNDLE can contain both a media section and a data section. Each candidate
// must retain its own mid instead of using the first mid in the entire SDP.
export function sdpCandidates(sdp: string): RTCIceCandidateInit[] {
  const result: RTCIceCandidateInit[] = [];
  let index = -1, mid = '', lines: string[] = [];
  const flush = () => {
    if (index < 0) return;
    for (const candidate of lines) result.push({candidate, sdpMid: mid || String(index), sdpMLineIndex: index});
  };
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) { flush(); index++; mid = ''; lines = []; }
    else if (line.startsWith('a=mid:')) mid = line.slice(6);
    else if (line.startsWith('a=candidate:')) lines.push(line.slice(2));
  }
  flush(); return result;
}
