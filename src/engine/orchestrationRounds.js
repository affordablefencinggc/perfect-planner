// Pure planning state. These transitions never dispatch a provider or authorize execution.
const validText = value => typeof value === 'string' && value.trim() && value.length <= 32000;
const requireThat = (condition, code) => { if (!condition) throw Error(code); };
export function createOrchestration({id, projectId, goal, participants, leadId, reviewerIds = [], maxRounds = 2}) {
  requireThat([id,projectId,goal].every(validText), 'ORCHESTRATION_CONTEXT_REQUIRED');
  requireThat(Array.isArray(participants) && participants.length >= 2 && participants.length <= 8, 'PARTICIPANTS_REQUIRED');
  const ids = new Set();
  const members = participants.map(p => {
    requireThat(p && [p.id,p.label,p.providerId,p.model].every(validText) && !ids.has(p.id), 'PARTICIPANT_INVALID');
    ids.add(p.id); return {id:p.id,label:p.label,providerId:p.providerId,model:p.model};
  });
  requireThat(ids.has(leadId) && Array.isArray(reviewerIds) && new Set(reviewerIds).size === reviewerIds.length && reviewerIds.every(id=>ids.has(id)), 'ROLE_INVALID');
  requireThat(Number.isSafeInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 5, 'ROUND_LIMIT_INVALID');
  return {schemaVersion:1,id,projectId,goal,participants:members,leadId,reviewerIds:[...reviewerIds],maxRounds,
    revision:1,status:'collecting',rounds:[{number:1,input:goal,outputs:[],synthesis:null,reviews:[]}],executionAuthorized:false};
}

export function transitionOrchestration(previous, event) {
  requireThat(event.projectId === previous.projectId && event.orchestrationId === previous.id && event.revision === previous.revision, 'ORCHESTRATION_STALE_OR_FOREIGN');
  requireThat(previous.status !== 'cancelled', 'ORCHESTRATION_CANCELLED');
  const state = structuredClone(previous), round = state.rounds.at(-1);
  if (event.type === 'cancel') { state.status='cancelled'; state.revision++; return state; }
  if (event.type === 'output') {
    requireThat(state.status === 'collecting' && state.participants.some(p=>p.id===event.participantId), 'OUTPUT_NOT_EXPECTED');
    requireThat(!round.outputs.some(o=>o.participantId===event.participantId), 'OUTPUT_ALREADY_RECORDED');
    requireThat(['completed','failed','unavailable'].includes(event.status) && validText(event.content) && validText(event.artifactId), 'OUTPUT_INVALID');
    requireThat(!state.rounds.some(r=>r.outputs.some(o=>o.artifactId===event.artifactId)), 'ARTIFACT_ALREADY_RECORDED');
    round.outputs.push({participantId:event.participantId,status:event.status,content:event.content,artifactId:event.artifactId});
  } else if (event.type === 'synthesize') {
    requireThat(state.status === 'collecting' && event.participantId === state.leadId, 'LEAD_REQUIRED');
    const completed = round.outputs.filter(o=>o.status==='completed').map(o=>o.artifactId).sort();
    requireThat(completed.length > 0 && Array.isArray(event.includedArtifactIds) && JSON.stringify([...event.includedArtifactIds].sort()) === JSON.stringify(completed), 'SYNTHESIS_SOURCES_INCOMPLETE');
    const missing=state.participants.filter(p=>!round.outputs.some(o=>o.participantId===p.id && o.status==='completed')).map(p=>p.id);
    requireThat(!missing.length || event.acceptPartial === true, 'PARTIAL_ROUND_REQUIRES_DECISION');
    requireThat(validText(event.content) && validText(event.artifactId), 'SYNTHESIS_INVALID');
    round.synthesis={participantId:event.participantId,artifactId:event.artifactId,content:event.content,includedArtifactIds:completed,missingParticipantIds:missing};
    state.status='reviewing';
  } else if(event.type === 'review') {
    requireThat(state.status==='reviewing' && state.reviewerIds.includes(event.participantId), 'REVIEWER_REQUIRED');
    requireThat(event.synthesisArtifactId===round.synthesis.artifactId && !round.reviews.some(r=>r.participantId===event.participantId), 'REVIEW_STALE_OR_DUPLICATE');
    requireThat(['approve','changes','disagree'].includes(event.verdict) && validText(event.content), 'REVIEW_INVALID');
    round.reviews.push({participantId:event.participantId,synthesisArtifactId:event.synthesisArtifactId,verdict:event.verdict,content:event.content});
  } else if(event.type === 'optimize') {
    requireThat(state.status==='reviewing' && round.number < state.maxRounds, 'ROUND_LIMIT_OR_STATE');
    requireThat(validText(event.instruction), 'OPTIMIZATION_INSTRUCTION_REQUIRED');
    state.rounds.push({number:round.number+1,input:round.synthesis.content,previousSynthesisArtifactId:round.synthesis.artifactId,
      instruction:event.instruction,priorReviews:structuredClone(round.reviews),outputs:[],synthesis:null,reviews:[]});
    state.status='collecting';
  } else throw Error('ORCHESTRATION_EVENT_UNKNOWN');
  state.revision++; return state;
}
