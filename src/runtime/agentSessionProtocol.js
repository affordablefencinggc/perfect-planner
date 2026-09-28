// Pure broker-observation rules. This is NOT pairing/authentication or a transport.
// Only a future authority-owned adapter may admit observations from a real session.
const bindingKeys = ['projectId', 'rootIdentity', 'workspaceId', 'registryRevision'];
const observationKeys = ['schemaVersion', 'binding', 'sessionId', 'sequence', 'kind', 'observedAt', 'expiresAt'];
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw Error('AGENT_SESSION_SCHEMA');
};
const uint = n => Number.isSafeInteger(n) && n >= 0;
export function validateAgentSessionBinding(binding) {
  exact(binding, bindingKeys);
  if (!['projectId','workspaceId','rootIdentity'].every(key => typeof binding[key] === 'string')) throw Error('AGENT_SESSION_BINDING');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(binding.projectId ?? '') || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(binding.workspaceId ?? '') || !/^[a-f0-9]{64}$/.test(binding.rootIdentity ?? '') || !uint(binding.registryRevision) || binding.registryRevision < 1) throw Error('AGENT_SESSION_BINDING');
  return binding;
}
function validateObservation(value) {
  exact(value, observationKeys);
  validateAgentSessionBinding(value.binding);
  if (typeof value.sessionId !== 'string') throw Error('AGENT_SESSION_SCHEMA');
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(value.sessionId ?? '') || !uint(value.sequence) || value.sequence < 1 || !['open','heartbeat','close'].includes(value.kind) || !uint(value.observedAt) || !uint(value.expiresAt)) throw Error('AGENT_SESSION_SCHEMA');
  if (value.kind === 'close' ? value.expiresAt !== value.observedAt : value.expiresAt <= value.observedAt || value.expiresAt - value.observedAt > 30000) throw Error('AGENT_SESSION_EXPIRY');
  return value;
}
export function acceptAgentSessionObservation(previous, incoming, binding, now) {
  validateAgentSessionBinding(binding);
  validateObservation(incoming);
  if (!uint(now) || incoming.observedAt > now || (incoming.kind !== 'close' && incoming.expiresAt <= now)) throw Error('AGENT_SESSION_TIME');
  if (bindingKeys.some(key => incoming.binding[key] !== binding[key])) throw Error('AGENT_SESSION_FOREIGN_PROJECT');
  if (previous) {
    validateObservation(previous);
    if (bindingKeys.some(key => previous.binding[key] !== binding[key]) || incoming.sessionId !== previous.sessionId) throw Error('AGENT_SESSION_IDENTITY');
    if (previous.kind === 'close') throw Error('AGENT_SESSION_CLOSED');
    if (incoming.sequence !== previous.sequence + 1 || incoming.observedAt < previous.observedAt || incoming.kind === 'open') throw Error('AGENT_SESSION_SEQUENCE');
  } else if (incoming.kind !== 'open' || incoming.sequence !== 1) throw Error('AGENT_SESSION_OPEN_REQUIRED');
  return Object.freeze({...incoming, binding:Object.freeze({...incoming.binding})});
}
export function agentSessionPresentation(observation, now) {
  if (!observation) return Object.freeze({state:'unverified', workVerified:false, executionAuthorized:false});
  validateObservation(observation);
  if (!uint(now)) throw Error('AGENT_SESSION_TIME');
  // A backward clock shift invalidates reachability; it never lengthens a lease.
  const state = observation.kind === 'close' ? 'closed' : now < observation.observedAt || now >= observation.expiresAt ? 'stale' : 'reachable';
  return Object.freeze({state, lastObservedAt:observation.observedAt, workVerified:false, executionAuthorized:false});
}
