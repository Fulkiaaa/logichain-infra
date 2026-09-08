// Présent pour cohérence documentaire avec logichain-api et LogiChainMobile,
// et utilisable ponctuellement via `npx --no -- commitlint --edit <fichier>`
// si Node.js est disponible localement.
//
// Ce dépôt n'a pas de package.json (projet Ansible pur) : le hook qui
// bloque réellement les commits invalides est donc un hook git natif
// (.githooks/commit-msg, sans dépendance Node), pas Husky. Voir
// CONTRIBUTING.md, section 3 bis.
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'ci', 'build', 'perf']],
  },
};
