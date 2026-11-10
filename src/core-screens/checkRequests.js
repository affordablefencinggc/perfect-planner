const key = (project, attempt) => `pp.check-request.v1:${project}:${attempt}`;

export function readCheckRequest(project, attempt) {
  try {
    const value = JSON.parse(localStorage.getItem(key(project, attempt)) ?? 'null');
    return value && value.attempt === attempt && typeof value.requestId === 'string' ? value : null;
  } catch { return null; }
}

export function saveCheckRequest(project, request) {
  // Failure must stop submission: a request without recoverable identity is unsafe to retry.
  const value = JSON.stringify(request);
  localStorage.setItem(key(project, request.attempt), value);
  if (localStorage.getItem(key(project, request.attempt)) !== value) throw new Error('The check request could not be saved. No check was submitted.');
}

export function clearCheckRequest(project, request) {
  const current = readCheckRequest(project, request.attempt);
  if (current?.requestId === request.requestId) localStorage.removeItem(key(project, request.attempt));
}
