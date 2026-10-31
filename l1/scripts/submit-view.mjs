// Gateway view of an accepted POST /tx (Red Team S1 retest LOW-1). The node
// answers { txid, status: "pending" | "parked", waitingForNonce? }; a parked
// transfer (nonce gap) is not "included in a coming block", it waits for the
// missing nonce and is evicted after the parked TTL if the gap stays open.
// `accepted` and `txid` are unchanged for existing clients; `status` is new.
export function submitAcceptedView(nodeBody, extra = {}) {
  const body = nodeBody && typeof nodeBody === "object" ? nodeBody : {};
  const txid = body.txid;
  if (body.status === "parked" && Number.isSafeInteger(body.waitingForNonce)) {
    return {
      accepted: true, txid, status: "parked", waitingForNonce: body.waitingForNonce,
      note: `Parked, waiting for nonce ${body.waitingForNonce}: submit that nonce first. A parked transaction is evicted after the node's parked TTL (10 minutes by default) if the gap stays open.`,
      ...extra
    };
  }
  return { accepted: true, txid, status: "pending", note: "Included in a coming block (about 30 seconds).", ...extra };
}
