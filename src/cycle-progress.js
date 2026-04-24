import {
  normalizeFiniteNonNegativeNumber,
  normalizeIssueCount,
} from './number-utils.js';
import { SCORE_ORDER } from './summary-contract.js';

// Progress is applied after beginCycle records and returns the current cycle.
export function applyCycleProgress(state, cycleRecord) {
  const previous = previousCycleRecord(state, cycleRecord);
  const progress = assessCycleProgress({
    previous,
    current: cycleRecord,
  });

  if (!previous || progress.changed) {
    state.stalledCycles = 0;
  } else {
    state.stalledCycles = normalizeFiniteNonNegativeNumber(state.stalledCycles) + 1;
  }
  cycleRecord.progress = {
    improved: progress.improved,
    changed: progress.changed,
    stalledCycles: state.stalledCycles,
  };
  return cycleRecord.progress;
}

export function shouldStopForStall(state, cycleRecord) {
  const maxStalledCycles = normalizeFiniteNonNegativeNumber(state.options?.stallCycles);
  const stalledCycles = normalizeFiniteNonNegativeNumber(cycleRecord?.progress?.stalledCycles);
  return Boolean(maxStalledCycles > 0 && stalledCycles >= maxStalledCycles);
}

function previousCycleRecord(state, current) {
  const cycles = Array.isArray(state?.cycles) ? state.cycles : [];
  assertCurrentCycleRecorded(cycles, current);
  return cycles[cycles.length - 2] || null;
}

function assertCurrentCycleRecorded(cycles, current) {
  // Cycle progress is applied only after beginCycle records and returns this
  // exact cycle object, so the current record must be the latest state cycle.
  if (cycles.at(-1) !== current) {
    throw new Error('applyCycleProgress requires cycleRecord to be recorded as the latest state cycle');
  }
}

function assessCycleProgress({ previous, current }) {
  const currentKey = progressKey(current);
  const previousKey = previous ? progressKey(previous) : '';
  const improved = previous ? cycleImproved(previous, current) : true;
  const changed = !previous || currentKey !== previousKey || improved;
  return {
    improved,
    changed,
  };
}

function cycleImproved(previous, current) {
  const previousScore = scoreRank(previous?.score);
  const currentScore = scoreRank(current?.score);
  if (currentScore < previousScore) return true;
  if (currentScore > previousScore) return false;
  return issueCount(current) < issueCount(previous);
}

function progressKey(cycleRecord) {
  if (!cycleRecord) return '';
  const issuePart = issueCount(cycleRecord);
  const scorePart = String(cycleRecord.score || '').trim().toUpperCase();
  const synopsisPart = String(cycleRecord.synopsis || cycleRecord.synthesis || '').trim().replace(/\s+/g, ' ');
  return [scorePart, issuePart, synopsisPart].join('|');
}

function issueCount(cycleRecord) {
  return normalizeIssueCount(cycleRecord?.issueCount);
}

function scoreRank(score) {
  const index = SCORE_ORDER.indexOf(String(score || '').trim().toUpperCase());
  return index === -1 ? SCORE_ORDER.length : index;
}
