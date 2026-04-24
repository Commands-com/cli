import { cycleProviderItemArtifactDescriptor } from '../../src/artifact-paths.js';

export function cycleArtifactOptions() {
  return {
    internal: {
      artifactPaths: cycleProviderItemArtifactDescriptor,
    },
  };
}
