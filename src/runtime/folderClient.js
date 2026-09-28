import { boundedFetch } from './boundedFetch.js';

export async function inspectFolder(planId) {
  const request = async (operation, body, token) => {
    const response = await boundedFetch(`/api/folder-contract/${operation}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-pp-folder-token': token } : {}) },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error('Saved folders are unavailable.');
    return result;
  };
  const identity = await request('session', {});
  if (!identity.token || !identity.actor) throw new Error('Folder session is incomplete.');
  const state = await request('inspect', { planId }, identity.token);
  if (state.valid !== true || state.planId !== planId) throw new Error('Folder receipt is invalid or belongs to another project.');
  return state;
}
