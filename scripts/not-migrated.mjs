// Placeholder for scripts that have not been moved to wallet SDK 2 yet. See MIGRATION-LEDGER9.md.
const name = process.argv[2] ?? 'this script';
console.error(`${name} has not been migrated to wallet SDK 2 / ledger 9 yet, so it is not built.`);
console.error('The old version is in src/ but excluded from tsconfig.json. See MIGRATION-LEDGER9.md ("Stage 2").');
process.exit(1);
