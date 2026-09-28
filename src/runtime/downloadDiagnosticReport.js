// Load download-specific browser APIs only for an explicit export request.
export function downloadDiagnosticReport(payload, projectId) {
  const href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  try {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `${projectId}-operations.json`;
    anchor.click();
  } finally { URL.revokeObjectURL(href); }
}
