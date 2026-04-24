export function formatRoomReport({
  room,
  objective,
  runId,
  providerId,
  model = '',
  repoRoot,
  outputs = [],
  synthesis = '',
  synthesisError = '',
}) {
  return [
    `# ${room.title}: ${objective}`,
    '',
    `Run: ${runId}`,
    `Room: ${room.id}`,
    `Provider: ${providerId}${model ? ` (${model})` : ''}`,
    `Repository: ${repoRoot}`,
    '',
    synthesis ? `## Synthesis\n\n${synthesis}` : '',
    synthesisError ? `## Synthesis\n\nSynthesis failed: ${synthesisError}` : '',
    ...outputs.map((output) => `## ${output.role}\n\n${output.text}`),
  ].filter(Boolean).join('\n\n');
}
