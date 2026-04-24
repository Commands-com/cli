import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPromptIntent } from '../src/prompt-intent.js';

function promptWithPayload(payload) {
  return [
    'Prompt body.',
    '<!-- commands-com-prompt-intent: {"kind":"review","cycle":1} -->',
    '',
    `<!-- commands-com-prompt-intent: ${payload} -->`,
  ].join('\n');
}

test('splitPromptIntent strips malformed trailing markers without returning an intent', () => {
  const expectedPrompt = [
    'Prompt body.',
    '<!-- commands-com-prompt-intent: {"kind":"review","cycle":1} -->',
  ].join('\n');
  const cases = [
    {
      label: 'non-JSON payload',
      payload: 'not-json',
    },
    {
      label: 'array payload',
      payload: '[{"kind":"review"}]',
    },
    {
      label: 'string scalar payload',
      payload: '"review"',
    },
    {
      label: 'number scalar payload',
      payload: '1',
    },
    {
      label: 'boolean scalar payload',
      payload: 'true',
    },
    {
      label: 'null payload',
      payload: 'null',
    },
  ];

  for (const { label, payload } of cases) {
    assert.deepEqual(splitPromptIntent(promptWithPayload(payload)), {
      prompt: expectedPrompt,
      intent: null,
    }, label);
  }
});
