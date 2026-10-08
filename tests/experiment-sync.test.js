const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { window: {} };
vm.runInNewContext(fs.readFileSync('experiment-sync.js', 'utf8'), context);
const merge = context.window.ExperimentSync.mergeParticipantStates;

test('fills cloud-missing keys while retaining existing cloud records', () => {
  const local = { participantId: 2, records: { stage1: { score: 4 }, stage2: { score: 5 } }, answers: { q1: 'A', q2: 'B' } };
  const cloud = { participantId: 2, records: { stage1: { score: 4 } }, answers: { q1: 'A' } };
  const result = merge(local, cloud, 2);

  assert.deepEqual(JSON.parse(JSON.stringify(result.state.records)), { stage1: { score: 4 }, stage2: { score: 5 } });
  assert.deepEqual(JSON.parse(JSON.stringify(result.state.answers)), { q1: 'A', q2: 'B' });
  assert.equal(result.added.records, 1);
  assert.equal(result.added.answers, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.conflicts)), []);
});

test('does not overwrite a differing cloud value and reports the conflict', () => {
  const result = merge(
    { participantId: 2, records: { stage1: { score: 3 } } },
    { participantId: 2, records: { stage1: { score: 4 } } },
    2
  );

  assert.equal(result.state.records.stage1.score, 4);
  assert.equal(result.added.records, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.conflicts)), [{ field: 'records', key: 'stage1' }]);
});

test('ignores a local cache belonging to a different participant', () => {
  const result = merge(
    { participantId: 1, records: { stage1: { score: 3 } } },
    { participantId: 2, records: {} },
    2
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result.state.records)), {});
  assert.equal(result.added.records, 0);
});
