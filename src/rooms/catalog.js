export const BUILT_IN_ROOMS = [
  {
    id: 'review-cycle',
    aliases: ['review'],
    title: 'Review Cycle',
    description: 'Convergence-style code review with correctness, tests, and maintainability reviewers.',
    participants: [
      { role: 'correctness reviewer', guidance: 'Find real bugs, regressions, edge cases, and data integrity risks.' },
      { role: 'test reviewer', guidance: 'Find missing, brittle, or misleading tests and propose regression coverage.' },
      { role: 'maintainability reviewer', guidance: 'Find confusing structure, duplication, naming, and change-cost issues.' },
    ],
  },
  {
    id: 'code-quality',
    aliases: ['quality'],
    title: 'Code Quality',
    description: 'Rank high-leverage maintainability, architecture, and test improvements.',
    participants: [
      { role: 'architecture reviewer', guidance: 'Assess boundaries, dependencies, cohesion, and abstraction weight.' },
      { role: 'maintainability reviewer', guidance: 'Assess complexity, naming, duplication, dead code, and readability.' },
      { role: 'test strategy reviewer', guidance: 'Assess coverage gaps, brittle tests, and validation ergonomics.' },
    ],
  },
  {
    id: 'architecture',
    aliases: ['arch'],
    title: 'Architecture Room',
    description: 'Evaluate system boundaries, extension points, and migration paths.',
    participants: [
      { role: 'system architect', guidance: 'Map the current architecture and identify boundary problems.' },
      { role: 'platform maintainer', guidance: 'Evaluate operational complexity, interfaces, and long-term ownership.' },
      { role: 'migration planner', guidance: 'Propose safe sequencing for architectural improvements.' },
    ],
  },
  {
    id: 'security',
    aliases: ['sec'],
    title: 'Security Room',
    description: 'Review trust boundaries, secrets, auth, filesystem, and process execution risks.',
    participants: [
      { role: 'threat modeler', guidance: 'Identify assets, attackers, trust boundaries, and abuse paths.' },
      { role: 'application security reviewer', guidance: 'Look for injection, auth, authorization, secrets, and unsafe defaults.' },
      { role: 'local runtime reviewer', guidance: 'Review filesystem, shell, child process, plugin, and local privilege risks.' },
    ],
  },
  {
    id: 'performance',
    aliases: ['perf'],
    title: 'Performance Room',
    description: 'Find runtime, memory, IO, latency, and scaling bottlenecks.',
    participants: [
      { role: 'runtime performance reviewer', guidance: 'Look for CPU, event-loop, concurrency, and hot-path issues.' },
      { role: 'data and IO reviewer', guidance: 'Look for filesystem, network, database, and serialization bottlenecks.' },
      { role: 'user-perceived performance reviewer', guidance: 'Look for latency, progress feedback, and responsiveness issues.' },
    ],
  },
  {
    id: 'bug-hunt',
    aliases: ['bugs'],
    title: 'Bug Hunt',
    description: 'Aggressively search for correctness bugs and failure modes.',
    participants: [
      { role: 'edge-case hunter', guidance: 'Find boundary conditions, null states, empty inputs, and invalid state transitions.' },
      { role: 'failure-mode reviewer', guidance: 'Find timeout, retry, partial failure, crash recovery, and cancellation bugs.' },
      { role: 'regression reviewer', guidance: 'Find behavior changes likely to surprise existing users.' },
    ],
  },
  {
    id: 'test-plan',
    aliases: ['tests'],
    title: 'Test Plan Room',
    description: 'Produce a practical test strategy for a change or subsystem.',
    participants: [
      { role: 'unit test planner', guidance: 'Identify small deterministic tests and fixtures.' },
      { role: 'integration test planner', guidance: 'Identify cross-module flows and realistic smoke coverage.' },
      { role: 'regression test planner', guidance: 'Identify historically likely failures and high-value guardrails.' },
    ],
  },
  {
    id: 'implementation-plan',
    aliases: ['plan', 'impl-plan'],
    title: 'Implementation Plan Room',
    description: 'Break an objective into a safe, sequenced engineering plan.',
    participants: [
      { role: 'technical planner', guidance: 'Break the objective into concrete implementation steps.' },
      { role: 'risk reviewer', guidance: 'Identify hidden risks, rollback points, and ambiguous decisions.' },
      { role: 'delivery planner', guidance: 'Prioritize a small shippable slice and validation plan.' },
    ],
  },
  {
    id: 'product-spec',
    aliases: ['spec'],
    title: 'Product Spec Room',
    description: 'Turn an idea into a product and technical specification.',
    participants: [
      { role: 'product strategist', guidance: 'Clarify users, value proposition, scope, and non-goals.' },
      { role: 'technical spec writer', guidance: 'Define implementation model, interfaces, data, and constraints.' },
      { role: 'UX reviewer', guidance: 'Define user flows, interaction details, and failure states.' },
    ],
  },
  {
    id: 'docs',
    aliases: ['documentation'],
    title: 'Docs Room',
    description: 'Improve README, onboarding, examples, and developer documentation.',
    participants: [
      { role: 'new user advocate', guidance: 'Find missing first-run context and confusing setup steps.' },
      { role: 'developer docs reviewer', guidance: 'Find inaccurate, stale, or incomplete technical docs.' },
      { role: 'examples reviewer', guidance: 'Propose concrete examples that prove the product value quickly.' },
    ],
  },
  {
    id: 'release-readiness',
    aliases: ['release'],
    title: 'Release Readiness Room',
    description: 'Check packaging, onboarding, testing, docs, and launch risks.',
    participants: [
      { role: 'release manager', guidance: 'Assess versioning, packaging, changelog, CI, and rollback readiness.' },
      { role: 'developer experience reviewer', guidance: 'Assess install, first run, error messages, and support burden.' },
      { role: 'quality gate reviewer', guidance: 'Assess tests, smoke coverage, known risks, and release blockers.' },
    ],
  },
  {
    id: 'codebase-research',
    aliases: ['research'],
    title: 'Codebase Research Room',
    description: 'Explore a codebase question and compare implementation options.',
    participants: [
      { role: 'codebase explorer', guidance: 'Map relevant files, flows, and existing patterns.' },
      { role: 'options analyst', guidance: 'Compare plausible approaches and tradeoffs.' },
      { role: 'recommendation writer', guidance: 'Recommend a path with assumptions, risks, and next steps.' },
    ],
  },
];
