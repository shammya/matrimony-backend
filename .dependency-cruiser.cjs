module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'controllers-use-services',
      severity: 'error',
      from: { path: '^src/controller/' },
      to: { path: '^src/(db|mongo|cache)/' },
    },
    {
      name: 'business-uses-resource-services',
      severity: 'error',
      from: { path: '^src/(service|process)/' },
      to: {
        path: '^src/(db|mongo)/(raw|repository|entity|config)/',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'domain-independent',
      severity: 'error',
      from: { path: '^src/bo/' },
      to: { path: '^src/', pathNot: '^src/bo/' },
    },
    {
      name: 'no-upward-infrastructure',
      severity: 'error',
      from: { path: '^src/(db|mongo|cache)/' },
      to: { path: '^src/(controller|process|service|container)' },
    },
    {
      name: 'no-transport-in-business',
      severity: 'error',
      from: { path: '^src/(process|service|db|mongo|cache|security)/' },
      to: { path: '^src/controller/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
