import { createHash } from 'node:crypto';
import { parseTaskDraftImport } from '../project/taskDraftLedger.js';
import { parseTaskAttempt } from './taskOutcomeContract.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Matches immutable snapshots; it does not approve a draft, authenticate a
// producer, or establish that the candidate digest matches filesystem content.
export function bindTaskAttemptToLedger(attemptWire, ledgerWire, checkId) {
  const ledger = parseTaskDraftImport(ledgerWire);
  const attempt = parseTaskAttempt(attemptWire);
  const task = ledger.tasks.find(task => task.id === attempt.binding.taskId);
  if (!task || task.archived
      || attempt.binding.projectId !== ledger.binding.projectId
      || attempt.binding.rootIdentity !== ledger.binding.rootIdentity
      || attempt.binding.ledgerRevision !== ledger.revision
      || attempt.binding.ledgerDigest !== hash(ledger)
      || attempt.binding.taskDigest !== hash(task)
      || typeof checkId !== 'string' || !attempt.requiredCheckIds.includes(checkId)) {
    throw new Error('TASK_OUTCOME_LEDGER_MISMATCH');
  }
  return Object.freeze({ attempt, checkId, authorityVerified: false });
}
